/**
 * @conduit/desktop — Electron main process (the shipped .exe).
 *
 * At runtime a headless coordinator: hosts `bot-core`, `fcm`, and the `discord`
 * adapter in the main process, holds the Rust+ WebSocket connection(s), and runs
 * in the tray. Its only visible surfaces are the one-time bootstrap wizard, the
 * read-only tray status window, and the Steam login `BrowserWindow`.
 *
 * This file is intentionally thin Electron glue: all real logic lives in the
 * electron-free modules (`Coordinator`, `PersistentStateStore`, wizard machine,
 * refresh scheduler, diagnostics), which are unit-tested without an Electron
 * binary. Here we only: build those pieces with the real Electron-backed
 * dependencies (`safeStorage`, `app.getPath`), open windows, manage the tray, and
 * register the typed IPC handlers that bridge the renderer to the coordinator.
 *
 * ## ESM/CJS decision
 * The package is `"type": "module"` and `tsc` emits ESM, so the main process is
 * ESM. Electron 28+ runs an ESM main entry directly. The preload is likewise ESM
 * and loads because the renderer windows set `sandbox: false` (contextIsolation
 * stays on). This keeps the whole app on one module system — no CJS shims.
 *
 * The module-scope side effects are guarded behind `app` being present so that
 * importing this file in a non-Electron test context (where `electron`'s runtime
 * is unavailable) does not crash; the composition root (`bootstrap`) is exported
 * for completeness but only invoked when Electron is actually running.
 */

import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";

import { BotCore } from "@conduit/bot-core";
import { FcmService } from "@conduit/fcm";
import { DiscordAdapter } from "@conduit/discord";

import { Coordinator } from "./coordinator.js";
import { PersistentStateStore } from "./state-store.js";
import { sendPushover } from "./pushover.js";
import { SafeStorageSecretBox } from "./safe-storage-box.js";
import { BotCorePanelStore } from "./panel-store-bridge.js";
import { createLogger, type LogRing } from "./logger.js";
import { assembleDiagnostics } from "./diagnostics.js";
import { BOT_AVATAR_PATH } from "./asset-paths.js";
import { applyStartOnLogin, isHiddenLaunch } from "./start-on-login.js";
import {
  createStatusWindow,
  createWizardWindow,
  showStatusNearTray,
} from "./windows/app-windows.js";
import { ConduitTray, type TrayLevel } from "./windows/tray.js";
import { openSteamLoginWindow } from "./windows/steam-window.js";
import {
  IPC_OPEN_EXTERNAL,
  IPC_RESET_CONFIG,
  IPC_STATUS_COPY_DIAGNOSTICS,
  IPC_STATUS_RENEW_STEAM,
  IPC_STATUS_GET,
  IPC_EVENT_STATUS,
  IPC_EVENT_WIZARD_STATE,
  IPC_WIZARD_BEGIN_PAIRING,
  IPC_WIZARD_CANCEL_PAIRING,
  IPC_WIZARD_CHECK_INTENTS,
  IPC_WIZARD_CONNECT_STEAM,
  IPC_WIZARD_DETECT_SERVER,
  IPC_WIZARD_FINISH,
  IPC_WIZARD_GET_STATE,
  IPC_WIZARD_SELECT_SERVER,
  IPC_WIZARD_SETUP_CHANNELS,
  IPC_WIZARD_SUBMIT_DISCORD_TOKEN,
  IPC_WIZARD_SUBMIT_SERVER_ID,
  type BeginPairingResult,
  type StatusSnapshot,
  type SteamRenewalResult,
  type SubmitResult,
} from "./ipc-contract.js";
import {
  INTENT_OFF_MESSAGE,
  discordProbeMessage,
  initialWizardSnapshot,
  serverDetectionEvent,
  validateDiscordToken,
  validateSnowflake,
  wizardReduce,
  type ChannelFallbackReason,
  type WizardEvent,
  type WizardServer,
  type WizardSnapshot,
} from "./wizard-machine.js";
import {
  createDiscordProbe,
  DiscordAuthError,
  DiscordForbiddenError,
  PERMISSION,
  hasPermission,
  type DiscordApplication,
  type DiscordGuild,
  type DiscordProbe,
} from "./discord-probe.js";
import {
  SteamSignInError,
  classifySteamConnectError,
  steamFailureEvent,
  steamRenewalResult,
} from "./steam-sign-in.js";

/** Wizard copy when a picked server is no longer among the detected choices. */
const STALE_SERVER_CHOICE_MESSAGE =
  "That server isn't in the list any more. Click Search again to refresh it.";

/**
 * The whole running app, assembled. Exported so a future Playwright/E2E harness
 * can drive it; in normal operation `runApp()` wires
 * it to the Electron lifecycle.
 */
export class DesktopApp {
  private store!: PersistentStateStore;
  private fcm!: FcmService;
  private core!: BotCore;
  private coordinator!: Coordinator;
  private logRing!: LogRing;
  private log = console;

  private wizardWindow?: BrowserWindow;
  private statusWindow?: BrowserWindow;
  /** A "Sign in with Steam again" in progress, shared by the tray and the status window. */
  private steamRenewal?: Promise<SteamRenewalResult>;
  private tray?: ConduitTray;

  private wizardState: WizardSnapshot = initialWizardSnapshot();
  /**
   * Bot token captured on the wizard's Discord-token step. The token is entered
   * BEFORE Steam in the new flow, but `StoredCredentials` requires the fcm creds
   * obtained during the Steam step — so we hold the token here until Steam
   * completes, then persist both together.
   */
  private pendingDiscordToken?: string;
  /** The bot's user id from the token check (for its overwrite on Conduit's channels). */
  private botUserId?: string;
  /** The servers last detected on the invite step, with the bot's permissions in each. */
  private detectedGuilds: DiscordGuild[] = [];
  /** Pending fcm.register() promise during the wizard's Steam step. */
  private registerInFlight?: Promise<void>;
  /** True while a pairing wait is armed (guards against double-arming). */
  private pairingArmed = false;
  /** Detaches the in-flight pairing wait (set while armed, cleared on settle). */
  private cancelPairingWait?: () => void;

  private readonly dataDir: string;
  /** Live Discord checks for the wizard (token → application, invite → servers). */
  private readonly discordProbe: DiscordProbe;

  constructor(dataDir: string, discordProbe: DiscordProbe = createDiscordProbe()) {
    this.dataDir = dataDir;
    this.discordProbe = discordProbe;
  }

  /** Build the coordinator + persistence (Electron-backed). */
  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });

    const { logger, ring } = await createLogger(this.dataDir);
    this.logRing = ring;
    this.log = logger as unknown as Console;

    const secretBox = new SafeStorageSecretBox();
    this.store = new PersistentStateStore({ dataDir: this.dataDir, secretBox });

    this.fcm = new FcmService({ logger });
    this.core = new BotCore(this.store, this.fcm, { logger, pushover: sendPushover });
    const panelStore = new BotCorePanelStore(this.core);

    this.coordinator = new Coordinator({
      store: this.store,
      fcm: this.fcm,
      core: this.core,
      panelStore,
      // applicationId/guildId are NOT passed here: the adapter reads them from
      // AppConfig (collected in the bootstrap wizard, persisted via the store).
      createDiscordAdapter: (token) =>
        new DiscordAdapter({
          core: this.core,
          token,
          logger,
          panelStore,
          // Surface failed sends (e.g. missing channel permission) to the tray
          // health row instead of letting them fail silently.
          onPostError: (info) => this.coordinator.reportDiscordPostError(info),
          // A bot with no avatar gets the Conduit mark; the adapter reads
          // this only when the bot has none.
          botAvatar: async () => new Uint8Array(await fs.readFile(BOT_AVATAR_PATH)),
        }),
      // The coordinator mirrors the start-on-login preference into the OS login
      // item: at startup, when it is toggled from the Setup hub, and on reset.
      applyStartOnLogin,
      logger,
    });

    // Push live status to the tray icon + status window.
    this.coordinator.onStatus((snap) => this.onStatusSnapshot(snap));
  }

  /**
   * Start the runtime + open the right surface (wizard vs. tray). A login-item
   * launch (`launchedHidden`, the `--hidden` flag) opens no window at all; an
   * unfinished setup stays reachable by launching Conduit again (see
   * {@link onSecondInstance}).
   */
  async start(launchedHidden = false): Promise<void> {
    await this.coordinator.start();

    this.createTrayAndStatus();
    this.registerIpcHandlers();

    if (!launchedHidden && !(await this.coordinator.isBootstrapped())) {
      this.openWizard();
    }
  }

  /**
   * Conduit was launched again while running: bring the wizard forward if setup
   * is unfinished, otherwise show the tray status window. A second login-item
   * launch (`--hidden`) stays silent.
   */
  async onSecondInstance(argv: readonly string[]): Promise<void> {
    if (isHiddenLaunch(argv)) return;
    if (
      (this.wizardWindow && !this.wizardWindow.isDestroyed()) ||
      !(await this.coordinator.isBootstrapped())
    ) {
      this.openWizard();
      return;
    }
    if (!this.statusWindow || this.statusWindow.isDestroyed()) {
      this.statusWindow = createStatusWindow();
    }
    showStatusNearTray(this.statusWindow);
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    await this.coordinator.stop();
    this.tray?.destroy();
  }

  // ── windows ───────────────────────────────────────────────────────────────

  private openWizard(): void {
    if (this.wizardWindow && !this.wizardWindow.isDestroyed()) {
      this.wizardWindow.focus();
      return;
    }
    this.wizardWindow = createWizardWindow();
    this.wizardWindow.on("closed", () => {
      this.wizardWindow = undefined;
    });
  }

  private createTrayAndStatus(): void {
    this.statusWindow = createStatusWindow();
    this.tray = new ConduitTray(
      () => this.toggleStatusWindow(),
      () => {
        void this.shutdown().finally(() => app.quit());
      },
      () => {
        void this.renewSteamSignIn().then((result) => {
          this.log.info?.({ ok: result.ok }, "tray: steam sign-in again finished");
        });
      },
    );
    this.tray.create();
    // The "go online" status is emitted during coordinator.start(), before the
    // tray exists, so that push is dropped. Seed the freshly-created tray with
    // the current snapshot so it reflects reality instead of its initial "down".
    this.tray.setLevel(this.coordinator.snapshot().overall);
  }

  /**
   * Sign in with Steam again, outside the wizard: the companion auth
   * token lasts 14 days and Facepunch refuses to refresh an expired one. Opens
   * the Steam window; the coordinator persists the new token and reconnects.
   * One run at a time, whether started from the tray or the status window.
   */
  private renewSteamSignIn(): Promise<SteamRenewalResult> {
    if (!this.steamRenewal) {
      this.steamRenewal = this.runSteamRenewal().finally(() => {
        this.steamRenewal = undefined;
      });
    }
    return this.steamRenewal;
  }

  private async runSteamRenewal(): Promise<SteamRenewalResult> {
    let tokenCaptured = false;
    const parent =
      this.statusWindow && !this.statusWindow.isDestroyed() && this.statusWindow.isVisible()
        ? this.statusWindow
        : undefined;
    try {
      await this.coordinator.renewSteamSignIn({
        onSteamLogin: (url) =>
          new Promise<void>((resolve, reject) => {
            openSteamLoginWindow({
              url,
              parent,
              onToken: (token) => {
                tokenCaptured = true;
                try {
                  this.fcm.submitSteamToken(token);
                  resolve();
                } catch (err) {
                  reject(err as Error);
                }
              },
              onCancelled: () => reject(new SteamSignInError({ kind: "cancelled" })),
              onFailed: (failure) => reject(new SteamSignInError(failure)),
            });
          }),
      });
      return steamRenewalResult(undefined);
    } catch (err) {
      const failure = classifySteamConnectError(err, { tokenCaptured });
      if (failure.kind === "cancelled") {
        this.log.info?.({}, "steam sign-in again: cancelled by the user");
      } else {
        this.log.error?.({ err, failure: failure.kind }, "steam sign-in again failed");
      }
      return steamRenewalResult(failure);
    }
  }

  private toggleStatusWindow(): void {
    if (!this.statusWindow || this.statusWindow.isDestroyed()) {
      this.statusWindow = createStatusWindow();
    }
    if (this.statusWindow.isVisible()) {
      this.statusWindow.hide();
    } else {
      showStatusNearTray(this.statusWindow);
    }
  }

  private onStatusSnapshot(snap: StatusSnapshot): void {
    this.tray?.setLevel(snap.overall as TrayLevel);
    if (this.statusWindow && !this.statusWindow.isDestroyed()) {
      this.statusWindow.webContents.send(IPC_EVENT_STATUS, snap);
    }
  }

  // ── wizard state plumbing ───────────────────────────────────────────────────

  /** Apply events in order and push the result once (no half-applied frame). */
  private applyWizardEvent(...events: WizardEvent[]): void {
    for (const event of events) this.wizardState = wizardReduce(this.wizardState, event);
    if (this.wizardWindow && !this.wizardWindow.isDestroyed()) {
      this.wizardWindow.webContents.send(IPC_EVENT_WIZARD_STATE, this.wizardState);
    }
  }

  /**
   * The servers the bot is already in, looked up as the invite step opens: on a
   * re-run of the wizard the bot is usually still in the server, and the step
   * offers it instead of the invite instructions. A failed lookup is logged and
   * reads as none, so it never blocks the step: the instructions show, and
   * their button looks again.
   */
  private async serversAlreadyJoined(token: string): Promise<WizardEvent | undefined> {
    try {
      this.detectedGuilds = await this.discordProbe.listGuilds(token);
    } catch (err) {
      this.detectedGuilds = [];
      this.log.warn?.({ err }, "wizard: looking for servers the bot is already in failed");
      return undefined;
    }
    this.log.info?.(
      { servers: this.detectedGuilds.length },
      "wizard: servers the bot is already in",
    );
    return { type: "invite.found", servers: this.detectedGuilds.map(toWizardServer) };
  }

  /** Forget the wizard's progress, for a fresh run after a reset. */
  private resetWizard(): void {
    this.cancelPairingWait?.();
    this.wizardState = initialWizardSnapshot();
    this.pendingDiscordToken = undefined;
    this.botUserId = undefined;
    this.detectedGuilds = [];
    this.applyWizardEvent();
  }

  /**
   * Arm the fcm push listener and wait for the first server pairing. Called
   * automatically when the wizard reaches the pair step (and again by the
   * renderer's retry button after an error). Idempotent while a wait is in
   * flight, so a stray re-trigger never stacks listeners or restarts the socket.
   */
  private armPairing(): void {
    if (this.pairingArmed) return;
    this.pairingArmed = true;
    this.applyWizardEvent({ type: "pair.start" });

    const onPaired = (server: { name: string }): void => {
      this.core.off("serverPaired", onPaired);
      this.pairingArmed = false;
      this.cancelPairingWait = undefined;
      this.applyWizardEvent({
        type: "pair.received",
        serverName: server.name,
      });
    };
    this.core.on("serverPaired", onPaired);
    this.cancelPairingWait = () => {
      this.core.off("serverPaired", onPaired);
      this.pairingArmed = false;
      this.cancelPairingWait = undefined;
    };

    this.core.beginPairing().catch((err) => {
      this.core.off("serverPaired", onPaired);
      this.pairingArmed = false;
      this.cancelPairingWait = undefined;
      this.applyWizardEvent({
        type: "pair.error",
        message: "Pairing failed. Make sure you clicked Pair in-game.",
      });
      this.log.warn?.({ err }, "wizard: beginPairing failed");
    });
  }

  /** The bot token from the wizard's bot step (or, when re-running it, the stored one). */
  private async heldDiscordToken(): Promise<string | undefined> {
    if (this.pendingDiscordToken) return this.pendingDiscordToken;
    return (await this.store.getCredentials())?.discordBotToken || undefined;
  }

  /**
   * Store the chosen Discord server, then either advance past the invite step
   * or, when the user asked for them, create Conduit's channels first.
   */
  private async saveServer(server: WizardServer, createChannels: boolean): Promise<void> {
    const config = this.store.getConfig();
    config.discordGuildId = server.id;
    await this.store.setConfig(config);
    if (!createChannels) {
      this.applyWizardEvent({ type: "invite.done", server });
      return;
    }
    this.applyWizardEvent({ type: "channels.submit", server });
    await this.setUpChannels(server.id);
  }

  /**
   * Create (or reuse) Conduit's private category with #conduit and #conduit-log
   * and save them as the control and logging channels. Without permission, or
   * on any failure, the wizard falls back instead of failing the step.
   */
  private async setUpChannels(guildId: string): Promise<void> {
    const fallback = (reason: ChannelFallbackReason): void =>
      this.applyWizardEvent({ type: "channels.fallback", reason });

    const token = await this.heldDiscordToken();
    if (!token) {
      this.log.warn?.({ guildId }, "wizard: no bot token held to create channels");
      fallback("failed");
      return;
    }
    // Known only for a detected server; a manually entered one just tries.
    const permissions = this.detectedGuilds.find((g) => g.id === guildId)?.permissions;
    if (permissions !== undefined && !hasPermission(permissions, PERMISSION.MANAGE_CHANNELS)) {
      this.log.info?.({ guildId }, "wizard: bot lacks Manage Channels; channel fallback");
      fallback("missing-permission");
      return;
    }
    try {
      const botUserId = this.botUserId ?? (await this.discordProbe.getApplication(token)).botUserId;
      const channels = await this.discordProbe.ensureConduitChannels(token, {
        guildId,
        botUserId,
        botPermissions: permissions,
      });
      const config = this.store.getConfig();
      config.controlChannelId = channels.control.id;
      config.loggingChannelId = channels.logging.id;
      await this.store.setConfig(config);
      this.log.info?.(
        {
          guildId,
          category: { id: channels.category.id, created: channels.category.created },
          control: { id: channels.control.id, created: channels.control.created },
          logging: { id: channels.logging.id, created: channels.logging.created },
        },
        "wizard: conduit channels ready",
      );
      this.applyWizardEvent({
        type: "channels.done",
        category: channels.category.name,
        control: channels.control.name,
        logging: channels.logging.name,
      });
    } catch (err) {
      const forbidden = err instanceof DiscordForbiddenError;
      this.log.warn?.({ err, guildId }, "wizard: creating conduit channels failed; fallback");
      fallback(forbidden ? "forbidden" : "failed");
    }
  }

  // ── IPC ─────────────────────────────────────────────────────────────────────

  private registerIpcHandlers(): void {
    ipcMain.handle(IPC_WIZARD_GET_STATE, () => this.wizardState);

    ipcMain.handle(IPC_WIZARD_CONNECT_STEAM, async (): Promise<WizardSnapshot> => {
      this.applyWizardEvent({ type: "steam.start" });
      // Set once the Steam window hands back a token: a failure after that point
      // is the Companion registration, not the sign-in.
      let tokenCaptured = false;
      try {
        // fcm.register opens the Steam window via onSteamLogin; the captured
        // token is fed back through fcm.submitSteamToken inside that callback.
        const creds = await this.fcm.register({
          onSteamLogin: (url) =>
            new Promise<void>((resolve, reject) => {
              openSteamLoginWindow({
                url,
                parent: this.wizardWindow,
                onToken: (token) => {
                  tokenCaptured = true;
                  try {
                    this.fcm.submitSteamToken(token);
                    resolve();
                  } catch (err) {
                    reject(err as Error);
                  }
                },
                onCancelled: () => reject(new SteamSignInError({ kind: "cancelled" })),
                // The failure is token-free; it reaches the log as fcm's AuthError
                // cause, and the wizard copy through classifySteamConnectError.
                onFailed: (failure) => reject(new SteamSignInError(failure)),
              });
            }),
        });

        // Persist the freshly-registered credentials (encrypted), folding in
        // the bot token captured on the earlier Discord-token step.
        const existing = await this.store.getCredentials();
        await this.store.setCredentials({
          fcm: creds,
          discordBotToken: this.pendingDiscordToken ?? existing?.discordBotToken ?? "",
          steamTokenExpiresAt: creds.steamTokenExpiresAt,
        });
        this.applyWizardEvent({ type: "steam.done" });
        // Pair is the next (and final) step. Arm the push listener now so the
        // user sees "Listening — pair in-game now…" the moment they land there,
        // instead of an unarmed "Waiting for a pairing…".
        this.armPairing();
      } catch (err) {
        const failure = classifySteamConnectError(err, { tokenCaptured });
        this.applyWizardEvent(steamFailureEvent(failure));
        if (failure.kind === "cancelled") {
          this.log.info?.({}, "wizard: steam sign-in cancelled by the user");
        } else {
          this.log.error?.({ err, failure: failure.kind }, "wizard: steam connect failed");
        }
      }
      return this.wizardState;
    });

    // Bot step: check the token's shape, then live with Discord. The check also
    // yields the Application ID (for the invite URL and the adapter's config).
    ipcMain.handle(
      IPC_WIZARD_SUBMIT_DISCORD_TOKEN,
      async (_e, token: unknown): Promise<SubmitResult> => {
        const raw = typeof token === "string" ? token : "";
        const problem = validateDiscordToken(raw);
        if (problem) {
          this.applyWizardEvent({ type: "bot.error", message: problem });
          return { ok: false, message: problem };
        }
        this.applyWizardEvent({ type: "bot.submit" });
        const trimmed = raw.trim();

        let application: DiscordApplication;
        try {
          application = await this.discordProbe.getApplication(trimmed);
        } catch (err) {
          // Probe errors never carry the token, so the error object is log-safe.
          const message = discordProbeMessage(err, "token");
          this.applyWizardEvent({ type: "bot.error", message });
          this.log.warn?.({ err }, "wizard: bot token check failed");
          return { ok: false, message };
        }

        // The token is entered before Steam, so credentials may not exist yet.
        // Hold it in memory; connectSteam persists it alongside the fcm creds. If
        // creds already exist (re-running the wizard), update them in place too.
        this.pendingDiscordToken = trimmed;
        this.botUserId = application.botUserId;
        const existing = await this.store.getCredentials();
        if (existing) {
          await this.store.setCredentials({ ...existing, discordBotToken: trimmed });
        }
        const config = this.store.getConfig();
        config.discordAppId = application.id;
        await this.store.setConfig(config);
        this.applyWizardEvent({
          type: "bot.done",
          appId: application.id,
          botName: application.name,
        });
        return { ok: true };
      },
    );

    // Intents step: verify the Server Members intent through the app's flags
    // instead of trusting the "I've enabled it" click.
    ipcMain.handle(IPC_WIZARD_CHECK_INTENTS, async (): Promise<WizardSnapshot> => {
      if (this.wizardState.current !== "intents") return this.wizardState;
      const token = await this.heldDiscordToken();
      if (!token) {
        this.applyWizardEvent({
          type: "intents.error",
          message: discordProbeMessage(new DiscordAuthError("no bot token held"), "intents"),
        });
        return this.wizardState;
      }
      this.applyWizardEvent({ type: "intents.submit" });
      try {
        const application = await this.discordProbe.getApplication(token);
        if (!application.membersIntentEnabled) {
          this.applyWizardEvent({ type: "intents.error", message: INTENT_OFF_MESSAGE });
          return this.wizardState;
        }
        // Look before the invite step shows, so it opens in the right layout.
        const found = await this.serversAlreadyJoined(token);
        this.applyWizardEvent({ type: "intents.done" }, ...(found ? [found] : []));
      } catch (err) {
        this.applyWizardEvent({
          type: "intents.error",
          message: discordProbeMessage(err, "intents"),
        });
        this.log.warn?.({ err }, "wizard: intent check failed");
      }
      return this.wizardState;
    });

    // Invite step: find the server the bot was invited to. One → stored and
    // advance; several → picker (selectServer); none → retry. Renderer input is
    // untrusted: only a literal `true` asks for the channels.
    ipcMain.handle(
      IPC_WIZARD_DETECT_SERVER,
      async (_e, createChannels: unknown): Promise<WizardSnapshot> => {
        if (this.wizardState.current !== "invite") return this.wizardState;
        const token = await this.heldDiscordToken();
        if (!token) {
          this.applyWizardEvent({
            type: "invite.error",
            message: discordProbeMessage(new DiscordAuthError("no bot token held"), "servers"),
          });
          return this.wizardState;
        }
        this.applyWizardEvent({ type: "invite.submit" });
        let guilds: DiscordGuild[];
        try {
          guilds = await this.discordProbe.listGuilds(token);
        } catch (err) {
          this.applyWizardEvent({
            type: "invite.error",
            message: discordProbeMessage(err, "servers"),
          });
          this.log.warn?.({ err }, "wizard: server detection failed");
          return this.wizardState;
        }
        this.detectedGuilds = guilds;
        // The wizard shows only what the renderer needs, not the permissions.
        const event = serverDetectionEvent(guilds.map(toWizardServer));
        if (event.type === "invite.done") {
          await this.saveServer(event.server, createChannels === true);
        } else {
          this.applyWizardEvent(event);
        }
        return this.wizardState;
      },
    );

    // After a channel fallback: try again, or continue without the channels.
    ipcMain.handle(
      IPC_WIZARD_SETUP_CHANNELS,
      async (_e, create: unknown): Promise<WizardSnapshot> => {
        const state = this.wizardState;
        const server = state.server;
        if (
          state.current !== "invite" ||
          state.steps.invite === "busy" ||
          state.channels?.kind !== "fallback" ||
          !server
        ) {
          return state;
        }
        if (create !== true) {
          this.log.info?.({ guildId: server.id }, "wizard: continuing without conduit channels");
          this.applyWizardEvent({ type: "channels.skip" });
          return this.wizardState;
        }
        this.applyWizardEvent({ type: "channels.submit", server });
        // Re-read the bot's permissions: re-inviting it may have added Manage Channels.
        const token = await this.heldDiscordToken();
        if (token) {
          try {
            this.detectedGuilds = await this.discordProbe.listGuilds(token);
          } catch (err) {
            this.detectedGuilds = [];
            this.log.warn?.({ err }, "wizard: re-reading server permissions failed");
          }
        }
        await this.setUpChannels(server.id);
        return this.wizardState;
      },
    );

    // Picker, or the one server the bot was already in: the id must be one of
    // the servers just detected (renderer input is untrusted).
    ipcMain.handle(
      IPC_WIZARD_SELECT_SERVER,
      async (_e, serverId: unknown, createChannels: unknown): Promise<SubmitResult> => {
        const choice =
          this.wizardState.current === "invite"
            ? this.wizardState.serverChoices?.find((s) => s.id === serverId)
            : undefined;
        if (!choice) {
          this.applyWizardEvent({ type: "invite.error", message: STALE_SERVER_CHOICE_MESSAGE });
          return { ok: false, message: STALE_SERVER_CHOICE_MESSAGE };
        }
        this.applyWizardEvent({ type: "invite.submit" });
        await this.saveServer(choice, createChannels === true);
        return { ok: true };
      },
    );

    // Manual fallback: a Server ID copied with Discord's Developer Mode.
    ipcMain.handle(
      IPC_WIZARD_SUBMIT_SERVER_ID,
      async (_e, serverId: unknown, createChannels: unknown): Promise<SubmitResult> => {
        const raw = typeof serverId === "string" ? serverId : "";
        const problem = validateSnowflake(raw, "Server ID");
        if (problem) {
          this.applyWizardEvent({ type: "invite.error", message: problem });
          return { ok: false, message: problem };
        }
        this.applyWizardEvent({ type: "invite.submit" });
        await this.saveServer({ id: raw.trim() }, createChannels === true);
        return { ok: true };
      },
    );

    ipcMain.handle(IPC_WIZARD_BEGIN_PAIRING, async (): Promise<BeginPairingResult> => {
      // Pairing is armed automatically on entering the pair step; this handler
      // re-arms after an error (the renderer's retry button) and is a no-op
      // while a wait is already in flight.
      this.armPairing();
      return {
        paired: this.wizardState.complete,
        serverName: this.wizardState.pairedServerName,
      };
    });

    ipcMain.handle(IPC_WIZARD_CANCEL_PAIRING, async () => {
      this.cancelPairingWait?.();
      this.applyWizardEvent({ type: "pair.cancel" });
      await this.fcm.stopListening();
    });

    ipcMain.handle(IPC_WIZARD_FINISH, async () => {
      const stored = await this.store.getCredentials();
      if (stored?.fcm && stored.discordBotToken) {
        await this.coordinator.bringOnline(stored.fcm, stored.discordBotToken);
      }
      if (this.wizardWindow && !this.wizardWindow.isDestroyed()) {
        this.wizardWindow.close();
      }
    });

    ipcMain.handle(IPC_STATUS_GET, async (): Promise<StatusSnapshot> => this.buildStatusSnapshot());

    ipcMain.handle(IPC_STATUS_RENEW_STEAM, async (): Promise<SteamRenewalResult> =>
      this.renewSteamSignIn(),
    );

    ipcMain.handle(IPC_STATUS_COPY_DIAGNOSTICS, async (): Promise<string> => {
      const blob = await this.buildDiagnostics();
      await clipboard.writeText(blob);
      return blob;
    });

    // Wipe everything back to a vanilla state. Confirmed with a native dialog
    // (destructive + irreversible), deletes all tracked Discord panels, clears
    // persisted state + credentials, then reopens the bootstrap wizard.
    ipcMain.handle(IPC_RESET_CONFIG, async (): Promise<boolean> => {
      const parent =
        this.statusWindow && !this.statusWindow.isDestroyed() ? this.statusWindow : undefined;
      const opts = {
        type: "warning" as const,
        buttons: ["Cancel", "Reset everything"],
        defaultId: 0,
        cancelId: 0,
        title: "Reset configuration",
        message: "Reset Conduit to a clean state?",
        detail:
          "This deletes all Conduit panels from your Discord server and erases " +
          "every saved setting — your Steam/Discord login, paired servers, and " +
          "devices. You'll go back through the setup wizard. This can't be undone.",
      };
      const { response } = parent
        ? await dialog.showMessageBox(parent, opts)
        : await dialog.showMessageBox(opts);
      if (response !== 1) return false;

      await this.coordinator.resetAll();
      // The wizard runs again from the start, not from where it last finished.
      this.resetWizard();
      this.openWizard();
      return true;
    });

    // Open instructional/invite links in the user's default browser. Restricted
    // to https so a compromised renderer can't launch arbitrary schemes.
    ipcMain.handle(IPC_OPEN_EXTERNAL, async (_e, url: string): Promise<void> => {
      if (typeof url === "string" && /^https:\/\//i.test(url)) {
        await shell.openExternal(url);
      } else {
        this.log.warn?.({ url }, "openExternal: refused non-https url");
      }
    });
  }

  /** Snapshot with the token caption filled from the stored expiry. */
  private async buildStatusSnapshot(): Promise<StatusSnapshot> {
    const snap = this.coordinator.snapshot();
    const creds = await this.store.getCredentials();
    snap.tokenCaption = this.coordinator.tokenCaptionFor(creds?.steamTokenExpiresAt);
    return snap;
  }

  private async buildDiagnostics(): Promise<string> {
    const snap = await this.buildStatusSnapshot();
    const creds = await this.store.getCredentials();
    const servers = this.core.listServers();
    const entityCount = servers.reduce((n, s) => n + this.core.listEntities(s.id).length, 0);
    const persistentIds = await this.store.getPersistentIds();
    return assembleDiagnostics({
      appVersion: app.getVersion(),
      platform: {
        electron: process.versions.electron,
        node: process.versions.node,
        os: `${os.type()} ${os.release()}`,
        arch: process.arch,
      },
      status: snap,
      counts: {
        servers: servers.length,
        entities: entityCount,
        persistentIds: persistentIds.length,
        hasCredentials: Boolean(creds?.fcm),
        hasDiscordToken: Boolean(creds?.discordBotToken),
      },
      steamTokenExpiresAt: creds?.steamTokenExpiresAt,
      recentLogLines: this.logRing.lines(),
      generatedAt: Date.now(),
    });
  }
}

/** A detected server as the wizard shows it (no permissions). */
function toWizardServer(guild: DiscordGuild): WizardServer {
  const server: WizardServer = { id: guild.id, name: guild.name };
  if (guild.iconUrl !== undefined) server.iconUrl = guild.iconUrl;
  return server;
}

/** Resolve the app data directory (`%APPDATA%/Conduit`). */
function resolveDataDir(): string {
  try {
    return app.getPath("userData");
  } catch {
    return path.join(os.homedir(), ".conduit");
  }
}

/**
 * Wire the {@link DesktopApp} to the Electron lifecycle. Only called when running
 * under Electron (guarded in the module footer).
 */
export async function runApp(): Promise<void> {
  // Single-instance: a second launch focuses the existing instance.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();
  const desktop = new DesktopApp(resolveDataDir());
  await desktop.init();
  await desktop.start(isHiddenLaunch(process.argv));

  // Bring the wizard / status window forward when a second copy is launched.
  app.on("second-instance", (_event, argv) => {
    void desktop.onSecondInstance(argv);
  });

  // Keep running in the tray when all windows are closed (headless coordinator).
  app.on("window-all-closed", () => {
    // Do NOT quit: the app lives in the tray.
  });

  app.on("before-quit", () => {
    void desktop.shutdown();
  });
}

// Only auto-run under a real Electron runtime. `app` is a usable object only when
// Electron is hosting the process; importing this module in a plain-Node test
// must not boot the app.
if (app && typeof app.whenReady === "function" && process.versions.electron) {
  void runApp();
}
