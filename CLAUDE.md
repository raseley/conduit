# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Conduit** is an unofficial client for the **Rust+** companion API (the protocol behind
Facepunch's Rust+ mobile app) plus a **Discord bot** that lets a user control and monitor
their Rust server's smart devices. It ships as a **single double-clickable Windows
Electron app** that walks a non-technical user through pairing/registration to a live
control interface, with Discord as the primary control surface.

## Commands

pnpm workspace (pnpm 9, Node ≥22.12). Run from repo root unless noted. Node 25+ no longer
bundles Corepack; if `pnpm` is missing or broken, every command below also works as
`npx pnpm@9.15.9 <command>` (the setup script falls back to that by itself).

```bash
pnpm install              # install all workspaces
pnpm gen:proto            # regenerate @conduit/rustplus-proto from proto/rustplus.proto (REQUIRED before first build — output is gitignored)
pnpm build                # build every package (tsc -b, topological)
pnpm typecheck            # tsc -b across all packages
pnpm test                 # vitest run across all packages
pnpm lint                 # eslint .
pnpm format               # prettier --write .
pnpm format:check         # prettier --check . (CI gate)
pnpm clean                # remove dist/, *.tsbuildinfo, coverage
```

Per-package: `pnpm --filter @conduit/<name> <script>` (e.g. `pnpm --filter @conduit/bot-core test`).

Single test file / single test:

```bash
pnpm --filter @conduit/bot-core exec vitest run src/index.test.ts
pnpm --filter @conduit/bot-core exec vitest run -t "name of test"
```

Run the app from source (Windows, PowerShell): `scripts/setup-and-launch.ps1` does the
whole fresh-checkout → running Electron path (prereqs, deps, electron binary, gen:proto,
build, launch). Secrets (Steam, Discord bot token, server pairing) are entered in the
in-app wizard, not on the command line. Package a real `.exe` with
`pnpm --filter @conduit/desktop dist` (electron-builder).

Tests use **vitest** (workspace defined in `vitest.workspace.ts`). Codegen uses
**protobufjs static-module** (`pbjs`/`pbts`), NOT ts-proto or `protoc` — `protoc` is
deliberately avoided so no native toolchain is needed.

## Architecture: strict layered dependency tiers

The whole design is a one-directional dependency chain. Each package's allowed imports are
documented in its `src/index.ts` header and **enforced** by per-package
`@typescript-eslint/no-restricted-imports` rules (`files`-scoped in `eslint.config.js`) plus
each package's `dependencies` in `package.json` — respect these boundaries; they are the
core invariant of the codebase, and `pnpm lint` fails on a cross-tier import.

```
rustplus-proto  ← rustplus-client  ← bot-core  ← discord
                       fcm          ←
                                    all ← apps/desktop (Electron composition root)
```

- **`packages/rustplus-proto`** — generated protobuf types + a thin encode/decode codec.
  The only package that touches protobufjs/`Long`. Generated files live in
  `src/generated/` (gitignored; deterministic). 64-bit fields (`playerId`, steam ids,
  and entity ids, which are `uint64`) are `Long`s.
- **`packages/rustplus-client`** — one authenticated WebSocket connection to **one** Rust
  server. It connects through **Facepunch's companion socket**
  (`companion: { serverId, getAuthToken }` → `wss://companion-rust.facepunch.com/socket/{serverId}`,
  the Steam login token sent as a WebSocket subprotocol, never in the URL) or **directly**
  to `ip:port`. The route is chosen at every (re)connect: companion when a token is
  available, otherwise direct if the server has an address. It handles request/response
  correlation, server broadcasts as typed events, **token-bucket rate limiting** with the
  server's own costs (`rate-limiter.ts`), auto-reconnect with backoff+jitter (a `connect()`
  that fails rejects at once and then keeps retrying the same way, so a host started before
  the game server connects once it is up; a refused auth token is retried after
  `AUTH_RETRY_DELAYS_MS`, 5/10/15 s, then reported as `authRejected` and the client stops), and
  re-subscription of tracked entities on reconnect (the server only broadcasts entity
  changes after a prior `getEntityInfo`; `resubscribeOnReconnect: false` hands that to the
  host). The server answers both a bad `playerToken` and an unreachable entity with
  `not_found`; the client tells them apart with a `getTime` probe (`AuthError` vs
  `EntityNotFoundError`). Entity ids are JS numbers, converted at the wire by
  `entityIdToWire`/`entityIdFromWire`. Imports only `rustplus-proto` and `ws`.
  Publishable; no Discord/Electron/FCM.
- **`packages/fcm`** — Google push delivery + Rust+ pairing/registration. The one fragile
  dependency (`@liamcottle/push-receiver`) is **quarantined** behind `PushReceiverDriver`
  (`driver/pushReceiverDriver.ts`); everything else depends only on that interface.
  Network calls (`net/expo.ts`, `net/companion.ts`) are injectable seams. Emits typed
  events, including `pushHandled` (the id to persist so a restart does not replay it).
  Current pairing pushes carry **no `ip`/`port`**; a payload that fails to decode is
  logged with its `payloadShape` (field names and value shapes, never values).
  `register()` is first-run setup; `refresh()` renews the Steam token; `renew()` signs in
  with Steam again on the existing device registration. No Discord/Electron/Rust+ client.
- **`packages/bot-core`** — **the coordinator core and the single bridge** between Discord
  and the Rust server. Owns one `RustPlusClient` per paired server and routes **every**
  server through the companion socket (falling back to a direct address once the client
  reports the auth token refused, `authRejected`; a single refused handshake changes
  nothing), maps high-level operations + config onto client calls and persisted
  state, and fans fcm pairings + client broadcasts into a small set of domain events
  (`BotCoreEventMap`, e.g. `entityChanged`, `entityRefreshed` after a reconnect,
  `authRenewalNeeded` when the operator must sign in with Steam again) the discord adapter
  subscribes to. It re-subscribes its entities itself on every reconnect (re-arming
  auto-revert timers). Imports only `rustplus-client` + `fcm` — **NO Discord, NO
  Electron**. Re-exports the domain types adapters render so `discord` consumes a single
  dependency surface. Persistence is via the injectable `StateStore` interface
  (in-memory impl ships here for tests). Switch groups (`PairedServer.switchGroups`:
  `{ id, name, entityIds }`, a switch in at most one) are kept here with typed operations
  (`createSwitchGroup`, `renameSwitchGroup`, `setSwitchGroupMembers`, `deleteSwitchGroup`);
  removing a device takes it out of its group, and an emptied group is deleted.
- **`packages/discord`** — Tier 1, the primary user surface. The complete discord.js
  interaction model: the persistent **Conduit Panel**, buttons, native channel/role selects,
  modals, two bootstrap slash commands, per-click role-based permission checks, and the
  switch **state-lock** machine. While no admin or user role is chosen, it adopts the
  server's roles named "Conduit Admin" and "Conduit" (`adoptNamedRoles` in `permissions.ts`;
  never an integration role) when it is ready and when the Setup hub opens. Each server's Conduit Panel is a fixed group of **Components
  V2** messages, one per device type (Server, Switches, Alarms, Storage, Cameras; a type only
  once the server has such a device), laid out by the pure `layoutServer` (`panels.ts`), which
  counts components and characters against Discord's limits (40 / 4,000), trims, and pages
  ("Switches 1/2"). Every device is one row with one grey button; each type message ends with a
  "Manage a …" select that opens that device's settings ephemerally. A switch group is
  one Switches row of the same cost (its grouped switches have no row of their own): its state
  is aggregated from its members' locks (`switchGroupState`, confirmed values only), its button
  actuates each member through its own lock in turn, and its ephemeral panel (chosen in
  "Manage a switch…") shows each member and stays live while its token lasts. The group is posted once
  and then only edited, through the `EditPipeline` (`edit-pipeline.ts`: skip-identical,
  debounce; on 30046 the adapter rebuilds every panel, at most once an hour, else the panel
  backs off); it is reposted, in order, only when the layout needs a message it
  has no id for (a new type or page), and a type's message is deleted when its last device
  goes. Its message ids persist on `PairedServer.panelMessageIds`. Every operation that posts,
  deletes or reposts panels runs through one `PanelQueue` per control channel
  (`panel-queue.ts`); only Discord's 10008 Unknown Message counts as a panel being gone, and
  `reconstructPanels` migrates old per-device panels and sweeps untracked Conduit panels from
  the channel. Allowed
  to import `discord.js`; **never reaches past `bot-core`**.
- **`apps/desktop`** — Electron shell (the shipped `.exe`). At runtime a **headless
  coordinator** in the tray; the only visible surfaces are the one-time bootstrap wizard,
  the read-only tray status window, and the Steam login `BrowserWindow`.

## Desktop app: thin Electron glue over electron-free logic

`apps/desktop/src/main.ts` is **intentionally thin Electron glue** (windows, tray, IPC,
`safeStorage`, `app.getPath`). All real logic lives in **electron-free modules** that
unit-test without an Electron binary:

- **`Coordinator`** (`coordinator.ts`) — the headless runtime that composes `StateStore` +
  `FcmService` + `BotCore` + `DiscordAdapter`, owns the lifecycle (`start()` connects
  paired servers and starts the adapter), persists refreshed credentials, schedules the
  credential-refresh check, mirrors the start-on-login preference into the OS (at startup,
  on bot-core's `startOnLoginChanged`, and on reset — through the injected
  `applyStartOnLogin` seam), tracks per-source health for the tray snapshot, and surfaces
  bot-core's `authRenewalNeeded` as a "Steam sign-in" row plus `renewSteamSignIn()`.
  Imports no electron/discord.js/fcm IO directly beyond the workspace packages; all deps
  are injected.
- **`wizard-machine.ts`** — pure reducer for the bootstrap wizard (Create bot → Enable
  intents → Invite bot → Connect Steam → Pair server → Finish).
- **`discord-probe.ts`** — the wizard's Discord REST calls (`/applications/@me` checks
  the bot token and yields the Application ID, bot user id and intent flags;
  `/users/@me/guilds` finds the invited server and the bot's permissions there;
  `ensureConduitChannels` lists and creates the private Conduit category with `#conduit`
  and `#conduit-log`, reusing existing ones), with an injectable `fetch`, boundary
  validation and typed errors (a 403 is `DiscordForbiddenError`).
- **`steam-sign-in.ts`** — the typed Steam sign-in failure (cancelled, refused, flow
  changed, registration failed, unreachable) and its user-facing copy, for the wizard and
  for "Sign in with Steam again" from the tray.
- **`refresh-scheduler.ts`** (also asks bot-core whether a renewal is needed after each
  check, and wakes at each of bot-core's sign-in reminder milestones as well as hourly),
  **`state-store.ts`** (`PersistentStateStore`: plain JSON files; credentials, player
  tokens and Pushover keys encrypted), **`secret-box.ts`** (the `SecretBox` encryption seam +
  `FakeSecretBox`), **`panel-store-bridge.ts`** (`BotCorePanelStore`: persists Discord panel
  message ids through bot-core), **`diagnostics.ts`** (the secret-free "Copy diagnostics"
  blob).
- **`pushover.ts`** — the concrete `PushoverNotifier` injected into `BotCore`: one
  form-encoded POST with an injectable `fetch` seam (mirrors fcm's `net/` pattern); throws
  `PushoverError`.
- **`logger.ts`** — pino logger writing to `<dataDir>/logs/conduit.log` plus an in-memory
  `LogRing` for the diagnostics tail. Its `redact.paths` safety net is **derived** from
  `@conduit/fcm`'s `SENSITIVE_KEYS`, never hand-listed.
- **`constants.ts`** — app name, the Facepunch login host allow-list, fixed window sizes.
- **`conduit-mark.ts`** — the Conduit mark rasterized in code (a port of
  `assets/icon/render.mjs`, the generator of the shipped icon files; keep their geometry in
  step) for the status-colored tray icon. **`asset-paths.ts`** — where the shipped icon files
  (window icon, Discord bot avatar) sit in `dist/assets/icon/`; the build copies them there.
- The renderer↔main boundary is the **typed IPC contract** in `ipc-contract.ts`.

Besides `main.ts`, the modules that import `electron` are deliberately thin glue:

- **`windows/app-windows.ts`** — factories for the two renderer windows (bootstrap wizard,
  tray status), which share one HTML bundle + preload and differ by URL hash.
- **`windows/steam-window.ts`** — the isolated Steam login `BrowserWindow` (no Conduit
  preload, in-memory session partition). It opens Facepunch's login with the
  `returnUrl=/app?returnUrl=rust-plus://rust-auth-session` chain, sends a Linux User-Agent
  on the `/app` step only (Facepunch blocks Windows there), and captures the token from the
  `rust-plus://` redirect. Its pure helpers (`parseAuthRedirect`, `judgeFacepunchResponse`,
  `isAppStep`, `loginFailedReason`, `withAppStepHeaders`, `appStepUserAgent`,
  `redirectTargetForLog`) are unit-tested in `steam-window.test.ts`.
- **`windows/tray.ts`** — the tray icon (the Conduit mark, its ring and bar in the worst
  current status's color on the navy tile, drawn at 16 and 32px by `conduit-mark.ts`) and
  its menu (Status…, Sign in with Steam again…, Quit).
- **`preload.mts`** — the `contextBridge` exposing the typed `window.conduit` bridge. It must
  stay `.mts` (emitted as `.mjs`): Electron picks ESM vs CJS for a preload by extension
  alone.
- **`safe-storage-box.ts`** — `SafeStorageSecretBox`, the only module that calls
  `safeStorage` (DPAPI on Windows); the production `SecretBox`.
- **`start-on-login.ts`** — guarded wrapper around `app.setLoginItemSettings`; `main.ts`
  injects it into the `Coordinator` as its `applyStartOnLogin` seam. The pure
  `loginItemOptions()` builds the same `path`/`args` for setting and reading the item
  (run from source it must name the app directory, or the item launches bare Electron; run
  from the portable exe it must name that exe, `PORTABLE_EXECUTABLE_FILE`, not the temporary
  copy the wrapper unpacks and deletes), and `--hidden` (`isHiddenLaunch`) starts straight
  into the tray.

**`renderer/`** holds the plain ESM JS/HTML/CSS for both windows (not TypeScript; copied
verbatim into the build). It has no Node or Electron access and talks only to
`window.conduit`.

ESM throughout: package is `"type": "module"`, `tsc` emits ESM, Electron 28+ runs the ESM
main entry directly. Note `.js` extensions on relative imports (NodeNext resolution).

## Conventions

- Every package's logic is built around **injectable seams** (client factories, drivers,
  `fetch` functions, loggers, time sources) so tests run with fakes and no real IO. When
  adding functionality, follow this — take dependencies via constructor options.
- **Respect the layer boundaries.** Never add a cross-tier import: the allowed import set
  per package is the chain in the Architecture section (e.g. `rustplus-client` imports only
  `rustplus-proto` + `ws`; `bot-core` never imports `discord` or electron; `discord` never
  reaches past `bot-core`). `pnpm lint` enforces this and fails on a violation.
- **Throw typed errors, never bare `Error`, in domain logic.** Each package exposes a base
  error class (`RustPlusError` in `rustplus-client/errors.ts`, `FcmError` in
  `fcm/errors.ts`, `BotCoreError` in `bot-core/errors.ts`) with discriminated subclasses
  (e.g. `AuthError`, `RateLimitError`, `ConnectionError`, `ProtocolError`, `StateError`,
  `ValidationError`).
  Subclasses carry a stable `name` and accept `{ cause }` for chaining. The discord adapter
  converts any thrown error to user-facing copy via `friendlyError(err)` (matches on
  `err.name`) and never leaks stack traces to end users.
- **Acknowledge every Discord interaction exactly once, and report failures ack-safely.**
  A handler that can fail after acknowledging must report through the adapter's
  `replyFailure` (components), never a bare second `reply`; the failure send itself is
  guarded and logged, not thrown. Modal submits follow one shape (`handleModalSubmit`):
  validate and answer bad input at once, then `deferReply` **before** any bot-core or
  Discord REST work (Discord drops an interaction not acknowledged within 3 seconds),
  then `editReply` the outcome; a failure edits the pending reply, or follows up if the
  outcome was already shown. Routing switches end in a `default` that acknowledges, since
  a parseable custom ID can name a domain/action this build does not handle (stale panels).
- **Never present unconfirmed device state.** The switch state-lock only ever holds what
  the server reported (`seed`/`confirm`); a switch it has not heard about is _unknown_
  (`value: undefined`, rendered "Unknown"), and a timeout or failed actuation restores the
  prior confirmed value rather than the requested one.
- **Validate at the trust boundary; trust typed data past it.** All external input — FCM
  push payloads, WebSocket frames, Discord interactions, custom IDs — is validated or
  narrowed in its boundary module and **fails closed**: malformed input throws a typed error
  that the listener catches (so the connection survives, e.g. `fcm/decode.ts`'s
  `reqStr`/`reqEntityId` → `PairingError`), or returns `undefined` to be ignored (e.g.
  `discord/customId.ts#parseCustomId`). Narrow Discord interactions with the `isButton()` /
  `isModalSubmit()` type guards before dispatch. No schema library — hand-rolled guards
  scoped to the decode layer; code past the boundary relies on the typed shape.
- Logger is a minimal structural interface (`debug/info/warn/error`), defaulting to a no-op;
  the host app injects the real logger. **Never log secrets and never use `console.*` in
  source** — route objects through `redact()` (`fcm/redact.ts`) at the call site to mask
  sensitive keys (`token`, `secret`, `playerToken`, `steamAuthToken`, `expoPushToken`,
  `fcm`, `gcm`, …); the desktop logger adds a pino `redact.paths` net as defense-in-depth.
  The key list has **one source of truth**: `SENSITIVE_KEYS` in `fcm/redact.ts`. `redact()`,
  the pino paths (`desktop/logger.ts`), and the diagnostics scrubber
  (`desktop/diagnostics.ts`) all derive from it — add a new secret's key there, never in a
  second list. Log successes as well as failures: lifecycle events (connect with its route,
  disconnect, reconnect attempt, re-subscription count, pairings, handled interactions and
  their outcome) at `info`, per-broadcast detail at `debug`, with ids, never values a user
  typed.
- Persisted shapes (`bot-core/types.ts`) must stay JSON-serializable — no class instances,
  no `Long`, no protobuf — so any `StateStore` backend round-trips them losslessly. Entity
  ids are 64-bit on the server but stored as JS numbers (exact up to 2^53); the boundaries
  (`rustplus-client` mappers, fcm's `reqEntityId`) reject anything a number cannot hold.
- **Tests**: vitest workspace; tests are co-located as `*.test.ts`, and a package's behavior
  is exercised through its `index.test.ts` against the public surface. The core
  orchestrators additionally have focused suites named after their module
  (`bot-core.test.ts`, `client.test.ts`, `adapter.test.ts`, `state-lock.test.ts`) — put
  precise edge-case and regression tests there. Inject **hand-rolled
  fakes** via constructor seams (no mocking library) — fakes that emit are tiny
  `EventEmitter` subclasses; the Electron seam is `apps/desktop/test/electron-stub.ts`. Use
  **fixture factories** with overrides (`makeServer(id)`, `baseInput(overrides)`). Make time
  **deterministic** with `vi.useFakeTimers()` + `advanceTimersByTime` or an injected
  `TimerProvider` for timeouts/backoff/reconnect — never real sleeps. Assert events by
  subscribing with `.on()` and checking the handler fired, not by spying on emitter
  internals.
- **Don't cite issue or PR numbers in code, tests or config; explain the reason inline.**
  Write why in a sentence (e.g. "Discord caps edits to messages older than an hour"), not a
  `#<n>` reference, and give test names no number suffix; the commit or PR is where the link
  belongs. Another project's reference is spelled out as `owner/repo#<n>` or a full URL. CI's
  "No issue or PR numbers in tracked files" step (`ci.yml`) fails on a reference.
- TypeScript `strict` is on across the workspace (`tsconfig.base.json`); packages use
  project references (`composite: true`, build with `tsc -b`).
- Prettier: 100 col, 2-space, double quotes, semicolons, trailing commas, LF line endings
  (`.gitattributes` checks every text file out as LF on all platforms, so
  `prettier --check .` is meaningful on Windows too). eslint is pragmatic
  (`no-explicit-any` off, unused vars warn with `^_` ignore).
