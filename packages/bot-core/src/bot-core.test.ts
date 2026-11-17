/**
 * Focused suite for the {@link BotCore} coordinator.
 *
 * `index.test.ts` exercises the public surface end to end (one happy path per
 * operation). This file targets the orchestration details that a regression
 * would otherwise only surface indirectly: the typed-error contract, lifecycle
 * resilience, multi-server event fan-out, interest (re-)subscription, the
 * pairing wait, credential refresh, and the auto-revert timer bookkeeping.
 */

import { EventEmitter } from "node:events";

import { AuthError, ConnectionError, EntityNotFoundError } from "@conduit/rustplus-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_RENEWAL_MILESTONES_MS,
  authRenewalMilestone,
  BotCore,
  BotCoreError,
  CameraUnavailableError,
  InMemoryStateStore,
  MAX_PERSISTENT_IDS,
  nextAuthRenewalMilestoneAt,
  StateError,
  SERVER_OFFLINE_GRACE_MS,
  SWITCH_AUTO_DELAY_DEFAULT,
  SWITCH_AUTO_DELAY_MAX,
  SWITCH_AUTO_DELAY_MIN,
  SWITCH_GROUP_MAX_MEMBERS,
  ValidationError,
  type AppConfig,
  type BotCoreEventMap,
  type ClientFactory,
  type EntityChange,
  type EntityInfo,
  type FcmCredentials,
  type Logger,
  type PairedEntity,
  type PairedServer,
  type PairingNotification,
  type PushoverNotifier,
  type StoredCredentials,
  type TeamChatMessage,
  type TimerProvider,
} from "./index.js";

// ── fakes ────────────────────────────────────────────────────────────────────

type ClientOptions = Parameters<ClientFactory>[0];

/**
 * A fake RustPlusClient: an emitter with spied protocol methods. It models the
 * real client's re-subscription contract: every `getEntityInfo` tracks the
 * entity, `untrackEntity` drops it, and an automatic reconnect re-requests
 * whatever is still tracked, unless `resubscribeOnReconnect: false` (bot-core
 * then re-subscribes itself, on `connected`).
 */
class FakeClient extends EventEmitter {
  connected = false;
  route: "companion" | "direct" | undefined = "companion";
  /** Entity ids the client would re-request on an automatic reconnect. */
  readonly tracked = new Set<number>();
  constructor(readonly options: ClientOptions) {
    super();
    this.on("disconnected", () => {
      this.connected = false;
    });
  }
  untrackEntity = vi.fn((entityId: number): void => {
    this.tracked.delete(entityId);
  });
  /** A dropped socket coming back by itself, as the real client's backoff does. */
  async simulateAutoReconnect(): Promise<void> {
    this.emit("disconnected", { code: 1006, reason: "" });
    this.connected = true;
    this.emit("connected");
    if (this.options.resubscribeOnReconnect !== false) {
      for (const entityId of [...this.tracked]) await this.getEntityInfo(entityId);
    }
    await flushMicrotasks();
  }
  connect = vi.fn(async () => {
    this.connected = true;
    this.emit("connected");
  });
  disconnect = vi.fn(async () => {
    this.emit("disconnected", { code: 1000, reason: "bye" });
  });
  setEntityValue = vi.fn(async (_id: number, _on: boolean) => {});
  getEntityInfo = vi.fn(async (entityId: number): Promise<EntityInfo> => {
    this.tracked.add(entityId);
    return { entityId, type: "switch", value: false, items: [] };
  });
  getInfo = vi.fn(async () => ({ name: "srv" }) as never);
  getTime = vi.fn(async () => ({ time: 12 }) as never);
  getTeamInfo = vi.fn(async () => ({ leaderSteamId: "1", members: [] }));
  sendTeamMessage = vi.fn(async (_m: string) => {});
  getCameraFrame = vi.fn(async (_identifier: string, _frame: number) => new Uint8Array([1]));
}

/** A fake FcmService: an emitter with stubbed lifecycle methods. */
class FakeFcm extends EventEmitter {
  startListening = vi.fn(async (_c: FcmCredentials, _ids?: string[]) => {});
  stopListening = vi.fn(async () => {});
  refresh = vi.fn(async (c: FcmCredentials): Promise<FcmCredentials> => ({
    ...c,
    steamAuthToken: "rotated",
    steamTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  }));
  renew = vi.fn(
    async (c: FcmCredentials, opts: { onSteamLogin: (url: string) => Promise<void> }) => {
      await opts.onSteamLogin("https://login.example/");
      const renewed = {
        ...c,
        steamAuthToken: "renewed",
        steamTokenExpiresAt: "2099-02-01T00:00:00.000Z",
      };
      this.emit("credentialsRefreshed", renewed);
      return renewed;
    },
  );
}

/** One-shot timer source that records each armed delay and fires on demand. */
/** The fixed clock every test core reads (a dropped server's `lastSeenAt`). */
const CLOCK_NOW = Date.UTC(2026, 10, 16, 10, 43, 45);

class RecordingTimers implements TimerProvider {
  private seq = 0;
  readonly pending = new Map<number, { cb: () => void; ms: number }>();
  /** Every delay ever armed, in order. */
  readonly armedDelays: number[] = [];
  setTimer = (cb: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { cb, ms });
    this.armedDelays.push(ms);
    return id;
  };
  clearTimer = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  get armed(): number {
    return this.pending.size;
  }
  /** Armed timers other than a dropped server's offline grace timer. */
  get autoReverts(): number {
    return [...this.pending.values()].filter((t) => t.ms !== SERVER_OFFLINE_GRACE_MS).length;
  }
  /** Fire (and consume) every pending callback armed with this delay. */
  fire(ms: number): void {
    for (const [id, timer] of [...this.pending]) {
      if (timer.ms !== ms) continue;
      this.pending.delete(id);
      timer.cb();
    }
  }
  /** Fire every pending callback once, then let the async toggle settle. */
  async fireAll(): Promise<void> {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const { cb } of entries) cb();
    await flushMicrotasks();
  }
}

/** A logger that records warnings so tests can assert a failure was absorbed. */
class CapturingLogger implements Logger {
  readonly warnings: { obj: unknown; msg?: string }[] = [];
  /** Every info/debug line, for the success-path logging. */
  readonly lines: { level: "info" | "debug"; obj: unknown; msg?: string }[] = [];
  debug = (obj: unknown, msg?: string): void => {
    this.lines.push({ level: "debug", obj, msg });
  };
  info = (obj: unknown, msg?: string): void => {
    this.lines.push({ level: "info", obj, msg });
  };
  /** The fields of the `level` line with this message, if one was logged. */
  logged(level: "info" | "debug", msg: string): unknown[] {
    return this.lines.filter((l) => l.level === level && l.msg === msg).map((l) => l.obj);
  }
  error = (): void => {};
  warn = (obj: unknown, msg?: string): void => {
    this.warnings.push({ obj, msg });
  };
  warned(fragment: string): boolean {
    return this.warnings.some((w) => w.msg?.includes(fragment));
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// ── fixture factories ────────────────────────────────────────────────────────

function makeServer(id: string, overrides: Partial<PairedServer> = {}): PairedServer {
  return {
    id,
    name: `Server ${id}`,
    desc: "",
    ip: `10.0.0.${id.length}`,
    port: 28017,
    playerId: "76561198000000000",
    playerToken: `tok-${id}`,
    addedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEntity(
  serverId: string,
  entityId: number,
  overrides: Partial<PairedEntity> = {},
): PairedEntity {
  return { serverId, entityId, entityType: "switch", ...overrides };
}

function makeFcmCreds(overrides: Partial<FcmCredentials> = {}): FcmCredentials {
  return {
    fcm: {},
    gcm: {},
    expoPushToken: "ExponentPushToken[x]",
    steamAuthToken: "steam",
    steamTokenExpiresAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeStoredCreds(): StoredCredentials {
  return {
    fcm: makeFcmCreds(),
    discordBotToken: "bot",
    steamTokenExpiresAt: "2026-07-01T00:00:00.000Z",
  };
}

function makePairing(overrides: Partial<PairingNotification> = {}): PairingNotification {
  return {
    type: "server",
    id: "a",
    name: "Server a",
    desc: "",
    ip: "10.0.0.1",
    port: 28017,
    playerId: "76561198000000000",
    playerToken: "tok-a",
    ...overrides,
  } as PairingNotification;
}

function change(entityId: number, value: boolean): EntityChange {
  return { entityId, value, items: [] };
}

interface Seed {
  config?: AppConfig;
  servers?: PairedServer[];
  entities?: PairedEntity[];
  credentials?: StoredCredentials;
  persistentIds?: string[];
}

/** Build a BotCore over fakes. Every created client is recorded in `clients`. */
function setup(
  seed: Seed = {},
  opts: { pushover?: PushoverNotifier; offlineGraceMs?: number } = {},
) {
  const store = new InMemoryStateStore(seed);
  const fcm = new FakeFcm();
  const clients: FakeClient[] = [];
  const clientFactory = vi.fn((options: ClientOptions) => {
    const client = new FakeClient(options);
    clients.push(client);
    return client as never;
  });
  const timers = new RecordingTimers();
  const logger = new CapturingLogger();
  const core = new BotCore(store, fcm as never, {
    clientFactory,
    timers,
    logger,
    pairingTimeoutMs: 50,
    pushover: opts.pushover,
    offlineGraceMs: opts.offlineGraceMs,
    now: () => CLOCK_NOW,
  });
  /** The most recently created client for a server (by its connection token). */
  const clientFor = (serverId: string): FakeClient => {
    const match = clients.filter((c) => c.options.playerToken === `tok-${serverId}`).at(-1);
    if (!match) throw new Error(`no client was created for ${serverId}`);
    return match;
  };
  return { store, fcm, clients, clientFactory, clientFor, timers, logger, core };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── typed errors ─────────────────────────────────────────────────────────────

describe("BotCore typed errors", () => {
  it("StateError and ValidationError are BotCoreErrors with stable names and a cause", () => {
    const cause = new Error("root");
    const state = new StateError("s", { cause });
    const validation = new ValidationError("v");

    expect(state).toBeInstanceOf(BotCoreError);
    expect(state).toBeInstanceOf(Error);
    expect(state.name).toBe("StateError");
    expect((state as { cause?: unknown }).cause).toBe(cause);
    expect(validation).toBeInstanceOf(BotCoreError);
    expect(validation.name).toBe("ValidationError");
    expect(validation).not.toBeInstanceOf(StateError);
    expect(new BotCoreError("b").name).toBe("BotCoreError");
  });

  it("every client-backed operation throws StateError while the server is not connected", async () => {
    const { core } = setup({ servers: [makeServer("a")] });
    await core.start();

    const attempts: [string, () => Promise<unknown>][] = [
      ["toggleEntity", () => core.toggleEntity("a", 1, true)],
      ["getEntity", () => core.getEntity("a", 1)],
      ["registerEntityInterest", () => core.registerEntityInterest("a", 1)],
      ["getCameraFrame", () => core.getCameraFrame("a", "CAM1")],
      ["getServerInfo", () => core.getServerInfo("a")],
      ["getServerTime", () => core.getServerTime("a")],
      ["getTeam", () => core.getTeam("a")],
      ["sendTeamMessage", () => core.sendTeamMessage("a", "hi")],
    ];
    for (const [label, attempt] of attempts) {
      const err = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, label).toBeInstanceOf(StateError);
      expect((err as Error).message, label).toMatch(/not connected/i);
    }
  });

  it("unknown servers and entities throw StateError", async () => {
    const { core } = setup({ servers: [makeServer("a")] });
    await core.start();

    await expect(core.connectServer("ghost")).rejects.toBeInstanceOf(StateError);
    await expect(core.addCamera("ghost", "CAM1")).rejects.toBeInstanceOf(StateError);
    await expect(core.setServerPanelIds("ghost", { server: "m" })).rejects.toBeInstanceOf(
      StateError,
    );
    await expect(core.clearLegacyPanelIds("ghost", { status: true })).rejects.toBeInstanceOf(
      StateError,
    );
    await expect(core.setEntityLabel("a", 404, "x")).rejects.toBeInstanceOf(StateError);
    await expect(core.setEntityWatch("a", 404, true)).rejects.toBeInstanceOf(StateError);
    await expect(core.setAlarmPushoverSeverity("a", 404, "high")).rejects.toBeInstanceOf(
      StateError,
    );
    await expect(core.setAlarmNotificationLevel("a", 404, "active")).rejects.toBeInstanceOf(
      StateError,
    );
    await expect(core.setSwitchAutoAction("a", 404, "off")).rejects.toBeInstanceOf(StateError);
    await expect(core.setSwitchAutoDelaySeconds("a", 404, 60)).rejects.toBeInstanceOf(StateError);
  });

  it("a setting applied to the wrong entity kind throws StateError and persists nothing", async () => {
    const { core, store } = setup({
      servers: [makeServer("a")],
      entities: [
        makeEntity("a", 1, { entityType: "switch" }),
        makeEntity("a", 2, { entityType: "alarm" }),
      ],
    });
    await core.start();

    await expect(core.setAlarmPushoverSeverity("a", 1, "high")).rejects.toBeInstanceOf(StateError);
    await expect(core.setAlarmNotificationLevel("a", 1, "active")).rejects.toBeInstanceOf(
      StateError,
    );
    await expect(core.setSwitchAutoAction("a", 2, "off")).rejects.toBeInstanceOf(StateError);
    await expect(core.setSwitchAutoDelaySeconds("a", 2, 60)).rejects.toBeInstanceOf(StateError);

    expect(store.getEntity("a", 1)?.pushoverSeverity).toBeUndefined();
    expect(store.getEntity("a", 1)?.notificationLevel).toBeUndefined();
    expect(store.getEntity("a", 2)?.autoAction).toBeUndefined();
    expect(store.getEntity("a", 2)?.autoActionDelaySeconds).toBeUndefined();
  });

  it("rejected input throws ValidationError before any state lookup", async () => {
    const { core } = setup({ servers: [makeServer("a")], entities: [makeEntity("a", 1)] });
    await core.start();

    await expect(core.addCamera("a", "   ")).rejects.toBeInstanceOf(ValidationError);
    // An empty identifier is reported as such even when the server is unknown too.
    await expect(core.addCamera("ghost", "")).rejects.toBeInstanceOf(ValidationError);

    for (const seconds of [SWITCH_AUTO_DELAY_MIN - 1, SWITCH_AUTO_DELAY_MAX + 1, 60.5, NaN]) {
      await expect(
        core.setSwitchAutoDelaySeconds("a", 1, seconds),
        String(seconds),
      ).rejects.toBeInstanceOf(ValidationError);
      // …and likewise when the entity is unknown: the range check comes first.
      await expect(
        core.setSwitchAutoDelaySeconds("a", 404, seconds),
        String(seconds),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("accepts the inclusive delay bounds", async () => {
    const { core, store } = setup({ servers: [makeServer("a")], entities: [makeEntity("a", 1)] });
    await core.start();

    await core.setSwitchAutoDelaySeconds("a", 1, SWITCH_AUTO_DELAY_MIN);
    expect(store.getEntity("a", 1)?.autoActionDelaySeconds).toBe(SWITCH_AUTO_DELAY_MIN);
    await core.setSwitchAutoDelaySeconds("a", 1, SWITCH_AUTO_DELAY_MAX);
    expect(store.getEntity("a", 1)?.autoActionDelaySeconds).toBe(SWITCH_AUTO_DELAY_MAX);
  });

  it("pairing and refresh without stored credentials reject with AuthError", async () => {
    const { core, fcm } = setup();
    await core.start();

    await expect(core.beginPairing()).rejects.toMatchObject({ name: "AuthError" });
    await expect(core.refreshCredentials()).rejects.toMatchObject({ name: "AuthError" });
    expect(fcm.startListening).not.toHaveBeenCalled();
    expect(fcm.refresh).not.toHaveBeenCalled();
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe("BotCore lifecycle", () => {
  it("start() is idempotent: fcm listeners are wired exactly once", async () => {
    const { core, fcm } = setup();
    const paired: PairedServer[] = [];
    core.on("serverPaired", (s) => paired.push(s));

    await core.start();
    await core.start();
    fcm.emit("serverPairing", makePairing());
    await flushMicrotasks();

    expect(paired).toHaveLength(1);
    expect(fcm.listenerCount("serverPairing")).toBe(1);
  });

  it("stop() keeps going when a client disconnect or the fcm listener fails", async () => {
    const { core, fcm, clientFor, logger } = setup({
      servers: [makeServer("a"), makeServer("bb")],
    });
    await core.start();
    await core.connectServer("a");
    await core.connectServer("bb");
    clientFor("a").disconnect.mockRejectedValueOnce(new Error("socket already gone"));
    fcm.stopListening.mockRejectedValueOnce(new Error("listener already gone"));

    await expect(core.stop()).resolves.toBeUndefined();

    expect(clientFor("bb").disconnect).toHaveBeenCalledTimes(1);
    expect(logger.warned("disconnect failed")).toBe(true);
    expect(logger.warned("fcm.stopListening failed")).toBe(true);
  });

  it("stop() forgets every client and clears armed auto-revert timers", async () => {
    const { core, clientFor, timers } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 5, { autoAction: "off" })],
    });
    await core.start();
    await core.connectServer("a");
    clientFor("a").emit("entityChanged", change(5, true));
    expect(timers.armed).toBe(1);

    await core.stop();

    expect(timers.armed).toBe(0);
    expect(core.isServerConnected("a")).toBe(false);
    await expect(core.getServerInfo("a")).rejects.toBeInstanceOf(StateError);
  });
});

// ── connecting & interest ────────────────────────────────────────────────────

describe("BotCore connectServer and entity interest", () => {
  it("hands the paired server's connection details to the client factory", async () => {
    const server = makeServer("a", { ip: "203.0.113.7", port: 28083, playerId: "765" });
    const { core, clientFactory } = setup({ servers: [server], credentials: makeStoredCreds() });
    await core.start();
    await core.connectServer("a");

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledWith({
      companion: { serverId: "a", getAuthToken: expect.any(Function) },
      ip: "203.0.113.7",
      port: 28083,
      playerId: "765",
      playerToken: "tok-a",
      // bot-core re-subscribes itself on reconnect, re-arming auto-revert timers.
      resubscribeOnReconnect: false,
    });
  });

  // Regression (live test 2026-11-16): current servers' pairings carry no
  // ip/port, so the only route is Facepunch's companion socket by server id.
  it("routes a server with no ip/port through the companion socket with the Steam token", async () => {
    const server = makeServer("a", { ip: undefined, port: undefined });
    const { core, clientFactory } = setup({ servers: [server], credentials: makeStoredCreds() });
    await core.start();
    await core.connectServer("a");

    const opts = clientFactory.mock.calls[0]![0];
    expect(opts.companion?.serverId).toBe("a");
    expect(opts.companion?.getAuthToken()).toBe("steam");
    expect(opts.ip).toBeUndefined();
  });

  it("hands clients the refreshed Steam token after a credential refresh", async () => {
    const { core, fcm, clientFactory } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");
    const getAuthToken = clientFactory.mock.calls[0]![0].companion!.getAuthToken;

    fcm.emit("credentialsRefreshed", makeFcmCreds({ steamAuthToken: "renewed" }));
    await vi.waitFor(() => expect(getAuthToken()).toBe("renewed"));
  });

  // Regression (live test 2026-11-16): a pairing push replayed during startup
  // connected the same server while the startup connect was still in flight.
  it("shares one attempt between overlapping calls: one client, one connect", async () => {
    const { core, clientFactory, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1)],
      credentials: makeStoredCreds(),
    });
    await core.start();

    await Promise.all([core.connectServer("a"), core.connectServer("a")]);

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(clientFor("a").connect).toHaveBeenCalledTimes(1);
    expect(clientFor("a").getEntityInfo).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh attempt once the previous one has settled", async () => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");
    await core.connectServer("a");
    expect(clientFor("a").connect).toHaveBeenCalledTimes(2);
  });

  it("shares a failure with every overlapping caller, then allows a retry", async () => {
    const { core, clientFactory, clientFor } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    client.connect.mockRejectedValueOnce(new Error("handshake refused"));

    const outcomes = await Promise.allSettled([core.connectServer("a"), core.connectServer("a")]);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
    expect(client.connect).toHaveBeenCalledTimes(2);

    await core.connectServer("a");
    expect(client.connect).toHaveBeenCalledTimes(3);
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a second call reuses the client and re-subscribes", async () => {
    const { core, clientFactory, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1), makeEntity("a", 2)],
    });
    await core.start();
    await core.connectServer("a");
    await core.connectServer("a");

    const client = clientFor("a");
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([1, 2, 1, 2]);
  });

  it("does not double-wire broadcasts when connectServer is called twice", async () => {
    const { core, clientFor } = setup({ servers: [makeServer("a")] });
    const seen: EntityChange[] = [];
    core.on("entityChanged", ({ change: c }) => seen.push(c));
    await core.start();
    await core.connectServer("a");
    await core.connectServer("a");

    clientFor("a").emit("entityChanged", change(9, true));

    expect(seen).toHaveLength(1);
  });

  it("seeds interest from persisted entities but never subscribes to cameras", async () => {
    const { core, clientFor } = setup({ servers: [makeServer("a")] });
    await core.start();
    const camera = await core.addCamera("a", "CAM1");
    expect(camera.entityId).toBeLessThan(0);
    await core.setEntityLabel("a", camera.entityId, "Gate cam");
    await core.connectServer("a");

    expect(clientFor("a").getEntityInfo).not.toHaveBeenCalled();
  });

  it("one entity failing to re-subscribe does not stop the others", async () => {
    const { core, clientFor, logger } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1), makeEntity("a", 2), makeEntity("a", 3)],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    client.getEntityInfo.mockClear();
    client.getEntityInfo.mockImplementation(async (entityId: number) => {
      if (entityId === 2) throw new Error("not_found");
      return { entityId, type: "switch", value: false, items: [] };
    });

    // A reconnect re-subscribes everything; entity 2 is gone from the server.
    await expect(core.connectServer("a")).resolves.toBeUndefined();

    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([1, 2, 3]);
    expect(logger.warned("re-subscribe getEntityInfo failed")).toBe(true);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]!.obj).toMatchObject({ serverId: "a", entityId: 2 });
  });

  it("toggleEntity returns the fresh info and keeps the entity subscribed across reconnects", async () => {
    const { core, clientFor } = setup({ servers: [makeServer("a")] });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    client.getEntityInfo.mockResolvedValueOnce({
      entityId: 7,
      type: "switch",
      value: true,
      items: [],
    });

    const info = await core.toggleEntity("a", 7, true);

    expect(client.setEntityValue).toHaveBeenCalledWith(7, true);
    expect(info).toEqual({ entityId: 7, type: "switch", value: true, items: [] });

    client.getEntityInfo.mockClear();
    await core.connectServer("a");
    expect(client.getEntityInfo).toHaveBeenCalledWith(7);
  });

  it("a failed toggle propagates the client's error unchanged", async () => {
    const { core, clientFor } = setup({ servers: [makeServer("a")] });
    await core.start();
    await core.connectServer("a");
    const failure = Object.assign(new Error("gone"), { name: "EntityNotFoundError" });
    clientFor("a").setEntityValue.mockRejectedValueOnce(failure);

    await expect(core.toggleEntity("a", 7, true)).rejects.toBe(failure);
  });

  it("a removed entity is no longer re-subscribed on reconnect", async () => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1), makeEntity("a", 2)],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");

    await core.removeEntity("a", 1);
    client.getEntityInfo.mockClear();
    await core.connectServer("a");

    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([2]);
  });

  it("a removed entity is untracked on the client, so its own reconnect skips it too", async () => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1), makeEntity("a", 2)],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    expect([...client.tracked]).toEqual([1, 2]);

    await core.removeEntity("a", 1);

    expect(client.untrackEntity.mock.calls).toEqual([[1]]);
    // An automatic reconnect must not request the removed entity again, from
    // either layer's set.
    client.getEntityInfo.mockClear();
    await client.simulateAutoReconnect();
    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([2]);
  });

  it("a server that is down when the app starts is picked up once the client gets through", async () => {
    // The PC started before the game server did: the first connect fails, and
    // the client then keeps retrying by itself.
    const { core, clientFactory, logger } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1), makeEntity("a", 2)],
      credentials: makeStoredCreds(),
    });
    await core.start();
    const unreachable = new ConnectionError("companion socket can't reach the game server");
    clientFactory.mockImplementationOnce((options: ClientOptions) => {
      const client = new FakeClient(options);
      client.connect.mockRejectedValueOnce(unreachable);
      return client as never;
    });
    const statuses: string[] = [];
    core.on("serverStatusChanged", (e) => statuses.push(`${e.previous}→${e.status}`));
    const refreshed: number[] = [];
    core.on("entityRefreshed", (e) => refreshed.push(e.entityId));

    // The caller is told why, and the server reads offline meanwhile.
    await expect(core.connectServer("a")).rejects.toBe(unreachable);
    expect(core.getServerStatus("a")).toEqual({ status: "offline" });
    const client = clientFactory.mock.results[0]!.value as FakeClient;
    expect(client.getEntityInfo).not.toHaveBeenCalled();

    // One of the client's own retries connects: nobody called connectServer.
    client.connected = true;
    client.emit("connected");
    await flushMicrotasks();

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["offline→connected"]);
    expect(core.isServerConnected("a")).toBe(true);
    // Its paired devices are requested, so the server broadcasts their changes.
    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect(refreshed).toEqual([1, 2]);
    expect(logger.logged("info", "rust+ entities re-subscribed")).toEqual([
      { serverId: "a", requested: 2, refreshed: 2, failed: 0 },
    ]);
  });

  it("removing an entity on a server that was never connected touches no client", async () => {
    const { core, clients, store } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1)],
    });
    await core.start();

    await expect(core.removeEntity("a", 1)).resolves.toBeUndefined();

    expect(clients).toEqual([]);
    expect(store.getEntity("a", 1)).toBeUndefined();
  });

  it("removing an unknown entity does not untrack anything", async () => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1)],
    });
    await core.start();
    await core.connectServer("a");

    await core.removeEntity("a", 999);

    expect(clientFor("a").untrackEntity).not.toHaveBeenCalled();
  });

  it("getCameraFrame asks the client for frame 0 of the given identifier", async () => {
    const { core, clientFor } = setup({ servers: [makeServer("a")] });
    await core.start();
    await core.connectServer("a");

    const frame = await core.getCameraFrame("a", "CAM1");

    expect(clientFor("a").getCameraFrame).toHaveBeenCalledWith("CAM1", 0);
    expect(frame).toEqual(new Uint8Array([1]));
  });

  it("getCameraFrame passes the client's CameraUnavailableError through unchanged", async () => {
    const { core, clientFor } = setup({ servers: [makeServer("a")] });
    await core.start();
    await core.connectServer("a");
    const refusal = new CameraUnavailableError("server error: player_online", {
      reason: "playerOnline",
    });
    clientFor("a").getCameraFrame.mockRejectedValueOnce(refusal);

    const err = await core.getCameraFrame("a", "CAM1").catch((e: unknown) => e);

    expect(err).toBe(refusal);
    expect(err).toMatchObject({ name: "CameraUnavailableError", reason: "playerOnline" });
  });
});

// ── start-on-login preference ────────────────────────────────────────────────

describe("BotCore start-on-login preference", () => {
  it.each([true, false])("persists %s and announces it to the host", async (enabled) => {
    const { core, store } = setup({
      config: { startOnLogin: !enabled, roleCapabilities: { admin: ["A"], user: [] } },
    });
    await core.start();
    const announced: { enabled: boolean }[] = [];
    core.on("startOnLoginChanged", (e) => announced.push(e));

    await core.setStartOnLogin(enabled);

    expect(core.getConfig().startOnLogin).toBe(enabled);
    expect(store.getConfig().startOnLogin).toBe(enabled);
    expect(announced).toEqual([{ enabled }]);
  });

  it("leaves the rest of the config untouched", async () => {
    const config: AppConfig = {
      startOnLogin: false,
      controlChannelId: "chan",
      loggingChannelId: "log",
      roleCapabilities: { admin: ["A"], user: ["U"] },
      pushover: { appToken: "app", userKey: "user" },
    };
    const { core } = setup({ config });
    await core.start();

    await core.setStartOnLogin(true);

    expect(core.getConfig()).toEqual({ ...config, startOnLogin: true });
  });

  it("announces only after the preference is persisted", async () => {
    const { core, store } = setup();
    await core.start();
    const persistedWhenAnnounced: boolean[] = [];
    core.on("startOnLoginChanged", () => {
      persistedWhenAnnounced.push(store.getConfig().startOnLogin);
    });

    await core.setStartOnLogin(true);

    expect(persistedWhenAnnounced).toEqual([true]);
  });
});

// ── event fan-out ────────────────────────────────────────────────────────────

describe("BotCore event fan-out", () => {
  it("tags each client's broadcasts with its own server id", async () => {
    const { core, clientFor } = setup({ servers: [makeServer("a"), makeServer("bb")] });
    const changes: { serverId: string; entityId: number }[] = [];
    const chats: { serverId: string; text: string }[] = [];
    core.on("entityChanged", ({ serverId, change: c }) =>
      changes.push({ serverId, entityId: c.entityId }),
    );
    core.on("teamChat", ({ serverId, message }) => chats.push({ serverId, text: message.message }));
    await core.start();
    await core.connectServer("a");
    await core.connectServer("bb");

    const chat: TeamChatMessage = {
      steamId: "1",
      name: "n",
      message: "from bb",
      color: "",
      time: 0,
    };
    clientFor("bb").emit("entityChanged", change(1, true));
    clientFor("a").emit("entityChanged", change(1, false));
    clientFor("bb").emit("teamChat", chat);

    expect(changes).toEqual([
      { serverId: "bb", entityId: 1 },
      { serverId: "a", entityId: 1 },
    ]);
    expect(chats).toEqual([{ serverId: "bb", text: "from bb" }]);
  });

  it("reports connect and disconnect per server, carrying the close reason", async () => {
    const { core, clientFor } = setup({ servers: [makeServer("a"), makeServer("bb")] });
    const statuses: { serverId: string; status: string; reason?: string }[] = [];
    core.on("serverStatusChanged", (s) => statuses.push(s));
    await core.start();
    await core.connectServer("a");
    await core.connectServer("bb");

    clientFor("a").emit("disconnected", { code: 1006, reason: "socket dropped" });

    expect(statuses).toEqual([
      { serverId: "a", status: "connected", previous: "offline" },
      { serverId: "bb", status: "connected", previous: "offline" },
      {
        serverId: "a",
        status: "reconnecting",
        previous: "connected",
        lastSeenAt: CLOCK_NOW,
        reason: "socket dropped",
      },
    ]);
    expect(core.isServerConnected("a")).toBe(false);
    expect(core.isServerConnected("bb")).toBe(true);
  });

  it("absorbs a client 'error' event instead of crashing the process", async () => {
    const { core, clientFor, logger } = setup({ servers: [makeServer("a")] });
    await core.start();
    await core.connectServer("a");

    expect(() => clientFor("a").emit("error", new Error("decode failed"))).not.toThrow();
    expect(logger.warned("rustplus client error")).toBe(true);
  });

  it("re-pairing a server keeps its addedAt and panel message ids", async () => {
    const original = makeServer("a", {
      addedAt: "2026-01-01T00:00:00.000Z",
      panelMessageIds: { server: "server-msg", switches: ["switches-msg"] },
      statusPanelMessageId: "status-msg",
      teamPanelMessageId: "team-msg",
    });
    const { core, fcm, store } = setup({ servers: [original] });
    const paired: PairedServer[] = [];
    core.on("serverPaired", (s) => paired.push(s));
    await core.start();

    fcm.emit("serverPairing", makePairing({ name: "Renamed", playerToken: "rotated-token" }));
    await flushMicrotasks();

    expect(paired).toHaveLength(1);
    expect(store.getServer("a")).toMatchObject({
      name: "Renamed",
      playerToken: "rotated-token",
      addedAt: "2026-01-01T00:00:00.000Z",
      panelMessageIds: { server: "server-msg", switches: ["switches-msg"] },
      statusPanelMessageId: "status-msg",
      teamPanelMessageId: "team-msg",
    });
  });

  it("maps the pairing payload's entity type number to a logical kind", async () => {
    const { core, fcm, store } = setup({ servers: [makeServer("a")] });
    await core.start();

    const cases: [number | undefined, PairedEntity["entityType"]][] = [
      [1, "switch"],
      [2, "alarm"],
      [3, "storageMonitor"],
      [undefined, "switch"],
    ];
    for (const [index, [raw]] of cases.entries()) {
      fcm.emit(
        "entityPairing",
        makePairing({ type: "entity", entityId: 100 + index, entityType: raw }),
      );
    }
    await flushMicrotasks();

    for (const [index, [, kind]] of cases.entries()) {
      expect(store.getEntity("a", 100 + index)?.entityType, String(index)).toBe(kind);
    }
  });

  it("a Pushover delivery failure is logged, not thrown into the broadcast path", async () => {
    const pushover = vi.fn<PushoverNotifier>(async () => {
      throw new Error("pushover 500");
    });
    const { core, clientFor, logger } = setup(
      {
        config: {
          startOnLogin: false,
          roleCapabilities: { admin: [], user: [] },
          pushover: { appToken: "app", userKey: "user" },
        } as AppConfig,
        servers: [makeServer("a")],
        entities: [makeEntity("a", 3, { entityType: "alarm", pushoverSeverity: "high" })],
      },
      { pushover },
    );
    const seen: EntityChange[] = [];
    core.on("entityChanged", ({ change: c }) => seen.push(c));
    await core.start();
    await core.connectServer("a");

    clientFor("a").emit("entityChanged", change(3, true));
    await flushMicrotasks();

    expect(seen).toHaveLength(1);
    expect(pushover).toHaveBeenCalledTimes(1);
    expect(pushover.mock.calls[0]![0]).toMatchObject({
      appToken: "app",
      userKey: "user",
      priority: 1,
    });
    expect(logger.warned("pushover: send failed")).toBe(true);
  });
});

// ── handled push ids ─────────────────────────────────────────────────────────

describe("BotCore handled push id persistence", () => {
  it("persists each handled push id so the next listener start seeds it", async () => {
    const { core, fcm, store } = setup({ credentials: makeStoredCreds() });
    const add = vi.spyOn(store, "addPersistentIds");
    await core.start();

    fcm.emit("pushHandled", "push-1");
    fcm.emit("pushHandled", "push-2");
    await flushMicrotasks();

    expect(add.mock.calls).toEqual([[["push-1"]], [["push-2"]]]);

    // The ids reach the next listener start (what a restart's start does).
    vi.useFakeTimers();
    const wait = core.beginPairing();
    await vi.advanceTimersByTimeAsync(50);
    await wait;
    expect(fcm.startListening).toHaveBeenLastCalledWith(makeFcmCreds(), ["push-1", "push-2"]);
  });

  it("a failing store write is logged, not thrown", async () => {
    const { core, fcm, store, logger } = setup();
    vi.spyOn(store, "addPersistentIds").mockRejectedValue(new Error("disk full"));
    await core.start();

    fcm.emit("pushHandled", "push-1");
    await flushMicrotasks();

    expect(logger.warned("fcm: failed to persist push id")).toBe(true);
  });

  it("the store keeps only the newest MAX_PERSISTENT_IDS ids", async () => {
    const { core, fcm, store } = setup({ persistentIds: ["oldest"] });
    await core.start();

    for (let i = 0; i < MAX_PERSISTENT_IDS; i++) fcm.emit("pushHandled", `push-${i}`);
    await flushMicrotasks();

    const ids = await store.getPersistentIds();
    expect(ids).toHaveLength(MAX_PERSISTENT_IDS);
    expect(ids).not.toContain("oldest");
    expect(ids[0]).toBe("push-0");
    expect(ids.at(-1)).toBe(`push-${MAX_PERSISTENT_IDS - 1}`);
  });
});

// ── pairing wait ─────────────────────────────────────────────────────────────

describe("BotCore pairing wait", () => {
  it("resolves on its own after the pairing timeout and detaches its listeners", async () => {
    vi.useFakeTimers();
    const { core, fcm } = setup({ credentials: makeStoredCreds(), persistentIds: ["p1"] });
    await core.start();
    const baseline = fcm.listenerCount("serverPairing");

    let settled = false;
    const wait = core.beginPairing().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0); // let the listener arm before the clock moves
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    expect(fcm.listenerCount("serverPairing")).toBe(baseline + 1);

    await vi.advanceTimersByTimeAsync(1);
    await wait;

    expect(settled).toBe(true);
    expect(fcm.startListening).toHaveBeenCalledWith(makeFcmCreds(), ["p1"]);
    expect(fcm.listenerCount("serverPairing")).toBe(baseline);
    expect(fcm.listenerCount("entityPairing")).toBe(baseline);
  });

  it("an entity pairing settles the wait and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const { core, fcm } = setup({ credentials: makeStoredCreds(), servers: [makeServer("a")] });
    await core.start();

    const wait = core.beginPairing();
    await vi.advanceTimersByTimeAsync(0);
    fcm.emit("entityPairing", makePairing({ type: "entity", entityId: 4, entityType: 1 }));
    await wait;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("can be armed again after a previous wait has settled", async () => {
    vi.useFakeTimers();
    const { core, fcm } = setup({ credentials: makeStoredCreds() });
    await core.start();

    const first = core.beginPairing();
    await vi.advanceTimersByTimeAsync(0);
    await core.cancelPairing();
    await first;

    let secondSettled = false;
    const second = core.beginPairing().then(() => {
      secondSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(secondSettled).toBe(false);
    fcm.emit("serverPairing", makePairing());
    await second;

    expect(fcm.startListening).toHaveBeenCalledTimes(2);
  });
});

// ── credential refresh ───────────────────────────────────────────────────────

describe("BotCore credential refresh", () => {
  it("replaces every client with a fresh one after a refresh", async () => {
    const { core, clients, clientFactory, store } = setup({
      credentials: makeStoredCreds(),
      servers: [makeServer("a"), makeServer("bb")],
    });
    await core.start();
    await core.connectServer("a");
    await core.connectServer("bb");
    const [oldA, oldB] = clients;

    const refreshed = await core.refreshCredentials();

    expect(refreshed.steamAuthToken).toBe("rotated");
    expect(await store.getCredentials()).toMatchObject({
      discordBotToken: "bot",
      steamTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      fcm: { steamAuthToken: "rotated" },
    });
    expect(oldA!.disconnect).toHaveBeenCalledTimes(1);
    expect(oldB!.disconnect).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledTimes(4);
    expect(core.isServerConnected("a")).toBe(true);
    expect(core.isServerConnected("bb")).toBe(true);
  });

  it("one server failing to reconnect does not strand the others", async () => {
    const { core, clientFactory, logger } = setup({
      credentials: makeStoredCreds(),
      servers: [makeServer("a"), makeServer("bb")],
    });
    await core.start();
    await core.connectServer("a");
    await core.connectServer("bb");
    // The replacement client for "a" (first to be rebuilt) refuses to connect.
    clientFactory.mockImplementationOnce((options: ClientOptions) => {
      const client = new FakeClient(options);
      client.connect.mockRejectedValue(new Error("refused"));
      return client as never;
    });

    await expect(core.refreshCredentials()).resolves.toMatchObject({ steamAuthToken: "rotated" });

    expect(logger.warned("reconnect after refresh failed")).toBe(true);
    expect(core.isServerConnected("a")).toBe(false);
    expect(core.isServerConnected("bb")).toBe(true);
  });

  it("persists credentials the fcm service refreshed on its own", async () => {
    const { core, fcm, store } = setup({ credentials: makeStoredCreds() });
    await core.start();

    fcm.emit(
      "credentialsRefreshed",
      makeFcmCreds({ steamAuthToken: "pushed", steamTokenExpiresAt: "2030-01-01T00:00:00.000Z" }),
    );
    await flushMicrotasks();

    expect(await store.getCredentials()).toMatchObject({
      discordBotToken: "bot",
      steamTokenExpiresAt: "2030-01-01T00:00:00.000Z",
      fcm: { steamAuthToken: "pushed" },
    });
  });

  it("ignores an fcm credential refresh when nothing is stored yet", async () => {
    const { core, fcm, store } = setup();
    await core.start();

    fcm.emit("credentialsRefreshed", makeFcmCreds({ steamAuthToken: "pushed" }));
    await flushMicrotasks();

    expect(await store.getCredentials()).toBeUndefined();
  });
});

// ── auto-revert timers ───────────────────────────────────────────────────────

// The client reconnects by itself after a server restart; bot-core must
// re-request its entities then, re-arming auto-revert and refreshing panels.
describe("BotCore automatic reconnect", () => {
  it("re-arms a switch's auto-revert after an automatic reconnect, and it fires", async () => {
    const { core, clientFor, timers } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1, { autoAction: "off", autoActionDelaySeconds: 30 })],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    // The switch is ON: the auto-off countdown is armed.
    client.getEntityInfo.mockImplementation(async (entityId: number) => ({
      entityId,
      type: "switch",
      value: true,
      items: [],
    }));
    client.emit("entityChanged", change(1, true));
    expect(timers.armed).toBe(1);

    await client.simulateAutoReconnect();

    expect(timers.armed).toBe(1);
    await timers.fireAll();
    expect(client.setEntityValue).toHaveBeenCalledWith(1, false);
  });

  it("emits entityRefreshed with each tracked entity's current value", async () => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1), makeEntity("a", 2, { entityType: "alarm" })],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    const refreshed: unknown[] = [];
    core.on("entityRefreshed", (e) => refreshed.push(e));
    client.getEntityInfo.mockImplementation(async (entityId: number) => ({
      entityId,
      type: "switch",
      value: entityId === 1,
      items: [],
    }));

    await client.simulateAutoReconnect();

    expect(refreshed).toEqual([
      { serverId: "a", entityId: 1, info: expect.objectContaining({ value: true }) },
      { serverId: "a", entityId: 2, info: expect.objectContaining({ value: false }) },
    ]);
  });

  it("requests each tracked entity once per automatic reconnect", async () => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1), makeEntity("a", 2)],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    client.getEntityInfo.mockClear();

    await client.simulateAutoReconnect();

    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([1, 2]);
  });

  it("a connectServer after a disconnect requests each entity once, not twice", async () => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1), makeEntity("a", 2)],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    client.emit("disconnected", { code: 1006, reason: "" });
    client.getEntityInfo.mockClear();

    await core.connectServer("a");

    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([1, 2]);
  });

  it("a first connect does not re-subscribe from the connected event as well", async () => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1)],
    });
    await core.start();
    await core.connectServer("a");
    await flushMicrotasks();
    expect(clientFor("a").getEntityInfo).toHaveBeenCalledTimes(1);
  });
});

// An entity the server cannot reach leaves bot-core's interest set too, or a
// reconnect would re-request what the client already untracked.
describe("BotCore interest after EntityNotFoundError", () => {
  function notFoundFor(client: FakeClient, gone: number): void {
    client.getEntityInfo.mockImplementation(async (entityId: number) => {
      if (entityId === gone) {
        client.tracked.delete(entityId); // as the real client untracks it
        throw new EntityNotFoundError(`entity ${entityId} not_found`);
      }
      client.tracked.add(entityId);
      return { entityId, type: "switch", value: false, items: [] };
    });
  }

  it("a second connectServer does not request an entity that was not found", async () => {
    const { core, clients, clientFor, clientFactory } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1), makeEntity("a", 2)],
    });
    await core.start();
    // Fail entity 1 from the very first request.
    clientFactory.mockImplementationOnce((options: ClientOptions) => {
      const client = new FakeClient(options);
      notFoundFor(client, 1);
      clients.push(client);
      return client as never;
    });
    await core.connectServer("a");
    const client = clientFor("a");
    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    client.getEntityInfo.mockClear();

    await core.connectServer("a");
    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([2]);

    await client.simulateAutoReconnect();
    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([2, 2]);
  });

  it("keeps the persisted entity: removing a device stays the operator's decision", async () => {
    const { core, clientFor, store } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1)],
    });
    await core.start();
    await core.connectServer("a");
    notFoundFor(clientFor("a"), 1);

    await core.connectServer("a");
    expect(store.getEntity("a", 1)).toBeDefined();
  });

  it("a later getEntity registers interest again", async () => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1)],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    notFoundFor(client, 1);
    await core.connectServer("a"); // 1 is dropped

    // The device is reachable again (the player re-authorised on the TC).
    notFoundFor(client, -999);
    await core.getEntity("a", 1);
    client.getEntityInfo.mockClear();

    await core.connectServer("a");
    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([1]);
  });

  it.each<[string, (core: BotCore) => Promise<unknown>]>([
    ["getEntity", (core) => core.getEntity("a", 1)],
    ["toggleEntity", (core) => core.toggleEntity("a", 1, true)],
  ])("%s drops interest on EntityNotFoundError", async (_name, call) => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1)],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    notFoundFor(client, 1);

    await expect(call(core)).rejects.toBeInstanceOf(EntityNotFoundError);
    client.getEntityInfo.mockClear();
    await core.connectServer("a");
    expect(client.getEntityInfo).not.toHaveBeenCalled();
  });

  it("keeps interest on other failures (AuthError, timeouts)", async () => {
    const { core, clientFor } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1)],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    client.getEntityInfo.mockRejectedValueOnce(new AuthError("not_found: bad token"));

    await core.connectServer("a");
    client.getEntityInfo.mockClear();
    await core.connectServer("a");
    expect(client.getEntityInfo.mock.calls.map(([id]) => id)).toEqual([1]);
  });
});

// The companion auth token (Steam sign-in) lasts 14 days, and Facepunch refuses
// to refresh an expired one.
describe("BotCore Steam sign-in renewal", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-11-16T00:00:00.000Z");

  function credsExpiringAt(iso: string): StoredCredentials {
    return { ...makeStoredCreds(), steamTokenExpiresAt: iso };
  }

  function companionTokenOf(clientFactory: ReturnType<typeof setup>["clientFactory"]) {
    return clientFactory.mock.calls[0]![0].companion!.getAuthToken;
  }

  it("checkAuthToken: ok far from expiry, expiring inside the schedule, expired after", async () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    for (const [expiry, state, milestoneMs] of [
      [at(10 * DAY), "ok", undefined],
      [at(2 * DAY - 1), "expiring", 2 * DAY],
      [at(-1), "expired", 0],
    ] as const) {
      const { core } = setup({ credentials: credsExpiringAt(expiry) });
      const notices: unknown[] = [];
      core.on("authRenewalNeeded", (n) => notices.push(n));
      expect(await core.checkAuthToken(NOW)).toBe(state);
      expect(notices).toEqual(
        state === "ok" ? [] : [{ reason: state, expiresAt: expiry, milestoneMs }],
      );
    }
  });

  // Escalating reminders (48h before expiry down to expired) instead of one
  // "expires soon" line.
  describe("reminder milestones", () => {
    const MIN = 60 * 1000;
    const HOUR = 60 * MIN;
    const EXPIRY = NOW + 3 * DAY;
    const EXPIRES_AT = new Date(EXPIRY).toISOString();

    it("the schedule is 48h, 24h, 12h, 4h, 3h, 2h, 1h, 30 min, 5 min, 1 min", () => {
      expect(AUTH_RENEWAL_MILESTONES_MS).toEqual([
        48 * HOUR,
        24 * HOUR,
        12 * HOUR,
        4 * HOUR,
        3 * HOUR,
        2 * HOUR,
        HOUR,
        30 * MIN,
        5 * MIN,
        MIN,
      ]);
    });

    it("authRenewalMilestone is the smallest milestone at or above the time left", () => {
      expect(authRenewalMilestone(EXPIRES_AT, EXPIRY - 49 * HOUR)).toBeUndefined();
      expect(authRenewalMilestone(EXPIRES_AT, EXPIRY - 48 * HOUR)).toBe(48 * HOUR);
      expect(authRenewalMilestone(EXPIRES_AT, EXPIRY - 13 * HOUR)).toBe(24 * HOUR);
      expect(authRenewalMilestone(EXPIRES_AT, EXPIRY - 45 * MIN)).toBe(HOUR);
      expect(authRenewalMilestone(EXPIRES_AT, EXPIRY - 1)).toBe(MIN);
      expect(authRenewalMilestone(EXPIRES_AT, EXPIRY)).toBe(0);
      expect(authRenewalMilestone("not a date", NOW)).toBe(0);
    });

    it("nextAuthRenewalMilestoneAt is the next milestone instant strictly after now", () => {
      expect(nextAuthRenewalMilestoneAt(EXPIRES_AT, NOW)).toBe(EXPIRY - 48 * HOUR);
      expect(nextAuthRenewalMilestoneAt(EXPIRES_AT, EXPIRY - 48 * HOUR)).toBe(EXPIRY - 24 * HOUR);
      expect(nextAuthRenewalMilestoneAt(EXPIRES_AT, EXPIRY - 10 * MIN)).toBe(EXPIRY - 5 * MIN);
      expect(nextAuthRenewalMilestoneAt(EXPIRES_AT, EXPIRY - MIN)).toBe(EXPIRY);
      expect(nextAuthRenewalMilestoneAt(EXPIRES_AT, EXPIRY)).toBeUndefined();
      expect(nextAuthRenewalMilestoneAt(undefined, NOW)).toBeUndefined();
      expect(nextAuthRenewalMilestoneAt("not a date", NOW)).toBeUndefined();
    });

    it("emits once per milestone, in order, ending in expired", async () => {
      const { core } = setup({ credentials: credsExpiringAt(EXPIRES_AT) });
      const notices: { reason: string; milestoneMs?: number }[] = [];
      core.on("authRenewalNeeded", (n) => notices.push(n));

      // Check at each milestone, just after it, and well before the next.
      for (const milestone of [...AUTH_RENEWAL_MILESTONES_MS, 0]) {
        await core.checkAuthToken(EXPIRY - milestone);
        await core.checkAuthToken(EXPIRY - milestone + 1);
        await core.checkAuthToken(EXPIRY - milestone + 10 * 1000);
      }
      await core.checkAuthToken(EXPIRY + DAY);

      expect(notices.map((n) => n.milestoneMs)).toEqual([...AUTH_RENEWAL_MILESTONES_MS, 0]);
      expect(notices.map((n) => n.reason)).toEqual([
        ...AUTH_RENEWAL_MILESTONES_MS.map(() => "expiring"),
        "expired",
      ]);
    });

    it("sends only the current milestone when several were skipped", async () => {
      const { core } = setup({ credentials: credsExpiringAt(EXPIRES_AT) });
      const notices: { reason: string; milestoneMs?: number }[] = [];
      core.on("authRenewalNeeded", (n) => notices.push(n));

      await core.checkAuthToken(EXPIRY - 47 * HOUR); // 48h
      await core.checkAuthToken(EXPIRY - 50 * MIN); // asleep through 24h … 2h, 1h
      await core.checkAuthToken(EXPIRY + HOUR); // asleep through 30, 5 and 1 min

      expect(notices).toEqual([
        { reason: "expiring", expiresAt: EXPIRES_AT, milestoneMs: 48 * HOUR },
        { reason: "expiring", expiresAt: EXPIRES_AT, milestoneMs: HOUR },
        { reason: "expired", expiresAt: EXPIRES_AT, milestoneMs: 0 },
      ]);
    });

    it("persists the last reminder with its expiry, so a restart does not repeat it", async () => {
      const { core, store } = setup({ credentials: credsExpiringAt(EXPIRES_AT) });
      await core.checkAuthToken(EXPIRY - 3 * HOUR);
      expect(store.getConfig().steamRenewalReminder).toEqual({
        reason: "expiring",
        expiresAt: EXPIRES_AT,
        milestoneMs: 3 * HOUR,
      });

      // A restart: a new BotCore over the same persisted state.
      const restarted = new BotCore(store, new FakeFcm() as never, {
        clientFactory: vi.fn() as never,
        timers: new RecordingTimers(),
      });
      const notices: { milestoneMs?: number }[] = [];
      restarted.on("authRenewalNeeded", (n) => notices.push(n));

      await restarted.checkAuthToken(EXPIRY - 3 * HOUR + MIN);
      expect(notices).toEqual([]);
      await restarted.checkAuthToken(EXPIRY - 2 * HOUR);
      expect(notices.map((n) => n.milestoneMs)).toEqual([2 * HOUR]);
    });

    it("a stored reminder for another expiry does not hold back this one", async () => {
      const { core } = setup({
        credentials: credsExpiringAt(EXPIRES_AT),
        config: {
          startOnLogin: false,
          roleCapabilities: { admin: [], user: [] },
          steamRenewalReminder: {
            reason: "expiring",
            expiresAt: "2026-01-01T00:00:00.000Z",
            milestoneMs: 48 * HOUR,
          },
        },
      });
      const notices: unknown[] = [];
      core.on("authRenewalNeeded", (n) => notices.push(n));

      await core.checkAuthToken(EXPIRY - 48 * HOUR);
      expect(notices).toHaveLength(1);
    });

    it("starts over at 48h after a refreshed sign-in brings a new expiry", async () => {
      const { core, fcm } = setup({ credentials: credsExpiringAt(EXPIRES_AT) });
      const notices: { expiresAt?: string; milestoneMs?: number }[] = [];
      core.on("authRenewalNeeded", (n) => notices.push(n));
      await core.checkAuthToken(EXPIRY - 47 * HOUR);
      await core.checkAuthToken(EXPIRY - 23 * HOUR);

      const renewedExpiry = EXPIRY + 14 * DAY;
      const renewedAt = new Date(renewedExpiry).toISOString();
      fcm.refresh.mockResolvedValueOnce(makeFcmCreds({ steamTokenExpiresAt: renewedAt }));
      await core.refreshCredentials();
      expect(await core.checkAuthToken(EXPIRY - 22 * HOUR)).toBe("ok");
      await core.checkAuthToken(renewedExpiry - 47 * HOUR);

      expect(notices.map((n) => [n.expiresAt, n.milestoneMs])).toEqual([
        [EXPIRES_AT, 48 * HOUR],
        [EXPIRES_AT, 24 * HOUR],
        [renewedAt, 48 * HOUR],
      ]);
    });

    it("rejected emits once, whatever milestones pass, and is not repeated after a restart", async () => {
      const { core, store, clientFactory } = setup({
        servers: [makeServer("a")],
        credentials: credsExpiringAt(EXPIRES_AT),
      });
      await core.start();
      const notices: { reason: string }[] = [];
      core.on("authRenewalNeeded", (n) => notices.push(n));
      const refused = new AuthError("HTTP 403", { credential: "authToken" });
      clientFactory.mockImplementationOnce((options: ClientOptions) => {
        const client = new FakeClient(options);
        client.connect.mockRejectedValueOnce(refused);
        return client as never;
      });
      await expect(core.connectServer("a")).rejects.toBe(refused);
      // The client's retries were refused too.
      (clientFactory.mock.results[0]!.value as FakeClient).emit("authRejected", refused);
      await flushMicrotasks();

      for (const milestone of [...AUTH_RENEWAL_MILESTONES_MS, 0]) {
        expect(await core.checkAuthToken(EXPIRY - milestone)).toBe("rejected");
      }
      expect(notices.map((n) => n.reason)).toEqual(["rejected"]);
      expect(store.getConfig().steamRenewalReminder).toEqual({
        reason: "rejected",
        expiresAt: EXPIRES_AT,
      });
    });
  });

  it("checkAuthToken reports missing credentials without a notice", async () => {
    const { core } = setup();
    const notices: unknown[] = [];
    core.on("authRenewalNeeded", (n) => notices.push(n));
    expect(await core.checkAuthToken(NOW)).toBe("missing");
    expect(notices).toEqual([]);
  });

  it("sends each notice once, however often it is checked, and again when the state changes", async () => {
    const expiry = new Date(NOW + DAY).toISOString();
    const { core } = setup({ credentials: credsExpiringAt(expiry) });
    const notices: { reason: string }[] = [];
    core.on("authRenewalNeeded", (n) => notices.push(n));

    await core.checkAuthToken(NOW);
    await core.checkAuthToken(NOW + 1000);
    await core.checkAuthToken(NOW + 2 * DAY);
    await core.checkAuthToken(NOW + 3 * DAY);

    expect(notices.map((n) => n.reason)).toEqual(["expiring", "expired"]);
  });

  it("one refused handshake is not yet a refused token: nothing is withdrawn or announced", async () => {
    const { core, clientFactory } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    const notices: unknown[] = [];
    core.on("authRenewalNeeded", (n) => notices.push(n));
    const refused = new AuthError("companion socket rejected the auth token (HTTP 403)", {
      credential: "authToken",
    });
    clientFactory.mockImplementationOnce((options: ClientOptions) => {
      const client = new FakeClient(options);
      client.connect.mockRejectedValueOnce(refused);
      return client as never;
    });

    // The caller is told why the connect failed; the client retries by itself.
    await expect(core.connectServer("a")).rejects.toBe(refused);
    const client = clientFactory.mock.results[0]!.value as FakeClient;
    client.emit("error", refused);
    await flushMicrotasks();

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(companionTokenOf(clientFactory)()).toBe("steam");
    expect(notices).toEqual([]);
    expect(await core.checkAuthToken(Date.parse("2026-06-01T00:00:00.000Z"))).toBe("ok");
  });

  it("a token refused on every retry is withdrawn, announced once, and the server falls back to its direct address", async () => {
    const { core, clientFactory } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    const notices: unknown[] = [];
    core.on("authRenewalNeeded", (n) => notices.push(n));
    const refused = new AuthError("companion socket rejected the auth token (HTTP 403)", {
      credential: "authToken",
    });
    clientFactory.mockImplementationOnce((options: ClientOptions) => {
      const client = new FakeClient(options);
      client.connect.mockRejectedValueOnce(refused);
      return client as never;
    });
    await expect(core.connectServer("a")).rejects.toBe(refused);
    const client = clientFactory.mock.results[0]!.value as FakeClient;

    // The client's retries were refused too: it stops and says so.
    client.emit("authRejected", refused);
    await flushMicrotasks();

    // The second connect dials the direct address: the token is withdrawn.
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(companionTokenOf(clientFactory)()).toBeUndefined();
    expect(core.isServerConnected("a")).toBe(true);
    expect(notices).toEqual([
      { reason: "rejected", expiresAt: makeStoredCreds().steamTokenExpiresAt },
    ]);
    expect(await core.checkAuthToken()).toBe("rejected");
    expect(notices).toHaveLength(1);
  });

  it("a refused token on a server with no direct address fails the connect, with nothing to fall back to", async () => {
    const { core, clientFactory } = setup({
      servers: [makeServer("a", { ip: undefined, port: undefined })],
      credentials: makeStoredCreds(),
    });
    await core.start();
    const notices: unknown[] = [];
    core.on("authRenewalNeeded", (n) => notices.push(n));
    const refused = new AuthError("HTTP 403", { credential: "authToken" });
    clientFactory.mockImplementationOnce((options: ClientOptions) => {
      const client = new FakeClient(options);
      client.connect.mockRejectedValueOnce(refused);
      return client as never;
    });

    await expect(core.connectServer("a")).rejects.toBe(refused);
    const client = clientFactory.mock.results[0]!.value as FakeClient;
    client.emit("authRejected", refused);
    await flushMicrotasks();

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
  });

  it("a token refused on every retry during an automatic reconnect is withdrawn too", async () => {
    const { core, clientFactory, clientFor } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");
    const notices: unknown[] = [];
    core.on("authRenewalNeeded", (n) => notices.push(n));
    expect(companionTokenOf(clientFactory)()).toBe("steam");
    const refused = new AuthError("HTTP 403", { credential: "authToken" });

    // Each refused retry is reported as an error; that alone changes nothing.
    clientFor("a").emit("error", refused);
    await flushMicrotasks();
    expect(companionTokenOf(clientFactory)()).toBe("steam");
    expect(notices).toEqual([]);

    clientFor("a").emit("authRejected", refused);
    await flushMicrotasks();

    expect(companionTokenOf(clientFactory)()).toBeUndefined();
    expect(notices).toHaveLength(1);
  });

  it("a rejected playerToken is not a Steam sign-in problem", async () => {
    const { core, clientFactory, clientFor } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");
    const notices: unknown[] = [];
    core.on("authRenewalNeeded", (n) => notices.push(n));

    clientFor("a").emit("error", new AuthError("not_found", { credential: "playerToken" }));
    await flushMicrotasks();

    expect(companionTokenOf(clientFactory)()).toBe("steam");
    expect(notices).toEqual([]);
  });

  it("renewCredentials signs in again, persists the new token, and reconnects with it", async () => {
    const { core, fcm, store, clientFactory, clientFor } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");
    clientFor("a").emit("error", new AuthError("HTTP 403", { credential: "authToken" }));
    await flushMicrotasks();
    const onSteamLogin = vi.fn(async () => {});

    await core.renewCredentials({ onSteamLogin });

    expect(fcm.renew).toHaveBeenCalledOnce();
    expect(onSteamLogin).toHaveBeenCalledOnce();
    expect((await store.getCredentials())?.fcm.steamAuthToken).toBe("renewed");
    expect((await store.getCredentials())?.steamTokenExpiresAt).toBe("2099-02-01T00:00:00.000Z");
    // A fresh client for the server, offering the new token.
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(clientFactory.mock.calls[1]![0].companion!.getAuthToken()).toBe("renewed");
    expect(clientFor("a").connect).toHaveBeenCalledOnce();
    expect(await core.checkAuthToken(NOW)).toBe("ok");
  });

  it("a refreshed token from fcm also clears a rejection", async () => {
    const { core, fcm, clientFactory, clientFor } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");
    clientFor("a").emit("error", new AuthError("HTTP 403", { credential: "authToken" }));
    await flushMicrotasks();

    fcm.emit("credentialsRefreshed", makeFcmCreds({ steamAuthToken: "fresh" }));
    await flushMicrotasks();

    expect(companionTokenOf(clientFactory)()).toBe("fresh");
  });
});

// Successful lifecycle events leave a readable trace in the log, not just failures.
describe("BotCore success-path logging", () => {
  it("logs a connect with its route, and the re-subscription count", async () => {
    const { core, logger } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1), makeEntity("a", 2)],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");

    expect(logger.logged("info", "rust+ connected")).toEqual([
      { serverId: "a", route: "companion" },
    ]);
    expect(logger.logged("info", "rust+ entities re-subscribed")).toEqual([
      { serverId: "a", requested: 2, refreshed: 2, failed: 0 },
    ]);
  });

  it("logs a disconnect and the reconnect attempt that follows", async () => {
    const { core, clientFor, logger } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");

    clientFor("a").emit("disconnected", { code: 1006, reason: "" });
    clientFor("a").emit("reconnecting", { attempt: 1, delayMs: 1000 });

    expect(logger.logged("info", "rust+ disconnected")).toEqual([
      { serverId: "a", code: 1006, reason: "" },
    ]);
    expect(logger.logged("info", "rust+ reconnect scheduled")).toEqual([
      { serverId: "a", attempt: 1, delayMs: 1000 },
    ]);
  });

  it("logs an entity broadcast at debug", async () => {
    const { core, clientFor, logger } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");

    clientFor("a").emit("entityChanged", change(7, true));

    expect(logger.logged("debug", "rust+ entity changed")).toEqual([
      { serverId: "a", entityId: 7, value: true },
    ]);
  });

  it("logs a storage monitor broadcast's shape and upkeep, never its contents", async () => {
    const { core, clientFor, logger } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");

    clientFor("a").emit("entityChanged", {
      entityId: 9,
      value: false,
      items: [{ itemId: -151838493, quantity: 451, itemIsBlueprint: false }],
      capacity: 24,
      hasProtection: true,
      protectionExpiry: 1_800_000_000,
    });

    expect(logger.logged("debug", "rust+ entity changed")).toEqual([
      {
        serverId: "a",
        entityId: 9,
        value: false,
        items: 1,
        capacity: 24,
        hasProtection: true,
        protectionExpiry: 1_800_000_000,
      },
    ]);
  });

  it("logs server and device pairings by id, never the playerToken", async () => {
    const { core, fcm, logger } = setup({ credentials: makeStoredCreds() });
    await core.start();

    fcm.emit("serverPairing", makePairing({ id: "srv", name: "My Server" }));
    await flushMicrotasks();
    fcm.emit(
      "entityPairing",
      makePairing({ id: "srv", type: "entity", entityId: 42, entityType: 1 }),
    );
    await flushMicrotasks();

    expect(logger.logged("info", "server paired")).toEqual([
      { serverId: "srv", name: "My Server", repaired: false },
    ]);
    expect(logger.logged("info", "device paired")).toEqual([
      { serverId: "srv", entityId: 42, entityType: "switch", repaired: false },
    ]);
    expect(JSON.stringify(logger.lines)).not.toContain("tok-a");
  });
});

// Live test 2026-11-16: after `app.regeneratetoken` and an in-game re-pair,
// the running client kept sending the old playerToken.
describe("BotCore re-pair with new credentials", () => {
  it("replaces the client so the next connect uses the new playerToken", async () => {
    const { core, fcm, clientFactory, clients, logger } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");
    const old = clients[0]!;

    fcm.emit("serverPairing", makePairing({ id: "a", playerToken: "tok-new" }));
    await flushMicrotasks();
    expect(old.disconnect).toHaveBeenCalledOnce();

    await core.connectServer("a"); // what the coordinator does on serverPaired
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(clientFactory.mock.calls[1]![0].playerToken).toBe("tok-new");
    expect(logger.logged("info", "rust+ client replaced: re-paired with new credentials")).toEqual([
      { serverId: "a" },
    ]);
  });

  it("keeps the client when a re-pair carries the same credentials", async () => {
    const { core, fcm, clientFactory, clients } = setup({
      servers: [makeServer("a")],
      credentials: makeStoredCreds(),
    });
    await core.start();
    await core.connectServer("a");

    fcm.emit("serverPairing", makePairing({ id: "a" }));
    await flushMicrotasks();
    await core.connectServer("a");

    expect(clients[0]!.disconnect).not.toHaveBeenCalled();
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });
});

describe("BotCore auto-revert timers", () => {
  it("arms with the configured delay, or the default when none is set", async () => {
    const { core, clientFor, timers } = setup({
      servers: [makeServer("a")],
      entities: [
        makeEntity("a", 1, { autoAction: "off", autoActionDelaySeconds: 45 }),
        makeEntity("a", 2, { autoAction: "off" }),
      ],
    });
    await core.start();
    await core.connectServer("a");

    clientFor("a").emit("entityChanged", change(1, true));
    clientFor("a").emit("entityChanged", change(2, true));

    expect(timers.armedDelays).toEqual([45_000, SWITCH_AUTO_DELAY_DEFAULT * 1000]);
  });

  it("auto-on mirrors auto-off: OFF is the trigger and the revert turns it ON", async () => {
    const { core, clientFor, timers, logger } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1, { autoAction: "on", autoActionDelaySeconds: 30 })],
    });
    await core.start();
    await core.connectServer("a"); // reported OFF on connect → already armed
    expect(timers.armed).toBe(1);

    clientFor("a").emit("entityChanged", change(1, true)); // at target → disarm
    expect(timers.armed).toBe(0);

    clientFor("a").emit("entityChanged", change(1, false));
    expect(timers.armed).toBe(1);
    await timers.fireAll();

    expect(clientFor("a").setEntityValue).toHaveBeenCalledWith(1, true);
    expect(logger.logged("info", "auto-revert fired")).toEqual([
      { serverId: "a", entityId: 1, target: "on" },
    ]);
  });

  it("a repeated trigger report restarts the countdown rather than stacking timers", async () => {
    const { core, clientFor, timers } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1, { autoAction: "off", autoActionDelaySeconds: 60 })],
    });
    await core.start();
    await core.connectServer("a");

    clientFor("a").emit("entityChanged", change(1, true));
    clientFor("a").emit("entityChanged", change(1, true));

    expect(timers.armed).toBe(1);
    expect(timers.armedDelays).toEqual([60_000, 60_000]);
  });

  it("a disconnect clears only that server's timers", async () => {
    const { core, clientFor, timers } = setup({
      servers: [makeServer("a"), makeServer("bb")],
      entities: [
        makeEntity("a", 1, { autoAction: "off" }),
        makeEntity("bb", 1, { autoAction: "off" }),
      ],
    });
    await core.start();
    await core.connectServer("a");
    await core.connectServer("bb");
    clientFor("a").emit("entityChanged", change(1, true));
    clientFor("bb").emit("entityChanged", change(1, true));
    expect(timers.armed).toBe(2);

    clientFor("a").emit("disconnected", { code: 1006, reason: "dropped" });
    expect(timers.autoReverts).toBe(1);

    await timers.fireAll();
    expect(clientFor("bb").setEntityValue).toHaveBeenCalledWith(1, false);
    expect(clientFor("a").setEntityValue).not.toHaveBeenCalled();
  });

  it("a failing revert is logged and never rejects", async () => {
    const { core, clientFor, timers, logger } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1, { autoAction: "off" })],
    });
    await core.start();
    await core.connectServer("a");
    clientFor("a").setEntityValue.mockRejectedValueOnce(new Error("rate limited"));
    clientFor("a").emit("entityChanged", change(1, true));

    await timers.fireAll();

    expect(logger.warned("auto-revert toggle failed")).toBe(true);
    expect(timers.armed).toBe(0);
  });

  it("clearing the auto action disarms a pending timer", async () => {
    const { core, clientFor, timers, store } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1, { autoAction: "off" })],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    client.emit("entityChanged", change(1, true));
    expect(timers.armed).toBe(1);
    client.getEntityInfo.mockResolvedValue({ entityId: 1, type: "switch", value: true, items: [] });

    await core.setSwitchAutoAction("a", 1, null);

    expect(store.getEntity("a", 1)?.autoAction).toBeUndefined();
    expect(timers.armed).toBe(0);
  });

  it("changing a setting while offline persists it and arms nothing until reconnect", async () => {
    const { core, clientFor, timers, store } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1)],
    });
    await core.start();
    await core.connectServer("a");
    const client = clientFor("a");
    client.emit("disconnected", { code: 1006, reason: "dropped" });
    client.getEntityInfo.mockClear();

    await core.setSwitchAutoAction("a", 1, "off");

    expect(store.getEntity("a", 1)?.autoAction).toBe("off");
    expect(client.getEntityInfo).not.toHaveBeenCalled();
    expect(timers.autoReverts).toBe(0);

    // Back online with the switch already ON → the countdown starts now.
    client.getEntityInfo.mockResolvedValue({ entityId: 1, type: "switch", value: true, items: [] });
    await core.connectServer("a");
    expect(timers.autoReverts).toBe(1);
  });

  it("a re-arm lookup failure is logged and leaves the setting persisted", async () => {
    const { core, clientFor, timers, store, logger } = setup({
      servers: [makeServer("a")],
      entities: [makeEntity("a", 1)],
    });
    await core.start();
    await core.connectServer("a");
    clientFor("a").getEntityInfo.mockRejectedValueOnce(new Error("timeout"));

    await expect(core.setSwitchAutoAction("a", 1, "off")).resolves.toBeUndefined();

    expect(store.getEntity("a", 1)?.autoAction).toBe("off");
    expect(logger.warned("auto-revert re-arm getEntityInfo failed")).toBe(true);
    expect(timers.armed).toBe(0);
  });

  it("removing an entity cancels its countdown and leaves its neighbours armed", async () => {
    const { core, clientFor, timers } = setup({
      servers: [makeServer("a")],
      entities: [
        makeEntity("a", 1, { autoAction: "off" }),
        makeEntity("a", 2, { autoAction: "off" }),
      ],
    });
    const removed: { serverId: string; entityId: number }[] = [];
    core.on("entityRemoved", (r) => removed.push(r));
    await core.start();
    await core.connectServer("a");
    clientFor("a").emit("entityChanged", change(1, true));
    clientFor("a").emit("entityChanged", change(2, true));

    await core.removeEntity("a", 1);

    expect(removed).toEqual([{ serverId: "a", entityId: 1 }]);
    expect(timers.armed).toBe(1);
    await timers.fireAll();
    expect(clientFor("a").setEntityValue.mock.calls).toEqual([[2, false]]);
  });
});

// ── server connection status: reconnecting before offline ───────────────────

describe("BotCore server connection status", () => {
  type StatusEvent = BotCoreEventMap["serverStatusChanged"][0];

  async function connected() {
    const h = setup({ servers: [makeServer("a")] });
    const events: StatusEvent[] = [];
    h.core.on("serverStatusChanged", (e) => events.push(e));
    await h.core.start();
    await h.core.connectServer("a");
    return { ...h, events, statuses: () => events.map((e) => e.status) };
  }

  it("is offline before the first connect, and connected after it", async () => {
    const { core } = setup({ servers: [makeServer("a")] });
    expect(core.getServerStatus("a")).toEqual({ status: "offline" });
    await core.start();
    await core.connectServer("a");
    expect(core.getServerStatus("a")).toEqual({ status: "connected" });
  });

  it("a short drop is reconnecting, then connected: never offline", async () => {
    const h = await connected();

    h.clientFor("a").emit("disconnected", { code: 1006, reason: "proxy restarting" });
    expect(h.core.getServerStatus("a")).toEqual({ status: "reconnecting", lastSeenAt: CLOCK_NOW });

    h.clientFor("a").connected = true;
    h.clientFor("a").emit("connected");

    expect(h.statuses()).toEqual(["connected", "reconnecting", "connected"]);
    expect(h.events.at(-1)).toEqual({
      serverId: "a",
      status: "connected",
      previous: "reconnecting",
    });
    // The grace timer is gone: it can never report offline later.
    expect(h.timers.armedDelays).toContain(SERVER_OFFLINE_GRACE_MS);
    h.timers.fire(SERVER_OFFLINE_GRACE_MS);
    expect(h.statuses()).not.toContain("offline");
    expect(h.core.getServerStatus("a")).toEqual({ status: "connected" });
  });

  it("a drop that outlasts the grace period is offline, keeping when it was last seen", async () => {
    const h = await connected();

    h.clientFor("a").emit("disconnected", { code: 1006, reason: "" });
    h.timers.fire(SERVER_OFFLINE_GRACE_MS);

    expect(h.statuses()).toEqual(["connected", "reconnecting", "offline"]);
    expect(h.events.at(-1)).toEqual({
      serverId: "a",
      status: "offline",
      previous: "reconnecting",
      lastSeenAt: CLOCK_NOW,
    });
    expect(h.core.getServerStatus("a")).toEqual({ status: "offline", lastSeenAt: CLOCK_NOW });

    // Recovery from offline says so.
    h.clientFor("a").connected = true;
    h.clientFor("a").emit("connected");
    expect(h.events.at(-1)).toEqual({ serverId: "a", status: "connected", previous: "offline" });
  });

  it("reports each change once: repeated drops and connects emit nothing new", async () => {
    const h = await connected();

    h.clientFor("a").emit("connected");
    h.clientFor("a").emit("disconnected", { code: 1006, reason: "" });
    h.clientFor("a").emit("disconnected", { code: 1006, reason: "" });

    expect(h.statuses()).toEqual(["connected", "reconnecting"]);
    expect(h.timers.armedDelays.filter((ms) => ms === SERVER_OFFLINE_GRACE_MS)).toHaveLength(1);
  });

  it("honours an injected grace period", async () => {
    const { core, clientFor, timers } = setup(
      { servers: [makeServer("a")] },
      { offlineGraceMs: 5_000 },
    );
    await core.start();
    await core.connectServer("a");

    clientFor("a").emit("disconnected", { code: 1006, reason: "" });
    timers.fire(5_000);

    expect(core.getServerStatus("a")).toEqual({ status: "offline", lastSeenAt: CLOCK_NOW });
  });

  it("a reconnect for new credentials is reconnecting, and offline if it then fails", async () => {
    const h = setup({ servers: [makeServer("a")], credentials: makeStoredCreds() });
    const events: StatusEvent[] = [];
    h.core.on("serverStatusChanged", (e) => events.push(e));
    await h.core.start();
    await h.core.connectServer("a");
    // The fresh client's connect fails.
    h.clientFactory.mockImplementationOnce((options: ClientOptions) => {
      const client = new FakeClient(options);
      client.connect.mockRejectedValue(new Error("unreachable"));
      return client as never;
    });

    await h.core.refreshCredentials();
    expect(events.map((e) => e.status)).toEqual(["connected", "reconnecting"]);

    h.timers.fire(SERVER_OFFLINE_GRACE_MS);
    expect(events.map((e) => e.status)).toEqual(["connected", "reconnecting", "offline"]);
  });

  it("stop() disarms the grace timer and forgets every status", async () => {
    const h = await connected();
    h.clientFor("a").emit("disconnected", { code: 1006, reason: "" });

    await h.core.stop();

    h.timers.fire(SERVER_OFFLINE_GRACE_MS);
    expect(h.statuses()).toEqual(["connected", "reconnecting"]);
    expect(h.core.getServerStatus("a")).toEqual({ status: "offline" });
  });
});

describe("BotCore switch groups", () => {
  /** Server "a" with switches 1–4, an alarm 9, and the given server overrides. */
  function groupSetup(server: Partial<PairedServer> = {}) {
    return setup({
      servers: [makeServer("a", server)],
      entities: [
        makeEntity("a", 1),
        makeEntity("a", 2),
        makeEntity("a", 3),
        makeEntity("a", 4),
        makeEntity("a", 9, { entityType: "alarm" }),
      ],
    });
  }

  it("creates a group, persists it JSON-serializably, and lists it", async () => {
    const { core, store } = groupSetup();
    await core.start();

    const group = await core.createSwitchGroup("a", "  Turrets ", [2, 1, 2]);

    expect(group).toEqual({ id: expect.stringMatching(/^g/), name: "Turrets", entityIds: [2, 1] });
    expect(core.listSwitchGroups("a")).toEqual([group]);
    const persisted = store.getServer("a")!;
    expect(JSON.parse(JSON.stringify(persisted))).toEqual(persisted);
    expect(persisted.switchGroups).toEqual([group]);
  });

  it("round-trips through JSON into a fresh core, ids and order intact", async () => {
    const first = groupSetup();
    await first.core.start();
    const turrets = await first.core.createSwitchGroup("a", "Turrets", [3, 1]);
    const lights = await first.core.createSwitchGroup("a", "Lights", [2]);
    expect(turrets.id).not.toBe(lights.id);

    const reloaded = setup(
      JSON.parse(
        JSON.stringify({
          servers: first.store.listServers(),
          entities: first.store.listEntities("a"),
        }),
      ),
    );
    await reloaded.core.start();

    expect(reloaded.core.listSwitchGroups("a")).toEqual([turrets, lights]);
    await reloaded.core.renameSwitchGroup("a", turrets.id, "Gate turrets");
    expect(reloaded.core.listSwitchGroups("a")[0]!.name).toBe("Gate turrets");
  });

  it("loads state that predates groups: none listed, and groups can be added", async () => {
    // A server written before switch groups existed: no switchGroups key at all.
    const old = JSON.parse(JSON.stringify(makeServer("a"))) as PairedServer;
    expect("switchGroups" in old).toBe(false);
    const { core } = setup({ servers: [old], entities: [makeEntity("a", 1)] });
    await core.start();

    expect(core.listSwitchGroups("a")).toEqual([]);
    expect(core.listSwitchGroups("unknown")).toEqual([]);
    await core.createSwitchGroup("a", "Turrets", [1]);
    expect(core.listSwitchGroups("a").map((g) => g.entityIds)).toEqual([[1]]);
  });

  it("rejects bad input with typed errors and persists nothing", async () => {
    const { core, store } = groupSetup();
    await core.start();
    const lights = await core.createSwitchGroup("a", "Lights", [4]);

    await expect(core.createSwitchGroup("nope", "X", [1])).rejects.toBeInstanceOf(StateError);
    await expect(core.createSwitchGroup("a", "X", [1, 9])).rejects.toBeInstanceOf(StateError);
    await expect(core.createSwitchGroup("a", "X", [1, 77])).rejects.toBeInstanceOf(StateError);
    await expect(core.createSwitchGroup("a", "   ", [1])).rejects.toBeInstanceOf(ValidationError);
    await expect(core.createSwitchGroup("a", "x".repeat(65), [1])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(core.createSwitchGroup("a", "X", [])).rejects.toBeInstanceOf(ValidationError);
    await expect(core.createSwitchGroup("a", "X", [1, 4])).rejects.toBeInstanceOf(ValidationError);
    await expect(core.renameSwitchGroup("a", "g-gone", "X")).rejects.toBeInstanceOf(StateError);
    await expect(core.setSwitchGroupMembers("a", lights.id, [])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(core.deleteSwitchGroup("a", "g-gone")).rejects.toBeInstanceOf(StateError);

    expect(store.getServer("a")!.switchGroups).toEqual([lights]);
  });

  it("holds at most SWITCH_GROUP_MAX_MEMBERS switches", async () => {
    const ids = Array.from({ length: SWITCH_GROUP_MAX_MEMBERS + 1 }, (_, i) => i + 1);
    const { core } = setup({
      servers: [makeServer("a")],
      entities: ids.map((id) => makeEntity("a", id)),
    });
    await core.start();

    await expect(core.createSwitchGroup("a", "All", ids)).rejects.toBeInstanceOf(ValidationError);
    const group = await core.createSwitchGroup("a", "All", ids.slice(1));
    expect(group.entityIds).toHaveLength(SWITCH_GROUP_MAX_MEMBERS);
  });

  it("renames, sets members (keeping its own) and deletes", async () => {
    const { core, store } = groupSetup();
    await core.start();
    const group = await core.createSwitchGroup("a", "Turrets", [1, 2]);

    await core.renameSwitchGroup("a", group.id, "Gate");
    await core.setSwitchGroupMembers("a", group.id, [2, 3]);
    expect(core.listSwitchGroups("a")).toEqual([{ id: group.id, name: "Gate", entityIds: [2, 3] }]);

    await core.deleteSwitchGroup("a", group.id);
    expect(core.listSwitchGroups("a")).toEqual([]);
    expect(store.getServer("a")!.switchGroups).toBeUndefined();
  });

  it("removing a member device takes it out of its group, before entityRemoved fires", async () => {
    const { core } = groupSetup();
    await core.start();
    const turrets = await core.createSwitchGroup("a", "Turrets", [1, 2]);
    const seen: unknown[] = [];
    core.on("entityRemoved", ({ serverId }) => seen.push(core.listSwitchGroups(serverId)));

    await core.removeEntity("a", 1);

    expect(core.listSwitchGroups("a")).toEqual([{ ...turrets, entityIds: [2] }]);
    expect(seen).toEqual([[{ ...turrets, entityIds: [2] }]]);
  });

  it("removing a group's last member deletes the group", async () => {
    const { core, store, logger } = groupSetup();
    await core.start();
    const solo = await core.createSwitchGroup("a", "Solo", [3]);
    const kept = await core.createSwitchGroup("a", "Kept", [4]);

    await core.removeEntity("a", 3);

    expect(store.getServer("a")!.switchGroups).toEqual([kept]);
    expect(logger.logged("info", "switch group deleted: no members left")).toEqual([
      { serverId: "a", groupId: solo.id },
    ]);
  });

  it("a re-pair of the server keeps its groups", async () => {
    const { core, fcm } = groupSetup();
    await core.start();
    const group = await core.createSwitchGroup("a", "Turrets", [1]);

    fcm.emit("serverPairing", makePairing({ id: "a" }));
    await flushMicrotasks();

    expect(core.listSwitchGroups("a")).toEqual([group]);
  });

  it("lists only members that are still paired switches, each in one group", async () => {
    const { core } = groupSetup({
      switchGroups: [
        { id: "g1", name: "A", entityIds: [1, 9, 77] },
        { id: "g2", name: "B", entityIds: [1, 2] },
        { id: "g3", name: "Ghost", entityIds: [88] },
      ],
    });
    await core.start();

    expect(core.listSwitchGroups("a")).toEqual([
      { id: "g1", name: "A", entityIds: [1] },
      { id: "g2", name: "B", entityIds: [2] },
    ]);
  });
});
