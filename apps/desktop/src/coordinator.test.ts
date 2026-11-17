import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

import { InMemoryStateStore, type StoredCredentials } from "@conduit/bot-core";

import { Coordinator } from "./coordinator.js";
import type { StatusSnapshot } from "./ipc-contract.js";

/** Minimal fake fcm: an EventEmitter with the methods the coordinator calls. */
class FakeFcm extends EventEmitter {
  startListening = vi.fn().mockResolvedValue(undefined);
  stopListening = vi.fn().mockResolvedValue(undefined);
}

/** Minimal fake bot-core: an EventEmitter with the surface the coordinator uses. */
class FakeCore extends EventEmitter {
  servers: { id: string; name: string }[] = [];
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
  connectServer = vi.fn().mockResolvedValue(undefined);
  refreshCredentials = vi.fn().mockResolvedValue(undefined);
  renewCredentials = vi.fn().mockResolvedValue(undefined);
  checkAuthToken = vi.fn().mockResolvedValue("ok");
  listServers = vi.fn(() => this.servers);
  listEntities = vi.fn(() => []);
  /** What `getServerStatus` reports per server (default: offline). */
  readonly statuses = new Map<string, "connected" | "reconnecting" | "offline">();
  getServerStatus = vi.fn((serverId: string) => ({
    status: this.statuses.get(serverId) ?? "offline",
  }));
}

function creds(steamExpiry: string): StoredCredentials {
  return {
    fcm: {
      fcm: {},
      gcm: {},
      expoPushToken: "x",
      steamAuthToken: "s",
      steamTokenExpiresAt: steamExpiry,
    },
    discordBotToken: "tok",
    steamTokenExpiresAt: steamExpiry,
  };
}

function makeCoordinator(
  opts: {
    store?: InMemoryStateStore;
    fcm?: FakeFcm;
    core?: FakeCore;
    now?: number;
    /** Overrides the recording start-on-login seam (e.g. one that throws). */
    applyStartOnLogin?: (enabled: boolean) => void;
  } = {},
) {
  const store = opts.store ?? new InMemoryStateStore();
  const fcm = opts.fcm ?? new FakeFcm();
  const core = opts.core ?? new FakeCore();
  const adapter = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    deleteAllPanels: vi.fn().mockResolvedValue(0),
  };
  const createDiscordAdapter = vi.fn(() => adapter);
  /** Every value handed to the OS login-item seam, in order. */
  const loginItem: boolean[] = [];
  const coordinator = new Coordinator({
    applyStartOnLogin: opts.applyStartOnLogin ?? ((enabled) => loginItem.push(enabled)),
    store,
    fcm: fcm as never,
    core: core as never,
    panelStore: {
      setServerPanelIds: vi.fn(),
      clearLegacyPanelIds: vi.fn(),
      setEntityWatch: vi.fn(),
    } as never,
    createDiscordAdapter: createDiscordAdapter as never,
    now: () => opts.now ?? Date.now(),
  });
  return { coordinator, store, fcm, core, adapter, createDiscordAdapter, loginItem };
}

// The Steam sign-in (companion auth token) must be renewed every 14 days:
// Facepunch refuses to refresh an expired one.
describe("Coordinator Steam sign-in renewal", () => {
  it("asks bot-core whether a renewal is needed on each refresh check", async () => {
    const store = new InMemoryStateStore({ credentials: creds("2099-01-01T00:00:00.000Z") });
    const { coordinator, core } = makeCoordinator({ store });
    await coordinator.start();
    await vi.waitFor(() => expect(core.checkAuthToken).toHaveBeenCalled());
    await coordinator.stop();
  });

  it.each([
    ["expiring", "idle", "expires soon · sign in again"],
    ["expired", "down", "expired · sign in again"],
    ["rejected", "down", "rejected by Facepunch · sign in again"],
  ] as const)(
    "a %s notice adds a Steam sign-in row and the sign-in button",
    async (reason, level, caption) => {
      const { coordinator, core } = makeCoordinator();
      await coordinator.start();
      const snaps: StatusSnapshot[] = [];
      coordinator.onStatus((s) => snaps.push(s));
      expect(coordinator.snapshot().steamSignInNeeded).toBe(false);

      core.emit("authRenewalNeeded", { reason });

      const snap = snaps.at(-1)!;
      expect(snap.steamSignInNeeded).toBe(true);
      expect(snap.rows.find((r) => r.id === "steam")).toEqual({
        id: "steam",
        level,
        label: "Steam sign-in",
        caption,
      });
    },
  );

  it("renewSteamSignIn hands the Steam window to bot-core and clears the prompt", async () => {
    const { coordinator, core } = makeCoordinator();
    await coordinator.start();
    core.emit("authRenewalNeeded", { reason: "expired" });
    const opts = { onSteamLogin: vi.fn(async () => {}) };

    await coordinator.renewSteamSignIn(opts);

    expect(core.renewCredentials).toHaveBeenCalledWith(opts);
    expect(coordinator.snapshot().steamSignInNeeded).toBe(false);
    expect(coordinator.snapshot().rows.some((r) => r.id === "steam")).toBe(false);
  });

  it("a failed renewal keeps the prompt and rethrows", async () => {
    const { coordinator, core } = makeCoordinator();
    await coordinator.start();
    core.emit("authRenewalNeeded", { reason: "expired" });
    core.renewCredentials.mockRejectedValueOnce(new Error("cancelled"));

    await expect(coordinator.renewSteamSignIn({ onSteamLogin: async () => {} })).rejects.toThrow(
      "cancelled",
    );
    expect(coordinator.snapshot().steamSignInNeeded).toBe(true);
  });

  it("an automatic refresh that lands new credentials clears the prompt", async () => {
    const store = new InMemoryStateStore({ credentials: creds("2099-01-01T00:00:00.000Z") });
    const { coordinator, core, fcm } = makeCoordinator({ store });
    await coordinator.start();
    core.emit("authRenewalNeeded", { reason: "expiring" });

    fcm.emit("credentialsRefreshed", creds("2099-02-01T00:00:00.000Z").fcm);

    expect(coordinator.snapshot().steamSignInNeeded).toBe(false);
    await coordinator.stop();
  });
});

describe("Coordinator", () => {
  it("stays idle when not bootstrapped (no credentials)", async () => {
    const { coordinator, fcm, createDiscordAdapter, core } = makeCoordinator();
    await coordinator.start();
    expect(core.start).toHaveBeenCalled();
    expect(fcm.startListening).not.toHaveBeenCalled();
    expect(createDiscordAdapter).not.toHaveBeenCalled();
  });

  it("brings the runtime online when bootstrapped on start()", async () => {
    const store = new InMemoryStateStore();
    await store.setCredentials(creds("2099-01-01T00:00:00.000Z"));
    const core = new FakeCore();
    core.servers = [{ id: "srv-1", name: "Server One" }];
    const { coordinator, fcm, createDiscordAdapter, adapter } = makeCoordinator({
      store,
      core,
    });

    await coordinator.start();

    expect(fcm.startListening).toHaveBeenCalledTimes(1);
    expect(core.connectServer).toHaveBeenCalledWith("srv-1");
    expect(createDiscordAdapter).toHaveBeenCalledWith("tok");
    expect(adapter.start).toHaveBeenCalled();

    // The adapter must start (and subscribe) before servers connect, so it never
    // misses the connect event that flips the status panel to online.
    expect(adapter.start.mock.invocationCallOrder[0]).toBeLessThan(
      core.connectServer.mock.invocationCallOrder[0]!,
    );
  });

  // Regression (live test 2026-11-16): a server paired while the coordinator ran
  // stayed idle until the next app start, because only start() connected servers.
  it("connects a server paired while it runs", async () => {
    const store = new InMemoryStateStore();
    await store.setCredentials(creds("2099-01-01T00:00:00.000Z"));
    const { coordinator, core } = makeCoordinator({ store });
    await coordinator.start();
    expect(core.connectServer).not.toHaveBeenCalled();

    core.emit("serverPaired", { id: "srv-new", name: "New Server" });
    await vi.waitFor(() => expect(core.connectServer).toHaveBeenCalledWith("srv-new"));
  });

  it("survives a failed connect for a newly paired server", async () => {
    const store = new InMemoryStateStore();
    await store.setCredentials(creds("2099-01-01T00:00:00.000Z"));
    const core = new FakeCore();
    core.connectServer.mockRejectedValueOnce(new Error("handshake refused"));
    const { coordinator } = makeCoordinator({ store, core });
    await coordinator.start();

    core.emit("serverPaired", { id: "srv-new", name: "New Server" });
    await vi.waitFor(() => expect(core.connectServer).toHaveBeenCalledTimes(1));
    // The rejection is caught and logged; nothing escapes as an unhandled rejection.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("persists refreshed credentials on fcm credentialsRefreshed", async () => {
    const store = new InMemoryStateStore();
    await store.setCredentials(creds("2026-06-13T00:00:00.000Z"));
    const fcm = new FakeFcm();
    const { coordinator } = makeCoordinator({ store, fcm });
    await coordinator.start();

    fcm.emit("credentialsRefreshed", {
      fcm: {},
      gcm: {},
      expoPushToken: "x2",
      steamAuthToken: "s2",
      steamTokenExpiresAt: "2026-07-01T00:00:00.000Z",
    });
    // Allow the async persistence microtask to settle.
    await new Promise((r) => setTimeout(r, 0));

    const stored = await store.getCredentials();
    expect(stored?.steamTokenExpiresAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("computes overall health as worst-of the rows", async () => {
    const core = new FakeCore();
    core.servers = [{ id: "a", name: "A" }];
    const { coordinator } = makeCoordinator({ core });
    await coordinator.start(); // not bootstrapped → fcm/discord down

    const snap = coordinator.snapshot();
    // fcm + discord are "down" since we never brought the runtime online.
    expect(snap.overall).toBe("down");
    expect(snap.rows.some((r) => r.label === "Push listener (FCM)")).toBe(true);
    expect(snap.rows.some((r) => r.label === "Discord gateway")).toBe(true);
  });

  it("shows a reconnecting server amber and only an offline one red", async () => {
    const core = new FakeCore();
    core.servers = [{ id: "srv-1", name: "Server One" }];
    const { coordinator } = makeCoordinator({ core });
    await coordinator.start();
    const row = () => coordinator.snapshot().rows.find((r) => r.id === "server:srv-1");

    core.emit("serverStatusChanged", { serverId: "srv-1", status: "connected" });
    expect(row()).toMatchObject({ level: "online", caption: "connected" });

    core.emit("serverStatusChanged", { serverId: "srv-1", status: "reconnecting" });
    expect(row()).toMatchObject({ level: "idle", caption: "reconnecting…" });

    core.emit("serverStatusChanged", { serverId: "srv-1", status: "offline" });
    expect(row()).toMatchObject({ level: "down", caption: "disconnected" });
  });

  it("degrades the Discord row when a post error is reported", async () => {
    const core = new FakeCore();
    const { coordinator } = makeCoordinator({ core });
    await coordinator.start();

    coordinator.reportDiscordPostError({
      channelId: "chan",
      code: 50013,
      message: "Missing Permissions",
      permission: true,
    });

    const row = coordinator.snapshot().rows.find((r) => r.id === "discord");
    expect(row?.level).toBe("idle");
    expect(row?.caption).toContain("permissions");
  });

  it("says Discord is limiting panel edits when it reports the 30046 edit cap", async () => {
    const core = new FakeCore();
    const { coordinator } = makeCoordinator({ core });
    await coordinator.start();

    coordinator.reportDiscordPostError({
      channelId: "chan",
      code: 30046,
      message: "Maximum number of edits to messages older than 1 hour reached.",
      permission: false,
      editCap: true,
    });

    const row = coordinator.snapshot().rows.find((r) => r.id === "discord");
    expect(row?.level).toBe("idle");
    expect(row?.caption).toContain("limiting panel edits");
  });

  it("notes that panels were rebuilt after the edit cap, without degrading the row", async () => {
    const store = new InMemoryStateStore({ credentials: creds("2099-01-01T00:00:00.000Z") });
    const { coordinator } = makeCoordinator({ store });
    await coordinator.start();
    expect(coordinator.snapshot().rows.find((r) => r.id === "discord")?.level).toBe("online");

    coordinator.reportDiscordPostError({
      channelId: "chan",
      code: 30046,
      message: "Maximum number of edits to messages older than 1 hour reached",
      permission: false,
      editCap: true,
      panelsRebuilt: true,
    });

    const row = coordinator.snapshot().rows.find((r) => r.id === "discord");
    expect(row?.level).toBe("online");
    expect(row?.caption).toContain("Discord limited panel edits; panels were rebuilt");

    // A real failure afterwards degrades the row as before.
    coordinator.reportDiscordPostError({
      channelId: "chan",
      code: 50013,
      message: "Missing Permissions",
      permission: true,
    });
    const after = coordinator.snapshot().rows.find((r) => r.id === "discord");
    expect(after?.level).toBe("idle");
    expect(after?.caption).toContain("permissions");
    await coordinator.stop();
  });

  it("resetAll deletes panels, tears down, wipes state, and goes idle", async () => {
    const store = new InMemoryStateStore();
    await store.setCredentials(creds("2099-01-01T00:00:00.000Z"));
    await store.upsertServer({
      id: "srv-1",
      name: "Server One",
      desc: "",
      ip: "1.1.1.1",
      port: 1,
      playerId: "0",
      playerToken: "0",
      addedAt: "",
    });
    const core = new FakeCore();
    // Make the fake faithful: real bot-core reads servers from the store, so the
    // list reflects store.clear() — mirror that here instead of a static array.
    core.listServers = vi.fn(() => store.listServers().map((s) => ({ id: s.id, name: s.name })));
    const { coordinator, adapter } = makeCoordinator({ store, core });

    await coordinator.start(); // bootstrapped → online, this.discord set
    await coordinator.resetAll();

    // Panels deleted while the adapter was still up, then the adapter stopped.
    expect(adapter.deleteAllPanels).toHaveBeenCalledTimes(1);
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(adapter.deleteAllPanels.mock.invocationCallOrder[0]!).toBeLessThan(
      adapter.stop.mock.invocationCallOrder[0]!,
    );
    // The runtime is torn down via bot-core (which stops fcm + disconnects clients).
    expect(core.stop).toHaveBeenCalled();

    // State wiped back to vanilla.
    expect(store.listServers()).toEqual([]);
    expect(await store.getCredentials()).toBeUndefined();

    // Tray drops to the empty "down" snapshot.
    const snap = coordinator.snapshot();
    expect(snap.rows.some((r) => r.id === "server:srv-1")).toBe(false);
    expect(snap.overall).toBe("down");
  });

  it.each([true, false])(
    "reflects the persisted start-on-login preference (%s) into the OS on start()",
    async (startOnLogin) => {
      const store = new InMemoryStateStore({
        config: { startOnLogin, roleCapabilities: { admin: [], user: [] } },
      });
      const { coordinator, loginItem } = makeCoordinator({ store });

      await coordinator.start();

      expect(loginItem).toEqual([startOnLogin]);
    },
  );

  it("applies a start-on-login change announced by bot-core at runtime", async () => {
    const { coordinator, core, loginItem } = makeCoordinator();
    await coordinator.start();
    loginItem.length = 0;

    core.emit("startOnLoginChanged", { enabled: true });
    core.emit("startOnLoginChanged", { enabled: false });

    expect(loginItem).toEqual([true, false]);
  });

  it("does not apply a start-on-login change twice when start() is called again", async () => {
    const { coordinator, core, loginItem } = makeCoordinator();
    await coordinator.start();
    await coordinator.start(); // idempotent: must not stack a second listener
    loginItem.length = 0;

    core.emit("startOnLoginChanged", { enabled: true });

    expect(loginItem).toEqual([true]);
  });

  it("survives the OS login-item seam throwing", async () => {
    const { coordinator, core } = makeCoordinator({
      applyStartOnLogin: () => {
        throw new Error("login items unavailable");
      },
    });

    await expect(coordinator.start()).resolves.toBeUndefined();
    expect(() => core.emit("startOnLoginChanged", { enabled: true })).not.toThrow();
  });

  it("resetAll takes the OS login item back along with the wiped config", async () => {
    const store = new InMemoryStateStore({
      config: { startOnLogin: true, roleCapabilities: { admin: [], user: [] } },
    });
    const { coordinator, core, loginItem } = makeCoordinator({ store });
    await coordinator.start();
    expect(loginItem).toEqual([true]);

    await coordinator.resetAll();

    expect(store.getConfig().startOnLogin).toBe(false);
    expect(loginItem).toEqual([true, false]);

    // Still listening after the reset (the wiring is not torn down by it), and
    // still exactly once.
    core.emit("startOnLoginChanged", { enabled: true });
    expect(loginItem).toEqual([true, false, true]);
  });

  it("formats the Steam token caption from a known expiry", () => {
    const now = Date.parse("2026-06-13T00:00:00.000Z");
    const { coordinator } = makeCoordinator({ now });
    const in9 = new Date(now + 9 * 24 * 60 * 60 * 1000).toISOString();
    expect(coordinator.tokenCaptionFor(in9)).toBe("Steam token renews in 9 days");
    expect(coordinator.tokenCaptionFor(undefined)).toBe("Not connected yet");
  });
});
