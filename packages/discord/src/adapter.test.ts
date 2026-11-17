/**
 * Focused suite for the Components V2 dispatcher in `adapter.ts`.
 *
 * `index.test.ts` exercises the adapter's happy paths through the package's
 * public surface. This file targets the dispatch layer itself: fail-closed
 * customId handling, the per-click permission check, routing edge cases,
 * acknowledgement safety through the real discord.js bridge, friendly failure
 * replies, the domain-event fan-in, and the start/stop lifecycle.
 *
 * Everything is driven through constructor seams with hand-rolled fakes: an
 * `EventEmitter` core, an `EventEmitter` gateway client, a manual
 * `TimerProvider`, and a recording `PanelStore` / `Logger`.
 */

import { EventEmitter } from "node:events";

import { describe, it, expect, vi } from "vitest";
import { Events, MessageFlags } from "discord.js";

import {
  BotCore,
  CameraUnavailableError,
  InMemoryStateStore,
  SERVER_OFFLINE_GRACE_MS,
} from "@conduit/bot-core";
import type {
  AppConfig,
  PairedEntity,
  PairedServer,
  RoleCapabilityMap,
  ServerStatus,
  SwitchGroup,
} from "@conduit/bot-core";

import {
  CAMERA_COOLDOWN_MS,
  DiscordAdapter,
  EDIT_CAP_REBUILD_INTERVAL_MS,
  type DispatchableInteraction,
  type Logger,
  type PostErrorInfo,
} from "./adapter.js";
import { buildCustomId, type CustomIdDomain } from "./customId.js";
import {
  CAMERA_PLAYER_ONLINE_MESSAGE,
  DENIAL_MESSAGE,
  ENTITY_NOT_FOUND_MESSAGE,
  GENERIC_FAILURE_MESSAGE,
  NO_ROLE_MESSAGE,
  STALE_STATE_MESSAGE,
  friendlyError,
} from "./errors.js";
import { HandleRegistry } from "./handles.js";
import { NEW_GROUP_OPTION } from "./panels.js";
import type { PanelStore } from "./panel-store.js";
import { EDIT_CAP_BACKOFF_MS, EDIT_DEBOUNCE_MS } from "./edit-pipeline.js";
import type { TimerProvider } from "./state-lock.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const SERVER_ID = "srv-1";
const SWITCH_ID = 7;
const ALARM_ID = 8;
const MONITOR_ID = 9;
const CAMERA_ID = 10;
const READY_TIMEOUT_MS = 4321;
const FIXED_NOW = new Date(2026, 5, 16, 14, 3, 5);

interface CoreState {
  config: AppConfig;
  servers: PairedServer[];
  entities: PairedEntity[];
  /** Server ids `isServerConnected` reports as live. */
  connected: string[];
}

function makeServer(id: string, overrides: Partial<PairedServer> = {}): PairedServer {
  return {
    id,
    name: `Server ${id}`,
    desc: "",
    ip: "1.1.1.1",
    port: 28082,
    playerId: "76561198000000000",
    playerToken: "0",
    addedAt: "",
    ...overrides,
  };
}

function makeEntity(
  entityId: number,
  entityType: PairedEntity["entityType"],
  overrides: Partial<PairedEntity> = {},
): PairedEntity {
  return { serverId: SERVER_ID, entityId, entityType, ...overrides };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    startOnLogin: false,
    controlChannelId: "control-chan",
    roleCapabilities: { admin: ["ADMIN"], user: ["USER"] },
    ...overrides,
  };
}

function makeState(overrides: Partial<CoreState> = {}): CoreState {
  return { config: makeConfig(), servers: [], entities: [], connected: [], ...overrides };
}

/** One server with one device of every type, none of them posted yet. */
function deviceState(overrides: Partial<CoreState> = {}): CoreState {
  return makeState({
    servers: [makeServer(SERVER_ID)],
    entities: [
      makeEntity(SWITCH_ID, "switch", { label: "Front Door" }),
      makeEntity(ALARM_ID, "alarm", { label: "Base Alarm" }),
      makeEntity(MONITOR_ID, "storageMonitor", { label: "Loot Room" }),
      makeEntity(CAMERA_ID, "camera", { label: "Gate Cam", identifier: "GATE1" }),
    ],
    ...overrides,
  });
}

/**
 * The same devices with their server's Conduit Panel posted: one message per
 * device type, in posting order.
 */
const POSTED_MESSAGES = ["server-1", "sw-1", "al-1", "st-1", "cam-1"];
const POSTED_IDS = {
  server: "server-1",
  switches: ["sw-1"],
  alarms: ["al-1"],
  storage: ["st-1"],
  cameras: ["cam-1"],
};
function postedState(overrides: Partial<CoreState> = {}): CoreState {
  return makeState({
    servers: [makeServer(SERVER_ID, { panelMessageIds: structuredClone(POSTED_IDS) })],
    entities: [
      makeEntity(SWITCH_ID, "switch", { label: "Front Door" }),
      makeEntity(ALARM_ID, "alarm", { label: "Base Alarm" }),
      makeEntity(MONITOR_ID, "storageMonitor", { label: "Loot Room", watchChanges: true }),
      makeEntity(CAMERA_ID, "camera", { label: "Gate Cam", identifier: "GATE1" }),
    ],
    connected: [SERVER_ID],
    ...overrides,
  });
}

/**
 * The same devices as an older build left them: a status panel and one panel
 * per device, with no Conduit Panel yet (the Conduit Panel migration's input).
 */
const LEGACY_MESSAGES = ["status-1", "old-sw", "old-al", "old-mon", "old-cam"];
function legacyState(overrides: Partial<CoreState> = {}): CoreState {
  return makeState({
    servers: [makeServer(SERVER_ID, { statusPanelMessageId: "status-1" })],
    entities: [
      makeEntity(SWITCH_ID, "switch", { label: "Front Door", panelMessageId: "old-sw" }),
      makeEntity(ALARM_ID, "alarm", { label: "Base Alarm", panelMessageId: "old-al" }),
      makeEntity(MONITOR_ID, "storageMonitor", { label: "Loot Room", panelMessageId: "old-mon" }),
      makeEntity(CAMERA_ID, "camera", {
        label: "Gate Cam",
        identifier: "GATE1",
        panelMessageId: "old-cam",
      }),
    ],
    connected: [SERVER_ID],
    ...overrides,
  });
}

/** An online, alive team member. */
function teamMember(steamId: string, name: string) {
  return { steamId, name, x: 0, y: 0, isOnline: true, spawnTime: 0, isAlive: true, deathTime: 0 };
}

/** An error carrying a typed-error `name`, as the workspace error classes do. */
function namedError(name: string, message = "boom-internal-detail"): Error {
  return Object.assign(new Error(message), { name });
}

/** Let every already-queued promise continuation run (no timers involved). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── fakes ────────────────────────────────────────────────────────────────────

/**
 * Hand-rolled `BotCore` stand-in. Emits domain events like the real one (it is
 * an `EventEmitter`), records every async operation, and can be scripted to
 * reject a given operation.
 */
class FakeCore extends EventEmitter {
  readonly stateLockTimeoutMs = 10_000;
  readonly calls: { method: string; args: unknown[] }[] = [];
  /** The on/off value `getEntity` / `registerEntityInterest` report. */
  entityValue = false;
  private readonly failures = new Map<string, unknown>();

  constructor(readonly state: CoreState) {
    super();
  }

  /** Make every later call to `method` reject with `err`. */
  failWith(method: string, err: unknown): void {
    this.failures.set(method, err);
  }

  /** Argument lists of every recorded call to `method`. */
  callsTo(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  private async invoke<T>(method: string, args: unknown[], result: T): Promise<T> {
    this.calls.push({ method, args });
    if (this.failures.has(method)) throw this.failures.get(method);
    return result;
  }

  /** Per-entity `getEntity` / `registerEntityInterest` answers (e.g. a monitor's contents). */
  readonly infoFor = new Map<number, Record<string, unknown>>();

  private entityInfo(entityId: number, value: boolean) {
    return this.infoFor.get(entityId) ?? { entityId, type: "switch", value, items: [] };
  }

  getConfig = (): AppConfig => this.state.config;
  listServers = (): PairedServer[] => this.state.servers;
  listEntities = (serverId: string): PairedEntity[] =>
    this.state.entities.filter((e) => e.serverId === serverId);
  isServerConnected = (serverId: string): boolean => this.state.connected.includes(serverId);

  // ── switch groups: kept on the server, as bot-core keeps them ──
  private server(serverId: string): PairedServer | undefined {
    return this.state.servers.find((s) => s.id === serverId);
  }
  listSwitchGroups = (serverId: string): SwitchGroup[] =>
    structuredClone(this.server(serverId)?.switchGroups ?? []);
  createSwitchGroup = async (serverId: string, name: string, entityIds: number[]) => {
    const group: SwitchGroup = { id: `g${this.calls.length}`, name, entityIds: [...entityIds] };
    await this.invoke("createSwitchGroup", [serverId, name, entityIds], undefined);
    const server = this.server(serverId)!;
    server.switchGroups = [...(server.switchGroups ?? []), group];
    return structuredClone(group);
  };
  renameSwitchGroup = async (serverId: string, groupId: string, name: string) => {
    await this.invoke("renameSwitchGroup", [serverId, groupId, name], undefined);
    const group = this.server(serverId)?.switchGroups?.find((g) => g.id === groupId);
    if (group) group.name = name;
  };
  setSwitchGroupMembers = async (serverId: string, groupId: string, entityIds: number[]) => {
    await this.invoke("setSwitchGroupMembers", [serverId, groupId, entityIds], undefined);
    const group = this.server(serverId)?.switchGroups?.find((g) => g.id === groupId);
    if (group) group.entityIds = [...entityIds];
  };
  deleteSwitchGroup = async (serverId: string, groupId: string) => {
    await this.invoke("deleteSwitchGroup", [serverId, groupId], undefined);
    const server = this.server(serverId);
    if (server) server.switchGroups = server.switchGroups?.filter((g) => g.id !== groupId);
  };
  /** A server's status, when set; else connected or offline, from `state.connected`. */
  readonly serverStatus = new Map<string, ServerStatus>();
  getServerStatus = (serverId: string): ServerStatus =>
    this.serverStatus.get(serverId) ?? {
      status: this.state.connected.includes(serverId) ? "connected" : "offline",
    };
  /** Move a server to `status` and emit `serverStatusChanged`, as bot-core does. */
  setServerStatus(serverId: string, next: ServerStatus): void {
    const previous = this.getServerStatus(serverId).status;
    this.serverStatus.set(serverId, next);
    this.state.connected = this.state.connected.filter((id) => id !== serverId);
    if (next.status === "connected") this.state.connected.push(serverId);
    this.emit("serverStatusChanged", { serverId, previous, ...next });
  }
  isPushoverConfigured = (): boolean =>
    Boolean(this.state.config.pushover?.appToken && this.state.config.pushover?.userKey);

  /** Per-entity `toggleEntity` failures (one member of a group failing). */
  readonly toggleFailures = new Map<number, unknown>();
  toggleEntity = (serverId: string, entityId: number, value: boolean) => {
    const err = this.toggleFailures.get(entityId);
    if (err !== undefined) {
      this.calls.push({ method: "toggleEntity", args: [serverId, entityId, value] });
      return Promise.reject(err);
    }
    return this.invoke(
      "toggleEntity",
      [serverId, entityId, value],
      this.entityInfo(entityId, value),
    );
  };
  getEntity = (serverId: string, entityId: number) =>
    this.invoke("getEntity", [serverId, entityId], this.entityInfo(entityId, this.entityValue));
  registerEntityInterest = (serverId: string, entityId: number) =>
    this.invoke(
      "registerEntityInterest",
      [serverId, entityId],
      this.entityInfo(entityId, this.entityValue),
    );
  removeEntity = (serverId: string, entityId: number) =>
    this.invoke("removeEntity", [serverId, entityId], undefined);
  setControlChannel = (channelId: string) =>
    this.invoke("setControlChannel", [channelId], undefined);
  setLoggingChannel = (channelId: string) =>
    this.invoke("setLoggingChannel", [channelId], undefined);
  setRoleCapabilities = async (map: RoleCapabilityMap): Promise<void> => {
    await this.invoke("setRoleCapabilities", [map], undefined);
    this.state.config.roleCapabilities = { admin: [...map.admin], user: [...map.user] };
  };
  setStartOnLogin = async (enabled: boolean): Promise<void> => {
    await this.invoke("setStartOnLogin", [enabled], undefined);
    this.state.config.startOnLogin = enabled;
  };
  beginPairing = () => this.invoke("beginPairing", [], undefined);
  cancelPairing = () => this.invoke("cancelPairing", [], undefined);
  getServerInfo = (serverId: string) =>
    this.invoke("getServerInfo", [serverId], { players: 12, maxPlayers: 100, queuedPlayers: 3 });
  /** What `getTeam` reports. */
  team: { leaderSteamId: string; members: unknown[] } = { leaderSteamId: "0", members: [] };
  getTeam = (serverId: string) => this.invoke("getTeam", [serverId], this.team);
  getServerTime = (serverId: string) =>
    this.invoke("getServerTime", [serverId], {
      dayLengthMinutes: 60,
      timeScale: 1,
      sunrise: 7,
      sunset: 19,
      time: 12.5,
      isDay: true,
    });
  setEntityLabel = async (serverId: string, entityId: number, label: string) => {
    await this.invoke("setEntityLabel", [serverId, entityId, label], undefined);
    const entity = this.state.entities.find(
      (e) => e.serverId === serverId && e.entityId === entityId,
    );
    if (entity) entity.label = label;
  };
  setPushoverCredentials = (appToken: string, userKey: string) =>
    this.invoke("setPushoverCredentials", [appToken, userKey], undefined);
  clearPushoverCredentials = () => this.invoke("clearPushoverCredentials", [], undefined);
  setAlarmPushoverSeverity = (serverId: string, entityId: number, severity: unknown) =>
    this.invoke("setAlarmPushoverSeverity", [serverId, entityId, severity], undefined);
  setAlarmNotificationLevel = (serverId: string, entityId: number, level: unknown) =>
    this.invoke("setAlarmNotificationLevel", [serverId, entityId, level], undefined);
  setSwitchAutoAction = async (serverId: string, entityId: number, action: unknown) => {
    await this.invoke("setSwitchAutoAction", [serverId, entityId, action], undefined);
    const entity = this.state.entities.find(
      (e) => e.serverId === serverId && e.entityId === entityId,
    );
    if (entity) entity.autoAction = (action ?? undefined) as PairedEntity["autoAction"];
  };
  setSwitchAutoDelaySeconds = (serverId: string, entityId: number, seconds: number) =>
    this.invoke("setSwitchAutoDelaySeconds", [serverId, entityId, seconds], undefined);
  getCameraFrame = (serverId: string, identifier: string) =>
    this.invoke("getCameraFrame", [serverId, identifier], new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  addCamera = (serverId: string, identifier: string, label?: string) =>
    this.invoke("addCamera", [serverId, identifier, label], {
      serverId,
      entityId: -1,
      entityType: "camera",
      identifier,
    });
}

/** Discord's 10008 Unknown Message: the only error that means a panel is gone. */
function unknownMessage(): Error {
  return Object.assign(namedError("DiscordAPIError", "Unknown Message"), { code: 10008 });
}

/** A Discord API error with the given code (or none: a timeout, a 5xx). */
function discordError(code?: number, message = "Discord said no"): Error {
  return Object.assign(namedError("DiscordAPIError", message), code === undefined ? {} : { code });
}

/** The bot's own user id (what the orphan sweep compares authors against). */
const BOT_USER_ID = "bot-user";

/** Components V2 JSON carrying a Conduit button, as every Conduit panel does. */
function conduitComponents(id: string): unknown[] {
  return [
    {
      type: 17,
      components: [{ type: 1, components: [{ type: 2, custom_id: `conduit:v1:switch:on:${id}` }] }],
    },
  ];
}

interface FakeMessage {
  authorId: string;
  components: unknown[];
}

/**
 * A fake text channel that tracks which messages exist (in posting order, with
 * author and components, so the orphan sweep can read its history), and every
 * send/edit/delete. Messages listed in `existing` are Conduit panels by the bot.
 */
function makeChannel(existing: string[] = []) {
  const messages = new Map<string, FakeMessage>(
    existing.map((id) => [id, { authorId: BOT_USER_ID, components: conduitComponents(id) }]),
  );
  /** Errors to throw when a given message id is fetched. */
  const failures = new Map<string, unknown>();
  /** Errors to throw when a given message id is edited (its fetch and delete still work). */
  const editFailures = new Map<string, unknown>();
  const sent: { id: string; payload: unknown }[] = [];
  const edits: { id: string; payload: unknown }[] = [];
  const deleted: string[] = [];
  const historyFetches: unknown[] = [];
  /** While set, every send waits for it (see holdSends). */
  let sendGate: Promise<void> | undefined;
  let next = 0;
  const handle = (id: string) => ({
    id,
    author: { id: messages.get(id)?.authorId },
    components: messages.get(id)?.components,
    edit: async (payload: unknown) => {
      if (editFailures.has(id)) throw editFailures.get(id);
      edits.push({ id, payload });
    },
    delete: async () => {
      messages.delete(id);
      deleted.push(id);
    },
  });
  const channel = {
    send: async (payload: unknown) => {
      if (sendGate) await sendGate;
      const id = `posted-${next++}`;
      const components = (payload as { components?: unknown[] }).components ?? [];
      messages.set(id, { authorId: BOT_USER_ID, components });
      sent.push({ id, payload });
      return { id };
    },
    messages: {
      fetch: async (arg: string | { limit: number }) => {
        if (typeof arg === "object") {
          historyFetches.push(arg);
          const newestFirst = [...messages.keys()].reverse().slice(0, arg.limit);
          return new Map(newestFirst.map((id) => [id, handle(id)]));
        }
        if (failures.has(arg)) throw failures.get(arg);
        if (!messages.has(arg)) throw unknownMessage();
        return handle(arg);
      },
    },
  };
  return {
    channel,
    sent,
    edits,
    deleted,
    historyFetches,
    /** Make every later fetch of message `id` throw `err` (until cleared). */
    failFetch: (id: string, err: unknown): void => {
      failures.set(id, err);
    },
    /** Make every later edit of message `id` throw `err` (until cleared). */
    failEdit: (id: string, err: unknown): void => {
      editFailures.set(id, err);
    },
    clearFailures: (): void => {
      failures.clear();
      editFailures.clear();
    },
    /** Hold every send until the returned function is called. */
    holdSends: (): (() => void) => {
      let release!: () => void;
      sendGate = new Promise((resolve) => {
        release = () => {
          sendGate = undefined;
          resolve();
        };
      });
      return release;
    },
    /** Put a message in the channel directly (another author's, or plain text). */
    addMessage: (id: string, message: FakeMessage): void => {
      messages.set(id, message);
    },
    /** Ids of every message still in the channel, oldest first. */
    live: (): string[] => [...messages.keys()],
    /** Plain-text (audit) lines sent so far. */
    lines: (): string[] =>
      sent
        .map((s) => (s.payload as { content?: unknown }).content)
        .filter((c): c is string => typeof c === "string"),
    /** JSON of every edit made to one message. */
    editsTo: (id: string): string[] =>
      edits.filter((e) => e.id === id).map((e) => JSON.stringify(e.payload)),
    reset: (): void => {
      sent.length = 0;
      edits.length = 0;
      deleted.length = 0;
      historyFetches.length = 0;
    },
  };
}

/** A fake discord.js `Client`: an emitter with login/destroy and one channel. */
class FakeClient extends EventEmitter {
  readonly logins: string[] = [];
  destroyed = 0;
  /** The bot's own user, as discord.js sets it on login. */
  user?: { id: string; avatar: string | null; setAvatar: ReturnType<typeof vi.fn> };
  readonly channels: {
    cache: { get(id: string): unknown };
    fetch(id: string): Promise<unknown>;
  };
  /** The gateway's server cache, with each server's roles (the Guilds intent fills it). */
  readonly guilds = { cache: new Map<string, { roles: { cache: Map<string, unknown> } }>() };

  /** Put a server with these roles in the cache. */
  setRoles(guildId: string, roles: { id: string; name: string; managed?: boolean }[]): void {
    const cache = new Map<string, unknown>(roles.map((r) => [r.id, { managed: false, ...r }]));
    this.guilds.cache.set(guildId, { roles: { cache } });
  }

  constructor(channel: unknown) {
    super();
    this.channels = { cache: { get: () => channel }, fetch: async () => channel };
  }

  async login(token: string): Promise<string> {
    this.logins.push(token);
    return token;
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
  }
}

/** A manual clock: timers only fire when a test fires them. */
function makeTimers() {
  const pending = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  const provider: TimerProvider = {
    setTimer: (cb, ms) => {
      const id = next++;
      pending.set(id, { cb, ms });
      return id;
    },
    clearTimer: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    provider,
    /** Delays of the timers still armed. */
    pendingMs: (): number[] => [...pending.values()].map((t) => t.ms),
    /** Fire (and consume) every armed timer with this delay. */
    fire: (ms: number): void => {
      for (const [id, timer] of [...pending]) {
        if (timer.ms !== ms) continue;
        pending.delete(id);
        timer.cb();
      }
    },
  };
}

/**
 * A recording `PanelStore`. With `writeThrough`, it also writes each id into the
 * fake core's state, as the desktop's bot-core-backed store does, so later
 * operations read the ids earlier ones stored.
 */
function makePanelStore(writeThrough?: CoreState) {
  const calls: { method: keyof PanelStore; args: unknown[] }[] = [];
  const store: PanelStore = {
    setServerPanelIds: async (...args) => {
      calls.push({ method: "setServerPanelIds", args });
      const [serverId, ids] = args;
      const server = writeThrough?.servers.find((s) => s.id === serverId);
      if (server) server.panelMessageIds = ids;
    },
    clearLegacyPanelIds: async (...args) => {
      calls.push({ method: "clearLegacyPanelIds", args });
      const [serverId, legacy] = args;
      const server = writeThrough?.servers.find((s) => s.id === serverId);
      if (server && legacy.status) server.statusPanelMessageId = undefined;
      if (server && legacy.team) server.teamPanelMessageId = undefined;
      for (const entity of writeThrough?.entities ?? []) {
        if (entity.serverId === serverId && legacy.entityIds?.includes(entity.entityId)) {
          entity.panelMessageId = undefined;
        }
      }
    },
    setEntityWatch: async (...args) => {
      calls.push({ method: "setEntityWatch", args });
    },
  };
  return {
    store,
    calls,
    callsTo: (method: keyof PanelStore): unknown[][] =>
      calls.filter((c) => c.method === method).map((c) => c.args),
  };
}

type LogLevel = "debug" | "info" | "warn" | "error";

function makeLogger() {
  const entries: { level: LogLevel; obj: unknown; msg?: string }[] = [];
  const at =
    (level: LogLevel) =>
    (obj: unknown, msg?: string): void => {
      entries.push({ level, obj, msg });
    };
  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return {
    logger,
    messages: (level: LogLevel): (string | undefined)[] =>
      entries.filter((e) => e.level === level).map((e) => e.msg),
    /** The fields of every `level` line with this message. */
    fields: (level: LogLevel, msg: string): unknown[] =>
      entries.filter((e) => e.level === level && e.msg === msg).map((e) => e.obj),
  };
}

/** The component with this custom id, searched through nested components. */
function findComponent(components: unknown, customId: string): unknown {
  if (Array.isArray(components)) {
    for (const c of components) {
      const found = findComponent(c, customId);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!components || typeof components !== "object") return undefined;
  const c = components as { custom_id?: unknown; components?: unknown; accessory?: unknown };
  if (c.custom_id === customId) return c;
  return findComponent(c.components, customId) ?? findComponent(c.accessory, customId);
}

/** Delete a message from a harness's channel behind the adapter's back (a member did). */
async function deleteFromChannel(
  h: { chan: ReturnType<typeof makeChannel> },
  id: string,
): Promise<void> {
  const message = (await h.chan.channel.messages.fetch(id)) as { delete(): Promise<void> };
  await message.delete();
  h.chan.reset();
}

/** An adapter wired to every fake, plus helpers to mint customIds and start it. */
function makeHarness(
  state: CoreState = makeState(),
  opts: {
    existingMessages?: string[];
    botAvatar?: () => Promise<Uint8Array | undefined>;
    /** Persist panel ids into `state`, as the desktop's real panel store does. */
    writeThrough?: boolean;
    /** Give the fake client its bot user (the orphan sweep needs its id). */
    botUser?: boolean;
    onPostError?: (info: PostErrorInfo) => void;
    /** Run the periodic status refresh at this interval (off by default). */
    statusRefreshIntervalMs?: number;
    /** The adapter's clock; defaults to {@link FIXED_NOW}. */
    now?: () => Date;
  } = {},
) {
  const core = new FakeCore(state);
  const log = makeLogger();
  const timers = makeTimers();
  const chan = makeChannel(opts.existingMessages);
  const client = new FakeClient(chan.channel);
  if (opts.botUser) client.user = { id: BOT_USER_ID, avatar: "set", setAvatar: vi.fn() };
  const store = makePanelStore(opts.writeThrough ? state : undefined);
  let clientsCreated = 0;
  const adapter = new DiscordAdapter({
    core: core as never,
    token: "bot-token",
    logger: log.logger,
    timers: timers.provider,
    panelStore: store.store,
    clientFactory: () => {
      clientsCreated += 1;
      return client as never;
    },
    statusRefreshIntervalMs: opts.statusRefreshIntervalMs ?? 0,
    readyTimeoutMs: READY_TIMEOUT_MS,
    now: opts.now ?? (() => FIXED_NOW),
    botAvatar: opts.botAvatar,
    onPostError: opts.onPostError,
  });

  /** Build one of our customIds, registering handles for the given ids. */
  const id = (
    domain: CustomIdDomain,
    action: string,
    serverId?: string,
    entityId?: number,
  ): string =>
    buildCustomId({
      domain,
      action,
      server: serverId ? adapter.handleRegistry.register(serverId) : undefined,
      entity:
        serverId && entityId !== undefined
          ? adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId))
          : undefined,
    });

  /**
   * Let the edit pipeline's debounce run out, so the automatic edits it was
   * holding are sent, then let them land.
   */
  const settle = async (): Promise<void> => {
    await flush();
    timers.fire(EDIT_DEBOUNCE_MS);
    await flush();
  };

  /**
   * Start the adapter against the fake gateway (firing ClientReady so start()
   * resolves), then clear everything the startup reconcile recorded so tests
   * assert only on what they trigger.
   */
  const start = async (): Promise<void> => {
    const started = adapter.start();
    client.emit(Events.ClientReady);
    await started;
    chan.reset();
    core.calls.length = 0;
    store.calls.length = 0;
  };

  return {
    state,
    core,
    log,
    timers,
    chan,
    client,
    store,
    adapter,
    id,
    start,
    settle,
    clientsCreated: () => clientsCreated,
  };
}

type ClickKind = "button" | "channelSelect" | "roleSelect" | "stringSelect";

interface Ack {
  via: string;
  payload?: unknown;
}

/**
 * A dispatcher-level interaction (the {@link DispatchableInteraction} seam),
 * recording every acknowledgement in order.
 */
function makeClick(
  customId: string,
  opts: {
    roles?: string[];
    admin?: boolean;
    values?: string[];
    kind?: ClickKind;
    failReplyWith?: unknown;
  } = {},
) {
  const acks: Ack[] = [];
  const kind = opts.kind ?? "button";
  let dismissed = 0;
  const interaction: DispatchableInteraction = {
    customId,
    memberRoleIds: opts.roles ?? [],
    userId: "U1",
    userName: "rich",
    isAdministrator: opts.admin ?? false,
    values: opts.values,
    isButton: () => kind === "button",
    isChannelSelectMenu: () => kind === "channelSelect",
    isRoleSelectMenu: () => kind === "roleSelect",
    isStringSelectMenu: () => kind === "stringSelect",
    replyEphemeral: async (content) => {
      if (opts.failReplyWith !== undefined) throw opts.failReplyWith;
      acks.push({ via: "replyEphemeral", payload: content });
    },
    replyEphemeralPanel: async (payload) => {
      acks.push({ via: "replyEphemeralPanel", payload });
      return {
        editPanel: async () => {},
        delete: async () => {
          dismissed += 1;
        },
      };
    },
    showModal: async (modal) => {
      acks.push({ via: "showModal", payload: (modal as { toJSON(): unknown }).toJSON() });
    },
    deferUpdate: async () => {
      acks.push({ via: "deferUpdate" });
    },
    update: async (payload) => {
      acks.push({ via: "update", payload });
    },
    editReply: async (payload) => {
      acks.push({ via: "editReply", payload });
    },
  };
  return {
    interaction,
    acks,
    /** The `via` of each acknowledgement, in order. */
    order: (): string[] => acks.map((a) => a.via),
    /** Ephemeral text replies, in order. */
    texts: (): unknown[] => acks.filter((a) => a.via === "replyEphemeral").map((a) => a.payload),
    payloads: (via: string): unknown[] => acks.filter((a) => a.via === via).map((a) => a.payload),
    dismissed: (): number => dismissed,
  };
}

type GatewayKind = ClickKind | "modalSubmit" | "chatInput" | "autocomplete";

/**
 * A discord.js-shaped interaction for `onInteraction`. It is strict the way
 * discord.js is: acknowledging twice (or following up / editing the reply
 * before acknowledging) throws, so any double-ack in the adapter surfaces as a
 * logged handler error. `failReplyWith` fails every call that sends a first
 * response or fills one in (reply, deferReply, editReply) — an expired token.
 */
function makeGatewayInteraction(
  opts: {
    kind?: GatewayKind;
    customId?: string;
    roles?: string[];
    /** Overrides the whole `member` (e.g. `null`, or a role-manager shape). */
    member?: unknown;
    userId?: string;
    ownerId?: string;
    administrator?: boolean | "throws";
    values?: string[];
    fields?: Record<string, string>;
    subcommand?: string;
    failReplyWith?: unknown;
    /** The server the interaction came from. */
    guildId?: string;
  } = {},
) {
  const kind = opts.kind ?? "button";
  const acks: Ack[] = [];
  const assertUnacked = (): void => {
    if (i.replied || i.deferred) throw namedError("Error", "InteractionAlreadyReplied");
  };
  const i = {
    customId: opts.customId ?? "",
    replied: false,
    deferred: false,
    user: { id: opts.userId ?? "user-1", username: "rich" },
    member: "member" in opts ? opts.member : { roles: opts.roles ?? [] },
    guildId: opts.guildId ?? null,
    guild: { ownerId: opts.ownerId ?? "owner-1" },
    memberPermissions: {
      has: (): boolean => {
        if (opts.administrator === "throws") throw new Error("permissions unavailable");
        return opts.administrator ?? false;
      },
    },
    values: opts.values,
    commandName: "conduit",
    options: { getSubcommand: () => opts.subcommand ?? "status" },
    fields: { getTextInputValue: (key: string) => opts.fields?.[key] ?? "" },
    isChatInputCommand: () => kind === "chatInput",
    isButton: () => kind === "button",
    isChannelSelectMenu: () => kind === "channelSelect",
    isRoleSelectMenu: () => kind === "roleSelect",
    isStringSelectMenu: () => kind === "stringSelect",
    isModalSubmit: () => kind === "modalSubmit",
    reply: async (payload: unknown) => {
      if (opts.failReplyWith !== undefined) throw opts.failReplyWith;
      assertUnacked();
      i.replied = true;
      acks.push({ via: "reply", payload });
    },
    deferReply: async (payload: unknown) => {
      if (opts.failReplyWith !== undefined) throw opts.failReplyWith;
      assertUnacked();
      i.deferred = true;
      acks.push({ via: "deferReply", payload });
    },
    followUp: async (payload: unknown) => {
      if (!i.replied && !i.deferred) throw namedError("Error", "InteractionNotReplied");
      acks.push({ via: "followUp", payload });
      return {};
    },
    deferUpdate: async () => {
      assertUnacked();
      i.deferred = true;
      acks.push({ via: "deferUpdate" });
    },
    update: async (payload: unknown) => {
      assertUnacked();
      i.replied = true;
      acks.push({ via: "update", payload });
    },
    showModal: async (modal: unknown) => {
      assertUnacked();
      i.replied = true;
      acks.push({ via: "showModal", payload: (modal as { toJSON(): unknown }).toJSON() });
    },
    editReply: async (payload: unknown) => {
      if (opts.failReplyWith !== undefined) throw opts.failReplyWith;
      if (!i.replied && !i.deferred) throw namedError("Error", "InteractionNotReplied");
      // Like discord.js: filling in a deferred reply marks it replied.
      i.replied = true;
      acks.push({ via: "editReply", payload });
    },
    deleteReply: async () => {
      acks.push({ via: "deleteReply" });
    },
  };
  return {
    /** The interaction, typed for `onInteraction` / a gateway `emit`. */
    interaction: i as never,
    acks,
    order: (): string[] => acks.map((a) => a.via),
    payloads: (via: string): { content?: string; components?: unknown[]; flags?: number }[] =>
      acks.filter((a) => a.via === via).map((a) => a.payload as never),
  };
}

const isEphemeral = (flags: number | undefined): boolean =>
  ((flags ?? 0) & MessageFlags.Ephemeral) === MessageFlags.Ephemeral;

/** A Components V2 payload's first line of text: a panel message's heading. */
function heading(payload: unknown): string {
  const json = JSON.stringify(payload);
  const content = /"content":"((?:[^"\\]|\\.)*)"/.exec(json)?.[1] ?? "";
  return (JSON.parse(`"${content}"`) as string).split("\n")[0]!;
}

/** The row button (Section accessory) of the row whose text contains `text`. */
function rowButton(payload: unknown, text: string): { label?: string; disabled?: boolean } {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const container = (parsed as { components: { components: unknown[] }[] }).components[0]!;
  for (const c of container.components as {
    type: number;
    components?: { content?: string }[];
    accessory?: { label?: string; disabled?: boolean };
  }[]) {
    if (c.type === 9 && c.components?.some((t) => t.content?.includes(text))) {
      return c.accessory ?? {};
    }
  }
  throw new Error(`no row containing ${text}`);
}

// ── customId parsing: fail closed ────────────────────────────────────────────

describe("dispatcher: customId parsing fails closed", () => {
  it.each([
    ["an empty id", ""],
    ["a bare namespace", "conduit"],
    ["the prefix alone", "conduit:v1"],
    ["a missing action", "conduit:v1:switch"],
    ["an empty action", "conduit:v1:switch:"],
    ["an empty domain", "conduit:v1::on"],
    ["a future scheme version", "conduit:v2:switch:on:abc:def"],
    ["another bot's namespace", "other:v1:switch:on:abc:def"],
  ])("ignores %s without acknowledging or touching bot-core", async (_label, customId) => {
    const h = makeHarness(deviceState());
    const click = makeClick(customId, { roles: ["ADMIN"], admin: true });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome).toEqual({ handled: false, allowed: false });
    expect(click.acks).toEqual([]);
    expect(h.core.calls).toEqual([]);
  });

  it("reports the parsed handles of a server-scoped id in the outcome", async () => {
    const h = makeHarness(deviceState());
    const customId = h.id("server", "refresh", SERVER_ID);
    const click = makeClick(customId, { roles: ["USER"] });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome.handled).toBe(true);
    expect(outcome.allowed).toBe(true);
    expect(outcome.parsed).toEqual({
      domain: "server",
      action: "refresh",
      server: h.adapter.handleRegistry.handleFor(SERVER_ID),
    });
  });

  it("gates an unmapped action on a known domain as admin-only", async () => {
    const h = makeHarness(deviceState());
    const customId = h.id("switch", "selfdestruct", SERVER_ID, SWITCH_ID);

    const asUser = makeClick(customId, { roles: ["USER"] });
    const denied = await h.adapter.dispatch(asUser.interaction);
    expect(denied.allowed).toBe(false);
    expect(asUser.texts()).toEqual([DENIAL_MESSAGE]);

    // An admin gets through the gate, but the unknown action actuates nothing.
    const asAdmin = makeClick(customId, { roles: ["ADMIN"] });
    const allowed = await h.adapter.dispatch(asAdmin.interaction);
    expect(allowed.allowed).toBe(true);
    expect(asAdmin.order()).toEqual(["deferUpdate"]);
    expect(h.core.calls).toEqual([]);
  });

  it("denies a well-formed id on an unknown domain to a non-admin", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick("conduit:v1:bogus:on", { roles: ["USER"] });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome.handled).toBe(true);
    expect(outcome.allowed).toBe(false);
    expect(click.texts()).toEqual([DENIAL_MESSAGE]);
    expect(h.core.calls).toEqual([]);
  });

  it.each([
    ["the retired team domain", "conduit:v1:team:refresh:abc"],
    ["a domain this build has never heard of", "conduit:v1:bogus:on"],
  ])("acknowledges a permitted click on %s exactly once", async (_label, customId) => {
    const h = makeHarness(deviceState());
    // Through the strict gateway fake: a missing ack leaves `acks` empty, and a
    // double ack throws and is logged.
    const click = makeGatewayInteraction({ customId, roles: ["ADMIN"] });

    await h.adapter.onInteraction(click.interaction);

    expect(click.order()).toEqual(["deferUpdate"]);
    expect(h.core.calls).toEqual([]);
    expect(h.log.messages("error")).toEqual([]);
    expect(h.log.messages("warn")).toEqual([]);
  });

  it("reports an unrouted domain as handled and allowed, having actuated nothing", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick("conduit:v1:team:refresh:abc", { roles: ["ADMIN"] });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome).toMatchObject({ handled: true, allowed: true });
    expect(click.order()).toEqual(["deferUpdate"]);
    expect(h.core.calls).toEqual([]);
  });

  it("never acknowledges a foreign component arriving from the gateway", async () => {
    const h = makeHarness(deviceState());
    const foreign = makeGatewayInteraction({ customId: "someone-elses:button", roles: ["ADMIN"] });

    await h.adapter.onInteraction(foreign.interaction);

    expect(foreign.acks).toEqual([]);
    expect(h.core.calls).toEqual([]);
    expect(h.log.messages("error")).toEqual([]);
  });

  it("ignores interaction types it has no handler for", async () => {
    const h = makeHarness(deviceState());
    const autocomplete = makeGatewayInteraction({
      kind: "autocomplete",
      customId: h.id("switch", "on", SERVER_ID, SWITCH_ID),
      roles: ["ADMIN"],
    });

    await h.adapter.onInteraction(autocomplete.interaction);

    expect(autocomplete.acks).toEqual([]);
    expect(h.core.calls).toEqual([]);
  });
});

// ── per-click permission check ───────────────────────────────────────────────

describe("dispatcher: per-click permission check", () => {
  it("tells a member with no mapped role to ask for one on a user-gated action", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["STRANGER"] });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome).toMatchObject({ handled: true, allowed: false });
    expect(click.texts()).toEqual([NO_ROLE_MESSAGE]);
    expect(click.acks).toHaveLength(1);
    expect(h.core.calls).toEqual([]);
  });

  it("tells a member with no mapped role an admin role is needed on an admin-gated action", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick(h.id("setup", "addDevice"), { roles: [] });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome).toMatchObject({ handled: true, allowed: false });
    expect(click.texts()).toEqual([DENIAL_MESSAGE]);
    expect(h.core.calls).toEqual([]);
  });

  // A handled click leaves a log line, not just a denial.
  it("logs a handled click with its domain, action, device and outcome", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["ADMIN"] });

    await h.adapter.dispatch(click.interaction);

    expect(h.log.fields("info", "interaction handled")).toEqual([
      {
        domain: "switch",
        action: "on",
        serverId: SERVER_ID,
        entityId: SWITCH_ID,
        userId: "U1",
        outcome: "ok",
      },
    ]);
  });

  // Live test 2026-11-16: the "Switching…" repaint ran before the
  // acknowledgement, took over 3 seconds, and Discord rejected the late ack
  // ("Unknown interaction"), so the switch was never actuated.
  it("a switch ON/OFF click is acknowledged before the panel repaint and the actuation", async () => {
    const h = makeHarness(postedState());
    await h.start();
    // The repaint's REST call never returns.
    h.chan.channel.messages.fetch = () => new Promise(() => {});
    const click = makeClick(h.id("switch", "off", SERVER_ID, SWITCH_ID), { roles: ["USER"] });

    void h.adapter.dispatch(click.interaction);
    await flush();

    expect(click.order()).toEqual(["deferUpdate"]);
  });

  it("a switch toggle that fails is logged as failed and recorded in the logging channel", async () => {
    const h = makeHarness(postedState({ config: makeConfig({ loggingChannelId: "log-chan" }) }));
    await h.start();
    h.core.failWith("toggleEntity", namedError("EntityNotFoundError"));
    const click = makeClick(h.id("switch", "off", SERVER_ID, SWITCH_ID), { roles: ["USER"] });

    await h.adapter.dispatch(click.interaction);
    await flush();

    expect(h.log.fields("info", "interaction handled")).toEqual([
      expect.objectContaining({ domain: "switch", action: "off", outcome: "failed" }),
    ]);
    expect(h.chan.lines()).toContain(
      '[14:03:05] ⚠️ <@U1> switch "Front Door" → OFF failed: device not found, or no tool-cupboard access',
    );
  });

  it("logs a click whose handler failed as outcome: failed", async () => {
    const h = makeHarness(deviceState());
    h.core.failWith("setRoleCapabilities", new Error("boom"));
    const select = makeClick(h.id("setup", "adminRoles"), {
      roles: ["ADMIN"],
      kind: "roleSelect",
      values: ["R1"],
    });

    await h.adapter.dispatch(select.interaction);

    expect(h.log.fields("info", "interaction handled")).toEqual([
      expect.objectContaining({ domain: "setup", action: "adminRoles", outcome: "failed" }),
    ]);
  });

  it("lets an admin role perform a user-gated action (admin implies user)", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["ADMIN"] });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome.allowed).toBe(true);
    expect(h.core.callsTo("toggleEntity")).toEqual([[SERVER_ID, SWITCH_ID, true]]);
  });

  it.each([["pushover"], ["addCamera"]])(
    "denies setup:%s to a user role before any modal or panel opens",
    async (action) => {
      const h = makeHarness(deviceState());
      const click = makeClick(h.id("setup", action), { roles: ["USER"] });

      const outcome = await h.adapter.dispatch(click.interaction);

      expect(outcome.allowed).toBe(false);
      expect(click.order()).toEqual(["replyEphemeral"]);
      expect(click.texts()).toEqual([DENIAL_MESSAGE]);
    },
  );

  it("extends the Discord-Administrator bypass to the pairing flow", async () => {
    const h = makeHarness(
      deviceState({ config: makeConfig({ roleCapabilities: { admin: [], user: [] } }) }),
    );
    const click = makeClick(h.id("pairing", "cancel"), { roles: [], admin: true });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome.allowed).toBe(true);
    expect(h.core.callsTo("cancelPairing")).toHaveLength(1);
    expect(click.order()).toEqual(["update"]);
  });

  it.each<[CustomIdDomain, string, number | undefined]>([
    ["camera", "capture", CAMERA_ID],
    ["camera", "remove", CAMERA_ID],
    ["alarm", "settings", ALARM_ID],
    ["monitor", "watch", MONITOR_ID],
    ["server", "refresh", undefined],
  ])(
    "does not extend the Discord-Administrator bypass to %s:%s",
    async (domain, action, entityId) => {
      const h = makeHarness(deviceState());
      const click = makeClick(h.id(domain, action, SERVER_ID, entityId), {
        roles: [],
        admin: true,
      });

      const outcome = await h.adapter.dispatch(click.interaction);

      expect(outcome.allowed).toBe(false);
      expect(click.order()).toEqual(["replyEphemeral"]);
      expect(h.core.calls).toEqual([]);
      expect(h.store.calls).toEqual([]);
    },
  );

  it("re-reads the role map on every click (no cached decision)", async () => {
    const h = makeHarness(deviceState());
    const customId = h.id("switch", "off", SERVER_ID, SWITCH_ID);

    const before = makeClick(customId, { roles: ["NEWCOMER"] });
    expect((await h.adapter.dispatch(before.interaction)).allowed).toBe(false);
    expect(h.core.calls).toEqual([]);

    // An admin maps the member's role between two clicks.
    h.state.config = makeConfig({ roleCapabilities: { admin: ["ADMIN"], user: ["NEWCOMER"] } });

    const after = makeClick(customId, { roles: ["NEWCOMER"] });
    expect((await h.adapter.dispatch(after.interaction)).allowed).toBe(true);
    expect(h.core.callsTo("toggleEntity")).toEqual([[SERVER_ID, SWITCH_ID, false]]);
  });

  it("reads role ids off a cached GuildMemberRoleManager", async () => {
    const h = makeHarness(deviceState());
    const click = makeGatewayInteraction({
      customId: h.id("switch", "on", SERVER_ID, SWITCH_ID),
      member: { roles: { cache: new Map([["USER", {}]]) } },
    });

    await h.adapter.onInteraction(click.interaction);

    expect(h.core.callsTo("toggleEntity")).toEqual([[SERVER_ID, SWITCH_ID, true]]);
    expect(click.order()).toEqual(["deferUpdate"]);
  });

  it("treats an interaction with no member as holding no roles", async () => {
    const h = makeHarness(deviceState());
    const click = makeGatewayInteraction({
      customId: h.id("switch", "on", SERVER_ID, SWITCH_ID),
      member: null,
    });

    await h.adapter.onInteraction(click.interaction);

    expect(click.order()).toEqual(["reply"]);
    expect(click.payloads("reply")[0]?.content).toBe(NO_ROLE_MESSAGE);
    expect(isEphemeral(click.payloads("reply")[0]?.flags)).toBe(true);
    expect(h.core.calls).toEqual([]);
  });

  it("lets the guild owner drive a Setup-hub select with no roles and no Administrator bit", async () => {
    const h = makeHarness(deviceState());
    const select = makeGatewayInteraction({
      kind: "roleSelect",
      customId: h.id("setup", "adminRoles"),
      roles: [],
      userId: "the-owner",
      ownerId: "the-owner",
      administrator: false,
      values: ["R1", "R2"],
    });

    await h.adapter.onInteraction(select.interaction);

    expect(h.core.callsTo("setRoleCapabilities")).toEqual([
      [{ admin: ["R1", "R2"], user: ["USER"] }],
    ]);
    expect(select.order()).toEqual(["reply"]);
    expect(isEphemeral(select.payloads("reply")[0]?.flags)).toBe(true);
  });

  it("treats an unreadable permission bitfield as not-an-administrator", async () => {
    const h = makeHarness(deviceState());
    const click = makeGatewayInteraction({
      customId: h.id("setup", "addDevice"),
      roles: [],
      administrator: "throws",
    });

    await h.adapter.onInteraction(click.interaction);

    expect(click.payloads("reply").map((p) => p.content)).toEqual([DENIAL_MESSAGE]);
    expect(h.core.calls).toEqual([]);
    expect(h.log.messages("error")).toEqual([]);
  });
});

// ── routing ──────────────────────────────────────────────────────────────────

describe("dispatcher: routing", () => {
  it("acknowledges a switch action with no handler without actuating", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick(h.id("switch", "explode", SERVER_ID, SWITCH_ID), { roles: ["ADMIN"] });

    await h.adapter.dispatch(click.interaction);

    expect(click.order()).toEqual(["deferUpdate"]);
    expect(h.core.calls).toEqual([]);
  });

  it("answers a switch click whose handles no longer resolve with the generic failure", async () => {
    const h = makeHarness(deviceState());
    const stale = buildCustomId({
      domain: "switch",
      action: "on",
      server: "gone1",
      entity: "gone2",
    });
    const click = makeClick(stale, { roles: ["USER"] });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome.allowed).toBe(true);
    expect(click.texts()).toEqual([GENERIC_FAILURE_MESSAGE]);
    expect(h.core.calls).toEqual([]);
  });

  it.each<[CustomIdDomain, string, string]>([
    ["monitor", "watch", "USER"],
    ["alarm", "severity", "ADMIN"],
    ["camera", "capture", "USER"],
  ])(
    "acknowledges %s:%s with unresolvable handles and does nothing else",
    async (domain, action, role) => {
      const h = makeHarness(deviceState());
      const stale = buildCustomId({ domain, action, server: "gone1", entity: "gone2" });
      const click = makeClick(stale, { roles: [role], values: ["high"], kind: "stringSelect" });

      await h.adapter.dispatch(click.interaction);

      expect(click.order()).toEqual(["deferUpdate"]);
      expect(h.core.calls).toEqual([]);
      expect(h.store.calls).toEqual([]);
    },
  );

  it("acknowledges server:refresh for an unknown server without fetching status", async () => {
    const h = makeHarness(deviceState({ connected: [SERVER_ID] }));
    const stale = buildCustomId({ domain: "server", action: "refresh", server: "gone1" });
    const click = makeClick(stale, { roles: ["USER"] });

    await h.adapter.dispatch(click.interaction);

    expect(click.order()).toEqual(["deferUpdate"]);
    expect(h.core.calls).toEqual([]);
  });

  it("acknowledges a monitor action it has no handler for without persisting anything", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick(h.id("monitor", "explode", SERVER_ID, MONITOR_ID), {
      roles: ["ADMIN"],
    });

    await h.adapter.dispatch(click.interaction);

    expect(click.order()).toEqual(["deferUpdate"]);
    expect(h.store.calls).toEqual([]);
  });

  it("acknowledges an unmapped alarm action for an admin without touching bot-core", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick(h.id("alarm", "explode", SERVER_ID, ALARM_ID), { roles: ["ADMIN"] });

    await h.adapter.dispatch(click.interaction);

    expect(click.order()).toEqual(["deferUpdate"]);
    expect(h.core.calls).toEqual([]);
  });

  it("setup:userRoles replaces the user roles and keeps the admin roles", async () => {
    const h = makeHarness(deviceState());
    const select = makeClick(h.id("setup", "userRoles"), {
      roles: ["ADMIN"],
      kind: "roleSelect",
      values: ["R9"],
    });

    await h.adapter.dispatch(select.interaction);

    expect(h.core.callsTo("setRoleCapabilities")).toEqual([[{ admin: ["ADMIN"], user: ["R9"] }]]);
  });

  it("setup:userRoles with nothing selected clears the user roles", async () => {
    const h = makeHarness(deviceState());
    const select = makeClick(h.id("setup", "userRoles"), { roles: ["ADMIN"], kind: "roleSelect" });

    await h.adapter.dispatch(select.interaction);

    expect(h.core.callsTo("setRoleCapabilities")).toEqual([[{ admin: ["ADMIN"], user: [] }]]);
  });

  it.each([["channel"], ["logChannel"]])(
    "setup:%s with no selected value acknowledges without changing config",
    async (action) => {
      const h = makeHarness(deviceState());
      const select = makeClick(h.id("setup", action), {
        roles: ["ADMIN"],
        kind: "channelSelect",
        values: [],
      });

      await h.adapter.dispatch(select.interaction);

      expect(select.order()).toEqual(["deferUpdate"]);
      expect(h.core.calls).toEqual([]);
    },
  );

  it("setup:startOnLogin flips the persisted preference and re-renders the hub label", async () => {
    const h = makeHarness(deviceState());
    expect(h.state.config.startOnLogin).toBe(false);

    const enable = makeClick(h.id("setup", "startOnLogin"), { roles: ["ADMIN"] });
    await h.adapter.dispatch(enable.interaction);

    expect(h.core.callsTo("setStartOnLogin")).toEqual([[true]]);
    expect(h.state.config.startOnLogin).toBe(true);
    expect(enable.order()).toEqual(["update"]);
    expect(JSON.stringify(enable.payloads("update")[0])).toContain("Start on login: ON");

    const disable = makeClick(h.id("setup", "startOnLogin"), { roles: ["ADMIN"] });
    await h.adapter.dispatch(disable.interaction);

    expect(h.core.callsTo("setStartOnLogin")).toEqual([[true], [false]]);
    expect(h.state.config.startOnLogin).toBe(false);
    expect(JSON.stringify(disable.payloads("update")[0])).toContain("Start on login: OFF");
  });

  it("setup:startOnLogin is admin-only", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick(h.id("setup", "startOnLogin"), { roles: ["USER"] });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome.allowed).toBe(false);
    expect(click.texts()).toEqual([DENIAL_MESSAGE]);
    expect(h.core.callsTo("setStartOnLogin")).toEqual([]);
    expect(h.state.config.startOnLogin).toBe(false);
  });

  it("setup:startOnLogin reports a failure and does not repaint a label it did not change", async () => {
    const h = makeHarness(deviceState());
    const err = namedError("StateError");
    h.core.failWith("setStartOnLogin", err);
    const click = makeClick(h.id("setup", "startOnLogin"), { roles: ["ADMIN"] });

    await h.adapter.dispatch(click.interaction);

    expect(click.order()).toEqual(["replyEphemeral"]);
    expect(click.texts()).toEqual([friendlyError(err)]);
    expect(h.state.config.startOnLogin).toBe(false);
  });

  it("setup:addCamera with no paired server explains instead of opening a modal", async () => {
    const h = makeHarness(makeState());
    const click = makeClick(h.id("setup", "addCamera"), { roles: ["ADMIN"] });

    await h.adapter.dispatch(click.interaction);

    expect(click.order()).toEqual(["replyEphemeral"]);
  });

  it("setup:addCamera with one server opens the add-camera modal bound to it", async () => {
    const h = makeHarness(deviceState());
    const click = makeClick(h.id("setup", "addCamera"), { roles: ["ADMIN"] });

    await h.adapter.dispatch(click.interaction);

    expect(click.order()).toEqual(["showModal"]);
    expect(click.payloads("showModal")[0]).toMatchObject({
      custom_id: h.id("setup", "cameraAdd", SERVER_ID),
    });
  });

  it("setup:addCamera with several servers offers a server picker first", async () => {
    const h = makeHarness(
      makeState({
        servers: [makeServer("srv-a", { name: "Alpha" }), makeServer("srv-b", { name: "Bravo" })],
      }),
    );
    const click = makeClick(h.id("setup", "addCamera"), { roles: ["ADMIN"] });

    await h.adapter.dispatch(click.interaction);

    expect(click.order()).toEqual(["replyEphemeralPanel"]);
    const picker = JSON.stringify(click.payloads("replyEphemeralPanel")[0]);
    expect(picker).toContain(h.id("setup", "cameraServer"));
    expect(picker).toContain("Alpha");
    expect(picker).toContain("Bravo");
  });

  it("setup:cameraServer opens the add-camera modal for the picked server", async () => {
    const h = makeHarness(makeState({ servers: [makeServer("srv-a"), makeServer("srv-b")] }));
    const picked = h.adapter.handleRegistry.register("srv-b");
    const select = makeClick(h.id("setup", "cameraServer"), {
      roles: ["ADMIN"],
      kind: "stringSelect",
      values: [picked],
    });

    await h.adapter.dispatch(select.interaction);

    expect(select.order()).toEqual(["showModal"]);
    expect(select.payloads("showModal")[0]).toMatchObject({
      custom_id: h.id("setup", "cameraAdd", "srv-b"),
    });
  });

  it("setup:cameraServer with no selection just acknowledges", async () => {
    const h = makeHarness(makeState({ servers: [makeServer("srv-a"), makeServer("srv-b")] }));
    const select = makeClick(h.id("setup", "cameraServer"), {
      roles: ["ADMIN"],
      kind: "stringSelect",
      values: [],
    });

    await h.adapter.dispatch(select.interaction);

    expect(select.order()).toEqual(["deferUpdate"]);
  });

  it("the Setup hub's button reads Rebuild panels and keeps the setup:repost custom id", async () => {
    const h = makeHarness(deviceState());
    // Any re-render of the hub shows its buttons.
    const click = makeClick(h.id("setup", "startOnLogin"), { roles: ["ADMIN"] });
    await h.adapter.dispatch(click.interaction);

    const find = (node: unknown): Record<string, unknown> | undefined => {
      if (Array.isArray(node)) return node.map(find).find(Boolean);
      if (!node || typeof node !== "object") return undefined;
      const record = node as Record<string, unknown>;
      if (record.custom_id === h.id("setup", "repost")) return record;
      return Object.values(record).map(find).find(Boolean);
    };
    const hub = JSON.parse(JSON.stringify(click.payloads("update")[0]));
    expect(find(hub)).toEqual(expect.objectContaining({ label: "Rebuild panels" }));
    expect(JSON.stringify(hub)).not.toContain("Repost panels");
  });

  it("setup:repost (Rebuild panels) deletes the server's panel and posts it afresh, in order", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const click = makeClick(h.id("setup", "repost"), { roles: ["ADMIN"] });

    await h.adapter.dispatch(click.interaction);

    expect(click.order()).toEqual(["deferUpdate"]);
    expect(h.chan.deleted).toEqual(POSTED_MESSAGES);
    expect(h.chan.sent.map((s) => heading(s.payload))).toEqual([
      "### Server srv-1",
      "### 🔌 Switches",
      "### 🔔 Alarms",
      "### 📦 Storage",
      "### 📷 Cameras",
    ]);
    const [server, switches, alarms, storage, cameras] = h.chan.sent.map((s) => s.id);
    expect(h.store.callsTo("setServerPanelIds")).toEqual([
      [
        SERVER_ID,
        { server, switches: [switches], alarms: [alarms], storage: [storage], cameras: [cameras] },
      ],
    ]);
  });

  it("carries a select menu's values across the gateway bridge", async () => {
    const h = makeHarness(deviceState());
    const select = makeGatewayInteraction({
      kind: "channelSelect",
      customId: h.id("setup", "logChannel"),
      roles: ["ADMIN"],
      values: ["log-chan-9"],
    });

    await h.adapter.onInteraction(select.interaction);

    expect(h.core.callsTo("setLoggingChannel")).toEqual([["log-chan-9"]]);
    expect(select.order()).toEqual(["update"]);
  });
});

// ── slash commands ───────────────────────────────────────────────────────────

describe("dispatcher: slash commands", () => {
  it("/conduit status lists the paired servers ephemerally for a user role", async () => {
    const h = makeHarness(
      makeState({
        servers: [makeServer("srv-a", { name: "Alpha" }), makeServer("srv-b", { name: "Bravo" })],
      }),
    );
    const slash = makeGatewayInteraction({
      kind: "chatInput",
      subcommand: "status",
      roles: ["USER"],
    });

    await h.adapter.onInteraction(slash.interaction);

    expect(slash.order()).toEqual(["reply"]);
    const reply = slash.payloads("reply")[0];
    expect(reply?.content).toContain("Alpha");
    expect(reply?.content).toContain("Bravo");
    expect(reply?.components).toBeUndefined();
    expect(isEphemeral(reply?.flags)).toBe(true);
  });

  it("/conduit status with nothing paired says so rather than replying empty", async () => {
    const h = makeHarness(makeState());
    const slash = makeGatewayInteraction({
      kind: "chatInput",
      subcommand: "status",
      roles: ["USER"],
    });

    await h.adapter.onInteraction(slash.interaction);

    const content = slash.payloads("reply")[0]?.content ?? "";
    expect(content).toMatch(/no servers paired/i);
    expect(content).not.toBe(DENIAL_MESSAGE);
  });

  it("/conduit status is denied to a member with no role and no Discord admin rights", async () => {
    const h = makeHarness(deviceState());
    const slash = makeGatewayInteraction({ kind: "chatInput", subcommand: "status", roles: [] });

    await h.adapter.onInteraction(slash.interaction);

    const reply = slash.payloads("reply")[0];
    expect(reply?.content).toBe(DENIAL_MESSAGE);
    expect(isEphemeral(reply?.flags)).toBe(true);
  });

  it("/conduit setup is denied to a user role (admin-only)", async () => {
    const h = makeHarness(deviceState());
    const slash = makeGatewayInteraction({
      kind: "chatInput",
      subcommand: "setup",
      roles: ["USER"],
    });

    await h.adapter.onInteraction(slash.interaction);

    expect(slash.order()).toEqual(["reply"]);
    const reply = slash.payloads("reply")[0];
    expect(reply?.content).toBe(DENIAL_MESSAGE);
    expect(reply?.components).toBeUndefined();
  });

  it("a slash command never reaches the component dispatcher", async () => {
    const h = makeHarness(deviceState());
    // A chat-input interaction has no component customId; one that somehow
    // carried ours must still be answered as a command, not actuated.
    const slash = makeGatewayInteraction({
      kind: "chatInput",
      subcommand: "status",
      roles: ["USER"],
      customId: h.id("switch", "on", SERVER_ID, SWITCH_ID),
    });

    await h.adapter.onInteraction(slash.interaction);

    expect(slash.order()).toEqual(["reply"]);
    expect(h.core.calls).toEqual([]);
  });
});

describe("adapter: the Conduit roles are adopted by name", () => {
  const GUILD_ID = "guild-1";
  const SERVER_ROLES = [
    { id: "everyone", name: "@everyone" },
    { id: "r-admin", name: "Conduit Admin" },
    { id: "r-user", name: "Conduit" },
    // Discord's role for the bot itself, named after it: never adopted.
    { id: "r-bot", name: "Conduit", managed: true },
  ];

  /** A harness with nothing chosen, its server's roles in the gateway cache. */
  function harness(
    roleCapabilities = { admin: [] as string[], user: [] as string[] },
    roles = SERVER_ROLES,
  ) {
    const h = makeHarness(
      deviceState({ config: makeConfig({ discordGuildId: GUILD_ID, roleCapabilities }) }),
    );
    h.client.setRoles(GUILD_ID, roles);
    return h;
  }

  /** Log in and fire ClientReady, keeping what the startup did on record. */
  async function ready(h: ReturnType<typeof makeHarness>): Promise<void> {
    const started = h.adapter.start();
    h.client.emit(Events.ClientReady);
    await started;
  }

  /** Open the Setup hub as the server owner; return the role ids each select shows. */
  async function openSetup(h: ReturnType<typeof harness>) {
    const slash = makeGatewayInteraction({
      kind: "chatInput",
      subcommand: "setup",
      userId: "owner-1",
      guildId: GUILD_ID,
    });
    await h.adapter.onInteraction(slash.interaction);
    expect(slash.order()).toEqual(["reply"]);
    const components = slash.payloads("reply")[0]?.components ?? [];
    const selected = (action: string): string[] => {
      const select = findComponent(components, buildCustomId({ domain: "setup", action }));
      const defaults = (select as { default_values?: { id: string; type: string }[] })
        ?.default_values;
      expect(defaults?.every((d) => d.type === "role") ?? true).toBe(true);
      return (defaults ?? []).map((d) => d.id);
    };
    return { admin: selected("adminRoles"), user: selected("userRoles") };
  }

  it("on ready, with none chosen, saves the named roles, and the Setup hub shows them", async () => {
    const h = harness();
    await ready(h);

    expect(h.core.callsTo("setRoleCapabilities")).toEqual([
      [{ admin: ["r-admin"], user: ["r-user"] }],
    ]);
    expect(h.log.messages("info")).toContain("discord: adopted the Conduit roles by name");
    expect(await openSetup(h)).toEqual({ admin: ["r-admin"], user: ["r-user"] });
  });

  it("a member with the adopted user role can then turn a switch on", async () => {
    const h = harness();
    await ready(h);
    const click = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["r-user"] });

    const outcome = await h.adapter.dispatch(click.interaction);

    expect(outcome).toMatchObject({ handled: true, allowed: true });
    expect(click.texts()).not.toContain(NO_ROLE_MESSAGE);
  });

  it("with only one of the roles in the server, adopts it and leaves the other empty", async () => {
    const h = harness(undefined, [{ id: "r-user", name: "conduit" }]);
    await ready(h);

    expect(h.core.callsTo("setRoleCapabilities")).toEqual([[{ admin: [], user: ["r-user"] }]]);
    expect(await openSetup(h)).toEqual({ admin: [], user: ["r-user"] });
  });

  it("never replaces roles already chosen, on ready or in the Setup hub", async () => {
    const h = harness({ admin: ["mine"], user: [] }, [
      ...SERVER_ROLES,
      { id: "mine", name: "Officers" },
    ]);
    await ready(h);
    const shown = await openSetup(h);

    expect(h.core.callsTo("setRoleCapabilities")).toEqual([]);
    expect(shown).toEqual({ admin: ["mine"], user: [] });
  });

  it("opening the Setup hub adopts roles created since Conduit started", async () => {
    const h = harness(undefined, [{ id: "everyone", name: "@everyone" }]);
    await ready(h);
    expect(h.core.callsTo("setRoleCapabilities")).toEqual([]);

    h.client.setRoles(GUILD_ID, SERVER_ROLES);
    expect(await openSetup(h)).toEqual({ admin: ["r-admin"], user: ["r-user"] });
    expect(h.core.callsTo("setRoleCapabilities")).toEqual([
      [{ admin: ["r-admin"], user: ["r-user"] }],
    ]);
  });

  it("does nothing while the server is not in the cache", async () => {
    const h = makeHarness(
      deviceState({
        config: makeConfig({ discordGuildId: GUILD_ID, roleCapabilities: { admin: [], user: [] } }),
      }),
    );
    await ready(h);
    expect(h.core.callsTo("setRoleCapabilities")).toEqual([]);
  });

  it("a failed save is logged, and the Setup hub still opens", async () => {
    const h = harness();
    h.core.failWith("setRoleCapabilities", new Error("disk full"));
    await ready(h);

    expect(await openSetup(h)).toEqual({ admin: [], user: [] });
    expect(h.log.messages("warn")).toContain("discord: adopting the Conduit roles failed");
  });

  it("the Setup hub leaves out a chosen role the server no longer has", async () => {
    const h = harness({ admin: ["r-admin", "deleted"], user: ["r-user"] });
    await ready(h);
    expect(await openSetup(h)).toEqual({ admin: ["r-admin"], user: ["r-user"] });
  });
});

// ── modal submits ────────────────────────────────────────────────────────────

describe("dispatcher: modal submits", () => {
  it("ignores a modal whose customId is not ours", async () => {
    const h = makeHarness(deviceState());
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: "other-bot:modal",
      roles: ["ADMIN"],
      fields: { label: "x" },
    });

    await h.adapter.onInteraction(submit.interaction);

    expect(submit.acks).toEqual([]);
    expect(h.core.calls).toEqual([]);
  });

  it.each<[CustomIdDomain, string, number | undefined]>([
    ["pairing", "label", SWITCH_ID],
    ["switch", "autodelay", SWITCH_ID],
    ["setup", "pushover", undefined],
    ["setup", "cameraAdd", undefined],
  ])("denies a %s:%s submit from a user role and persists nothing", async (domain, action, eid) => {
    const h = makeHarness(deviceState());
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: h.id(domain, action, SERVER_ID, eid),
      roles: ["USER"],
      fields: { label: "Name", seconds: "60", appToken: "a", userKey: "b", identifier: "CAM" },
    });

    await h.adapter.onInteraction(submit.interaction);

    expect(submit.order()).toEqual(["reply"]);
    expect(submit.payloads("reply")[0]?.content).toBe(DENIAL_MESSAGE);
    expect(isEphemeral(submit.payloads("reply")[0]?.flags)).toBe(true);
    expect(h.core.calls).toEqual([]);
  });

  it("does not extend the Discord-Administrator bypass to a device-domain modal", async () => {
    const h = makeHarness(deviceState());
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: h.id("switch", "autodelay", SERVER_ID, SWITCH_ID),
      roles: [],
      administrator: true,
      fields: { seconds: "60" },
    });

    await h.adapter.onInteraction(submit.interaction);

    expect(submit.payloads("reply").map((p) => p.content)).toEqual([DENIAL_MESSAGE]);
    expect(h.core.calls).toEqual([]);
  });

  it.each([["abc"], ["60.5"], ["1e1000"], ["60 seconds"]])(
    "rejects a non-integer auto-revert delay %j without persisting it",
    async (seconds) => {
      const h = makeHarness(deviceState());
      const submit = makeGatewayInteraction({
        kind: "modalSubmit",
        customId: h.id("switch", "autodelay", SERVER_ID, SWITCH_ID),
        roles: ["ADMIN"],
        fields: { seconds },
      });

      await h.adapter.onInteraction(submit.interaction);

      expect(submit.order()).toEqual(["reply"]);
      expect(isEphemeral(submit.payloads("reply")[0]?.flags)).toBe(true);
      expect(h.core.callsTo("setSwitchAutoDelaySeconds")).toEqual([]);
    },
  );

  it("rejects a valid delay submitted against handles that no longer resolve", async () => {
    const h = makeHarness(deviceState());
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: buildCustomId({
        domain: "switch",
        action: "autodelay",
        server: "gone1",
        entity: "gone2",
      }),
      roles: ["ADMIN"],
      fields: { seconds: "60" },
    });

    await h.adapter.onInteraction(submit.interaction);

    expect(submit.order()).toEqual(["reply"]);
    expect(h.core.calls).toEqual([]);
  });

  it("does not register a camera against a server handle that no longer resolves", async () => {
    const h = makeHarness(deviceState());
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: buildCustomId({ domain: "setup", action: "cameraAdd", server: "gone1" }),
      roles: ["ADMIN"],
      fields: { identifier: "GATE1", label: "Gate" },
    });

    await h.adapter.onInteraction(submit.interaction);

    expect(submit.order()).toEqual(["reply"]);
    expect(h.core.callsTo("addCamera")).toEqual([]);
  });

  it.each([["AuthError"], ["RateLimitError"], ["ConnectionError"]])(
    "turns a %s from bot-core into a friendly ephemeral reply",
    async (name) => {
      const h = makeHarness(deviceState());
      const err = namedError(name);
      h.core.failWith("setEntityLabel", err);
      const submit = makeGatewayInteraction({
        kind: "modalSubmit",
        customId: h.id("pairing", "label", SERVER_ID, SWITCH_ID),
        roles: ["ADMIN"],
        fields: { label: "Front Door" },
      });

      await h.adapter.onInteraction(submit.interaction);

      // Acknowledged before bot-core was called; the failure then replaces the
      // pending reply (whose ephemeral flag was set by the deferral).
      expect(submit.order()).toEqual(["deferReply", "editReply"]);
      expect(isEphemeral(submit.payloads("deferReply")[0]?.flags)).toBe(true);
      const outcome = submit.payloads("editReply")[0];
      expect(outcome?.content).toBe(friendlyError(err));
      expect(outcome?.content).not.toBe(GENERIC_FAILURE_MESSAGE);
      expect(outcome?.content).not.toContain(err.message);
    },
  );

  it("acknowledges a label submit before the panel is laid out", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: h.id("pairing", "label", SERVER_ID, SWITCH_ID),
      roles: ["ADMIN"],
      fields: { label: "Back Door" },
    });
    // How many acknowledgements had been made when each panel message was written.
    const acksAtWrite: number[] = [];
    const fetch = h.chan.channel.messages.fetch;
    h.chan.channel.messages.fetch = (async (arg: string | { limit: number }) => {
      if (typeof arg === "string") acksAtWrite.push(submit.acks.length);
      return fetch(arg);
    }) as typeof fetch;

    await h.adapter.onInteraction(submit.interaction);

    expect(h.core.callsTo("setEntityLabel")).toEqual([[SERVER_ID, SWITCH_ID, "Back Door"]]);
    expect(submit.order()).toEqual(["deferReply", "editReply"]);
    expect(submit.payloads("editReply")[0]?.content).toBe("✅ Saved.");
    // The rename was an edit of the Switches message in place, after both the
    // acknowledgement and the "Saved" outcome.
    expect(h.chan.editsTo("sw-1")).toEqual([expect.stringContaining("Back Door")]);
    expect(h.chan.sent).toEqual([]);
    expect(acksAtWrite.length).toBeGreaterThan(0);
    expect(acksAtWrite.every((count) => count === 2)).toBe(true);
  });

  it("follows up (not replies again) when a modal handler fails after replying", async () => {
    // No panel posted yet, so laying it out after the label posts it; that
    // fails while persisting the posted ids, after the label was saved.
    const h = makeHarness(deviceState());
    const err = namedError("StateError");
    h.store.store.setServerPanelIds = async () => {
      throw err;
    };
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: h.id("pairing", "label", SERVER_ID, SWITCH_ID),
      roles: ["ADMIN"],
      fields: { label: "Front Door" },
    });

    await h.adapter.onInteraction(submit.interaction);

    expect(submit.order()).toEqual(["deferReply", "editReply", "followUp"]);
    expect(submit.payloads("editReply")[0]?.content).toBe("✅ Saved.");
    const followUp = submit.payloads("followUp")[0];
    expect(followUp?.content).toBe(friendlyError(err));
    expect(followUp?.content).not.toContain(err.message);
    expect(isEphemeral(followUp?.flags)).toBe(true);
    // One error, for the real failure. The strict fake throws
    // InteractionAlreadyReplied on a second reply(); that would surface here as
    // a second, misleading "interaction handling failed".
    expect(h.log.messages("error")).toEqual(["modal submit failed"]);
    expect(h.log.messages("warn")).not.toContain("error reply failed");
  });

  it("logs, rather than throws, when a modal's failure reply cannot be delivered", async () => {
    const h = makeHarness(deviceState());
    h.core.failWith("setEntityLabel", namedError("ConnectionError"));
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: h.id("pairing", "label", SERVER_ID, SWITCH_ID),
      roles: ["ADMIN"],
      fields: { label: "Front Door" },
      failReplyWith: namedError("DiscordAPIError", "Unknown interaction"),
    });

    await expect(h.adapter.onInteraction(submit.interaction)).resolves.toBeUndefined();

    expect(submit.acks).toEqual([]);
    expect(h.log.messages("error")).toEqual(["modal submit failed"]);
    expect(h.log.messages("warn")).toContain("error reply failed");
  });

  it("acknowledges a permitted modal it has no handler for", async () => {
    const h = makeHarness(deviceState());
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: "conduit:v1:setup:retiredForm",
      roles: ["ADMIN"],
    });

    await h.adapter.onInteraction(submit.interaction);

    expect(submit.order()).toEqual(["reply"]);
    expect(isEphemeral(submit.payloads("reply")[0]?.flags)).toBe(true);
    expect(h.core.calls).toEqual([]);
    expect(h.log.messages("error")).toEqual([]);
  });

  it("falls back to the generic failure copy for an untyped bot-core error", async () => {
    const h = makeHarness(deviceState());
    h.core.failWith("addCamera", new Error("ECONNRESET at socket.js:42"));
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: h.id("setup", "cameraAdd", SERVER_ID),
      roles: ["ADMIN"],
      fields: { identifier: "GATE1" },
    });

    await h.adapter.onInteraction(submit.interaction);

    expect(submit.order()).toEqual(["deferReply", "editReply"]);
    expect(submit.payloads("editReply").map((p) => p.content)).toEqual([GENERIC_FAILURE_MESSAGE]);
  });

  /**
   * Record, for each named bot-core call, how many acknowledgements the modal
   * had made by the time the call started.
   */
  function acksWhenCalled(
    h: ReturnType<typeof makeHarness>,
    submit: ReturnType<typeof makeGatewayInteraction>,
    methods: string[],
  ): Record<string, number[]> {
    const seen: Record<string, number[]> = {};
    const core = h.core as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of methods) {
      seen[method] = [];
      const original = core[method]!;
      core[method] = (...args: unknown[]) => {
        seen[method]!.push(submit.acks.length);
        return original(...args);
      };
    }
    return seen;
  }

  it.each<[string, CustomIdDomain, string, number | undefined, Record<string, string>, string]>([
    [
      "the auto-revert delay",
      "switch",
      "autodelay",
      SWITCH_ID,
      { seconds: "60" },
      "setSwitchAutoDelaySeconds",
    ],
    [
      "add camera",
      "setup",
      "cameraAdd",
      undefined,
      { identifier: "GATE2", label: "Gate" },
      "addCamera",
    ],
    [
      "Pushover credentials",
      "setup",
      "pushover",
      undefined,
      { appToken: "a", userKey: "b" },
      "setPushoverCredentials",
    ],
    ["clearing Pushover", "setup", "pushover", undefined, {}, "clearPushoverCredentials"],
    ["a device label", "pairing", "label", SWITCH_ID, { label: "Front Door" }, "setEntityLabel"],
  ])(
    "acknowledges %s before calling bot-core, then fills in the outcome",
    async (_label, domain, action, entityId, fields, method) => {
      const h = makeHarness(deviceState());
      const submit = makeGatewayInteraction({
        kind: "modalSubmit",
        customId: h.id(domain, action, SERVER_ID, entityId),
        roles: ["ADMIN"],
        fields,
      });
      const seen = acksWhenCalled(h, submit, [method]);

      await h.adapter.onInteraction(submit.interaction);

      // bot-core ran exactly once, and only after the deferred acknowledgement.
      expect(seen[method]).toEqual([1]);
      expect(submit.order()).toEqual(["deferReply", "editReply"]);
      expect(isEphemeral(submit.payloads("deferReply")[0]?.flags)).toBe(true);
      expect(submit.payloads("editReply")[0]?.content).toMatch(/^✅/);
      expect(h.log.messages("error")).toEqual([]);
    },
  );

  it("still acknowledges in time when bot-core is slow to answer", async () => {
    const h = makeHarness(deviceState());
    // The server takes its time: the delay setter does not resolve until released.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const core = h.core as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = core.setSwitchAutoDelaySeconds!;
    core.setSwitchAutoDelaySeconds = async (...args: unknown[]) => {
      await gate;
      return original(...args);
    };
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: h.id("switch", "autodelay", SERVER_ID, SWITCH_ID),
      roles: ["ADMIN"],
      fields: { seconds: "60" },
    });

    const handling = h.adapter.onInteraction(submit.interaction);
    await flush();

    // bot-core has not answered, yet Discord already has its acknowledgement.
    expect(submit.order()).toEqual(["deferReply"]);

    release();
    await handling;
    expect(submit.order()).toEqual(["deferReply", "editReply"]);
    expect(submit.payloads("editReply")[0]?.content).toContain("60s");
  });

  it.each<[string, CustomIdDomain, string, number | undefined, Record<string, string>]>([
    ["an out-of-range delay", "switch", "autodelay", SWITCH_ID, { seconds: "5" }],
    ["a camera with no identifier", "setup", "cameraAdd", undefined, { identifier: "  " }],
    ["half a Pushover credential", "setup", "pushover", undefined, { appToken: "a" }],
  ])(
    "answers %s at once, without deferring or calling bot-core",
    async (_l, domain, action, eid, fields) => {
      const h = makeHarness(deviceState());
      const submit = makeGatewayInteraction({
        kind: "modalSubmit",
        customId: h.id(domain, action, SERVER_ID, eid),
        roles: ["ADMIN"],
        fields,
      });

      await h.adapter.onInteraction(submit.interaction);

      expect(submit.order()).toEqual(["reply"]);
      expect(submit.payloads("reply")[0]?.content).toMatch(/^⚠️/);
      expect(isEphemeral(submit.payloads("reply")[0]?.flags)).toBe(true);
      expect(h.core.calls).toEqual([]);
    },
  );

  it("tells the member a label modal's device is gone instead of claiming it was saved", async () => {
    const h = makeHarness(deviceState());
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: buildCustomId({
        domain: "pairing",
        action: "label",
        server: "gone1",
        entity: "gone2",
      }),
      roles: ["ADMIN"],
      fields: { label: "Front Door" },
    });

    await h.adapter.onInteraction(submit.interaction);

    expect(submit.order()).toEqual(["reply"]);
    expect(submit.payloads("reply")[0]?.content).toBe(STALE_STATE_MESSAGE);
    expect(h.core.calls).toEqual([]);
  });
});

// ── failures → friendly ephemeral replies ────────────────────────────────────

describe("dispatcher: failures become friendly ephemeral replies", () => {
  it.each([
    ["AuthError", undefined],
    ["RateLimitError", undefined],
    ["ConnectionError", undefined],
    ["EntityNotFoundError", ENTITY_NOT_FOUND_MESSAGE],
  ])("maps a thrown %s to its tailored copy, with no stack or raw message", async (name, copy) => {
    const h = makeHarness(deviceState());
    const err = namedError(name);
    h.core.failWith("setRoleCapabilities", err);
    const select = makeClick(h.id("setup", "adminRoles"), {
      roles: ["ADMIN"],
      kind: "roleSelect",
      values: ["R1"],
    });

    const outcome = await h.adapter.dispatch(select.interaction);

    // The click was ours and permitted; the failure is reported, not thrown.
    expect(outcome).toMatchObject({ handled: true, allowed: true });
    expect(select.order()).toEqual(["replyEphemeral"]);
    const text = String(select.texts()[0]);
    expect(text).toBe(copy ?? friendlyError(err));
    expect(text).not.toBe(GENERIC_FAILURE_MESSAGE);
    expect(text).not.toContain(err.message);
    expect(text).not.toContain(String(err.stack).split("\n")[1]?.trim() ?? "    at ");
    expect(h.log.messages("error")).toContain("dispatch failed");
  });

  it.each([
    ["an untyped Error", new Error("TypeError: cannot read properties of undefined")],
    ["a thrown string", "kaboom"],
    ["a thrown null", null],
    ["a thrown plain object", { code: 500 }],
  ])("maps %s to the generic failure copy", async (_label, thrown) => {
    const h = makeHarness(deviceState());
    h.core.failWith("setRoleCapabilities", thrown);
    const select = makeClick(h.id("setup", "adminRoles"), {
      roles: ["ADMIN"],
      kind: "roleSelect",
      values: ["R1"],
    });

    const outcome = await h.adapter.dispatch(select.interaction);

    expect(outcome).toMatchObject({ handled: true, allowed: true });
    expect(select.texts()).toEqual([GENERIC_FAILURE_MESSAGE]);
  });

  it("still resolves when the failure reply itself cannot be delivered", async () => {
    const h = makeHarness(deviceState());
    h.core.failWith("setRoleCapabilities", namedError("ConnectionError"));
    const select = makeClick(h.id("setup", "adminRoles"), {
      roles: ["ADMIN"],
      kind: "roleSelect",
      values: ["R1"],
      failReplyWith: namedError("DiscordAPIError", "Unknown interaction"),
    });

    const outcome = await h.adapter.dispatch(select.interaction);

    expect(outcome).toMatchObject({ handled: true, allowed: true });
    expect(h.log.messages("warn")).toContain("error reply failed");
  });

  it("replies (not follows up) when the failure happens before any acknowledgement", async () => {
    const h = makeHarness(deviceState());
    const err = namedError("RateLimitError");
    h.core.failWith("setRoleCapabilities", err);
    const select = makeGatewayInteraction({
      kind: "roleSelect",
      customId: h.id("setup", "adminRoles"),
      roles: ["ADMIN"],
      values: ["R1"],
    });

    await h.adapter.onInteraction(select.interaction);

    expect(select.order()).toEqual(["reply"]);
    expect(select.payloads("reply")[0]?.content).toBe(friendlyError(err));
    expect(isEphemeral(select.payloads("reply")[0]?.flags)).toBe(true);
    expect(h.log.messages("error")).toEqual(["dispatch failed"]);
  });

  it("follows up (not replies) when a camera capture fails after the deferred ack", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const err = namedError("ConnectionError");
    h.core.failWith("getCameraFrame", err);
    const click = makeGatewayInteraction({
      customId: h.id("camera", "capture", SERVER_ID, CAMERA_ID),
      roles: ["USER"],
    });

    await h.adapter.onInteraction(click.interaction);

    expect(click.order()).toEqual(["deferUpdate", "followUp"]);
    expect(click.payloads("followUp")[0]?.content).toBe(friendlyError(err));
    expect(isEphemeral(click.payloads("followUp")[0]?.flags)).toBe(true);
    // The shared panel never shows a frame: its one edit is Capture cooling down.
    expect(h.chan.editsTo("cam-1")).toHaveLength(1);
    expect(h.chan.editsTo("cam-1")[0]).not.toContain("attachment://");
    expect(rowButton(h.chan.editsTo("cam-1")[0], "Gate Cam").disabled).toBe(true);
    expect(h.log.messages("error")).toEqual([]);
  });

  it("tells the member to leave the game when the server refuses a capture with player_online", async () => {
    const h = makeHarness(postedState({ config: makeConfig({ loggingChannelId: "log-chan" }) }), {
      existingMessages: POSTED_MESSAGES,
    });
    await h.start();
    h.core.failWith(
      "getCameraFrame",
      new CameraUnavailableError("server error: player_online", { reason: "playerOnline" }),
    );
    const click = makeGatewayInteraction({
      customId: h.id("camera", "capture", SERVER_ID, CAMERA_ID),
      roles: ["USER"],
    });

    await h.adapter.onInteraction(click.interaction);
    await flush();

    expect(click.payloads("followUp")[0]?.content).toBe(CAMERA_PLAYER_ONLINE_MESSAGE);
    expect(h.chan.lines().some((l) => l.endsWith("failed: player is in-game"))).toBe(true);
    expect(h.chan.lines().join("\n")).not.toContain("unexpected error");
  });

  it("a failed switch actuation releases the lock at the server-reported state", async () => {
    const h = makeHarness(deviceState());
    h.core.failWith("toggleEntity", namedError("ConnectionError"));
    h.core.entityValue = true; // what the server still reports
    const click = makeClick(h.id("switch", "off", SERVER_ID, SWITCH_ID), { roles: ["USER"] });

    await h.adapter.dispatch(click.interaction);

    expect(
      h.adapter.stateLockMachine.snapshot({ serverId: SERVER_ID, entityId: SWITCH_ID }),
    ).toEqual({ phase: "synced", value: true, buttonsDisabled: false });
    // The lock's confirmation timeout is disarmed, so no late warning fires.
    expect(h.timers.pendingMs()).not.toContain(h.core.stateLockTimeoutMs);
    expect(click.order()).toEqual(["deferUpdate", "replyEphemeral"]);
  });

  it("a failed actuation with the server unreachable restores the prior state, not a guess", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    h.core.entityValue = true; // seeded ON by the startup reconcile
    await h.start();
    const key = { serverId: SERVER_ID, entityId: SWITCH_ID };
    expect(h.adapter.stateLockMachine.snapshot(key)?.value).toBe(true);
    // The server went away: neither the toggle nor the follow-up read answers.
    h.core.failWith("toggleEntity", namedError("ConnectionError"));
    h.core.failWith("getEntity", namedError("ConnectionError"));
    const click = makeClick(h.id("switch", "off", SERVER_ID, SWITCH_ID), { roles: ["USER"] });

    await h.adapter.dispatch(click.interaction);

    // Still ON — the last thing the server confirmed — not an invented OFF.
    expect(h.adapter.stateLockMachine.snapshot(key)).toEqual({
      phase: "synced",
      value: true,
      buttonsDisabled: false,
    });
    expect(h.chan.editsTo("sw-1").at(-1)).toContain("Front Door** · 🟢 On");
    expect(h.timers.pendingMs()).not.toContain(h.core.stateLockTimeoutMs);
    expect(click.order()).toEqual(["deferUpdate", "replyEphemeral"]);
  });

  it.each<[string, string, string[]]>([
    ["severity", "setAlarmPushoverSeverity", ["high"]],
    ["notify", "setAlarmNotificationLevel", ["everyone"]],
  ])(
    "an alarm:%s failure in bot-core produces exactly one friendly ephemeral reply",
    async (action, method, values) => {
      const h = makeHarness(deviceState());
      const err = namedError("StateError");
      h.core.failWith(method, err);
      const select = makeGatewayInteraction({
        kind: "stringSelect",
        customId: h.id("alarm", action, SERVER_ID, ALARM_ID),
        roles: ["ADMIN"],
        values,
      });

      await h.adapter.onInteraction(select.interaction);

      expect(select.order()).toEqual(["reply"]);
      const reply = select.payloads("reply")[0];
      expect(reply?.content).toBe(friendlyError(err));
      expect(reply?.content).not.toContain(err.message);
      expect(isEphemeral(reply?.flags)).toBe(true);
      expect(h.log.messages("warn")).toEqual(["alarm action failed"]);
      // No double acknowledgement (the strict fake would throw, and be logged).
      expect(h.log.messages("error")).toEqual([]);
    },
  );

  it("an alarm removal that fails in bot-core is reported instead of failing silently", async () => {
    const h = makeHarness(deviceState());
    const err = namedError("ConnectionError");
    h.core.failWith("removeEntity", err);
    const click = makeGatewayInteraction({
      customId: h.id("alarm", "remove-confirm", SERVER_ID, ALARM_ID),
      roles: ["ADMIN"],
    });

    await h.adapter.onInteraction(click.interaction);

    expect(click.order()).toEqual(["reply"]);
    expect(click.payloads("reply")[0]?.content).toBe(friendlyError(err));
    expect(h.log.messages("error")).toEqual([]);
  });

  it("an alarm failure whose reply cannot be delivered is logged, not thrown", async () => {
    const h = makeHarness(deviceState());
    h.core.failWith("setAlarmPushoverSeverity", namedError("StateError"));
    const select = makeClick(h.id("alarm", "severity", SERVER_ID, ALARM_ID), {
      roles: ["ADMIN"],
      kind: "stringSelect",
      values: ["high"],
      failReplyWith: namedError("DiscordAPIError", "Unknown interaction"),
    });

    const outcome = await h.adapter.dispatch(select.interaction);

    expect(outcome).toMatchObject({ handled: true, allowed: true });
    expect(h.log.messages("warn")).toEqual(["alarm action failed", "error reply failed"]);
    expect(h.log.messages("error")).toEqual([]);
  });

  it("never rejects out of the gateway listener when a denial reply fails", async () => {
    const h = makeHarness(deviceState());
    const click = makeGatewayInteraction({
      customId: h.id("setup", "addDevice"),
      roles: ["USER"],
      failReplyWith: namedError("DiscordAPIError", "Unknown interaction"),
    });

    await expect(h.adapter.onInteraction(click.interaction)).resolves.toBeUndefined();

    expect(h.log.messages("error")).toEqual(["interaction handling failed"]);
    expect(h.core.calls).toEqual([]);
  });

  it("never rejects out of the gateway listener when a slash reply fails", async () => {
    const h = makeHarness(deviceState());
    const slash = makeGatewayInteraction({
      kind: "chatInput",
      subcommand: "status",
      roles: ["USER"],
      failReplyWith: namedError("DiscordAPIError", "Unknown interaction"),
    });

    await expect(h.adapter.onInteraction(slash.interaction)).resolves.toBeUndefined();

    expect(h.log.messages("error")).toEqual(["interaction handling failed"]);
  });
});

// ── acknowledgement safety through the discord.js bridge ─────────────────────

describe("dispatcher: acknowledgement safety", () => {
  interface AckCase {
    name: string;
    domain: CustomIdDomain;
    action: string;
    entityId?: number;
    scoped?: boolean;
    role: string;
    kind?: ClickKind;
    values?: string[];
    /** A "Manage…" select: its value is this device's handle. */
    manage?: number;
    expected: string[];
  }

  const cases: AckCase[] = [
    {
      name: "switch:on",
      domain: "switch",
      action: "on",
      entityId: SWITCH_ID,
      role: "USER",
      expected: ["deferUpdate"],
    },
    {
      name: "switch:settings",
      domain: "switch",
      action: "settings",
      entityId: SWITCH_ID,
      role: "ADMIN",
      expected: ["reply"],
    },
    {
      name: "switch:auto",
      domain: "switch",
      action: "auto",
      entityId: SWITCH_ID,
      role: "ADMIN",
      kind: "stringSelect",
      values: ["off"],
      expected: ["deferUpdate", "editReply"],
    },
    {
      name: "switch:delay",
      domain: "switch",
      action: "delay",
      entityId: SWITCH_ID,
      role: "ADMIN",
      expected: ["showModal"],
    },
    {
      name: "switch:remove",
      domain: "switch",
      action: "remove",
      entityId: SWITCH_ID,
      role: "ADMIN",
      expected: ["update"],
    },
    {
      name: "alarm:severity",
      domain: "alarm",
      action: "severity",
      entityId: ALARM_ID,
      role: "ADMIN",
      kind: "stringSelect",
      values: ["off"],
      expected: ["update"],
    },
    {
      name: "switch:refresh",
      domain: "switch",
      action: "refresh",
      entityId: SWITCH_ID,
      role: "USER",
      expected: ["deferUpdate"],
    },
    ...(
      [
        ["switch", SWITCH_ID, "ADMIN"],
        ["alarm", ALARM_ID, "ADMIN"],
        ["monitor", MONITOR_ID, "USER"],
        ["camera", CAMERA_ID, "ADMIN"],
      ] as const
    ).map(([domain, entityId, role]): AckCase => ({
      name: `${domain}:manage`,
      domain,
      action: "manage",
      scoped: true,
      role,
      kind: "stringSelect",
      manage: entityId,
      expected: ["reply"],
    })),
    {
      name: "monitor:watch",
      domain: "monitor",
      action: "watch",
      entityId: MONITOR_ID,
      role: "USER",
      expected: ["update"],
    },
    {
      name: "monitor:refresh",
      domain: "monitor",
      action: "refresh",
      entityId: MONITOR_ID,
      role: "USER",
      expected: ["deferUpdate", "editReply"],
    },
    {
      name: "monitor:contents",
      domain: "monitor",
      action: "contents",
      entityId: MONITOR_ID,
      role: "USER",
      expected: ["reply"],
    },
    {
      name: "monitor:name",
      domain: "monitor",
      action: "name",
      entityId: MONITOR_ID,
      role: "ADMIN",
      expected: ["showModal"],
    },
    {
      name: "monitor:remove",
      domain: "monitor",
      action: "remove",
      entityId: MONITOR_ID,
      role: "ADMIN",
      expected: ["update"],
    },
    {
      name: "camera:capture",
      domain: "camera",
      action: "capture",
      entityId: CAMERA_ID,
      role: "USER",
      expected: ["deferUpdate", "followUp"],
    },
    {
      name: "camera:name",
      domain: "camera",
      action: "name",
      entityId: CAMERA_ID,
      role: "ADMIN",
      expected: ["showModal"],
    },
    {
      name: "camera:remove",
      domain: "camera",
      action: "remove",
      entityId: CAMERA_ID,
      role: "ADMIN",
      expected: ["update"],
    },
    {
      name: "server:refresh",
      domain: "server",
      action: "refresh",
      scoped: true,
      role: "USER",
      expected: ["deferUpdate"],
    },
    {
      name: "setup:adminRoles",
      domain: "setup",
      action: "adminRoles",
      role: "ADMIN",
      kind: "roleSelect",
      values: ["R1"],
      expected: ["reply"],
    },
    {
      name: "setup:channel",
      domain: "setup",
      action: "channel",
      role: "ADMIN",
      kind: "channelSelect",
      values: ["chan-2"],
      expected: ["update"],
    },
    {
      name: "setup:pushover",
      domain: "setup",
      action: "pushover",
      role: "ADMIN",
      expected: ["showModal"],
    },
    {
      name: "pairing:cancel",
      domain: "pairing",
      action: "cancel",
      role: "ADMIN",
      expected: ["update"],
    },
    {
      name: "setup:startOnLogin",
      domain: "setup",
      action: "startOnLogin",
      role: "ADMIN",
      expected: ["update"],
    },
  ];

  it.each(cases)("$name acknowledges exactly once ($expected)", async (c) => {
    const h = makeHarness(deviceState());
    const serverId = c.entityId !== undefined || c.scoped ? SERVER_ID : undefined;
    const click = makeGatewayInteraction({
      kind: c.kind ?? "button",
      customId: h.id(c.domain, c.action, serverId, c.entityId),
      roles: [c.role],
      values:
        c.manage === undefined
          ? c.values
          : [h.adapter.handleRegistry.register(HandleRegistry.entityKey(SERVER_ID, c.manage))],
    });

    await h.adapter.onInteraction(click.interaction);

    expect(click.order()).toEqual(c.expected);
    // The strict fake throws on a double ack; a swallowed one would be logged.
    expect(h.log.messages("error")).toEqual([]);
    expect(h.log.messages("warn")).toEqual([]);
  });

  it("switch:auto is acknowledged even when setSwitchAutoAction never resolves", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    h.core.setSwitchAutoAction = () => new Promise<undefined>(() => {});
    const select = makeGatewayInteraction({
      kind: "stringSelect",
      customId: h.id("switch", "auto", SERVER_ID, SWITCH_ID),
      roles: ["ADMIN"],
      values: ["off"],
    });

    // Never settles: the handler is stuck on the bot-core call.
    void h.adapter.onInteraction(select.interaction);
    await flush();

    expect(select.order()).toEqual(["deferUpdate"]);
  });

  it("switch:auto persists, repaints the panel, then edits the menu through editReply", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const select = makeGatewayInteraction({
      kind: "stringSelect",
      customId: h.id("switch", "auto", SERVER_ID, SWITCH_ID),
      roles: ["ADMIN"],
      values: ["off"],
    });

    await h.adapter.onInteraction(select.interaction);

    expect(h.core.callsTo("setSwitchAutoAction")).toEqual([[SERVER_ID, SWITCH_ID, "off"]]);
    expect(h.chan.editsTo("sw-1")).toHaveLength(1);
    expect(select.order()).toEqual(["deferUpdate", "editReply"]);
    const menu = select.payloads("editReply")[0];
    expect(menu?.components).toHaveLength(1);
    expect((menu?.flags ?? 0) & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
    expect(h.log.messages("error")).toEqual([]);
  });

  it("a switch:auto failure after the acknowledgement produces exactly one follow-up", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const err = namedError("StateError");
    h.core.failWith("setSwitchAutoAction", err);
    const select = makeGatewayInteraction({
      kind: "stringSelect",
      customId: h.id("switch", "auto", SERVER_ID, SWITCH_ID),
      roles: ["ADMIN"],
      values: ["on"],
    });

    await h.adapter.onInteraction(select.interaction);

    expect(select.order()).toEqual(["deferUpdate", "followUp"]);
    const followUp = select.payloads("followUp")[0];
    expect(followUp?.content).toBe(friendlyError(err));
    expect(isEphemeral(followUp?.flags)).toBe(true);
    expect(h.chan.edits).toEqual([]);
  });

  it("a second click while the switch is pending is acknowledged but not actuated", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const first = makeGatewayInteraction({
      customId: h.id("switch", "on", SERVER_ID, SWITCH_ID),
      roles: ["USER"],
    });
    // Lands before the disabled-button edit reached the member's client — and
    // asks for the opposite value.
    const second = makeGatewayInteraction({
      customId: h.id("switch", "off", SERVER_ID, SWITCH_ID),
      roles: ["USER"],
    });

    await h.adapter.onInteraction(first.interaction);
    h.chan.reset();
    await h.adapter.onInteraction(second.interaction);

    // Exactly one actuation — the first — and both clicks acknowledged once.
    expect(h.core.callsTo("toggleEntity")).toEqual([[SERVER_ID, SWITCH_ID, true]]);
    expect(first.order()).toEqual(["deferUpdate"]);
    expect(second.order()).toEqual(["deferUpdate"]);
    // The ignored click neither repaints the panel nor re-arms the lock.
    expect(h.chan.edits).toEqual([]);
    expect(h.timers.pendingMs().filter((ms) => ms === h.core.stateLockTimeoutMs)).toHaveLength(1);
    expect(h.log.messages("error")).toEqual([]);
  });

  it("two overlapping clicks on the same switch actuate once", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const clicks = [0, 1].map(() =>
      makeGatewayInteraction({
        customId: h.id("switch", "on", SERVER_ID, SWITCH_ID),
        roles: ["USER"],
      }),
    );

    // Neither handler has finished when the other starts.
    await Promise.all(clicks.map((c) => h.adapter.onInteraction(c.interaction)));

    expect(h.core.callsTo("toggleEntity")).toEqual([[SERVER_ID, SWITCH_ID, true]]);
    for (const c of clicks) expect(c.order()).toEqual(["deferUpdate"]);
  });

  it("a click after the confirming broadcast actuates again", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const on = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["USER"] });
    await h.adapter.dispatch(on.interaction);
    h.core.emit("entityChanged", {
      serverId: SERVER_ID,
      change: { entityId: SWITCH_ID, value: true },
    });
    await flush();

    const off = makeClick(h.id("switch", "off", SERVER_ID, SWITCH_ID), { roles: ["USER"] });
    await h.adapter.dispatch(off.interaction);

    expect(h.core.callsTo("toggleEntity")).toEqual([
      [SERVER_ID, SWITCH_ID, true],
      [SERVER_ID, SWITCH_ID, false],
    ]);
  });

  it("sends a settings menu as an ephemeral Components V2 reply", async () => {
    const h = makeHarness(deviceState());
    const click = makeGatewayInteraction({
      customId: h.id("alarm", "settings", SERVER_ID, ALARM_ID),
      roles: ["ADMIN"],
    });

    await h.adapter.onInteraction(click.interaction);

    expect(click.order()).toEqual(["reply"]);
    const reply = click.payloads("reply")[0];
    expect(reply?.components).toHaveLength(1);
    expect(reply?.content).toBeUndefined();
    expect(isEphemeral(reply?.flags)).toBe(true);
    expect((reply?.flags ?? 0) & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
  });

  it("auto-dismisses the ephemeral pairing panel exactly once when the device pairs", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const addDevice = makeGatewayInteraction({
      customId: h.id("setup", "addDevice"),
      roles: ["ADMIN"],
    });
    await h.adapter.onInteraction(addDevice.interaction);
    expect(addDevice.order()).toEqual(["reply"]);
    expect(h.core.callsTo("beginPairing")).toHaveLength(1);

    const paired = makeEntity(42, "switch", { label: "New Switch" });
    h.state.entities.push(paired);
    h.core.emit("entityPaired", paired);
    await flush();
    expect(addDevice.order()).toEqual(["reply", "deleteReply"]);

    // A later pairing has no stashed panel left to dismiss.
    h.core.emit("entityPaired", paired);
    await flush();
    expect(addDevice.order()).toEqual(["reply", "deleteReply"]);
  });

  it("drops the pairing panel handle on cancel so a later pairing does not delete it", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const addDevice = makeGatewayInteraction({
      customId: h.id("setup", "addDevice"),
      roles: ["ADMIN"],
    });
    await h.adapter.onInteraction(addDevice.interaction);
    const cancel = makeGatewayInteraction({
      customId: h.id("pairing", "cancel"),
      roles: ["ADMIN"],
    });
    await h.adapter.onInteraction(cancel.interaction);
    expect(cancel.order()).toEqual(["update"]);
    expect(h.core.callsTo("cancelPairing")).toHaveLength(1);

    const paired = makeEntity(42, "switch", { label: "New Switch" });
    h.state.entities.push(paired);
    h.core.emit("entityPaired", paired);
    await flush();

    expect(addDevice.order()).toEqual(["reply"]);
  });
});

// ── domain events → panels ───────────────────────────────────────────────────

describe("adapter: bot-core domain events fan into panel updates", () => {
  async function startedHarness(overrides: Partial<CoreState> = {}) {
    const h = makeHarness(postedState(overrides), { existingMessages: POSTED_MESSAGES });
    await h.start();
    return h;
  }
  const lockKey = { serverId: SERVER_ID, entityId: SWITCH_ID };

  it("entityChanged closes a pending switch lock and repaints the panel with the confirmed state", async () => {
    const h = await startedHarness();
    const click = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["USER"] });
    await h.adapter.dispatch(click.interaction);
    expect(h.adapter.stateLockMachine.snapshot(lockKey)?.phase).toBe("pending");
    expect(h.chan.editsTo("sw-1").at(-1)).toContain("Switching");
    h.chan.reset();

    h.core.emit("entityChanged", {
      serverId: SERVER_ID,
      change: { entityId: SWITCH_ID, value: true },
    });
    await h.settle();

    expect(h.adapter.stateLockMachine.snapshot(lockKey)).toEqual({
      phase: "synced",
      value: true,
      buttonsDisabled: false,
    });
    expect(h.chan.editsTo("sw-1")).toHaveLength(1);
    expect(h.chan.editsTo("sw-1")[0]).toContain("Front Door** · 🟢 On");
    expect(h.timers.pendingMs()).not.toContain(h.core.stateLockTimeoutMs);
  });

  // After a reconnect, bot-core re-reads every device; a switch that
  // flipped while the server was down must stop showing its old state.
  it("entityRefreshed re-seeds the switch lock and repaints a changed switch, without an audit line", async () => {
    const h = await startedHarness({ config: makeConfig({ loggingChannelId: "log-chan" }) });
    expect(h.adapter.stateLockMachine.snapshot(lockKey)?.value).toBe(false);
    h.chan.reset();

    h.core.emit("entityRefreshed", {
      serverId: SERVER_ID,
      entityId: SWITCH_ID,
      info: { entityId: SWITCH_ID, type: "switch", value: true, items: [] },
    });
    await h.settle();

    expect(h.adapter.stateLockMachine.snapshot(lockKey)).toEqual({
      phase: "synced",
      value: true,
      buttonsDisabled: false,
    });
    expect(h.chan.editsTo("sw-1")).toHaveLength(1);
    expect(h.chan.editsTo("sw-1")[0]).toContain("Front Door** · 🟢 On");
    // A refresh is not a change: nothing goes to the logging channel.
    expect(h.chan.sent).toEqual([]);
  });

  it("entityRefreshed with the value already shown repaints nothing", async () => {
    const h = await startedHarness();
    h.chan.reset();

    h.core.emit("entityRefreshed", {
      serverId: SERVER_ID,
      entityId: SWITCH_ID,
      info: { entityId: SWITCH_ID, type: "switch", value: false, items: [] },
    });
    await h.settle();

    expect(h.chan.edits).toEqual([]);
  });

  it("entityChanged for an entity it does not know edits and posts nothing", async () => {
    const h = await startedHarness();

    h.core.emit("entityChanged", { serverId: SERVER_ID, change: { entityId: 999, value: true } });
    await h.settle();

    expect(h.chan.edits).toEqual([]);
    expect(h.chan.sent).toEqual([]);
  });

  // Live test 2026-11-16: a tool cupboard holding wood, metal and more
  // showed "0/0 slots · Empty"; the panel was never given the contents.
  describe("storage monitor contents", () => {
    const TC = {
      entityId: MONITOR_ID,
      type: "storageMonitor",
      capacity: 24,
      hasProtection: true,
      protectionExpiry: 1_800_000_000,
      items: [
        { itemId: -151838493, quantity: 451, itemIsBlueprint: false },
        { itemId: 69511070, quantity: 100, itemIsBlueprint: false },
        { itemId: -151838493, quantity: 49, itemIsBlueprint: false },
      ],
    };

    it("Refresh reads the monitor, repaints its row and updates its settings", async () => {
      const h = await startedHarness();
      h.core.infoFor.set(MONITOR_ID, TC);
      const click = makeClick(h.id("monitor", "refresh", SERVER_ID, MONITOR_ID), {
        roles: ["USER"],
      });

      await h.adapter.dispatch(click.interaction);
      await h.settle();

      expect(click.order()).toEqual(["deferUpdate", "editReply"]);
      expect(h.core.callsTo("getEntity")).toEqual([[SERVER_ID, MONITOR_ID]]);
      const panel = h.chan.editsTo("st-1").at(-1);
      expect(panel).toContain("3/24 slots");
      expect(panel).toContain("Wood ×500 · Metal Fragments ×100");
      expect(panel).toContain("upkeep ends <t:1800000000:R>");
      expect(JSON.stringify(click.payloads("editReply")[0])).toContain(
        "protected until <t:1800000000:f>",
      );
    });

    it("a failed Refresh is reported to the member after the acknowledgement", async () => {
      const h = await startedHarness();
      h.core.failWith("getEntity", namedError("ConnectionError"));
      const click = makeClick(h.id("monitor", "refresh", SERVER_ID, MONITOR_ID), {
        roles: ["USER"],
      });

      await h.adapter.dispatch(click.interaction);

      // replyEphemeral follows up once the click has been deferred.
      expect(click.order()).toEqual(["deferUpdate", "replyEphemeral"]);
      expect(h.log.messages("warn")).toContain("monitor action failed");
      expect(click.texts()).toEqual([friendlyError(namedError("ConnectionError"))]);
    });

    it("a reconnect's entityRefreshed repaints the monitor with its contents", async () => {
      const h = await startedHarness();

      h.core.emit("entityRefreshed", { serverId: SERVER_ID, entityId: MONITOR_ID, info: TC });
      await h.settle();

      expect(h.chan.editsTo("st-1").at(-1)).toContain("Wood ×500");
    });

    it("Watch decides whether a change posts a line to the logging channel", async () => {
      const h = await startedHarness({ config: makeConfig({ loggingChannelId: "log-chan" }) });
      const monitor = h.state.entities.find((e) => e.entityId === MONITOR_ID)!;

      monitor.watchChanges = false;
      h.core.emit("entityChanged", { serverId: SERVER_ID, change: TC });
      await h.settle();
      expect(h.chan.lines()).toEqual([]);

      monitor.watchChanges = true;
      h.core.emit("entityChanged", { serverId: SERVER_ID, change: TC });
      await h.settle();
      expect(h.chan.lines()).toEqual([expect.stringContaining("contents changed")]);
    });

    it("a monitor on a plain box (no upkeep expiry) shows no upkeep line", async () => {
      const h = await startedHarness();
      const box = { ...TC, capacity: 48, hasProtection: false, protectionExpiry: 0 };

      h.core.emit("entityRefreshed", { serverId: SERVER_ID, entityId: MONITOR_ID, info: box });
      await h.settle();

      const panel = h.chan.editsTo("st-1").at(-1);
      expect(panel).toContain("3/48 slots");
      expect(panel).not.toContain("upkeep");
    });

    it("an unwatched box's change is kept, and shown by the next repaint", async () => {
      const h = await startedHarness();
      const monitor = h.state.entities.find((e) => e.entityId === MONITOR_ID)!;
      monitor.watchChanges = false;
      const box = { ...TC, capacity: 48, hasProtection: false, protectionExpiry: 0 };

      h.core.emit("entityChanged", { serverId: SERVER_ID, change: box });
      await h.settle();
      expect(h.chan.editsTo("st-1")).toEqual([]);

      h.core.emit("entityRefreshed", { serverId: SERVER_ID, entityId: MONITOR_ID, info: box });
      await h.settle();
      expect(h.chan.editsTo("st-1").at(-1)).toContain("3/48 slots");
    });

    describe("an unwatched tool cupboard", () => {
      /** A started harness whose clock the test moves, with the monitor unwatched. */
      async function tcHarness() {
        let clock = FIXED_NOW.getTime();
        const h = makeHarness(
          postedState({ config: makeConfig({ loggingChannelId: "log-chan" }) }),
          { existingMessages: POSTED_MESSAGES, now: () => new Date(clock) },
        );
        await h.start();
        h.state.entities.find((e) => e.entityId === MONITOR_ID)!.watchChanges = false;
        return {
          h,
          nowSeconds: () => Math.floor(clock / 1000),
          advance: (ms: number) => {
            clock += ms;
          },
        };
      }

      /** The cupboard, its upkeep running out at `expiry` (Unix seconds), holding `wood`. */
      const tcFor = (expiry: number, wood = 451) => ({
        ...TC,
        protectionExpiry: expiry,
        items: [{ itemId: -151838493, quantity: wood, itemIsBlueprint: false }],
      });

      /** The cupboard as first read (pairing, reconnect), then a clean channel. */
      async function seed(h: Awaited<ReturnType<typeof tcHarness>>["h"], info: typeof TC) {
        h.core.emit("entityRefreshed", { serverId: SERVER_ID, entityId: MONITOR_ID, info });
        await h.settle();
        h.chan.reset();
      }

      /**
       * The cupboard broadcasts `broadcast`, and a direct read then finds
       * `read`: its broadcasts carry new contents but the upkeep from before.
       */
      async function change(
        h: Awaited<ReturnType<typeof tcHarness>>["h"],
        broadcast: typeof TC,
        read: typeof TC,
      ): Promise<void> {
        h.core.infoFor.set(MONITOR_ID, read);
        h.core.emit("entityChanged", { serverId: SERVER_ID, change: broadcast });
        await h.settle();
        h.timers.fire(2_000);
        await h.settle();
      }

      it("repaints its upkeep at most every 15 minutes, and logs nothing", async () => {
        const { h, nowSeconds, advance } = await tcHarness();
        const expiry = nowSeconds() + 86_400;
        await seed(h, tcFor(expiry));

        // An upkeep payment five minutes on: less wood, the expiry nudged.
        advance(5 * 60_000);
        await change(h, tcFor(expiry, 400), tcFor(expiry + 30, 400));
        expect(h.chan.editsTo("st-1")).toEqual([]);

        // The first payment once 15 minutes have passed repaints the row.
        advance(10 * 60_000);
        await change(h, tcFor(expiry, 350), tcFor(expiry + 60, 350));
        expect(h.chan.editsTo("st-1")).toHaveLength(1);
        expect(h.chan.editsTo("st-1")[0]).toContain(`upkeep ends <t:${expiry + 60}:R>`);
        expect(h.chan.editsTo("st-1")[0]).toContain("Wood ×350");
        expect(h.chan.lines()).toEqual([]);
      });

      // Seen live: emptying a cupboard broadcast its empty contents with the
      // expiry from before; only a direct read showed it decaying.
      it("takes its upkeep from a direct read, not from its broadcast", async () => {
        const { h, nowSeconds } = await tcHarness();
        const expiry = nowSeconds() + 600;
        await seed(h, tcFor(expiry));
        const emptied = { ...TC, items: [] };

        h.core.infoFor.set(MONITOR_ID, { ...emptied, protectionExpiry: 0 });
        h.core.emit("entityChanged", {
          serverId: SERVER_ID,
          change: { ...emptied, protectionExpiry: expiry },
        });
        await h.settle();
        expect(h.chan.editsTo("st-1")).toEqual([]);
        expect(h.core.callsTo("getEntity")).toEqual([]);

        h.timers.fire(2_000);
        await h.settle();
        expect(h.core.callsTo("getEntity")).toEqual([[SERVER_ID, MONITOR_ID]]);
        expect(h.chan.editsTo("st-1").at(-1)).toContain("no upkeep: decaying");
        expect(h.chan.lines()).toEqual([]);
        expect(h.log.fields("info", "storage monitor upkeep changed").at(-1)).toMatchObject({
          upkeep: "decaying",
          was: "protected",
          hasProtection: true,
        });
      });

      it("keeps the upkeep it last read when a broadcast claims otherwise", async () => {
        const { h, nowSeconds } = await tcHarness();
        const expiry = nowSeconds() + 600;
        await seed(h, { ...TC, items: [], protectionExpiry: 0 });

        // Refilled: the broadcast still says spent; the read says protected.
        await change(h, { ...TC, protectionExpiry: 0 }, tcFor(expiry));
        expect(h.chan.editsTo("st-1").at(-1)).toContain(`upkeep ends <t:${expiry}:R>`);
        expect(h.log.fields("info", "storage monitor upkeep changed")).toHaveLength(2);
      });

      it("reads it once for a burst of broadcasts", async () => {
        const { h, nowSeconds } = await tcHarness();
        const expiry = nowSeconds() + 600;
        await seed(h, tcFor(expiry));

        h.core.infoFor.set(MONITOR_ID, tcFor(expiry, 100));
        h.core.emit("entityChanged", { serverId: SERVER_ID, change: tcFor(expiry, 300) });
        await h.settle();
        h.core.emit("entityChanged", { serverId: SERVER_ID, change: tcFor(expiry, 100) });
        await h.settle();
        h.timers.fire(2_000);
        await h.settle();

        expect(h.core.callsTo("getEntity")).toEqual([[SERVER_ID, MONITOR_ID]]);
      });

      it("a watched one logs each change and repaints with the upkeep it reads", async () => {
        const { h, nowSeconds } = await tcHarness();
        h.state.entities.find((e) => e.entityId === MONITOR_ID)!.watchChanges = true;
        const expiry = nowSeconds() + 600;
        await seed(h, tcFor(expiry));

        await change(h, { ...tcFor(expiry), items: [] }, { ...TC, items: [], protectionExpiry: 0 });

        expect(h.chan.lines()).toEqual([expect.stringContaining("contents changed")]);
        expect(h.chan.editsTo("st-1").at(-1)).toContain("no upkeep: decaying");
      });

      it("is read again once its upkeep runs out, even if it never broadcasts", async () => {
        const { h, nowSeconds } = await tcHarness();
        h.core.emit("entityRefreshed", {
          serverId: SERVER_ID,
          entityId: MONITOR_ID,
          info: tcFor(nowSeconds() + 3_600),
        });
        await h.settle();
        h.chan.reset();
        const recheckMs = 3_600_000 + 60_000;
        expect(h.timers.pendingMs()).toContain(recheckMs);

        h.core.infoFor.set(MONITOR_ID, { ...TC, items: [], protectionExpiry: 0 });
        h.timers.fire(recheckMs);
        await h.settle();

        expect(h.core.callsTo("getEntity")).toEqual([[SERVER_ID, MONITOR_ID]]);
        expect(h.chan.editsTo("st-1").at(-1)).toContain("no upkeep: decaying");
        // Spent, it has no expiry to wait for.
        expect(h.timers.pendingMs()).not.toContain(recheckMs);
      });

      it("moves its re-read when the expiry moves, and drops it when removed", async () => {
        const { h, nowSeconds } = await tcHarness();
        const info = tcFor(nowSeconds() + 3_600);
        h.core.emit("entityRefreshed", { serverId: SERVER_ID, entityId: MONITOR_ID, info });
        await h.settle();

        // Refilled: once read, the re-read moves to the new expiry.
        await change(h, info, tcFor(nowSeconds() + 7_200));
        expect(h.timers.pendingMs()).not.toContain(3_600_000 + 60_000);
        expect(h.timers.pendingMs()).toContain(7_200_000 + 60_000);

        h.core.emit("entityRemoved", { serverId: SERVER_ID, entityId: MONITOR_ID });
        await h.settle();
        expect(h.timers.pendingMs()).not.toContain(7_200_000 + 60_000);
      });
    });

    it("a monitor that answers not_found at pairing is asked once more", async () => {
      const h = await startedHarness();
      const paired = makeEntity(77, "storageMonitor", { label: "New TC" });
      h.state.entities.push(paired);
      h.core.failWith("registerEntityInterest", namedError("EntityNotFoundError"));

      h.core.emit("entityPaired", paired);
      await h.settle();
      expect(h.core.callsTo("registerEntityInterest")).toEqual([[SERVER_ID, 77]]);

      h.timers.fire(5_000);
      await h.settle();
      expect(h.core.callsTo("registerEntityInterest")).toEqual([
        [SERVER_ID, 77],
        [SERVER_ID, 77],
      ]);
    });
  });

  it("entityChanged repaints a storage monitor only while it is being watched", async () => {
    const h = await startedHarness();
    const change = {
      serverId: SERVER_ID,
      change: { entityId: MONITOR_ID, capacity: 24, items: [{ itemId: 69511070, quantity: 1 }] },
    };

    h.core.emit("entityChanged", change);
    await h.settle();
    expect(h.chan.editsTo("st-1")).toHaveLength(1);

    const monitor = h.state.entities.find((e) => e.entityId === MONITOR_ID);
    if (monitor) monitor.watchChanges = false;
    h.chan.reset();
    h.core.emit("entityChanged", change);
    await h.settle();
    expect(h.chan.edits).toEqual([]);
  });

  it("serverStatusChanged → connected fetches live status into the Server message", async () => {
    const h = await startedHarness({ connected: [] });

    h.core.setServerStatus(SERVER_ID, { status: "connected" });
    await h.settle();

    expect(h.core.callsTo("getServerInfo")).toEqual([[SERVER_ID]]);
    const last = h.chan.editsTo("server-1").at(-1);
    expect(last).toContain("🟢 Online");
    expect(last).toContain("12/100 players · queue 3");
  });

  it("serverStatusChanged → offline paints every message offline without querying the server", async () => {
    const h = await startedHarness();

    h.core.setServerStatus(SERVER_ID, { status: "offline", lastSeenAt: FIXED_NOW.getTime() });
    await h.settle();

    expect(h.core.calls).toEqual([]);
    expect(h.chan.editsTo("server-1")).toHaveLength(1);
    expect(h.chan.editsTo("server-1")[0]).toContain("🔴 Offline");
    // Every message turns red, and its actions are disabled.
    for (const id of POSTED_MESSAGES) {
      expect(h.chan.editsTo(id).at(-1)).toContain(`"accent_color":${0xf23f43}`);
    }
  });

  it("entityRemoved of a type's last device deletes that message and keeps the rest in place", async () => {
    const h = await startedHarness();
    // bot-core drops the entity before emitting.
    h.state.entities = h.state.entities.filter((e) => e.entityId !== SWITCH_ID);

    h.core.emit("entityRemoved", { serverId: SERVER_ID, entityId: SWITCH_ID });
    await h.settle();

    expect(h.chan.deleted).toEqual(["sw-1"]);
    expect(h.chan.sent).toEqual([]);
    const { switches: _gone, ...rest } = POSTED_IDS;
    expect(h.store.callsTo("setServerPanelIds")).toEqual([[SERVER_ID, rest]]);
  });

  it("entityRemoved of one of several switches edits the Switches message", async () => {
    const h = await startedHarness({
      entities: [...postedState().entities, makeEntity(11, "switch", { label: "Back Door" })],
    });
    h.state.entities = h.state.entities.filter((e) => e.entityId !== 11);

    h.core.emit("entityRemoved", { serverId: SERVER_ID, entityId: 11 });
    await h.settle();

    expect(h.chan.deleted).toEqual([]);
    expect(h.chan.sent).toEqual([]);
    expect(h.chan.editsTo("sw-1").at(-1)).not.toContain("Back Door");
    expect(h.store.callsTo("setServerPanelIds")).toEqual([]);
  });

  // Live test 2026-11-16: an in-game "Resend Pair" posted a second server panel.
  it("a re-pair edits the server's existing panel instead of posting another", async () => {
    const h = await startedHarness();
    const server = h.state.servers.find((s) => s.id === SERVER_ID)!;

    h.core.emit("serverPaired", server);
    await h.settle();

    expect(h.chan.sent).toEqual([]);
    // Still connected: the re-paired panel shows it live (no connect event follows).
    expect(h.chan.editsTo("server-1").at(-1)).toContain("🟢 Online");
    expect(h.store.callsTo("setServerPanelIds")).toEqual([]);
  });

  it("a re-pair whose Server message was deleted posts the whole group again", async () => {
    const h = await startedHarness();
    // bot-core emits the stored server, so the stored id is the one that is gone.
    const server = h.state.servers.find((s) => s.id === SERVER_ID)!;
    server.panelMessageIds = { ...POSTED_IDS, server: "gone" };

    h.core.emit("serverPaired", server);
    await h.settle();

    // The rest of the group is reposted with it, to keep the order.
    expect(h.chan.deleted).toEqual(["sw-1", "al-1", "st-1", "cam-1"]);
    expect(h.chan.sent).toHaveLength(5);
    const [first] = h.chan.sent.map((m) => m.id);
    expect(h.store.callsTo("setServerPanelIds")).toEqual([
      [SERVER_ID, expect.objectContaining({ server: first })],
    ]);
  });

  it("a failed status fetch says why instead of 'fetching status…'", async () => {
    const h = await startedHarness();
    h.core.failWith("getServerInfo", namedError("AuthError"));

    h.core.emit("serverStatusChanged", { serverId: SERVER_ID, status: "connected" });
    await h.settle();

    const last = h.chan.editsTo("server-1").at(-1);
    expect(last).toContain("Couldn't fetch status: the server rejected Conduit's credentials");
    expect(last).not.toContain("fetching status");
  });

  it("serverPaired posts an offline Server message and persists its message id", async () => {
    const h = await startedHarness();
    const paired = makeServer("srv-new", { name: "Fresh Wipe" });
    h.state.servers.push(paired);

    h.core.emit("serverPaired", paired);
    await h.settle();

    expect(h.chan.sent).toHaveLength(1);
    const posted = h.chan.sent[0];
    expect(heading(posted?.payload)).toBe("### Fresh Wipe");
    expect(JSON.stringify(posted?.payload)).toContain("🔴 Offline");
    expect(h.store.callsTo("setServerPanelIds")).toEqual([["srv-new", { server: posted?.id }]]);
  });

  it("entityPaired adds a switch's row to the Switches message, in alphabetical order", async () => {
    const h = await startedHarness();
    const paired = makeEntity(42, "switch", { label: "Alpha Switch" });
    h.state.entities.push(paired);

    h.core.emit("entityPaired", paired);
    await h.settle();

    // An edit in place: a type the server already has is never reposted.
    expect(h.chan.sent).toEqual([]);
    expect(h.chan.deleted).toEqual([]);
    const sw = h.chan.editsTo("sw-1").at(-1)!;
    expect(sw.indexOf("Alpha Switch")).toBeLessThan(sw.indexOf("Front Door"));
  });

  it("entityPaired registers interest in the new device and shows its real state", async () => {
    const h = await startedHarness();
    h.core.entityValue = true; // the server reports the new switch as ON
    const paired = makeEntity(42, "switch", { label: "Zulu Switch" });
    h.state.entities.push(paired);

    h.core.emit("entityPaired", paired);
    await h.settle();

    // Without the getEntityInfo behind registerEntityInterest the server never
    // broadcasts this device's changes.
    expect(h.core.callsTo("registerEntityInterest")).toEqual([[SERVER_ID, 42]]);
    expect(h.chan.editsTo("sw-1").at(-1)).toContain("Zulu Switch** · 🟢 On");
  });

  it("entityPaired registers interest for an alarm too, but never for a camera", async () => {
    const h = await startedHarness();
    const alarm = makeEntity(43, "alarm", { label: "New Alarm" });
    const camera = makeEntity(-44, "camera", { label: "New Cam", identifier: "CAM2" });
    h.state.entities.push(alarm, camera);

    h.core.emit("entityPaired", alarm);
    h.core.emit("entityPaired", camera);
    await h.settle();

    expect(h.core.callsTo("registerEntityInterest")).toEqual([[SERVER_ID, 43]]);
  });

  it("a newly paired switch the server cannot report on is shown as unknown, not off", async () => {
    const h = await startedHarness();
    h.core.failWith("registerEntityInterest", namedError("ConnectionError"));
    const paired = makeEntity(42, "switch", { label: "Zulu Switch" });
    h.state.entities.push(paired);

    h.core.emit("entityPaired", paired);
    await h.settle();

    const posted = h.chan.editsTo("sw-1").at(-1);
    expect(posted).toContain("Zulu Switch** · ⚪ Unknown");
    expect(posted).not.toContain("Zulu Switch** · 🔴 Off");
    expect(rowButton(posted, "Zulu Switch").label).toBe("Refresh");
    expect(
      h.adapter.stateLockMachine.snapshot({ serverId: SERVER_ID, entityId: 42 }),
    ).toBeUndefined();
    expect(h.log.messages("warn")).toContain("registerEntityInterest on pairing failed");
  });

  it("a timeout on a switch the server never reported leaves it unknown, not at the requested state", async () => {
    // The startup reconcile could not read the switch, so its lock is unseeded.
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    h.core.failWith("registerEntityInterest", namedError("ConnectionError"));
    await h.start();
    expect(h.adapter.stateLockMachine.snapshot(lockKey)).toBeUndefined();
    const click = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["USER"] });
    await h.adapter.dispatch(click.interaction);
    expect(h.chan.editsTo("sw-1").at(-1)).toContain("Switching");
    h.chan.reset();

    h.timers.fire(h.core.stateLockTimeoutMs);
    await h.settle();

    const settled = h.adapter.stateLockMachine.snapshot(lockKey);
    expect(settled).toEqual({ phase: "synced", buttonsDisabled: false });
    expect(settled?.value).toBeUndefined();
    const repaint = h.chan.editsTo("sw-1").at(-1);
    expect(repaint).toContain("Front Door** · ⚪ Unknown");
    expect(repaint).not.toContain("🟢 On");
  });

  it("an unconfirmed switch change is recorded in the logging channel", async () => {
    const h = await startedHarness({ config: makeConfig({ loggingChannelId: "log-chan" }) });
    const click = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["USER"] });
    await h.adapter.dispatch(click.interaction);
    h.chan.reset();

    h.timers.fire(h.core.stateLockTimeoutMs);
    await h.settle();

    expect(h.chan.lines()).toContain(
      `[14:03:05] ⚠️ "Front Door": the server didn't confirm the change`,
    );
  });

  it("entityRemoved drops a pending lock so its timeout never fires for the removed device", async () => {
    const h = await startedHarness();
    const click = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["USER"] });
    await h.adapter.dispatch(click.interaction);
    expect(h.timers.pendingMs()).toContain(h.core.stateLockTimeoutMs);

    h.state.entities = h.state.entities.filter((e) => e.entityId !== SWITCH_ID);
    h.core.emit("entityRemoved", {
      serverId: SERVER_ID,
      entityId: SWITCH_ID,
      panelMessageId: "sw-1",
    });
    await h.settle();

    expect(h.timers.pendingMs()).not.toContain(h.core.stateLockTimeoutMs);
    expect(h.adapter.stateLockMachine.snapshot(lockKey)).toBeUndefined();
  });

  it("authRenewalNeeded posts the sign-in prompt", async () => {
    const h = await startedHarness({ config: makeConfig({ loggingChannelId: "log-chan" }) });

    h.core.emit("authRenewalNeeded", { reason: "expired" });
    await h.settle();

    expect(h.chan.lines()).toEqual([
      expect.stringContaining("Conduit's Steam sign-in has expired"),
    ]);
  });

  it("authRenewalNeeded falls back to the control channel without a logging channel", async () => {
    const h = await startedHarness();
    h.chan.reset();

    h.core.emit("authRenewalNeeded", { reason: "rejected" });
    await h.settle();

    expect(h.chan.lines()).toEqual([expect.stringContaining("Sign in with Steam again")]);
  });

  // The logging channel is busy, so its lines are @silent and ping nobody
  // unless the line is one that must reach people.
  describe("audit-line delivery", () => {
    type TextPayload = {
      content: string;
      flags?: number;
      allowedMentions?: { parse?: string[]; roles?: string[] };
    };
    const lastText = (h: { chan: { sent: { payload: unknown }[] } }): TextPayload =>
      h.chan.sent.at(-1)!.payload as TextPayload;
    const loggingState = (alarm: Partial<PairedEntity> = {}) => ({
      config: makeConfig({ loggingChannelId: "log-chan" }),
      entities: [makeEntity(ALARM_ID, "alarm", { label: "Base Alarm", ...alarm })],
    });

    it("a routine audit line is @silent and parses no mentions", async () => {
      const h = await startedHarness({ config: makeConfig({ loggingChannelId: "log-chan" }) });
      h.chan.reset();

      h.core.emit("entityChanged", {
        serverId: SERVER_ID,
        change: { entityId: SWITCH_ID, value: true },
      });
      await flush();

      const payload = lastText(h);
      expect(payload.content).toContain('"Front Door" → ON');
      expect(payload.flags).toBe(MessageFlags.SuppressNotifications);
      expect(payload.allowedMentions).toEqual({ parse: [] });
    });

    it.each([
      ["silent", "", true, { parse: [] }],
      [undefined, "", false, { parse: [] }],
      ["active", "@here ", false, { parse: ["everyone"] }],
      ["everyone", "@everyone ", false, { parse: ["everyone"] }],
    ] as const)(
      "an alarm firing at level %s: prefix %j, silent=%s",
      async (level, prefix, silent, allowedMentions) => {
        const h = await startedHarness(loggingState({ notificationLevel: level }));
        h.chan.reset();

        h.core.emit("entityChanged", {
          serverId: SERVER_ID,
          change: { entityId: ALARM_ID, value: true },
        });
        await flush();

        const payload = lastText(h);
        expect(payload.content).toBe(`${prefix}[14:03:05] 🔀 "Base Alarm" → ON`);
        expect(payload.flags).toBe(silent ? MessageFlags.SuppressNotifications : undefined);
        expect(payload.allowedMentions).toEqual(allowedMentions);
      },
    );

    it.each([["silent"], [undefined], ["active"], ["everyone"]] as const)(
      "an alarm resetting at level %s is silent and mentions nobody",
      async (level) => {
        const h = await startedHarness(loggingState({ notificationLevel: level }));
        h.chan.reset();

        h.core.emit("entityChanged", {
          serverId: SERVER_ID,
          change: { entityId: ALARM_ID, value: false },
        });
        await flush();

        const payload = lastText(h);
        expect(payload.content).toBe('[14:03:05] 🔀 "Base Alarm" → OFF');
        expect(payload.flags).toBe(MessageFlags.SuppressNotifications);
        expect(payload.allowedMentions).toEqual({ parse: [] });
      },
    );

    it("a label containing @everyone produces no parsed mentions", async () => {
      const h = await startedHarness({
        ...loggingState({ label: "@everyone <@&123> raid", notificationLevel: undefined }),
      });
      h.chan.reset();

      h.core.emit("entityChanged", {
        serverId: SERVER_ID,
        change: { entityId: ALARM_ID, value: true },
      });
      h.core.emit("teamChat", {
        serverId: SERVER_ID,
        message: { name: "Bob", message: "@everyone <@&123> get on" },
      });
      await flush();

      const texts = h.chan.sent
        .map((s) => s.payload as TextPayload)
        .filter((p) => typeof p.content === "string");
      expect(texts).toHaveLength(2);
      for (const p of texts) expect(p.allowedMentions).toEqual({ parse: [] });
    });

    it("the FCM alarm push notifies as Normal, without a mention", async () => {
      const h = await startedHarness(loggingState());
      h.chan.reset();

      h.core.emit("alarmTriggered", { title: "Base", message: "Raid!" });
      await flush();

      const payload = lastText(h);
      expect(payload.content).toBe('[14:03:05] 🚨 Alarm "Base": Raid!');
      expect(payload.flags).toBeUndefined();
      expect(payload.allowedMentions).toEqual({ parse: [] });
    });

    // A renewal reminder must reach the people who can sign in again.
    it("a sign-in renewal notice @mentions each admin role and notifies", async () => {
      const h = await startedHarness({
        config: makeConfig({
          loggingChannelId: "log-chan",
          roleCapabilities: { admin: ["ADMIN", "OWNER"], user: ["USER"] },
        }),
      });
      h.chan.reset();

      h.core.emit("authRenewalNeeded", {
        reason: "expiring",
        expiresAt: "2026-06-17T14:03:05.000Z",
        milestoneMs: 60 * 60 * 1000,
      });
      await flush();

      const payload = lastText(h);
      expect(payload.content).toMatch(/^<@&ADMIN> <@&OWNER> \[14:03:05\] 🔑 /);
      expect(payload.content).toContain("Sign in with Steam again");
      expect(payload.flags).toBeUndefined();
      expect(payload.allowedMentions).toEqual({ parse: [], roles: ["ADMIN", "OWNER"] });
    });

    it("a sign-in renewal notice with no admin roles mentions nobody but still notifies", async () => {
      const h = await startedHarness({
        config: makeConfig({
          loggingChannelId: "log-chan",
          roleCapabilities: { admin: [], user: ["USER"] },
        }),
      });
      h.chan.reset();

      h.core.emit("authRenewalNeeded", { reason: "rejected" });
      await flush();

      const payload = lastText(h);
      expect(payload.content).toMatch(/^\[14:03:05\] 🔑 /);
      expect(payload.flags).toBeUndefined();
      expect(payload.allowedMentions).toEqual({ parse: [] });
    });
  });

  it("alarm, death and team-chat events are mirrored to the logging channel", async () => {
    const h = await startedHarness({ config: makeConfig({ loggingChannelId: "log-chan" }) });
    // Bob has joined the team since the panel was drawn.
    h.core.team = { leaderSteamId: "1", members: [teamMember("1", "Bob")] };

    h.core.emit("alarmTriggered", { title: "Base", message: "Raid!" });
    h.core.emit("playerDeath", { name: "ShadowCat", message: "by Bob" });
    h.core.emit("teamChat", { serverId: SERVER_ID, message: { name: "Bob", message: "omw" } });
    await h.settle();

    const lines = h.chan.lines();
    expect(lines).toContain('[14:03:05] 🚨 Alarm "Base": Raid!');
    expect(lines).toContain("[14:03:05] 💀 ShadowCat died: by Bob");
    expect(lines).toContain("[14:03:05] 💬 [TEAM] Bob: omw");
    // Team chat also refreshes the team line of the Server message.
    expect(h.core.callsTo("getTeam")).toEqual([[SERVER_ID]]);
    expect(h.chan.editsTo("server-1")).toEqual([expect.stringContaining("Team: 🟢 Bob 👑")]);
  });

  it("a lock that is never confirmed times out and repaints the panel at the prior state", async () => {
    const h = await startedHarness();
    const click = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["USER"] });
    await h.adapter.dispatch(click.interaction);
    h.chan.reset();

    h.timers.fire(h.core.stateLockTimeoutMs);
    await h.settle();

    expect(h.adapter.stateLockMachine.snapshot(lockKey)).toEqual({
      phase: "synced",
      value: false,
      buttonsDisabled: false,
    });
    expect(h.chan.editsTo("sw-1")).toHaveLength(1);
    expect(h.chan.editsTo("sw-1")[0]).toContain("Front Door** · 🔴 Off");
    expect(h.log.messages("warn")).toContain("state-lock timeout; restoring prior state");
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

// ── panel bookkeeping: failed edits, the panel queue, the orphan sweep ──────

describe("adapter: panel bookkeeping", () => {
  describe("only 10008 Unknown Message means a panel is gone", () => {
    it("a transient edit failure neither posts a new Server message nor changes its stored id", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      h.chan.failFetch("server-1", discordError(undefined, "Service Unavailable"));

      const report = await h.adapter.reconstructPanels();

      expect(h.chan.sent).toEqual([]);
      expect(h.store.callsTo("setServerPanelIds")).toEqual([]);
      expect(report.kept).toEqual(["server-1"]);
      expect(report.edited).toEqual(["sw-1", "al-1", "st-1", "cam-1"]);
      expect(report.missing).toEqual([]);
      expect(h.log.fields("warn", "panel write failed; keeping its id")).toEqual([
        expect.objectContaining({ op: "edit", channelId: "control-chan", messageId: "server-1" }),
      ]);
    });

    it("a transient edit failure keeps a device-type message instead of reposting", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      h.chan.failFetch("sw-1", discordError(500));

      const report = await h.adapter.reconstructPanels();

      expect(report.kept).toEqual(["sw-1"]);
      expect(report.missing).toEqual([]);
      expect(h.chan.sent).toEqual([]);
      expect(h.store.callsTo("setServerPanelIds")).toEqual([]);
    });

    it("a re-pair whose panel edit fails transiently keeps the panel and its ids", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      h.chan.failFetch("server-1", discordError());

      h.core.emit("serverPaired", h.state.servers[0]);
      await flush();

      expect(h.chan.sent).toEqual([]);
      expect(h.store.callsTo("setServerPanelIds")).toEqual([]);
    });

    it("10008 Unknown Message reposts the group in order and persists the new ids", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      // Someone deleted the Storage message; Discord now answers 10008 for it.
      await deleteFromChannel(h, "st-1");

      const report = await h.adapter.reconstructPanels();

      // A message in the middle went: the whole group is posted again, in order.
      expect(h.chan.sent.map((m) => heading(m.payload))).toEqual([
        "### Server srv-1",
        "### 🔌 Switches",
        "### 🔔 Alarms",
        "### 📦 Storage",
        "### 📷 Cameras",
      ]);
      const [server, switches, alarms, storage, cameras] = h.chan.sent.map((m) => m.id);
      expect(h.store.callsTo("setServerPanelIds")).toEqual([
        [
          SERVER_ID,
          {
            server,
            switches: [switches],
            alarms: [alarms],
            storage: [storage],
            cameras: [cameras],
          },
        ],
      ]);
      expect(report.edited).toEqual([server, switches, alarms, storage, cameras]);
      expect(report.kept).toEqual([]);
      expect(h.chan.live().sort()).toEqual([server, switches, alarms, storage, cameras].sort());
    });

    it.each([
      [10003, "Unknown Channel"],
      [50001, "Missing Access"],
      [50013, "Missing Permissions"],
    ])(
      "%i %s keeps every stored id, reposts nothing, and warns and reports once",
      async (code, text) => {
        const errors: PostErrorInfo[] = [];
        const h = makeHarness(postedState(), {
          existingMessages: POSTED_MESSAGES,
          onPostError: (info) => errors.push(info),
        });
        await h.start();
        for (const id of POSTED_MESSAGES) h.chan.failFetch(id, discordError(code, text));

        const first = await h.adapter.reconstructPanels();
        await h.adapter.reconstructPanels();

        expect(h.chan.sent).toEqual([]);
        expect(h.store.callsTo("setServerPanelIds")).toEqual([]);
        expect(first.kept).toEqual(POSTED_MESSAGES);
        expect(first.missing).toEqual([]);
        expect(
          h.log.fields("warn", "panel channel unreachable; keeping stored panel ids"),
        ).toHaveLength(1);
        expect(errors).toEqual([
          expect.objectContaining({ channelId: "control-chan", code, permission: code !== 10003 }),
        ]);
      },
    );

    it("a control channel that cannot be fetched keeps the ids and reposts nothing", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      h.client.channels.cache.get = () => undefined;
      h.client.channels.fetch = async () => {
        throw discordError(10003, "Unknown Channel");
      };

      const report = await h.adapter.reconstructPanels();

      expect(h.chan.sent).toEqual([]);
      expect(h.store.callsTo("setServerPanelIds")).toEqual([]);
      expect(report.kept).toEqual(POSTED_MESSAGES);
    });

    it("warns again when access is lost a second time, after a write succeeded", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      const warnings = () =>
        h.log.fields("warn", "panel channel unreachable; keeping stored panel ids").length;

      for (const id of POSTED_MESSAGES) h.chan.failFetch(id, discordError(50001));
      await h.adapter.reconstructPanels();
      h.chan.clearFailures();
      await h.adapter.reconstructPanels();
      for (const id of POSTED_MESSAGES) h.chan.failFetch(id, discordError(50001));
      await h.adapter.reconstructPanels();

      expect(warnings()).toBe(2);
    });
  });

  describe("panel changes run one at a time", () => {
    it("two entityPaired events of new types back to back leave exactly one panel", async () => {
      const state = makeState({
        servers: [makeServer(SERVER_ID, { panelMessageIds: { server: "server-1" } })],
      });
      const h = makeHarness(state, { existingMessages: ["server-1"], writeThrough: true });
      await h.start();
      const first = makeEntity(SWITCH_ID, "switch", { label: "Front Door" });
      const second = makeEntity(ALARM_ID, "alarm", { label: "Base Alarm" });

      // bot-core stores each device before announcing it.
      state.entities.push(first);
      h.core.emit("entityPaired", first);
      state.entities.push(second);
      h.core.emit("entityPaired", second);
      await flush();

      const ids = state.servers[0]!.panelMessageIds!;
      expect(Object.keys(ids)).toEqual(["server", "switches", "alarms"]);
      const tracked = [ids.server!, ...ids.switches!, ...ids.alarms!];
      expect(h.chan.live().sort()).toEqual(tracked.sort());
    });

    it("Rebuild panels while a pairing lands produces no duplicates", async () => {
      const h = makeHarness(postedState(), {
        existingMessages: POSTED_MESSAGES,
        writeThrough: true,
      });
      await h.start();
      const added = makeEntity(11, "switch", { label: "Back Door" });
      const click = makeClick(h.id("setup", "repost"), { roles: ["ADMIN"] });

      // The pairing lands while the rebuild is posting device panels.
      const release = h.chan.holdSends();
      const reposted = h.adapter.dispatch(click.interaction);
      await flush();
      h.state.entities.push(added);
      h.core.emit("entityPaired", added);
      await flush();
      release();
      await reposted;
      await flush();

      const ids = h.state.servers[0]!.panelMessageIds!;
      const tracked = [
        ids.server!,
        ...ids.switches!,
        ...ids.alarms!,
        ...ids.storage!,
        ...ids.cameras!,
      ];
      expect(new Set(tracked).size).toBe(5);
      expect(h.chan.live().sort()).toEqual(tracked.sort());
      expect(h.chan.editsTo(ids.switches![0]!).at(-1) ?? "").not.toContain("undefined");
    });

    it("a server pairing while panels are reconstructed posts one Server message", async () => {
      // No control channel yet at startup, so nothing is posted then.
      const state = makeState({
        servers: [makeServer(SERVER_ID)],
        config: makeConfig({ controlChannelId: undefined }),
      });
      const h = makeHarness(state, { writeThrough: true });
      await h.start();
      state.config.controlChannelId = "control-chan";
      const server = state.servers[0]!;

      const reconstructed = h.adapter.reconstructPanels();
      h.core.emit("serverPaired", server);
      await reconstructed;
      await flush();

      expect(h.chan.sent).toHaveLength(1);
      expect(server.panelMessageIds).toEqual({ server: h.chan.sent[0]!.id });
    });
  });

  describe("orphaned panels are swept from the control channel", () => {
    /** Posted panels, plus an orphaned panel, another user's message and a plain-text notice. */
    function sweepHarness() {
      const h = makeHarness(postedState(), {
        existingMessages: POSTED_MESSAGES,
        botUser: true,
      });
      h.chan.addMessage("orphan-1", {
        authorId: BOT_USER_ID,
        components: conduitComponents("orphan-1"),
      });
      h.chan.addMessage("theirs-1", {
        authorId: "someone-else",
        components: conduitComponents("theirs-1"),
      });
      h.chan.addMessage("notice-1", { authorId: BOT_USER_ID, components: [] });
      return h;
    }

    it("deletes an untracked Conduit panel; keeps tracked panels, other users' messages and plain text", async () => {
      const h = sweepHarness();

      await h.start();

      expect(h.chan.live().sort()).toEqual([...POSTED_MESSAGES, "theirs-1", "notice-1"].sort());
      expect(h.log.fields("info", "swept orphaned panels")).toEqual([
        expect.objectContaining({ channelId: "control-chan", swept: 1 }),
      ]);
    });

    it("reads only the latest 100 messages", async () => {
      const h = sweepHarness();
      await h.start();

      const report = await h.adapter.reconstructPanels();

      expect(h.chan.historyFetches).toEqual([{ limit: 100 }]);
      expect(report.swept).toBe(0);
    });

    it("keeps the messages it has just reposted, before the panel store reflects them", async () => {
      const h = sweepHarness();
      await h.start();
      await deleteFromChannel(h, "server-1");

      const report = await h.adapter.reconstructPanels();

      expect(h.chan.sent).toHaveLength(5);
      for (const { id } of h.chan.sent) expect(h.chan.live()).toContain(id);
      expect(report.swept).toBe(0);
    });

    it("recognises a real panel's components as Conduit's", async () => {
      // A real Conduit Panel, posted and then forgotten (its ids never persisted).
      const h = makeHarness(deviceState(), { botUser: true });
      await h.start();
      const forgotten = h.chan.live();
      expect(forgotten).toHaveLength(5);
      await h.adapter.stop();

      await h.start();

      // The restart posts the panel afresh and sweeps the forgotten one.
      expect(h.chan.live()).toHaveLength(5);
      for (const id of forgotten) expect(h.chan.live()).not.toContain(id);
      expect(h.log.fields("info", "swept orphaned panels").at(-1)).toEqual(
        expect.objectContaining({ swept: 5 }),
      );
    });
  });
});

describe("adapter: panel edit budget", () => {
  const INTERVAL = 60_000;

  async function startedHarness(
    opts: {
      overrides?: Partial<CoreState>;
      onPostError?: (info: PostErrorInfo) => void;
      now?: () => Date;
    } = {},
  ) {
    const h = makeHarness(postedState(opts.overrides), {
      existingMessages: POSTED_MESSAGES,
      statusRefreshIntervalMs: INTERVAL,
      onPostError: opts.onPostError,
      now: opts.now,
    });
    await h.start();
    return h;
  }

  /** Run one periodic status refresh and let its edit go out. */
  async function tick(h: Awaited<ReturnType<typeof startedHarness>>): Promise<void> {
    h.timers.fire(INTERVAL);
    await h.settle();
  }

  /** A storage-monitor broadcast holding `quantity` metal fragments. */
  function monitorChange(quantity: number) {
    return {
      serverId: SERVER_ID,
      change: {
        entityId: MONITOR_ID,
        capacity: 24,
        items: [{ itemId: 69511070, quantity, itemIsBlueprint: false }],
      },
    };
  }

  it("an unchanged periodic refresh fetches the status but makes no edit", async () => {
    const h = await startedHarness();

    await tick(h);
    await tick(h);

    expect(h.core.callsTo("getServerInfo")).toEqual([[SERVER_ID], [SERVER_ID]]);
    expect(h.chan.edits).toEqual([]);
  });

  it("a periodic refresh that finds a change makes one edit, with no 'Refreshing…' and no clock", async () => {
    const h = await startedHarness();
    h.core.team = { leaderSteamId: "1", members: [teamMember("1", "Bob")] };

    await tick(h);

    const edits = h.chan.editsTo("server-1");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("Bob");
    expect(edits[0]).not.toContain("Refreshing");
    expect(edits[0]).not.toContain("🕑");
    expect(h.core.callsTo("getServerTime")).toEqual([]);
  });

  it("manual Refresh still shows 'Refreshing…', then the result with the game clock, at once", async () => {
    const h = await startedHarness();
    const click = makeClick(h.id("server", "refresh", SERVER_ID), { roles: ["USER"] });

    await h.adapter.dispatch(click.interaction);

    const edits = h.chan.editsTo("server-1");
    expect(edits).toHaveLength(2);
    expect(edits[0]).toContain("Refreshing");
    expect(edits[0]).toContain('"disabled":true');
    expect(edits[1]).not.toContain("Refreshing");
    expect(edits[1]).toContain("🕑 12:30");
  });

  it("a burst of changes to one panel becomes one edit carrying the last of them", async () => {
    const h = await startedHarness();

    for (const quantity of [1, 2, 3]) h.core.emit("entityChanged", monitorChange(quantity));
    await flush();
    expect(h.chan.edits).toEqual([]);

    await h.settle();
    const edits = h.chan.editsTo("st-1");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("Metal Fragments ×3");
  });

  it("a switch click's feedback skips the debounce: pending and its confirmation", async () => {
    const h = await startedHarness();
    const click = makeClick(h.id("switch", "on", SERVER_ID, SWITCH_ID), { roles: ["USER"] });

    await h.adapter.dispatch(click.interaction);
    expect(h.chan.editsTo("sw-1")).toEqual([expect.stringContaining("Switching")]);

    h.core.emit("entityChanged", {
      serverId: SERVER_ID,
      change: { entityId: SWITCH_ID, value: true },
    });
    await flush();
    expect(h.chan.editsTo("sw-1")).toHaveLength(2);
    expect(h.chan.editsTo("sw-1")[1]).toContain("Front Door** · 🟢 On");
  });

  it("a switch flipped in game (no click) waits out the debounce", async () => {
    const h = await startedHarness();

    h.core.emit("entityChanged", {
      serverId: SERVER_ID,
      change: { entityId: SWITCH_ID, value: true },
    });
    await flush();
    expect(h.chan.edits).toEqual([]);

    await h.settle();
    expect(h.chan.editsTo("sw-1")).toEqual([expect.stringContaining("Front Door** · 🟢 On")]);
  });

  describe("Discord's 30046 edit cap", () => {
    const REBUILT = "discord edit cap reached (30046): rebuilding every panel";
    const PAUSED = "discord edit cap reached (30046): pausing this panel's edits, not retrying";
    const HEADINGS = [
      "### Server srv-1",
      "### 🔌 Switches",
      "### 🔔 Alarms",
      "### 📦 Storage",
      "### 📷 Cameras",
    ];
    const BOB = { leaderSteamId: "1", members: [teamMember("1", "Bob")] };
    const BOB_AND_ANN = {
      leaderSteamId: "1",
      members: [teamMember("1", "Bob"), teamMember("2", "Ann")],
    };
    const capError = () =>
      discordError(30046, "Maximum number of edits to messages older than 1 hour reached.");

    /** A harness whose clock the test moves, recording what the host is told. */
    async function cappedHarness() {
      let clock = FIXED_NOW.getTime();
      const reported: PostErrorInfo[] = [];
      const h = await startedHarness({
        onPostError: (info) => reported.push(info),
        now: () => new Date(clock),
      });
      return {
        h,
        reported,
        advance: (ms: number) => {
          clock += ms;
        },
      };
    }

    /** Make Discord refuse the next edits of `id` with 30046, and change the team so one is due. */
    async function capOn(
      h: Awaited<ReturnType<typeof startedHarness>>,
      id: string,
      team: typeof BOB,
    ): Promise<void> {
      h.chan.failEdit(id, capError());
      h.core.team = team;
      await tick(h);
      // Let a queued rebuild run.
      await flush();
    }

    it("rebuilds every panel, in order, once, instead of pausing the refused one", async () => {
      const { h, reported } = await cappedHarness();

      await capOn(h, "server-1", BOB);

      expect(h.log.fields("info", REBUILT)).toEqual([
        expect.objectContaining({ messageId: "server-1", code: 30046 }),
      ]);
      expect(h.log.messages("error")).toEqual([]);
      expect(h.timers.pendingMs()).not.toContain(EDIT_CAP_BACKOFF_MS);
      expect(h.chan.deleted).toEqual(POSTED_MESSAGES);
      expect(h.chan.sent.map((s) => heading(s.payload))).toEqual(HEADINGS);
      // Drawn from current state: the change the refused edit carried is on it.
      expect(JSON.stringify(h.chan.sent[0]!.payload)).toContain("Bob");
      expect(reported).toEqual([
        expect.objectContaining({
          channelId: "control-chan",
          code: 30046,
          permission: false,
          editCap: true,
          panelsRebuilt: true,
        }),
      ]);

      // The fresh panels take edits again, in place.
      h.core.team = BOB_AND_ANN;
      await tick(h);
      expect(h.chan.editsTo("posted-0")).toEqual([expect.stringContaining("Ann")]);
      expect(h.chan.sent).toHaveLength(HEADINGS.length);
    });

    it("drops edits still waiting for the old messages", async () => {
      const { h } = await cappedHarness();
      // A switch change waits out its debounce for the old Switches message.
      h.core.emit("entityChanged", {
        serverId: SERVER_ID,
        change: { entityId: SWITCH_ID, value: true },
      });
      await flush();
      h.chan.failEdit("server-1", capError());

      // A member's Refresh edits the Server message at once: refused.
      const click = makeClick(h.id("server", "refresh", SERVER_ID), { roles: ["USER"] });
      await h.adapter.dispatch(click.interaction);
      await h.settle();

      // The Refresh result is refused too, but the rebuild replaces it: no pause.
      expect(h.log.messages("info").filter((m) => m === REBUILT)).toHaveLength(1);
      expect(h.log.messages("error")).toEqual([]);
      expect(h.chan.deleted).toEqual(POSTED_MESSAGES);
      expect(h.chan.edits.filter((e) => POSTED_MESSAGES.includes(e.id))).toEqual([]);
      expect(h.timers.pendingMs()).not.toContain(EDIT_CAP_BACKOFF_MS);
      expect(h.chan.sent.map((s) => heading(s.payload))).toEqual(HEADINGS);
    });

    it("pauses the panel instead when a second 30046 comes within the hour", async () => {
      const { h, reported, advance } = await cappedHarness();
      await capOn(h, "server-1", BOB);
      h.chan.reset();
      reported.length = 0;

      advance(EDIT_CAP_REBUILD_INTERVAL_MS - 1);
      await capOn(h, "posted-0", BOB_AND_ANN);

      expect(h.chan.sent).toEqual([]);
      expect(h.chan.deleted).toEqual([]);
      expect(h.log.messages("info").filter((m) => m === REBUILT)).toHaveLength(1);
      expect(h.log.messages("error")).toEqual([PAUSED]);
      expect(h.timers.pendingMs()).toContain(EDIT_CAP_BACKOFF_MS);
      expect(reported).toEqual([
        expect.objectContaining({ code: 30046, permission: false, editCap: true }),
      ]);
      expect(reported[0]!.panelsRebuilt).toBeUndefined();

      // Discord would take edits again; the panel still waits out its pause.
      h.chan.clearFailures();
      await tick(h);
      expect(h.chan.edits).toEqual([]);

      // The pause ends: the newest panel goes out, once.
      h.timers.fire(EDIT_CAP_BACKOFF_MS);
      await flush();
      expect(h.chan.editsTo("posted-0")).toEqual([expect.stringContaining("Ann")]);
    });

    it("rebuilds again once the hour has passed", async () => {
      const { h, advance } = await cappedHarness();
      await capOn(h, "server-1", BOB);
      h.chan.reset();

      advance(EDIT_CAP_REBUILD_INTERVAL_MS);
      await capOn(h, "posted-0", BOB_AND_ANN);

      expect(h.log.messages("info").filter((m) => m === REBUILT)).toHaveLength(2);
      expect(h.log.messages("error")).toEqual([]);
      expect(h.chan.deleted).toEqual(["posted-0", "posted-1", "posted-2", "posted-3", "posted-4"]);
      expect(h.chan.sent.map((s) => heading(s.payload))).toEqual(HEADINGS);
      expect(JSON.stringify(h.chan.sent[0]!.payload)).toContain("Ann");
    });
  });

  it("drops a debounced edit for a panel that is deleted meanwhile", async () => {
    const h = await startedHarness();
    h.core.emit("entityChanged", monitorChange(5));
    await flush();

    // The last monitor goes, so the Storage message is deleted.
    const monitor = h.state.entities.find((e) => e.entityId === MONITOR_ID)!;
    h.state.entities = h.state.entities.filter((e) => e !== monitor);
    h.core.emit("entityRemoved", { serverId: SERVER_ID, entityId: MONITOR_ID });
    await h.settle();

    expect(h.chan.deleted).toContain("st-1");
    expect(h.chan.editsTo("st-1")).toEqual([]);
  });
});

describe("adapter: reconnecting before offline", () => {
  const LAST_SEEN = FIXED_NOW.getTime() - 5 * 60_000;

  async function startedHarness() {
    const h = makeHarness(postedState({ config: makeConfig({ loggingChannelId: "log-chan" }) }), {
      existingMessages: POSTED_MESSAGES,
    });
    await h.start();
    h.adapter.stateLockMachine.seed({ serverId: SERVER_ID, entityId: SWITCH_ID }, true);
    return h;
  }

  /** Whether a message has buttons, and every one of them is disabled. */
  function allButtonsDisabled(json: string | undefined): boolean {
    const buttons: { disabled?: boolean }[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if ((node as { type?: unknown }).type === 2) buttons.push(node as { disabled?: boolean });
      for (const value of Object.values(node)) visit(value);
    };
    visit(JSON.parse(json ?? "null"));
    return buttons.length > 0 && buttons.every((b) => b.disabled === true);
  }

  it("reconnecting keeps the last known data, disables the actions, and writes no line", async () => {
    const h = await startedHarness();

    h.core.setServerStatus(SERVER_ID, { status: "reconnecting", lastSeenAt: LAST_SEEN });
    await h.settle();

    const status = h.chan.editsTo("server-1").at(-1);
    expect(status).toContain("🟡 Reconnecting…");
    expect(status).toContain("12/100 players"); // from before the drop
    expect(rowButton(status, "Reconnecting").disabled).toBe(true); // Refresh
    expect(h.core.callsTo("getServerInfo")).toEqual([]);
    const sw = h.chan.editsTo("sw-1").at(-1);
    expect(sw).toContain("Front Door** · 🟢 On");
    expect(rowButton(sw, "Front Door")).toEqual(
      expect.objectContaining({ label: "Turn off", disabled: true }),
    );
    for (const id of ["st-1", "cam-1"])
      expect(allButtonsDisabled(h.chan.editsTo(id).at(-1))).toBe(true);
    expect(h.chan.lines()).toEqual([]);
  });

  it("offline says when the server was last seen, shows the last reported state, and writes a line", async () => {
    const h = await startedHarness();
    h.core.setServerStatus(SERVER_ID, { status: "reconnecting", lastSeenAt: LAST_SEEN });
    await h.settle();

    h.core.setServerStatus(SERVER_ID, { status: "offline", lastSeenAt: LAST_SEEN });
    await h.settle();

    const status = h.chan.editsTo("server-1").at(-1);
    expect(status).toContain("🔴 Offline");
    expect(status).toContain(`last seen <t:${Math.floor(LAST_SEEN / 1000)}:R>`);
    expect(status).not.toContain("players");
    const sw = h.chan.editsTo("sw-1").at(-1);
    expect(sw).toContain("Front Door** · last reported 🟢 On");
    for (const id of POSTED_MESSAGES) {
      if (id !== "al-1") expect(allButtonsDisabled(h.chan.editsTo(id).at(-1))).toBe(true);
    }
    expect(h.chan.lines()).toEqual(["[14:03:05] 🔴 Server srv-1 offline"]);
  });

  it("coming back from offline writes a line; coming back from reconnecting does not", async () => {
    const h = await startedHarness();

    h.core.setServerStatus(SERVER_ID, { status: "reconnecting", lastSeenAt: LAST_SEEN });
    h.core.setServerStatus(SERVER_ID, { status: "connected" });
    await h.settle();
    expect(h.chan.lines()).toEqual([]);

    h.core.setServerStatus(SERVER_ID, { status: "reconnecting", lastSeenAt: LAST_SEEN });
    h.core.setServerStatus(SERVER_ID, { status: "offline", lastSeenAt: LAST_SEEN });
    h.core.setServerStatus(SERVER_ID, { status: "connected" });
    await h.settle();
    expect(h.chan.lines()).toEqual([
      "[14:03:05] 🔴 Server srv-1 offline",
      "[14:03:05] 🟢 Server srv-1 online",
    ]);
    const sw = h.chan.editsTo("sw-1").at(-1);
    expect(sw).toContain("Front Door** · 🟢 On");
    expect(rowButton(sw, "Front Door")).toEqual(
      expect.objectContaining({ label: "Turn off", disabled: false }),
    );
  });

  // End to end with a real bot-core: its grace timer and the adapter's panels.
  describe("with bot-core's grace period", () => {
    /** A Rust+ client whose connection the test drops and restores. */
    class FakeRustClient extends EventEmitter {
      connected = false;
      readonly route = "companion";
      connect = async (): Promise<void> => this.back();
      disconnect = async (): Promise<void> => {};
      getInfo = async () => ({ players: 12, maxPlayers: 100, queuedPlayers: 3 });
      getTeamInfo = async () => ({ leaderSteamId: "0", members: [] });
      getEntityInfo = async (entityId: number) => ({
        entityId,
        type: "switch",
        value: false,
        items: [],
      });
      untrackEntity = (): void => {};
      drop(): void {
        this.connected = false;
        this.emit("disconnected", { code: 1006, reason: "CloudFlare WebSocket proxy restarting" });
      }
      back(): void {
        this.connected = true;
        this.emit("connected");
      }
    }

    async function live() {
      const timers = makeTimers();
      const rust = new FakeRustClient();
      const core = new BotCore(
        new InMemoryStateStore({
          config: makeConfig({ loggingChannelId: "log-chan" }),
          servers: [makeServer(SERVER_ID, { panelMessageIds: { server: "server-1" } })],
        }),
        new EventEmitter() as never,
        { clientFactory: () => rust as never, timers: timers.provider, now: () => 0 },
      );
      await core.start();
      const chan = makeChannel(["server-1"]);
      const client = new FakeClient(chan.channel);
      const adapter = new DiscordAdapter({
        core,
        token: "bot-token",
        timers: timers.provider,
        clientFactory: () => client as never,
        statusRefreshIntervalMs: 0,
        now: () => FIXED_NOW,
      });
      const started = adapter.start();
      client.emit(Events.ClientReady);
      await started;
      await core.connectServer(SERVER_ID);
      const settle = async (): Promise<void> => {
        await flush();
        timers.fire(EDIT_DEBOUNCE_MS);
        await flush();
      };
      await settle();
      chan.reset();
      return { timers, rust, core, chan, settle };
    }

    it("a 2 s blip makes no offline edit and writes no line", async () => {
      const h = await live();

      h.rust.drop();
      await h.settle(); // the 🟡 edit goes out
      h.rust.back(); // 2 s later: well inside the grace period
      await h.settle();

      const edits = h.chan.editsTo("server-1");
      expect(edits.some((e) => e.includes("🔴 Offline"))).toBe(false);
      expect(edits.at(-1)).toContain("🟢 Online");
      expect(h.chan.lines()).toEqual([]);
      // The grace timer is gone: nothing turns it offline later.
      h.timers.fire(SERVER_OFFLINE_GRACE_MS);
      await h.settle();
      expect(h.chan.editsTo("server-1").some((e) => e.includes("🔴 Offline"))).toBe(false);
    });

    it("a long outage shows reconnecting, then offline, then recovers", async () => {
      const h = await live();

      h.rust.drop();
      await h.settle();
      expect(h.chan.editsTo("server-1").at(-1)).toContain("🟡 Reconnecting");
      expect(h.chan.lines()).toEqual([]);

      h.timers.fire(SERVER_OFFLINE_GRACE_MS);
      await h.settle();
      expect(h.chan.editsTo("server-1").at(-1)).toContain("🔴 Offline");
      expect(h.chan.editsTo("server-1").at(-1)).toContain("last seen <t:0:R>");
      expect(h.chan.lines()).toEqual(["[14:03:05] 🔴 Server srv-1 offline"]);

      h.rust.back();
      await h.settle();
      expect(h.chan.editsTo("server-1").at(-1)).toContain("🟢 Online");
      expect(h.chan.lines()).toEqual([
        "[14:03:05] 🔴 Server srv-1 offline",
        "[14:03:05] 🟢 Server srv-1 online",
      ]);
    });
  });
});

describe("adapter: lifecycle", () => {
  it("start() is idempotent once started and leaves no startup timer armed", async () => {
    const h = makeHarness(makeState());
    await h.start();

    expect(h.client.logins).toEqual(["bot-token"]);
    // Ready arrived, so the ready-timeout safety net was disarmed.
    expect(h.timers.pendingMs()).toEqual([]);

    await h.adapter.start();

    expect(h.clientsCreated()).toBe(1);
    expect(h.client.logins).toEqual(["bot-token"]);
  });

  it("routes gateway InteractionCreate events through the dispatcher once started", async () => {
    const h = makeHarness(deviceState());
    await h.start();
    const click = makeGatewayInteraction({ customId: h.id("setup", "addDevice"), roles: ["USER"] });

    h.client.emit(Events.InteractionCreate, click.interaction);
    await flush();

    expect(click.payloads("reply").map((p) => p.content)).toEqual([DENIAL_MESSAGE]);
  });

  it("reconciles panels when ClientReady arrives after the ready timeout", async () => {
    const h = makeHarness(makeState({ servers: [makeServer(SERVER_ID)] }));
    const started = h.adapter.start();
    await flush();

    // No ClientReady yet: the safety net lets startup proceed un-reconciled.
    h.timers.fire(READY_TIMEOUT_MS);
    await started;
    expect(h.chan.sent).toEqual([]);

    h.client.emit(Events.ClientReady);
    await flush();

    // The late ready still posts the server's missing panel.
    expect(h.chan.sent).toHaveLength(1);
    expect(h.store.callsTo("setServerPanelIds")).toEqual([
      [SERVER_ID, { server: h.chan.sent[0]?.id }],
    ]);
  });

  it("stop() before start() is a no-op, and a second stop() does not destroy twice", async () => {
    const h = makeHarness(makeState());

    await h.adapter.stop();
    expect(h.client.destroyed).toBe(0);

    await h.start();
    await h.adapter.stop();
    await h.adapter.stop();
    expect(h.client.destroyed).toBe(1);
  });

  it("after stop(), domain events no longer post, edit or delete anything in Discord", async () => {
    const h = makeHarness(postedState({ config: makeConfig({ loggingChannelId: "log-chan" }) }), {
      existingMessages: POSTED_MESSAGES,
    });
    await h.start();
    await h.adapter.stop();

    h.core.emit("entityChanged", {
      serverId: SERVER_ID,
      change: { entityId: SWITCH_ID, value: true },
    });
    h.core.emit("serverStatusChanged", { serverId: SERVER_ID, status: "disconnected" });
    h.core.emit("serverPaired", makeServer("srv-new"));
    h.core.emit("alarmTriggered", { title: "Base", message: "Raid!" });
    h.core.emit("entityRemoved", {
      serverId: SERVER_ID,
      entityId: SWITCH_ID,
      panelMessageId: "sw-1",
    });
    await flush();

    expect(h.chan.sent).toEqual([]);
    expect(h.chan.edits).toEqual([]);
    expect(h.chan.deleted).toEqual([]);
  });

  /** Every bot-core event the adapter subscribes to. */
  const DOMAIN_EVENTS = [
    "entityChanged",
    "serverStatusChanged",
    "alarmTriggered",
    "playerDeath",
    "teamChat",
    "entityPaired",
    "entityRemoved",
    "serverPaired",
  ];

  it("start() subscribes to each bot-core event exactly once", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    await h.start();

    for (const event of DOMAIN_EVENTS) expect(h.core.listenerCount(event)).toBe(1);
  });

  it("stop() detaches from bot-core: later events trigger no bot-core calls", async () => {
    const h = makeHarness(postedState({ config: makeConfig({ loggingChannelId: "log-chan" }) }), {
      existingMessages: POSTED_MESSAGES,
    });
    await h.start();
    await h.adapter.stop();

    for (const event of DOMAIN_EVENTS) expect(h.core.listenerCount(event)).toBe(0);

    // These would fetch live status / roster / entity state if still wired.
    h.core.emit("serverStatusChanged", { serverId: SERVER_ID, status: "connected" });
    h.core.emit("teamChat", { serverId: SERVER_ID, message: { name: "Bob", message: "omw" } });
    const paired = makeEntity(42, "switch", { label: "New Switch" });
    h.state.entities.push(paired);
    h.core.emit("entityPaired", paired);
    await flush();

    expect(h.core.calls).toEqual([]);
    expect(h.chan.sent).toEqual([]);
    expect(h.chan.edits).toEqual([]);
    expect(h.chan.deleted).toEqual([]);
  });

  it("start() → stop() → start() handles each domain event exactly once", async () => {
    const h = makeHarness(postedState({ config: makeConfig({ loggingChannelId: "log-chan" }) }), {
      existingMessages: POSTED_MESSAGES,
    });
    await h.start();
    await h.adapter.stop();
    await h.start();

    for (const event of DOMAIN_EVENTS) expect(h.core.listenerCount(event)).toBe(1);

    h.core.emit("alarmTriggered", { title: "Base", message: "Raid!" });
    h.core.emit("entityChanged", {
      serverId: SERVER_ID,
      change: { entityId: MONITOR_ID, capacity: 24, items: [{ itemId: 69511070, quantity: 1 }] },
    });
    h.core.emit("serverStatusChanged", { serverId: SERVER_ID, status: "connected" });
    await h.settle();

    // One audit line, one panel edit and one status fetch per event — not two.
    expect(h.chan.lines().filter((l) => l.includes("🚨"))).toHaveLength(1);
    expect(h.chan.editsTo("st-1")).toHaveLength(1);
    expect(h.core.callsTo("getServerInfo")).toEqual([[SERVER_ID]]);
  });

  it("a second stop() and a stop() before start() leave nothing to detach", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });

    await h.adapter.stop();
    await h.start();
    await h.adapter.stop();
    await expect(h.adapter.stop()).resolves.toBeUndefined();

    for (const event of DOMAIN_EVENTS) expect(h.core.listenerCount(event)).toBe(0);
  });

  // Each user creates their own bot; Conduit gives it the Conduit mark.
  describe("default bot avatar", () => {
    const MARK = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    function botUser(avatar: string | null) {
      return { id: "bot-1", avatar, setAvatar: vi.fn(async () => {}) };
    }

    it("sets the Conduit mark on a bot with no avatar, once on ready", async () => {
      const botAvatar = vi.fn(async () => MARK);
      const h = makeHarness(makeState(), { botAvatar });
      h.client.user = botUser(null);

      await h.start();
      await flush();

      expect(h.client.user.setAvatar).toHaveBeenCalledOnce();
      expect([...(h.client.user.setAvatar.mock.calls[0]![0] as Buffer)]).toEqual([...MARK]);
      expect(h.log.messages("info")).toContain("discord: set the bot's avatar to the Conduit mark");
    });

    it("never replaces an avatar the user chose, and does not even read the picture", async () => {
      const botAvatar = vi.fn(async () => MARK);
      const h = makeHarness(makeState(), { botAvatar });
      h.client.user = botUser("a1b2c3");

      await h.start();
      await flush();

      expect(botAvatar).not.toHaveBeenCalled();
      expect(h.client.user.setAvatar).not.toHaveBeenCalled();
    });

    it("a rejected avatar change is logged and startup carries on", async () => {
      const h = makeHarness(makeState(), { botAvatar: async () => MARK });
      h.client.user = botUser(null);
      h.client.user.setAvatar.mockRejectedValueOnce(
        new Error("You are changing your avatar too fast"),
      );

      await h.start();
      await flush();

      expect(h.log.messages("warn")).toContain("discord: setting the bot's avatar failed");
    });

    it("does nothing without a picture to offer", async () => {
      const h = makeHarness();
      h.client.user = botUser(null);

      await h.start();
      await flush();

      expect(h.client.user.setAvatar).not.toHaveBeenCalled();
    });
  });

  it("a failed login leaves no bot-core listeners and no startup timer behind", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    const loginError = namedError("Error", "TokenInvalid");
    h.client.login = async () => {
      throw loginError;
    };

    await expect(h.adapter.start()).rejects.toBe(loginError);

    for (const event of DOMAIN_EVENTS) expect(h.core.listenerCount(event)).toBe(0);
    expect(h.timers.pendingMs()).toEqual([]);

    // Still inert afterwards: an event reaches nothing.
    h.core.emit("serverStatusChanged", { serverId: SERVER_ID, status: "connected" });
    await flush();
    expect(h.core.calls).toEqual([]);
    expect(h.chan.edits).toEqual([]);
  });

  it("can start again after a failed login", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
    const login = h.client.login.bind(h.client);
    h.client.login = async () => {
      throw namedError("Error", "TokenInvalid");
    };
    await expect(h.adapter.start()).rejects.toThrow("TokenInvalid");

    h.client.login = login;
    await h.start();

    for (const event of DOMAIN_EVENTS) expect(h.core.listenerCount(event)).toBe(1);
  });
});

// ── the Conduit Panel: one message per device type, per server ───────────────

describe("adapter: the Conduit Panel", () => {
  const HEADINGS = [
    "### Server srv-1",
    "### 🔌 Switches",
    "### 🔔 Alarms",
    "### 📦 Storage",
    "### 📷 Cameras",
  ];

  /** Start without clearing what the startup reconcile did. */
  async function startKeepingRecords(h: ReturnType<typeof makeHarness>): Promise<void> {
    const started = h.adapter.start();
    h.client.emit(Events.ClientReady);
    await started;
  }

  describe("migration from per-device panels", () => {
    it("deletes the old status, team and device panels, then posts the group in order", async () => {
      const state = legacyState();
      state.servers[0]!.teamPanelMessageId = "team-1";
      const h = makeHarness(state, {
        existingMessages: [...LEGACY_MESSAGES, "team-1"],
        writeThrough: true,
      });

      await startKeepingRecords(h);

      expect(h.chan.deleted).toEqual([
        "status-1",
        "team-1",
        "old-sw",
        "old-al",
        "old-mon",
        "old-cam",
      ]);
      expect(h.store.callsTo("clearLegacyPanelIds")).toEqual([
        [
          SERVER_ID,
          {
            status: true,
            team: true,
            entityIds: [SWITCH_ID, ALARM_ID, MONITOR_ID, CAMERA_ID],
          },
        ],
      ]);
      expect(h.chan.sent.map((m) => heading(m.payload))).toEqual(HEADINGS);
      const server = state.servers[0]!;
      expect(server.statusPanelMessageId).toBeUndefined();
      expect(server.teamPanelMessageId).toBeUndefined();
      expect(state.entities.map((e) => e.panelMessageId)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      const posted = h.chan.sent.map((m) => m.id);
      expect(server.panelMessageIds).toEqual({
        server: posted[0],
        switches: [posted[1]],
        alarms: [posted[2]],
        storage: [posted[3]],
        cameras: [posted[4]],
      });
      expect(h.chan.live()).toEqual(posted);

      // The next start finds the new panel and only edits it.
      await h.adapter.stop();
      h.chan.reset();
      await startKeepingRecords(h);
      expect(h.chan.sent).toEqual([]);
      expect(h.chan.deleted).toEqual([]);
    });

    it("keeps an old panel's id when its delete fails, and retries on the next start", async () => {
      const h = makeHarness(legacyState(), {
        existingMessages: LEGACY_MESSAGES,
        writeThrough: true,
      });
      h.chan.failFetch("old-al", discordError(500));

      await startKeepingRecords(h);

      expect(h.store.callsTo("clearLegacyPanelIds")).toEqual([
        [SERVER_ID, { status: true, entityIds: [SWITCH_ID, MONITOR_ID, CAMERA_ID] }],
      ]);
      const alarm = h.state.entities.find((e) => e.entityId === ALARM_ID)!;
      expect(alarm.panelMessageId).toBe("old-al");
      expect(h.chan.sent).toHaveLength(5);

      h.chan.clearFailures();
      await h.adapter.reconstructPanels();
      expect(alarm.panelMessageId).toBeUndefined();
      expect(h.chan.live()).not.toContain("old-al");
    });
  });

  describe("layout changes", () => {
    it("the first device of a new type reposts the group, to keep the order", async () => {
      const { cameras: _none, ...ids } = POSTED_IDS;
      const state = postedState();
      state.servers[0]!.panelMessageIds = structuredClone(ids);
      state.entities = state.entities.filter((e) => e.entityType !== "camera");
      const h = makeHarness(state, {
        existingMessages: POSTED_MESSAGES.filter((id) => id !== "cam-1"),
        writeThrough: true,
      });
      await h.start();
      const camera = makeEntity(CAMERA_ID, "camera", { label: "Gate Cam", identifier: "GATE1" });
      state.entities.push(camera);

      h.core.emit("entityPaired", camera);
      await h.settle();

      expect(h.chan.deleted).toEqual(["server-1", "sw-1", "al-1", "st-1"]);
      expect(h.chan.sent.map((m) => heading(m.payload))).toEqual(HEADINGS);
      expect(h.chan.live()).toEqual(h.chan.sent.map((m) => m.id));
    });

    it("a 12th switch pages the Switches message; removing it goes back to one page", async () => {
      const switches = Array.from({ length: 11 }, (_, i) =>
        makeEntity(100 + i, "switch", { label: `Switch ${String(i).padStart(2, "0")}` }),
      );
      const state = makeState({
        servers: [
          makeServer(SERVER_ID, { panelMessageIds: { server: "server-1", switches: ["sw-1"] } }),
        ],
        entities: switches,
        connected: [SERVER_ID],
      });
      const h = makeHarness(state, {
        existingMessages: ["server-1", "sw-1"],
        writeThrough: true,
      });
      await h.start();
      const twelfth = makeEntity(200, "switch", { label: "Switch 99" });
      state.entities.push(twelfth);

      h.core.emit("entityPaired", twelfth);
      await h.settle();

      expect(h.chan.sent.map((m) => heading(m.payload))).toEqual([
        "### Server srv-1",
        "### 🔌 Switches 1/2",
        "### 🔌 Switches 2/2",
      ]);
      const [, page1, page2] = h.chan.sent.map((m) => m.id);
      expect(state.servers[0]!.panelMessageIds?.switches).toEqual([page1, page2]);

      h.chan.reset();
      state.entities = state.entities.filter((e) => e !== twelfth);
      h.core.emit("entityRemoved", { serverId: SERVER_ID, entityId: 200 });
      await h.settle();

      expect(h.chan.deleted).toEqual([page2]);
      expect(h.chan.sent).toEqual([]);
      expect(heading(JSON.parse(h.chan.editsTo(page1!).at(-1)!))).toBe("### 🔌 Switches");
      expect(state.servers[0]!.panelMessageIds?.switches).toEqual([page1]);
    });
  });

  describe("rows and their buttons", () => {
    it("a Manage select opens that device's settings ephemerally and resets the select", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      const handle = h.adapter.handleRegistry.register(
        HandleRegistry.entityKey(SERVER_ID, SWITCH_ID),
      );
      const select = makeClick(h.id("switch", "manage", SERVER_ID), {
        roles: ["ADMIN"],
        kind: "stringSelect",
        values: [handle],
      });

      await h.adapter.dispatch(select.interaction);
      await h.settle();

      expect(select.order()).toEqual(["replyEphemeralPanel"]);
      const settings = JSON.stringify(select.payloads("replyEphemeralPanel")[0]);
      expect(settings).toContain("Front Door");
      expect(settings).toContain("⚙ Settings");
      // The Switches message is drawn again, so the select shows its placeholder.
      expect(h.chan.editsTo("sw-1")).toHaveLength(1);
    });

    it("a Manage select naming another server's device is refused", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      const elsewhere = h.adapter.handleRegistry.register(
        HandleRegistry.entityKey("srv-2", SWITCH_ID),
      );
      const select = makeClick(h.id("switch", "manage", SERVER_ID), {
        roles: ["ADMIN"],
        kind: "stringSelect",
        values: [elsewhere],
      });

      await h.adapter.dispatch(select.interaction);

      expect(select.texts()).toEqual([GENERIC_FAILURE_MESSAGE]);
      expect(select.payloads("replyEphemeralPanel")).toEqual([]);
    });

    it("🔍 Contents shows a monitor's full contents to the member; the row keeps a summary", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      const items = [-151838493, 69511070, -2099697608, 317398316, 1381010055].map((itemId, i) => ({
        itemId,
        quantity: 100 - i,
        itemIsBlueprint: false,
      }));
      h.core.emit("entityRefreshed", {
        serverId: SERVER_ID,
        entityId: MONITOR_ID,
        info: { entityId: MONITOR_ID, type: "storageMonitor", capacity: 24, items },
      });
      await h.settle();
      expect(h.chan.editsTo("st-1").at(-1)).toContain("+2 more");
      const click = makeClick(h.id("monitor", "contents", SERVER_ID, MONITOR_ID), {
        roles: ["USER"],
      });

      await h.adapter.dispatch(click.interaction);

      expect(click.order()).toEqual(["replyEphemeralPanel"]);
      const contents = JSON.stringify(click.payloads("replyEphemeralPanel")[0]);
      expect(contents).toContain("5/24 slots");
      expect(contents).toContain("Wood ×100\\nMetal Fragments ×99");
      expect(contents).not.toContain("more");
    });

    it("📷 Capture with no logging channel shows the still to the member alone", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      const click = makeClick(h.id("camera", "capture", SERVER_ID, CAMERA_ID), {
        roles: ["USER"],
      });

      await h.adapter.dispatch(click.interaction);

      expect(h.core.callsTo("getCameraFrame")).toEqual([[SERVER_ID, "GATE1"]]);
      expect(click.order()).toEqual(["deferUpdate", "replyEphemeralPanel"]);
      const frame = click.payloads("replyEphemeralPanel")[0] as { files?: unknown[] };
      expect(frame.files).toHaveLength(1);
      expect(JSON.stringify(frame)).toContain("Gate Cam");
      // Nothing is posted, and the shared panel never shows the frame.
      expect(h.chan.sent).toEqual([]);
      expect(h.chan.edits.map((e) => e.id)).toEqual(["cam-1"]);
      expect(h.chan.editsTo("cam-1")[0]).not.toContain("attachment://");
    });

    it("📷 Capture posts the still @silent to the logging channel, mentioning the member", async () => {
      const h = makeHarness(postedState({ config: makeConfig({ loggingChannelId: "log-chan" }) }), {
        existingMessages: POSTED_MESSAGES,
      });
      await h.start();
      h.chan.reset();
      const click = makeClick(h.id("camera", "capture", SERVER_ID, CAMERA_ID), {
        roles: ["USER"],
      });

      await h.adapter.dispatch(click.interaction);
      await flush();

      // Acknowledged once, with nothing shown in the control channel.
      expect(click.order()).toEqual(["deferUpdate"]);
      const posts = h.chan.sent
        .map((s) => s.payload as { files?: unknown[]; flags: number; allowedMentions: unknown })
        .filter((p) => p.files?.length);
      expect(posts).toHaveLength(1);
      const [post] = posts;
      expect(JSON.stringify(post)).toContain("Gate Cam");
      expect(JSON.stringify(post)).toContain("by <@U1>");
      expect(JSON.stringify(post)).toContain("attachment://camera-");
      // @silent like every log line, so members on "All Messages" get no
      // notification; the only mention Discord acts on is the member who pressed it.
      expect(post!.flags & MessageFlags.SuppressNotifications).toBe(
        MessageFlags.SuppressNotifications,
      );
      expect(post!.allowedMentions).toEqual({ parse: [], users: ["U1"] });
    });

    it("📷 Capture disables that camera's button for 30 seconds", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      const capture = h.id("camera", "capture", SERVER_ID, CAMERA_ID);

      await h.adapter.dispatch(makeClick(capture, { roles: ["USER"] }).interaction);
      await flush();

      const cooling = h.chan.editsTo("cam-1").at(-1);
      expect(rowButton(cooling, "Gate Cam").disabled).toBe(true);
      const readyAt = Math.ceil((FIXED_NOW.getTime() + CAMERA_COOLDOWN_MS) / 1000);
      expect(cooling).toContain(`ready <t:${readyAt}:R>`);
      expect(h.timers.pendingMs()).toContain(CAMERA_COOLDOWN_MS);

      // A click that lands meanwhile (from a panel not yet redrawn) is turned away.
      const early = makeClick(capture, { roles: ["USER"] });
      await h.adapter.dispatch(early.interaction);
      expect(early.order()).toEqual(["replyEphemeral"]);
      expect(early.payloads("replyEphemeral")[0]).toMatch(/try again in 30s/i);
      expect(h.core.callsTo("getCameraFrame")).toHaveLength(1);

      h.timers.fire(CAMERA_COOLDOWN_MS);
      await flush();

      const ready = h.chan.editsTo("cam-1").at(-1);
      expect(rowButton(ready, "Gate Cam").disabled).toBe(false);
      expect(ready).not.toContain("ready <t:");
      await h.adapter.dispatch(makeClick(capture, { roles: ["USER"] }).interaction);
      expect(h.core.callsTo("getCameraFrame")).toHaveLength(2);
    });

    it("stop() disarms a camera's cooldown", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      await h.adapter.dispatch(
        makeClick(h.id("camera", "capture", SERVER_ID, CAMERA_ID), { roles: ["USER"] }).interaction,
      );

      await h.adapter.stop();

      expect(h.timers.pendingMs()).not.toContain(CAMERA_COOLDOWN_MS);
    });

    it("🔄 Refresh on an unknown switch reads its state and offers the matching action", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      h.core.failWith("registerEntityInterest", namedError("ConnectionError"));
      await h.start();
      expect(
        h.adapter.stateLockMachine.snapshot({ serverId: SERVER_ID, entityId: SWITCH_ID }),
      ).toBeUndefined();
      const click = makeClick(h.id("switch", "refresh", SERVER_ID, SWITCH_ID), {
        roles: ["USER"],
      });

      await h.adapter.dispatch(click.interaction);

      expect(click.order()).toEqual(["deferUpdate"]);
      expect(h.core.callsTo("getEntity")).toEqual([[SERVER_ID, SWITCH_ID]]);
      const sw = h.chan.editsTo("sw-1").at(-1);
      expect(sw).toContain("Front Door** · 🔴 Off");
      expect(rowButton(sw, "Front Door")).toEqual(
        expect.objectContaining({ label: "Turn on", disabled: false }),
      );
    });

    it("a firing alarm turns its line and message red; the @here alert stays plain text", async () => {
      const state = postedState({ config: makeConfig({ loggingChannelId: "log-chan" }) });
      state.entities.find((e) => e.entityId === ALARM_ID)!.notificationLevel = "active";
      const h = makeHarness(state, { existingMessages: POSTED_MESSAGES });
      await h.start();

      h.core.emit("entityChanged", {
        serverId: SERVER_ID,
        change: { entityId: ALARM_ID, value: true },
      });
      await h.settle();

      const firing = h.chan.editsTo("al-1").at(-1)!;
      expect(firing).toContain("🚨 **Base Alarm** · **firing**");
      expect(firing).toContain(`"accent_color":${0xf23f43}`);
      expect(firing).not.toContain("@here");
      expect(h.chan.lines()).toEqual([expect.stringMatching(/^@here /)]);

      h.core.emit("entityChanged", {
        serverId: SERVER_ID,
        change: { entityId: ALARM_ID, value: false },
      });
      await h.settle();

      const quiet = h.chan.editsTo("al-1").at(-1)!;
      expect(quiet).toContain("🔔 **Base Alarm** · quiet");
      expect(quiet).toContain(`"accent_color":${0x5865f2}`);
    });

    it("a stale select of a domain this build has no panel for is still acknowledged", async () => {
      const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });
      await h.start();
      const stale = buildCustomId({
        domain: "team" as CustomIdDomain,
        action: "manage",
        server: h.adapter.handleRegistry.register(SERVER_ID),
      });
      const select = makeClick(stale, { roles: ["ADMIN"], kind: "stringSelect", values: ["x"] });

      const outcome = await h.adapter.dispatch(select.interaction);

      expect(outcome.handled).toBe(true);
      expect(select.order()).toEqual(["deferUpdate"]);
      expect(h.core.calls).toEqual([]);
    });
  });
});

describe("adapter: panels are silent", () => {
  /** Start without clearing what the startup reconcile did. */
  async function startKeepingRecords(h: ReturnType<typeof makeHarness>): Promise<void> {
    const started = h.adapter.start();
    h.client.emit(Events.ClientReady);
    await started;
  }

  type Sent = { flags?: number; allowedMentions?: unknown };

  it("posts every panel @silent, as Components V2, with no parsed mentions", async () => {
    const h = makeHarness(legacyState(), { existingMessages: LEGACY_MESSAGES });

    await startKeepingRecords(h);

    expect(h.chan.sent.length).toBeGreaterThan(0);
    for (const { payload } of h.chan.sent) {
      const sent = payload as Sent;
      expect(sent.flags).toBe(MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications);
      expect(sent.allowedMentions).toEqual({ parse: [] });
    }
  });

  it("edits a panel without the suppress flag (Discord refuses it on edit), still parsing no mentions", async () => {
    const h = makeHarness(postedState(), { existingMessages: POSTED_MESSAGES });

    await startKeepingRecords(h);

    expect(h.chan.edits.length).toBeGreaterThan(0);
    for (const { payload } of h.chan.edits) {
      const edit = payload as Sent;
      expect((edit.flags ?? 0) & MessageFlags.SuppressNotifications).toBe(0);
      expect(edit.allowedMentions).toEqual({ parse: [] });
    }
  });
});

// ── switch groups ────────────────────────────────────────────────────────────

describe("adapter: switch groups", () => {
  const TURRET_A = 11;
  const TURRET_B = 12;
  const TURRET_C = 13;
  const GROUP_ID = "g1";

  /** The posted panel, plus three turrets; `members` of them form the group "Turrets". */
  function groupState(members: number[] = [TURRET_A, TURRET_B, TURRET_C]): CoreState {
    const base = postedState({ config: makeConfig({ loggingChannelId: "log-chan" }) });
    return {
      ...base,
      servers: [
        makeServer(SERVER_ID, {
          panelMessageIds: structuredClone(POSTED_IDS),
          switchGroups: [{ id: GROUP_ID, name: "Turrets", entityIds: members }],
        }),
      ],
      entities: [
        ...base.entities,
        makeEntity(TURRET_A, "switch", { label: "Turret A" }),
        makeEntity(TURRET_B, "switch", { label: "Turret B", autoAction: "off" }),
        makeEntity(TURRET_C, "switch", { label: "Turret C" }),
      ],
    };
  }

  async function groupHarness(members?: number[]) {
    const h = makeHarness(groupState(members), { existingMessages: POSTED_MESSAGES });
    await h.start();
    const handles = h.adapter.handleRegistry;
    const serverHandle = handles.register(SERVER_ID);
    const groupHandle = handles.register(HandleRegistry.groupKey(SERVER_ID, GROUP_ID));
    const memberHandle = (entityId: number) =>
      handles.register(HandleRegistry.entityKey(SERVER_ID, entityId));
    const groupId = (action: string) =>
      buildCustomId({ domain: "group", action, server: serverHandle, entity: groupHandle });
    const seed = (entityId: number, value: boolean) =>
      h.adapter.stateLockMachine.seed({ serverId: SERVER_ID, entityId }, value);
    const lock = (entityId: number) =>
      h.adapter.stateLockMachine.snapshot({ serverId: SERVER_ID, entityId });
    const changed = (entityId: number, value: boolean) =>
      h.core.emit("entityChanged", { serverId: SERVER_ID, change: { entityId, value, items: [] } });
    const switchesMessage = (): string => h.chan.editsTo("sw-1").at(-1) ?? "";
    return {
      ...h,
      serverHandle,
      groupHandle,
      memberHandle,
      groupId,
      seed,
      lock,
      changed,
      switchesMessage,
    };
  }

  it("shows the group as one row, and only ungrouped switches get rows of their own", async () => {
    const h = await groupHarness();
    h.changed(TURRET_A, true); // a broadcast repaints the Switches message
    await h.settle();

    const message = h.switchesMessage();
    expect(message).toContain("🔌 **Turrets** (3) · 🟡 1/3 on");
    expect(message).toContain("Front Door** · ");
    expect(message).not.toContain("Turret A** · ");
    expect(rowButton(message, "Turrets").label).toBe("Turn on");
  });

  it("Turn on actuates each member through its own lock, one after another, skipping members already on", async () => {
    const h = await groupHarness();
    h.seed(TURRET_A, true);
    const click = makeClick(h.groupId("on"), { roles: ["USER"] });

    await h.adapter.dispatch(click.interaction);

    expect(click.order()).toEqual(["deferUpdate"]);
    expect(h.core.callsTo("toggleEntity")).toEqual([
      [SERVER_ID, TURRET_B, true],
      [SERVER_ID, TURRET_C, true],
    ]);
    expect(h.lock(TURRET_A)?.phase).toBe("synced");
    expect(h.lock(TURRET_B)).toMatchObject({ phase: "pending", requested: true });
    expect(h.switchesMessage()).toContain("Turrets** (3) · ⏳ Switching on…");

    h.changed(TURRET_B, true);
    h.changed(TURRET_C, true);
    await h.settle();

    expect(h.switchesMessage()).toContain("Turrets** (3) · 🟢 On");
    expect(rowButton(h.switchesMessage(), "Turrets").label).toBe("Turn off");
    // One audit line for the group action, none per member.
    expect(h.chan.lines().filter((l) => l.includes("Turret"))).toEqual([
      '[14:03:05] 🔘 <@U1> toggled group "Turrets" (3) → ON',
    ]);
  });

  it("a member that fails restores its own prior value; the others go on; the clicker is told once, ack-safely", async () => {
    const h = await groupHarness();
    h.seed(TURRET_A, false);
    h.seed(TURRET_B, false);
    h.seed(TURRET_C, false);
    h.core.toggleFailures.set(TURRET_B, namedError("EntityNotFoundError"));
    // The server cannot be read either: the failed member falls back to its prior value.
    h.core.failWith("getEntity", namedError("ConnectionError"));
    const click = makeGatewayInteraction({ customId: h.groupId("on"), roles: ["USER"] });

    await h.adapter.onInteraction(click.interaction);

    expect(h.core.callsTo("toggleEntity")).toEqual([
      [SERVER_ID, TURRET_A, true],
      [SERVER_ID, TURRET_B, true],
      [SERVER_ID, TURRET_C, true],
    ]);
    expect(h.lock(TURRET_B)).toEqual({ phase: "synced", value: false, buttonsDisabled: false });
    expect(h.lock(TURRET_A)?.phase).toBe("pending");
    expect(h.lock(TURRET_C)?.phase).toBe("pending");
    expect(click.order()).toEqual(["deferUpdate", "followUp"]);
    expect(click.payloads("followUp")[0]?.content).toBe(
      `⚠️ 1 of 3 switches in "Turrets" didn't switch: Turret B.\n${ENTITY_NOT_FOUND_MESSAGE}`,
    );
    expect(h.log.fields("info", "interaction handled")).toEqual([
      expect.objectContaining({
        domain: "group",
        action: "on",
        groupId: GROUP_ID,
        outcome: "failed",
      }),
    ]);

    // The others confirm: the group shows what the members really are.
    h.changed(TURRET_A, true);
    h.changed(TURRET_C, true);
    await h.settle();
    expect(h.switchesMessage()).toContain("Turrets** (3) · 🟡 2/3 on");
  });

  it("an unknown group offers Refresh, which re-reads every member", async () => {
    const h = await groupHarness([TURRET_A, TURRET_B]);
    h.adapter.stateLockMachine.forget({ serverId: SERVER_ID, entityId: TURRET_A });
    h.core.entityValue = true;
    const click = makeClick(h.groupId("refresh"), { roles: ["USER"] });

    await h.adapter.dispatch(click.interaction);

    expect(h.core.callsTo("getEntity")).toEqual([
      [SERVER_ID, TURRET_A],
      [SERVER_ID, TURRET_B],
    ]);
    expect(h.switchesMessage()).toContain("Turrets** (2) · 🟢 On");
  });

  it("a stale group button says so instead of acting", async () => {
    const h = await groupHarness();
    h.state.servers[0]!.switchGroups = [];
    const click = makeClick(h.groupId("on"), { roles: ["USER"] });

    await h.adapter.dispatch(click.interaction);

    expect(click.texts()).toEqual([STALE_STATE_MESSAGE]);
    expect(h.core.callsTo("toggleEntity")).toEqual([]);
  });

  it("the group's panel is admin-only; its row's action is a user's", async () => {
    const h = await groupHarness();
    const panel = makeClick(h.groupId("members"), { roles: ["USER"] });

    await h.adapter.dispatch(panel.interaction);

    expect(panel.texts()).toEqual([DENIAL_MESSAGE]);
  });

  it("choosing the group in Manage a switch… opens its panel, which follows its members' states", async () => {
    const h = await groupHarness();
    h.seed(TURRET_A, false);
    const edits: string[] = [];
    const manage = makeClick(h.id("switch", "manage", SERVER_ID), {
      roles: ["ADMIN"],
      kind: "stringSelect",
      values: [h.groupHandle],
    });
    manage.interaction.replyEphemeralPanel = async (payload) => {
      manage.acks.push({ via: "replyEphemeralPanel", payload });
      return {
        editPanel: async (p) => {
          edits.push(JSON.stringify(p));
        },
        delete: async () => {},
      };
    };

    await h.adapter.dispatch(manage.interaction);

    expect(manage.order()).toEqual(["replyEphemeralPanel"]);
    const shown = JSON.stringify(manage.payloads("replyEphemeralPanel")[0]);
    expect(heading(manage.payloads("replyEphemeralPanel")[0])).toBe("## 🔌 Turrets");
    expect(shown).toContain("Turret A** · 🔴 Off");
    expect(shown).toContain("-# auto-off after 300s"); // Turret B's own auto-revert

    h.changed(TURRET_A, true);
    await flush();
    expect(edits.at(-1)).toContain("Turret A** · 🟢 On");
  });

  it("creates a group: New group… → name modal → member picker → the group's panel and row", async () => {
    const h = await groupHarness([TURRET_A, TURRET_B]);
    const manage = makeClick(h.id("switch", "manage", SERVER_ID), {
      roles: ["ADMIN"],
      kind: "stringSelect",
      values: [NEW_GROUP_OPTION],
    });
    await h.adapter.dispatch(manage.interaction);
    const modal = manage.payloads("showModal")[0] as { custom_id: string };
    expect(modal.custom_id).toBe(
      buildCustomId({ domain: "group", action: "create", server: h.serverHandle }),
    );

    // The name: answered at once with the member picker (one acknowledgement).
    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: modal.custom_id,
      roles: ["ADMIN"],
      fields: { name: " Lights " },
    });
    await h.adapter.onInteraction(submit.interaction);
    expect(submit.order()).toEqual(["reply"]);
    const picker = submit.payloads("reply")[0]!;
    expect(isEphemeral(picker.flags)).toBe(true);
    const pickerJson = JSON.stringify(picker.components);
    // Only switches in no group are offered.
    expect(pickerJson).toContain("Front Door");
    expect(pickerJson).toContain("Turret C");
    expect(pickerJson).not.toContain("Turret A");
    expect(h.core.callsTo("createSwitchGroup")).toEqual([]);

    // The members: the group is created and shown in place, and gets its row.
    const selectId = /conduit:v1:group:create-members:[^"]+/.exec(pickerJson)![0];
    const pick = makeClick(selectId, {
      roles: ["ADMIN"],
      kind: "stringSelect",
      values: [h.memberHandle(TURRET_C), h.memberHandle(SWITCH_ID)],
    });
    await h.adapter.dispatch(pick.interaction);

    expect(h.core.callsTo("createSwitchGroup")).toEqual([
      [SERVER_ID, "Lights", [TURRET_C, SWITCH_ID]],
    ]);
    expect(pick.order()).toEqual(["update"]);
    expect(heading(pick.payloads("update")[0])).toBe("## 🔌 Lights");
    expect(h.switchesMessage()).toContain("**Lights** (2)");
    expect(h.switchesMessage()).not.toContain("Front Door** · ");

    // The draft is used up: picking again says the form expired.
    const again = makeClick(selectId, {
      roles: ["ADMIN"],
      kind: "stringSelect",
      values: [h.memberHandle(TURRET_C)],
    });
    await h.adapter.dispatch(again.interaction);
    expect(JSON.stringify(again.payloads("update")[0])).toContain("This form has expired");
  });

  it("New group… says so when every switch is already in a group", async () => {
    const h = await groupHarness();
    h.state.servers[0]!.switchGroups![0]!.entityIds.push(SWITCH_ID);
    const manage = makeClick(h.id("switch", "manage", SERVER_ID), {
      roles: ["ADMIN"],
      kind: "stringSelect",
      values: [NEW_GROUP_OPTION],
    });

    await h.adapter.dispatch(manage.interaction);

    expect(manage.order()).toEqual(["replyEphemeral"]);
    expect(String(manage.texts()[0])).toContain("already in a group");
  });

  it("renames through a prefilled modal, acknowledged before bot-core", async () => {
    const h = await groupHarness();
    const button = makeClick(h.groupId("rename"), { roles: ["ADMIN"] });
    await h.adapter.dispatch(button.interaction);
    const modal = JSON.stringify(button.payloads("showModal")[0]);
    expect(modal).toContain('"value":"Turrets"');

    const submit = makeGatewayInteraction({
      kind: "modalSubmit",
      customId: h.groupId("rename"),
      roles: ["ADMIN"],
      fields: { name: "Gate turrets" },
    });
    await h.adapter.onInteraction(submit.interaction);

    expect(submit.order()).toEqual(["deferReply", "editReply"]);
    expect(h.core.callsTo("renameSwitchGroup")).toEqual([[SERVER_ID, GROUP_ID, "Gate turrets"]]);
    expect(h.switchesMessage()).toContain("**Gate turrets** (3)");
  });

  it("edits members: current members are picked already, and freed switches get their rows back", async () => {
    const h = await groupHarness([TURRET_A, TURRET_B]);
    const edit = makeClick(h.groupId("members"), { roles: ["ADMIN"] });
    await h.adapter.dispatch(edit.interaction);
    const picker = JSON.stringify(edit.payloads("update")[0]);
    const options = /"options":(\[.*?\])/.exec(picker)![1]!;
    expect(
      JSON.parse(options).map((o: { label: string; default?: boolean }) => [o.label, o.default]),
    ).toEqual([
      ["Turret A", true],
      ["Turret B", true],
      ["Front Door", false],
      ["Turret C", false],
    ]);

    const set = makeClick(h.groupId("setmembers"), {
      roles: ["ADMIN"],
      kind: "stringSelect",
      values: [h.memberHandle(TURRET_A), h.memberHandle(TURRET_C)],
    });
    await h.adapter.dispatch(set.interaction);

    expect(h.core.callsTo("setSwitchGroupMembers")).toEqual([
      [SERVER_ID, GROUP_ID, [TURRET_A, TURRET_C]],
    ]);
    expect(set.order()).toEqual(["update"]);
    expect(h.switchesMessage()).toContain("**Turrets** (2)");
    expect(h.switchesMessage()).toContain("Turret B** · ");
  });

  it("deletes after a confirmation; its switches get their own rows again", async () => {
    const h = await groupHarness();
    const ask = makeClick(h.groupId("delete"), { roles: ["ADMIN"] });
    await h.adapter.dispatch(ask.interaction);
    expect(JSON.stringify(ask.payloads("update")[0])).toContain("Delete this group?");

    const confirm = makeClick(h.groupId("delete-confirm"), { roles: ["ADMIN"] });
    await h.adapter.dispatch(confirm.interaction);

    expect(h.core.callsTo("deleteSwitchGroup")).toEqual([[SERVER_ID, GROUP_ID]]);
    expect(JSON.stringify(confirm.payloads("update")[0])).toContain(
      "Deleted the group **Turrets**",
    );
    expect(h.switchesMessage()).not.toContain("Turrets**");
    expect(h.switchesMessage()).toContain("Turret A** · ");
  });

  it("removing a member device takes it off the group's row; the last one takes the row away", async () => {
    const h = await groupHarness([TURRET_A, TURRET_B]);
    const remove = (entityId: number) => {
      // What bot-core's removeEntity does before it emits entityRemoved.
      h.state.entities = h.state.entities.filter((e) => e.entityId !== entityId);
      const group = h.state.servers[0]!.switchGroups![0]!;
      group.entityIds = group.entityIds.filter((id) => id !== entityId);
      if (group.entityIds.length === 0) h.state.servers[0]!.switchGroups = [];
      h.core.emit("entityRemoved", { serverId: SERVER_ID, entityId });
    };

    remove(TURRET_A);
    await flush();
    expect(h.switchesMessage()).toContain("**Turrets** (1)");
    expect(h.lock(TURRET_A)).toBeUndefined();

    remove(TURRET_B);
    await flush();
    expect(h.switchesMessage()).not.toContain("Turrets");
    expect(h.switchesMessage()).toContain("Turret C** · ");
  });
});
