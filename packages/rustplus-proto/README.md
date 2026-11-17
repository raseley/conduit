# @conduit/rustplus-proto

> Generated Rust+ Protocol Buffers message types and a thin encode/decode codec.

This is the base package of [Conduit](../../README.md), an unofficial client for the
[Rust+](https://rust.facepunch.com/companion) companion API. It owns the vendored
`rustplus.proto` schema, generates typed message classes from it, and exposes two thin
codec helpers plus the generated message classes.

It has **no** network or state logic and **no** dependency on Discord, Electron, or FCM —
it is publishable in isolation.

## Role in the dependency chain

Conduit is a strict, one-directional layered dependency chain. This package sits at the
bottom; everything above it consumes its generated types and codec:

```
rustplus-proto  ←  rustplus-client  ←  bot-core  ←  discord
```

It is the **only** package in the workspace that touches `protobufjs` and `Long`.
Correlation, sequence numbers, rate limiting, and reconnection live in
`@conduit/rustplus-client`, not here.

## How codegen works

The TypeScript message types are **generated**, not hand-written. The vendored schema is
`proto/rustplus.proto` (at the repo root); codegen reads it and emits a static ESM module
plus matching declarations.

| Output                        | Description                                        |
| ----------------------------- | -------------------------------------------------- |
| `src/generated/rustplus.js`   | Static ESM module (typed messages + encode/decode) |
| `src/generated/rustplus.d.ts` | Type declarations for the generated module         |

Codegen uses **protobufjs static-module** via `pbjs` + `pbts` (the `protobufjs-cli`
devDependency), driven by `scripts/gen-proto.mjs`. It is **not** ts-proto, and the
canonical `protoc` compiler is **deliberately avoided** — `protoc` requires a native
toolchain that isn't available in this environment, whereas protobufjs ships a pure-JS
parser/generator, so no native install is needed.

> **Important:** `src/generated/` is **gitignored**. Codegen is deterministic, so the
> files are left on disk for downstream packages to consume — but they are not checked in.
> You must generate them before the first build:
>
> ```bash
> pnpm install      # ensures protobufjs-cli (pbjs/pbts) is present
> pnpm gen:proto    # run from the repo root → writes src/generated/
> ```

Within this package, `pnpm gen` runs the same generator. After generation, `pnpm build`
compiles with `tsc -b` and copies `src/generated/` into `dist/generated/`.

## Public API

All exports come from the package root (`@conduit/rustplus-proto`).

### Codec

| Export          | Signature                          | Description                                                                                                               |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `encodeRequest` | `(req: IAppRequest) => Uint8Array` | Encode an `AppRequest` to the Rust+ wire format. Accepts an `AppRequest` instance or a plain `IAppRequest`-shaped object. |
| `decodeMessage` | `(buf: Uint8Array) => AppMessage`  | Decode a wire-format buffer into an `AppMessage` (a response or a server-pushed broadcast).                               |

Both are thin wrappers over the generated `AppRequest.encode(...).finish()` and
`AppMessage.decode(...)`. They add no sequence/correlation logic — that is the client's
responsibility.

### Message classes and enums

The generated message classes are re-exported individually for convenience — the envelope
(`AppRequest`, `AppMessage`, `AppResponse`, `AppBroadcast`), request payloads
(`AppSendMessage`, `AppSetEntityValue`, `AppCameraInput`, …), response payloads
(`AppInfo`, `AppTime`, `AppMap`, `AppTeamInfo`, `AppEntityInfo`, `AppMapMarkers`, …),
broadcast payloads (`AppEntityChanged`, `AppNewTeamMessage`, `AppCameraRays`, …), and the
`AppEntityType` / `AppMarkerType` enums. The names mirror the messages defined in
`proto/rustplus.proto`.

The full generated namespace is also exported as `rustplus` for anything not surfaced
individually (`Vector2`/`Vector3`/`Vector4`, `Color`, `Ray`, `ClanInfo`, etc.):

```ts
import { rustplus } from "@conduit/rustplus-proto";
const v = new rustplus.Vector3({ x: 1, y: 2, z: 3 });
```

For each message, protobufjs generates both a class (e.g. `AppRequest`) and a plain-object
interface (e.g. `IAppRequest`). The class instances are what `encode`/`decode` operate on;
`encode` also accepts plain objects satisfying the `I*` shape. Type aliases for the
envelope types (`AppRequest`/`IAppRequest`, `AppMessage`/`IAppMessage`,
`AppResponse`/`IAppResponse`, `AppBroadcast`/`IAppBroadcast`) are exported.

### `Long`

`Long` (from the [`long`](https://www.npmjs.com/package/long) library) is re-exported.
64-bit protobuf fields such as `playerId` / `steamId` are modelled as `Long` to preserve
full precision (Steam64 ids exceed `Number.MAX_SAFE_INTEGER`). Build them with
`Long.fromString(steamId)`.

## Usage

The Rust+ protocol: outgoing requests are `AppRequest` messages; responses and
server-pushed broadcasts arrive as `AppMessage` messages.

```ts
import { encodeRequest, decodeMessage, Long } from "@conduit/rustplus-proto";

// Steam64 ids exceed Number.MAX_SAFE_INTEGER → build them as Long.
const playerId = Long.fromString("76561198000000000", /* unsigned */ true);

// Encode a getInfo request to the wire format.
const buf = encodeRequest({
  seq: 1,
  playerId,
  playerToken: 123456789,
  getInfo: {},
});

// Decode a wire-format buffer (a response or a broadcast).
const msg = decodeMessage(someBytesFromTheSocket);
if (msg.response?.info) {
  console.log(msg.response.info.name, msg.response.info.players);
}
```

## Development

```bash
pnpm --filter @conduit/rustplus-proto gen        # regenerate src/generated/
pnpm --filter @conduit/rustplus-proto build      # tsc -b + copy generated → dist/
pnpm --filter @conduit/rustplus-proto typecheck  # tsc -b
pnpm --filter @conduit/rustplus-proto test        # vitest run
```

Tests are written with [vitest](https://vitest.dev/) and round-trip representative
messages through the codec (see `src/index.test.ts`).

---

Part of the [Conduit](../../README.md) monorepo.
