/**
 * {@link Coordinator} — the headless runtime that wires the four workspace
 * packages together.
 *
 * It composes the persistent {@link StateStore}, {@link FcmService},
 * {@link BotCore}, and {@link DiscordAdapter}, and owns the runtime lifecycle:
 *  - on `start()`, if credentials exist, it starts bot-core, arms the fcm push
 *    listener with stored persistent ids, connects every paired server, and
 *    starts the discord adapter with the stored bot token;
 *  - it subscribes to fcm `credentialsRefreshed` so refreshed creds are persisted;
 *  - it schedules the credential-refresh check;
 *  - it mirrors the start-on-login preference into the OS login item, at startup
 *    and whenever bot-core reports it changed (the Setup hub toggle);
 *  - it tracks per-source health so the tray can render a {@link StatusSnapshot}.
 *
 * This module imports NO `electron`/`discord.js`/`fcm` IO directly beyond the
 * already-electron-free workspace packages, so it unit-tests with fakes. The
 * Electron glue (windows, tray, IPC) sits above it in `main.ts`.
 */

import {
  BotCore,
  type AuthRenewalNotice,
  type ServerConnectionStatus,
  type StateStore,
} from "@conduit/bot-core";
import { FcmService, redact, type FcmCredentials, type FcmRegisterOptions } from "@conduit/fcm";
import { DiscordAdapter, type PanelStore, type PostErrorInfo } from "@conduit/discord";

import type { StatusRow, StatusSnapshot } from "./ipc-contract.js";
import { msUntilExpiry } from "./refresh-scheduler.js";
import { RefreshScheduler, type RefreshSchedulerDeps } from "./refresh-scheduler.js";

/** Minimal structural logger (matches the workspace packages'). */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Health level shared with the tray (status tokens). */
type Level = "online" | "idle" | "down";

/** Dependencies injected into {@link Coordinator} (all swappable in tests). */
export interface CoordinatorDeps {
  store: StateStore;
  fcm: FcmService;
  core: BotCore;
  /** Panel-id persistence bridge (BotCorePanelStore in production). */
  panelStore: PanelStore;
  /**
   * Factory for the discord adapter. Injectable so tests don't construct a real
   * discord.js client; production passes a thunk over `new DiscordAdapter(...)`.
   */
  createDiscordAdapter: (token: string) => DiscordAdapter;
  /**
   * Applies the start-on-login preference to the OS login item. Injected so this
   * module stays electron-free; production passes `applyStartOnLogin` from
   * `start-on-login.ts`. Defaults to a no-op.
   */
  applyStartOnLogin?: (enabled: boolean) => void;
  logger?: Logger;
  /** Current time source (for the token caption + scheduler). */
  now?: () => number;
}

/** A consumer of status updates (the tray window). */
export type StatusListener = (snapshot: StatusSnapshot) => void;

/**
 * The runtime coordinator. Construct with {@link CoordinatorDeps}, then `start()`.
 */
export class Coordinator {
  private readonly store: StateStore;
  private readonly fcm: FcmService;
  private readonly core: BotCore;
  private readonly panelStore: PanelStore;
  private readonly createDiscordAdapter: (token: string) => DiscordAdapter;
  private readonly applyStartOnLogin: (enabled: boolean) => void;
  private readonly log: Logger;
  private readonly now: () => number;

  private discord?: DiscordAdapter;
  private scheduler?: RefreshScheduler;

  /** Per-server connection health, keyed by server id. */
  private readonly serverHealth = new Map<string, Level>();
  private fcmHealth: Level = "down";
  private discordHealth: Level = "down";
  /**
   * Set when the adapter reports a failed channel send (e.g. the bot lacks
   * permission to post in the control channel). The gateway can be connected
   * while posting fails, so this degrades the Discord row independently of
   * {@link discordHealth}. Cleared when the adapter (re)starts cleanly.
   */
  private discordPostError?: string;
  /** Whether {@link discordPostError} degrades the row, or is only a note. */
  private discordPostErrorDegrades = true;
  /**
   * Set while the operator must sign in with Steam again (bot-core's
   * `authRenewalNeeded`); cleared when a refresh or renewal lands new
   * credentials. Shown as a tray row and a "Sign in with Steam again" button.
   */
  private steamRenewal?: AuthRenewalNotice;

  private readonly statusListeners = new Set<StatusListener>();
  private started = false;

  constructor(deps: CoordinatorDeps) {
    this.store = deps.store;
    this.fcm = deps.fcm;
    this.core = deps.core;
    this.panelStore = deps.panelStore;
    this.createDiscordAdapter = deps.createDiscordAdapter;
    this.applyStartOnLogin = deps.applyStartOnLogin ?? (() => {});
    this.log = deps.logger ?? noopLogger;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Whether bootstrap has completed: Steam (fcm) credentials + a Discord bot
   * token, plus the Discord application + server ids the adapter needs to
   * register slash commands. All four are gathered in the wizard; a missing one
   * means setup is incomplete and the wizard should reopen.
   */
  async isBootstrapped(): Promise<boolean> {
    const creds = await this.store.getCredentials();
    const config = this.store.getConfig();
    return Boolean(
      creds?.fcm && creds.discordBotToken && config.discordAppId && config.discordGuildId,
    );
  }

  /**
   * Start the runtime. Loads state, wires fcm credential persistence + health
   * tracking, and — only if bootstrapped — brings the full coordinator online
   * (push listener, server connections, discord adapter). Idempotent.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.core.start();
    this.wireCoreHealth();
    this.wireFcmCredentialPersistence();
    this.wireStartOnLogin();
    // Reflect the persisted preference into the OS (state is loaded by now).
    this.reflectStartOnLogin(this.store.getConfig().startOnLogin);

    this.scheduler = new RefreshScheduler(this.refreshDeps());
    this.scheduler.start();

    const stored = await this.store.getCredentials();
    if (!stored?.fcm || !stored.discordBotToken) {
      this.log.info({}, "coordinator: not bootstrapped yet; staying idle");
      this.emitStatus();
      return;
    }

    await this.bringOnline(stored.fcm, stored.discordBotToken);
  }

  /**
   * Bring the runtime online with concrete credentials. Called by `start()` when
   * already bootstrapped, and by the wizard's `finish` once bootstrap completes.
   */
  async bringOnline(fcmCredentials: FcmCredentials, discordToken: string): Promise<void> {
    // 1. Arm the push listener with stored persistent ids (replay suppression).
    try {
      const persistentIds = await this.store.getPersistentIds();
      await this.fcm.startListening(fcmCredentials, persistentIds);
      this.fcmHealth = "online";
    } catch (err) {
      this.fcmHealth = "down";
      this.log.error({ err }, "coordinator: fcm.startListening failed");
    }

    // 2. Start the discord adapter BEFORE connecting servers, so it subscribes to
    // serverStatusChanged first and never misses the connect event fired in step 3.
    // (The onReady reconcile reads live state too, so this is belt-and-suspenders.)
    try {
      this.discord = this.createDiscordAdapter(discordToken);
      await this.discord.start();
      this.discordHealth = "online";
      this.discordPostError = undefined;
    } catch (err) {
      this.discordHealth = "down";
      this.log.error({ err }, "coordinator: discord adapter start failed");
    }

    // 3. Connect every paired server.
    for (const server of this.core.listServers()) {
      await this.connectPairedServer(server.id);
    }

    this.log.info({ servers: this.core.listServers().length }, "coordinator: online");
    this.emitStatus();
  }

  /** Graceful shutdown: stop discord, the scheduler, and bot-core (+fcm). */
  async stop(): Promise<void> {
    this.scheduler?.stop();
    if (this.discord) {
      try {
        await this.discord.stop();
      } catch (err) {
        this.log.warn({ err }, "coordinator: discord stop failed");
      }
      this.discord = undefined;
    }
    await this.core.stop();
    this.started = false;
  }

  /**
   * Reset the app to a vanilla, just-installed state. Deletes every tracked
   * Discord panel (while the adapter is still logged in), tears the runtime down,
   * wipes all persisted state + credentials, and drops the tray to its empty
   * "down" snapshot. After this the app is no longer bootstrapped, so the caller
   * (`main.ts`) reopens the wizard — same path as a fresh install.
   */
  async resetAll(): Promise<void> {
    // 1. Delete panels first — needs the live, logged-in adapter. Best-effort:
    // a Discord outage must not block the local wipe.
    if (this.discord) {
      try {
        const deleted = await this.discord.deleteAllPanels();
        this.log.info({ deleted }, "coordinator: deleted panels on reset");
      } catch (err) {
        this.log.warn({ err }, "coordinator: deleteAllPanels failed on reset");
      }
    }

    // 2. Tear down the live runtime: discord adapter (old bot token), the
    // scheduler, and bot-core's clients + fcm listener (old credentials).
    await this.stop();

    // 3. Wipe persisted state + credentials back to vanilla.
    await this.store.clear();
    // The wiped config no longer asks to start on login; take the OS login item
    // back with it, or a reset app would keep launching itself at sign-in.
    this.reflectStartOnLogin(this.store.getConfig().startOnLogin);

    // 4. Re-arm the refresh scheduler so the app matches its fresh-launch idle
    // state (the scheduler reads creds lazily from the store, so it no-ops until
    // the wizard stores new ones). The domain-event wiring set up in `start()`
    // survives `stop()` singly-attached, so we deliberately do NOT re-run it here.
    this.scheduler = new RefreshScheduler(this.refreshDeps());
    this.scheduler.start();
    // Keep the coordinator logically "started": the runtime is still alive (core
    // wired, scheduler running), it's just idle until the wizard re-bootstraps it.
    this.started = true;

    // 5. Reset in-memory health and notify the tray immediately.
    this.serverHealth.clear();
    this.steamRenewal = undefined;
    this.fcmHealth = "down";
    this.discordHealth = "down";
    this.emitStatus();
    this.log.info({}, "coordinator: reset to vanilla state");
  }

  /** The {@link PanelStore} the discord adapter should use (wired by `main.ts`). */
  getPanelStore(): PanelStore {
    return this.panelStore;
  }

  // ── status (tray) ───────────────────────────────────────────────────────────

  /** Subscribe to status changes; returns an unsubscribe fn. */
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.snapshot());
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Record a failed Discord send reported by the adapter and refresh the tray.
   * A permission/access error gets an actionable caption pointing at the likely
   * fix (the bot's channel permissions); anything else is reported generically.
   * Discord's 30046 edit cap reads as a note, without degrading the row, when
   * the adapter rebuilt the panels (nothing is left stale).
   */
  reportDiscordPostError(info: PostErrorInfo): void {
    this.discordPostErrorDegrades = !(info.editCap && info.panelsRebuilt);
    this.discordPostError = info.permission
      ? "connected, but can't post — check the bot's channel permissions"
      : info.editCap
        ? info.panelsRebuilt
          ? "connected · Discord limited panel edits; panels were rebuilt"
          : "connected, but Discord is limiting panel edits — panels update less often for now"
        : "connected, but a message failed to send";
    this.log.warn({ ...info }, "discord post failed");
    this.emitStatus();
  }

  /** Build the current health snapshot (wireframe rows). */
  snapshot(): StatusSnapshot {
    const rows: StatusRow[] = [];

    for (const server of this.core.listServers()) {
      const level = this.serverHealth.get(server.id) ?? "down";
      rows.push({
        id: `server:${server.id}`,
        level,
        label: server.name || "Rust server",
        caption: captionFor(level, "connected", "reconnecting…", "disconnected"),
      });
    }

    rows.push({
      id: "fcm",
      level: this.fcmHealth,
      label: "Push listener (FCM)",
      caption: captionFor(this.fcmHealth, "listening", "reconnecting…", "stopped"),
    });

    // A post failure (e.g. missing channel permission) degrades the row even when
    // the gateway is connected: the bot is online but can't do its job. A note
    // (panels rebuilt after Discord's edit cap) only replaces the caption, and
    // only while the gateway is connected.
    const failure = this.discordPostErrorDegrades ? this.discordPostError : undefined;
    const note =
      !this.discordPostErrorDegrades && this.discordHealth === "online"
        ? this.discordPostError
        : undefined;
    rows.push({
      id: "discord",
      level: failure ? "idle" : this.discordHealth,
      label: "Discord gateway",
      caption:
        failure ??
        note ??
        captionFor(this.discordHealth, "connected", "reconnecting…", "disconnected"),
    });

    // Only while a renewal is needed: an expiring sign-in still works (idle),
    // an expired or refused one has cut Conduit off from its servers (down).
    if (this.steamRenewal) {
      const { reason } = this.steamRenewal;
      rows.push({
        id: "steam",
        level: reason === "expiring" ? "idle" : "down",
        label: "Steam sign-in",
        caption:
          reason === "expiring"
            ? "expires soon · sign in again"
            : reason === "expired"
              ? "expired · sign in again"
              : "rejected by Facepunch · sign in again",
      });
    }

    return {
      overall: worst(rows.map((r) => r.level)),
      rows,
      tokenCaption: this.tokenCaption(),
      steamSignInNeeded: this.steamRenewal !== undefined,
    };
  }

  /**
   * Sign in with Steam again, outside the wizard: `opts.onSteamLogin` opens the
   * Steam window (main.ts) and hands the token to `fcm.submitSteamToken`.
   * bot-core persists the new token and reconnects every server with it.
   * Throws whatever the sign-in or registration threw.
   */
  async renewSteamSignIn(opts: FcmRegisterOptions): Promise<void> {
    await this.core.renewCredentials(opts);
    this.steamRenewal = undefined;
    this.emitStatus();
    this.log.info({}, "coordinator: steam sign-in renewed");
  }

  private tokenCaption(): string {
    // Synchronous best-effort; the precise expiry is read async on demand by the
    // status IPC handler. Here we return a neutral caption when unknown.
    return "Steam token status in diagnostics";
  }

  /** Compute the token caption from a known expiry (used by the IPC handler). */
  tokenCaptionFor(steamTokenExpiresAt: string | undefined): string {
    if (!steamTokenExpiresAt) return "Not connected yet";
    const ms = msUntilExpiry(steamTokenExpiresAt, this.now());
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    if (ms <= 0) return "Steam token expired — refreshing…";
    if (days === 0) return "Steam token renews today";
    if (days === 1) return "Steam token renews in 1 day";
    return `Steam token renews in ${days} days`;
  }

  private emitStatus(): void {
    const snap = this.snapshot();
    for (const l of this.statusListeners) {
      try {
        l(snap);
      } catch (err) {
        this.log.warn({ err }, "status listener threw");
      }
    }
  }

  // ── wiring ──────────────────────────────────────────────────────────────────

  private wireCoreHealth(): void {
    // A short drop is `reconnecting` (amber, "reconnecting…"); only one that
    // outlasts bot-core's grace period turns the row red, so a short disconnect does not flap it.
    this.core.on("serverStatusChanged", ({ serverId, status }) => {
      this.serverHealth.set(serverId, healthFor(status));
      this.emitStatus();
    });
    this.core.on("serverPaired", (server) => {
      // Connect a server paired while we run (the wizard's pair step, or an
      // in-game re-pair); otherwise it would sit idle until the next start.
      // connectServer is idempotent for one already connected.
      void this.connectPairedServer(server.id).then(() => this.emitStatus());
    });
  }

  /** Connect one paired server, tracking its health. Never throws. */
  private async connectPairedServer(serverId: string): Promise<void> {
    this.serverHealth.set(serverId, "idle");
    try {
      await this.core.connectServer(serverId);
      // Already connected (a re-pair) changes nothing, so no event says so.
      this.serverHealth.set(serverId, healthFor(this.core.getServerStatus(serverId).status));
    } catch (err) {
      this.serverHealth.set(serverId, "down");
      this.log.warn({ err, serverId }, "coordinator: connectServer failed");
    }
  }

  /**
   * Apply the start-on-login preference whenever it is changed at runtime.
   * bot-core persists the flag (toggled from the Discord Setup hub) and emits
   * `startOnLoginChanged`; registering the OS login item happens here.
   */
  private wireStartOnLogin(): void {
    this.core.on("authRenewalNeeded", (notice) => {
      this.steamRenewal = notice;
      this.emitStatus();
    });
    this.core.on("startOnLoginChanged", ({ enabled }) => {
      this.reflectStartOnLogin(enabled);
    });
  }

  /** Hand the preference to the OS seam; a failure there must never propagate. */
  private reflectStartOnLogin(enabled: boolean): void {
    try {
      this.applyStartOnLogin(enabled);
      this.log.info({ enabled }, "coordinator: applied start-on-login preference");
    } catch (err) {
      this.log.warn({ err, enabled }, "coordinator: applying start-on-login failed");
    }
  }

  /** Persist refreshed credentials whenever fcm emits them. */
  private wireFcmCredentialPersistence(): void {
    this.fcm.on("credentialsRefreshed", (creds: FcmCredentials) => {
      // A new token answers any pending "sign in again".
      if (this.steamRenewal) {
        this.steamRenewal = undefined;
        this.emitStatus();
      }
      void (async () => {
        try {
          const stored = await this.store.getCredentials();
          if (!stored) return;
          await this.store.setCredentials({
            ...stored,
            fcm: creds,
            steamTokenExpiresAt: creds.steamTokenExpiresAt,
          });
          this.log.info({ creds: redact(creds) }, "coordinator: persisted refreshed credentials");
        } catch (err) {
          this.log.error({ err }, "coordinator: persisting refreshed creds failed");
        }
      })();
    });
  }

  private refreshDeps(): RefreshSchedulerDeps {
    return {
      getExpiry: async () => (await this.store.getCredentials())?.steamTokenExpiresAt,
      refresh: async () => {
        await this.core.refreshCredentials();
      },
      // After the automatic refresh (which Facepunch refuses once the token has
      // expired): tell the operator if they must sign in again.
      afterCheck: async () => {
        await this.core.checkAuthToken(this.now());
      },
      now: this.now,
      log: this.log,
    };
  }
}

/** Pick a caption for a level. */
function captionFor(level: Level, online: string, idle: string, down: string): string {
  switch (level) {
    case "online":
      return online;
    case "idle":
      return idle;
    case "down":
      return down;
  }
}

/** The tray level for a server's connection: amber while reconnecting. */
function healthFor(status: ServerConnectionStatus): Level {
  switch (status) {
    case "connected":
      return "online";
    case "reconnecting":
      return "idle";
    case "offline":
      return "down";
  }
}

/** Worst-of: any `down` ⇒ down; else any `idle` ⇒ idle; else online (tray). */
function worst(levels: Level[]): Level {
  if (levels.includes("down")) return "down";
  if (levels.includes("idle")) return "idle";
  return "online";
}
