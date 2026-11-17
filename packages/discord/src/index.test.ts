import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageFlags } from "discord.js";

import {
  DiscordAdapter,
  formatGameTime,
  EDIT_DEBOUNCE_MS,
  buildCustomId,
  parseCustomId,
  CUSTOM_ID_MAX_LENGTH,
  HandleRegistry,
  buildAlarmSettingsPanel,
  buildSwitchSettingsPanel,
  layoutServer,
  isAllowed,
  resolveCapability,
  requiredCapabilityFor,
  adoptNamedRoles,
  CONDUIT_ROLE_NAMES,
  friendlyError,
  ENTITY_NOT_FOUND_MESSAGE,
  StateLockMachine,
  type DispatchableInteraction,
  type TimerProvider,
  type PostErrorInfo,
  type SwitchRowState,
} from "./index.js";

import type { AppConfig, PairedEntity, PairedServer, RoleCapabilityMap } from "@conduit/bot-core";

// ── customId build/parse round-trip ──────────────────────────────────────────

describe("customId scheme", () => {
  it("round-trips a fully-scoped entity customId", () => {
    const built = buildCustomId({
      domain: "switch",
      action: "off",
      server: "abc",
      entity: "def",
    });
    expect(built).toBe("conduit:v1:switch:off:abc:def");
    expect(parseCustomId(built)).toEqual({
      domain: "switch",
      action: "off",
      server: "abc",
      entity: "def",
    });
  });

  it("round-trips a guild-scoped (setup) customId with no handles", () => {
    const built = buildCustomId({ domain: "setup", action: "channel" });
    expect(built).toBe("conduit:v1:setup:channel");
    expect(parseCustomId(built)).toEqual({
      domain: "setup",
      action: "channel",
      server: undefined,
      entity: undefined,
    });
  });

  it("keeps handles well under Discord's 100-char limit (even with uuid sources)", () => {
    const registry = new HandleRegistry();
    const serverId = "11111111-2222-3333-4444-555555555555";
    const serverHandle = registry.register(serverId);
    const entityHandle = registry.register(HandleRegistry.entityKey(serverId, 1234567890));
    const id = buildCustomId({
      domain: "monitor",
      action: "watch",
      server: serverHandle,
      entity: entityHandle,
    });
    expect(id.length).toBeLessThanOrEqual(CUSTOM_ID_MAX_LENGTH);
    expect(registry.idFor(serverHandle)).toBe(serverId);
  });

  it("returns undefined for foreign / malformed customIds", () => {
    expect(parseCustomId("some-other-button")).toBeUndefined();
    expect(parseCustomId("conduit:v2:switch:on")).toBeUndefined();
    expect(parseCustomId("conduit:v1:switch")).toBeUndefined();
  });

  it("handles are deterministic across registry instances (restart-stable)", () => {
    const a = new HandleRegistry().register("server-x");
    const b = new HandleRegistry().register("server-x");
    expect(a).toBe(b);
  });
});

// ── permission resolution ────────────────────────────────────────────────────

describe("permissions", () => {
  const map: RoleCapabilityMap = { admin: ["ROLE_ADMIN"], user: ["ROLE_USER"] };

  it("admin implies user", () => {
    expect(resolveCapability(["ROLE_ADMIN"], map)).toBe("admin");
    expect(isAllowed(["ROLE_ADMIN"], map, "user")).toBe(true);
    expect(isAllowed(["ROLE_ADMIN"], map, "admin")).toBe(true);
  });

  it("user cannot perform admin actions", () => {
    expect(isAllowed(["ROLE_USER"], map, "user")).toBe(true);
    expect(isAllowed(["ROLE_USER"], map, "admin")).toBe(false);
  });

  it("unmapped member is denied everything", () => {
    expect(resolveCapability(["ROLE_NONE"], map)).toBeUndefined();
    expect(isAllowed(["ROLE_NONE"], map, "user")).toBe(false);
  });

  it("action→capability table fails closed for unknown actions", () => {
    expect(requiredCapabilityFor("switch", "off")).toBe("user");
    expect(requiredCapabilityFor("mystery", "thing")).toBe("admin");
  });
});

describe("adoptNamedRoles", () => {
  const NONE: RoleCapabilityMap = { admin: [], user: [] };
  const role = (id: string, name: string, managed = false) => ({ id, name, managed });
  const SERVER_ROLES = [
    role("everyone", "@everyone"),
    role("mods", "Moderators"),
    role("r-admin", "Conduit Admin"),
    role("r-user", "Conduit"),
  ];

  it("adopts the roles named Conduit Admin and Conduit when none are chosen", () => {
    expect(CONDUIT_ROLE_NAMES).toEqual({ admin: "Conduit Admin", user: "Conduit" });
    expect(adoptNamedRoles(NONE, SERVER_ROLES)).toEqual({ admin: ["r-admin"], user: ["r-user"] });
  });

  it("matches the names case-insensitively, ignoring outer spaces", () => {
    const roles = [role("a", " conduit admin"), role("u", "CONDUIT ")];
    expect(adoptNamedRoles(NONE, roles)).toEqual({ admin: ["a"], user: ["u"] });
  });

  it("adopts the one that exists and leaves the other empty", () => {
    expect(adoptNamedRoles(NONE, [role("u", "Conduit")])).toEqual({ admin: [], user: ["u"] });
    expect(adoptNamedRoles(NONE, [role("a", "Conduit Admin")])).toEqual({
      admin: ["a"],
      user: [],
    });
  });

  it("never replaces a choice made by hand, even a partial one", () => {
    expect(adoptNamedRoles({ admin: ["mine"], user: [] }, SERVER_ROLES)).toBeUndefined();
    expect(adoptNamedRoles({ admin: [], user: ["mine"] }, SERVER_ROLES)).toBeUndefined();
  });

  it("has nothing to save when no role has either name", () => {
    expect(adoptNamedRoles(NONE, [role("mods", "Moderators")])).toBeUndefined();
    expect(adoptNamedRoles(NONE, [])).toBeUndefined();
  });

  it("never adopts the bot's own integration role, which Discord names after the bot", () => {
    expect(adoptNamedRoles(NONE, [role("bot", "Conduit", true)])).toBeUndefined();
    expect(adoptNamedRoles(NONE, [role("bot", "Conduit", true), role("u", "Conduit")])).toEqual({
      admin: [],
      user: ["u"],
    });
  });

  it("leaves a name that more than one role has for the operator to choose", () => {
    const roles = [role("u1", "Conduit"), role("u2", "conduit"), role("a", "Conduit Admin")];
    expect(adoptNamedRoles(NONE, roles)).toEqual({ admin: ["a"], user: [] });
  });
});

// ── state-lock state machine (the headline test) ─────────────────────────────

describe("state-lock state machine", () => {
  it("click disables both buttons + pending; entityChanged re-enables to new state", () => {
    const machine = new StateLockMachine({ timeoutMs: 10_000 });
    const key = { serverId: "s1", entityId: 5 };
    machine.seed(key, true); // synced ON

    const clicked = machine.click(key, false); // user clicks OFF
    expect(clicked.changed).toBe(true);
    expect(clicked.snapshot.phase).toBe("pending");
    expect(clicked.snapshot.buttonsDisabled).toBe(true);

    const confirmed = machine.confirm(key, false); // tier-3 broadcast OFF
    expect(confirmed.snapshot.phase).toBe("synced");
    expect(confirmed.snapshot.buttonsDisabled).toBe(false);
    expect(confirmed.snapshot.value).toBe(false);
  });

  it("ignores a second click while already pending (no double-actuation)", () => {
    const machine = new StateLockMachine({ timeoutMs: 10_000 });
    const key = { serverId: "s1", entityId: 5 };
    machine.seed(key, true);
    machine.click(key, false);
    const second = machine.click(key, false);
    expect(second.changed).toBe(false);
    expect(second.snapshot.phase).toBe("pending");
  });

  it("timeout restores prior state + warns (fake timers)", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const machine = new StateLockMachine({ timeoutMs: 1000, onTimeout });
    const key = { serverId: "s1", entityId: 5 };
    machine.seed(key, true); // prior ON

    machine.click(key, false); // request OFF
    expect(machine.snapshot(key)?.buttonsDisabled).toBe(true);

    vi.advanceTimersByTime(1000); // no broadcast arrives

    expect(onTimeout).toHaveBeenCalledTimes(1);
    const [, result] = onTimeout.mock.calls[0];
    expect(result.warn).toBe(true);
    const snap = machine.snapshot(key);
    expect(snap?.value).toBe(true); // restored prior ON
    expect(snap?.buttonsDisabled).toBe(false);
    vi.useRealTimers();
  });

  it("confirm cancels the pending timeout (no late warn)", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const machine = new StateLockMachine({ timeoutMs: 1000, onTimeout });
    const key = { serverId: "s1", entityId: 5 };
    machine.seed(key, true);
    machine.click(key, false);
    machine.confirm(key, false);
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("uses an injected TimerProvider", () => {
    const set = vi.fn().mockReturnValue("handle");
    const clear = vi.fn();
    const timers: TimerProvider = { setTimer: set, clearTimer: clear };
    const machine = new StateLockMachine({ timeoutMs: 1000, timers });
    const key = { serverId: "s1", entityId: 7 };
    machine.seed(key, false);
    machine.click(key, true);
    expect(set).toHaveBeenCalledOnce();
    machine.confirm(key, true);
    expect(clear).toHaveBeenCalledWith("handle");
  });
});

// ── adapter dispatch fakes ───────────────────────────────────────────────────

interface FakeCoreState {
  config: AppConfig;
  servers: PairedServer[];
  entities: PairedEntity[];
  /** Server ids reported as live-connected by `isServerConnected`. */
  connectedServerIds?: string[];
}

function makeFakeCore(state: FakeCoreState) {
  const toggleEntity = vi
    .fn()
    .mockResolvedValue({ entityId: 0, type: "switch", value: true, items: [] });
  const getEntity = vi
    .fn()
    .mockResolvedValue({ entityId: 0, type: "switch", value: false, items: [] });
  const registerEntityInterest = vi
    .fn()
    .mockResolvedValue({ entityId: 0, type: "switch", value: false, items: [] });
  const setControlChannel = vi.fn().mockResolvedValue(undefined);
  const setLoggingChannel = vi.fn().mockResolvedValue(undefined);
  const setRoleCapabilities = vi.fn().mockResolvedValue(undefined);
  const beginPairing = vi.fn().mockResolvedValue(undefined);
  const cancelPairing = vi.fn().mockResolvedValue(undefined);
  const getServerInfo = vi
    .fn()
    .mockResolvedValue({ players: 12, maxPlayers: 100, queuedPlayers: 3 });
  const getTeam = vi.fn().mockResolvedValue({ leaderSteamId: "0", members: [] });
  const getServerTime = vi.fn().mockResolvedValue({
    dayLengthMinutes: 60,
    timeScale: 1,
    sunrise: 7,
    sunset: 19,
    time: 12.5,
    isDay: true,
  });
  const sendTeamMessage = vi.fn().mockResolvedValue(undefined);
  const setEntityLabel = vi.fn().mockResolvedValue(undefined);
  const setPushoverCredentials = vi.fn().mockResolvedValue(undefined);
  const clearPushoverCredentials = vi.fn().mockResolvedValue(undefined);
  const setAlarmPushoverSeverity = vi.fn().mockResolvedValue(undefined);
  const setAlarmNotificationLevel = vi.fn().mockResolvedValue(undefined);
  const setSwitchAutoAction = vi.fn().mockResolvedValue(undefined);
  const setSwitchAutoDelaySeconds = vi.fn().mockResolvedValue(undefined);
  const removeEntity = vi.fn().mockResolvedValue(undefined);
  const getCameraFrame = vi.fn().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const addCamera = vi.fn().mockResolvedValue({
    serverId: "srv",
    entityId: -1,
    entityType: "camera",
    identifier: "cam",
  });

  const core = {
    stateLockTimeoutMs: 10_000,
    getConfig: () => state.config,
    listServers: () => state.servers,
    listEntities: (serverId: string) => state.entities.filter((e) => e.serverId === serverId),
    listSwitchGroups: (serverId: string) =>
      state.servers.find((s) => s.id === serverId)?.switchGroups ?? [],
    isServerConnected: (serverId: string) => (state.connectedServerIds ?? []).includes(serverId),
    getServerStatus: (serverId: string) => ({
      status: (state.connectedServerIds ?? []).includes(serverId) ? "connected" : "offline",
    }),
    isPushoverConfigured: () =>
      Boolean(state.config.pushover?.appToken && state.config.pushover?.userKey),
    toggleEntity,
    getEntity,
    registerEntityInterest,
    setControlChannel,
    setLoggingChannel,
    setRoleCapabilities,
    beginPairing,
    cancelPairing,
    getServerInfo,
    getServerTime,
    getTeam,
    sendTeamMessage,
    setEntityLabel,
    setPushoverCredentials,
    clearPushoverCredentials,
    setAlarmPushoverSeverity,
    setAlarmNotificationLevel,
    setSwitchAutoAction,
    setSwitchAutoDelaySeconds,
    removeEntity,
    getCameraFrame,
    addCamera,
    setStartOnLogin: vi.fn().mockResolvedValue(undefined),
    // bot-core is an EventEmitter: the adapter subscribes on start() and
    // unsubscribes on stop().
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    core,
    toggleEntity,
    removeEntity,
    setControlChannel,
    setLoggingChannel,
    setRoleCapabilities,
    registerEntityInterest,
    sendTeamMessage,
    setEntityLabel,
    setPushoverCredentials,
    clearPushoverCredentials,
    setAlarmPushoverSeverity,
    setAlarmNotificationLevel,
    setSwitchAutoAction,
    setSwitchAutoDelaySeconds,
    getCameraFrame,
    addCamera,
    getServerInfo,
    getServerTime,
    getTeam,
    beginPairing,
    cancelPairing,
  };
}

function makeInteraction(
  customId: string,
  memberRoleIds: string[],
  opts: {
    values?: string[];
    kind?: "button" | "channel" | "role" | "stringSelect";
    admin?: boolean;
    userId?: string;
    userName?: string;
  } = {},
): DispatchableInteraction & {
  replied: { content: string }[];
  deferred: boolean;
  modals: { customId: string; title: string; raw: unknown }[];
  updates: unknown[];
  editReplies: unknown[];
  ephemeralPanels: unknown[];
  ephemeralDeletes: number;
} {
  const replied: { content: string }[] = [];
  const modals: { customId: string; title: string; raw: unknown }[] = [];
  const updates: unknown[] = [];
  const editReplies: unknown[] = [];
  const ephemeralPanels: unknown[] = [];
  let ephemeralDeletes = 0;
  const kind = opts.kind ?? "button";
  let deferred = false;
  return {
    customId,
    memberRoleIds,
    userId: opts.userId,
    userName: opts.userName,
    isAdministrator: opts.admin ?? false,
    values: opts.values,
    isButton: () => kind === "button",
    isChannelSelectMenu: () => kind === "channel",
    isRoleSelectMenu: () => kind === "role",
    isStringSelectMenu: () => kind === "stringSelect",
    replyEphemeral: async (content: string) => {
      replied.push({ content });
    },
    replyEphemeralPanel: async (payload: unknown) => {
      ephemeralPanels.push(payload);
      return {
        editPanel: async () => {},
        delete: async () => {
          ephemeralDeletes += 1;
        },
      };
    },
    showModal: async (modal: unknown) => {
      const json = (modal as { toJSON(): { custom_id: string; title: string } }).toJSON();
      modals.push({ customId: json.custom_id, title: json.title, raw: modal });
    },
    deferUpdate: async () => {
      deferred = true;
    },
    update: async (payload: unknown) => {
      updates.push(payload);
    },
    editReply: async (payload: unknown) => {
      editReplies.push(payload);
    },
    get replied() {
      return replied;
    },
    get deferred() {
      return deferred;
    },
    get modals() {
      return modals;
    },
    get updates() {
      return updates;
    },
    get editReplies() {
      return editReplies;
    },
    get ephemeralPanels() {
      return ephemeralPanels;
    },
    get ephemeralDeletes() {
      return ephemeralDeletes;
    },
  } as never;
}

/** A minimal chat-input slash-command interaction (`/conduit <sub>`). */
function makeSlashCommand(
  sub: string,
  opts: { admin?: boolean; roleIds?: string[]; owner?: boolean } = {},
) {
  const replied: {
    content?: string;
    components?: unknown[];
    flags?: number;
  }[] = [];
  // When `owner` is set we model the literal guild owner: ownerId === user.id,
  // but WITHOUT the Administrator permission bit, to prove the owner bypass works
  // on the ownerId check alone.
  const userId = "owner-user";
  const interaction = {
    isChatInputCommand: () => true,
    isButton: () => false,
    isChannelSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isModalSubmit: () => false,
    commandName: "conduit",
    options: { getSubcommand: () => sub },
    member: opts.roleIds ? { roles: opts.roleIds } : undefined,
    user: { id: userId },
    guild: opts.owner ? { ownerId: userId } : { ownerId: "someone-else" },
    memberPermissions: { has: () => opts.admin ?? false },
    reply: async (o: { content?: string; components?: unknown[]; flags?: number }) => {
      replied.push(o);
      return undefined;
    },
  };
  return { interaction, replied };
}

/**
 * A minimal modal-submit interaction (the dispatcher routes these separately).
 * `replied` collects every message shown to the member, in order, however it
 * was delivered: a direct reply, the edit that fills in a deferred reply, or a
 * follow-up. `deferred` records that the modal was acknowledged up front.
 */
function makeModalSubmit(
  customId: string,
  memberRoleIds: string[],
  fields: Record<string, string>,
  opts: { admin?: boolean } = {},
): {
  customId: string;
  member: { roles: string[] };
  memberPermissions: { has(p: bigint): boolean };
  fields: { getTextInputValue(id: string): string };
  deferred: boolean;
  reply(opts: { content: string; flags?: number }): Promise<unknown>;
  deferReply(opts: { flags?: number }): Promise<unknown>;
  editReply(opts: { content: string }): Promise<unknown>;
  followUp(opts: { content: string; flags?: number }): Promise<unknown>;
  replied: { content: string }[];
} {
  const replied: { content: string }[] = [];
  const show = async (opts: { content: string }) => {
    replied.push({ content: opts.content });
    return undefined;
  };
  const interaction = {
    customId,
    member: { roles: memberRoleIds },
    memberPermissions: { has: () => opts.admin ?? false },
    fields: {
      getTextInputValue: (id: string) => fields[id] ?? "",
    },
    deferred: false,
    reply: show,
    deferReply: async () => {
      interaction.deferred = true;
      return undefined;
    },
    editReply: show,
    followUp: show,
    get replied() {
      return replied;
    },
  };
  return interaction;
}

function baseConfig(roleCapabilities: RoleCapabilityMap): AppConfig {
  return { startOnLogin: false, controlChannelId: "chan-1", roleCapabilities };
}

describe("formatGameTime", () => {
  const gt = (time: number) => ({
    dayLengthMinutes: 60,
    timeScale: 1,
    sunrise: 7,
    sunset: 19,
    time,
    isDay: true,
  });

  it("formats an hour-of-day float as 24-hour HH:MM", () => {
    expect(formatGameTime(gt(0))).toBe("00:00");
    expect(formatGameTime(gt(12.5))).toBe("12:30");
    expect(formatGameTime(gt(9.25))).toBe("09:15");
    expect(formatGameTime(gt(23.99))).toBe("23:59");
  });

  it("rolls 59.5 minutes up to the next hour and normalizes out-of-range values", () => {
    expect(formatGameTime(gt(8.999))).toBe("09:00"); // 53.94m rounds to 60 → roll
    expect(formatGameTime(gt(23.999))).toBe("00:00"); // rolls past midnight
    expect(formatGameTime(gt(24))).toBe("00:00"); // 24 wraps to 0
    expect(formatGameTime(gt(-1))).toBe("23:00"); // negative normalizes
  });
});

describe("DiscordAdapter dispatch", () => {
  it("denies a non-admin clicking an admin action ephemerally; bot-core NOT called", async () => {
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const interaction = makeInteraction(
      buildCustomId({ domain: "setup", action: "addDevice" }),
      ["USER"], // user role, but addDevice is admin-only
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(false);
    expect(fake.toggleEntity).not.toHaveBeenCalled();
    expect(interaction.replied[0].content).toMatch(/admin role/i);
  });

  it("permits a Discord Administrator (server owner) a setup action with NO Conduit roles mapped", async () => {
    // Fresh install: role map empty, so isAllowed() denies everyone. The owner
    // (Administrator) must still be able to drive the Setup hub to map the first
    // roles — otherwise setup is unreachable.
    const fake = makeFakeCore({
      config: baseConfig({ admin: [], user: [] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const interaction = makeInteraction(
      buildCustomId({ domain: "setup", action: "channel" }),
      [], // no roles at all
      { kind: "channel", values: ["new-channel-id"], admin: true },
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(true);
    expect(fake.setControlChannel).toHaveBeenCalledWith("new-channel-id");
  });

  it("does NOT extend the admin bypass to device-control panels (owner still role-gated)", async () => {
    // The bypass is scoped to the setup flow by design. An Administrator with no
    // mapped Conduit role still cannot actuate a switch.
    const serverId = "server-1";
    const entityId = 7;
    const fake = makeFakeCore({
      config: baseConfig({ admin: [], user: [] }),
      servers: [
        {
          id: serverId,
          name: "S",
          desc: "",
          ip: "1.1.1.1",
          port: 1,
          playerId: "0",
          playerToken: "0",
          addedAt: "",
        },
      ],
      entities: [{ serverId, entityId, entityType: "switch", panelMessageId: "msg-1" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "off", server: sH, entity: eH }),
      [],
      { admin: true },
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(false);
    expect(fake.toggleEntity).not.toHaveBeenCalled();
  });

  it("permits a user toggling a switch → bot-core.toggleEntity called", async () => {
    const serverId = "server-1";
    const entityId = 42;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [
        {
          id: serverId,
          name: "S",
          desc: "",
          ip: "1.1.1.1",
          port: 1,
          playerId: "0",
          playerToken: "0",
          addedAt: "",
        },
      ],
      entities: [{ serverId, entityId, entityType: "switch", panelMessageId: "msg-1" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });

    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));

    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "off", server: sH, entity: eH }),
      ["USER"],
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(true);
    expect(fake.toggleEntity).toHaveBeenCalledWith(serverId, entityId, false);
    expect(adapter.stateLockMachine.snapshot({ serverId, entityId })?.phase).toBe("pending");
  });

  it("ignores foreign customIds (handled:false)", async () => {
    const fake = makeFakeCore({
      config: baseConfig({ admin: [], user: [] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const interaction = makeInteraction("not-ours", ["X"]);
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.handled).toBe(false);
  });
});

/**
 * A discord.js-shaped button interaction (vs. the dispatcher-level
 * {@link makeInteraction}), used to exercise `onInteraction`'s real
 * reply/defer/followUp bridge. `reply`/`deferUpdate` throw once already
 * acknowledged, mirroring discord.js's InteractionAlreadyReplied.
 */
function makeButtonInteraction(customId: string, roleIds: string[]) {
  const calls = {
    reply: [] as { content?: string }[],
    followUp: [] as { content?: string }[],
    deferUpdate: 0,
    update: [] as unknown[],
  };
  const i = {
    customId,
    replied: false,
    deferred: false,
    user: { id: "u1", username: "rich" },
    member: { roles: roleIds },
    guild: { ownerId: "owner" },
    memberPermissions: { has: () => false },
    values: undefined as string[] | undefined,
    isChatInputCommand: () => false,
    isButton: () => true,
    isChannelSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    reply: async (o: { content?: string }) => {
      if (i.replied || i.deferred) throw new Error("InteractionAlreadyReplied");
      i.replied = true;
      calls.reply.push(o);
    },
    followUp: async (o: { content?: string }) => {
      calls.followUp.push(o);
      return {};
    },
    deferUpdate: async () => {
      if (i.replied || i.deferred) throw new Error("InteractionAlreadyReplied");
      i.deferred = true;
      calls.deferUpdate += 1;
    },
    update: async (o: unknown) => {
      i.replied = true;
      calls.update.push(o);
    },
  };
  return { i, calls };
}

describe("DiscordAdapter interaction acknowledgement safety", () => {
  it("friendlyError maps EntityNotFoundError to the device-gone copy", () => {
    expect(friendlyError(Object.assign(new Error("gone"), { name: "EntityNotFoundError" }))).toBe(
      ENTITY_NOT_FOUND_MESSAGE,
    );
  });

  it("a switch toggle whose actuation fails replies via followUp (no double reply)", async () => {
    const serverId = "server-1";
    const entityId = 9;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch", panelMessageId: "msg-1" }],
    });
    fake.toggleEntity.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { name: "EntityNotFoundError" }),
    );
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const { i, calls } = makeButtonInteraction(
      buildCustomId({ domain: "switch", action: "on", server: sH, entity: eH }),
      ["USER"],
    );

    // Must not reject (no unhandled rejection) even though toggleEntity throws
    // after the deferUpdate.
    await adapter.onInteraction(i as never);

    expect(calls.deferUpdate).toBe(1);
    expect(calls.followUp).toHaveLength(1);
    expect(calls.followUp[0]?.content).toBe(ENTITY_NOT_FOUND_MESSAGE);
    // reply() after the defer would have thrown InteractionAlreadyReplied.
    expect(calls.reply).toHaveLength(0);
  });
});

describe("DiscordAdapter remove device", () => {
  function removableSwitch() {
    const serverId = "server-1";
    const entityId = 7;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [
        { serverId, entityId, entityType: "switch", label: "Red Light", panelMessageId: "msg-1" },
      ],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    return { serverId, entityId, fake, adapter, sH, eH };
  }

  it("switch:remove shows a confirm panel without removing", async () => {
    const { fake, adapter, sH, eH } = removableSwitch();
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "remove", server: sH, entity: eH }),
      ["ADMIN"],
      { admin: true },
    );
    await adapter.dispatch(interaction);
    expect(fake.removeEntity).not.toHaveBeenCalled();
    expect(interaction.updates).toHaveLength(1);
  });

  it("switch:remove-confirm forgets the entity and shows the removed notice", async () => {
    const { serverId, entityId, fake, adapter, sH, eH } = removableSwitch();
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "remove-confirm", server: sH, entity: eH }),
      ["ADMIN"],
      { admin: true },
    );
    await adapter.dispatch(interaction);
    expect(fake.removeEntity).toHaveBeenCalledWith(serverId, entityId);
    expect(interaction.updates).toHaveLength(1);
  });

  it("alarm:remove-confirm forgets the entity", async () => {
    const serverId = "server-1";
    const entityId = 12;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [
        { serverId, entityId, entityType: "alarm", label: "Base Alarm", panelMessageId: "msg-2" },
      ],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "alarm", action: "remove-confirm", server: sH, entity: eH }),
      ["ADMIN"],
      { admin: true },
    );
    await adapter.dispatch(interaction);
    expect(fake.removeEntity).toHaveBeenCalledWith(serverId, entityId);
  });
});

describe("DiscordAdapter setup hub", () => {
  it("Channel Select → setControlChannel with the chosen id", async () => {
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: [] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const interaction = makeInteraction(
      buildCustomId({ domain: "setup", action: "channel" }),
      ["ADMIN"],
      { kind: "channel", values: ["new-channel-id"] },
    );
    await adapter.dispatch(interaction);
    expect(fake.setControlChannel).toHaveBeenCalledWith("new-channel-id");
  });

  it("Channel Select reconstructs panels so a server paired before the channel existed posts immediately", async () => {
    // First-run ordering gap: the server pairs (the panel was never posted because
    // there was no control channel) and the channel is chosen afterwards. Selecting
    // it must self-heal by posting the status panel, not wait for a restart.
    const state: FakeCoreState = {
      config: baseConfig({ admin: ["ADMIN"], user: [] }),
      servers: [serverFixture("srv-1")], // no statusPanelMessageId yet
      entities: [],
    };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const { client, sent } = adapterWithChannel(state);
    // @ts-expect-error inject the private client field
    adapter.client = client;
    const interaction = makeInteraction(
      buildCustomId({ domain: "setup", action: "channel" }),
      ["ADMIN"],
      { kind: "channel", values: ["new-channel-id"] },
    );
    await adapter.dispatch(interaction);
    expect(fake.setControlChannel).toHaveBeenCalledWith("new-channel-id");
    // The (single) status panel was posted as a result of choosing the channel.
    expect(sent).toHaveLength(1);
  });

  it("Role Select (admin) → setRoleCapabilities", async () => {
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["U"] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const interaction = makeInteraction(
      buildCustomId({ domain: "setup", action: "adminRoles" }),
      ["ADMIN"],
      { kind: "role", values: ["R1", "R2"] },
    );
    await adapter.dispatch(interaction);
    expect(fake.setRoleCapabilities).toHaveBeenCalledWith({
      admin: ["R1", "R2"],
      user: ["U"],
    });
  });

  it("/conduit setup with NO control channel renders the hub inline (ephemeral)", async () => {
    // First-run bootstrap: an admin runs /conduit setup before any control
    // channel exists. The hub must come back as the (ephemeral) reply itself —
    // there's nowhere to post it yet, and the channel-select lives in the hub.
    const fake = makeFakeCore({
      config: { startOnLogin: false, roleCapabilities: { admin: [], user: [] } },
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const { interaction, replied } = makeSlashCommand("setup", { admin: true });

    await adapter.onInteraction(interaction as never);

    expect(replied).toHaveLength(1);
    const reply = replied[0]!;
    expect(reply.content).toBeUndefined();
    expect(reply.components?.length).toBeGreaterThan(0);
    expect(reply.flags! & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
    expect(reply.flags! & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
  });

  it("/conduit setup permitted for the guild OWNER even WITHOUT the Administrator permission bit", async () => {
    // Proves the owner bypass does not rely on memberPermissions.has(Administrator):
    // ownerId === user.id is enough. admin:false → the permission bitfield says no.
    const fake = makeFakeCore({
      config: { startOnLogin: false, roleCapabilities: { admin: [], user: [] } },
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const { interaction, replied } = makeSlashCommand("setup", {
      admin: false,
      owner: true,
    });

    await adapter.onInteraction(interaction as never);

    expect(replied).toHaveLength(1);
    // The hub renders (components present) rather than the denial message — the
    // first-run inline hub reply carries components and no text content.
    expect(replied[0]!.content ?? "").not.toMatch(/admin role/i);
    expect(replied[0]!.components?.length).toBeGreaterThan(0);
  });

  it("/conduit setup DENIED for a non-owner, non-admin, with no roles", async () => {
    const fake = makeFakeCore({
      config: { startOnLogin: false, roleCapabilities: { admin: [], user: [] } },
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const { interaction, replied } = makeSlashCommand("setup", {
      admin: false,
      owner: false,
    });

    await adapter.onInteraction(interaction as never);

    expect(replied).toHaveLength(1);
    expect(replied[0]!.content).toMatch(/admin role/i);
  });

  it("/conduit setup WITH a control channel renders the hub ephemerally (no persistent post)", async () => {
    // The Setup hub is always ephemeral now — even with a control channel set, it
    // comes back as the (ephemeral) reply itself rather than a persistent message
    // posted to the channel.
    const fake = makeFakeCore({
      config: baseConfig({ admin: [], user: [] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const { interaction, replied } = makeSlashCommand("setup", { admin: true });

    await adapter.onInteraction(interaction as never);

    expect(replied).toHaveLength(1);
    const reply = replied[0]!;
    expect(reply.content).toBeUndefined();
    expect(reply.components?.length).toBeGreaterThan(0);
    expect(reply.flags! & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
    expect(reply.flags! & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
  });
});

describe("DiscordAdapter panel reconstruction", () => {
  function adapterWithFakeChannel(state: FakeCoreState, existingMessageIds: Set<string>) {
    const channelSend = vi.fn().mockResolvedValue({ id: "new-msg" });
    const edits = new Map<string, unknown[]>();
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });

    const channel = {
      send: channelSend,
      messages: {
        fetch: vi.fn(async (id: string) => {
          if (!existingMessageIds.has(id))
            throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return {
            edit: vi.fn(async (payload: unknown) => {
              edits.set(id, [...(edits.get(id) ?? []), payload]);
            }),
          };
        }),
      },
    };
    const client = {
      channels: {
        cache: { get: () => channel },
        fetch: async () => channel,
      },
    };
    // @ts-expect-error inject the private client field for the test seam
    adapter.client = client;
    return { adapter, fake, edits, channelSend };
  }

  function panelState(ids: PairedServer["panelMessageIds"]): FakeCoreState {
    return {
      config: {
        startOnLogin: false,
        controlChannelId: "chan",
        roleCapabilities: { admin: [], user: [] },
      },
      servers: [serverFixture("srv", { name: "Srv", panelMessageIds: ids })],
      entities: [
        { serverId: "srv", entityId: 1, entityType: "switch" },
        { serverId: "srv", entityId: 2, entityType: "switch" },
      ],
    };
  }

  it("edits the stored panel in place when every message exists", async () => {
    const state = panelState({ server: "server-msg", switches: ["switches-msg"] });
    const { adapter, fake, channelSend, edits } = adapterWithFakeChannel(
      state,
      new Set(["server-msg", "switches-msg"]),
    );

    const report = await adapter.reconstructPanels();

    expect(report.edited).toEqual(["server-msg", "switches-msg"]);
    expect(report.missing).toEqual([]);
    expect(channelSend).not.toHaveBeenCalled();
    expect([...edits.keys()]).toEqual(["server-msg", "switches-msg"]);
    // Interest in every device, so their broadcasts (and lock closure) resume.
    expect(fake.registerEntityInterest).toHaveBeenCalledWith("srv", 1);
    expect(fake.registerEntityInterest).toHaveBeenCalledWith("srv", 2);
  });

  it("reposts the whole group when one of its messages is gone", async () => {
    const state = panelState({ server: "server-msg", switches: ["switches-msg"] });
    const { adapter, channelSend } = adapterWithFakeChannel(state, new Set(["server-msg"]));

    const report = await adapter.reconstructPanels();

    // Server, then Switches: Discord can't insert a message above another.
    expect(channelSend).toHaveBeenCalledTimes(2);
    expect(report.edited).toEqual(["new-msg", "new-msg"]);
    expect(report.missing).toEqual([]);
  });

  it("renders the live connection state on reconcile (not a hardcoded offline)", async () => {
    const serverId = "srv";
    function stateWith(connected: boolean): FakeCoreState {
      return {
        config: {
          startOnLogin: false,
          controlChannelId: "chan",
          roleCapabilities: { admin: [], user: [] },
        },
        servers: [
          {
            id: serverId,
            name: "Srv",
            desc: "",
            ip: "1.1.1.1",
            port: 1,
            playerId: "0",
            playerToken: "0",
            addedAt: "",
            panelMessageIds: { server: "status-msg" },
          },
        ],
        entities: [],
        connectedServerIds: connected ? [serverId] : [],
      };
    }
    const present = new Set(["status-msg"]);

    // Connected: the Server message must read online and show the live players
    // and queue, never the offline state nor a stuck "fetching status…".
    const live = adapterWithFakeChannel(stateWith(true), present);
    await live.adapter.reconstructPanels();
    const liveJson = JSON.stringify(live.edits.get("status-msg"));
    expect(liveJson).toContain("12/100 players · queue 3");
    expect(liveJson).not.toContain("fetching status");
    expect(liveJson).not.toContain("Offline");
    // No game clock: only a manual Refresh shows it, to spend fewer edits.
    expect(liveJson).toContain("### Srv\\n🟢 Online");
    expect(liveJson).not.toContain("🕑");

    // Disconnected: still surfaces the unreachable state.
    const down = adapterWithFakeChannel(stateWith(false), present);
    await down.adapter.reconstructPanels();
    expect(JSON.stringify(down.edits.get("status-msg"))).toContain("🔴 Offline");
  });

  it("deletes an old status panel and posts the Server message (self-heal)", async () => {
    const serverId = "srv";
    const state: FakeCoreState = {
      config: {
        startOnLogin: false,
        controlChannelId: "chan",
        roleCapabilities: { admin: [], user: [] },
      },
      servers: [
        {
          id: serverId,
          name: "Srv",
          desc: "",
          ip: "1.1.1.1",
          port: 1,
          playerId: "0",
          playerToken: "0",
          addedAt: "",
          // A stored status id whose message is gone.
          statusPanelMessageId: "status-gone",
        },
      ],
      entities: [],
    };
    // Nothing exists in the channel: the old status panel is already gone, and
    // the server's panel (only its Server message: it has no devices) is posted.
    const { adapter, channelSend } = adapterWithFakeChannel(state, new Set());

    const report = await adapter.reconstructPanels();

    expect(channelSend).toHaveBeenCalledTimes(1); // the Server message; no separate team panel
    expect(report.edited).toEqual(["new-msg"]);
    expect(report.missing).toEqual([]);
  });

  it("migrates away from the old status and team panels: deletes them and clears their ids", async () => {
    const serverId = "srv";
    const state: FakeCoreState = {
      config: {
        startOnLogin: false,
        controlChannelId: "chan",
        roleCapabilities: { admin: [], user: [] },
      },
      servers: [
        {
          id: serverId,
          name: "Srv",
          desc: "",
          ip: "1.1.1.1",
          port: 1,
          playerId: "0",
          playerToken: "0",
          addedAt: "",
          statusPanelMessageId: "status-msg",
          // Legacy standalone team panel from before the merge.
          teamPanelMessageId: "team-msg",
        },
      ],
      entities: [],
    };
    const deleted: string[] = [];
    const clearLegacyPanelIds = vi.fn().mockResolvedValue(undefined);
    const setServerPanelIds = vi.fn().mockResolvedValue(undefined);
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "t",
      panelStore: {
        setServerPanelIds,
        clearLegacyPanelIds,
        setEntityWatch: vi.fn().mockResolvedValue(undefined),
      },
    });
    const present = new Set(["status-msg", "team-msg"]);
    const channel = {
      send: vi.fn().mockResolvedValue({ id: "new-msg" }),
      messages: {
        fetch: vi.fn(async (id: string) => {
          if (!present.has(id)) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return {
            edit: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn(async () => {
              deleted.push(id);
            }),
          };
        }),
      },
    };
    // @ts-expect-error inject the private client field for the test seam
    adapter.client = { channels: { cache: { get: () => channel }, fetch: async () => channel } };

    await adapter.reconstructPanels();

    expect(deleted).toEqual(["status-msg", "team-msg"]);
    expect(clearLegacyPanelIds).toHaveBeenCalledWith(serverId, {
      status: true,
      team: true,
      entityIds: [],
    });
    // Then the new panel is posted: the team now lives in the Server message.
    expect(setServerPanelIds).toHaveBeenCalledWith(serverId, { server: "new-msg" });
  });

  it("renders the team roster subsection with online/lead/connected indicators", async () => {
    const serverId = "srv";
    const state: FakeCoreState = {
      config: {
        startOnLogin: false,
        controlChannelId: "chan",
        roleCapabilities: { admin: [], user: [] },
      },
      servers: [
        {
          id: serverId,
          name: "Srv",
          desc: "",
          ip: "1.1.1.1",
          port: 1,
          // Rust+ is connected through Bob (steamId 200).
          playerId: "200",
          playerToken: "0",
          addedAt: "",
          panelMessageIds: { server: "status-msg" },
        },
      ],
      entities: [],
      connectedServerIds: [serverId],
    };
    const present = new Set(["status-msg"]);
    const { adapter, fake, edits } = adapterWithFakeChannel(state, present);
    fake.getTeam.mockResolvedValue({
      leaderSteamId: "100",
      members: [
        { steamId: "100", name: "Alice", isOnline: true }, // lead
        { steamId: "200", name: "Bob", isOnline: true }, // connected (Rust+)
        { steamId: "300", name: "Carol", isOnline: false }, // offline
      ],
    });

    await adapter.reconstructPanels();

    const json = JSON.stringify(edits.get("status-msg"));
    // 👑 the team lead (Alice), 📶 the Rust+-connected account (Bob); an online
    // dot for the two online members, a hollow dot for the offline one.
    expect(json).toContain("-# Team: 🟢 Alice 👑 · 🟢 Bob 📶 · ⚪ Carol");
  });

  it("omits the team subsection when offline (no roster fetched)", async () => {
    const serverId = "srv";
    const state: FakeCoreState = {
      config: {
        startOnLogin: false,
        controlChannelId: "chan",
        roleCapabilities: { admin: [], user: [] },
      },
      servers: [
        {
          id: serverId,
          name: "Srv",
          desc: "",
          ip: "1.1.1.1",
          port: 1,
          playerId: "0",
          playerToken: "0",
          addedAt: "",
          panelMessageIds: { server: "status-msg" },
        },
      ],
      entities: [],
      connectedServerIds: [], // offline
    };
    const { adapter, fake, edits } = adapterWithFakeChannel(state, new Set(["status-msg"]));

    await adapter.reconstructPanels();

    expect(fake.getTeam).not.toHaveBeenCalled();
    expect(JSON.stringify(edits.get("status-msg"))).not.toContain("Team:");
  });
});

describe("DiscordAdapter.deleteAllPanels", () => {
  /** Adapter wired to a fake channel that records which message ids get deleted. */
  function adapterWithDeletableChannel(state: FakeCoreState, existingMessageIds: Set<string>) {
    const deleted: string[] = [];
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const channel = {
      send: vi.fn(),
      messages: {
        fetch: vi.fn(async (id: string) => {
          if (!existingMessageIds.has(id))
            throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return {
            edit: vi.fn(),
            delete: vi.fn(async () => {
              deleted.push(id);
            }),
          };
        }),
      },
    };
    const client = {
      channels: { cache: { get: () => channel }, fetch: async () => channel },
    };
    // @ts-expect-error inject the private client field for the test seam
    adapter.client = client;
    return { adapter, deleted };
  }

  const baseCfg: AppConfig = {
    startOnLogin: false,
    controlChannelId: "chan",
    roleCapabilities: { admin: [], user: [] },
  };

  function serverWithPanels(id: string): PairedServer {
    return {
      id,
      name: "Srv",
      desc: "",
      ip: "1.1.1.1",
      port: 1,
      playerId: "0",
      playerToken: "0",
      addedAt: "",
      panelMessageIds: { server: `${id}-server`, switches: [`${id}-sw-1`, `${id}-sw-2`] },
      // Old panels a migration has not deleted yet.
      statusPanelMessageId: `${id}-status`,
      teamPanelMessageId: `${id}-team`,
    };
  }

  it("deletes every tracked panel message, old ones included, and returns the count", async () => {
    const state: FakeCoreState = {
      config: baseCfg,
      servers: [serverWithPanels("srv")],
      entities: [
        { serverId: "srv", entityId: 1, entityType: "switch", panelMessageId: "ent-1" },
        // No panelMessageId → nothing to delete for this one.
        { serverId: "srv", entityId: 2, entityType: "alarm" },
      ],
    };
    const present = new Set([
      "srv-server",
      "srv-sw-1",
      "srv-sw-2",
      "srv-status",
      "srv-team",
      "ent-1",
    ]);
    const { adapter, deleted } = adapterWithDeletableChannel(state, present);

    const count = await adapter.deleteAllPanels();

    expect(count).toBe(6);
    expect(deleted.sort()).toEqual([...present].sort());
  });

  it("counts an already-gone message as a no-op (best-effort)", async () => {
    const state: FakeCoreState = {
      config: baseCfg,
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
          statusPanelMessageId: "present",
          teamPanelMessageId: "gone",
        },
      ],
      entities: [],
    };
    const { adapter, deleted } = adapterWithDeletableChannel(state, new Set(["present"]));

    const count = await adapter.deleteAllPanels();

    expect(count).toBe(1);
    expect(deleted).toEqual(["present"]);
  });

  it("returns 0 when no control channel is configured", async () => {
    const state: FakeCoreState = {
      config: { ...baseCfg, controlChannelId: undefined },
      servers: [serverWithPanels("srv")],
      entities: [],
    };
    const { adapter, deleted } = adapterWithDeletableChannel(state, new Set());

    expect(await adapter.deleteAllPanels()).toBe(0);
    expect(deleted).toEqual([]);
  });
});

describe("DiscordAdapter lifecycle", () => {
  let loginFn: ReturnType<typeof vi.fn>;
  let destroyFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loginFn = vi.fn().mockResolvedValue("token");
    destroyFn = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("start() logs in via the injected client factory; stop() destroys it", async () => {
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const fakeClient = {
      once: (e: string, cb: (...a: unknown[]) => void) => handlers.set(`once:${e}`, cb),
      on: (e: string, cb: (...a: unknown[]) => void) => handlers.set(`on:${e}`, cb),
      login: loginFn,
      destroy: destroyFn,
    };
    const fake = makeFakeCore({
      config: baseConfig({ admin: [], user: [] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "the-token",
      clientFactory: () => fakeClient as never,
    });
    // start() awaits the gateway ClientReady event before resolving. The once()
    // handler is registered synchronously (before the awaited login), so fire it
    // to let start() complete — otherwise the await would hang.
    const startP = adapter.start();
    const onReady = [...handlers].find(([k]) => k.startsWith("once:"))?.[1];
    onReady?.();
    await startP;
    expect(loginFn).toHaveBeenCalledWith("the-token");
    await adapter.stop();
    expect(destroyFn).toHaveBeenCalledOnce();
  });

  it("start() gates on ClientReady: stays pending until the event fires, then runs onReady", async () => {
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const fakeClient = {
      once: (e: string, cb: (...a: unknown[]) => void) => handlers.set(`once:${e}`, cb),
      on: (e: string, cb: (...a: unknown[]) => void) => handlers.set(`on:${e}`, cb),
      login: loginFn,
      destroy: destroyFn,
    };
    const fake = makeFakeCore({
      config: baseConfig({ admin: [], user: [] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "the-token",
      clientFactory: () => fakeClient as never,
    });
    const onReadySpy = vi.spyOn(adapter, "onReady");

    let resolved = false;
    const startP = adapter.start().then(() => {
      resolved = true;
    });
    // login() has resolved but ClientReady has not fired: start() must still be pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(onReadySpy).not.toHaveBeenCalled();

    // Fire ClientReady → onReady runs and start() resolves.
    [...handlers].find(([k]) => k.startsWith("once:"))?.[1]?.();
    await startP;
    expect(resolved).toBe(true);
    expect(onReadySpy).toHaveBeenCalledOnce();
  });

  it("start() proceeds via the readyTimeout fallback when ClientReady never fires", async () => {
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const fakeClient = {
      once: (e: string, cb: (...a: unknown[]) => void) => handlers.set(`once:${e}`, cb),
      on: (e: string, cb: (...a: unknown[]) => void) => handlers.set(`on:${e}`, cb),
      login: loginFn,
      destroy: destroyFn,
    };
    const fake = makeFakeCore({
      config: baseConfig({ admin: [], user: [] }),
      servers: [],
      entities: [],
    });
    // Controllable timer seam: capture the fallback callback instead of waiting.
    let fired: (() => void) | undefined;
    const timers: TimerProvider = {
      setTimer: (cb) => {
        fired = cb as () => void;
        return 1;
      },
      clearTimer: vi.fn(),
    };
    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "the-token",
      clientFactory: () => fakeClient as never,
      timers,
      readyTimeoutMs: 1234,
    });

    let resolved = false;
    const startP = adapter.start().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    // ClientReady never fires; without the fallback start() would hang.
    expect(resolved).toBe(false);
    fired?.();
    await startP;
    expect(resolved).toBe(true);
  });

  it("periodic refresh re-fetches connected status panels every interval and stops on stop()", async () => {
    // Controllable timer seam: record every scheduled timer (with its ms) and
    // every clear, so we can drive ticks by hand and assert the loop reschedules.
    const scheduled: { id: number; cb: () => void; ms: number }[] = [];
    const cleared: unknown[] = [];
    const timers: TimerProvider = {
      setTimer: (cb, ms) => {
        const id = scheduled.length + 1;
        scheduled.push({ id, cb: cb as () => void, ms });
        return id;
      },
      clearTimer: (h) => {
        cleared.push(h);
      },
    };
    const interval = 60_000;
    const refreshTimers = () => scheduled.filter((s) => s.ms === interval);
    const flush = async () => {
      // Drain enough microtasks to cover the busy pre-edit + getInfo + final edit
      // chain and the loop's reschedule that runs in its .finally.
      for (let i = 0; i < 40; i++) await Promise.resolve();
    };

    // A fake client that is both lifecycle-capable (once/on/login/destroy) and
    // channel-capable (so editMessage can resolve + edit the status message).
    const edited: string[] = [];
    const existing = new Set(["srv-1-status"]);
    const channel = {
      send: vi.fn(async () => ({ id: "new" })),
      messages: {
        fetch: vi.fn(async (id: string) => {
          if (!existing.has(id)) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return {
            edit: vi.fn(async () => {
              edited.push(id);
            }),
            delete: vi.fn(async () => undefined),
          };
        }),
      },
    };
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const fakeClient = {
      once: (e: string, cb: (...a: unknown[]) => void) => handlers.set(`once:${e}`, cb),
      on: (e: string, cb: (...a: unknown[]) => void) => handlers.set(`on:${e}`, cb),
      login: loginFn,
      destroy: destroyFn,
      channels: { cache: { get: () => channel }, fetch: async () => channel },
    };

    const fake = makeFakeCore({
      config: baseConfig({ admin: [], user: [] }),
      servers: [serverFixture("srv-1", { panelMessageIds: { server: "srv-1-status" } })],
      entities: [],
      connectedServerIds: ["srv-1"],
    });
    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "the-token",
      clientFactory: () => fakeClient as never,
      timers,
      statusRefreshIntervalMs: interval,
    });

    const startP = adapter.start();
    [...handlers].find(([k]) => k.startsWith("once:"))?.[1]?.();
    await startP;

    // onReady → startStatusRefresh scheduled exactly one refresh tick.
    expect(refreshTimers()).toHaveLength(1);
    const infoCallsAfterStart = fake.getServerInfo.mock.calls.length;
    const editsAfterStart = edited.length;

    // Fire the tick: it re-fetches getInfo, then reschedules the next tick.
    // Nothing changed, so it makes no edit: Discord caps edits to old messages.
    const fireDebounce = () => {
      for (const t of scheduled.filter((s) => s.ms === EDIT_DEBOUNCE_MS)) t.cb();
    };
    refreshTimers().at(-1)!.cb();
    await flush();
    fireDebounce();
    await flush();
    expect(fake.getServerInfo.mock.calls.length).toBeGreaterThan(infoCallsAfterStart);
    expect(edited.length).toBe(editsAfterStart);
    expect(refreshTimers()).toHaveLength(2);

    // Pop changed: the next tick edits the panel (once its debounce runs out).
    fake.getServerInfo.mockResolvedValue({ players: 13, maxPlayers: 100, queuedPlayers: 0 });
    refreshTimers().at(-1)!.cb();
    await flush();
    expect(edited.length).toBe(editsAfterStart);
    fireDebounce();
    await flush();
    expect(edited.length).toBe(editsAfterStart + 1);
    expect(refreshTimers()).toHaveLength(3);

    // stop() cancels the pending tick and halts the loop.
    const pendingId = refreshTimers().at(-1)!.id;
    await adapter.stop();
    expect(cleared).toContain(pendingId);
    expect(destroyFn).toHaveBeenCalledOnce();

    // A late-firing tick after stop() must not reschedule.
    refreshTimers().at(-1)!.cb();
    await flush();
    expect(refreshTimers()).toHaveLength(3);
  });

  it("coalesces concurrent status refreshes per server while one is in flight", async () => {
    const scheduled: { id: number; cb: () => void; ms: number }[] = [];
    const timers: TimerProvider = {
      setTimer: (cb, ms) => {
        scheduled.push({ id: scheduled.length + 1, cb: cb as () => void, ms });
        return scheduled.length;
      },
      clearTimer: vi.fn(),
    };
    const interval = 60_000;
    const refreshTimers = () => scheduled.filter((s) => s.ms === interval);
    const flush = async () => {
      // Drain enough microtasks to cover the busy pre-edit + getInfo + final edit
      // chain and the loop's reschedule that runs in its .finally.
      for (let i = 0; i < 40; i++) await Promise.resolve();
    };

    const existing = new Set(["srv-1-status"]);
    const channel = {
      send: vi.fn(async () => ({ id: "new" })),
      messages: {
        fetch: vi.fn(async (id: string) => {
          if (!existing.has(id)) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return { edit: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
        }),
      },
    };
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const fakeClient = {
      once: (e: string, cb: (...a: unknown[]) => void) => handlers.set(`once:${e}`, cb),
      on: (e: string, cb: (...a: unknown[]) => void) => handlers.set(`on:${e}`, cb),
      login: loginFn,
      destroy: destroyFn,
      channels: { cache: { get: () => channel }, fetch: async () => channel },
    };

    // Server starts offline so reconstructPanels renders it without a getInfo
    // (offline servers can't answer it); we connect it after start to drive ticks.
    const coreState: FakeCoreState = {
      config: baseConfig({ admin: [], user: [] }),
      servers: [serverFixture("srv-1", { panelMessageIds: { server: "srv-1-status" } })],
      entities: [],
      connectedServerIds: [],
    };
    const fake = makeFakeCore(coreState);
    // getServerInfo hangs until released, so the first refresh stays "in flight".
    let releaseInfo: () => void = () => {};
    fake.getServerInfo.mockImplementation(
      () =>
        new Promise((res) => {
          releaseInfo = () => res({ players: 1, maxPlayers: 2, queuedPlayers: 0 });
        }),
    );

    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "the-token",
      clientFactory: () => fakeClient as never,
      timers,
      statusRefreshIntervalMs: interval,
    });
    const startP = adapter.start();
    [...handlers].find(([k]) => k.startsWith("once:"))?.[1]?.();
    await startP;
    coreState.connectedServerIds!.push("srv-1");

    // Fire the same tick twice back-to-back: the first acquires the in-flight
    // guard and blocks on getServerInfo; the second must coalesce (skip).
    const tick = refreshTimers().at(-1)!.cb;
    tick();
    tick();
    await flush();
    expect(fake.getServerInfo).toHaveBeenCalledTimes(1);

    // Release the in-flight refresh: the guard clears and a fresh tick can fetch.
    releaseInfo();
    await flush();
    refreshTimers().at(-1)!.cb();
    await flush();
    expect(fake.getServerInfo).toHaveBeenCalledTimes(2);
  });
});

describe("DiscordAdapter refresh button busy state", () => {
  it("disables the Refresh button during the fetch, then re-enables it on the result", async () => {
    const serverId = "srv";
    const state: FakeCoreState = {
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId, { panelMessageIds: { server: "status-msg" } })],
      entities: [],
      connectedServerIds: [serverId],
    };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const { client, edited } = adapterWithChannel(state, new Set(["status-msg"]));
    // @ts-expect-error inject the private client field for the test seam
    adapter.client = client;

    const sH = adapter.handleRegistry.register(serverId);
    const interaction = makeInteraction(
      buildCustomId({ domain: "server", action: "refresh", server: sH }),
      ["USER"],
      { userId: "U1" },
    );
    await adapter.dispatch(interaction);

    // Two edits: the busy pre-edit (disabled "Refreshing…") then the populated,
    // re-enabled panel.
    const statusEdits = edited
      .filter((e) => e.id === "status-msg")
      .map((e) => JSON.stringify(e.payload));
    expect(statusEdits).toHaveLength(2);
    expect(statusEdits[0]).toContain("Refreshing");
    expect(statusEdits[0]).toContain('"disabled":true');
    expect(statusEdits[1]).toContain("12/100 players");
    expect(statusEdits[1]).not.toContain("Refreshing");
    expect(statusEdits[1]).toContain('"disabled":false');
  });
});

// ── shared: an adapter wired to a fake control channel ───────────────────────

function adapterWithChannel(state: FakeCoreState, existingMessageIds: Set<string> = new Set()) {
  const sent: { id: string; payload: unknown }[] = [];
  const edited: { id: string; payload: unknown }[] = [];
  let nextId = 0;
  const channelSend = vi.fn(async (payload: unknown) => {
    const id = `new-msg-${nextId++}`;
    sent.push({ id, payload });
    return { id };
  });
  const channel = {
    send: channelSend,
    messages: {
      fetch: vi.fn(async (id: string) => {
        if (!existingMessageIds.has(id))
          throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        return {
          edit: vi.fn(async (payload: unknown) => {
            edited.push({ id, payload });
            return undefined;
          }),
        };
      }),
    },
  };
  const client = {
    channels: { cache: { get: () => channel }, fetch: async () => channel },
  };
  return { channel, client, sent, edited, channelSend };
}

function serverFixture(id: string, extra: Partial<PairedServer> = {}): PairedServer {
  return {
    id,
    name: "S",
    desc: "",
    ip: "1.1.1.1",
    port: 1,
    playerId: "0",
    playerToken: "0",
    addedAt: "",
    ...extra,
  };
}

// ── post-error reporting ─────────────────────────────────────────────────────

describe("DiscordAdapter post-error reporting", () => {
  it("reports a permission error (code 50013) when a send fails", async () => {
    const serverId = "srv-perm";
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [],
    });
    const errors: PostErrorInfo[] = [];
    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "t",
      onPostError: (info) => errors.push(info),
    });
    const err = Object.assign(new Error("Missing Permissions"), { code: 50013 });
    const channel = {
      send: vi.fn(async () => {
        throw err;
      }),
      messages: { fetch: vi.fn() },
    };
    const client = {
      channels: { cache: { get: () => channel }, fetch: async () => channel },
    };
    // @ts-expect-error inject the private client field
    adapter.client = client;

    await (adapter as unknown as { onServerPaired(s: PairedServer): Promise<void> }).onServerPaired(
      serverFixture(serverId),
    );

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.code).toBe(50013);
    expect(errors[0]!.permission).toBe(true);
    expect(errors[0]!.channelId).toBe("chan-1");
  });
});

// ── audit log ────────────────────────────────────────────────────────────────

describe("DiscordAdapter audit log", () => {
  const at = new Date(2026, 5, 16, 14, 3, 5);
  const contentLines = (sent: { payload: unknown }[]): string[] =>
    sent
      .map((s) => (s.payload as { content?: string }).content)
      .filter((c): c is string => typeof c === "string");

  it("logs a switch toggle to the logging channel with the actor", async () => {
    const serverId = "srv-audit-a";
    const entityId = 3;
    const config = {
      ...baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      loggingChannelId: "log-1",
    };
    const state: FakeCoreState = {
      config,
      servers: [serverFixture(serverId)],
      entities: [
        {
          serverId,
          entityId,
          entityType: "switch",
          label: "Front Door",
          panelMessageId: "sw-msg",
        },
      ],
    };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "t",
      now: () => at,
    });
    const { client, sent } = adapterWithChannel(state, new Set(["sw-msg"]));
    // @ts-expect-error inject the private client field
    adapter.client = client;
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "on", server: sH, entity: eH }),
      ["USER"],
      { userId: "U1" },
    );
    await adapter.dispatch(interaction);
    expect(contentLines(sent)).toContain('[14:03:05] 🔘 <@U1> toggled "Front Door" → ON');
  });

  it("logs a permission denial", async () => {
    const config = {
      ...baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      loggingChannelId: "log-1",
    };
    const state: FakeCoreState = { config, servers: [], entities: [] };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "t",
      now: () => at,
    });
    const { client, sent } = adapterWithChannel(state);
    // @ts-expect-error inject the private client field
    adapter.client = client;
    const interaction = makeInteraction(
      buildCustomId({ domain: "setup", action: "addDevice" }),
      ["USER"], // user role can't drive admin-only addDevice
      { userId: "U2" },
    );
    await adapter.dispatch(interaction);
    expect(contentLines(sent)).toContain("[14:03:05] ⛔ <@U2> denied: setup:addDevice");
  });

  it("writes nothing when no logging channel is configured", async () => {
    const serverId = "srv-audit-b";
    const entityId = 5;
    const config = baseConfig({ admin: ["ADMIN"], user: ["USER"] }); // no loggingChannelId
    const state: FakeCoreState = {
      config,
      servers: [serverFixture(serverId)],
      entities: [
        {
          serverId,
          entityId,
          entityType: "switch",
          label: "Light",
          panelMessageId: "sw2",
        },
      ],
    };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "t",
      now: () => at,
    });
    const { client, sent } = adapterWithChannel(state, new Set(["sw2"]));
    // @ts-expect-error inject the private client field
    adapter.client = client;
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "on", server: sH, entity: eH }),
      ["USER"],
      { userId: "U3" },
    );
    await adapter.dispatch(interaction);
    expect(contentLines(sent)).toHaveLength(0);
  });

  it("posts alarm + death as logging-channel lines (no control-channel panel)", async () => {
    const config = {
      ...baseConfig({ admin: [], user: [] }),
      loggingChannelId: "log-1",
    };
    const state: FakeCoreState = { config, servers: [], entities: [] };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({
      core: fake.core as never,
      token: "t",
      now: () => at,
    });
    const { client, sent } = adapterWithChannel(state);
    // @ts-expect-error inject the private client field
    adapter.client = client;
    const priv = adapter as unknown as {
      onAlarmTriggered(a: { title: string; message: string }): Promise<void>;
      onPlayerDeath(d: { name: string; message?: string }): Promise<void>;
    };
    await priv.onAlarmTriggered({ title: "Base", message: "Raid!" });
    await priv.onPlayerDeath({ name: "ShadowCat", message: "by Bob" });
    const lines = contentLines(sent);
    expect(lines).toContain('[14:03:05] 🚨 Alarm "Base": Raid!');
    expect(lines).toContain("[14:03:05] 💀 ShadowCat died: by Bob");
  });

  it("a firing alarm @mentions per its notification level (and opts into pinging)", async () => {
    const serverId = "srv-notify-fire";
    const entityId = 8;
    const config = {
      ...baseConfig({ admin: [], user: [] }),
      loggingChannelId: "log-1",
    };
    const state: FakeCoreState = {
      config,
      servers: [serverFixture(serverId)],
      entities: [
        {
          serverId,
          entityId,
          entityType: "alarm",
          label: "Perimeter",
          notificationLevel: "active",
        },
      ],
    };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t", now: () => at });
    const { client, sent } = adapterWithChannel(state);
    // @ts-expect-error inject the private client field
    adapter.client = client;
    const priv = adapter as unknown as {
      onEntityChanged(
        serverId: string,
        change: { entityId: number; value?: boolean },
      ): Promise<void>;
    };
    await priv.onEntityChanged(serverId, { entityId, value: true });
    const payload = sent.at(-1)!.payload as {
      content: string;
      allowedMentions?: { parse: string[] };
    };
    expect(payload.content).toBe('@here [14:03:05] 🔀 "Perimeter" → ON');
    expect(payload.allowedMentions).toEqual({ parse: ["everyone"] });
  });

  it("a firing alarm with the default (Normal) level notifies but parses no mentions", async () => {
    const serverId = "srv-notify-default";
    const entityId = 2;
    const config = {
      ...baseConfig({ admin: [], user: [] }),
      loggingChannelId: "log-1",
    };
    const state: FakeCoreState = {
      config,
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "alarm", label: "Quiet" }],
    };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t", now: () => at });
    const { client, sent } = adapterWithChannel(state);
    // @ts-expect-error inject the private client field
    adapter.client = client;
    const priv = adapter as unknown as {
      onEntityChanged(
        serverId: string,
        change: { entityId: number; value?: boolean },
      ): Promise<void>;
    };
    await priv.onEntityChanged(serverId, { entityId, value: true });
    const payload = sent.at(-1)!.payload as {
      content: string;
      flags?: number;
      allowedMentions?: unknown;
    };
    expect(payload.content).toBe('[14:03:05] 🔀 "Quiet" → ON');
    expect(payload.flags).toBeUndefined();
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("setup logChannel select persists via setLoggingChannel", async () => {
    const config = {
      ...baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
    };
    const fake = makeFakeCore({ config, servers: [], entities: [] });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const interaction = makeInteraction(
      buildCustomId({ domain: "setup", action: "logChannel" }),
      ["ADMIN"],
      { kind: "channel", values: ["new-log-chan"], admin: true },
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(true);
    expect(fake.setLoggingChannel).toHaveBeenCalledWith("new-log-chan");
  });
});

// ── free-text modal presentation ─────────────────────────────────────────────

describe("DiscordAdapter modal presentation", () => {
  it("pairing:label (admin) shows a 'Name this <type>' modal carrying both handles", async () => {
    const serverId = "srv-lbl";
    const entityId = 7;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "pairing", action: "label", server: sH, entity: eH }),
      ["ADMIN"],
    );
    await adapter.dispatch(interaction);
    expect(interaction.modals).toHaveLength(1);
    expect(interaction.modals[0].title).toMatch(/switch/i);
    expect(interaction.modals[0].customId).toBe(
      buildCustomId({ domain: "pairing", action: "label", server: sH, entity: eH }),
    );
  });

  it("switch:name (admin) shows a Rename modal prefilled with the current label", async () => {
    const serverId = "srv-rename-sw";
    const entityId = 11;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch", label: "Base Lights" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "name", server: sH, entity: eH }),
      ["ADMIN"],
    );
    await adapter.dispatch(interaction);
    expect(interaction.modals).toHaveLength(1);
    expect(interaction.deferred).toBe(false);
    // The Rename modal submits under pairing:label so the one submit branch handles it.
    expect(interaction.modals[0].customId).toBe(
      buildCustomId({ domain: "pairing", action: "label", server: sH, entity: eH }),
    );
    expect(interaction.modals[0].title).toMatch(/rename/i);
    // The current label is prefilled as the input's value.
    expect(JSON.stringify(interaction.modals[0].raw)).toContain("Base Lights");
  });

  it("switch:name is denied for non-admins (no modal)", async () => {
    const serverId = "srv-rename-deny";
    const entityId = 12;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch", label: "Base Lights" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "name", server: sH, entity: eH }),
      ["USER"],
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(false);
    expect(interaction.modals).toHaveLength(0);
  });

  it("alarm:name (admin) shows a Rename modal carrying both handles", async () => {
    const serverId = "srv-rename-al";
    const entityId = 13;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "alarm", label: "Front Door" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "alarm", action: "name", server: sH, entity: eH }),
      ["ADMIN"],
    );
    await adapter.dispatch(interaction);
    expect(interaction.modals).toHaveLength(1);
    expect(interaction.deferred).toBe(false);
    expect(interaction.modals[0].customId).toBe(
      buildCustomId({ domain: "pairing", action: "label", server: sH, entity: eH }),
    );
    expect(interaction.modals[0].title).toMatch(/rename/i);
  });

  it("setup:pushover (admin) shows the credentials modal (no deferUpdate)", async () => {
    const fake = makeFakeCore({
      config: {
        ...baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
        pushover: { appToken: "existing-app", userKey: "existing-user" },
      },
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const interaction = makeInteraction(buildCustomId({ domain: "setup", action: "pushover" }), [
      "ADMIN",
    ]);
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(true);
    expect(interaction.modals).toHaveLength(1);
    expect(interaction.modals[0].customId).toBe(
      buildCustomId({ domain: "setup", action: "pushover" }),
    );
    expect(interaction.deferred).toBe(false);
  });

  it("alarm:severity (admin) select → core.setAlarmPushoverSeverity with the chosen value", async () => {
    const serverId = "srv-sev";
    const entityId = 7;
    const fake = makeFakeCore({
      config: {
        ...baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
        pushover: { appToken: "a", userKey: "u" },
      },
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "alarm" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "alarm", action: "severity", server: sH, entity: eH }),
      ["ADMIN"],
      { values: ["high"], kind: "stringSelect" },
    );
    await adapter.dispatch(interaction);
    expect(fake.setAlarmPushoverSeverity).toHaveBeenCalledWith(serverId, entityId, "high");
  });

  it("alarm:severity 'off' clears the severity (null)", async () => {
    const serverId = "srv-off";
    const entityId = 4;
    const fake = makeFakeCore({
      config: {
        ...baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
        pushover: { appToken: "a", userKey: "u" },
      },
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "alarm", pushoverSeverity: "high" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "alarm", action: "severity", server: sH, entity: eH }),
      ["ADMIN"],
      { values: ["off"], kind: "stringSelect" },
    );
    await adapter.dispatch(interaction);
    expect(fake.setAlarmPushoverSeverity).toHaveBeenCalledWith(serverId, entityId, null);
  });

  it("alarm:notify (admin) select → core.setAlarmNotificationLevel with the chosen value", async () => {
    const serverId = "srv-notify";
    const entityId = 5;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "alarm" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "alarm", action: "notify", server: sH, entity: eH }),
      ["ADMIN"],
      { values: ["everyone"], kind: "stringSelect" },
    );
    await adapter.dispatch(interaction);
    expect(fake.setAlarmNotificationLevel).toHaveBeenCalledWith(serverId, entityId, "everyone");
  });

  it("alarm:notify 'default' clears the level (null)", async () => {
    const serverId = "srv-notify-off";
    const entityId = 6;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "alarm", notificationLevel: "active" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "alarm", action: "notify", server: sH, entity: eH }),
      ["ADMIN"],
      { values: ["default"], kind: "stringSelect" },
    );
    await adapter.dispatch(interaction);
    expect(fake.setAlarmNotificationLevel).toHaveBeenCalledWith(serverId, entityId, null);
  });

  it("switch:auto (admin) select → core.setSwitchAutoAction with the chosen mode", async () => {
    const serverId = "srv-auto";
    const entityId = 5;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "auto", server: sH, entity: eH }),
      ["ADMIN"],
      { values: ["off"], kind: "stringSelect" },
    );
    await adapter.dispatch(interaction);
    expect(fake.setSwitchAutoAction).toHaveBeenCalledWith(serverId, entityId, "off");
    expect(interaction.deferred).toBe(true); // acknowledged before the work
    expect(interaction.editReplies).toHaveLength(1); // ephemeral menu refreshed in place
  });

  it("switch:auto 'none' disables auto-revert (null)", async () => {
    const serverId = "srv-auto-off";
    const entityId = 6;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch", autoAction: "on" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "auto", server: sH, entity: eH }),
      ["ADMIN"],
      { values: ["none"], kind: "stringSelect" },
    );
    await adapter.dispatch(interaction);
    expect(fake.setSwitchAutoAction).toHaveBeenCalledWith(serverId, entityId, null);
  });

  it("switch:delay (admin) → opens the auto-revert delay modal prefilled with current", async () => {
    const serverId = "srv-delay";
    const entityId = 7;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch", autoActionDelaySeconds: 90 }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "delay", server: sH, entity: eH }),
      ["ADMIN"],
    );
    await adapter.dispatch(interaction);
    expect(interaction.modals).toHaveLength(1);
    const parsed = parseCustomId(interaction.modals[0].customId);
    expect(parsed?.domain).toBe("switch");
    expect(parsed?.action).toBe("autodelay");
  });

  it("switch:autodelay submit (admin) with a valid value → core.setSwitchAutoDelaySeconds", async () => {
    const serverId = "srv-delay-ok";
    const entityId = 8;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const submit = makeModalSubmit(
      buildCustomId({ domain: "switch", action: "autodelay", server: sH, entity: eH }),
      ["ADMIN"],
      { seconds: "120" },
      { admin: true },
    );
    await (
      adapter as unknown as { handleModalSubmit(i: unknown): Promise<void> }
    ).handleModalSubmit(submit);
    expect(fake.setSwitchAutoDelaySeconds).toHaveBeenCalledWith(serverId, entityId, 120);
    expect(submit.replied[0].content).toMatch(/120s/);
  });

  it("switch:autodelay submit with an out-of-range value → rejected; setter not called", async () => {
    const serverId = "srv-delay-bad";
    const entityId = 9;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const submit = makeModalSubmit(
      buildCustomId({ domain: "switch", action: "autodelay", server: sH, entity: eH }),
      ["ADMIN"],
      { seconds: "5" }, // below the 30s floor
      { admin: true },
    );
    await (
      adapter as unknown as { handleModalSubmit(i: unknown): Promise<void> }
    ).handleModalSubmit(submit);
    expect(fake.setSwitchAutoDelaySeconds).not.toHaveBeenCalled();
    expect(submit.replied[0].content).toMatch(/between/i);
  });

  it("alarm:settings (admin) → opens the ephemeral Paging menu", async () => {
    const serverId = "srv-settings";
    const entityId = 9;
    const fake = makeFakeCore({
      config: {
        ...baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
        pushover: { appToken: "a", userKey: "u" },
      },
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "alarm" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "alarm", action: "settings", server: sH, entity: eH }),
      ["ADMIN"],
    );
    await adapter.dispatch(interaction);
    expect(interaction.ephemeralPanels).toHaveLength(1);
    expect(fake.setAlarmPushoverSeverity).not.toHaveBeenCalled();
  });

  it("alarm:settings is denied for non-admins", async () => {
    const serverId = "srv-deny";
    const entityId = 3;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "alarm" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "alarm", action: "settings", server: sH, entity: eH }),
      ["USER"],
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(false);
    expect(interaction.ephemeralPanels).toHaveLength(0);
    expect(interaction.replied.length).toBeGreaterThan(0);
  });

  it("switch:settings (admin) → opens the ephemeral Settings menu", async () => {
    const serverId = "srv-sw-settings";
    const entityId = 21;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch", label: "Base Lights" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "settings", server: sH, entity: eH }),
      ["ADMIN"],
    );
    await adapter.dispatch(interaction);
    expect(interaction.ephemeralPanels).toHaveLength(1);
    // Opening Settings must not actuate the switch.
    expect(fake.toggleEntity).not.toHaveBeenCalled();
  });

  it("switch:settings is denied for non-admins", async () => {
    const serverId = "srv-sw-deny";
    const entityId = 22;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch", label: "Base Lights" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "switch", action: "settings", server: sH, entity: eH }),
      ["USER"],
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(false);
    expect(interaction.ephemeralPanels).toHaveLength(0);
  });
});

// ── alarm panel rendering ────────────────────────────────────────────────────

describe("the Alarms message", () => {
  /** Post a server's panel holding one alarm, and return the Alarms message's JSON. */
  async function alarmsMessage(opts: { severity?: "high"; configured: boolean }) {
    const state: FakeCoreState = {
      config: {
        ...baseConfig({ admin: [], user: [] }),
        ...(opts.configured ? { pushover: { appToken: "a", userKey: "u" } } : {}),
      },
      servers: [serverFixture("srv")],
      entities: [
        {
          serverId: "srv",
          entityId: 1,
          entityType: "alarm",
          label: "Front door",
          pushoverSeverity: opts.severity,
        },
      ],
    };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const { client, sent } = adapterWithChannel(state);
    // @ts-expect-error inject the private client field for the test seam
    adapter.client = client;
    await adapter.reconstructPanels();
    return JSON.stringify(sent.find((m) => JSON.stringify(m.payload).includes("Alarms"))?.payload);
  }

  it("shows each alarm as a line, with a Manage select instead of per-alarm buttons", async () => {
    const json = await alarmsMessage({ configured: true });
    expect(json).toContain("🔔 **Front door** · quiet · paging off");
    expect(json).toContain("Manage an alarm…");
    expect(json).not.toContain('"type":2');
  });

  it("paging reads on only when configured AND a priority is set", async () => {
    expect(await alarmsMessage({ severity: "high", configured: true })).toContain("paging on");
    // Priority set but no global credentials → off.
    expect(await alarmsMessage({ severity: "high", configured: false })).toContain("paging off");
    // Configured but no priority opted in → off.
    expect(await alarmsMessage({ configured: true })).toContain("paging off");
  });
});

// ── settings-menu rendering ──────────────────────────────────────────────────

describe("settings panels", () => {
  /** The Switches message for one switch "Base Lights". */
  function switchesJson(row: {
    lock: SwitchRowState["lock"];
    autoAction?: "on" | "off";
    autoDelaySeconds?: number;
  }): string {
    const messages = layoutServer({
      serverHandle: "s",
      name: "Srv",
      status: "connected",
      switches: [{ kind: "switch", entityHandle: "e", label: "Base Lights", ...row }],
      alarms: [],
      monitors: [],
      cameras: [],
    });
    return JSON.stringify(messages.find((m) => m.kind === "switches")?.payload);
  }
  const on = { phase: "synced", value: true, buttonsDisabled: false } as const;

  it("a switch row has one button with an explicit target, and settings sit behind the Manage select", () => {
    const json = switchesJson({ lock: on });
    expect(json).toContain(
      buildCustomId({ domain: "switch", action: "off", server: "s", entity: "e" }),
    );
    expect(json).not.toContain(
      buildCustomId({ domain: "switch", action: "on", server: "s", entity: "e" }),
    );
    expect(json).toContain(buildCustomId({ domain: "switch", action: "manage", server: "s" }));
  });

  it("shows an auto-off line under the switch when auto-revert is enabled", () => {
    expect(switchesJson({ lock: on, autoAction: "off", autoDelaySeconds: 30 })).toContain(
      "-# auto-off after 30s",
    );
  });

  it("shows an auto-on line with the configured delay", () => {
    expect(
      switchesJson({
        lock: { phase: "synced", value: false, buttonsDisabled: false },
        autoAction: "on",
        autoDelaySeconds: 120,
      }),
    ).toContain("-# auto-on after 120s");
  });

  it("omits the auto line when auto-revert is disabled", () => {
    expect(switchesJson({ lock: on })).not.toContain("auto-");
  });

  it("renders a switch the server has not reported as unknown, not off", () => {
    const json = switchesJson({ lock: { phase: "synced", buttonsDisabled: false } });
    expect(json).toContain("Base Lights** · ⚪ Unknown");
    expect(json).not.toContain("🔴 Off");
    // It offers Refresh, never a guessed action, and the button works.
    expect(json).toContain(
      buildCustomId({ domain: "switch", action: "refresh", server: "s", entity: "e" }),
    );
    expect(json).not.toContain('"disabled":true');
  });

  it("disables the button while an unknown switch is pending", () => {
    const json = switchesJson({ lock: { phase: "pending", buttonsDisabled: true } });
    expect(json).toContain("Base Lights** · ⏳ Switching…");
    expect(json.match(/"disabled":true/g)).toHaveLength(1);
  });

  it("buildSwitchSettingsPanel shows the device name and a Rename button", () => {
    const json = JSON.stringify(
      buildSwitchSettingsPanel({
        serverHandle: "s",
        entityHandle: "e",
        label: "Base Lights",
      }).toJSON(),
    );
    expect(json).toContain("Base Lights");
    expect(json).toContain("Settings");
    expect(json).toContain("Rename");
    expect(json).toContain(
      buildCustomId({ domain: "switch", action: "name", server: "s", entity: "e" }),
    );
  });

  it("buildAlarmSettingsPanel adds a Rename button while keeping the severity select", () => {
    const json = JSON.stringify(
      buildAlarmSettingsPanel({
        serverHandle: "s",
        entityHandle: "e",
        label: "Front Door",
        pushoverSeverity: "high",
        pushoverConfigured: true,
      }).toJSON(),
    );
    expect(json).toContain("Front Door");
    expect(json).toContain("Rename");
    expect(json).toContain(
      buildCustomId({ domain: "alarm", action: "name", server: "s", entity: "e" }),
    );
    expect(json).toContain(
      buildCustomId({ domain: "alarm", action: "severity", server: "s", entity: "e" }),
    );
    expect(json).toContain("Paging priority");
  });

  it("buildAlarmSettingsPanel renders the notification-level select above Paging priority", () => {
    const panel = buildAlarmSettingsPanel({
      serverHandle: "s",
      entityHandle: "e",
      label: "Front Door",
      notificationLevel: "everyone",
      pushoverConfigured: false,
    });
    const json = JSON.stringify(panel.toJSON());
    const notifyId = buildCustomId({ domain: "alarm", action: "notify", server: "s", entity: "e" });
    expect(json).toContain(notifyId);
    expect(json).toContain("Notification level");
    // The notification-level control must come before the paging severity one.
    expect(json.indexOf("Notification level")).toBeLessThan(json.indexOf("Paging priority"));
    // The current level is reflected as the select's default option.
    const components = panel.toJSON().components as Array<{
      type: number;
      components?: Array<{
        custom_id?: string;
        options?: Array<{ value: string; default?: boolean }>;
      }>;
    }>;
    const select = components
      .flatMap((c) => c.components ?? [])
      .find((c) => c.custom_id === notifyId);
    expect(select?.options?.find((o) => o.default)?.value).toBe("everyone");
  });

  it("buildAlarmSettingsPanel hints to configure Pushover when credentials are missing", () => {
    const json = JSON.stringify(
      buildAlarmSettingsPanel({
        serverHandle: "s",
        entityHandle: "e",
        label: "Front Door",
        pushoverConfigured: false,
      }).toJSON(),
    );
    expect(json).toContain("Configure Pushover");
  });
});

// ── modal submit routing + permission gate (security) ────────────────────────

describe("DiscordAdapter modal submit", () => {
  it("pairing:label submit (admin) → setEntityLabel then lays out the panel", async () => {
    const serverId = "srv-3";
    const entityId = 9;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const setServerPanelIds = vi.fn().mockResolvedValue(undefined);
    (adapter as unknown as { panelStore: unknown }).panelStore = {
      setServerPanelIds,
      clearLegacyPanelIds: vi.fn().mockResolvedValue(undefined),
      setEntityWatch: vi.fn().mockResolvedValue(undefined),
    } as never;
    const { client, sent } = adapterWithChannel({
      config: fake.core.getConfig(),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch" }],
    });
    // @ts-expect-error inject the private client field
    adapter.client = client;

    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const submit = makeModalSubmit(
      buildCustomId({ domain: "pairing", action: "label", server: sH, entity: eH }),
      ["ADMIN"],
      { label: "Base Lights" },
    );
    await (
      adapter as unknown as {
        handleModalSubmit(i: unknown): Promise<void>;
      }
    ).handleModalSubmit(submit);
    expect(fake.setEntityLabel).toHaveBeenCalledWith(serverId, entityId, "Base Lights");
    // No panel yet, so it is posted: the Server message, then Switches.
    expect(sent).toHaveLength(2);
    expect(setServerPanelIds).toHaveBeenCalledWith(serverId, {
      server: sent[0].id,
      switches: [sent[1].id],
    });
  });

  it("pairing:label submit permitted for a Discord Administrator with NO mapped roles", async () => {
    const serverId = "srv-4";
    const entityId = 11;
    const fake = makeFakeCore({
      config: baseConfig({ admin: [], user: [] }), // fresh install, nothing mapped
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch" }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    (adapter as unknown as { panelStore: { setEntityPanelId: unknown } }).panelStore = {
      setServerPanelIds: vi.fn().mockResolvedValue(undefined),
      clearLegacyPanelIds: vi.fn().mockResolvedValue(undefined),
      setEntityWatch: vi.fn().mockResolvedValue(undefined),
    } as never;
    const { client } = adapterWithChannel({
      config: fake.core.getConfig(),
      servers: [serverFixture(serverId)],
      entities: [{ serverId, entityId, entityType: "switch" }],
    });
    // @ts-expect-error inject the private client field
    adapter.client = client;

    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const submit = makeModalSubmit(
      buildCustomId({ domain: "pairing", action: "label", server: sH, entity: eH }),
      [], // no roles
      { label: "Front Door" },
      { admin: true },
    );
    await (
      adapter as unknown as {
        handleModalSubmit(i: unknown): Promise<void>;
      }
    ).handleModalSubmit(submit);
    expect(fake.setEntityLabel).toHaveBeenCalledWith(serverId, entityId, "Front Door");
    expect(submit.replied.some((r) => /admin role/i.test(r.content))).toBe(false);
  });

  it("setup:pushover submit (admin) with both fields → core.setPushoverCredentials", async () => {
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const submit = makeModalSubmit(
      buildCustomId({ domain: "setup", action: "pushover" }),
      ["ADMIN"],
      { appToken: "app-tok", userKey: "user-key" },
      { admin: true },
    );
    await (
      adapter as unknown as { handleModalSubmit(i: unknown): Promise<void> }
    ).handleModalSubmit(submit);
    expect(fake.setPushoverCredentials).toHaveBeenCalledWith("app-tok", "user-key");
    expect(fake.clearPushoverCredentials).not.toHaveBeenCalled();
    expect(submit.replied[0].content).toMatch(/configured/i);
  });

  it("setup:pushover submit with both fields empty → core.clearPushoverCredentials", async () => {
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const submit = makeModalSubmit(
      buildCustomId({ domain: "setup", action: "pushover" }),
      ["ADMIN"],
      { appToken: "  ", userKey: "" },
      { admin: true },
    );
    await (
      adapter as unknown as { handleModalSubmit(i: unknown): Promise<void> }
    ).handleModalSubmit(submit);
    expect(fake.clearPushoverCredentials).toHaveBeenCalledTimes(1);
    expect(fake.setPushoverCredentials).not.toHaveBeenCalled();
    expect(submit.replied[0].content).toMatch(/disabled/i);
  });

  it("setup:pushover submit with only one field → rejected; neither setter called", async () => {
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const submit = makeModalSubmit(
      buildCustomId({ domain: "setup", action: "pushover" }),
      ["ADMIN"],
      { appToken: "app-tok", userKey: "" },
      { admin: true },
    );
    await (
      adapter as unknown as { handleModalSubmit(i: unknown): Promise<void> }
    ).handleModalSubmit(submit);
    expect(fake.setPushoverCredentials).not.toHaveBeenCalled();
    expect(fake.clearPushoverCredentials).not.toHaveBeenCalled();
    expect(submit.replied[0].content).toMatch(/both/i);
  });
});

// ── newly-wired actions ──────────────────────────────────────────────────────

describe("DiscordAdapter wired actions", () => {
  it("camera:capture renders a still by identifier and shows it ephemerally", async () => {
    const serverId = "srv-cam";
    const entityId = 3;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [
        {
          serverId,
          entityId,
          entityType: "camera",
          identifier: "base_main",
          panelMessageId: "msg-cam",
        },
      ],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "camera", action: "capture", server: sH, entity: eH }),
      ["USER"],
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(true);
    expect(fake.getCameraFrame).toHaveBeenCalledWith(serverId, "base_main");
    // The still is shown to the member alone, never on the shared panel.
    const [frame] = interaction.ephemeralPanels as { files?: unknown[] }[];
    expect(frame?.files).toHaveLength(1);
    expect(JSON.stringify(frame)).toContain("attachment://camera-");
  });

  it("camera:remove-confirm forwards to core.removeEntity", async () => {
    const serverId = "srv-cam";
    const entityId = 3;
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [
        { serverId, entityId, entityType: "camera", identifier: "base_main", panelMessageId: "m" },
      ],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "camera", action: "remove-confirm", server: sH, entity: eH }),
      ["ADMIN"],
      { admin: true },
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(true);
    expect(fake.removeEntity).toHaveBeenCalledWith(serverId, entityId);
  });

  it("setup:cameraAdd modal submit registers the camera against its server", async () => {
    const serverId = "srv-cam";
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const submit = makeModalSubmit(
      buildCustomId({ domain: "setup", action: "cameraAdd", server: sH }),
      ["ADMIN"],
      { identifier: "base_main", label: "Base" },
      { admin: true },
    );
    await (
      adapter as unknown as { handleModalSubmit(i: unknown): Promise<void> }
    ).handleModalSubmit(submit);
    expect(fake.addCamera).toHaveBeenCalledWith(serverId, "base_main", "Base");
    expect(submit.replied[0].content).toMatch(/camera added/i);
    // Warn up front that Rust+ will not show cameras to an in-game player.
    expect(submit.replied[0].content).toMatch(/connected to the server in-game/);
  });

  it("setup:cameraAdd modal submit rejects an empty identifier", async () => {
    const serverId = "srv-cam";
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const sH = adapter.handleRegistry.register(serverId);
    const submit = makeModalSubmit(
      buildCustomId({ domain: "setup", action: "cameraAdd", server: sH }),
      ["ADMIN"],
      { identifier: "   ", label: "" },
      { admin: true },
    );
    await (
      adapter as unknown as { handleModalSubmit(i: unknown): Promise<void> }
    ).handleModalSubmit(submit);
    expect(fake.addCamera).not.toHaveBeenCalled();
    expect(submit.replied[0].content).toMatch(/identifier is required/i);
  });

  it("setup:cameraAdd lays out the panel exactly once (no duplicates)", async () => {
    // Regression: the camera-add handler used to lay out explicitly *and* rely on
    // the entityPaired event's layout, running two concurrent full reposts that
    // duplicated panels. The event-driven layout must be the only one.
    const serverId = "srv-cam-dup";
    // A pre-existing device so we'd also catch existing-panel duplication.
    const entities: PairedEntity[] = [
      { serverId, entityId: 1, entityType: "switch", label: "alpha" },
    ];
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities,
    });
    // Wire a real listener registry so addCamera can drive onEntityPaired, mirroring
    // how bot-core.addCamera upserts the entity then emits `entityPaired`.
    const listeners: Record<string, ((arg: unknown) => void)[]> = {};
    fake.core.on = ((event: string, cb: (arg: unknown) => void) => {
      (listeners[event] ??= []).push(cb);
    }) as never;
    fake.core.addCamera = (async (sid: string, identifier: string, label?: string) => {
      const entity: PairedEntity = {
        serverId: sid,
        entityId: -1,
        entityType: "camera",
        identifier,
        label,
      };
      entities.push(entity); // listEntities reads this same array
      for (const cb of listeners["entityPaired"] ?? []) cb(entity);
      return entity;
    }) as never;

    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    // start() normally wires these; do it directly so the entityPaired listener exists.
    (adapter as unknown as { wireDomainEvents(): void }).wireDomainEvents();
    const { client, sent } = adapterWithChannel({
      config: fake.core.getConfig(),
      servers: [serverFixture(serverId)],
      entities,
    });
    // @ts-expect-error inject the private client field
    adapter.client = client;

    const sH = adapter.handleRegistry.register(serverId);
    const submit = makeModalSubmit(
      buildCustomId({ domain: "setup", action: "cameraAdd", server: sH }),
      ["ADMIN"],
      { identifier: "base_main", label: "Base" },
      { admin: true },
    );
    await (
      adapter as unknown as { handleModalSubmit(i: unknown): Promise<void> }
    ).handleModalSubmit(submit);
    // The entityPaired relayout is fire-and-forget; let it settle before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // One layout ran: Server, Switches and the new Cameras message, each posted once.
    expect(sent).toHaveLength(3);
    expect(sent.filter((s) => JSON.stringify(s.payload).includes("Base"))).toHaveLength(1);
    expect(sent.filter((s) => JSON.stringify(s.payload).includes("alpha"))).toHaveLength(1);
  });

  it("pairing:cancel (admin) cancels the wait and re-renders the panel in place", async () => {
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const interaction = makeInteraction(
      buildCustomId({ domain: "pairing", action: "cancel" }),
      [],
      { admin: true },
    );
    const outcome = await adapter.dispatch(interaction);
    expect(outcome.allowed).toBe(true);
    expect(fake.cancelPairing).toHaveBeenCalledOnce();
    // The clicked message (the transient pairing panel) is edited in place rather
    // than acknowledged with a bare deferUpdate.
    expect(interaction.updates).toHaveLength(1);
    expect(interaction.deferred).toBe(false);
  });

  it("monitor:watch toggles, flips the settings' button and marks the row 👁 watching", async () => {
    const serverId = "srv-mon";
    const entityId = 8;
    const ids = { server: "srv-msg", storage: ["storage-msg"] };
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId, { panelMessageIds: ids })],
      entities: [{ serverId, entityId, entityType: "storageMonitor", watchChanges: false }],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const setEntityWatch = vi.fn().mockResolvedValue(undefined);
    (adapter as unknown as { panelStore: unknown }).panelStore = {
      setServerPanelIds: vi.fn().mockResolvedValue(undefined),
      clearLegacyPanelIds: vi.fn().mockResolvedValue(undefined),
      setEntityWatch,
    } as never;
    const { client, edited } = adapterWithChannel(
      { config: fake.core.getConfig(), servers: [], entities: [] },
      new Set(["storage-msg"]),
    );
    // @ts-expect-error inject the private client field
    adapter.client = client;

    const sH = adapter.handleRegistry.register(serverId);
    const eH = adapter.handleRegistry.register(HandleRegistry.entityKey(serverId, entityId));
    const interaction = makeInteraction(
      buildCustomId({ domain: "monitor", action: "watch", server: sH, entity: eH }),
      ["USER"],
    );
    await adapter.dispatch(interaction);
    expect(setEntityWatch).toHaveBeenCalledWith(serverId, entityId, true);
    expect(JSON.stringify(interaction.updates)).toContain("Watch: ON");
    expect(edited.map((e) => e.id)).toEqual(["storage-msg"]);
    expect(JSON.stringify(edited[0]?.payload)).toContain("👁 watching");
  });
});

// ── server pairing posts the status panel ────────────────────────────────────

describe("DiscordAdapter server pairing panels", () => {
  it("onServerPaired posts the (single) Server message and persists its id", async () => {
    const serverId = "srv-paired";
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const setServerPanelIds = vi.fn().mockResolvedValue(undefined);
    (adapter as unknown as { panelStore: unknown }).panelStore = {
      setServerPanelIds,
      clearLegacyPanelIds: vi.fn().mockResolvedValue(undefined),
      setEntityWatch: vi.fn().mockResolvedValue(undefined),
    } as never;
    const { client, sent } = adapterWithChannel({
      config: fake.core.getConfig(),
      servers: [serverFixture(serverId)],
      entities: [],
    });
    // @ts-expect-error inject the private client field
    adapter.client = client;

    await (
      adapter as unknown as {
        onServerPaired(s: PairedServer): Promise<void>;
      }
    ).onServerPaired(serverFixture(serverId));

    // One message: no devices yet, and the team is part of the Server message.
    expect(sent).toHaveLength(1);
    expect(setServerPanelIds.mock.calls).toEqual([[serverId, { server: sent[0].id }]]);
  });

  it("Setup hub Add device replies with an ephemeral pairing panel and begins pairing", async () => {
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [],
      entities: [],
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const { client, sent } = adapterWithChannel({
      config: fake.core.getConfig(),
      servers: [],
      entities: [],
    });
    // @ts-expect-error inject the private client field
    adapter.client = client;

    const interaction = makeInteraction(buildCustomId({ domain: "setup", action: "addDevice" }), [
      "ADMIN",
    ]);
    await adapter.dispatch(interaction);
    // No persistent channel post — the pairing panel is the ephemeral reply.
    expect(sent).toHaveLength(0);
    expect(interaction.ephemeralPanels).toHaveLength(1);
    expect(fake.beginPairing).toHaveBeenCalledOnce();
  });

  it("onEntityPaired auto-dismisses the stashed ephemeral pairing panel", async () => {
    const serverId = "srv-pair";
    // bot-core upserts the entity before emitting `entityPaired`, so the layout
    // onEntityPaired runs sees it in listEntities — mirror that in the fixture.
    const entities = [{ serverId, entityId: 5, entityType: "switch" as const }];
    const fake = makeFakeCore({
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities,
    });
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    (adapter as unknown as { panelStore: unknown }).panelStore = {
      setServerPanelIds: vi.fn().mockResolvedValue(undefined),
      clearLegacyPanelIds: vi.fn().mockResolvedValue(undefined),
      setEntityWatch: vi.fn().mockResolvedValue(undefined),
    } as never;
    const { client, sent } = adapterWithChannel({
      config: fake.core.getConfig(),
      servers: [serverFixture(serverId)],
      entities,
    });
    // @ts-expect-error inject the private client field
    adapter.client = client;

    // Add device → stashes the ephemeral pairing handle.
    const addDevice = makeInteraction(buildCustomId({ domain: "setup", action: "addDevice" }), [
      "ADMIN",
    ]);
    await adapter.dispatch(addDevice);
    expect(addDevice.ephemeralPanels).toHaveLength(1);

    // Device pairs → persistent control panel posts AND the ephemeral panel is deleted.
    await (
      adapter as unknown as {
        onEntityPaired(e: PairedEntity): Promise<void>;
      }
    ).onEntityPaired({
      serverId,
      entityId: 5,
      entityType: "switch",
    } as PairedEntity);

    expect(sent).toHaveLength(2); // the server's panel: Server and Switches
    expect(addDevice.ephemeralDeletes).toBe(1);
  });
});

// ── device panel ordering ─────────────────────────────────────────────────────

describe("DiscordAdapter device row ordering", () => {
  it("lists rows alphabetically by label (case-insensitive) within their type's message", async () => {
    const serverId = "srv-order";
    // Deliberately out of order, mixed case: the rows must read apple/Banana/cherry.
    const entities = [
      { serverId, entityId: 1, entityType: "switch" as const, label: "cherry" },
      { serverId, entityId: 2, entityType: "switch" as const, label: "apple" },
      { serverId, entityId: 3, entityType: "switch" as const, label: "Banana" },
    ];
    const state: FakeCoreState = {
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [serverFixture(serverId)],
      entities,
    };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const { client, sent } = adapterWithChannel(state);
    // @ts-expect-error inject the private client field
    adapter.client = client;

    await adapter.reconstructPanels();

    // One Switches message holds all three, in order.
    expect(sent).toHaveLength(2);
    const switches = JSON.stringify(sent[1]?.payload);
    expect(switches.indexOf("apple")).toBeLessThan(switches.indexOf("Banana"));
    expect(switches.indexOf("Banana")).toBeLessThan(switches.indexOf("cherry"));
  });

  it("a device that sorts first is an edit in place, never a repost (Discord can't reorder)", async () => {
    const serverId = "srv-reorder";
    // "zulu" is on the panel already; a freshly paired "alpha" must read above it.
    const entities: PairedEntity[] = [
      { serverId, entityId: 1, entityType: "switch", label: "zulu" },
      { serverId, entityId: 2, entityType: "switch", label: "alpha" },
    ];
    const state: FakeCoreState = {
      config: baseConfig({ admin: ["ADMIN"], user: ["USER"] }),
      servers: [
        serverFixture(serverId, { panelMessageIds: { server: "srv-msg", switches: ["sw-msg"] } }),
      ],
      entities,
    };
    const fake = makeFakeCore(state);
    const adapter = new DiscordAdapter({ core: fake.core as never, token: "t" });
    const { client, sent, edited } = adapterWithChannel(state, new Set(["srv-msg", "sw-msg"]));
    // @ts-expect-error inject the private client field
    adapter.client = client;

    await (adapter as unknown as { onEntityPaired(e: PairedEntity): Promise<void> }).onEntityPaired(
      entities[1]!,
    );

    expect(sent).toEqual([]);
    expect(edited.map((e) => e.id)).toEqual(["srv-msg", "sw-msg"]);
    const switches = JSON.stringify(edited[1]?.payload);
    expect(switches.indexOf("alpha")).toBeLessThan(switches.indexOf("zulu"));
  });
});
