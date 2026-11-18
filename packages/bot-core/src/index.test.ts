import { EventEmitter } from "node:events";

import { describe, it, expect, vi } from "vitest";

import {
  BotCore,
  InMemoryStateStore,
  severityToPriority,
  type AppConfig,
  type Logger,
  type PairedEntity,
  type PairedServer,
  type PushoverNotifier,
  type StoredCredentials,
} from "./index.js";
import type {
  EntityChange,
  EntityInfo,
  PairingNotification,
  AlarmNotification,
  DeathNotification,
  FcmCredentials,
  TeamChatMessage,
} from "./index.js";

// ── fakes ────────────────────────────────────────────────────────────────────

/** A fake RustPlusClient: EventEmitter + spied protocol methods. */
class FakeClient extends EventEmitter {
  connected = false;
  constructor() {
    super();
    // Mirror the real client: any disconnect (method-driven or a dropped socket
    // surfaced via the event) flips the connection state.
    this.on("disconnected", () => {
      this.connected = false;
    });
  }
  connect = vi.fn(async () => {
    this.connected = true;
    this.emit("connected");
  });
  disconnect = vi.fn(async () => {
    this.emit("disconnected", { code: 1000, reason: "bye" });
  });
  setEntityValue = vi.fn(async (_id: number, _on: boolean) => {});
  getEntityInfo = vi.fn(async (entityId: number): Promise<EntityInfo> => ({
    entityId,
    type: "switch",
    value: false,
    items: [],
  }));
  untrackEntity = vi.fn((_entityId: number): void => {});
  getInfo = vi.fn(async () => ({ name: "srv" }) as never);
  getTeamInfo = vi.fn(async () => ({ leaderSteamId: "1", members: [] }));
  sendTeamMessage = vi.fn(async (_m: string) => {});
  getCameraFrame = vi.fn(async () => new Uint8Array([1, 2, 3]));
}

/**
 * A controllable one-shot timer source. Records armed callbacks so tests can
 * assert how many are pending and fire them deterministically — no real clocks.
 */
class FakeTimers {
  private seq = 0;
  readonly pending = new Map<number, () => void>();
  setTimer = (cb: () => void, _ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, cb);
    return id;
  };
  clearTimer = (h: unknown): void => {
    this.pending.delete(h as number);
  };
  get armed(): number {
    return this.pending.size;
  }
  /** Fire every currently-pending callback once, then drain microtasks. */
  async flush(): Promise<void> {
    const cbs = [...this.pending.values()];
    this.pending.clear();
    for (const cb of cbs) cb();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
}

/** A fake FcmService: just an EventEmitter with stubbed lifecycle methods. */
class FakeFcm extends EventEmitter {
  startListening = vi.fn(async (_c: FcmCredentials, _ids?: string[]) => {});
  stopListening = vi.fn(async () => {});
  refresh = vi.fn(async (c: FcmCredentials): Promise<FcmCredentials> => ({
    ...c,
    steamAuthToken: "rotated",
    steamTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  }));
}

function makeFcmCreds(): FcmCredentials {
  return {
    fcm: {},
    gcm: {},
    expoPushToken: "ExponentPushToken[x]",
    steamAuthToken: "steam",
    steamTokenExpiresAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeStoredCreds(): StoredCredentials {
  return {
    fcm: makeFcmCreds(),
    discordBotToken: "bot",
    steamTokenExpiresAt: "2026-07-01T00:00:00.000Z",
  };
}

const SERVER: PairedServer = {
  id: "srv-1",
  name: "My Server",
  desc: "d",
  ip: "1.2.3.4",
  port: 28017,
  playerId: "76561198000000000",
  playerToken: "tok",
  addedAt: "2026-06-01T00:00:00.000Z",
};

interface Seed {
  config?: AppConfig;
  servers?: PairedServer[];
  entities?: PairedEntity[];
  credentials?: StoredCredentials;
  persistentIds?: string[];
}

function setup(
  seed?: Seed,
  opts?: { pushover?: PushoverNotifier; logger?: Logger; timers?: FakeTimers },
) {
  const store = new InMemoryStateStore(seed);
  const fcm = new FakeFcm();
  const fake = new FakeClient();
  const clientFactory = vi.fn(() => fake as never);
  const timers = opts?.timers;
  const core = new BotCore(store, fcm as never, {
    clientFactory,
    pairingTimeoutMs: 50,
    pushover: opts?.pushover,
    logger: opts?.logger,
    timers,
  });
  return { store, fcm, fake, clientFactory, core, timers };
}

describe("InMemoryStateStore.clear", () => {
  it("resets config, servers, entities, credentials, and persistent ids", async () => {
    const store = new InMemoryStateStore({
      config: {
        startOnLogin: true,
        controlChannelId: "chan",
        roleCapabilities: { admin: ["r1"], user: ["r2"] },
      },
      servers: [
        {
          id: "srv",
          name: "Srv",
          desc: "",
          ip: "1.1.1.1",
          port: 1,
          playerId: "0",
          playerToken: "0",
          addedAt: "",
        },
      ],
      entities: [{ serverId: "srv", entityId: 1, entityType: "switch" }],
      persistentIds: ["id1"],
    });

    await store.clear();

    expect(store.listServers()).toEqual([]);
    expect(store.listEntities("srv")).toEqual([]);
    expect(await store.getPersistentIds()).toEqual([]);
    expect(await store.getCredentials()).toBeUndefined();
    expect(store.getConfig().controlChannelId).toBeUndefined();
  });
});

describe("@conduit/bot-core", () => {
  // ── pairing ──────────────────────────────────────────────────────────────
  it("fcm serverPairing → PairedServer persisted + serverPaired emitted", async () => {
    const { store, fcm, core } = setup();
    await core.start();

    const seen: PairedServer[] = [];
    core.on("serverPaired", (s) => seen.push(s));

    const push: PairingNotification = {
      type: "server",
      ip: "5.6.7.8",
      port: 28017,
      name: "Paired",
      desc: "desc",
      id: "uuid-1",
      playerId: "765",
      playerToken: "ptok",
    };
    fcm.emit("serverPairing", push);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(store.getServer("uuid-1")?.name).toBe("Paired");
    expect(seen[0]!.ip).toBe("5.6.7.8");
  });

  it("fcm entityPairing → PairedEntity persisted + entityPaired emitted", async () => {
    const { store, fcm, core } = setup({ servers: [SERVER] });
    await core.start();

    const seen: PairedEntity[] = [];
    core.on("entityPaired", (e) => seen.push(e));

    const push: PairingNotification = {
      type: "entity",
      ip: SERVER.ip,
      port: SERVER.port,
      name: SERVER.name,
      desc: SERVER.desc,
      id: SERVER.id,
      playerId: SERVER.playerId,
      playerToken: SERVER.playerToken,
      entityId: 9090,
      entityType: 1,
    };
    fcm.emit("entityPairing", push);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    const stored = store.getEntity(SERVER.id, 9090);
    expect(stored?.entityType).toBe("switch");
    expect(seen[0]!.entityId).toBe(9090);
  });

  it("addCamera persists a camera entity (negative id) + emits entityPaired", async () => {
    const { store, core } = setup({ servers: [SERVER] });
    await core.start();

    const seen: PairedEntity[] = [];
    core.on("entityPaired", (e) => seen.push(e));

    const entity = await core.addCamera(SERVER.id, "  base_main  ", "Base Cam");
    expect(entity.entityType).toBe("camera");
    expect(entity.identifier).toBe("base_main"); // trimmed
    expect(entity.label).toBe("Base Cam");
    expect(entity.entityId).toBeLessThan(0); // synthetic, won't collide with real ids

    const stored = store.getEntity(SERVER.id, entity.entityId);
    expect(stored?.identifier).toBe("base_main");
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    // Re-adding the same identifier maps to the same entity (stable id), updating it.
    const again = await core.addCamera(SERVER.id, "base_main", "Renamed");
    expect(again.entityId).toBe(entity.entityId);
    expect(store.listEntities(SERVER.id).filter((e) => e.entityType === "camera")).toHaveLength(1);
  });

  it("addCamera rejects an empty identifier and an unknown server", async () => {
    const { core } = setup({ servers: [SERVER] });
    await core.start();
    await expect(core.addCamera(SERVER.id, "   ")).rejects.toThrow(/identifier/i);
    await expect(core.addCamera("nope", "cam")).rejects.toThrow(/unknown server/i);
  });

  // ── connect + event bridge ─────────────────────────────────────────────────
  it("connectServer creates+connects a client; entityChanged bridges to domain event", async () => {
    const { fake, clientFactory, core } = setup({ servers: [SERVER] });
    await core.start();

    const events: { serverId: string; change: EntityChange }[] = [];
    core.on("entityChanged", (e) => events.push(e));

    await core.connectServer(SERVER.id);
    expect(clientFactory).toHaveBeenCalledOnce();
    expect(fake.connect).toHaveBeenCalledOnce();

    const change: EntityChange = { entityId: 5, value: true, items: [] };
    fake.emit("entityChanged", change);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ serverId: SERVER.id, change });
  });

  it("isServerConnected reflects live client state", async () => {
    const { fake, core } = setup({ servers: [SERVER] });
    await core.start();

    // Unknown/never-connected servers report false.
    expect(core.isServerConnected("nope")).toBe(false);
    expect(core.isServerConnected(SERVER.id)).toBe(false);

    await core.connectServer(SERVER.id);
    expect(core.isServerConnected(SERVER.id)).toBe(true);

    fake.emit("disconnected", { code: 1006, reason: "drop" });
    expect(core.isServerConnected(SERVER.id)).toBe(false);
  });

  it("teamChat and serverStatusChanged bridge through", async () => {
    const { fake, core } = setup({ servers: [SERVER] });
    await core.start();

    const chats: TeamChatMessage[] = [];
    const statuses: string[] = [];
    core.on("teamChat", (e) => chats.push(e.message));
    core.on("serverStatusChanged", (e) => statuses.push(e.status));

    await core.connectServer(SERVER.id); // emits connected
    fake.emit("teamChat", {
      steamId: "1",
      name: "Alice",
      message: "hi",
      color: "#fff",
      time: 0,
    });
    fake.emit("disconnected", { code: 1006, reason: "drop" });

    expect(chats.map((c) => c.message)).toEqual(["hi"]);
    expect(statuses).toEqual(["connected", "reconnecting"]);
  });

  // ── toggle + state-lock close path ─────────────────────────────────────────
  it("toggleEntity calls setEntityValue(on) and a later entityChanged flows through", async () => {
    const { fake, core } = setup({ servers: [SERVER] });
    await core.start();
    await core.connectServer(SERVER.id);

    const events: EntityChange[] = [];
    core.on("entityChanged", (e) => events.push(e.change));

    const info = await core.toggleEntity(SERVER.id, 42, true);
    expect(fake.setEntityValue).toHaveBeenCalledWith(42, true);
    expect(info.entityId).toBe(42);

    // tier-3 broadcast that closes the state-lock
    fake.emit("entityChanged", { entityId: 42, value: true, items: [] });
    expect(events).toEqual([{ entityId: 42, value: true, items: [] }]);
  });

  // ── getEntity registers interest (reconnect re-subscribe) ───────────────────
  it("getEntity issues getEntityInfo; reconnect re-subscribes tracked entities", async () => {
    const { fake, core } = setup({ servers: [SERVER] });
    await core.start();
    await core.connectServer(SERVER.id);

    await core.getEntity(SERVER.id, 77);
    expect(fake.getEntityInfo).toHaveBeenCalledWith(77);

    fake.getEntityInfo.mockClear();
    // reconnect: connectServer again on an already-managed client re-registers
    await core.connectServer(SERVER.id);
    expect(fake.getEntityInfo).toHaveBeenCalledWith(77);
  });

  it("registerEntityInterest seeds interest used on reconnect", async () => {
    const { fake, core } = setup({ servers: [SERVER] });
    await core.start();
    await core.connectServer(SERVER.id);
    await core.registerEntityInterest(SERVER.id, 123);
    expect(fake.getEntityInfo).toHaveBeenCalledWith(123);
  });

  // ── config ops persist + round-trip ─────────────────────────────────────────
  it("setControlChannel / setRoleCapabilities persist into AppConfig", async () => {
    const { store, core } = setup();
    await core.start();
    await core.setControlChannel("chan-1");
    await core.setRoleCapabilities({ admin: ["r-admin"], user: ["r-user"] });

    const cfg = store.getConfig();
    expect(cfg.controlChannelId).toBe("chan-1");
    expect(cfg.roleCapabilities).toEqual({
      admin: ["r-admin"],
      user: ["r-user"],
    });
    // survives a fresh read via getConfig
    expect(core.getConfig().controlChannelId).toBe("chan-1");
  });

  it("setLoggingChannel persists into AppConfig independently of the control channel", async () => {
    const { store, core } = setup();
    await core.start();
    await core.setControlChannel("chan-1");
    await core.setLoggingChannel("log-1");

    const cfg = store.getConfig();
    expect(cfg.loggingChannelId).toBe("log-1");
    // does not clobber the control channel
    expect(cfg.controlChannelId).toBe("chan-1");
    expect(core.getConfig().loggingChannelId).toBe("log-1");
  });

  it("setEntityLabel persists onto the PairedEntity", async () => {
    const entity: PairedEntity = {
      serverId: SERVER.id,
      entityId: 5,
      entityType: "switch",
    };
    const { store, core } = setup({ servers: [SERVER], entities: [entity] });
    await core.start();
    await core.setEntityLabel(SERVER.id, 5, "Base Lights");
    expect(store.getEntity(SERVER.id, 5)?.label).toBe("Base Lights");
  });

  // ── panel message ids persist + round-trip ──────────────────────────────────
  it("setServerPanelIds persists the Conduit Panel's ids per message and page, and clears them", async () => {
    const { core, store } = setup({ servers: [SERVER] });
    await core.start();

    const ids = { server: "msg-server", switches: ["sw-1", "sw-2"], storage: ["st-1"] };
    await core.setServerPanelIds(SERVER.id, ids);
    ids.switches.push("mutated-after");

    expect(store.getServer(SERVER.id)?.panelMessageIds).toEqual({
      server: "msg-server",
      switches: ["sw-1", "sw-2"],
      storage: ["st-1"],
    });
    // JSON-serialisable: a JSON round trip is lossless.
    const stored = store.getServer(SERVER.id)!;
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);

    await core.setServerPanelIds(SERVER.id, undefined);
    expect(store.getServer(SERVER.id)?.panelMessageIds).toBeUndefined();
  });

  it("setServerPanelIds throws on an unknown server", async () => {
    const { core } = setup();
    await core.start();
    await expect(core.setServerPanelIds("nope", { server: "m" })).rejects.toThrow();
  });

  it("state from before the Conduit Panel still loads, and its legacy ids clear", async () => {
    const legacyServer: PairedServer = {
      ...SERVER,
      statusPanelMessageId: "old-status",
      teamPanelMessageId: "old-team",
    };
    const entities: PairedEntity[] = [
      { serverId: SERVER.id, entityId: 7, entityType: "switch", panelMessageId: "old-7" },
      { serverId: SERVER.id, entityId: 8, entityType: "alarm", panelMessageId: "old-8" },
    ];
    const { core, store } = setup({ servers: [legacyServer], entities });
    await core.start();
    expect(core.listServers()[0]?.panelMessageIds).toBeUndefined();

    await core.clearLegacyPanelIds(SERVER.id, { status: true, entityIds: [7] });

    expect(store.getServer(SERVER.id)).toMatchObject({ teamPanelMessageId: "old-team" });
    expect(store.getServer(SERVER.id)?.statusPanelMessageId).toBeUndefined();
    expect(store.getEntity(SERVER.id, 7)?.panelMessageId).toBeUndefined();
    expect(store.getEntity(SERVER.id, 8)?.panelMessageId).toBe("old-8");
  });

  it("clearLegacyPanelIds throws on an unknown server", async () => {
    const { core } = setup();
    await core.start();
    await expect(core.clearLegacyPanelIds("nope", { status: true })).rejects.toThrow();
  });

  it("setEntityWatch persists the watchChanges opt-in", async () => {
    const entity: PairedEntity = {
      serverId: SERVER.id,
      entityId: 8,
      entityType: "storageMonitor",
    };
    const { core } = setup({ servers: [SERVER], entities: [entity] });
    await core.start();

    await core.setEntityWatch(SERVER.id, 8, true);
    expect(core.listEntities(SERVER.id)[0]?.watchChanges).toBe(true);

    await core.setEntityWatch(SERVER.id, 8, false);
    expect(core.listEntities(SERVER.id)[0]?.watchChanges).toBe(false);
  });

  it("setEntityWatch throws on an unknown entity", async () => {
    const { core } = setup({ servers: [SERVER] });
    await core.start();
    await expect(core.setEntityWatch(SERVER.id, 404, true)).rejects.toThrow();
  });

  // ── alarm ───────────────────────────────────────────────────────────────────
  it("fcm alarm → alarmTriggered domain event", async () => {
    const { fcm, core } = setup();
    await core.start();
    const seen: AlarmNotification[] = [];
    core.on("alarmTriggered", (a) => seen.push(a));
    const alarm: AlarmNotification = { title: "Raid", message: "incoming" };
    fcm.emit("alarm", alarm);
    expect(seen).toEqual([alarm]);
  });

  // ── pushover ─────────────────────────────────────────────────────────────────
  const ALARM_ENTITY: PairedEntity = {
    serverId: SERVER.id,
    entityId: 7,
    entityType: "alarm",
    label: "Front door",
    pushoverSeverity: "high",
  };

  it("severityToPriority maps low/medium/high to -1/0/1", () => {
    expect(severityToPriority("low")).toBe(-1);
    expect(severityToPriority("medium")).toBe(0);
    expect(severityToPriority("high")).toBe(1);
  });

  it("alarm entityChanged value:true → Pushover send with mapped priority + credentials", async () => {
    const pushover = vi.fn(async () => {});
    const config: AppConfig = {
      startOnLogin: false,
      roleCapabilities: { admin: [], user: [] },
      pushover: { appToken: "app-tok", userKey: "user-key" },
    };
    const { core, fake } = setup(
      { config, servers: [SERVER], entities: [ALARM_ENTITY] },
      { pushover },
    );
    await core.start();
    await core.connectServer(SERVER.id);

    fake.emit("entityChanged", { entityId: 7, value: true } as EntityChange);
    await vi.waitFor(() => expect(pushover).toHaveBeenCalledTimes(1));
    expect(pushover).toHaveBeenCalledWith(
      expect.objectContaining({
        appToken: "app-tok",
        userKey: "user-key",
        priority: 1,
        title: expect.stringContaining("Front door"),
      }),
    );
  });

  it("does not send Pushover when the alarm clears (value:false)", async () => {
    const pushover = vi.fn(async () => {});
    const config: AppConfig = {
      startOnLogin: false,
      roleCapabilities: { admin: [], user: [] },
      pushover: { appToken: "app-tok", userKey: "user-key" },
    };
    const { core, fake } = setup(
      { config, servers: [SERVER], entities: [ALARM_ENTITY] },
      { pushover },
    );
    await core.start();
    await core.connectServer(SERVER.id);

    fake.emit("entityChanged", { entityId: 7, value: false } as EntityChange);
    expect(pushover).not.toHaveBeenCalled();
  });

  it("alarm with a severity but no credentials skips the send and warns", async () => {
    const pushover = vi.fn(async () => {});
    const warn = vi.fn();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const { core, fake } = setup(
      { servers: [SERVER], entities: [ALARM_ENTITY] }, // no config.pushover
      { pushover, logger },
    );
    await core.start();
    await core.connectServer(SERVER.id);

    fake.emit("entityChanged", { entityId: 7, value: true } as EntityChange);
    expect(pushover).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("does not send Pushover for an alarm without a severity", async () => {
    const pushover = vi.fn(async () => {});
    const config: AppConfig = {
      startOnLogin: false,
      roleCapabilities: { admin: [], user: [] },
      pushover: { appToken: "app-tok", userKey: "user-key" },
    };
    const noSeverity: PairedEntity = { ...ALARM_ENTITY, pushoverSeverity: undefined };
    const { core, fake } = setup(
      { config, servers: [SERVER], entities: [noSeverity] },
      { pushover },
    );
    await core.start();
    await core.connectServer(SERVER.id);

    fake.emit("entityChanged", { entityId: 7, value: true } as EntityChange);
    expect(pushover).not.toHaveBeenCalled();
  });

  it("set/clear Pushover credentials toggles isPushoverConfigured", async () => {
    const { core } = setup();
    await core.start();
    expect(core.isPushoverConfigured()).toBe(false);

    await core.setPushoverCredentials("app-tok", "user-key");
    expect(core.isPushoverConfigured()).toBe(true);
    expect(core.getConfig().pushover).toEqual({ appToken: "app-tok", userKey: "user-key" });

    await core.clearPushoverCredentials();
    expect(core.isPushoverConfigured()).toBe(false);
    expect(core.getConfig().pushover).toBeUndefined();
  });

  it("setAlarmPushoverSeverity sets and clears the severity", async () => {
    const entity: PairedEntity = { serverId: SERVER.id, entityId: 7, entityType: "alarm" };
    const { core } = setup({ servers: [SERVER], entities: [entity] });
    await core.start();

    await core.setAlarmPushoverSeverity(SERVER.id, 7, "medium");
    expect(core.listEntities(SERVER.id)[0]?.pushoverSeverity).toBe("medium");

    await core.setAlarmPushoverSeverity(SERVER.id, 7, null);
    expect(core.listEntities(SERVER.id)[0]?.pushoverSeverity).toBeUndefined();
  });

  it("setAlarmPushoverSeverity throws for a non-alarm entity", async () => {
    const sw: PairedEntity = { serverId: SERVER.id, entityId: 9, entityType: "switch" };
    const { core } = setup({ servers: [SERVER], entities: [sw] });
    await core.start();
    await expect(core.setAlarmPushoverSeverity(SERVER.id, 9, "high")).rejects.toThrow();
  });

  it("setAlarmNotificationLevel sets and clears the level", async () => {
    const entity: PairedEntity = { serverId: SERVER.id, entityId: 7, entityType: "alarm" };
    const { core } = setup({ servers: [SERVER], entities: [entity] });
    await core.start();

    await core.setAlarmNotificationLevel(SERVER.id, 7, "everyone");
    expect(core.listEntities(SERVER.id)[0]?.notificationLevel).toBe("everyone");

    await core.setAlarmNotificationLevel(SERVER.id, 7, null);
    expect(core.listEntities(SERVER.id)[0]?.notificationLevel).toBeUndefined();
  });

  it("setAlarmNotificationLevel throws for a non-alarm entity", async () => {
    const sw: PairedEntity = { serverId: SERVER.id, entityId: 9, entityType: "switch" };
    const { core } = setup({ servers: [SERVER], entities: [sw] });
    await core.start();
    await expect(core.setAlarmNotificationLevel(SERVER.id, 9, "active")).rejects.toThrow();
  });

  // ── switch auto-revert ──────────────────────────────────────────────────────
  it("setSwitchAutoAction / setSwitchAutoDelaySeconds persist and clear", async () => {
    const sw: PairedEntity = { serverId: SERVER.id, entityId: 5, entityType: "switch" };
    const { core } = setup({ servers: [SERVER], entities: [sw] });
    await core.start();

    await core.setSwitchAutoAction(SERVER.id, 5, "off");
    expect(core.listEntities(SERVER.id)[0]?.autoAction).toBe("off");
    await core.setSwitchAutoDelaySeconds(SERVER.id, 5, 600);
    expect(core.listEntities(SERVER.id)[0]?.autoActionDelaySeconds).toBe(600);

    await core.setSwitchAutoAction(SERVER.id, 5, null);
    expect(core.listEntities(SERVER.id)[0]?.autoAction).toBeUndefined();
  });

  it("switch setters throw for a non-switch entity", async () => {
    const alarm: PairedEntity = { serverId: SERVER.id, entityId: 7, entityType: "alarm" };
    const { core } = setup({ servers: [SERVER], entities: [alarm] });
    await core.start();
    await expect(core.setSwitchAutoAction(SERVER.id, 7, "off")).rejects.toThrow();
    await expect(core.setSwitchAutoDelaySeconds(SERVER.id, 7, 60)).rejects.toThrow();
  });

  it("setSwitchAutoDelaySeconds rejects out-of-range values", async () => {
    const sw: PairedEntity = { serverId: SERVER.id, entityId: 5, entityType: "switch" };
    const { core } = setup({ servers: [SERVER], entities: [sw] });
    await core.start();
    await expect(core.setSwitchAutoDelaySeconds(SERVER.id, 5, 29)).rejects.toThrow();
    await expect(core.setSwitchAutoDelaySeconds(SERVER.id, 5, 3601)).rejects.toThrow();
    await expect(core.setSwitchAutoDelaySeconds(SERVER.id, 5, 60.5)).rejects.toThrow();
  });

  it("auto-off: entityChanged ON arms a timer that flips the switch OFF", async () => {
    const timers = new FakeTimers();
    const sw: PairedEntity = {
      serverId: SERVER.id,
      entityId: 5,
      entityType: "switch",
      autoAction: "off",
      autoActionDelaySeconds: 60,
    };
    const { fake, core } = setup({ servers: [SERVER], entities: [sw] }, { timers });
    await core.start();
    await core.connectServer(SERVER.id);

    // Switch turns ON → arm.
    fake.emit("entityChanged", { entityId: 5, value: true } as EntityChange);
    expect(timers.armed).toBe(1);

    // Fire the timer → it forces the switch OFF.
    await timers.flush();
    expect(fake.setEntityValue).toHaveBeenCalledWith(5, false);
  });

  it("auto-off: entityChanged OFF clears a pending timer (no fire)", async () => {
    const timers = new FakeTimers();
    const sw: PairedEntity = {
      serverId: SERVER.id,
      entityId: 5,
      entityType: "switch",
      autoAction: "off",
      autoActionDelaySeconds: 60,
    };
    const { fake, core } = setup({ servers: [SERVER], entities: [sw] }, { timers });
    await core.start();
    await core.connectServer(SERVER.id);

    fake.emit("entityChanged", { entityId: 5, value: true } as EntityChange);
    expect(timers.armed).toBe(1);
    // Switch returns OFF (manually or via the revert) → disarm.
    fake.emit("entityChanged", { entityId: 5, value: false } as EntityChange);
    expect(timers.armed).toBe(0);
  });

  it("the post-revert broadcast does not re-arm (no loop)", async () => {
    const timers = new FakeTimers();
    const sw: PairedEntity = {
      serverId: SERVER.id,
      entityId: 5,
      entityType: "switch",
      autoAction: "off",
      autoActionDelaySeconds: 60,
    };
    const { fake, core } = setup({ servers: [SERVER], entities: [sw] }, { timers });
    await core.start();
    await core.connectServer(SERVER.id);

    fake.emit("entityChanged", { entityId: 5, value: true } as EntityChange);
    await timers.flush(); // fires → setEntityValue(5,false)
    // The server echoes the revert as a fresh broadcast at the target state.
    fake.emit("entityChanged", { entityId: 5, value: false } as EntityChange);
    expect(timers.armed).toBe(0);
  });

  it("arm-immediately: enabling auto-off on an already-ON switch arms now", async () => {
    const timers = new FakeTimers();
    const sw: PairedEntity = { serverId: SERVER.id, entityId: 5, entityType: "switch" };
    const { fake, core } = setup({ servers: [SERVER], entities: [sw] }, { timers });
    fake.getEntityInfo.mockResolvedValue({ entityId: 5, type: "switch", value: true, items: [] });
    await core.start();
    await core.connectServer(SERVER.id);

    await core.setSwitchAutoAction(SERVER.id, 5, "off");
    expect(timers.armed).toBe(1);
  });

  it("arm-on-connect: a switch already in its trigger state arms on reconnect", async () => {
    const timers = new FakeTimers();
    const sw: PairedEntity = {
      serverId: SERVER.id,
      entityId: 5,
      entityType: "switch",
      autoAction: "off",
      autoActionDelaySeconds: 60,
    };
    const { fake, core } = setup({ servers: [SERVER], entities: [sw] }, { timers });
    fake.getEntityInfo.mockResolvedValue({ entityId: 5, type: "switch", value: true, items: [] });
    await core.start();
    await core.connectServer(SERVER.id); // reregisterInterest sees value:true → arm
    expect(timers.armed).toBe(1);
  });

  it("removeEntity drops the entity, clears its timer, and emits entityRemoved", async () => {
    const timers = new FakeTimers();
    const sw: PairedEntity = {
      serverId: SERVER.id,
      entityId: 5,
      entityType: "switch",
      autoAction: "off",
      autoActionDelaySeconds: 60,
    };
    const { store, fake, core } = setup({ servers: [SERVER], entities: [sw] }, { timers });
    await core.start();
    await core.connectServer(SERVER.id);

    // Arm a timer so we can prove removal clears it.
    fake.emit("entityChanged", { entityId: 5, value: true } as EntityChange);
    expect(timers.armed).toBe(1);

    const removed: Array<{ serverId: string; entityId: number }> = [];
    core.on("entityRemoved", (e) => removed.push(e));

    await core.removeEntity(SERVER.id, 5);

    expect(store.getEntity(SERVER.id, 5)).toBeUndefined();
    expect(timers.armed).toBe(0);
    expect(removed).toEqual([{ serverId: SERVER.id, entityId: 5 }]);
    // The client stops re-subscribing it on its own reconnects.
    expect(fake.untrackEntity).toHaveBeenCalledWith(5);
  });

  it("removeEntity no-ops on an unknown entity (no event)", async () => {
    const { core } = setup({ servers: [SERVER] });
    await core.start();
    const removed: unknown[] = [];
    core.on("entityRemoved", (e) => removed.push(e));
    await core.removeEntity(SERVER.id, 999);
    expect(removed).toEqual([]);
  });

  it("onEntityPairing preserves a switch's auto-revert settings on re-pair", async () => {
    const sw: PairedEntity = {
      serverId: SERVER.id,
      entityId: 5,
      entityType: "switch",
      autoAction: "on",
      autoActionDelaySeconds: 120,
    };
    const { fcm, core } = setup({ servers: [SERVER], entities: [sw] });
    await core.start();

    const pairing: PairingNotification = {
      type: "entity",
      id: SERVER.id,
      name: SERVER.name,
      desc: SERVER.desc,
      ip: SERVER.ip,
      port: SERVER.port,
      playerId: SERVER.playerId,
      playerToken: SERVER.playerToken,
      entityId: 5,
      entityType: 1, // switch
    };
    fcm.emit("entityPairing", pairing);
    await vi.waitFor(() => expect(core.listEntities(SERVER.id)[0]?.autoAction).toBe("on"));

    const entity = core.listEntities(SERVER.id)[0];
    expect(entity?.autoAction).toBe("on");
    expect(entity?.autoActionDelaySeconds).toBe(120);
  });

  // ── death ─────────────────────────────────────────────────────────────────
  it("fcm death → playerDeath domain event", async () => {
    const { fcm, core } = setup();
    await core.start();
    const seen: DeathNotification[] = [];
    core.on("playerDeath", (d) => seen.push(d));
    const death: DeathNotification = {
      name: "Survivor",
      message: "was killed by a bear",
    };
    fcm.emit("death", death);
    expect(seen).toEqual([death]);
  });

  it("an undecodable fcm push does not crash (error is absorbed)", async () => {
    const { fcm, core } = setup();
    await core.start();
    // No "error" listener registered by the test: bot-core must have one, else
    // Node's EventEmitter rethrows and this would throw.
    expect(() => fcm.emit("error", new Error("unrecognised"))).not.toThrow();
  });

  // ── start() rehydration ─────────────────────────────────────────────────────
  it("start() rehydrates servers/entities/config from a pre-seeded store", async () => {
    const config: AppConfig = {
      controlChannelId: "seeded-chan",
      startOnLogin: true,
      roleCapabilities: { admin: ["a"], user: ["u"] },
    };
    const entity: PairedEntity = {
      serverId: SERVER.id,
      entityId: 1,
      entityType: "alarm",
      label: "Door",
    };
    const { core } = setup({ config, servers: [SERVER], entities: [entity] });
    await core.start();

    expect(core.listServers().map((s) => s.id)).toEqual([SERVER.id]);
    expect(core.listEntities(SERVER.id).map((e) => e.label)).toEqual(["Door"]);
    expect(core.getConfig().controlChannelId).toBe("seeded-chan");
  });

  // ── pairing flow arms the listener ──────────────────────────────────────────
  it("beginPairing arms fcm listener with stored creds + persistentIds, resolves on pairing", async () => {
    const { fcm, core } = setup({
      credentials: makeStoredCreds(),
      persistentIds: ["old-1"],
    });
    await core.start();

    const p = core.beginPairing();
    await vi.waitFor(() =>
      expect(fcm.startListening).toHaveBeenCalledWith(
        expect.objectContaining({ steamAuthToken: "steam" }),
        ["old-1"],
      ),
    );
    fcm.emit("entityPairing", {
      type: "entity",
      ip: "1",
      port: 1,
      name: "n",
      desc: "d",
      id: "i",
      playerId: "p",
      playerToken: "t",
      entityId: 1,
      entityType: 1,
    });
    await expect(p).resolves.toBeUndefined();
  });

  // ── credential refresh hook ─────────────────────────────────────────────────
  it("refreshCredentials refreshes via fcm, persists, and reconnects clients", async () => {
    const { store, fcm, fake, core } = setup({
      servers: [SERVER],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer(SERVER.id);
    fake.connect.mockClear();

    const out = await core.refreshCredentials();
    expect(fcm.refresh).toHaveBeenCalledOnce();
    expect(out.steamAuthToken).toBe("rotated");
    const persisted = await store.getCredentials();
    expect(persisted?.steamTokenExpiresAt).toBe("2099-01-01T00:00:00.000Z");
    // affected client reconnected
    expect(fake.disconnect).toHaveBeenCalled();
    expect(fake.connect).toHaveBeenCalled();
  });

  // ── stop ─────────────────────────────────────────────────────────────────────
  it("stop disconnects clients and stops the fcm listener", async () => {
    const { fcm, fake, core } = setup({ servers: [SERVER] });
    await core.start();
    await core.connectServer(SERVER.id);
    await core.stop();
    expect(fake.disconnect).toHaveBeenCalled();
    expect(fcm.stopListening).toHaveBeenCalled();
  });

  // ── state-lock timeout constant is surfaced ──────────────────────────────────
  it("exposes a stateLockTimeoutMs for the discord adapter", () => {
    const { core } = setup();
    expect(typeof core.stateLockTimeoutMs).toBe("number");
  });
});
