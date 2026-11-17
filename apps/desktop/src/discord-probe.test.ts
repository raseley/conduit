import { describe, it, expect } from "vitest";

import {
  BOT_CHANNEL_PERMISSIONS,
  DISCORD_API_BASE,
  DiscordAuthError,
  DiscordForbiddenError,
  DiscordProbeError,
  PERMISSION,
  conduitOverwrites,
  hasPermission,
  DiscordProtocolError,
  DiscordUnavailableError,
  GATEWAY_GUILD_MEMBERS,
  GATEWAY_GUILD_MEMBERS_LIMITED,
  createDiscordProbe,
  parseApplication,
  parseGuilds,
} from "./discord-probe.js";

const TOKEN = "MTAxMjM0NTY3ODkwMTIzNDU2Nzg.GabcDe.fGhIjKlMnOpQrStUvWxYz0123456789abcd";
const APP_ID = "123456789012345678";
const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const ICON = "0123456789abcdef0123456789abcdef";
const BOT_ID = "333333333333333333";
const CATEGORY_ID = "444444444444444444";
const CONTROL_ID = "555555555555555555";
const LOG_ID = "666666666666666666";

interface Call {
  url: string;
  init: RequestInit;
}

/** A hand-rolled fake `fetch`: records calls and answers with a canned response. */
function fakeFetch(answer: () => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  };
  return { fetch: fn as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createDiscordProbe().getApplication", () => {
  it("GETs /applications/@me as the bot and returns the app id + name", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ id: APP_ID, name: "MyBot", flags: GATEWAY_GUILD_MEMBERS_LIMITED }),
    );
    const app = await createDiscordProbe({ fetch }).getApplication(`  ${TOKEN}  `);

    expect(app).toEqual({
      id: APP_ID,
      name: "MyBot",
      membersIntentEnabled: true,
      botUserId: APP_ID,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${DISCORD_API_BASE}/applications/@me`);
    expect(calls[0]!.init.method).toBe("GET");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bot ${TOKEN}`);
    expect(headers["User-Agent"]).toMatch(/^DiscordBot \(/);
  });

  it("throws DiscordAuthError on 401, without the token in the message", async () => {
    const { fetch } = fakeFetch(() => json({ message: "401: Unauthorized", code: 0 }, 401));
    const err = await createDiscordProbe({ fetch })
      .getApplication(TOKEN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordAuthError);
    expect(err).toBeInstanceOf(DiscordProbeError);
    expect((err as Error).name).toBe("DiscordAuthError");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("wraps a network failure in DiscordUnavailableError (retryable)", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await createDiscordProbe({ fetch })
      .getApplication(TOKEN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordUnavailableError);
    expect((err as DiscordUnavailableError).status).toBeUndefined();
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });

  it("treats 5xx and 429 as Discord being unavailable, with the status", async () => {
    for (const status of [500, 502, 429]) {
      const { fetch } = fakeFetch(() => json({}, status));
      const err = await createDiscordProbe({ fetch })
        .getApplication(TOKEN)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiscordUnavailableError);
      expect((err as DiscordUnavailableError).status).toBe(status);
    }
  });

  it("fails closed on a non-JSON body", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>", { status: 200 }));
    await expect(createDiscordProbe({ fetch }).getApplication(TOKEN)).rejects.toBeInstanceOf(
      DiscordProtocolError,
    );
  });
});

describe("createDiscordProbe().listGuilds", () => {
  it("GETs /users/@me/guilds and returns validated servers", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json([
        { id: GUILD_A, name: "Alpha", icon: ICON, owner: false, permissions: "0" },
        { id: GUILD_B, name: "Beta", icon: null },
      ]),
    );
    const guilds = await createDiscordProbe({ fetch }).listGuilds(TOKEN);

    expect(calls[0]!.url).toBe(`${DISCORD_API_BASE}/users/@me/guilds`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
    expect(guilds).toEqual([
      {
        id: GUILD_A,
        name: "Alpha",
        iconUrl: `https://cdn.discordapp.com/icons/${GUILD_A}/${ICON}.png?size=64`,
        permissions: "0",
      },
      { id: GUILD_B, name: "Beta" },
    ]);
  });

  it("returns an empty list when the bot is in no servers", async () => {
    const { fetch } = fakeFetch(() => json([]));
    expect(await createDiscordProbe({ fetch }).listGuilds(TOKEN)).toEqual([]);
  });

  it("throws DiscordAuthError on 401", async () => {
    const { fetch } = fakeFetch(() => json({}, 401));
    await expect(createDiscordProbe({ fetch }).listGuilds(TOKEN)).rejects.toBeInstanceOf(
      DiscordAuthError,
    );
  });
});

/** A channel as Discord lists it. */
function channel(id: string, type: number, name: string, parentId?: string): object {
  return { id, type, name, parent_id: parentId ?? null, position: 0 };
}

/**
 * A tiny fake Discord for the channel calls: `GET /guilds/{id}/channels` lists
 * `existing`; each `POST` creates a channel with the next id from `newIds`
 * (or answers `postStatus` instead).
 */
function fakeDiscord(opts: { existing?: object[]; newIds?: string[]; postStatus?: number }): {
  fetch: typeof fetch;
  calls: Call[];
  posts: () => Array<Record<string, unknown>>;
} {
  const newIds = [...(opts.newIds ?? [])];
  const { fetch, calls } = fakeFetch(() => {
    const call = calls[calls.length - 1]!;
    if (call.init.method === "GET") return json(opts.existing ?? []);
    if (opts.postStatus !== undefined)
      return json({ message: "Missing Permissions" }, opts.postStatus);
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    return json(
      channel(newIds.shift()!, body.type as number, body.name as string, body.parent_id as string),
      201,
    );
  });
  const posts = (): Array<Record<string, unknown>> =>
    calls
      .filter((c) => c.init.method === "POST")
      .map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);
  return { fetch, calls, posts };
}

const ENSURE_INPUT = { guildId: GUILD_A, botUserId: BOT_ID };

/** The overwrites every one of Conduit's channels is created with. */
const EXPECTED_OVERWRITES = [
  { id: GUILD_A, type: 0, allow: "0", deny: "1024" },
  { id: BOT_ID, type: 1, allow: "257024", deny: "0" },
];

describe("createDiscordProbe().ensureConduitChannels", () => {
  it("creates the category, then both text channels inside it, on a fresh server", async () => {
    const discord = fakeDiscord({ newIds: [CATEGORY_ID, CONTROL_ID, LOG_ID] });
    const result = await createDiscordProbe({ fetch: discord.fetch }).ensureConduitChannels(
      TOKEN,
      ENSURE_INPUT,
    );

    expect(discord.calls[0]!.url).toBe(`${DISCORD_API_BASE}/guilds/${GUILD_A}/channels`);
    expect(discord.calls[0]!.init.method).toBe("GET");
    for (const call of discord.calls.slice(1)) {
      expect(call.url).toBe(`${DISCORD_API_BASE}/guilds/${GUILD_A}/channels`);
      expect(call.init.method).toBe("POST");
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bot ${TOKEN}`);
      expect(headers["Content-Type"]).toBe("application/json");
    }
    expect(discord.posts()).toEqual([
      { name: "Conduit", type: 4, permission_overwrites: EXPECTED_OVERWRITES },
      {
        name: "conduit",
        type: 0,
        parent_id: CATEGORY_ID,
        permission_overwrites: EXPECTED_OVERWRITES,
      },
      {
        name: "conduit-log",
        type: 0,
        parent_id: CATEGORY_ID,
        permission_overwrites: EXPECTED_OVERWRITES,
      },
    ]);
    expect(result).toEqual({
      category: { id: CATEGORY_ID, name: "Conduit", created: true },
      control: { id: CONTROL_ID, name: "conduit", created: true },
      logging: { id: LOG_ID, name: "conduit-log", created: true },
    });
  });

  it("reuses existing channels by name and creates nothing", async () => {
    const discord = fakeDiscord({
      existing: [
        channel(GUILD_B, 0, "general"),
        channel(CATEGORY_ID, 4, "CONDUIT"),
        channel(CONTROL_ID, 0, "conduit", CATEGORY_ID),
        channel(LOG_ID, 0, "conduit-log", CATEGORY_ID),
      ],
    });
    const result = await createDiscordProbe({ fetch: discord.fetch }).ensureConduitChannels(
      TOKEN,
      ENSURE_INPUT,
    );
    expect(discord.posts()).toEqual([]);
    expect(result).toEqual({
      category: { id: CATEGORY_ID, name: "CONDUIT", created: false },
      control: { id: CONTROL_ID, name: "conduit", created: false },
      logging: { id: LOG_ID, name: "conduit-log", created: false },
    });
  });

  it("creates only the missing ones", async () => {
    const discord = fakeDiscord({
      existing: [
        channel(CATEGORY_ID, 4, "Conduit"),
        channel(CONTROL_ID, 0, "conduit", CATEGORY_ID),
        // A voice channel of the same name is not the log channel.
        channel(GUILD_B, 2, "conduit-log", CATEGORY_ID),
      ],
      newIds: [LOG_ID],
    });
    const result = await createDiscordProbe({ fetch: discord.fetch }).ensureConduitChannels(
      TOKEN,
      ENSURE_INPUT,
    );
    expect(discord.posts()).toEqual([
      {
        name: "conduit-log",
        type: 0,
        parent_id: CATEGORY_ID,
        permission_overwrites: EXPECTED_OVERWRITES,
      },
    ]);
    expect(result.control).toEqual({ id: CONTROL_ID, name: "conduit", created: false });
    expect(result.logging).toEqual({ id: LOG_ID, name: "conduit-log", created: true });
  });

  it("prefers the channel inside Conduit's category over one elsewhere", async () => {
    const elsewhere = "777777777777777777";
    const discord = fakeDiscord({
      existing: [
        channel(elsewhere, 0, "conduit"),
        channel(CATEGORY_ID, 4, "Conduit"),
        channel(CONTROL_ID, 0, "conduit", CATEGORY_ID),
        channel(LOG_ID, 0, "conduit-log"),
      ],
    });
    const result = await createDiscordProbe({ fetch: discord.fetch }).ensureConduitChannels(
      TOKEN,
      ENSURE_INPUT,
    );
    expect(result.control.id).toBe(CONTROL_ID);
    // Outside the category, but it has the name: reused rather than duplicated.
    expect(result.logging.id).toBe(LOG_ID);
    expect(discord.posts()).toEqual([]);
  });

  it("allows the bot only permissions it has server-wide", async () => {
    const discord = fakeDiscord({ newIds: [CATEGORY_ID, CONTROL_ID, LOG_ID] });
    // An older install: everything but Mention Everyone, plus Manage Channels.
    const perms = String(BOT_CHANNEL_PERMISSIONS - PERMISSION.MENTION_EVERYONE + 16);
    await createDiscordProbe({ fetch: discord.fetch }).ensureConduitChannels(TOKEN, {
      ...ENSURE_INPUT,
      botPermissions: perms,
    });
    for (const post of discord.posts()) {
      expect(post.permission_overwrites).toContainEqual({
        id: BOT_ID,
        type: 1,
        allow: "125952",
        deny: "0",
      });
    }
  });

  it("maps a 403 to DiscordForbiddenError", async () => {
    const discord = fakeDiscord({ postStatus: 403 });
    const err = await createDiscordProbe({ fetch: discord.fetch })
      .ensureConduitChannels(TOKEN, ENSURE_INPUT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordForbiddenError);
    expect(err).toBeInstanceOf(DiscordProbeError);
    expect((err as Error).name).toBe("DiscordForbiddenError");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("fails closed on a malformed channel list or answer", async () => {
    const list = fakeFetch(() => json({ channels: [] }));
    await expect(
      createDiscordProbe({ fetch: list.fetch }).ensureConduitChannels(TOKEN, ENSURE_INPUT),
    ).rejects.toBeInstanceOf(DiscordProtocolError);

    const badParent = fakeFetch(() => json([{ id: CONTROL_ID, type: 0, name: "x", parent_id: 5 }]));
    await expect(
      createDiscordProbe({ fetch: badParent.fetch }).ensureConduitChannels(TOKEN, ENSURE_INPUT),
    ).rejects.toBeInstanceOf(DiscordProtocolError);
  });

  it("refuses ids that are not snowflakes before calling Discord", async () => {
    const discord = fakeDiscord({});
    await expect(
      createDiscordProbe({ fetch: discord.fetch }).ensureConduitChannels(TOKEN, {
        guildId: "../users/@me",
        botUserId: BOT_ID,
      }),
    ).rejects.toBeInstanceOf(DiscordProtocolError);
    expect(discord.calls).toHaveLength(0);
  });
});

describe("hasPermission", () => {
  it("tests a bit in Discord's decimal bitfield string", () => {
    expect(hasPermission("16", PERMISSION.MANAGE_CHANNELS)).toBe(true);
    expect(hasPermission("125952", PERMISSION.MANAGE_CHANNELS)).toBe(false);
    // Bits above 2^53 survive (BigInt), and don't confuse the low bits.
    expect(hasPermission("9007199254740992", PERMISSION.MANAGE_CHANNELS)).toBe(false);
  });

  it("treats Administrator as every permission", () => {
    expect(hasPermission("8", PERMISSION.MANAGE_CHANNELS)).toBe(true);
  });
});

describe("conduitOverwrites", () => {
  it("keeps the full allow for an administrator bot", () => {
    expect(conduitOverwrites({ ...ENSURE_INPUT, botPermissions: "8" })).toEqual(
      EXPECTED_OVERWRITES,
    );
  });
});

describe("parseApplication", () => {
  it("reads the Server Members intent from either flag", () => {
    expect(parseApplication({ id: APP_ID, name: "A", flags: GATEWAY_GUILD_MEMBERS })).toEqual({
      id: APP_ID,
      name: "A",
      membersIntentEnabled: true,
      botUserId: APP_ID,
    });
    expect(
      parseApplication({ id: APP_ID, name: "A", flags: GATEWAY_GUILD_MEMBERS_LIMITED | 1 }),
    ).toMatchObject({ membersIntentEnabled: true });
    expect(parseApplication({ id: APP_ID, name: "A", flags: 1 << 23 })).toMatchObject({
      membersIntentEnabled: false,
    });
    expect(parseApplication({ id: APP_ID, name: "A" })).toMatchObject({
      membersIntentEnabled: false,
    });
  });

  it("takes the bot's user id from bot.id, else the Application ID", () => {
    expect(parseApplication({ id: APP_ID, name: "A", bot: { id: BOT_ID } }).botUserId).toBe(BOT_ID);
    expect(parseApplication({ id: APP_ID, name: "A", bot: null }).botUserId).toBe(APP_ID);
  });

  it("fails closed on a malformed body", () => {
    for (const body of [
      { id: APP_ID, name: "A", bot: "x" },
      { id: APP_ID, name: "A", bot: { id: "nope" } },
      null,
      [],
      "x",
      { name: "A" },
      { id: "12", name: "A" },
      { id: 12345678901234, name: "A" },
      { id: APP_ID },
      { id: APP_ID, name: "  " },
      { id: APP_ID, name: "A", flags: "16384" },
      { id: APP_ID, name: "A", flags: -1 },
    ]) {
      expect(() => parseApplication(body)).toThrow(DiscordProtocolError);
    }
  });
});

describe("parseGuilds", () => {
  it("fails closed on a malformed body", () => {
    for (const body of [
      null,
      {},
      [null],
      [{ id: "nope", name: "A" }],
      [{ id: GUILD_A }],
      [{ id: GUILD_A, name: "A", icon: 7 }],
      [{ id: GUILD_A, name: "A", permissions: 16 }],
      [{ id: GUILD_A, name: "A", permissions: "0x10" }],
    ]) {
      expect(() => parseGuilds(body)).toThrow(DiscordProtocolError);
    }
  });

  it("never builds an icon URL from a malformed hash", () => {
    expect(parseGuilds([{ id: GUILD_A, name: "A", icon: "../../evil" }])).toEqual([
      { id: GUILD_A, name: "A" },
    ]);
  });

  it("keeps animated icon hashes", () => {
    expect(parseGuilds([{ id: GUILD_A, name: "A", icon: `a_${ICON}` }])[0]!.iconUrl).toContain(
      `/a_${ICON}.png`,
    );
  });
});
