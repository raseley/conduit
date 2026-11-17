/**
 * Discord REST calls for the bootstrap wizard: electron-free, with an injectable
 * `fetch` seam (the {@link createPushoverNotifier} pattern), so it unit-tests
 * with a fake and no network.
 *
 * All calls are authenticated as the bot (`Authorization: Bot …`):
 * - `GET /applications/@me`: proves the token is live and yields the
 *   Application ID (no separate "paste the Application ID" step), the app's name,
 *   the bot's user id, and its `flags`, which say whether the Server Members
 *   intent is enabled.
 * - `GET /users/@me/guilds`: the servers the bot has been invited to, with the
 *   bot's permissions in each, so the wizard can find the user's server instead
 *   of asking for its ID.
 * - `GET /guilds/{id}/channels` + `POST /guilds/{id}/channels`: the one write.
 *   {@link DiscordProbe.ensureConduitChannels} creates Conduit's private
 *   category and its two text channels, reusing any that already exist. This
 *   needs Manage Channels; without it Discord answers 403, which becomes a
 *   {@link DiscordForbiddenError}.
 *
 * This module is the trust boundary for those responses: each body is validated
 * here and anything malformed **fails closed** with a {@link DiscordProtocolError}.
 * Code past it relies on the typed shapes. The token is never logged, never put
 * in an error message, and never leaves this module except in the header.
 */

/** Discord REST API base (v10). */
export const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Discord CDN base, for server icons. */
export const DISCORD_CDN_BASE = "https://cdn.discordapp.com";

/** Application flag: Server Members intent enabled (verified bots, 100+ servers). */
export const GATEWAY_GUILD_MEMBERS = 1 << 14;
/** Application flag: Server Members intent enabled (unverified bots, < 100 servers). */
export const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;

// ── Permissions ───────────────────────────────────────────────────────────────

/** Discord permission bits Conduit uses (see Discord's "Permissions" docs). */
export const PERMISSION = {
  ADMINISTRATOR: 8,
  MANAGE_CHANNELS: 16,
  VIEW_CHANNEL: 1024,
  SEND_MESSAGES: 2048,
  MANAGE_MESSAGES: 8192,
  EMBED_LINKS: 16384,
  ATTACH_FILES: 32768,
  READ_MESSAGE_HISTORY: 65536,
  MENTION_EVERYONE: 131072,
} as const;

/**
 * What the bot needs in its channels (257024): View Channel, Send Messages,
 * Manage Messages, Embed Links, Attach Files (map and camera images), Read
 * Message History (live-editing its panels), and Mention Everyone (alarm @here
 * / @everyone and admin-role pings). The invite asks for these plus Manage
 * Channels; Conduit's own channels allow them to the bot by overwrite.
 */
export const BOT_CHANNEL_PERMISSIONS =
  PERMISSION.VIEW_CHANNEL |
  PERMISSION.SEND_MESSAGES |
  PERMISSION.MANAGE_MESSAGES |
  PERMISSION.EMBED_LINKS |
  PERMISSION.ATTACH_FILES |
  PERMISSION.READ_MESSAGE_HISTORY |
  PERMISSION.MENTION_EVERYONE;

/**
 * Whether a server-wide permission set (a decimal bitfield string, as Discord
 * sends it) holds `bit`. Administrator holds every permission.
 */
export function hasPermission(permissions: string, bit: number): boolean {
  const perms = BigInt(permissions);
  const admin = BigInt(PERMISSION.ADMINISTRATOR);
  const wanted = BigInt(bit);
  return (perms & admin) === admin || (perms & wanted) === wanted;
}

// ── Conduit's channels ────────────────────────────────────────────────────────

/** The category Conduit creates (category names keep their case). */
export const CONDUIT_CATEGORY_NAME = "Conduit";
/** The control channel, where the panels live. */
export const CONDUIT_CONTROL_CHANNEL_NAME = "conduit";
/** The logging channel, for the activity log. */
export const CONDUIT_LOG_CHANNEL_NAME = "conduit-log";

/** Discord channel types Conduit reads or creates. */
export const CHANNEL_TYPE = { GUILD_TEXT: 0, GUILD_CATEGORY: 4 } as const;

/** Permission-overwrite target types. */
const OVERWRITE_ROLE = 0;
const OVERWRITE_MEMBER = 1;

/** How long one probe request may take before it counts as Discord being unreachable. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Discord asks API clients to identify themselves as `DiscordBot (url, version)`. */
const USER_AGENT = "DiscordBot (conduit-desktop, 2026.11.0)";

/** A Discord snowflake id: a 17–20 digit number. */
const SNOWFLAKE = /^\d{17,20}$/;

/** A Discord image hash (`a_` prefix for animated icons). */
const IMAGE_HASH = /^(a_)?[0-9a-f]{32}$/;

// ── Errors ────────────────────────────────────────────────────────────────────

/** Base class for every probe failure. Messages never contain the token. */
export class DiscordProbeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscordProbeError";
  }
}

/** Discord rejected the token (HTTP 401): wrong, reset, or not a bot token. */
export class DiscordAuthError extends DiscordProbeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscordAuthError";
  }
}

/**
 * Discord could not be reached or did not answer usefully: offline, timed out,
 * rate-limited, or an unexpected HTTP status. Retryable.
 */
export class DiscordUnavailableError extends DiscordProbeError {
  /** The HTTP status, when Discord answered at all. */
  readonly status?: number;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "DiscordUnavailableError";
    this.status = options?.status;
  }
}

/**
 * Discord refused the action (HTTP 403): the bot lacks a permission it needs,
 * e.g. Manage Channels to create Conduit's channels.
 */
export class DiscordForbiddenError extends DiscordProbeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscordForbiddenError";
  }
}

/** Discord answered 2xx with a body that is not the documented shape. */
export class DiscordProtocolError extends DiscordProbeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscordProtocolError";
  }
}

// ── Shapes ────────────────────────────────────────────────────────────────────

/** The bot's application, as the wizard needs it. */
export interface DiscordApplication {
  /** Application (client) id: the `client_id` of the invite URL. */
  id: string;
  /** The application's display name. */
  name: string;
  /** Whether the Server Members privileged intent is enabled in the portal. */
  membersIntentEnabled: boolean;
  /**
   * The bot's user id: `bot.id` when Discord sends it, otherwise the
   * Application ID (the same value for current applications).
   */
  botUserId: string;
}

/** One server (guild) the bot is in. */
export interface DiscordGuild {
  id: string;
  name: string;
  /** CDN URL of the server icon, when it has one. */
  iconUrl?: string;
  /**
   * The bot's server-wide permissions, a decimal bitfield string (test it with
   * {@link hasPermission}). Absent when Discord didn't send them.
   */
  permissions?: string;
}

/** A channel in a server, as {@link DiscordProbe.ensureConduitChannels} reads it. */
export interface DiscordChannel {
  id: string;
  /** Channel type: one of {@link CHANNEL_TYPE}, or another Discord type. */
  type: number;
  /** Empty for the rare channel types that have no name. */
  name: string;
  /** The category it sits in, if any. */
  parentId?: string;
}

/** One of Conduit's channels after {@link DiscordProbe.ensureConduitChannels}. */
export interface EnsuredChannel {
  id: string;
  name: string;
  /** True when Conduit created it just now; false when it already existed. */
  created: boolean;
}

/** Conduit's category and its two text channels, created or reused. */
export interface ConduitChannels {
  category: EnsuredChannel;
  control: EnsuredChannel;
  logging: EnsuredChannel;
}

/** What {@link DiscordProbe.ensureConduitChannels} needs to know. */
export interface EnsureChannelsInput {
  guildId: string;
  /** The bot's user id: its own overwrite keeps the hidden channels visible to it. */
  botUserId: string;
  /**
   * The bot's server-wide permissions, when known. Discord lets an overwrite
   * set at creation allow only permissions the bot already has, so the bot's
   * own allow is narrowed to these (an older install may lack Mention Everyone).
   */
  botPermissions?: string;
}

/** The probe's calls. */
export interface DiscordProbe {
  /** `GET /applications/@me`: validates the token and returns its application. */
  getApplication(token: string): Promise<DiscordApplication>;
  /** `GET /users/@me/guilds`: the servers the bot has been invited to. */
  listGuilds(token: string): Promise<DiscordGuild[]>;
  /**
   * Make sure the server has Conduit's private category with `#conduit` and
   * `#conduit-log` in it: list the server's channels, reuse the ones that
   * already exist (by name), and create the rest. Throws
   * {@link DiscordForbiddenError} when the bot may not create channels.
   */
  ensureConduitChannels(token: string, input: EnsureChannelsInput): Promise<ConduitChannels>;
}

/** Injectable `fetch` seam (defaults to Node's global `fetch`). */
export type FetchFn = typeof fetch;

/** Options for {@link createDiscordProbe}. */
export interface DiscordProbeOptions {
  fetch?: FetchFn;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
}

// ── Implementation ────────────────────────────────────────────────────────────

/** Build a {@link DiscordProbe} over `fetch`. Tests pass a fake. */
export function createDiscordProbe(opts: DiscordProbeOptions = {}): DiscordProbe {
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function requestJson(
    method: "GET" | "POST",
    path: string,
    token: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bot ${token.trim()}`,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetchFn(`${DISCORD_API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new DiscordUnavailableError(`Discord request to ${path} failed`, { cause });
    }

    if (res.status === 401) {
      throw new DiscordAuthError(`Discord rejected the bot token (HTTP 401 from ${path})`);
    }
    if (res.status === 403) {
      throw new DiscordForbiddenError(`Discord refused ${method} ${path} (HTTP 403)`);
    }
    if (!res.ok) {
      throw new DiscordUnavailableError(`Discord returned HTTP ${res.status} from ${path}`, {
        status: res.status,
      });
    }
    try {
      return await res.json();
    } catch (cause) {
      throw new DiscordProtocolError(`Discord returned a non-JSON body from ${path}`, { cause });
    }
  }

  const getJson = (path: string, token: string): Promise<unknown> =>
    requestJson("GET", path, token);

  async function createChannel(
    token: string,
    guildId: string,
    spec: { name: string; type: number; parentId?: string; overwrites: PermissionOverwrite[] },
  ): Promise<EnsuredChannel> {
    const body: Record<string, unknown> = {
      name: spec.name,
      type: spec.type,
      permission_overwrites: spec.overwrites,
    };
    if (spec.parentId !== undefined) body.parent_id = spec.parentId;
    const channel = parseChannel(
      await requestJson("POST", `/guilds/${guildId}/channels`, token, body),
    );
    return { id: channel.id, name: channel.name, created: true };
  }

  return {
    async getApplication(token) {
      return parseApplication(await getJson("/applications/@me", token));
    },
    async listGuilds(token) {
      return parseGuilds(await getJson("/users/@me/guilds", token));
    },
    async ensureConduitChannels(token, input) {
      const { guildId } = input;
      // Both ids end up in a URL path or an overwrite: check them first.
      if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(input.botUserId)) {
        throw new DiscordProtocolError("server or bot id was not a snowflake");
      }
      const existing = parseChannels(await getJson(`/guilds/${guildId}/channels`, token));
      const overwrites = conduitOverwrites(input);

      const foundCategory = existing.find(
        (c) => c.type === CHANNEL_TYPE.GUILD_CATEGORY && sameName(c.name, CONDUIT_CATEGORY_NAME),
      );
      const category: EnsuredChannel = foundCategory
        ? { id: foundCategory.id, name: foundCategory.name, created: false }
        : await createChannel(token, guildId, {
            name: CONDUIT_CATEGORY_NAME,
            type: CHANNEL_TYPE.GUILD_CATEGORY,
            overwrites,
          });

      const ensureText = async (name: string): Promise<EnsuredChannel> => {
        const matches = existing.filter(
          (c) => c.type === CHANNEL_TYPE.GUILD_TEXT && sameName(c.name, name),
        );
        // Prefer the one in Conduit's category; any of that name will do.
        const found = matches.find((c) => c.parentId === category.id) ?? matches[0];
        if (found) return { id: found.id, name: found.name, created: false };
        return createChannel(token, guildId, {
          name,
          type: CHANNEL_TYPE.GUILD_TEXT,
          parentId: category.id,
          overwrites,
        });
      };
      const control = await ensureText(CONDUIT_CONTROL_CHANNEL_NAME);
      const logging = await ensureText(CONDUIT_LOG_CHANNEL_NAME);
      return { category, control, logging };
    },
  };
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** One entry of a channel's `permission_overwrites`, as Discord takes it. */
export interface PermissionOverwrite {
  id: string;
  /** 0 = role, 1 = member. */
  type: number;
  allow: string;
  deny: string;
}

/**
 * The overwrites each of Conduit's channels is created with (the category and
 * both text channels alike, so they start in sync): @everyone, the role whose
 * id is the server id, may not view them; the bot, by a member overwrite, may
 * do what it needs. The bot's own entry is required: hiding a channel from
 * @everyone hides it from the bot too. Discord copying a category's overwrites
 * to new children is not relied on.
 */
export function conduitOverwrites(input: EnsureChannelsInput): PermissionOverwrite[] {
  let botAllow = BigInt(BOT_CHANNEL_PERMISSIONS);
  const perms = input.botPermissions;
  if (perms !== undefined && !hasPermission(perms, PERMISSION.ADMINISTRATOR)) {
    // Discord refuses an overwrite that allows what the bot doesn't have.
    botAllow &= BigInt(perms);
  }
  return [
    { id: input.guildId, type: OVERWRITE_ROLE, allow: "0", deny: String(PERMISSION.VIEW_CHANNEL) },
    { id: input.botUserId, type: OVERWRITE_MEMBER, allow: String(botAllow), deny: "0" },
  ];
}

// ── Boundary validation (exported for tests) ────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqSnowflake(obj: Record<string, unknown>, what: string): string {
  const id = obj.id;
  if (typeof id !== "string" || !SNOWFLAKE.test(id)) {
    throw new DiscordProtocolError(`${what} had no valid snowflake id`);
  }
  return id;
}

function reqName(obj: Record<string, unknown>, what: string): string {
  const name = obj.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new DiscordProtocolError(`${what} had no name`);
  }
  return name;
}

/** Validate a `GET /applications/@me` body. Fails closed. */
export function parseApplication(body: unknown): DiscordApplication {
  if (!isRecord(body)) throw new DiscordProtocolError("application was not an object");
  const id = reqSnowflake(body, "application");
  const name = reqName(body, "application");
  const flags = body.flags ?? 0;
  if (typeof flags !== "number" || !Number.isInteger(flags) || flags < 0) {
    throw new DiscordProtocolError("application flags were not a non-negative integer");
  }
  const intentBits = GATEWAY_GUILD_MEMBERS | GATEWAY_GUILD_MEMBERS_LIMITED;
  let botUserId = id;
  if (body.bot !== undefined && body.bot !== null) {
    if (!isRecord(body.bot)) throw new DiscordProtocolError("application bot was not an object");
    botUserId = reqSnowflake(body.bot, "application bot");
  }
  return { id, name, membersIntentEnabled: (flags & intentBits) !== 0, botUserId };
}

/** Validate a `GET /users/@me/guilds` body. Fails closed. */
export function parseGuilds(body: unknown): DiscordGuild[] {
  if (!Array.isArray(body)) throw new DiscordProtocolError("guild list was not an array");
  return body.map((entry) => {
    if (!isRecord(entry)) throw new DiscordProtocolError("guild was not an object");
    const id = reqSnowflake(entry, "guild");
    const name = reqName(entry, "guild");
    const icon = entry.icon;
    if (icon !== undefined && icon !== null && typeof icon !== "string") {
      throw new DiscordProtocolError("guild icon was not a string");
    }
    const permissions = entry.permissions;
    if (
      permissions !== undefined &&
      (typeof permissions !== "string" || !/^\d+$/.test(permissions))
    ) {
      throw new DiscordProtocolError("guild permissions were not a decimal bitfield");
    }
    const guild: DiscordGuild = { id, name };
    // Only a well-formed hash becomes a URL; anything else just means "no icon".
    if (typeof icon === "string" && IMAGE_HASH.test(icon)) {
      guild.iconUrl = `${DISCORD_CDN_BASE}/icons/${id}/${icon}.png?size=64`;
    }
    if (permissions !== undefined) guild.permissions = permissions;
    return guild;
  });
}

/** Validate one channel object (a list entry, or a `POST` answer). Fails closed. */
export function parseChannel(body: unknown): DiscordChannel {
  if (!isRecord(body)) throw new DiscordProtocolError("channel was not an object");
  const id = reqSnowflake(body, "channel");
  const type = body.type;
  if (typeof type !== "number" || !Number.isInteger(type)) {
    throw new DiscordProtocolError("channel type was not an integer");
  }
  // A few channel types have no name; such a channel is never one of Conduit's.
  const name = typeof body.name === "string" ? body.name : "";
  const parent = body.parent_id;
  if (parent !== undefined && parent !== null) {
    if (typeof parent !== "string" || !SNOWFLAKE.test(parent)) {
      throw new DiscordProtocolError("channel parent_id was not a snowflake");
    }
  }
  const channel: DiscordChannel = { id, type, name };
  if (typeof parent === "string") channel.parentId = parent;
  return channel;
}

/** Validate a `GET /guilds/{id}/channels` body. Fails closed. */
export function parseChannels(body: unknown): DiscordChannel[] {
  if (!Array.isArray(body)) throw new DiscordProtocolError("channel list was not an array");
  return body.map(parseChannel);
}
