/**
 * {@link BotCore} — the coordinator core.
 *
 * The single bridge from a Discord intent to a Rust+ request. It owns one
 * {@link RustPlusClient} per paired server, maps high-level operations and
 * configuration onto client calls + persisted state, and fans `fcm` pairings
 * and client broadcasts into a small set of domain events the discord adapter
 * subscribes to. It imports only `@conduit/rustplus-client` and `@conduit/fcm`
 * — no Discord, no Electron.
 */

import { EventEmitter } from "node:events";

import {
  AuthError,
  EntityNotFoundError,
  RustPlusClient,
  type EntityChange,
  type EntityInfo,
  type GameTime,
  type RustPlusClientOptions,
  type ServerInfo,
  type TeamChatMessage,
  type TeamInfo,
} from "@conduit/rustplus-client";
import {
  FcmService,
  type AlarmNotification,
  type DeathNotification,
  type FcmCredentials,
  type FcmRegisterOptions,
  type PairingNotification,
} from "@conduit/fcm";

import { StateError, ValidationError } from "./errors.js";
import type { StateStore } from "./store.js";
import type {
  AlarmNotificationLevel,
  AppConfig,
  LegacyPanelIds,
  PairedEntity,
  PairedServer,
  PushoverSeverity,
  RenewalReminderRecord,
  RoleCapabilityMap,
  ServerPanelIds,
  StoredCredentials,
  SwitchAutoAction,
  SwitchGroup,
} from "./types.js";

/**
 * Default state-lock timeout. bot-core exposes this constant; the
 * timeout UX itself lives in the discord adapter, which restores the prior
 * button state if no confirming broadcast arrives within this window.
 */
export const DEFAULT_STATE_LOCK_TIMEOUT_MS = 10_000;

/** Default beginPairing() wait before resolving without a pairing. */
const DEFAULT_PAIRING_TIMEOUT_MS = 60_000;

/** Default switch auto-revert delay (seconds) when none is configured. */
export const SWITCH_AUTO_DELAY_DEFAULT = 300;
/** Minimum accepted switch auto-revert delay (seconds). */
export const SWITCH_AUTO_DELAY_MIN = 30;
/** Maximum accepted switch auto-revert delay (seconds). */
export const SWITCH_AUTO_DELAY_MAX = 3600;

/**
 * Most switches one group holds. Actuating a group spends two requests
 * per member (set, then read back), so ten stays inside the server's 25-token
 * rate-limit bucket, and an adapter can show every member at once.
 */
export const SWITCH_GROUP_MAX_MEMBERS = 10;
/** Longest switch group name accepted, in characters. */
export const SWITCH_GROUP_NAME_MAX = 64;

/**
 * One-shot timer abstraction so the auto-revert engine is testable without real
 * clocks. Mirrors the discord adapter's seam; the host/tests can inject fakes.
 */
export interface TimerProvider {
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const defaultTimers: TimerProvider = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Minimal structural logger; defaults to a no-op so bot-core is silent. */
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

/** Factory for a {@link RustPlusClient}; injectable so tests pass a fake. */
export type ClientFactory = (opts: RustPlusClientOptions) => RustPlusClient;

/** A single Pushover notification to deliver. */
export interface PushoverMessage {
  /** Pushover application API token. */
  appToken: string;
  /** Pushover user or group key (the recipient). */
  userKey: string;
  /** Notification title. */
  title: string;
  /** Notification body. */
  message: string;
  /** Pushover priority (−2…2); bot-core only uses −1 | 0 | 1. */
  priority: number;
}

/**
 * Delivers a Pushover notification. Injectable so tests pass a fake and the
 * desktop composition root supplies the concrete `fetch`-based sender; defaults
 * to a no-op (Pushover disabled).
 */
export type PushoverNotifier = (msg: PushoverMessage) => Promise<void>;

/** No-op notifier: Pushover is disabled unless the host injects a real sender. */
const noopNotifier: PushoverNotifier = async () => {};

/** Map a per-alarm severity to a Pushover priority. */
export function severityToPriority(severity: PushoverSeverity): number {
  switch (severity) {
    case "low":
      return -1;
    case "medium":
      return 0;
    case "high":
      return 1;
  }
}

/** Construction options for {@link BotCore}. */
export interface BotCoreOptions {
  /** Override the rustplus-client constructor (test seam). */
  clientFactory?: ClientFactory;
  /** Structural logger; defaults to a no-op. */
  logger?: Logger;
  /**
   * Delivers Pushover notifications when a configured smart alarm fires.
   * Defaults to a no-op; the desktop composition root injects the concrete
   * `fetch`-based sender.
   */
  pushover?: PushoverNotifier;
  /**
   * State-lock timeout the discord adapter should honor. Stored and
   * surfaced via {@link BotCore.stateLockTimeoutMs}; bot-core does not itself
   * arm a timer — the timeout UX is the adapter's.
   */
  stateLockTimeoutMs?: number;
  /** Override the beginPairing() wait window. */
  pairingTimeoutMs?: number;
  /**
   * One-shot timer source for the switch auto-revert engine. Defaults to
   * `setTimeout`/`clearTimeout`; tests inject a controllable fake.
   */
  timers?: TimerProvider;
  /**
   * How long a server that dropped may take to reconnect before it is reported
   * `offline`. Until then it is `reconnecting`, so a short drop does not flap. Defaults to
   * {@link SERVER_OFFLINE_GRACE_MS}.
   */
  offlineGraceMs?: number;
  /** Clock (ms epoch) for a dropped server's `lastSeenAt`. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * How long a dropped server may take to reconnect before it is reported
 * offline. Long enough to ride out a companion-socket restart (seen live: back
 * in 2 s), short enough that a real outage is reported within a minute.
 */
export const SERVER_OFFLINE_GRACE_MS = 60_000;

/**
 * A paired server's connection, as adapters show it:
 * - `connected`: the connection is live.
 * - `reconnecting`: it dropped and the client is reconnecting, within the grace
 *   period ({@link BotCoreOptions.offlineGraceMs}). Show the last known data;
 *   device actions are unavailable.
 * - `offline`: it has not come back within the grace period, or it has not
 *   connected yet this session.
 */
export type ServerConnectionStatus = "connected" | "reconnecting" | "offline";

/** A server's connection status; see {@link BotCore.getServerStatus}. */
export interface ServerStatus {
  status: ServerConnectionStatus;
  /**
   * When the connection was last known to be live (ms epoch): the moment it
   * dropped. Set while `reconnecting` or `offline` after a drop; absent for a
   * server that has not connected this session.
   */
  lastSeenAt?: number;
}

/**
 * Domain event payloads emitted by {@link BotCore} for the discord adapter.
 * Each carries the `serverId` so the adapter can route to the right panel.
 */
export interface BotCoreEventMap {
  /** A server was paired (fcm `serverPairing`) and persisted. */
  serverPaired: [PairedServer];
  /** An entity was paired (fcm `entityPairing`) and persisted. */
  entityPaired: [PairedEntity];
  /**
   * An entity was removed from state (via {@link BotCore.removeEntity}). It is
   * already gone from `listEntities` by the time this fires.
   */
  entityRemoved: [{ serverId: string; entityId: number }];
  /** A smart alarm fired (fcm `alarm`). */
  alarmTriggered: [AlarmNotification];
  /** The operator's player died (fcm `death`). */
  playerDeath: [DeathNotification];
  /** A tier-3 entity-state broadcast (closes a switch state-lock). */
  entityChanged: [{ serverId: string; change: EntityChange }];
  /**
   * An entity's current state, read with `getEntityInfo` when its server
   * (re)connects. Not a change: the value may be the one already shown, and an
   * alarm reported `true` here is not a new firing. Lets the adapter correct a
   * panel whose device changed while the server was unreachable.
   */
  entityRefreshed: [{ serverId: string; entityId: number; info: EntityInfo }];
  /** A team-chat message relayed from a server. */
  teamChat: [{ serverId: string; message: TeamChatMessage }];
  /**
   * A server's connection status changed (see {@link ServerConnectionStatus}).
   * Emitted only on a change. A drop goes `connected` → `reconnecting`; it
   * becomes `offline` only if the server is not back within the grace period, so
   * a short blip is `reconnecting` → `connected`. `reason` is the close reason
   * of a drop.
   */
  serverStatusChanged: [
    ServerStatus & {
      serverId: string;
      previous: ServerConnectionStatus;
      reason?: string;
    },
  ];
  /**
   * The start-on-login preference was set (via {@link BotCore.setStartOnLogin}).
   * bot-core only persists the flag; the desktop host listens for this and
   * applies it to the OS login item.
   */
  startOnLoginChanged: [{ enabled: boolean }];
  /**
   * The operator must sign in with Steam again (on the PC running Conduit) for
   * the companion socket to keep working: the auth token is inside the
   * reminder schedule ({@link AUTH_RENEWAL_MILESTONES_MS}, `expiring`), has
   * expired (`expired`), or the companion socket refused it (`rejected`).
   * Emitted once per milestone and expiry, not on every check; a restart does
   * not repeat a reminder already sent.
   */
  authRenewalNeeded: [AuthRenewalNotice];
}

/** Why the Steam sign-in needs renewing; see `BotCoreEventMap.authRenewalNeeded`. */
export interface AuthRenewalNotice {
  reason: "expiring" | "expired" | "rejected";
  /** ISO-8601 expiry of the current token, when known. */
  expiresAt?: string;
  /**
   * Which reminder this is, in ms before {@link expiresAt}: one of
   * {@link AUTH_RENEWAL_MILESTONES_MS} for `expiring`, `0` for `expired`.
   * Absent for `rejected`, which has no schedule.
   */
  milestoneMs?: number;
}

/** The Steam sign-in's state, from {@link BotCore.checkAuthToken}. */
export type AuthTokenState = "ok" | "missing" | AuthRenewalNotice["reason"];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * When to remind the operator, in ms before the companion auth token (the
 * Steam login token, valid 14 days) expires: 48h, 24h, 12h, 4h, 3h, 2h, 1h,
 * 30 min, 5 min, 1 min. Expiry itself is the last reminder (`expired`). The
 * desktop host tries an automatic refresh from the first milestone on; a
 * reminder only reaches the operator if that has not renewed the token.
 */
export const AUTH_RENEWAL_MILESTONES_MS: readonly number[] = [
  48 * HOUR_MS,
  24 * HOUR_MS,
  12 * HOUR_MS,
  4 * HOUR_MS,
  3 * HOUR_MS,
  2 * HOUR_MS,
  HOUR_MS,
  30 * MINUTE_MS,
  5 * MINUTE_MS,
  MINUTE_MS,
];

/**
 * The reminder milestone in force at `now`: the smallest one at or above the
 * time left, `0` once the token has expired (or its expiry does not parse), or
 * `undefined` while the token is outside the schedule.
 */
export function authRenewalMilestone(expiresAt: string, now: number): number | undefined {
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return 0;
  const left = expiry - now;
  if (left <= 0) return 0;
  let current: number | undefined;
  for (const milestone of AUTH_RENEWAL_MILESTONES_MS) {
    if (milestone >= left && (current === undefined || milestone < current)) current = milestone;
  }
  return current;
}

/**
 * The next instant (ms epoch) strictly after `now` at which a reminder
 * milestone (expiry itself included) falls, or `undefined` when the token has
 * already expired or its expiry is unknown. Pure; the host wakes at it.
 */
export function nextAuthRenewalMilestoneAt(
  expiresAt: string | undefined,
  now: number,
): number | undefined {
  if (!expiresAt) return undefined;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return undefined;
  let next: number | undefined;
  for (const milestone of [...AUTH_RENEWAL_MILESTONES_MS, 0]) {
    const at = expiry - milestone;
    if (at > now && (next === undefined || at < next)) next = at;
  }
  return next;
}

/** Whether two reminders are the same one (same expiry, reason and milestone). */
function sameReminder(a: RenewalReminderRecord, b: RenewalReminderRecord): boolean {
  return a.reason === b.reason && a.expiresAt === b.expiresAt && a.milestoneMs === b.milestoneMs;
}

type BotCoreEventName = keyof BotCoreEventMap;

interface ManagedClient {
  server: PairedServer;
  client: RustPlusClient;
  /**
   * Entity ids to re-request on every (re)connect (state-lock interest). Seeded
   * once from the persisted entities, grown by {@link BotCore.getEntity}, and
   * shrunk when the server says an entity cannot be reached.
   */
  interest: Set<number>;
  /** Whether {@link interest} has been seeded from the persisted entities. */
  seeded: boolean;
  /** Set by a disconnect: the next `connected` must re-request {@link interest}. */
  needsResync: boolean;
  /** The re-subscription pass in flight, shared by overlapping triggers. */
  resync: Promise<void> | null;
}

const defaultClientFactory: ClientFactory = (opts) => new RustPlusClient(opts);

/**
 * The coordinator core. See the class-level docs for the full
 * contract; every Discord interaction resolves to a method here.
 */
export class BotCore extends EventEmitter {
  private readonly store: StateStore;
  private readonly fcm: FcmService;
  private readonly clientFactory: ClientFactory;
  /**
   * The Rust+ companion auth token (the Steam login token) every client offers
   * when it dials the companion socket. Cached from the credential store on
   * `connectServer` and on a credential refresh; clients read it through a getter.
   */
  private companionAuthToken: string | undefined;
  /**
   * The companion socket refused {@link companionAuthToken}. Clients are then
   * offered no token, so a server with a direct address falls back to it, until
   * a new token arrives (refresh or renewal).
   */
  private authTokenRejected = false;
  /**
   * The last `authRenewalNeeded` this process sent, so each is sent once. The
   * same record is persisted on the credentials, so a restart does not repeat it.
   */
  private lastRenewalNotice: AuthRenewalNotice | undefined;
  /** In-flight {@link connectServer} attempts by server id, shared by overlapping calls. */
  private readonly connecting = new Map<string, Promise<void>>();
  private readonly log: Logger;
  private readonly pushover: PushoverNotifier;

  /** State-lock timeout the adapter should honor. */
  readonly stateLockTimeoutMs: number;
  private readonly pairingTimeoutMs: number;

  /** One managed client per connected server, keyed by server id. */
  private readonly clients = new Map<string, ManagedClient>();

  private readonly timers: TimerProvider;

  /** Armed switch auto-revert timers, keyed `${serverId}:${entityId}`. */
  private readonly autoTimers = new Map<string, unknown>();

  /** Each server's connection status, and its grace timer while reconnecting. */
  private readonly connection = new Map<string, ServerStatus & { graceTimer?: unknown }>();
  private readonly offlineGraceMs: number;
  private readonly now: () => number;

  private started = false;

  /**
   * Settle hook for an in-flight {@link beginPairing} wait. Set while armed,
   * cleared when the wait settles. {@link cancelPairing} calls it to resolve the
   * pending promise early.
   */
  private settlePairing?: () => void;

  constructor(store: StateStore, fcm: FcmService, opts: BotCoreOptions = {}) {
    super();
    this.store = store;
    this.fcm = fcm;
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.log = opts.logger ?? noopLogger;
    this.pushover = opts.pushover ?? noopNotifier;
    this.stateLockTimeoutMs = opts.stateLockTimeoutMs ?? DEFAULT_STATE_LOCK_TIMEOUT_MS;
    this.pairingTimeoutMs = opts.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;
    this.timers = opts.timers ?? defaultTimers;
    this.offlineGraceMs = opts.offlineGraceMs ?? SERVER_OFFLINE_GRACE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  // Typed event overloads so adapters get exact payload shapes.
  on<E extends BotCoreEventName>(event: E, listener: (...args: BotCoreEventMap[E]) => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  private emitEvent<E extends BotCoreEventName>(event: E, ...args: BotCoreEventMap[E]): boolean {
    return super.emit(event, ...args);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Rehydrate state from the store and wire up fcm pairing/alarm listeners. Does
   * NOT auto-connect servers (the desktop scheduler / adapter decides when to
   * `connectServer`) and does NOT arm the push listener (that is `beginPairing`).
   */
  async start(): Promise<void> {
    if (this.started) return;
    await this.store.load();
    this.wireFcm();
    this.started = true;
    this.log.info({ servers: this.store.listServers().length }, "bot-core started");
  }

  /** Disconnect every client and stop the fcm listener. */
  async stop(): Promise<void> {
    this.clearAllAutoTimers();
    for (const entry of this.connection.values()) {
      if (entry.graceTimer !== undefined) this.timers.clearTimer(entry.graceTimer);
    }
    this.connection.clear();
    for (const managed of this.clients.values()) {
      try {
        await managed.client.disconnect();
      } catch (err) {
        this.log.warn({ err, serverId: managed.server.id }, "disconnect failed");
      }
    }
    this.clients.clear();
    try {
      await this.fcm.stopListening();
    } catch (err) {
      this.log.warn({ err }, "fcm.stopListening failed");
    }
    this.started = false;
  }

  // ── server & entity management ─────────────────────────────────────────────

  listServers(): PairedServer[] {
    return this.store.listServers();
  }

  listEntities(serverId: string): PairedEntity[] {
    return this.store.listEntities(serverId);
  }

  getConfig(): AppConfig {
    return this.store.getConfig();
  }

  /**
   * Whether the {@link RustPlusClient} for a paired server currently holds a live
   * connection. Returns false for unknown/never-connected servers. Used by
   * adapters to render real connection state on reconcile rather than guessing.
   */
  isServerConnected(serverId: string): boolean {
    return this.clients.get(serverId)?.client.connected ?? false;
  }

  /**
   * A server's connection status as adapters show it: `reconnecting`
   * through a short drop, `offline` once the grace period has passed (or before
   * its first connect). The same status `serverStatusChanged` reports.
   */
  getServerStatus(serverId: string): ServerStatus {
    const entry = this.connection.get(serverId);
    if (!entry) return { status: "offline" };
    return entry.lastSeenAt === undefined
      ? { status: entry.status }
      : { status: entry.status, lastSeenAt: entry.lastSeenAt };
  }

  /** The server's connection is live: report `connected` (if it was not). */
  private markConnected(serverId: string): void {
    const entry = this.connection.get(serverId) ?? { status: "offline" };
    if (entry.graceTimer !== undefined) this.timers.clearTimer(entry.graceTimer);
    this.connection.set(serverId, { status: "connected" });
    if (entry.status === "connected") return;
    this.log.info(
      { serverId, previous: entry.status, downMs: this.downFor(entry) },
      entry.status === "offline" ? "server online" : "server back within the grace period",
    );
    this.emitEvent("serverStatusChanged", {
      serverId,
      status: "connected",
      previous: entry.status,
    });
  }

  /**
   * The server's connection dropped: report `reconnecting`, and `offline` if it
   * is not back within the grace period. Only a live connection can drop.
   */
  private markDropped(serverId: string, reason?: string): void {
    const entry = this.connection.get(serverId);
    if (entry?.status !== "connected") return;
    const lastSeenAt = this.now();
    const graceTimer = this.timers.setTimer(() => this.markOffline(serverId), this.offlineGraceMs);
    this.connection.set(serverId, { status: "reconnecting", lastSeenAt, graceTimer });
    this.log.info({ serverId, graceMs: this.offlineGraceMs, reason }, "server reconnecting");
    this.emitEvent("serverStatusChanged", {
      serverId,
      status: "reconnecting",
      previous: "connected",
      lastSeenAt,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /** The grace period passed without a reconnect: report `offline`. */
  private markOffline(serverId: string): void {
    const entry = this.connection.get(serverId);
    if (entry?.status !== "reconnecting") return;
    const { lastSeenAt } = entry;
    this.connection.set(serverId, { status: "offline", lastSeenAt });
    this.log.warn({ serverId, graceMs: this.offlineGraceMs }, "server offline: not back in time");
    this.emitEvent("serverStatusChanged", {
      serverId,
      status: "offline",
      previous: "reconnecting",
      ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
    });
  }

  /** How long a server has been down, for the log; undefined if never seen. */
  private downFor(entry: ServerStatus): number | undefined {
    return entry.lastSeenAt === undefined ? undefined : this.now() - entry.lastSeenAt;
  }

  /**
   * Create (if needed) and connect the {@link RustPlusClient} for a paired
   * server. Idempotent: if already connected, re-issues getEntityInfo for tracked
   * entities (so the server resumes broadcasting after a manual reconnect).
   *
   * Rejects if this attempt fails, so the caller can show why. The client then
   * keeps trying by itself (a server that is down when the app starts connects
   * once it is up); `serverStatusChanged` reports it when it gets through.
   */
  async connectServer(serverId: string): Promise<void> {
    // Overlapping calls (the startup connect and a pairing push replayed during
    // it, say) share one attempt. Run independently, both would pass the
    // no-client-yet check across the credential read below and each build a
    // client, or race connect() into "already in progress".
    const inFlight = this.connecting.get(serverId);
    if (inFlight) return inFlight;
    const attempt = this.connectServerOnce(serverId).finally(() => {
      this.connecting.delete(serverId);
    });
    this.connecting.set(serverId, attempt);
    return attempt;
  }

  private async connectServerOnce(serverId: string): Promise<void> {
    const server = this.store.getServer(serverId);
    if (!server) throw new StateError(`Unknown server: ${serverId}`);

    // Refresh the cached companion auth token before (re)connecting.
    this.companionAuthToken = (await this.store.getCredentials())?.fcm.steamAuthToken;

    let managed = this.clients.get(serverId);
    if (!managed) {
      // Facepunch's companion socket, addressed by the server id and
      // authenticated with the Steam login token (read at every reconnect, so a
      // renewed token is picked up). Current servers advertise no direct address.
      const client = this.clientFactory({
        companion: {
          serverId: server.id,
          getAuthToken: () => (this.authTokenRejected ? undefined : this.companionAuthToken),
        },
        ip: server.ip,
        port: server.port,
        playerId: server.playerId,
        playerToken: server.playerToken,
        // bot-core re-subscribes itself on reconnect (resyncInterest), because
        // it needs the results; the client's own pass would request each
        // entity a second time.
        resubscribeOnReconnect: false,
      });
      managed = {
        server,
        client,
        interest: new Set<number>(),
        seeded: false,
        needsResync: false,
        resync: null,
      };
      this.clients.set(serverId, managed);
      this.wireClient(managed);
    }

    try {
      await managed.client.connect();
    } catch (err) {
      // The client keeps trying by itself (and reports a token it gives up on
      // as `authRejected`). When it gets through, the `connected` handler has
      // to request the entities: this call no longer will.
      managed.needsResync = true;
      throw err;
    }
    // After a disconnect, the `connected` handler has already started this
    // pass; joining it requests each entity once.
    await this.resyncInterest(managed);
  }

  /**
   * Run {@link reregisterInterest}, or join the pass already in flight. Two
   * triggers can coincide: `connectServer`, and the client's `connected` event
   * after a disconnect (which also fires for a `connectServer` reconnect).
   */
  private resyncInterest(managed: ManagedClient): Promise<void> {
    if (!managed.resync) {
      managed.resync = this.reregisterInterest(managed).finally(() => {
        managed.resync = null;
      });
    }
    return managed.resync;
  }

  /**
   * On (re)connect, re-issue getEntityInfo for every entity we hold interest in,
   * so the server resumes broadcasting changes; re-arm each switch's
   * auto-revert from its current state; and emit `entityRefreshed` so panels
   * catch up with anything that changed while the server was unreachable.
   * Seeds interest from the persisted entities the first time, so panels
   * rebuilt on startup work.
   *
   * An entity the server says cannot be reached (`EntityNotFoundError`) leaves
   * the interest set, as it leaves the client's tracked set: neither layer
   * requests it again until something asks for it ({@link getEntity}). Its
   * persisted entity and panel stay: removing a device is the operator's call.
   */
  private async reregisterInterest(managed: ManagedClient): Promise<void> {
    const serverId = managed.server.id;
    if (!managed.seeded) {
      managed.seeded = true;
      for (const e of this.store.listEntities(serverId)) {
        // Cameras are addressed by identifier, not a broadcastable entity id.
        if (e.entityType !== "camera") managed.interest.add(e.entityId);
      }
    }
    const requested = managed.interest.size;
    let failed = 0;
    for (const entityId of [...managed.interest]) {
      let info: EntityInfo;
      try {
        info = await managed.client.getEntityInfo(entityId);
      } catch (err) {
        failed += 1;
        this.dropInterestIfGone(managed, entityId, err);
        this.log.warn({ err, serverId, entityId }, "re-subscribe getEntityInfo failed");
        continue;
      }
      // Arm-on-connect: a switch already sitting in its trigger state should
      // begin its auto-revert countdown immediately, not wait for a toggle.
      this.evaluateAutoTimer(serverId, entityId, info.value ?? false);
      this.emitEvent("entityRefreshed", { serverId, entityId, info });
    }
    this.log.info(
      { serverId, requested, refreshed: requested - failed, failed },
      "rust+ entities re-subscribed",
    );
  }

  /**
   * Forget interest in an entity the server says this player cannot reach, so
   * a later reconnect does not request it again. (The client has already
   * stopped tracking it.)
   */
  private dropInterestIfGone(managed: ManagedClient, entityId: number, err: unknown): void {
    if (err instanceof EntityNotFoundError) managed.interest.delete(entityId);
  }

  // ── operations (every Discord command lands here) ──────────────────────────

  /**
   * Set a switch on/off then return its info. The confirming `entityChanged`
   * domain event arrives separately as the tier-3 broadcast; the adapter closes
   * the state-lock on that event.
   */
  async toggleEntity(serverId: string, entityId: number, on: boolean): Promise<EntityInfo> {
    const managed = this.requireClient(serverId);
    this.registerInterest(managed, entityId);
    try {
      await managed.client.setEntityValue(entityId, on);
      return await managed.client.getEntityInfo(entityId);
    } catch (err) {
      this.dropInterestIfGone(managed, entityId, err);
      throw err;
    }
  }

  /**
   * Fetch an entity's info. Issuing getEntityInfo also registers interest, so the
   * server starts broadcasting subsequent changes and the client re-subscribes on
   * reconnect — this is the call a panel makes on creation.
   */
  async getEntity(serverId: string, entityId: number): Promise<EntityInfo> {
    const managed = this.requireClient(serverId);
    this.registerInterest(managed, entityId);
    try {
      return await managed.client.getEntityInfo(entityId);
    } catch (err) {
      this.dropInterestIfGone(managed, entityId, err);
      throw err;
    }
  }

  /**
   * Forget a paired entity entirely: drop it from persistence, stop tracking
   * interest — both bot-core's own set and the client's re-subscription set, so
   * neither a manual nor an automatic reconnect re-requests it — and clear any
   * armed auto-revert timer. The symmetric inverse of {@link onEntityPairing}.
   * Emits `entityRemoved` so the adapter can take it off the panel. No-ops if
   * the entity is unknown.
   */
  async removeEntity(serverId: string, entityId: number): Promise<void> {
    const entity = this.store.getEntity(serverId, entityId);
    if (!entity) return;

    const managed = this.clients.get(serverId);
    if (managed) {
      managed.interest.delete(entityId);
      // The client keeps its own tracked set (filled by every getEntityInfo) and
      // re-issues those requests on each automatic reconnect. Dropping only our
      // interest would leave it re-requesting — and spending rate-limit tokens
      // on — a device the operator removed, for the life of the client.
      managed.client.untrackEntity(entityId);
    }

    const key = BotCore.autoTimerKey(serverId, entityId);
    const timer = this.autoTimers.get(key);
    if (timer !== undefined) {
      this.timers.clearTimer(timer);
      this.autoTimers.delete(key);
    }

    await this.store.removeEntity(serverId, entityId);
    await this.dropFromSwitchGroups(serverId, entityId);
    this.emitEvent("entityRemoved", { serverId, entityId });
  }

  /**
   * Register a panel's interest in an entity: issues getEntityInfo so
   * the server begins broadcasting changes, and records the id so the client
   * re-subscribes on reconnect. The discord adapter calls this when it creates or
   * reconstructs an entity panel.
   */
  async registerEntityInterest(serverId: string, entityId: number): Promise<EntityInfo> {
    return this.getEntity(serverId, entityId);
  }

  /**
   * Register a CCTV camera by the string identifier the player set on the in-game
   * Computer Station. Unlike switches/alarms, cameras are not FCM-paired — they are
   * addressed by identifier, so this is their dedicated add path. A stable negative
   * `entityId` is derived from the identifier (real Rust entity ids are positive, so
   * there is no collision) and used as the persistence/panel key. Re-adding the same
   * identifier updates the existing camera's label rather than duplicating it. Emits
   * `entityPaired` so the adapter lays out a panel.
   */
  async addCamera(serverId: string, identifier: string, label?: string): Promise<PairedEntity> {
    const trimmed = identifier.trim();
    if (!trimmed) {
      throw new ValidationError("addCamera: camera identifier must not be empty");
    }
    if (!this.store.getServer(serverId)) {
      throw new StateError(`addCamera: unknown server ${serverId}`);
    }
    const entityId = cameraEntityId(trimmed);
    const existing = this.store.getEntity(serverId, entityId);
    const entity: PairedEntity = {
      serverId,
      entityId,
      entityType: "camera",
      identifier: trimmed,
      label: label?.trim() || existing?.label,
      panelMessageId: existing?.panelMessageId,
    };
    await this.store.upsertEntity(entity);
    this.emitEvent("entityPaired", entity);
    return entity;
  }

  /**
   * Capture a single still image from a registered camera (by its identifier).
   *
   * @throws {CameraUnavailableError} (re-exported from this package) when the
   *   server will not show the camera; its `reason` says why: the player is
   *   in-game (`playerOnline`), no such camera (`notFound`), or no image arrived
   *   (`noFrames`).
   */
  async getCameraFrame(serverId: string, identifier: string): Promise<Uint8Array> {
    const managed = this.requireClient(serverId);
    return managed.client.getCameraFrame(identifier, 0);
  }

  async getServerInfo(serverId: string): Promise<ServerInfo> {
    return this.requireClient(serverId).client.getInfo();
  }

  /** Fetch the server's in-game clock (`getTime`). */
  async getServerTime(serverId: string): Promise<GameTime> {
    return this.requireClient(serverId).client.getTime();
  }

  async getTeam(serverId: string): Promise<TeamInfo> {
    return this.requireClient(serverId).client.getTeamInfo();
  }

  async sendTeamMessage(serverId: string, message: string): Promise<void> {
    await this.requireClient(serverId).client.sendTeamMessage(message);
  }

  // ── configuration (persisted here; submitted from Discord panels) ──────────

  async setControlChannel(channelId: string): Promise<void> {
    const config = this.store.getConfig();
    config.controlChannelId = channelId;
    await this.store.setConfig(config);
  }

  async setLoggingChannel(channelId: string): Promise<void> {
    const config = this.store.getConfig();
    config.loggingChannelId = channelId;
    await this.store.setConfig(config);
  }

  /**
   * Persist the start-on-login preference and announce it with
   * `startOnLoginChanged`. bot-core has no access to the OS (no Electron here):
   * registering the login item is the desktop host's job, driven by that event.
   */
  async setStartOnLogin(enabled: boolean): Promise<void> {
    const config = this.store.getConfig();
    config.startOnLogin = enabled;
    await this.store.setConfig(config);
    this.emitEvent("startOnLoginChanged", { enabled });
  }

  async setEntityLabel(serverId: string, entityId: number, label: string): Promise<void> {
    const entity = this.store.getEntity(serverId, entityId);
    if (!entity) {
      throw new StateError(`Unknown entity ${entityId} on server ${serverId}`);
    }
    entity.label = label;
    await this.store.upsertEntity(entity);
  }

  /**
   * Set the global Pushover credentials (both required). Enables Pushover
   * delivery for any alarm that has a {@link PairedEntity.pushoverSeverity}.
   */
  async setPushoverCredentials(appToken: string, userKey: string): Promise<void> {
    const config = this.store.getConfig();
    config.pushover = { appToken, userKey };
    await this.store.setConfig(config);
  }

  /**
   * Clear the global Pushover credentials, disabling Pushover delivery. Any
   * per-alarm severity settings remain stored but inert until credentials are
   * re-entered.
   */
  async clearPushoverCredentials(): Promise<void> {
    const config = this.store.getConfig();
    config.pushover = undefined;
    await this.store.setConfig(config);
  }

  /** True when both Pushover credentials are present. */
  isPushoverConfigured(): boolean {
    const p = this.store.getConfig().pushover;
    return Boolean(p?.appToken && p?.userKey);
  }

  /**
   * Set (or clear, with `null`) a smart alarm's Pushover severity. Throws if the
   * entity is unknown or is not an alarm.
   */
  async setAlarmPushoverSeverity(
    serverId: string,
    entityId: number,
    severity: PushoverSeverity | null,
  ): Promise<void> {
    const entity = this.store.getEntity(serverId, entityId);
    if (!entity) {
      throw new StateError(`Unknown entity ${entityId} on server ${serverId}`);
    }
    if (entity.entityType !== "alarm") {
      throw new StateError(`Entity ${entityId} on server ${serverId} is not an alarm`);
    }
    entity.pushoverSeverity = severity ?? undefined;
    await this.store.upsertEntity(entity);
  }

  /**
   * Set (or clear back to Normal, with `null`) a smart alarm's notification
   * level — how its logging-channel line notifies when it fires. Throws if the
   * entity is unknown or is not an alarm.
   */
  async setAlarmNotificationLevel(
    serverId: string,
    entityId: number,
    level: AlarmNotificationLevel | null,
  ): Promise<void> {
    const entity = this.store.getEntity(serverId, entityId);
    if (!entity) {
      throw new StateError(`Unknown entity ${entityId} on server ${serverId}`);
    }
    if (entity.entityType !== "alarm") {
      throw new StateError(`Entity ${entityId} on server ${serverId} is not an alarm`);
    }
    entity.notificationLevel = level ?? undefined;
    await this.store.upsertEntity(entity);
  }

  /**
   * Set (or clear, with `null`) a smart switch's timed auto-revert mode. Throws
   * if the entity is unknown or is not a switch. After persisting, the timer is
   * re-evaluated against the switch's current state so enabling it on a switch
   * already in the trigger state arms the countdown immediately.
   */
  async setSwitchAutoAction(
    serverId: string,
    entityId: number,
    action: SwitchAutoAction | null,
  ): Promise<void> {
    const entity = this.requireSwitch(serverId, entityId);
    entity.autoAction = action ?? undefined;
    await this.store.upsertEntity(entity);
    await this.rearmAutoTimer(serverId, entityId);
  }

  /**
   * Set a smart switch's auto-revert delay (seconds). Throws if the entity is
   * unknown, is not a switch, or the delay is outside
   * {@link SWITCH_AUTO_DELAY_MIN}…{@link SWITCH_AUTO_DELAY_MAX}. Re-evaluates the
   * timer so a retime takes effect immediately.
   */
  async setSwitchAutoDelaySeconds(
    serverId: string,
    entityId: number,
    seconds: number,
  ): Promise<void> {
    if (
      !Number.isInteger(seconds) ||
      seconds < SWITCH_AUTO_DELAY_MIN ||
      seconds > SWITCH_AUTO_DELAY_MAX
    ) {
      throw new ValidationError(
        `Auto-revert delay must be a whole number between ${SWITCH_AUTO_DELAY_MIN} and ${SWITCH_AUTO_DELAY_MAX} seconds`,
      );
    }
    const entity = this.requireSwitch(serverId, entityId);
    entity.autoActionDelaySeconds = seconds;
    await this.store.upsertEntity(entity);
    await this.rearmAutoTimer(serverId, entityId);
  }

  async setRoleCapabilities(map: RoleCapabilityMap): Promise<void> {
    const config = this.store.getConfig();
    config.roleCapabilities = { admin: [...map.admin], user: [...map.user] };
    await this.store.setConfig(config);
  }

  // ── panel message ids (Components V2 panels survive restarts) ──────────────

  /**
   * Persist the message ids of a server's Conduit Panel so the adapter
   * can edit it in place across restarts. Replaces the whole record;
   * `undefined` clears it (the panel is gone and will be posted afresh).
   */
  async setServerPanelIds(serverId: string, ids: ServerPanelIds | undefined): Promise<void> {
    const server = this.store.getServer(serverId);
    if (!server) {
      throw new StateError(`Unknown server: ${serverId}`);
    }
    server.panelMessageIds = ids ? copyPanelIds(ids) : undefined;
    await this.store.upsertServer(server);
  }

  /**
   * Clear deprecated per-device panel ids once the adapter has deleted their
   * messages (the one-time migration to the Conduit Panel): the old status and team panels,
   * and each listed entity's own panel.
   */
  async clearLegacyPanelIds(serverId: string, legacy: LegacyPanelIds): Promise<void> {
    const server = this.store.getServer(serverId);
    if (!server) {
      throw new StateError(`Unknown server: ${serverId}`);
    }
    if (legacy.status || legacy.team) {
      if (legacy.status) server.statusPanelMessageId = undefined;
      if (legacy.team) server.teamPanelMessageId = undefined;
      await this.store.upsertServer(server);
    }
    for (const entityId of legacy.entityIds ?? []) {
      const entity = this.store.getEntity(serverId, entityId);
      if (!entity?.panelMessageId) continue;
      entity.panelMessageId = undefined;
      await this.store.upsertEntity(entity);
    }
  }

  /**
   * Toggle a storage monitor's opt-in change posts; persisted so the
   * preference survives restarts.
   */
  async setEntityWatch(serverId: string, entityId: number, watch: boolean): Promise<void> {
    const entity = this.store.getEntity(serverId, entityId);
    if (!entity) {
      throw new StateError(`Unknown entity ${entityId} on server ${serverId}`);
    }
    entity.watchChanges = watch;
    await this.store.upsertEntity(entity);
  }

  // ── switch groups ──────────────────────────────────────────────────────────

  /**
   * A server's switch groups, in creation order. Members that are no longer
   * paired switches are left out, and so is a group left with none; a switch
   * listed in two groups (hand-edited state) counts only for the first. Empty
   * for an unknown server.
   */
  listSwitchGroups(serverId: string): SwitchGroup[] {
    const server = this.store.getServer(serverId);
    if (!server?.switchGroups?.length) return [];
    const switches = new Set(
      this.store
        .listEntities(serverId)
        .filter((e) => e.entityType === "switch")
        .map((e) => e.entityId),
    );
    const seen = new Set<number>();
    const groups: SwitchGroup[] = [];
    for (const group of server.switchGroups) {
      const entityIds = group.entityIds.filter((id) => {
        if (!switches.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (entityIds.length > 0) groups.push({ id: group.id, name: group.name, entityIds });
    }
    return groups;
  }

  /**
   * Create a switch group from a name and its member switches. Throws
   * {@link StateError} for an unknown server or a member that is not a paired
   * switch there, and {@link ValidationError} for an empty or over-long name, no
   * members, more than {@link SWITCH_GROUP_MAX_MEMBERS}, or a switch already in
   * another group.
   */
  async createSwitchGroup(
    serverId: string,
    name: string,
    entityIds: readonly number[],
  ): Promise<SwitchGroup> {
    const server = this.requireServer(serverId);
    const groupName = validateGroupName(name);
    const members = this.validateGroupMembers(server, entityIds);
    const groups = server.switchGroups ?? [];
    const group: SwitchGroup = { id: this.newGroupId(groups), name: groupName, entityIds: members };
    server.switchGroups = [...groups, group];
    await this.store.upsertServer(server);
    this.log.info({ serverId, groupId: group.id, members: members.length }, "switch group created");
    return structuredClone(group);
  }

  /** Rename a switch group. Throws like {@link createSwitchGroup}. */
  async renameSwitchGroup(serverId: string, groupId: string, name: string): Promise<void> {
    const server = this.requireServer(serverId);
    const group = requireGroup(server, groupId);
    group.name = validateGroupName(name);
    await this.store.upsertServer(server);
    this.log.info({ serverId, groupId }, "switch group renamed");
  }

  /**
   * Replace a switch group's members. Throws like {@link createSwitchGroup}; a
   * group cannot be emptied this way ({@link deleteSwitchGroup} removes it).
   */
  async setSwitchGroupMembers(
    serverId: string,
    groupId: string,
    entityIds: readonly number[],
  ): Promise<void> {
    const server = this.requireServer(serverId);
    const group = requireGroup(server, groupId);
    group.entityIds = this.validateGroupMembers(server, entityIds, groupId);
    await this.store.upsertServer(server);
    this.log.info(
      { serverId, groupId, members: group.entityIds.length },
      "switch group members set",
    );
  }

  /** Delete a switch group; its switches are on their own again. */
  async deleteSwitchGroup(serverId: string, groupId: string): Promise<void> {
    const server = this.requireServer(serverId);
    requireGroup(server, groupId);
    const rest = (server.switchGroups ?? []).filter((g) => g.id !== groupId);
    server.switchGroups = rest.length > 0 ? rest : undefined;
    await this.store.upsertServer(server);
    this.log.info({ serverId, groupId }, "switch group deleted");
  }

  private requireServer(serverId: string): PairedServer {
    const server = this.store.getServer(serverId);
    if (!server) throw new StateError(`Unknown server: ${serverId}`);
    return server;
  }

  /**
   * Check a group's proposed members (deduplicated, in order): at least one, at
   * most {@link SWITCH_GROUP_MAX_MEMBERS}, each a paired switch on the server
   * and in no group but `groupId`.
   */
  private validateGroupMembers(
    server: PairedServer,
    entityIds: readonly number[],
    groupId?: string,
  ): number[] {
    const members = [...new Set(entityIds)];
    if (members.length === 0) throw new ValidationError("A switch group needs at least one switch");
    if (members.length > SWITCH_GROUP_MAX_MEMBERS) {
      throw new ValidationError(
        `A switch group holds at most ${SWITCH_GROUP_MAX_MEMBERS} switches`,
      );
    }
    for (const entityId of members) {
      this.requireSwitch(server.id, entityId);
      const other = (server.switchGroups ?? []).find(
        (g) => g.id !== groupId && g.entityIds.includes(entityId),
      );
      if (other) {
        throw new ValidationError(`Switch ${entityId} is already in another group`);
      }
    }
    return members;
  }

  /** A group id not yet used on the server: the clock in base 36, bumped past a clash. */
  private newGroupId(groups: readonly SwitchGroup[]): string {
    const taken = new Set(groups.map((g) => g.id));
    let n = this.now();
    while (taken.has(`g${n.toString(36)}`)) n += 1;
    return `g${n.toString(36)}`;
  }

  /**
   * Take a removed switch out of its group, deleting the group if that leaves
   * it empty. A no-op when the switch is in no group.
   */
  private async dropFromSwitchGroups(serverId: string, entityId: number): Promise<void> {
    const server = this.store.getServer(serverId);
    if (!server?.switchGroups?.some((g) => g.entityIds.includes(entityId))) return;
    const groups: SwitchGroup[] = [];
    for (const group of server.switchGroups) {
      const entityIds = group.entityIds.filter((id) => id !== entityId);
      if (entityIds.length > 0) groups.push({ ...group, entityIds });
      else this.log.info({ serverId, groupId: group.id }, "switch group deleted: no members left");
    }
    server.switchGroups = groups.length > 0 ? groups : undefined;
    await this.store.upsertServer(server);
  }

  // ── pairing ────────────────────────────────────────────────────────────────

  /**
   * Arm the fcm listener with stored credentials and resolve on the next pairing
   * event (server or entity), or after the pairing-timeout window. Persisted
   * persistentIds are passed so old notifications aren't replayed.
   */
  async beginPairing(): Promise<void> {
    const credentials = await this.requireFcmCredentials();
    const persistentIds = await this.store.getPersistentIds();
    await this.fcm.startListening(credentials, persistentIds);

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.fcm.off("serverPairing", done);
        this.fcm.off("entityPairing", done);
        this.settlePairing = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.pairingTimeoutMs);
      this.settlePairing = done;
      this.fcm.once("serverPairing", done);
      this.fcm.once("entityPairing", done);
    });
  }

  /**
   * Cancel an in-flight {@link beginPairing} wait early (e.g. the owner hit
   * [Cancel] on the pairing panel). Resolves the pending promise and tears down
   * the fcm listener so a later pairing isn't captured. Idempotent — a no-op when
   * nothing is armed.
   */
  async cancelPairing(): Promise<void> {
    this.settlePairing?.();
    await this.fcm.stopListening();
  }

  // ── credential refresh hook ────────────────────────────────────────────────

  /**
   * Refresh a near-expiry Steam token via fcm, persist the new credentials, and
   * reconnect every currently-connected client (the playerToken used for the WS
   * handshake may have rotated). The *scheduling* of this call is the desktop
   * app's job; bot-core provides the mechanism.
   */
  async refreshCredentials(): Promise<FcmCredentials> {
    const stored = await this.requireStoredCredentials();
    return this.adoptCredentials(stored, await this.fcm.refresh(stored.fcm));
  }

  /**
   * Sign in with Steam again (the host opens the login window through
   * `opts.onSteamLogin` and hands the token to `fcm.submitSteamToken`), then
   * persist the new token and reconnect every server with it. This is how an
   * expired or rejected auth token is replaced: Facepunch refuses to refresh
   * an expired one.
   */
  async renewCredentials(opts: FcmRegisterOptions): Promise<FcmCredentials> {
    const stored = await this.requireStoredCredentials();
    return this.adoptCredentials(stored, await this.fcm.renew(stored.fcm, opts));
  }

  /**
   * Check the companion auth token and emit `authRenewalNeeded` if the operator
   * must sign in again: once per reminder milestone
   * ({@link AUTH_RENEWAL_MILESTONES_MS}, then expiry) and token expiry. Only the
   * milestone in force is sent, so milestones missed while the PC slept do not
   * arrive in a burst. The host calls this at each milestone and hourly, after
   * its automatic refresh attempt.
   */
  async checkAuthToken(now: number = Date.now()): Promise<AuthTokenState> {
    const expiresAt = (await this.store.getCredentials())?.steamTokenExpiresAt;
    if (this.authTokenRejected) {
      await this.noticeRenewal({ reason: "rejected", expiresAt });
      return "rejected";
    }
    if (!expiresAt) return "missing";
    const milestoneMs = authRenewalMilestone(expiresAt, now);
    if (milestoneMs === undefined) return "ok";
    const reason = milestoneMs === 0 ? "expired" : "expiring";
    await this.noticeRenewal({ reason, expiresAt, milestoneMs });
    return reason;
  }

  /**
   * Emit `authRenewalNeeded`, unless this exact reminder was already sent, by
   * this process or (per the persisted config) before a restart, then persist
   * it. Never throws.
   */
  private async noticeRenewal(notice: AuthRenewalNotice): Promise<void> {
    const sent = [this.lastRenewalNotice, this.store.getConfig().steamRenewalReminder];
    if (sent.some((last) => last !== undefined && sameReminder(last, notice))) return;
    this.lastRenewalNotice = notice;
    this.log.warn(notice, "steam sign-in needs renewing");
    this.emitEvent("authRenewalNeeded", notice);
    const record: RenewalReminderRecord = { reason: notice.reason };
    if (notice.expiresAt !== undefined) record.expiresAt = notice.expiresAt;
    if (notice.milestoneMs !== undefined) record.milestoneMs = notice.milestoneMs;
    // Read the config afresh after the listeners ran, so nothing they wrote is lost.
    const config = this.store.getConfig();
    config.steamRenewalReminder = record;
    try {
      await this.store.setConfig(config);
    } catch (err) {
      this.log.warn({ err }, "persisting the steam sign-in reminder failed");
    }
  }

  /**
   * Record that the companion socket refused the auth token, if `err` says so.
   * Withdraws the token from every client (a server with a direct address then
   * falls back to it) and tells the operator. Returns whether it was that.
   */
  private noteAuthTokenRejected(err: unknown): boolean {
    if (!(err instanceof AuthError) || err.credential !== "authToken") return false;
    if (!this.companionAuthToken) return true; // never signed in: nothing to renew
    if (!this.authTokenRejected) {
      this.authTokenRejected = true;
      void this.store.getCredentials().then(
        (creds) =>
          this.noticeRenewal({ reason: "rejected", expiresAt: creds?.steamTokenExpiresAt }),
        () => this.noticeRenewal({ reason: "rejected" }),
      );
    }
    return true;
  }

  /** Persist new credentials and reconnect every server with the new token. */
  private async adoptCredentials(
    stored: StoredCredentials,
    fresh: FcmCredentials,
  ): Promise<FcmCredentials> {
    await this.store.setCredentials({
      ...stored,
      fcm: fresh,
      steamTokenExpiresAt: fresh.steamTokenExpiresAt,
    });
    this.acceptAuthToken(fresh.steamAuthToken);

    for (const serverId of [...this.clients.keys()]) {
      try {
        await this.clients.get(serverId)!.client.disconnect();
      } catch (err) {
        this.log.warn({ err, serverId }, "reconnect: disconnect failed");
      }
      this.clients.delete(serverId);
      // A deliberate disconnect emits no `disconnected`; report the gap ourselves,
      // so a reconnect that fails turns `offline` after the grace period.
      this.markDropped(serverId, "reconnecting with new credentials");
      try {
        await this.connectServer(serverId);
      } catch (err) {
        this.log.warn({ err, serverId }, "reconnect after refresh failed");
      }
    }
    return fresh;
  }

  /**
   * Disconnect and forget a server's client (its interest and auto-revert
   * timers go with it); the next {@link connectServer} builds a fresh one.
   */
  private async dropClient(serverId: string, why: string): Promise<void> {
    const managed = this.clients.get(serverId);
    if (!managed) return;
    this.clients.delete(serverId);
    this.markDropped(serverId, why);
    this.clearAutoTimersForServer(serverId);
    this.log.info({ serverId }, `rust+ client replaced: ${why}`);
    try {
      await managed.client.disconnect();
    } catch (err) {
      this.log.warn({ err, serverId }, "disconnect of replaced client failed");
    }
  }

  /** Adopt a new companion auth token: clients offer it from their next connect. */
  private acceptAuthToken(token: string): void {
    this.companionAuthToken = token;
    this.authTokenRejected = false;
    this.lastRenewalNotice = undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private requireClient(serverId: string): ManagedClient {
    const managed = this.clients.get(serverId);
    if (!managed) {
      throw new StateError(`Server ${serverId} is not connected; call connectServer first`);
    }
    return managed;
  }

  private registerInterest(managed: ManagedClient, entityId: number): void {
    managed.interest.add(entityId);
  }

  // ── switch auto-revert engine ──────────────────────────────────────────────

  private requireSwitch(serverId: string, entityId: number): PairedEntity {
    const entity = this.store.getEntity(serverId, entityId);
    if (!entity) {
      throw new StateError(`Unknown entity ${entityId} on server ${serverId}`);
    }
    if (entity.entityType !== "switch") {
      throw new StateError(`Entity ${entityId} on server ${serverId} is not a switch`);
    }
    return entity;
  }

  private static autoTimerKey(serverId: string, entityId: number): string {
    return `${serverId}:${entityId}`;
  }

  /**
   * (Re)evaluate the auto-revert timer for one switch against a known state.
   * Always clears any pending timer first; then, if the switch has an auto
   * action and `value` is the trigger state (the state we want to revert
   * *away* from), arms a fresh one-shot to flip it back after the delay.
   */
  private evaluateAutoTimer(serverId: string, entityId: number, value: boolean): void {
    const key = BotCore.autoTimerKey(serverId, entityId);
    const existing = this.autoTimers.get(key);
    if (existing !== undefined) {
      this.timers.clearTimer(existing);
      this.autoTimers.delete(key);
    }

    const entity = this.store.getEntity(serverId, entityId);
    if (entity?.entityType !== "switch" || !entity.autoAction) return;

    const target = entity.autoAction === "on";
    const triggerValue = !target;
    if (value !== triggerValue) return;

    const delaySeconds = entity.autoActionDelaySeconds ?? SWITCH_AUTO_DELAY_DEFAULT;
    const handle = this.timers.setTimer(() => {
      void this.fireAutoAction(serverId, entityId, target);
    }, delaySeconds * 1000);
    this.autoTimers.set(key, handle);
  }

  /**
   * Re-evaluate a switch's timer from its current live state (used after a
   * setting change). No-ops when the server isn't connected — the timer then
   * arms on the next connect via {@link reregisterInterest}.
   */
  private async rearmAutoTimer(serverId: string, entityId: number): Promise<void> {
    const managed = this.clients.get(serverId);
    if (!managed?.client.connected) {
      // Not connected: drop any stale handle; reregisterInterest re-arms later.
      const key = BotCore.autoTimerKey(serverId, entityId);
      const existing = this.autoTimers.get(key);
      if (existing !== undefined) {
        this.timers.clearTimer(existing);
        this.autoTimers.delete(key);
      }
      return;
    }
    try {
      const info = await managed.client.getEntityInfo(entityId);
      this.evaluateAutoTimer(serverId, entityId, info.value ?? false);
    } catch (err) {
      this.log.warn({ err, serverId, entityId }, "auto-revert re-arm getEntityInfo failed");
    }
  }

  /** Fire a switch's auto-revert: flip it to the target state. Never throws. */
  private async fireAutoAction(serverId: string, entityId: number, target: boolean): Promise<void> {
    this.autoTimers.delete(BotCore.autoTimerKey(serverId, entityId));
    this.log.info({ serverId, entityId, target: target ? "on" : "off" }, "auto-revert fired");
    try {
      await this.toggleEntity(serverId, entityId, target);
    } catch (err) {
      this.log.warn({ err, serverId, entityId }, "auto-revert toggle failed");
    }
  }

  private clearAutoTimersForServer(serverId: string): void {
    const prefix = `${serverId}:`;
    for (const [key, handle] of this.autoTimers) {
      if (key.startsWith(prefix)) {
        this.timers.clearTimer(handle);
        this.autoTimers.delete(key);
      }
    }
  }

  private clearAllAutoTimers(): void {
    for (const handle of this.autoTimers.values()) {
      this.timers.clearTimer(handle);
    }
    this.autoTimers.clear();
  }

  private async requireStoredCredentials(): Promise<
    NonNullable<Awaited<ReturnType<StateStore["getCredentials"]>>>
  > {
    const stored = await this.store.getCredentials();
    if (!stored) throw new AuthError("No stored credentials");
    return stored;
  }

  private async requireFcmCredentials(): Promise<FcmCredentials> {
    return (await this.requireStoredCredentials()).fcm;
  }

  /** Subscribe to fcm pairing/alarm events and translate to domain events. */
  private wireFcm(): void {
    this.fcm.on("serverPairing", (n) => {
      void this.onServerPairing(n);
    });
    this.fcm.on("entityPairing", (n) => {
      void this.onEntityPairing(n);
    });
    this.fcm.on("alarm", (a) => {
      this.emitEvent("alarmTriggered", a);
    });
    this.fcm.on("death", (d) => {
      this.emitEvent("playerDeath", d);
    });
    this.fcm.on("credentialsRefreshed", (creds) => {
      void this.onCredentialsRefreshed(creds);
    });
    // Persist each handled push id so the next startListening seeds it and a
    // restart never replays an old pairing or alarm.
    this.fcm.on("pushHandled", (persistentId: string) => {
      void this.onPushHandled(persistentId);
    });
    // A FcmService emits "error" for any push it cannot decode. Node's
    // EventEmitter rethrows "error" as an uncaught exception when nothing is
    // listening — which would crash the host process — so absorb it here.
    this.fcm.on("error", (err) => {
      this.log.warn({ err: err.message }, "fcm: listener error (ignored)");
    });
  }

  private async onPushHandled(persistentId: string): Promise<void> {
    try {
      await this.store.addPersistentIds([persistentId]);
    } catch (err) {
      // Losing one id only risks one replay after a restart; never crash on it.
      this.log.warn(
        { err: (err as Error).message, persistentId },
        "fcm: failed to persist push id",
      );
    }
  }

  private async onServerPairing(n: PairingNotification): Promise<void> {
    const existing = this.store.getServer(n.id);
    const server: PairedServer = {
      id: n.id,
      name: n.name,
      desc: n.desc,
      ip: n.ip,
      port: n.port,
      playerId: n.playerId,
      playerToken: n.playerToken,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      panelMessageIds: existing?.panelMessageIds,
      statusPanelMessageId: existing?.statusPanelMessageId,
      teamPanelMessageId: existing?.teamPanelMessageId,
      switchGroups: existing?.switchGroups,
    };
    await this.store.upsertServer(server);
    this.log.info(
      { serverId: server.id, name: server.name, repaired: Boolean(existing) },
      "server paired",
    );
    // A re-pair after `app.regeneratetoken` carries a new playerToken. The live
    // client still sends the old one, and connectServer would keep reusing it:
    // drop it, so the next connect (the host connects on serverPaired) builds
    // one with the new credentials.
    const credentialsChanged =
      existing !== undefined &&
      (existing.playerId !== server.playerId || existing.playerToken !== server.playerToken);
    if (credentialsChanged) await this.dropClient(server.id, "re-paired with new credentials");
    this.emitEvent("serverPaired", server);
  }

  private async onEntityPairing(n: PairingNotification): Promise<void> {
    const entityId = n.entityId ?? 0;
    const existing = this.store.getEntity(n.id, entityId);
    const entity: PairedEntity = {
      serverId: n.id,
      entityId,
      entityType: mapEntityType(n.entityType),
      identifier: existing?.identifier,
      label: existing?.label,
      panelMessageId: existing?.panelMessageId,
      watchChanges: existing?.watchChanges,
      // Preserve the switch safety setting so re-pairing a device doesn't
      // silently drop its timed auto-revert.
      autoAction: existing?.autoAction,
      autoActionDelaySeconds: existing?.autoActionDelaySeconds,
    };
    await this.store.upsertEntity(entity);
    this.log.info(
      {
        serverId: entity.serverId,
        entityId: entity.entityId,
        entityType: entity.entityType,
        repaired: Boolean(existing),
      },
      "device paired",
    );
    this.emitEvent("entityPaired", entity);
  }

  private async onCredentialsRefreshed(creds: FcmCredentials): Promise<void> {
    this.acceptAuthToken(creds.steamAuthToken);
    const stored = await this.store.getCredentials();
    if (!stored) return;
    await this.store.setCredentials({
      ...stored,
      fcm: creds,
      steamTokenExpiresAt: creds.steamTokenExpiresAt,
    });
  }

  /**
   * Send a Pushover notification for a fired alarm, if it has an opted-in
   * severity. No-ops for non-alarm entities or alarms without a severity.
   * Skips (with a warning) when global Pushover credentials are missing so a
   * stale per-alarm setting surfaces a meaningful log line rather than failing
   * silently. Never throws — delivery errors are logged, not propagated.
   */
  private async maybeSendAlarmPushover(server: PairedServer, entityId: number): Promise<void> {
    const entity = this.store.getEntity(server.id, entityId);
    if (entity?.entityType !== "alarm" || !entity.pushoverSeverity) return;

    const creds = this.store.getConfig().pushover;
    if (!creds?.appToken || !creds?.userKey) {
      this.log.warn(
        { serverId: server.id, entityId, severity: entity.pushoverSeverity },
        "alarm has a Pushover severity but no Pushover credentials are configured; skipping",
      );
      return;
    }

    const name = entity.label ?? "Smart Alarm";
    try {
      await this.pushover({
        appToken: creds.appToken,
        userKey: creds.userKey,
        title: `🚨 ${name}`,
        message: `${name} triggered on ${server.name}.`,
        priority: severityToPriority(entity.pushoverSeverity),
      });
    } catch (err) {
      this.log.warn({ err, serverId: server.id, entityId }, "pushover: send failed");
    }
  }

  /** Subscribe to a client's broadcasts and re-emit them as domain events. */
  private wireClient(managed: ManagedClient): void {
    const { server, client } = managed;
    client.on("entityChanged", (change: EntityChange) => {
      // A storage monitor's broadcast (it reports a capacity) also logs its
      // shape and upkeep, never its contents.
      const storage =
        change.capacity === undefined
          ? {}
          : {
              items: change.items?.length ?? 0,
              capacity: change.capacity,
              hasProtection: change.hasProtection,
              protectionExpiry: change.protectionExpiry,
            };
      this.log.debug(
        { serverId: server.id, entityId: change.entityId, value: change.value, ...storage },
        "rust+ entity changed",
      );
      this.emitEvent("entityChanged", { serverId: server.id, change });
      // A smart alarm firing is an alarm entity flipping to `true`. The server
      // only broadcasts on change, so `value === true` is a genuine rising edge.
      if (change.value === true) {
        void this.maybeSendAlarmPushover(server, change.entityId);
      }
      // A switch entering its trigger state arms (or, leaving it, disarms) the
      // timed auto-revert. Mutual exclusivity of the modes prevents a loop: the
      // revert flips to the non-trigger state, which only ever clears the timer.
      this.evaluateAutoTimer(server.id, change.entityId, change.value ?? false);
    });
    client.on("teamChat", (message: TeamChatMessage) => {
      this.emitEvent("teamChat", { serverId: server.id, message });
    });
    client.on("connected", () => {
      this.log.info({ serverId: server.id, route: client.route }, "rust+ connected");
      this.markConnected(server.id);
      // Back after a drop (the client's automatic reconnect, or connectServer):
      // re-request every entity, which re-arms the auto-revert timers the
      // disconnect cleared and refreshes the panels. A first connect is left
      // to connectServer.
      if (managed.needsResync) {
        managed.needsResync = false;
        void this.resyncInterest(managed);
      }
    });
    client.on("reconnecting", (info: { attempt: number; delayMs: number }) => {
      this.log.info(
        { serverId: server.id, attempt: info.attempt, delayMs: info.delayMs },
        "rust+ reconnect scheduled",
      );
    });
    client.on("disconnected", (info: { code: number; reason: string }) => {
      this.log.info(
        { serverId: server.id, code: info?.code, reason: info?.reason },
        "rust+ disconnected",
      );
      // A pending auto-revert can't actuate while offline; clear it so a stale
      // timer can't fire mid-reconnect. The `connected` handler re-arms it from
      // the switch's state once the server is back.
      this.clearAutoTimersForServer(server.id);
      managed.needsResync = true;
      this.markDropped(server.id, info?.reason);
    });
    client.on("error", (err: Error) => {
      // One refused handshake is not yet a refused token: the client retries it
      // and reports `authRejected` if the retries are refused too.
      this.log.warn({ err, serverId: server.id }, "rustplus client error");
    });
    client.on("authRejected", (err: Error) => {
      // The companion socket refused the auth token on every retry, and the
      // client has stopped. Withdraw the token and tell the operator to sign in
      // again; a server with a direct address reconnects that way meanwhile.
      this.log.warn({ err, serverId: server.id }, "rust+ auth token refused: retries used up");
      this.noteAuthTokenRejected(err);
      if (server.ip && server.port !== undefined) {
        this.connectServer(server.id).catch((directErr: unknown) => {
          this.log.warn({ err: directErr, serverId: server.id }, "direct fallback failed");
        });
      }
    });
  }
}

/**
 * Map the raw proto `entityType` number on an entity pairing push to our logical
 * kind. The pairing payload uses Facepunch's `AppEntityType` enum
 * (1=switch, 2=alarm, 3=storageMonitor); cameras pair as a server-side type that
 * is addressed by identifier, handled separately.
 */
/**
 * Derive a stable, negative `entityId` for a camera from its identifier. Cameras
 * are addressed by string identifier, but the store/panel key on a numeric id; a
 * negative id (real Rust entity ids are positive) keyed off the identifier hash
 * makes the same camera map to the same key without colliding with a real entity.
 */
/** A switch group's name, trimmed; throws a {@link ValidationError} if empty or too long. */
function validateGroupName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError("A switch group needs a name");
  if (trimmed.length > SWITCH_GROUP_NAME_MAX) {
    throw new ValidationError(`A switch group name is at most ${SWITCH_GROUP_NAME_MAX} characters`);
  }
  return trimmed;
}

/** The server's group with this id (a live reference into `server`); StateError if none. */
function requireGroup(server: PairedServer, groupId: string): SwitchGroup {
  const group = server.switchGroups?.find((g) => g.id === groupId);
  if (!group) throw new StateError(`Unknown switch group ${groupId} on server ${server.id}`);
  return group;
}

/** A deep copy of panel ids, keeping only the pages that are set. */
function copyPanelIds(ids: ServerPanelIds): ServerPanelIds {
  const copy: ServerPanelIds = {};
  if (ids.server) copy.server = ids.server;
  for (const kind of ["switches", "alarms", "storage", "cameras"] as const) {
    const pages = ids[kind];
    if (pages?.length) copy[kind] = [...pages];
  }
  return copy;
}

function cameraEntityId(identifier: string): number {
  // FNV-1a 32-bit hash → positive int, then negate.
  let hash = 0x811c9dc5;
  for (let i = 0; i < identifier.length; i++) {
    hash ^= identifier.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return -((hash >>> 0) % 0x7fffffff) - 1;
}

function mapEntityType(raw: number | undefined): PairedEntity["entityType"] {
  switch (raw) {
    case 1:
      return "switch";
    case 2:
      return "alarm";
    case 3:
      return "storageMonitor";
    default:
      return "switch";
  }
}
