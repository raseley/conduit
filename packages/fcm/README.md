# @conduit/fcm

Google push (FCM) delivery and Rust+ pairing/registration for [Conduit](../../README.md).

This package owns everything to do with **FCM/GCM push delivery and Rust+
pairing/registration**: registering a virtual device with Firebase, exchanging
tokens with Expo and Facepunch's Companion API, opening the persistent push
connection, and decoding incoming pairing/alarm notifications into typed events.

It quarantines the project's one fragile dependency,
[`@liamcottle/push-receiver`](https://www.npmjs.com/package/@liamcottle/push-receiver),
behind a stable internal interface. This is the **only** package in the monorepo
that touches the push library, so an upstream break has a small, contained blast
radius.

## Role in the monorepo

Conduit is a layered, one-directional dependency chain. `@conduit/fcm` sits near
the bottom:

```
rustplus-proto  ←  rustplus-client  ←  bot-core  ←  discord
                          fcm        ←
                                     all  ←  apps/desktop
```

`bot-core` consumes the typed events fcm emits and fans them into its domain
events; `apps/desktop` wires the real driver, persists the credentials fcm
produces (encrypted), and hosts the Steam login browser. fcm itself depends
**only** on the push library plus Node's global `fetch` — **no Discord, no
Electron, no Rust+ client**.

## What it does

1. **Registration** — FCM/GCM device registration → Expo push-token exchange →
   Steam login (UI hosted by the caller) → Companion API push registration.
   Returns the full credential bundle for the caller to persist encrypted.
2. **Listening** — opens the persistent MCS push connection, dedupes replayed
   notifications across reconnects, decodes each push, and emits the matching
   typed event.
3. **Credential lifecycle** — exposes credentials for encrypted persistence and
   refreshes the ~2-week Steam auth token via the Companion API.

## Public API

Everything below is exported from the package root (`@conduit/fcm`).

| Export                                                                                                 | Kind               | Purpose                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `FcmService`                                                                                           | class              | The public face of the package; orchestrates registration, listening, and credential refresh.                     |
| `FcmServiceDeps`                                                                                       | type               | Injectable dependencies for `FcmService` (driver, fetch seams, logger, ids). All default to real implementations. |
| `FcmEventMap`                                                                                          | type               | The typed events `FcmService` emits.                                                                              |
| `FcmCredentials`, `FcmRawCredentials`                                                                  | type               | The credential shapes fcm produces and consumes (JSON-serializable; persisted encrypted by the host).             |
| `FcmRegisterOptions`                                                                                   | type               | Options for `register()` (the `onSteamLogin` callback).                                                           |
| `PairingNotification`, `AlarmNotification`                                                             | type               | Decoded push payloads carried on the events.                                                                      |
| `createPushReceiverDriver`, `PushReceiverDriver`, `PushConnection`, `RawPush`                          | fn + types         | The quarantine seam over `@liamcottle/push-receiver` and its real adapter.                                        |
| `exchangeExpoPushToken`, `ExpoExchangeFn`                                                              | fn + type          | Expo push-token exchange network seam.                                                                            |
| `registerWithCompanionApi`, `CompanionRegisterFn`, `CompanionRegisterInput`, `CompanionRegisterResult` | fn + types         | Companion API registration/refresh network seam.                                                                  |
| `decodePush`, `DecodedPush`                                                                            | fn + type          | Pure push decoder (exported so it can be unit-tested / reused).                                                   |
| `FcmError`, `AuthError`, `PairingError`, `ConnectionError`                                             | classes            | Typed error categories (`auth` / `pairing` / `connection`).                                                       |
| `redact`, `noopLogger`, `REDACTED`, `Logger`                                                           | fn + values + type | Redaction helper and the structural logger seam.                                                                  |

### `FcmService`

```ts
class FcmService extends EventEmitter {
  constructor(deps?: FcmServiceDeps);

  register(opts: FcmRegisterOptions): Promise<FcmCredentials>;
  submitSteamToken(steamAuthToken: string): void;

  startListening(credentials: FcmCredentials, persistentIds?: string[]): Promise<void>;
  stopListening(): Promise<void>;

  refresh(credentials: FcmCredentials): Promise<FcmCredentials>;
}
```

### Events (`FcmEventMap`)

| Event                  | Payload               | Emitted when                                                                                      |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `serverPairing`        | `PairingNotification` | A server pairing push arrives.                                                                    |
| `entityPairing`        | `PairingNotification` | An entity (smart device) pairing push arrives.                                                    |
| `alarm`                | `AlarmNotification`   | A smart-alarm firing is relayed through the push channel.                                         |
| `credentialsRefreshed` | `FcmCredentials`      | `refresh()` produced a new Steam auth token.                                                      |
| `error`                | `Error`               | A non-fatal listener error (e.g. a malformed payload that was skipped — the connection survives). |

## Usage

`FcmService` stays UI-free: the host owns the Steam login browser and hands the
captured token back via `submitSteamToken`.

```ts
import { FcmService, type FcmCredentials } from "@conduit/fcm";

const fcm = new FcmService(); // real driver + fetch seams; silent no-op logger

// 1. First-run registration.
const credentials: FcmCredentials = await fcm.register({
  // The host drives the browser (Electron BrowserWindow, or print the URL).
  onSteamLogin: async (url) => {
    const steamAuthToken = await openBrowserAndCaptureToken(url);
    fcm.submitSteamToken(steamAuthToken);
  },
});
// Persist `credentials` encrypted (the desktop app uses Electron safeStorage).

// 2. Listen for pushes. Pass previously-seen ids to suppress replays.
fcm.on("serverPairing", (p) => console.log("paired server", p.name));
fcm.on("entityPairing", (p) => console.log("paired entity", p.entityId));
fcm.on("alarm", (a) => console.log("alarm", a.title));
fcm.on("error", (err) => console.warn("skipped a bad push:", err.message));

await fcm.startListening(credentials, /* persistentIds */ []);

// 3. Later, refresh the ~2-week Steam token before it expires.
fcm.on("credentialsRefreshed", (next) => persistEncrypted(next));
const refreshed = await fcm.refresh(credentials);
```

> The Steam token round-trips back into `register()` out of band. You may call
> `submitSteamToken` from inside `onSteamLogin` (as above) **or** resolve
> `onSteamLogin` first and call `submitSteamToken` afterward — `register` waits
> for whichever arrives.

## Architecture

### The `PushReceiverDriver` quarantine

`@liamcottle/push-receiver` ships no TypeScript types and has shifted its API
across versions. `src/driver/pushReceiverDriver.ts` is the **only** file allowed
to load it (lazily, via `createRequire`, so the untyped CommonJS module never
enters the type graph). Everything else — and the whole app — depends solely on
the `PushReceiverDriver` interface:

```ts
interface PushReceiverDriver {
  register(config: AndroidFcmConfig): Promise<FcmRawCredentials>;
  listen(
    credentials: FcmRawCredentials,
    persistentIds: string[],
    onPush: (push: RawPush) => void,
  ): Promise<PushConnection>;
}
```

If the library breaks or moves, the blast radius is exactly that one file.

### Injectable seams

Every fragile or network-touching dependency is an injectable seam, so the
service is fully testable with fakes and no real I/O. `FcmServiceDeps` accepts:

| Dependency                                  | Default                                           |
| ------------------------------------------- | ------------------------------------------------- |
| `driver` (`PushReceiverDriver`)             | real `createPushReceiverDriver`                   |
| `expoExchange` (`ExpoExchangeFn`)           | `exchangeExpoPushToken` (global `fetch`)          |
| `companionRegister` (`CompanionRegisterFn`) | `registerWithCompanionApi` (global `fetch`)       |
| `logger` (`Logger`)                         | `noopLogger` (silent unless injected)             |
| `senderId`, `fcmConfig`                     | Rust+ production values (override only for tests) |

### Redaction and logging

fcm handles the most sensitive material in the app (FCM/GCM security tokens, the
Steam auth token, the Expo token, and per-player `playerToken`s). The `Logger`
is a minimal structural interface (`debug` / `info` / `warn` / `error`) so the
host can inject its own logger (e.g. `pino`) without fcm taking that dependency.
`redact()` deep-clones any payload and masks sensitive fields by key name before
it reaches a log sink — always run credentials/pairing payloads through it.

### Typed errors

Failures surface as one of three categories, all extending `FcmError` (catch any
with `instanceof FcmError`, or branch on `.category`):

- `AuthError` (`auth`) — Steam/Companion authentication failed or expired.
- `PairingError` (`pairing`) — a received push payload could not be decoded.
- `ConnectionError` (`connection`) — registration HTTP or the push transport failed.

## Testing

Tests use [vitest](https://vitest.dev). Because every seam is injectable, the
suite runs entirely with fakes and no real network or push library.

```bash
pnpm --filter @conduit/fcm test         # run the package's tests
pnpm --filter @conduit/fcm typecheck    # tsc -b
pnpm --filter @conduit/fcm build        # tsc -b
```

## License / contributing

Part of the Conduit monorepo. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for setup,
the overall architecture, and contribution guidelines.
