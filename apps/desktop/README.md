# @conduit/desktop

> The Electron shell — the shipped Conduit Windows `.exe`.

`@conduit/desktop` is the composition root of [Conduit](../../README.md): the
Electron application that bundles every workspace package into one
double-clickable executable. At runtime it is a **headless coordinator**, not a
control surface — it hosts `bot-core`, `fcm`, and the `discord` adapter in the
main process, holds the Rust+ WebSocket connection(s), and lives in the system
tray. Its only visible surfaces are the one-time **bootstrap wizard**, the
read-only **tray status window**, and the isolated **Steam login window**. All
ongoing control and configuration happen in Discord.

## Role in the monorepo

This package sits at the top of Conduit's one-directional dependency chain — it
is the only place the four runtime packages are wired together:

```
rustplus-proto ← rustplus-client ← bot-core ← discord
                 fcm              ←
                                  all ← apps/desktop  (this package)
```

It depends on `@conduit/bot-core`, `@conduit/discord`, `@conduit/fcm`, and
`@conduit/rustplus-client`, plus `pino` for logging. It has no native dependencies (see
[State persistence](#state-persistence)).

## Architecture: thin Electron glue over electron-free logic

`src/main.ts` is intentionally thin Electron glue. It only builds the real
pieces with their Electron-backed dependencies (`safeStorage`, `app.getPath`),
opens windows, manages the tray, and registers the typed IPC handlers that
bridge the renderer to the coordinator. All real logic lives in **electron-free
modules** that unit-test without an Electron binary.

| Module                                  | Responsibility                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coordinator.ts`                        | `Coordinator` — the headless runtime. Composes the `StateStore`, `FcmService`, `BotCore`, and `DiscordAdapter`; owns the lifecycle (`start()` connects paired servers and starts the adapter); persists refreshed credentials; schedules the credential-refresh check; tracks per-source health for the tray snapshot. |
| `wizard-machine.ts`                     | Pure reducer for the six-step bootstrap wizard (Create bot → Enable intents → Invite bot → Connect Steam → Pair server → Finish in Discord), plus the pure mappings from side-effect results to events and copy. Owns step/status bookkeeping only; visuals live in the renderer and side effects in `main.ts`.        |
| `discord-probe.ts`                      | The wizard's live Discord checks over an injectable `fetch`: `GET /applications/@me` validates the bot token and yields the Application ID and Server Members intent flag; `GET /users/@me/guilds` finds the server the bot was invited to. Validates responses and fails closed with typed errors.                    |
| `steam-sign-in.ts`                      | Why a Connect Steam attempt failed (cancelled, Facepunch refused, Facepunch's flow changed, registration failed, unreachable) and the distinct wizard copy for each.                                                                                                                                                   |
| `conduit-mark.ts` / `asset-paths.ts`    | The Conduit mark rasterized in code for the status-colored tray icon (a port of `assets/icon/render.mjs`, which generates the shipped `.ico`, window icon and bot avatar), and where those shipped files sit in `dist/assets/icon/`.                                                                                   |
| `state-store.ts`                        | `PersistentStateStore` — bot-core's `StateStore` backed by JSON files under the app data directory, held in memory and mirrored to disk on every mutation.                                                                                                                                                             |
| `secret-box.ts` / `safe-storage-box.ts` | `SecretBox` encryption seam and its `SafeStorageSecretBox` impl. Credentials are encrypted at rest via Electron `safeStorage` (DPAPI on Windows) and never written in plaintext.                                                                                                                                       |
| `refresh-scheduler.ts`                  | `RefreshScheduler` — decides when the ~2-week Steam auth token is near expiry and drives `bot-core.refreshCredentials()`. Pure decision function + injectable clock.                                                                                                                                                   |
| `panel-store-bridge.ts`                 | `BotCorePanelStore` — implements discord's `PanelStore` by delegating to bot-core setters so Discord panels survive restarts.                                                                                                                                                                                          |
| `diagnostics.ts`                        | Assembles the tray's "Copy diagnostics" support blob, reusing `@conduit/fcm`'s `redact` so secrets are never included.                                                                                                                                                                                                 |
| `ipc-contract.ts`                       | The typed IPC contract — channel names and payload shapes shared by the main process and the renderer (`invoke:*` = renderer→main request/response, `event:*` = main→renderer push).                                                                                                                                   |

### State persistence

The on-disk store uses **plain JSON files** under the app data directory
(`%APPDATA%/Conduit` at runtime). For a single-operator app the data is tiny and
has no relational queries or concurrent writers, so SQLite buys nothing and would
cost a fragile native dependency.

## Commands

Run from the repo root via the workspace filter, or from this directory.

```bash
pnpm --filter @conduit/desktop build       # tsc -b, then copy renderer assets into dist/
pnpm --filter @conduit/desktop typecheck   # tsc -b (type-check only)
pnpm --filter @conduit/desktop test        # vitest run
pnpm --filter @conduit/desktop dist        # build, then package the .exe with electron-builder
```

| Script      | Command                                                            | What it does                                                             |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `build`     | `tsc -b && node ./scripts/copy-renderer.mjs`                       | Compiles the package and copies the renderer static assets into `dist/`. |
| `typecheck` | `tsc -b`                                                           | Type-checks via project references.                                      |
| `test`      | `vitest run`                                                       | Runs the package's unit tests (all electron-free).                       |
| `dist`      | `pnpm run build && electron-builder --config electron-builder.yml` | Produces the shipped Windows artifacts.                                  |

> **Prerequisite:** the generated proto package must exist before the first
> build. From the repo root run `pnpm install` then `pnpm gen:proto` (see the
> [contributing guide](../../CONTRIBUTING.md)).

### Packaging

`pnpm --filter @conduit/desktop dist` runs the build and then electron-builder
against `electron-builder.yml`, producing both an **NSIS installer** and a
**portable single `.exe`** (Windows x64; app id `com.conduit.desktop`,
product name `Conduit`). Output lands in `release/`. Auto-update against GitHub
Releases is stubbed in the config until the repo owner and code-signing cert are
set. Packaging requires Electron's binary to be downloaded locally.

## Configuration & secrets

There are no command-line secrets. Steam login, the Discord bot token, and
server pairing are all entered in the in-app **bootstrap wizard** on first run.
Secrets (the Steam/push credentials, the Discord bot token, each paired server's
player token and the Pushover keys) are persisted encrypted via Electron
`safeStorage` in `credentials.bin`; non-secret state lives as readable JSON in
`state.json` alongside it.

## Conventions

- **ESM throughout.** The package is `"type": "module"` and `tsc` emits ESM;
  Electron 28+ runs the ESM main entry directly. Relative imports use explicit
  `.js` extensions (NodeNext resolution).
- **Electron-free, testable modules.** All real logic is decoupled from the
  Electron runtime so it unit-tests with fakes and no Electron binary; `main.ts`
  is the only Electron-coupled module.
- **Injectable seams.** Dependencies (the `SecretBox`, clocks, the state-store
  base directory, loggers, the workspace services) are injected via constructor
  options so tests can substitute fakes.
- **Renderer isolation.** Renderer windows run with `contextIsolation: true` and
  `nodeIntegration: false`; they reach the main process only through the typed
  IPC contract exposed by the preload `contextBridge`.

## See also

- [Root README](../../README.md) — what Conduit does, for the people who run it.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — full architecture and workspace-level
  commands.
