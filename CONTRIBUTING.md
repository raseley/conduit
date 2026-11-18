# Contributing to Conduit

This is the developer guide: how Conduit is built, how to build and test it, and how to run
it from source. If you just want to use Conduit, see the [README](README.md).

**Conduit** is an unofficial client for the **Rust+** companion API (the protocol behind
Facepunch's Rust+ mobile app for the game [Rust](https://rust.facepunch.com/)) together
with a **Discord bot** that lets a user control and monitor their Rust server's smart
devices. The whole thing ships as a **single, double-clickable Windows application** that
walks a non-technical user through everything — from account pairing/registration to a live
control interface — with **Discord as the primary control and configuration surface**.

[`CLAUDE.md`](CLAUDE.md) holds the fuller, module-by-module reference to the architecture
and conventions summarized here.

## How it works under the hood

- **Control smart devices from Discord** — toggle smart switches, read smart-alarm and
  sensor state, and monitor your server through native Discord interactions.
- **Components V2 panels** — one live-edited Discord message per server and device type, with buttons, native
  channel/role selects, and modals; no slash-command spam.
- **Role-based permissions** — per-click permission checks so only authorized roles can
  flip switches or change configuration.
- **Guided onboarding** — a one-time in-app bootstrap wizard handles Steam login, Rust+
  registration/pairing, and the Discord bot token. No config files or command-line secrets.
- **Resilient connection** — one authenticated WebSocket per paired server with
  request/response correlation, server-enforced token-bucket rate limiting, and
  auto-reconnect (backoff + jitter) that re-subscribes tracked entities.
- **Headless tray runtime** — after setup the app lives in the system tray; the only visible
  surfaces are the wizard, a read-only status window, and the Steam login window.
- **Secrets encrypted at rest** — credentials are stored via Electron `safeStorage`.

## Architecture

Conduit is a pnpm monorepo organized as **strict, one-directional dependency tiers**. Each
package may only import from the packages below it in the chain; these boundaries are the
core invariant of the codebase.

```
rustplus-proto  ←  rustplus-client  ←  bot-core  ←  discord
                        fcm          ←
                                     all  ←  apps/desktop (Electron composition root)
```

| Package                    | Path                       | Responsibility                                                                                                                                                                                                                         |
| -------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@conduit/rustplus-proto`  | `packages/rustplus-proto`  | Generated protobuf types + a thin encode/decode codec. The only package that touches protobufjs / `Long`.                                                                                                                              |
| `@conduit/rustplus-client` | `packages/rustplus-client` | One authenticated WebSocket connection to **one** Rust server: request/response correlation, typed broadcast events, token-bucket rate limiting, and auto-reconnect with entity re-subscription. Imports only `rustplus-proto` + `ws`. |
| `@conduit/fcm`             | `packages/fcm`             | Google push delivery + Rust+ pairing/registration. The fragile push-receiver dependency is quarantined behind a driver interface; network calls are injectable seams.                                                                  |
| `@conduit/bot-core`        | `packages/bot-core`        | The coordinator core and single bridge between Discord and the Rust server. Owns one client per paired server and fans pairings + broadcasts into domain events. Imports only `rustplus-client` + `fcm` — **no Discord, no Electron**. |
| `@conduit/discord`         | `packages/discord`         | The primary user surface: discord.js Components V2 panels, buttons, selects, modals, bootstrap slash commands, permission checks, and the switch state-lock machine. Never reaches past `bot-core`.                                    |
| `@conduit/desktop`         | `apps/desktop`             | Electron shell (the shipped `.exe`): a thin glue layer over electron-free logic — a headless `Coordinator` that composes the state store, FCM service, bot-core, and Discord adapter.                                                  |

The boundaries are enforced: `pnpm lint` fails on a cross-tier import.

### Design conventions

- **Injectable seams everywhere** — client factories, drivers, `fetch` functions, loggers,
  and time sources are taken via constructor options so tests run with fakes and no real IO.
- **ESM throughout** — every package is `"type": "module"`; relative imports use `.js`
  extensions (NodeNext resolution).
- **JSON-serializable persisted state** — no class instances, no `Long`, no protobuf, so any
  `StateStore` backend round-trips losslessly.
- **TypeScript `strict`** across the workspace, built with project references (`tsc -b`).

## Prerequisites

- **Node.js** ≥ 22.12 (Electron 45's installer requires it)
- **pnpm** 9 (the repo pins `pnpm@9.15.9` via `packageManager`). Node 22–24 bundle
  Corepack, so `corepack enable` is enough. Node 25+ does not: run
  `npm install -g corepack` first, or install pnpm directly. If `pnpm` fails with
  `Cannot find module ...\corepack\dist\pnpm.js` after a Node upgrade, the Node folder
  still holds the old Corepack shims — delete its `pnpm*`/`pnpx*`/`yarn*` files (elevated
  prompt), then set Corepack up again. Any command here also works as
  `npx pnpm@9.15.9 <command>` in the meantime.
- **Windows** for running/packaging the desktop app (Electron + electron-builder)

## Getting started

```bash
# 1. Install all workspaces
pnpm install

# 2. Generate the protobuf code (REQUIRED before the first build — output is gitignored)
pnpm gen:proto

# 3. Build every package (topological tsc -b)
pnpm build
```

Codegen uses **protobufjs static-module** (`pbjs` / `pbts`), not ts-proto or `protoc` —
`protoc` is deliberately avoided so no native toolchain is needed.

### Running the app from source (Windows / PowerShell)

```powershell
scripts/setup-and-launch.ps1
```

This script handles the whole fresh-checkout → running-Electron path: prerequisites,
dependencies, the Electron binary, `gen:proto`, build, and launch. It checks that `pnpm`
really runs and otherwise uses the pinned version through `npx`. Secrets (Steam, Discord
bot token, server pairing) are entered in the in-app wizard — never on the command line.

### Packaging a distributable `.exe`

```bash
pnpm --filter @conduit/desktop dist
```

Builds the desktop app and runs **electron-builder** (`apps/desktop/electron-builder.yml`).
It produces the NSIS installer `Conduit-<version>-setup.exe` and the portable
`Conduit-<version>-portable.exe` in `apps/desktop/release/`. Official releases are built by
the CI workflow (`.github/workflows/ci.yml`) on a `v*` tag push, not on a developer's
machine.

Versions are calendar-based, `YYYY.M.PATCH` (e.g. `2026.11.0`, then `2026.11.1` for a fix in
the same month). Every `package.json` in the workspace carries the same version, and a
release tag is that version with a `v` in front (`v2026.11.0`); CI fails a tag that does not
match `apps/desktop`'s version.

## Development

Run from the repo root unless noted.

| Command             | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `pnpm install`      | Install all workspaces                                           |
| `pnpm gen:proto`    | Regenerate `@conduit/rustplus-proto` from `proto/rustplus.proto` |
| `pnpm build`        | Build every package (`tsc -b`, topological)                      |
| `pnpm typecheck`    | `tsc -b` across all packages                                     |
| `pnpm test`         | Run vitest across all packages                                   |
| `pnpm lint`         | `eslint .`                                                       |
| `pnpm format`       | `prettier --write .`                                             |
| `pnpm format:check` | `prettier --check .` (the CI gate)                               |
| `pnpm clean`        | Remove `dist/`, `*.tsbuildinfo`, and coverage                    |

### Per-package scripts

```bash
pnpm --filter @conduit/<name> <script>
# e.g.
pnpm --filter @conduit/bot-core test
```

### Running a single test file or test

```bash
pnpm --filter @conduit/bot-core exec vitest run src/index.test.ts
pnpm --filter @conduit/bot-core exec vitest run -t "name of test"
```

Tests use **vitest**. Each package has its own `vitest.config.ts`, which limits discovery to
`src/` (the build also compiles tests into `dist/`); the root `vitest.config.ts` lists the
packages as `projects` for running everything from the root.

### Code style

Prettier: 100 columns, 2-space indent, double quotes, semicolons, trailing commas. ESLint is
pragmatic (`no-explicit-any` off; unused vars warn, with `^_` ignored).

## Project structure

```
conduit/
├── apps/
│   └── desktop/            # Electron shell — the shipped .exe (headless tray coordinator + wizard)
├── packages/
│   ├── rustplus-proto/     # Generated protobuf types + thin codec
│   ├── rustplus-client/    # Authenticated WebSocket connection to one Rust server
│   ├── fcm/                # Google push delivery + Rust+ pairing/registration
│   ├── bot-core/           # Coordinator core; bridge between Discord and the Rust server
│   └── discord/            # discord.js Components V2 user surface
├── proto/                  # rustplus.proto source for codegen
├── scripts/                # gen-proto, setup-and-launch, etc.
└── pnpm-workspace.yaml
```

## Pull requests

Contributions are welcome. When adding functionality, follow the existing conventions:
respect the layered dependency tiers documented above, take dependencies via injectable
seams (constructor options), keep persisted shapes JSON-serializable, and run
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test` before opening a pull
request.

Please report security problems privately, as described in [SECURITY.md](SECURITY.md), not
in a public issue or pull request.
