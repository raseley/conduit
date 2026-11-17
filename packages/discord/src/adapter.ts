/**
 * {@link DiscordAdapter} — tier 1, the primary user surface.
 *
 * Owns the complete Discord interaction model: logs in a discord.js client,
 * registers the two bootstrap slash commands, keeps each server's **Conduit
 * Panel** (a Server message plus one Components V2 message per device type)
 * posted once and edited in place, routes every component interaction
 * through one dispatcher with a per-click permission check, and drives the
 * switch state-lock machine. It holds NO Rust+/pairing logic — every action
 * resolves to a `bot-core` call.
 *
 * The discord.js `Client` is created through an injectable factory so the
 * dispatcher and lifecycle can be unit-tested with a mocked client.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type Interaction,
  type ClientOptions,
  type APIMessageTopLevelComponent,
} from "discord.js";

import {
  SWITCH_AUTO_DELAY_DEFAULT,
  SWITCH_AUTO_DELAY_MIN,
  SWITCH_AUTO_DELAY_MAX,
  SWITCH_GROUP_MAX_MEMBERS,
  SWITCH_GROUP_NAME_MAX,
} from "@conduit/bot-core";
import type {
  AppConfig,
  BotCore,
  BotCoreEventMap,
  AlarmNotificationLevel,
  EntityChange,
  EntityInfo,
  GameTime,
  PairedEntity,
  PairedServer,
  PushoverSeverity,
  ServerConnectionStatus,
  ServerInfo,
  ServerPanelIds,
  SwitchAutoAction,
  SwitchGroup,
  TeamInfo,
} from "@conduit/bot-core";

import { CUSTOM_ID_PREFIX, buildCustomId, parseCustomId, type ParsedCustomId } from "./customId.js";
import { HandleRegistry } from "./handles.js";
import {
  adoptNamedRoles,
  isAllowed,
  requiredCapabilityFor,
  type ServerRole,
} from "./permissions.js";
import {
  StateLockMachine,
  type LockKey,
  type LockResult,
  type TimerProvider,
} from "./state-lock.js";
import { NoopPanelStore, type PanelStore } from "./panel-store.js";
import { PanelQueue } from "./panel-queue.js";
import {
  EDIT_DEBOUNCE_MS,
  EditPipeline,
  type EditOutcome,
  type SubmitOptions,
  type SubmitOutcome,
} from "./edit-pipeline.js";
import {
  NEW_GROUP_OPTION,
  PANEL_KINDS,
  UPKEEP_REPAINT_INTERVAL_MS,
  upkeepState,
  buildAlarmSettingsPanel,
  buildCameraFramePanel,
  buildCameraServerSelectPanel,
  buildCameraSettingsPanel,
  buildGroupDeleteConfirmPanel,
  buildGroupNoticePanel,
  buildMonitorContentsPanel,
  buildMonitorSettingsPanel,
  buildPairingPanel,
  buildRemoveConfirmPanel,
  buildRemovedNoticePanel,
  buildSetupPanel,
  buildSwitchGroupPanel,
  buildSwitchGroupPickerPanel,
  buildSwitchSettingsPanel,
  layoutServer,
  toPanelPayload,
  trimText,
  type PanelKind,
  type PanelMessage,
  type PanelPayload,
  type RemovableDomain,
  type ServerLayoutState,
  type SwitchesRow,
  type UpkeepState,
  type SwitchGroupMember,
  type AlarmRowState,
  type MonitorRowState,
  type CameraRowState,
} from "./panels.js";
import {
  alarmMentionPrefix,
  auditAlarm,
  auditAuthRenewal,
  auditFailure,
  auditGroupToggle,
  auditUnconfirmed,
  auditDeath,
  auditDenied,
  auditEntityChange,
  auditEntityPaired,
  auditInteraction,
  auditModal,
  auditServerPaired,
  auditServerStatus,
  auditSlash,
  auditSwitchToggle,
  auditTeamChat,
  roleMentionPrefix,
  type AuditDelivery,
} from "./audit-log.js";
import {
  COULD_NOT_CONFIRM_MESSAGE,
  DENIAL_MESSAGE,
  NO_ROLE_MESSAGE,
  STALE_STATE_MESSAGE,
  friendlyError,
  shortFailureReason,
} from "./errors.js";

/** Minimal structural logger (mirrors bot-core's; defaults to no-op). */
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

/** Factory for the discord.js client (test seam). */
export type ClientFactory = (options: ClientOptions) => Client;

/** Construction options for {@link DiscordAdapter}. */
export interface DiscordAdapterOptions {
  /** The coordinator core; the only path to Rust+. */
  core: BotCore;
  /** Discord bot token (entered during bootstrap). */
  token: string;
  /**
   * Application (client) id, required to register slash commands. Optional here:
   * when omitted the adapter falls back to `config.discordAppId` (set by the
   * bootstrap wizard). Provide it to override config (tests / env forwarding).
   */
  applicationId?: string;
  /**
   * Optional guild id to scope slash-command registration to a single guild.
   * Guild-scoped commands appear within seconds (global commands can take up to
   * ~1 hour). Takes precedence over `config.discordGuildId` (set by the
   * bootstrap wizard); provide it only to override config (tests / env forwarding).
   */
  guildId?: string;
  /** Structural logger; defaults to no-op. */
  logger?: Logger;
  /**
   * Panel-id persistence. bot-core ships no panel-id setter (see panel-store.ts);
   * the desktop host wires a real implementation. Defaults to a no-op so panels
   * still work in-session.
   */
  panelStore?: PanelStore;
  /** Override the discord.js client constructor (test seam). */
  clientFactory?: ClientFactory;
  /** Override the state-lock timer source (test seam). */
  timers?: TimerProvider;
  /**
   * How long start() waits for the gateway ClientReady event before proceeding
   * anyway. onReady (the panel reconcile) is bound to the event, not this wait, so
   * if ready arrives late panels still self-heal — this only bounds how long the
   * coordinator is gated on startup. Defaults to 30s; mainly a test seam.
   */
  readyTimeoutMs?: number;
  /**
   * How often, in ms, to re-fetch + live-edit the status panel of every connected
   * server so Pop/Queue stays current between connect/disconnect events (the only
   * other refresh triggers). Drives a self-rescheduling timer off the injected
   * `timers` seam, so the next tick is only scheduled after the prior refresh
   * settles (no overlap, no drift-pileup). Defaults to 60s; set `0` to disable.
   */
  statusRefreshIntervalMs?: number;
  /**
   * How long, in ms, an automatic panel edit (a broadcast, a reconnect, the
   * periodic status refresh) waits for newer changes to the same panel, so a
   * burst becomes one edit, sparing Discord's cap on edits to old messages. A
   * member's click is never delayed by it. Defaults to 750 ms; `0` sends every edit at once.
   */
  editDebounceMs?: number;
  /** Clock for audit-log timestamps (test seam); defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Notified when a panel/audit send to a channel fails. The host surfaces this
   * (e.g. a tray health row) so a silent "Missing Permissions" doesn't look like
   * everything is fine. `code` is Discord's error code when available (50013
   * Missing Permissions, 50001 Missing Access). Defaults to a no-op.
   */
  onPostError?: (info: PostErrorInfo) => void;
  /**
   * The picture to give the bot when it has none (the Conduit mark): each
   * user creates their own bot, so the app ships its avatar. Read only when
   * needed, and applied once on ready, only while the bot has no avatar, so a
   * picture the user chose is never replaced. The host supplies the bytes; this
   * package reads no app assets.
   */
  botAvatar?: () => Promise<Uint8Array | undefined>;
}

/**
 * How long to wait before asking again for a device that answered `not_found`
 * right at pairing (the server may not have finished setting it up).
 */
const PAIRING_INTEREST_RETRY_MS = 5_000;

/**
 * How long after a tool cupboard's upkeep is due to run out it is read again.
 * A cupboard that has run dry may never broadcast again (nothing is left in it
 * to change), so without this its row would keep "upkeep ends 3 hours ago".
 */
const UPKEEP_RECHECK_GRACE_MS = 60_000;

/**
 * How long after a tool cupboard's last broadcast it is read directly for its
 * upkeep, which the broadcast itself does not bring up to date. Two seconds,
 * as the community client rustplusplus uses for the same purpose.
 */
const UPKEEP_REREAD_DELAY_MS = 2_000;

/** The longest delay a timer can take (`setTimeout`'s 32-bit limit, about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * How long an open switch group panel is kept live: an ephemeral reply
 * can be edited through its interaction token for 15 minutes, so a little less.
 */
const GROUP_VIEW_TTL_MS = 14 * 60_000;

/** How long a new switch group's name waits for its members to be picked. */
const GROUP_DRAFT_TTL_MS = 15 * 60_000;

/** A switch group resolved from a custom ID. */
interface ResolvedGroup {
  serverId: string;
  group: SwitchGroup;
  serverHandle: string;
  groupHandle: string;
}

/**
 * An open switch group panel: an ephemeral message a member is looking
 * at, edited as its members' states change while its token lasts.
 */
interface GroupView {
  serverId: string;
  groupId: string;
  edit(payload: PanelPayload): Promise<void>;
  /** When its interaction token runs out (ms epoch). */
  expiresAt: number;
  /** The last payload shown, to skip an edit that would change nothing. */
  fingerprint?: string;
  /** The edit in flight, so edits to one panel run in order. */
  chain?: Promise<void>;
}

/** "➕ New group…" when there is no switch left to group. */
const NO_UNGROUPED_SWITCH_MESSAGE =
  "⚠️ Every switch on this server is already in a group. Edit a group's members to move one.";

/** A new group's member picker answered after its name was forgotten (a restart, or 15 minutes). */
const GROUP_FORM_EXPIRED_MESSAGE =
  "⚠️ This form has expired. Start again from **Manage a switch…** → **New group…**.";

/** The switch group name modal: one required text input, `name`. */
function groupNameModal(customId: string, title: string, current?: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId("name")
    .setLabel("Group name")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(SWITCH_GROUP_NAME_MAX)
    .setRequired(true);
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

/** Discord error codes that decide what a failed panel edit or delete means. */
const DISCORD_UNKNOWN_CHANNEL = 10003;
const DISCORD_UNKNOWN_MESSAGE = 10008;
const DISCORD_MISSING_ACCESS = 50001;
const DISCORD_MISSING_PERMISSIONS = 50013;
/**
 * "Maximum number of edits to messages older than 1 hour reached": Discord's
 * undocumented cap on edits to old messages. Panels are old messages, so every
 * panel edit counts against it.
 */
export const DISCORD_EDIT_CAP = 30046;

/**
 * At most one automatic rebuild of every panel per this long. A 30046
 * sooner than that pauses the refused panel's edits instead, so an unexpected
 * refusal cannot turn into a delete-and-repost loop.
 */
export const EDIT_CAP_REBUILD_INTERVAL_MS = 60 * 60_000;

/** How many of the control channel's latest messages the orphan sweep looks at. */
const SWEEP_MESSAGE_LIMIT = 100;

/**
 * What became of an edit or delete of a stored panel message:
 * - `ok`: it was edited or deleted.
 * - `gone`: Discord answered 10008 Unknown Message. Only this means the panel
 *   no longer exists and may be reposted.
 * - `unreachable`: the control channel is missing (10003), the bot cannot see
 *   or use it (50001 / 50013), or none is set. The panel may well still be there,
 *   so its id is kept and nothing is reposted.
 * - `capped`: Discord refused the edit with 30046 (its edit cap for messages
 *   older than an hour). The edit is not retried: the adapter rebuilds every
 *   panel (at most once an hour), or else the edit pipeline pauses that panel's
 *   edits.
 * - `failed`: anything else (a timeout, a 5xx, a rate limit). The id is kept and
 *   the next render retries.
 */
type PanelWriteOutcome = EditOutcome;

/** Classify a failed panel edit or delete by Discord's error code. */
function panelErrorOutcome(err: unknown): Exclude<PanelWriteOutcome, "ok"> {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === DISCORD_UNKNOWN_MESSAGE) return "gone";
  if (code === DISCORD_EDIT_CAP) return "capped";
  if (
    code === DISCORD_UNKNOWN_CHANNEL ||
    code === DISCORD_MISSING_ACCESS ||
    code === DISCORD_MISSING_PERMISSIONS
  ) {
    return "unreachable";
  }
  return "failed";
}

/**
 * Whether a message's components carry a Conduit custom ID (`conduit:v1:…`),
 * i.e. whether it is one of our panels rather than a plain-text line. Walks the
 * component tree (action rows, containers, sections and their accessories),
 * reading discord.js component objects through their API (`toJSON`) shape.
 */
function hasConduitCustomId(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasConduitCustomId);
  if (!node || typeof node !== "object") return false;
  const json = typeof (node as { toJSON?: unknown }).toJSON === "function";
  const data = (json ? (node as { toJSON(): unknown }).toJSON() : node) as {
    custom_id?: unknown;
    customId?: unknown;
    components?: unknown;
    accessory?: unknown;
  };
  if (!data || typeof data !== "object") return false;
  const customId = data.custom_id ?? data.customId;
  if (typeof customId === "string" && customId.startsWith(`${CUSTOM_ID_PREFIX}:`)) return true;
  return hasConduitCustomId(data.components) || hasConduitCustomId(data.accessory);
}

/** The slice of a discord.js message the panel helpers use. */
interface ChannelMessage {
  id: string;
  author?: { id?: string } | null;
  components?: unknown;
  edit(p: unknown): Promise<unknown>;
  delete(): Promise<unknown>;
}

/** Narrow a resolved channel to one that can hold and send messages. */
function asTextChannel(channel: unknown): TextChannelLike | undefined {
  return channel && typeof channel === "object" && "send" in channel && "messages" in channel
    ? (channel as TextChannelLike)
    : undefined;
}

/** The slice of a discord.js text channel the panel helpers use. */
interface TextChannelLike {
  send(payload: unknown): Promise<{ id: string }>;
  messages: {
    fetch(id: string): Promise<ChannelMessage>;
    fetch(options: { limit: number }): Promise<{ values(): Iterable<ChannelMessage> }>;
  };
}

/** Reported via {@link DiscordAdapterOptions.onPostError} when a send fails. */
export interface PostErrorInfo {
  /** The channel the send targeted. */
  channelId: string;
  /** Discord error code when the failure was a `DiscordAPIError` (else undefined). */
  code?: number;
  /** Human-readable error message. */
  message: string;
  /** True when `code` is a permission/access error (50013 / 50001). */
  permission: boolean;
  /**
   * True when Discord refused a panel edit with 30046 (its edit cap for messages
   * older than an hour). The adapter has rebuilt every panel (`panelsRebuilt`),
   * or else paused that panel's edits for a while.
   */
  editCap?: boolean;
  /**
   * With `editCap`: every panel is being deleted and posted afresh (a fresh
   * message is not subject to the cap), so nothing is left stale. Without it,
   * the refused panel's edits are paused.
   */
  panelsRebuilt?: boolean;
}

/**
 * A handle to an already-sent ephemeral reply, so the adapter can edit or delete
 * it later — even from an async domain-event handler with no interaction in scope
 * (e.g. auto-dismissing the pairing panel when `entityPaired` arrives via FCM).
 * Backed by the interaction webhook, it is valid for ~15 minutes; callers wrap
 * `editPanel`/`delete` in try/catch so an expired token degrades gracefully.
 */
export interface EphemeralHandle {
  /** Live-edit the ephemeral reply with a fresh V2 panel payload. */
  editPanel(payload: PanelPayload): Promise<void>;
  /** Delete the ephemeral reply (auto-dismiss). */
  delete(): Promise<void>;
}

/** An ephemeral Components V2 reply, optionally with attachments. */
export type EphemeralPanelPayload = PanelPayload & { files?: unknown[] };

/**
 * A discord.js interaction reduced to just what the dispatcher needs. The real
 * `Interaction` is structurally compatible; tests pass a hand-rolled object.
 */
export interface DispatchableInteraction {
  customId: string;
  /** Role ids of the clicking member. */
  memberRoleIds: string[];
  /** Discord user id of the clicking member (for the audit log). */
  userId?: string;
  /** Display/username of the clicking member (audit-log fallback when no id). */
  userName?: string;
  /**
   * Whether the clicking member holds Discord's Administrator permission (server
   * owners always do). Lets the owner/admin drive the Setup hub before any
   * Conduit roles are mapped. See {@link DiscordAdapter.isGuildAdministrator}.
   */
  isAdministrator?: boolean;
  /** Selected values for select-menu interactions (channel/role ids). */
  values?: string[];
  isButton(): boolean;
  isChannelSelectMenu(): boolean;
  isRoleSelectMenu(): boolean;
  isStringSelectMenu(): boolean;
  /** Reply ephemerally (denial/failure/confirmation). */
  replyEphemeral(content: string): Promise<void>;
  /**
   * Reply ephemerally with a Components V2 panel and return a handle for editing
   * or dismissing it later. Used by the transient Setup/Pairing flows and every
   * device's settings, so they are visible only to the invoking member. After an
   * acknowledgement it follows up instead. `files` carries attachments (a camera
   * frame). Optional in tests that don't exercise it.
   */
  replyEphemeralPanel?(payload: EphemeralPanelPayload): Promise<EphemeralHandle>;
  /** Show a modal (free-text entry). Optional in tests that don't exercise it. */
  showModal?(modal: unknown): Promise<void>;
  /** Acknowledge without a visible reply. */
  deferUpdate?(): Promise<void>;
  /**
   * Acknowledge a component click by editing the clicked message in place. Used
   * when the source message IS the panel to re-render (e.g. the transient pairing
   * panel on [Cancel], which the adapter does not otherwise track by id).
   */
  update?(payload: unknown): Promise<void>;
  /**
   * Edit the clicked message after a {@link deferUpdate}. Lets a handler
   * acknowledge first, do slow work, then re-render the source message (e.g.
   * the ephemeral switch settings menu after `switch:auto`).
   */
  editReply?(payload: unknown): Promise<void>;
}

/**
 * Domains whose admin-gated actions a Discord Administrator (incl. the server
 * owner) may perform even with no Conduit roles mapped. Scoped to the Setup hub
 * flow — channel/role mapping, device pairing — so the owner can always complete
 * setup. Device-control panels (switch/alarm/monitor/camera) stay strictly
 * role-gated by design, even for the owner.
 */
const ADMIN_BYPASS_DOMAINS = new Set(["setup", "pairing"]);

/** The outcome of dispatching an interaction (useful for tests + logging). */
export interface DispatchOutcome {
  /** Whether the interaction matched a Conduit customId at all. */
  handled: boolean;
  /** Whether the per-click permission check passed. */
  allowed: boolean;
  /** Resolved parsed customId, when ours. */
  parsed?: ParsedCustomId;
}

/** What a panel edit sends: a Components V2 payload, sometimes with files. */
interface PanelEditPayload {
  components: unknown[];
  flags: number;
  files?: unknown[];
  attachments?: unknown[];
}

/**
 * What the edit pipeline compares to skip an edit that would change nothing.
 * A payload carrying files (a camera frame) can't be compared, so it is always
 * sent.
 */
function panelFingerprint(payload: PanelEditPayload): string | undefined {
  if (payload.files?.length) return undefined;
  return JSON.stringify({ components: payload.components, flags: payload.flags });
}

/** In-memory record of a posted panel, keyed for live edits. */
interface PanelRef {
  messageId: string;
}

/** What laying out one server's Conduit Panel did. */
interface GroupReport {
  /** Message ids edited in place (or found unchanged), plus those posted afresh. */
  edited: string[];
  /** Messages that could not be posted (no channel access, say). */
  missing: { kind: PanelKind; serverId: string }[];
  /** Stored ids whose edit failed for a reason other than 10008: kept, for the next render to retry. */
  kept: string[];
  /** Old per-device, status and team panels deleted by the Conduit Panel migration. */
  migrated: number;
}

/** What {@link DiscordAdapter.reconstructPanels} did with each server's panel. */
export interface ReconcileReport extends GroupReport {
  /** Orphaned Conduit panels deleted from the control channel. */
  swept: number;
}

function emptyReport(): GroupReport {
  return { edited: [], missing: [], kept: [], migrated: 0 };
}

function mergeReport(into: GroupReport, from: GroupReport): void {
  into.edited.push(...from.edited);
  into.missing.push(...from.missing);
  into.kept.push(...from.kept);
  into.migrated += from.migrated;
}

/** The device-type messages, in posting order. */
const TYPE_KINDS = PANEL_KINDS.filter((k) => k !== "server");

/** The stored id of one message of a server's Conduit Panel, if any. */
function slotId(
  ids: ServerPanelIds | undefined,
  kind: PanelKind,
  page: number,
): string | undefined {
  if (!ids) return undefined;
  if (kind === "server") return page === 0 ? ids.server : undefined;
  return ids[kind]?.[page];
}

function setSlot(ids: ServerPanelIds, kind: PanelKind, page: number, id: string): void {
  if (kind === "server") ids.server = id;
  else (ids[kind] ??= [])[page] = id;
}

/** Every message id of a server's Conduit Panel, in posting order. */
function panelIdList(ids: ServerPanelIds | undefined): string[] {
  if (!ids) return [];
  return [ids.server, ...TYPE_KINDS.flatMap((k) => ids[k] ?? [])].filter(
    (id): id is string => typeof id === "string",
  );
}

/** The stored ids, kept to the messages a layout has. */
function idsForLayout(ids: ServerPanelIds, messages: readonly PanelMessage[]): ServerPanelIds {
  const next: ServerPanelIds = {};
  for (const m of messages) {
    const id = slotId(ids, m.kind, m.page);
    if (id) setSlot(next, m.kind, m.page, id);
  }
  return next;
}

/** The message a device domain's rows live in. */
function kindForDomain(domain: string): PanelKind | undefined {
  switch (domain) {
    case "switch":
      return "switches";
    case "alarm":
      return "alarms";
    case "monitor":
      return "storage";
    case "camera":
      return "cameras";
    default:
      return undefined;
  }
}

/** Display order for names: case-insensitive and numeric-aware ("Switch 2" before "Switch 10"). */
function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

/** A state-lock key as a string, for sets of switches. */
function lockId(key: LockKey): string {
  return HandleRegistry.entityKey(key.serverId, key.entityId);
}

/** What a render of the Server message may show beyond the cached state. */
interface ServerExtras {
  /** The in-game clock, for a manual Refresh only (it would make every tick an edit). */
  timeLabel?: string;
  /** A manual Refresh is in flight. */
  refreshing?: boolean;
}

/** Panels never ping: no `@everyone`, role or user mention in a panel is parsed. */
const PANEL_ALLOWED_MENTIONS = { parse: [] as string[] };

/**
 * How long a camera's Capture stays disabled after a press, so members can't
 * spam the server with renders (each one subscribes and accumulates frames).
 */
export const CAMERA_COOLDOWN_MS = 30_000;

/**
 * The Discord adapter. Construct with `{ core, token, logger }`, then
 * `start()`/`stop()` — the exact surface the desktop app calls.
 */
export class DiscordAdapter {
  private readonly core: BotCore;
  private readonly token: string;
  private readonly applicationId?: string;
  private readonly guildId?: string;
  private readonly log: Logger;
  private readonly panelStore: PanelStore;
  private readonly clientFactory: ClientFactory;
  private readonly now: () => Date;
  private readonly onPostError: (info: PostErrorInfo) => void;
  private readonly botAvatar?: () => Promise<Uint8Array | undefined>;

  private readonly handles = new HandleRegistry();
  private readonly stateLock: StateLockMachine;
  private readonly timers: TimerProvider;
  private readonly readyTimeoutMs: number;
  private readonly statusRefreshIntervalMs: number;

  private client?: Client;
  private started = false;

  /**
   * One detach function per bot-core listener registered by
   * {@link wireDomainEvents}. Run (and emptied) by {@link unwireDomainEvents} so
   * a stopped adapter stops reacting to bot-core, and a restart registers exactly
   * one set of listeners rather than stacking a second.
   */
  private domainUnsubscribers: Array<() => void> = [];

  /**
   * Handle to the in-flight periodic status-refresh timer, and a flag gating its
   * self-reschedule. The flag is the real stop switch: when a tick has fired and
   * its refresh is in flight, `clearTimer` on the (already-spent) handle is a
   * no-op, so `stopStatusRefresh` flips this false to keep the `.finally` from
   * scheduling the next tick.
   */
  private statusRefreshTimer?: unknown;
  private statusRefreshActive = false;

  /**
   * Server ids with a refresh-style status render in flight. Guards the manual
   * Refresh button and the periodic tick against each other so overlapping
   * getInfo round-trips can't stack (button-spam, or a tick landing on a slow
   * fetch). Only the coalescing callers touch this; connect/disconnect renders
   * stay authoritative and ignore it.
   */
  private readonly statusRefreshInFlight = new Set<string>();

  /**
   * The latest contents of each storage monitor (`serverId/entityId`), from
   * `getEntityInfo` (pairing, reconnect, Refresh) or an `entityChanged`
   * broadcast. The Storage message is drawn from this; without it, a row can
   * only say "contents unknown".
   */
  private readonly monitorInfo = new Map<string, EntityInfo>();

  /**
   * Whether each smart alarm (`serverId/entityId`) last reported itself on
   * (sounding): its line and the Alarms message turn red while it is.
   */
  private readonly alarmFiring = new Map<string, boolean>();

  /**
   * A storage monitor's Watch flag as just toggled (`serverId/entityId`), so it
   * shows at once even before the panel store's write reaches bot-core's entity.
   */
  private readonly watchOverride = new Map<string, boolean>();

  /**
   * When each server's Storage message was last redrawn from a monitor's
   * contents (epoch ms), so an unwatched tool cupboard's upkeep payments redraw
   * it at most once per {@link UPKEEP_REPAINT_INTERVAL_MS}.
   */
  private readonly storagePaintedAt = new Map<string, number>();

  /**
   * Each tool cupboard's re-read at its upkeep expiry (`serverId/entityId`): the
   * armed timer and the expiry (Unix seconds) it was armed for.
   */
  private readonly upkeepChecks = new Map<string, { handle: unknown; expiry: number }>();

  /**
   * Each tool cupboard's pending read after a broadcast (`serverId/entityId`):
   * the timer handle, pushed back by each further broadcast.
   */
  private readonly upkeepReads = new Map<string, unknown>();

  /**
   * Each camera whose Capture is cooling down (`serverId/entityId`): when it is
   * ready again (epoch ms) and the timer that re-enables its button then.
   */
  private readonly cameraCooldowns = new Map<string, { handle: unknown; until: number }>();

  /**
   * Each server's Conduit Panel message ids as last written, so a panel store
   * that persists nothing still edits the panel in-session. Falls back to
   * bot-core's `PairedServer.panelMessageIds`.
   */
  private readonly panelIds = new Map<string, ServerPanelIds>();

  /** Shown on the Server message when its last status request failed. */
  private readonly statusNotes = new Map<string, string>();

  /**
   * Open switch group panels, keyed `serverId/groupId/userId` (a member
   * has one live view of a group: the latest). Re-rendered when the Switches
   * message is, so each member's state there stays current.
   */
  private readonly groupViews = new Map<string, GroupView>();

  /** New switch groups waiting for their members: name chosen, by draft token. */
  private readonly groupDrafts = new Map<
    string,
    { serverId: string; name: string; expiresAt: number }
  >();
  private groupDraftSeq = 0;

  /**
   * Members (`serverId/entityId`) whose pending click came from a group action.
   * The group action wrote one audit line, so their confirming changes
   * write none of their own.
   */
  private readonly groupClicked = new Set<string>();

  /**
   * Interactions whose handler reported a failure itself (via
   * {@link replyFailure}) instead of throwing, so the "interaction handled" log
   * line can still say `failed`.
   */
  private readonly failedInteractions = new WeakSet<object>();

  /**
   * Last good `getServerInfo` per server: the Server message's players/queue,
   * kept while reconnecting and through the "refreshing" pre-edit. Cleared when
   * a server goes offline.
   */
  private readonly lastServerInfo = new Map<string, ServerInfo>();

  /**
   * Last good `getTeam` roster per server, mirroring {@link lastServerInfo}: the
   * Server message's team line. Cleared when a server goes offline.
   */
  private readonly lastTeam = new Map<string, TeamInfo>();

  /**
   * Handle to the in-flight pairing flow's ephemeral panel, stashed when [Add
   * device] is clicked so `onEntityPaired` can auto-dismiss it. Single-slot:
   * bot-core's `beginPairing`/`cancelPairing` are themselves singular.
   */
  private pairingDismiss?: EphemeralHandle;

  /**
   * Serialises every operation that posts, deletes or re-lays out persistent
   * panels, keyed by control channel. See {@link withPanelQueue}.
   */
  private readonly panelQueue = new PanelQueue();

  /**
   * Channels a panel edit or delete found unreachable (10003 / 50001 / 50013).
   * The first such failure is logged at warn and reported to the host; later
   * ones only at debug, until a write to the channel succeeds again.
   */
  private readonly unreachableChannels = new Set<string>();

  /**
   * Every in-place edit of a stored panel goes through here: per message,
   * identical payloads are skipped, automatic edits are coalesced, one edit is
   * in flight at a time, and a 30046 pauses the panel's edits. See
   * {@link editPanel}.
   */
  private readonly edits: EditPipeline<PanelEditPayload>;
  /** Whether automatic edits wait out a debounce (`editDebounceMs` > 0). */
  private readonly debounceEdits: boolean;
  /** When a 30046 last rebuilt every panel (epoch ms), for the once-an-hour guard. */
  private lastCapRebuildAt?: number;
  /** True from a 30046 that triggered a rebuild until that rebuild has run. */
  private capRebuildPending = false;

  constructor(options: DiscordAdapterOptions) {
    this.core = options.core;
    this.token = options.token;
    this.applicationId = options.applicationId;
    this.guildId = options.guildId;
    this.log = options.logger ?? noopLogger;
    this.panelStore = options.panelStore ?? new NoopPanelStore();
    this.clientFactory = options.clientFactory ?? ((opts) => new Client(opts));
    this.now = options.now ?? (() => new Date());
    this.onPostError = options.onPostError ?? (() => {});
    this.botAvatar = options.botAvatar;
    this.timers = options.timers ?? {
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.statusRefreshIntervalMs = options.statusRefreshIntervalMs ?? 60_000;
    this.debounceEdits = (options.editDebounceMs ?? EDIT_DEBOUNCE_MS) > 0;
    this.edits = new EditPipeline<PanelEditPayload>({
      send: (messageId, payload) =>
        this.editMessage(this.core.getConfig().controlChannelId, messageId, payload),
      fingerprint: panelFingerprint,
      timers: this.timers,
      debounceMs: options.editDebounceMs ?? EDIT_DEBOUNCE_MS,
      replaceOnCap: (messageId) => this.rebuildOnEditCap(messageId),
      onCapped: (messageId, backoffMs) => {
        this.log.error(
          { messageId, code: DISCORD_EDIT_CAP, pauseMinutes: Math.round(backoffMs / 60_000) },
          "discord edit cap reached (30046): pausing this panel's edits, not retrying",
        );
        this.reportEditCap({ panelsRebuilt: false });
      },
    });
    this.stateLock = new StateLockMachine({
      timeoutMs: this.core.stateLockTimeoutMs,
      timers: this.timers,
      onTimeout: (key, result) => {
        void this.onLockTimeout(key, result);
      },
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Log in, register the two bootstrap slash commands, wire interaction +
   * domain-event handlers, and (on ready) reconstruct panels from stored ids.
   */
  async start(): Promise<void> {
    if (this.started) return;

    const client = this.clientFactory({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    });
    this.client = client;

    // start() does not resolve until the gateway is ready and the first reconcile
    // (onReady → reconstructPanels) has run. The coordinator connects paired servers
    // immediately after start() returns; if we returned at login() — when the socket
    // is up but the guild/channel cache is still cold — that first status post/audit
    // would race the cache and fail (empty fetch, or a 50001 "Missing Access" send),
    // leaving panels blank until a manual restart. Awaiting ready closes that window.
    let cancelReadyWait = (): void => {};
    const ready = new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.timers.clearTimer(timer);
        resolve();
      };
      cancelReadyWait = done;
      client.once(Events.ClientReady, () => {
        void this.applyDefaultAvatar(client);
        this.onReady()
          .catch((err) => this.log.error({ err }, "onReady failed"))
          .finally(done);
      });
      // Safety net: never let a missing/delayed ClientReady wedge startup. The
      // once() handler above still fires (and reconciles) if ready arrives later.
      // `done` references `timer` only via its closure, invoked after assignment.
      const timer = this.timers.setTimer(() => {
        this.log.warn({ ms: this.readyTimeoutMs }, "discord ready timed out; continuing");
        done();
      }, this.readyTimeoutMs);
    });
    client.on(Events.InteractionCreate, (interaction: Interaction) => {
      void this.onInteraction(interaction);
    });

    this.wireDomainEvents();

    try {
      await client.login(this.token);
    } catch (err) {
      // A failed login leaves nothing running. Undo the wiring above so this
      // adapter does not go on reacting to bot-core events with no gateway, and
      // disarm the ready-timeout safety net.
      this.unwireDomainEvents();
      cancelReadyWait();
      this.client = undefined;
      throw err;
    }
    await ready;
    this.started = true;
    this.log.info({}, "discord adapter started");
  }

  /**
   * Give a bot that has no avatar the default picture
   * ({@link DiscordAdapterOptions.botAvatar}). Discord rate-limits avatar
   * changes, so this only ever runs while the avatar is unset: once set, later
   * starts skip it. Best-effort: a failure is logged, never thrown.
   */
  private async applyDefaultAvatar(client: Client): Promise<void> {
    const user = client.user;
    if (!this.botAvatar || !user || user.avatar !== null) return;
    try {
      const image = await this.botAvatar();
      if (!image) return;
      await user.setAvatar(Buffer.from(image));
      this.log.info({ userId: user.id }, "discord: set the bot's avatar to the Conduit mark");
    } catch (err) {
      this.log.warn({ err }, "discord: setting the bot's avatar failed");
    }
  }

  /**
   * Destroy the client, detach from bot-core, and clear state. After this the
   * adapter is inert — bot-core events reach nothing — until `start()` runs again.
   */
  async stop(): Promise<void> {
    // Detach first: an event arriving while the client is being destroyed must
    // not start new Discord IO.
    this.unwireDomainEvents();
    this.stopStatusRefresh();
    for (const key of [...this.upkeepChecks.keys(), ...this.upkeepReads.keys()]) {
      this.clearUpkeepTimers(key);
    }
    for (const { handle } of this.cameraCooldowns.values()) this.timers.clearTimer(handle);
    this.cameraCooldowns.clear();
    this.edits.clear();
    this.panelIds.clear();
    if (this.client) {
      await this.client.destroy();
      this.client = undefined;
    }
    this.started = false;
    this.log.info({}, "discord adapter stopped");
  }

  /**
   * Delete every tracked panel message this bot posted (each server's Conduit
   * Panel, and any old per-device panels not yet migrated), reading the stored
   * message ids off the live domain objects. Best-effort: a message that's
   * already gone is counted as a no-op. Used by the desktop "Reset
   * configuration" action, which runs this BEFORE wiping local state (the client
   * must still be logged in). Returns the number of messages successfully deleted.
   */
  async deleteAllPanels(): Promise<number> {
    return this.withPanelQueue(async () => {
      const channelId = this.core.getConfig().controlChannelId;
      if (!channelId) {
        this.log.warn({}, "no control channel; nothing to delete");
        return 0;
      }
      let deleted = 0;
      for (const server of this.core.listServers()) {
        for (const id of this.trackedPanelIds(server)) {
          if ((await this.deleteMessage(channelId, id)) === "ok") deleted++;
        }
      }
      this.log.info({ deleted }, "deleted all tracked panels");
      return deleted;
    });
  }

  /**
   * Run a panel-changing operation (anything that posts, deletes or re-lays out
   * persistent panels, and so reads and writes stored panel ids) after every
   * one already queued for the control channel. Without this, two
   * overlapping reposts read the same stored ids, both post, and the messages
   * written first are orphaned.
   *
   * Not reentrant: `task` must call only the unqueued bodies
   * (`…Unqueued`), never a queued entry point. If the control channel changed
   * while the task waited, it is queued again behind the new channel's work,
   * since every body acts on the channel configured when it runs.
   */
  private async withPanelQueue<T>(task: () => Promise<T>): Promise<T> {
    const channelKey = () => this.core.getConfig().controlChannelId ?? "";
    for (;;) {
      const key = channelKey();
      const outcome = await this.panelQueue.run(key, async () =>
        channelKey() === key
          ? { ran: true as const, value: await task() }
          : { ran: false as const },
      );
      if (outcome.ran) return outcome.value;
    }
  }

  /** The two bootstrap slash commands: nothing else is registered. */
  private buildSlashCommands(): unknown[] {
    return [
      new SlashCommandBuilder()
        .setName("conduit")
        .setDescription("Conduit control")
        .addSubcommand((s) => s.setName("setup").setDescription("Open the Setup hub (admin)"))
        .addSubcommand((s) => s.setName("status").setDescription("Quick status + jump links"))
        .toJSON(),
    ];
  }

  /** Register slash commands via the REST API (guild-scoped when known). */
  private async registerCommands(): Promise<void> {
    // The application/guild ids are collected in the desktop bootstrap wizard and
    // persisted to AppConfig; the constructor options only override them (tests,
    // or a host forwarding env vars). Prefer the explicit option, fall back to config.
    const config = this.core.getConfig();
    const applicationId = this.applicationId ?? config.discordAppId;
    if (!applicationId) {
      this.log.warn({}, "no applicationId; skipping slash-command registration");
      return;
    }
    const rest = new REST({ version: "10" }).setToken(this.token);
    const guildId = this.guildId ?? config.discordGuildId;
    const body = this.buildSlashCommands();
    try {
      if (guildId) {
        await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
      } else {
        await rest.put(Routes.applicationCommands(applicationId), { body });
      }
    } catch (err) {
      this.log.error({ err }, "slash-command registration failed");
    }
  }

  /**
   * On ready: register commands and reconstruct panels from stored message ids
   * (rebuild-from-stored-ids; reconcile against the control channel). Public so
   * it can be exercised in tests without a live gateway.
   */
  async onReady(): Promise<void> {
    await this.registerCommands();
    await this.adoptConduitRoles(this.guildId ?? this.core.getConfig().discordGuildId, "ready");
    await this.reconstructPanels();
    this.startStatusRefresh();
    this.log.info({}, "discord adapter ready; panels reconstructed");
  }

  // ── panel reconstruction ─────────────────────────────────────────────────────

  /**
   * Rebuild every server's Conduit Panel from its stored message ids.
   * Each stored message is edited in place, forced, which is also how the
   * reconcile learns it still exists. A server whose panel is incomplete (never
   * posted, a message gone, or a device type new since) has its whole group
   * posted afresh, in order. Old per-device, status and team panels from
   * earlier builds are deleted first (the one-time migration). Registers entity
   * interest so the broadcasts that close a switch's state lock arrive.
   *
   * Only Discord's 10008 Unknown Message counts as "gone". Any other failure
   * keeps the stored id, so a transient error never orphans a panel.
   * Afterwards, untracked Conduit panels are swept from the control channel.
   * Runs in the panel queue.
   *
   * Returns a reconciliation report (also handy for tests): which messages
   * were edited or posted, which could not be posted, which ids were kept after
   * an edit failed for another reason, how many old panels were migrated, and
   * how many orphaned panels were swept.
   */
  async reconstructPanels(): Promise<ReconcileReport> {
    return this.withPanelQueue(() => this.reconstructPanelsUnqueued());
  }

  /** {@link reconstructPanels} without the queue; call only from inside it. */
  private async reconstructPanelsUnqueued(): Promise<ReconcileReport> {
    const report = emptyReport();
    const channelId = this.core.getConfig().controlChannelId;

    // The Setup hub and settings panels are ephemeral (rendered per
    // invocation), so they are not reconstructed here.
    for (const server of this.core.listServers()) {
      this.handles.register(server.id);
      // Re-register interest so broadcasts (and state-lock closure) resume.
      for (const entity of this.core.listEntities(server.id)) {
        await this.registerInterestAndSeed(entity, "rebuild");
      }
      // Render the real connection state: the adapter may start (and reconcile)
      // after a server is already connected, so the connect event has come and
      // gone. No game clock: only a manual Refresh shows it.
      await this.fetchServerData(server.id, { clock: false });
      mergeReport(report, await this.syncGroupUnqueued(server.id, { verify: true }));
    }

    const swept = await this.sweepOrphanedPanels(channelId, report.edited);
    this.log.info(
      {
        edited: report.edited.length,
        missing: report.missing.length,
        kept: report.kept.length,
        migrated: report.migrated,
        swept,
      },
      "panel reconstruction reconciled",
    );
    return { ...report, swept };
  }

  /**
   * Every panel message id tracked for a server: its Conduit Panel, plus old
   * per-device, status and team panels not yet migrated.
   */
  private trackedPanelIds(server: PairedServer): string[] {
    const ids = panelIdList(this.idsFor(server));
    if (server.statusPanelMessageId) ids.push(server.statusPanelMessageId);
    if (server.teamPanelMessageId) ids.push(server.teamPanelMessageId);
    for (const entity of this.core.listEntities(server.id)) {
      if (entity.panelMessageId) ids.push(entity.panelMessageId);
    }
    return ids;
  }

  /**
   * Delete orphaned Conduit panels from the control channel: among its
   * latest {@link SWEEP_MESSAGE_LIMIT} messages, those this bot wrote that carry
   * Conduit custom IDs but whose id no panel tracks any more (lost to a failed
   * edit, overlapping reposts, an older build, or a crash between posting and
   * persisting). Other authors' messages and the bot's plain-text lines are never
   * touched, and only the control channel is read, never the logging channel.
   * `justPosted` adds ids posted by the caller, in case a panel store has not yet
   * reflected them. Best-effort: returns the number deleted.
   */
  private async sweepOrphanedPanels(
    channelId: string | undefined,
    justPosted: readonly string[],
  ): Promise<number> {
    const botId = this.client?.user?.id;
    if (!channelId || !botId) return 0;
    const tracked = new Set(justPosted);
    for (const server of this.core.listServers()) {
      for (const id of this.trackedPanelIds(server)) tracked.add(id);
    }

    let recent: ChannelMessage[];
    try {
      const channel = await this.lookupTextChannel(channelId);
      if (!channel) return 0;
      recent = [...(await channel.messages.fetch({ limit: SWEEP_MESSAGE_LIMIT })).values()];
    } catch (err) {
      this.log.warn({ err, channelId }, "panel sweep: reading the control channel failed");
      return 0;
    }

    let swept = 0;
    for (const message of recent) {
      if (message.author?.id !== botId) continue;
      if (tracked.has(message.id)) continue;
      if (!hasConduitCustomId(message.components)) continue;
      try {
        await message.delete();
        swept++;
      } catch (err) {
        // 10008: someone deleted it in the meantime, which is what we wanted.
        if (panelErrorOutcome(err) !== "gone") {
          this.log.warn({ err, channelId, messageId: message.id }, "panel sweep: delete failed");
        }
      }
    }
    this.log.info({ channelId, swept, scanned: recent.length }, "swept orphaned panels");
    return swept;
  }

  /**
   * Register bot-core interest in a device — the `getEntityInfo` after which the
   * server broadcasts its changes — and record what the server reported: a
   * switch's state seeds its lock, an alarm's says whether it is sounding, a
   * monitor's is its contents. Runs when a device is paired and when the panel
   * is rebuilt. Cameras are skipped: they are addressed by identifier and have
   * no broadcastable entity.
   *
   * Best-effort: on failure (server offline, entity gone) the switch simply stays
   * *unknown* in the lock rather than being assigned a guessed state.
   */
  private async registerInterestAndSeed(
    entity: PairedEntity,
    occasion: "rebuild" | "pairing" | "pairing retry",
  ): Promise<void> {
    if (entity.entityType === "camera") return;
    const { serverId, entityId } = entity;
    try {
      const info = await this.core.registerEntityInterest(serverId, entityId);
      if (entity.entityType === "switch") {
        this.stateLock.seed({ serverId, entityId }, info.value ?? false);
      } else if (entity.entityType === "alarm") {
        this.alarmFiring.set(HandleRegistry.entityKey(serverId, entityId), info.value ?? false);
      } else if (entity.entityType === "storageMonitor") {
        await this.updateMonitor(serverId, entityId, info, true);
      }
    } catch (err) {
      // Seen live: a storage monitor answered not_found right at pairing, then
      // worked after a restart; the server had not finished setting it up. A
      // not_found also drops the device from re-subscription, so retry once.
      if (occasion === "pairing" && (err as { name?: unknown })?.name === "EntityNotFoundError") {
        this.timers.setTimer(() => {
          const current = this.core.listEntities(serverId).find((e) => e.entityId === entityId);
          if (current) void this.registerInterestAndSeed(current, "pairing retry");
        }, PAIRING_INTEREST_RETRY_MS);
      }
      // At startup the panels are rebuilt before the server has connected; its
      // connect re-subscribes every device and refreshes the panels anyway.
      const notYetConnected = (err as { name?: unknown })?.name === "StateError";
      const level = notYetConnected ? "debug" : "warn";
      this.log[level]({ err, serverId, entityId }, `registerEntityInterest on ${occasion} failed`);
    }
  }

  /** Operator-facing label for a device; also the alphabetical sort key. */
  private entityLabel(entity: PairedEntity): string {
    return entity.label ?? `${entity.entityType} ${entity.entityId}`;
  }

  /**
   * A server's entities in display order: alphabetical by label (case-
   * insensitive, numeric-aware), with entityId as a stable tiebreak. This is the
   * order of the rows within each type's message.
   */
  private sortedEntities(serverId: string): PairedEntity[] {
    return [...this.core.listEntities(serverId)].sort((a, b) => {
      const byLabel = compareLabels(this.entityLabel(a), this.entityLabel(b));
      return byLabel !== 0 ? byLabel : a.entityId - b.entityId;
    });
  }

  /**
   * A switch as a row or a group member shows it: its handle, label, auto-revert
   * and what its state lock holds. No lock entry yet means the server has not
   * reported it: unknown, never a guessed "off".
   */
  private switchMember(entity: PairedEntity): SwitchGroupMember {
    const { serverId, entityId } = entity;
    return {
      entityHandle: this.handles.register(HandleRegistry.entityKey(serverId, entityId)),
      label: this.entityLabel(entity),
      lock: this.stateLock.snapshot({ serverId, entityId }) ?? {
        phase: "synced",
        buttonsDisabled: false,
      },
      autoAction: entity.autoAction,
      autoDelaySeconds: entity.autoActionDelaySeconds,
    };
  }

  /** A switch group's members, in the group's order. */
  private groupMembers(serverId: string, group: SwitchGroup): SwitchGroupMember[] {
    const entities = this.core.listEntities(serverId);
    return group.entityIds.flatMap((entityId) => {
      const entity = entities.find((e) => e.entityId === entityId);
      return entity?.entityType === "switch" ? [this.switchMember(entity)] : [];
    });
  }

  /** Whether a storage monitor's changes are announced (its Watch flag). */
  private isWatched(entity: PairedEntity): boolean {
    return (
      this.watchOverride.get(HandleRegistry.entityKey(entity.serverId, entity.entityId)) ??
      entity.watchChanges ??
      false
    );
  }

  // ── the Conduit Panel: one message per device type ──────────────────────────

  /** A server's Conduit Panel message ids: as last written here, else as bot-core stores them. */
  private idsFor(server: PairedServer): ServerPanelIds | undefined {
    return this.panelIds.get(server.id) ?? server.panelMessageIds;
  }

  /** Remember and persist a server's Conduit Panel message ids. */
  private async storePanelIds(serverId: string, ids: ServerPanelIds): Promise<void> {
    this.panelIds.set(serverId, ids);
    await this.panelStore.setServerPanelIds(serverId, ids);
  }

  /**
   * Everything a server's Conduit Panel shows, from bot-core and what this
   * adapter has heard: the state lock, monitor contents, alarm state, and the
   * last players/queue and team.
   */
  private layoutState(server: PairedServer, extras: ServerExtras = {}): ServerLayoutState {
    const serverId = server.id;
    const { status, lastSeenAt } = this.core.getServerStatus(serverId);
    const pushoverConfigured = this.core.isPushoverConfigured();
    const switches: SwitchesRow[] = [];
    const alarms: AlarmRowState[] = [];
    const monitors: MonitorRowState[] = [];
    const cameras: CameraRowState[] = [];
    // A grouped switch has no row of its own: its group's row stands for it.
    const groups = this.core.listSwitchGroups(serverId);
    const grouped = new Set(groups.flatMap((g) => g.entityIds));
    for (const entity of this.sortedEntities(serverId)) {
      const key = HandleRegistry.entityKey(serverId, entity.entityId);
      const entityHandle = this.handles.register(key);
      const label = this.entityLabel(entity);
      switch (entity.entityType) {
        case "switch":
          if (grouped.has(entity.entityId)) break;
          switches.push({ kind: "switch", ...this.switchMember(entity) });
          break;
        case "alarm":
          alarms.push({
            entityHandle,
            label,
            firing: this.alarmFiring.get(key) ?? false,
            // Paging is live only when credentials exist AND the alarm opted in.
            paging: pushoverConfigured && entity.pushoverSeverity != null,
          });
          break;
        case "storageMonitor":
          monitors.push({
            entityHandle,
            label,
            info: this.monitorInfo.get(key),
            watch: this.isWatched(entity),
          });
          break;
        case "camera":
          cameras.push({
            entityHandle,
            label,
            cooldownUntil: this.cameraCooldowns.get(key)?.until,
          });
          break;
      }
    }
    for (const group of groups) {
      const members = this.groupMembers(serverId, group);
      if (members.length === 0) continue;
      switches.push({
        kind: "group",
        groupHandle: this.handles.register(HandleRegistry.groupKey(serverId, group.id)),
        label: group.name,
        members,
      });
    }
    // Groups take their place among the switches, by name.
    switches.sort((a, b) => compareLabels(a.label, b.label));
    return {
      serverHandle: this.handles.register(serverId),
      name: server.name,
      status,
      lastSeenAt,
      info: this.lastServerInfo.get(serverId),
      team: this.lastTeam.get(serverId),
      connectedSteamId: server.playerId,
      statusNote: this.statusNotes.get(serverId),
      timeLabel: extras.timeLabel,
      refreshing: extras.refreshing,
      switches,
      alarms,
      monitors,
      cameras,
    };
  }

  /**
   * Edit a server's posted messages of the given kinds to show the current
   * state, through the edit pipeline. Posts nothing: a message that has
   * no stored id yet is skipped (the next layout change posts it). `immediate`
   * for a render a member is watching; `force` to send an unchanged payload.
   */
  private async renderPanels(
    serverId: string,
    kinds: readonly PanelKind[],
    options: SubmitOptions & { extras?: ServerExtras } = {},
  ): Promise<void> {
    // An open switch group panel shows the same switches.
    if (kinds.includes("switches")) void this.refreshGroupViews(serverId);
    const server = this.core.listServers().find((s) => s.id === serverId);
    if (!server) return;
    const ids = this.idsFor(server);
    if (!ids) return;
    const { extras, ...submit } = options;
    for (const message of layoutServer(this.layoutState(server, extras))) {
      if (!kinds.includes(message.kind)) continue;
      const id = slotId(ids, message.kind, message.page);
      if (id) await this.editPanel(id, message.payload, submit);
    }
  }

  /**
   * Make a server's posted Conduit Panel match its layout, as one queued
   * operation (a device paired, renamed or removed). See
   * {@link syncGroupUnqueued}.
   */
  private async syncGroup(serverId: string): Promise<void> {
    await this.withPanelQueue(() => this.syncGroupUnqueued(serverId));
  }

  /**
   * Make a server's posted Conduit Panel match its layout. Discord cannot
   * insert or reorder messages, so when the layout needs a message that has no
   * stored id (the first device of a type, a new page, or a message that is
   * gone) the whole group is reposted, in order. Otherwise messages no longer
   * needed are deleted and the rest edited in place, which keeps their order.
   * `verify` forces each edit (the reconcile, which edits to learn whether each
   * message still exists). Old per-device panels are migrated first. Call only
   * from inside the panel queue.
   */
  private async syncGroupUnqueued(
    serverId: string,
    opts: { verify?: boolean } = {},
  ): Promise<GroupReport> {
    const report = emptyReport();
    const server = this.core.listServers().find((s) => s.id === serverId);
    if (!server) return report;
    const channelId = this.core.getConfig().controlChannelId;
    if (!channelId) {
      this.log.warn({ serverId }, "no control channel; cannot lay out the panel");
      return report;
    }
    report.migrated = await this.migrateLegacyPanelsUnqueued(server, channelId);
    // A layout change (a device or group added, renamed or removed) can change
    // what an open switch group panel shows too.
    void this.refreshGroupViews(serverId);

    const messages = layoutServer(this.layoutState(server));
    const stored = this.idsFor(server) ?? {};
    let repost = messages.some((m) => !slotId(stored, m.kind, m.page));
    if (!repost) {
      // A type whose last device went, or a page that emptied: delete its
      // message. Removing messages keeps the others in order. A delete that
      // fails leaves an orphan for the sweep, never a stale tracked id.
      const keep = idsForLayout(stored, messages);
      const kept = new Set(panelIdList(keep));
      const extra = panelIdList(stored).filter((id) => !kept.has(id));
      for (const id of extra) await this.deleteMessage(channelId, id);
      if (extra.length > 0) {
        await this.storePanelIds(serverId, keep);
        this.log.info(
          { serverId, deleted: extra.length },
          "panel: removed messages no longer needed",
        );
      }
      for (const message of messages) {
        const id = slotId(keep, message.kind, message.page)!;
        const outcome = await this.editPanel(id, message.payload, {
          immediate: true,
          force: opts.verify,
        });
        if (outcome === "gone") {
          // Someone deleted it: repost the group so the order holds.
          repost = true;
          break;
        }
        if (outcome === "ok" || outcome === "skipped" || outcome === "deferred") {
          report.edited.push(id);
        } else {
          // Not known to be gone: keep the id and let the next render retry,
          // rather than post a second message beside one that may still be there.
          report.kept.push(id);
        }
      }
    }
    if (repost) {
      const posted = await this.repostGroupUnqueued(server, channelId, messages);
      return { ...posted, migrated: report.migrated };
    }
    return report;
  }

  /**
   * Delete a server's posted Conduit Panel and post it afresh, in order, back to
   * back so Discord shows the group under one author header, then persist the
   * new ids. Stops at the first message that cannot be posted (the channel is
   * likely unreachable), so the stored pages never have a gap; the next layout
   * change tries again. Call only from inside the panel queue.
   */
  private async repostGroupUnqueued(
    server: PairedServer,
    channelId: string,
    messages: readonly PanelMessage[] = layoutServer(this.layoutState(server)),
  ): Promise<GroupReport> {
    const report = emptyReport();
    for (const id of panelIdList(this.idsFor(server))) {
      await this.deleteMessage(channelId, id);
    }
    const next: ServerPanelIds = {};
    for (const [i, message] of messages.entries()) {
      const ref = await this.postMessage(message.payload);
      if (!ref) {
        for (const m of messages.slice(i))
          report.missing.push({ kind: m.kind, serverId: server.id });
        break;
      }
      setSlot(next, message.kind, message.page, ref.messageId);
      report.edited.push(ref.messageId);
    }
    await this.storePanelIds(server.id, next);
    this.log.info(
      { serverId: server.id, posted: report.edited.length, missing: report.missing.length },
      "panel: posted the server's Conduit Panel",
    );
    return report;
  }

  /**
   * The one-time Conduit Panel migration: delete a server's old per-device panels and
   * its old status and team panels, and clear their stored ids. An id whose
   * message could not be deleted (anything but done or 10008) is kept, to try
   * again next time. Returns how many were deleted or already gone.
   */
  private async migrateLegacyPanelsUnqueued(
    server: PairedServer,
    channelId: string,
  ): Promise<number> {
    const done = (outcome: PanelWriteOutcome) => outcome === "ok" || outcome === "gone";
    const legacy: { status?: boolean; team?: boolean; entityIds: number[] } = { entityIds: [] };
    let migrated = 0;
    if (server.statusPanelMessageId) {
      legacy.status = done(await this.deleteMessage(channelId, server.statusPanelMessageId));
      if (legacy.status) migrated++;
    }
    if (server.teamPanelMessageId) {
      legacy.team = done(await this.deleteMessage(channelId, server.teamPanelMessageId));
      if (legacy.team) migrated++;
    }
    let found = Boolean(server.statusPanelMessageId || server.teamPanelMessageId);
    for (const entity of this.core.listEntities(server.id)) {
      if (!entity.panelMessageId) continue;
      found = true;
      if (done(await this.deleteMessage(channelId, entity.panelMessageId))) {
        legacy.entityIds.push(entity.entityId);
        migrated++;
      }
    }
    if (!found) return 0;
    if (legacy.status || legacy.team || legacy.entityIds.length > 0) {
      await this.panelStore.clearLegacyPanelIds(server.id, legacy);
    }
    this.log.info({ serverId: server.id, migrated }, "panel: deleted the old per-device panels");
    return migrated;
  }

  /**
   * Repost every server's Conduit Panel, in order, as one queued operation
   * (Setup → Rebuild panels, choosing the control channel, and a 30046), then
   * sweep orphans.
   */
  private async repostAllPanels(): Promise<void> {
    await this.withPanelQueue(() => this.repostAllPanelsUnqueued());
  }

  /** The body of {@link repostAllPanels}. Call only from inside the panel queue. */
  private async repostAllPanelsUnqueued(): Promise<void> {
    const channelId = this.core.getConfig().controlChannelId;
    if (!channelId) {
      this.log.warn({}, "no control channel; cannot post panels");
      return;
    }
    const posted: string[] = [];
    for (const server of this.core.listServers()) {
      this.handles.register(server.id);
      for (const entity of this.core.listEntities(server.id)) {
        await this.registerInterestAndSeed(entity, "rebuild");
      }
      await this.fetchServerData(server.id, { clock: false });
      await this.migrateLegacyPanelsUnqueued(server, channelId);
      posted.push(...(await this.repostGroupUnqueued(server, channelId)).edited);
    }
    await this.sweepOrphanedPanels(channelId, posted);
  }

  /**
   * The edit pipeline's question on a 30046: replace the refused panel
   * rather than pause it? Discord caps edits only to messages older than an
   * hour, so a freshly posted panel takes edits again. Every panel is rebuilt,
   * not just the refused one, because Discord cannot insert a message
   * mid-channel and the order would break.
   *
   * At most one automatic rebuild per {@link EDIT_CAP_REBUILD_INTERVAL_MS}: a
   * 30046 sooner than that answers no, and the pipeline pauses the panel, so a
   * refusal that a rebuild does not cure cannot loop. A 30046 while a rebuild
   * is already on its way answers yes: that rebuild replaces the panel too.
   *
   * Called from inside the pipeline's send, which may itself run inside a
   * queued panel task, so the rebuild is queued and never awaited here.
   */
  private rebuildOnEditCap(messageId: string): boolean {
    if (this.capRebuildPending) {
      this.log.debug({ messageId }, "discord edit cap (30046) on a panel a rebuild will replace");
      return true;
    }
    const now = this.now().getTime();
    if (
      this.lastCapRebuildAt !== undefined &&
      now - this.lastCapRebuildAt < EDIT_CAP_REBUILD_INTERVAL_MS
    ) {
      return false;
    }
    this.lastCapRebuildAt = now;
    this.capRebuildPending = true;
    this.log.info(
      { messageId, code: DISCORD_EDIT_CAP },
      "discord edit cap reached (30046): rebuilding every panel",
    );
    this.reportEditCap({ panelsRebuilt: true });
    void this.rebuildPanelsAfterEditCap(messageId);
    return true;
  }

  /**
   * Rebuild every panel after a 30046, queued behind whatever panel work is
   * already running. Edits still waiting for the old messages are dropped
   * first: the rebuild renders from current state. Never rejects.
   */
  private async rebuildPanelsAfterEditCap(messageId: string): Promise<void> {
    try {
      await this.withPanelQueue(async () => {
        if (!this.started) return;
        this.edits.clear();
        await this.repostAllPanelsUnqueued();
      });
    } catch (err) {
      this.log.error({ err, messageId }, "panel rebuild after the edit cap failed");
    } finally {
      this.capRebuildPending = false;
    }
  }

  /** Tell the host Discord refused a panel edit with 30046, and what the adapter did. */
  private reportEditCap(outcome: { panelsRebuilt: boolean }): void {
    this.onPostError({
      channelId: this.core.getConfig().controlChannelId ?? "",
      code: DISCORD_EDIT_CAP,
      message: "Maximum number of edits to messages older than 1 hour reached",
      permission: false,
      editCap: true,
      ...(outcome.panelsRebuilt ? { panelsRebuilt: true } : {}),
    });
  }

  // ── interaction dispatch ─────────────────────────────────────────────────────

  /**
   * The gateway interaction listener. This is the trust boundary for every
   * Discord interaction, so it fails closed: any error escaping a handler is
   * logged and swallowed here rather than becoming an unhandled rejection that
   * could crash the process.
   */
  async onInteraction(interaction: Interaction): Promise<void> {
    try {
      await this.routeInteraction(interaction);
    } catch (err) {
      this.log.error({ err }, "interaction handling failed");
    }
  }

  /** Adapt a real discord.js interaction into the dispatcher's shape, then route. */
  private async routeInteraction(interaction: Interaction): Promise<void> {
    // Slash commands first.
    if (interaction.isChatInputCommand()) {
      await this.handleSlashCommand(interaction);
      return;
    }
    if (
      !interaction.isButton() &&
      !interaction.isChannelSelectMenu() &&
      !interaction.isRoleSelectMenu() &&
      !interaction.isStringSelectMenu() &&
      !interaction.isModalSubmit()
    ) {
      return;
    }

    if (interaction.isModalSubmit()) {
      await this.handleModalSubmit(interaction);
      return;
    }

    const roleIds = this.extractRoleIds(interaction);
    const values =
      interaction.isChannelSelectMenu() ||
      interaction.isRoleSelectMenu() ||
      interaction.isStringSelectMenu()
        ? interaction.values
        : undefined;

    const dispatchable: DispatchableInteraction = {
      customId: interaction.customId,
      memberRoleIds: roleIds,
      userId: interaction.user?.id,
      userName: interaction.user?.username,
      isAdministrator: this.isGuildAdministrator(interaction),
      values,
      isButton: () => interaction.isButton(),
      isChannelSelectMenu: () => interaction.isChannelSelectMenu(),
      isRoleSelectMenu: () => interaction.isRoleSelectMenu(),
      isStringSelectMenu: () => interaction.isStringSelectMenu(),
      replyEphemeral: async (content: string) => {
        // A handler may have already deferred/replied (e.g. a switch toggle
        // calls deferUpdate before the actuation that then throws). Replying
        // again would raise InteractionAlreadyReplied — follow up instead.
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      },
      replyEphemeralPanel: async (payload: EphemeralPanelPayload) => {
        // Components V2 panel, ephemeral: only the invoking member sees it.
        const alreadyAcked = interaction.replied || interaction.deferred;
        await (
          interaction as unknown as {
            reply(o: unknown): Promise<void>;
            followUp(o: unknown): Promise<unknown>;
          }
        )[alreadyAcked ? "followUp" : "reply"]({
          components: payload.components,
          flags: payload.flags | MessageFlags.Ephemeral,
          ...(payload.files?.length ? { files: payload.files } : {}),
        });
        const webhook = interaction as unknown as {
          editReply(o: unknown): Promise<unknown>;
          deleteReply(): Promise<unknown>;
        };
        return {
          editPanel: async (p: PanelPayload) => {
            await webhook.editReply({ components: p.components, flags: p.flags });
          },
          delete: async () => {
            await webhook.deleteReply();
          },
        };
      },
      showModal: async (modal: unknown) => {
        // discord.js types the arg; the dispatcher passes a ModalBuilder/JSON.
        await (
          interaction as unknown as {
            showModal(m: unknown): Promise<void>;
          }
        ).showModal(modal);
      },
      deferUpdate: async () => {
        await (
          interaction as unknown as {
            deferUpdate(): Promise<void>;
          }
        ).deferUpdate();
      },
      update: async (payload: unknown) => {
        // Buttons/select menus expose update(); editing the source message both
        // acknowledges the interaction and re-renders it in one call.
        await (
          interaction as unknown as {
            update(p: unknown): Promise<void>;
          }
        ).update(payload);
      },
      editReply: async (payload: unknown) => {
        // After deferUpdate, editReply edits the message the component sits on.
        await (
          interaction as unknown as {
            editReply(p: unknown): Promise<unknown>;
          }
        ).editReply(payload);
      },
    };

    await this.dispatch(dispatchable);
  }

  /**
   * The single component dispatcher. Parses the customId, enforces the per-click
   * permission check BEFORE any bot-core call, then routes to the right handler.
   * Pure enough to unit-test with a mocked {@link DispatchableInteraction}.
   */
  async dispatch(interaction: DispatchableInteraction): Promise<DispatchOutcome> {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) {
      return { handled: false, allowed: false };
    }

    // ── per-click permission check — before anything actuates ──
    const required = requiredCapabilityFor(parsed.domain, parsed.action);
    const config = this.core.getConfig();
    const allowed =
      isAllowed(interaction.memberRoleIds, config.roleCapabilities, required) ||
      (Boolean(interaction.isAdministrator) && ADMIN_BYPASS_DOMAINS.has(parsed.domain));
    if (!allowed) {
      const hasAnyRole = isAllowed(interaction.memberRoleIds, config.roleCapabilities, "user");
      // Diagnostic: a denial here is the "You need an admin role" path. Logging
      // the inputs makes it obvious whether the bypass should have fired (e.g. an
      // owner/admin whose isAdministrator came back false).
      this.log.info(
        {
          domain: parsed.domain,
          action: parsed.action,
          required,
          memberRoleIds: interaction.memberRoleIds,
          isAdministrator: Boolean(interaction.isAdministrator),
          adminBypassDomain: ADMIN_BYPASS_DOMAINS.has(parsed.domain),
        },
        "interaction denied",
      );
      await interaction.replyEphemeral(
        hasAnyRole || required === "admin" ? DENIAL_MESSAGE : NO_ROLE_MESSAGE,
      );
      void this.writeAudit(
        auditDenied({
          time: this.now(),
          userId: interaction.userId,
          userName: interaction.userName,
          domain: parsed.domain,
          action: parsed.action,
        }),
      );
      return { handled: true, allowed: false, parsed };
    }

    // Audit the (permitted) intent before routing, so even a failed actuation is
    // recorded. The confirming entityChanged event logs the resulting state too.
    void this.writeAudit(this.auditInteractionLine(parsed, interaction));

    let outcome: "ok" | "failed" = "ok";
    try {
      await this.route(parsed, interaction);
    } catch (err) {
      this.log.error({ err, customId: interaction.customId }, "dispatch failed");
      await this.replyFailure(interaction, err);
    }
    if (this.failedInteractions.has(interaction)) outcome = "failed";
    this.log.info(
      this.interactionLogFields(parsed, interaction.userId, outcome),
      "interaction handled",
    );
    return { handled: true, allowed: true, parsed };
  }

  /**
   * The ids for an "interaction handled" log line: domain, action, the server
   * and entity it addressed (resolved from the custom ID's handles), who
   * clicked, and the outcome. Discord and entity ids only; never input text.
   */
  private interactionLogFields(
    parsed: ParsedCustomId,
    userId: string | undefined,
    outcome: string,
  ): Record<string, unknown> {
    const ids = parsed.entity ? this.resolveEntity(parsed) : undefined;
    const group = parsed.domain === "group" ? this.resolveGroup(parsed) : undefined;
    return {
      domain: parsed.domain,
      action: parsed.action,
      serverId: ids?.serverId ?? group?.serverId,
      entityId: ids?.entityId,
      ...(group ? { groupId: group.group.id } : {}),
      userId,
      outcome,
    };
  }

  /**
   * Tell the member an action failed, as friendly ephemeral copy. Safe to call
   * whether or not the interaction was already acknowledged: `replyEphemeral`
   * replies or follows up as appropriate. The send itself can fail (e.g. the
   * interaction token expired); that is logged, never thrown, so it cannot
   * surface as a second error on top of the one being reported. `context`, when
   * given, goes on a line above the friendly copy (a group's partial failure).
   */
  private async replyFailure(
    interaction: DispatchableInteraction,
    err: unknown,
    context?: string,
  ): Promise<void> {
    this.failedInteractions.add(interaction);
    const parsed = parseCustomId(interaction.customId);
    if (parsed) {
      void this.writeAudit(
        auditFailure({
          time: this.now(),
          userId: interaction.userId,
          userName: interaction.userName,
          summary: this.describeAction(parsed),
          reason: shortFailureReason(err),
        }),
      );
    }
    try {
      const message = friendlyError(err);
      await interaction.replyEphemeral(context ? `${context}\n${message}` : message);
    } catch (replyErr) {
      this.log.warn({ replyErr, customId: interaction.customId }, "error reply failed");
    }
  }

  /**
   * A short description of what an interaction tried to do, for audit lines:
   * `switch "Test" → OFF` for a toggle, otherwise `domain:action`.
   */
  private describeAction(parsed: ParsedCustomId): string {
    if (parsed.domain === "switch" && (parsed.action === "on" || parsed.action === "off")) {
      const ids = this.resolveEntity(parsed);
      const entity = ids
        ? this.core.listEntities(ids.serverId).find((e) => e.entityId === ids.entityId)
        : undefined;
      return `switch "${entity?.label ?? "switch"}" → ${parsed.action.toUpperCase()}`;
    }
    if (parsed.domain === "group" && (parsed.action === "on" || parsed.action === "off")) {
      const group = this.resolveGroup(parsed)?.group;
      return `group "${group?.name ?? "group"}" → ${parsed.action.toUpperCase()}`;
    }
    return `${parsed.domain}:${parsed.action}`;
  }

  /**
   * Build the audit line for a permitted component interaction. Switch on/off
   * gets a rich "toggled X → ON" line (resolving the device label); everything
   * else falls back to a generic `domain:action` summary.
   */
  private auditInteractionLine(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): string {
    const base = {
      time: this.now(),
      userId: interaction.userId,
      userName: interaction.userName,
    };
    if (parsed.domain === "switch" && (parsed.action === "on" || parsed.action === "off")) {
      const ids = this.resolveEntity(parsed);
      const entity = ids
        ? this.core.listEntities(ids.serverId).find((e) => e.entityId === ids.entityId)
        : undefined;
      return auditSwitchToggle({
        ...base,
        label: entity?.label ?? "switch",
        on: parsed.action === "on",
      });
    }
    // A group action is one line for the whole group.
    if (parsed.domain === "group" && (parsed.action === "on" || parsed.action === "off")) {
      const group = this.resolveGroup(parsed)?.group;
      return auditGroupToggle({
        ...base,
        label: group?.name ?? "group",
        members: group?.entityIds.length ?? 0,
        on: parsed.action === "on",
      });
    }
    return auditInteraction({
      ...base,
      summary: `${parsed.domain}:${parsed.action}`,
    });
  }

  /** Route an already-permitted interaction to its domain handler. */
  private async route(parsed: ParsedCustomId, interaction: DispatchableInteraction): Promise<void> {
    // Free-text actions open a modal; a modal CANNOT be combined with
    // deferUpdate, so these are intercepted before the generic defer path. The
    // pairing flow and every device's Settings "Rename" button open the same
    // label modal (it submits under pairing:label).
    if (
      (parsed.domain === "pairing" && parsed.action === "label") ||
      (kindForDomain(parsed.domain) !== undefined && parsed.action === "name")
    ) {
      await this.showLabelModal(parsed, interaction);
      return;
    }
    // A type message's "Manage a …" select opens that device's settings.
    if (parsed.action === "manage") {
      await this.handleManage(parsed, interaction);
      return;
    }
    // The per-switch auto-revert [Delay] button opens a numeric modal — also
    // intercepted before the generic defer path (a modal cannot follow defer).
    if (parsed.domain === "switch" && parsed.action === "delay") {
      await this.showDelayModal(parsed, interaction);
      return;
    }
    // A switch group's Rename opens its name modal: also a modal path.
    if (parsed.domain === "group" && parsed.action === "rename") {
      await this.showGroupRenameModal(parsed, interaction);
      return;
    }
    // The Pushover credentials button opens a modal — intercept before the
    // generic defer path (a modal cannot follow a deferUpdate).
    if (parsed.domain === "setup" && parsed.action === "pushover") {
      await this.showPushoverModal(interaction);
      return;
    }
    // "Add camera" opens a modal (or, with >1 server, a server picker first) —
    // also a modal-opening path, so intercept before the generic defer. Cameras
    // aren't FCM-paired; they're registered by their Computer Station identifier.
    if (parsed.domain === "setup" && parsed.action === "addCamera") {
      await this.showAddCameraEntry(interaction);
      return;
    }
    // Picking a server from that picker opens the add-camera modal for it.
    if (parsed.domain === "setup" && parsed.action === "cameraServer") {
      const handle = interaction.values?.[0];
      if (handle) await this.showAddCameraModal(handle, interaction);
      else await interaction.deferUpdate?.();
      return;
    }
    // Cancel the armed pairing wait and re-render the transient panel in place.
    // Intercepted before the generic deferUpdate path: update() acknowledges the
    // click itself and cannot follow a deferUpdate.
    if (parsed.domain === "pairing" && parsed.action === "cancel") {
      await this.handlePairingCancel(interaction);
      return;
    }
    switch (parsed.domain) {
      case "switch":
        await this.handleSwitch(parsed, interaction);
        return;
      case "group":
        // Manages its own acknowledgement: its panels are ephemeral
        // replies and in-place updates.
        await this.handleGroup(parsed, interaction);
        return;
      case "setup":
        await this.handleSetup(parsed, interaction);
        return;
      case "monitor":
        await this.handleMonitor(parsed, interaction);
        return;
      case "camera":
        await this.handleCamera(parsed, interaction);
        return;
      case "alarm":
        // Manages its own acknowledgement: [Settings] opens an ephemeral reply
        // (which cannot follow a deferUpdate), the priority select update()s it.
        await this.handleAlarm(parsed, interaction);
        return;
      case "server":
      case "pairing":
        // These resolve to refresh/read/best-effort bot-core calls; acknowledged
        // so the client doesn't show "interaction failed". Full rendering is
        // wired the same way as the switch/setup handlers above.
        await interaction.deferUpdate?.();
        await this.handleGenericAction(parsed, interaction);
        return;
      default:
        // `parseCustomId` checks the shape of an id, not its domain, so a domain
        // outside `CustomIdDomain` does arrive here at runtime: a button on
        // a panel posted by an older build (e.g. the retired Team panel), or a
        // domain added to the type but not to this switch. Nothing to actuate —
        // acknowledge so Discord does not show "This interaction failed".
        await interaction.deferUpdate?.();
        return;
    }
  }

  // ── free-text modals (modals are used only for free text) ─────────────────────

  /**
   * Show the Pushover credentials modal. Prefills the current values so the admin
   * can edit them; submitting both empty disables Pushover. Handled in
   * {@link handleModalSubmit}.
   */
  private async showPushoverModal(interaction: DispatchableInteraction): Promise<void> {
    if (!interaction.showModal) {
      await interaction.deferUpdate?.();
      return;
    }
    const current = this.core.getConfig().pushover;
    const modal = new ModalBuilder()
      .setCustomId(buildCustomId({ domain: "setup", action: "pushover" }))
      .setTitle("Pushover credentials")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("appToken")
            .setLabel("Application API token")
            .setPlaceholder("Leave both fields empty to disable Pushover")
            .setStyle(TextInputStyle.Short)
            .setValue(current?.appToken ?? "")
            .setMaxLength(64)
            .setRequired(false),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("userKey")
            .setLabel("User or group key")
            .setStyle(TextInputStyle.Short)
            .setValue(current?.userKey ?? "")
            .setMaxLength(64)
            .setRequired(false),
        ),
      );
    await interaction.showModal(modal);
  }

  /**
   * Entry point for "Add camera". With no server paired, explains that one is
   * needed; with exactly one, opens the add-camera modal bound to it; with more
   * than one, shows an ephemeral server picker first (`setup:cameraServer`).
   */
  private async showAddCameraEntry(interaction: DispatchableInteraction): Promise<void> {
    const servers = this.core.listServers();
    if (servers.length === 0) {
      await interaction.replyEphemeral("⚠️ Pair a server first, then add a camera to it.");
      return;
    }
    if (servers.length === 1) {
      await this.showAddCameraModal(this.handles.register(servers[0].id), interaction);
      return;
    }
    if (interaction.replyEphemeralPanel) {
      await interaction.replyEphemeralPanel(
        toPanelPayload(
          buildCameraServerSelectPanel(
            servers.map((s) => ({ handle: this.handles.register(s.id), name: s.name })),
          ),
        ),
      );
    } else {
      await interaction.deferUpdate?.();
    }
  }

  /**
   * Show the add-camera modal for a given server handle. Collects the camera's
   * Computer Station identifier (required) and an optional friendly name. The
   * customId carries the server handle so {@link handleModalSubmit} can register
   * the camera against the right server.
   */
  private async showAddCameraModal(
    serverHandle: string,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    if (!interaction.showModal) {
      await interaction.deferUpdate?.();
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(buildCustomId({ domain: "setup", action: "cameraAdd", server: serverHandle }))
      .setTitle("Add a camera")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("identifier")
            .setLabel("Camera identifier")
            .setPlaceholder("The ID set on the in-game CCTV Computer Station")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(64)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("label")
            .setLabel("Name (optional)")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(64)
            .setRequired(false),
        ),
      );
    await interaction.showModal(modal);
  }

  /**
   * Show the "Name this <entityType>" label modal for the pairing flow. The
   * customId carries server+entity handles so the submit handler can persist the
   * label and post a fresh per-entity panel.
   */
  private async showLabelModal(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    if (!parsed.server || !parsed.entity || !interaction.showModal) {
      await interaction.deferUpdate?.();
      return;
    }
    const ids = this.resolveEntity(parsed);
    const entity = ids
      ? this.core.listEntities(ids.serverId).find((e) => e.entityId === ids.entityId)
      : undefined;
    const what =
      entity?.entityType === "storageMonitor" ? "monitor" : (entity?.entityType ?? "device");
    const current = entity?.label ?? "";
    const labelInput = new TextInputBuilder()
      .setCustomId("label")
      .setLabel("Label")
      .setStyle(TextInputStyle.Short)
      .setMaxLength(64)
      .setRequired(true);
    // Renaming an already-named device prefills the current name so the operator
    // edits rather than retypes; first-time naming (pairing) leaves it blank.
    if (current) labelInput.setValue(current);
    const modal = new ModalBuilder()
      .setCustomId(
        buildCustomId({
          domain: "pairing",
          action: "label",
          server: parsed.server,
          entity: parsed.entity,
        }),
      )
      .setTitle(current ? `Rename ${what}` : `Name this ${what}`)
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(labelInput));
    await interaction.showModal(modal);
  }

  /**
   * Show the per-switch auto-revert delay modal. Prefills the current delay (or
   * the default). The submit handler validates the range and persists it under
   * the customId `switch:autodelay`.
   */
  private async showDelayModal(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    if (!parsed.server || !parsed.entity || !interaction.showModal) {
      await interaction.deferUpdate?.();
      return;
    }
    const ids = this.resolveEntity(parsed);
    const entity = ids
      ? this.core.listEntities(ids.serverId).find((e) => e.entityId === ids.entityId)
      : undefined;
    const current = entity?.autoActionDelaySeconds ?? SWITCH_AUTO_DELAY_DEFAULT;
    const delayInput = new TextInputBuilder()
      .setCustomId("seconds")
      .setLabel(`Delay in seconds (${SWITCH_AUTO_DELAY_MIN}–${SWITCH_AUTO_DELAY_MAX})`)
      .setStyle(TextInputStyle.Short)
      .setMaxLength(5)
      .setRequired(true)
      .setValue(String(current));
    const modal = new ModalBuilder()
      .setCustomId(
        buildCustomId({
          domain: "switch",
          action: "autodelay",
          server: parsed.server,
          entity: parsed.entity,
        }),
      )
      .setTitle("Auto-revert delay")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(delayInput));
    await interaction.showModal(modal);
  }

  // ── manage selects ──────────────────────────────────────────────────────────

  /**
   * A type message's "Manage a switch / alarm / monitor / camera…" select: open
   * the chosen device's settings ephemerally, through the same handler as its
   * settings always had. Then re-render the message the select sits on, so the
   * select shows its placeholder again and the same device can be chosen twice.
   */
  private async handleManage(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const entity = interaction.values?.[0];
    const kind = kindForDomain(parsed.domain);
    if (!entity || !kind) {
      // No choice, or a domain this build has no select for (a stale panel).
      await interaction.deferUpdate?.();
      return;
    }
    const target: ParsedCustomId = { ...parsed, action: "settings", entity };
    switch (parsed.domain) {
      case "switch": {
        // The Switches select also lists groups and "➕ New group…".
        const group = this.resolveGroup(target);
        if (entity === NEW_GROUP_OPTION) await this.startGroupCreate(parsed, interaction);
        else if (group) await this.openGroupPanel(group, interaction);
        else await this.handleSwitch(target, interaction);
        break;
      }
      case "alarm":
        await this.handleAlarm(target, interaction);
        break;
      case "monitor":
        await this.handleMonitor(target, interaction);
        break;
      case "camera":
        await this.handleCamera(target, interaction);
        break;
    }
    const serverId = parsed.server ? this.handles.idFor(parsed.server) : undefined;
    if (serverId) void this.renderPanels(serverId, [kind], { force: true });
  }

  // ── switch state-lock ────────────────────────────────────────────────────────

  private async handleSwitch(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const ids = this.resolveEntity(parsed);
    if (!ids) {
      await interaction.replyEphemeral(friendlyError(new Error("unknown switch")));
      return;
    }
    // Remove flow (confirm → remove) is shared by every device's settings; it
    // updates the ephemeral menu in place.
    if (this.isRemovalAction(parsed.action)) {
      const entity = this.core.listEntities(ids.serverId).find((e) => e.entityId === ids.entityId);
      const label = entity?.label ?? `switch ${ids.entityId}`;
      await this.handleEntityRemoval("switch", parsed, interaction, ids, label, () =>
        toPanelPayload(
          buildSwitchSettingsPanel({
            serverHandle: parsed.server ?? "",
            entityHandle: parsed.entity ?? "",
            label,
            autoAction: entity?.autoAction,
            autoDelaySeconds: entity?.autoActionDelaySeconds,
          }),
        ),
      );
      return;
    }
    // Settings (from the "Manage a switch…" select) open an ephemeral menu,
    // visible only to the member. Like the alarm handler it manages its own
    // acknowledgement: the ephemeral reply cannot follow a deferUpdate. (The
    // Rename / Delay buttons inside it are modal actions intercepted in route();
    // they never reach here.)
    if (parsed.action === "settings" || parsed.action === "auto") {
      const entity = this.core.listEntities(ids.serverId).find((e) => e.entityId === ids.entityId);
      const label = entity?.label ?? `${entity?.entityType ?? "switch"} ${ids.entityId}`;
      const settingsPanel = (autoAction?: SwitchAutoAction) =>
        toPanelPayload(
          buildSwitchSettingsPanel({
            serverHandle: parsed.server ?? "",
            entityHandle: parsed.entity ?? "",
            label,
            autoAction,
            autoDelaySeconds: entity?.autoActionDelaySeconds,
          }),
        );
      if (parsed.action === "auto") {
        // Acknowledge first: persisting re-arms the auto-revert timer (which can
        // round-trip to the game server) and the repaint is a Discord REST edit;
        // together they can outlast Discord's 3-second window.
        await interaction.deferUpdate?.();
        // Persist the chosen mode ("none" disables it), then refresh the
        // ephemeral menu in place so the select's default reflects the change.
        const value = interaction.values?.[0];
        const action = value === "none" ? null : ((value ?? null) as SwitchAutoAction | null);
        try {
          if (value) {
            await this.core.setSwitchAutoAction(ids.serverId, ids.entityId, action);
            // Repaint the Switches message so the row's auto-revert line follows.
            await this.renderPanels(ids.serverId, ["switches"], { immediate: true });
          }
          await interaction.editReply?.(settingsPanel(action ?? undefined));
        } catch (err) {
          // Already acknowledged: report as a follow-up, never a second reply.
          this.log.warn({ err, ...ids }, "switch auto action failed");
          await this.replyFailure(interaction, err);
        }
        return;
      }
      if (interaction.replyEphemeralPanel) {
        await interaction.replyEphemeralPanel(settingsPanel(entity?.autoAction));
      } else {
        await interaction.deferUpdate?.();
      }
      return;
    }
    const key: LockKey = { serverId: ids.serverId, entityId: ids.entityId };
    // 🔄 Refresh on a switch whose state is unknown: read it from the server.
    if (parsed.action === "refresh") {
      await interaction.deferUpdate?.();
      try {
        const info = await this.core.getEntity(ids.serverId, ids.entityId);
        this.stateLock.confirm(key, info.value ?? false);
        await this.renderPanels(ids.serverId, ["switches"], { immediate: true });
      } catch (err) {
        this.log.warn({ err, ...ids }, "switch refresh failed");
        await this.replyFailure(interaction, err);
      }
      return;
    }
    if (parsed.action !== "on" && parsed.action !== "off") {
      await interaction.deferUpdate?.();
      return;
    }
    const requested = parsed.action === "on";

    // Acknowledge first. The "Switching…" repaint below is a Discord REST edit
    // and the actuation a Rust+ round-trip; a slow edit (the first request
    // after an idle spell opens a new connection) once outlasted Discord's
    // 3-second window, the late acknowledgement threw "Unknown interaction",
    // and the switch was never actuated.
    await interaction.deferUpdate?.();

    // Enter pending: disable the row's button.
    const result = this.stateLock.click(key, requested);
    if (!result.changed) {
      // The switch is already pending: an earlier click's actuation is in flight
      // and this one landed before the disabled-button edit reached Discord. Do
      // NOT actuate again: a second setEntityValue (possibly the opposite
      // value) would race the request the lock tracks.
      return;
    }
    await this.renderPanels(ids.serverId, ["switches"], { immediate: true });

    // Fire the actuation; the confirming entityChanged closes the lock.
    try {
      await this.core.toggleEntity(ids.serverId, ids.entityId, requested);
    } catch (err) {
      // Failed to even submit: release the lock now rather than wait for the
      // timeout. Settle on what the server reports if it still answers;
      // otherwise fall back to the prior confirmed state — never a guess.
      this.log.warn({ err, ...key }, "toggleEntity failed");
      const reported = await this.safeEntityValue(ids.serverId, ids.entityId);
      if (reported === undefined) this.stateLock.cancel(key);
      else this.stateLock.confirm(key, reported);
      await this.renderPanels(ids.serverId, ["switches"], { immediate: true });
      await this.replyFailure(interaction, err);
    }
  }

  // ── switch groups ─────────────────────────────────────────────────────────────

  /**
   * A switch group's actions. On its row: Turn on / Turn off / Refresh act on
   * every member. In its ephemeral panel (opened from "Manage a switch…"):
   * member settings, Edit members, Delete (Rename is a modal, intercepted in
   * route). Every path acknowledges exactly once; failures after the
   * acknowledgement go through {@link replyFailure}.
   */
  private async handleGroup(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    // Its entity segment is a draft token, not a group handle.
    if (parsed.action === "create-members") {
      await this.finishGroupCreate(parsed, interaction);
      return;
    }
    const g = this.resolveGroup(parsed);
    if (!g) {
      await interaction.replyEphemeral(STALE_STATE_MESSAGE);
      return;
    }
    if (parsed.action === "on" || parsed.action === "off") {
      await this.actuateGroup(g, parsed.action === "on", interaction);
      return;
    }
    if (parsed.action === "refresh") {
      await this.refreshGroup(g, interaction);
      return;
    }
    const groupId = (action: string) =>
      buildCustomId({ domain: "group", action, server: g.serverHandle, entity: g.groupHandle });
    try {
      switch (parsed.action) {
        case "view":
        case "delete-cancel":
          await this.showGroupPanelInPlace(g, interaction);
          return;
        case "member": {
          // "Member settings…": that switch's own settings, as a new ephemeral reply.
          const value = interaction.values?.[0];
          const member = value
            ? this.resolveEntity({
                domain: "switch",
                action: "settings",
                server: g.serverHandle,
                entity: value,
              })
            : undefined;
          if (!member || !g.group.entityIds.includes(member.entityId)) {
            await interaction.replyEphemeral(STALE_STATE_MESSAGE);
            return;
          }
          await this.handleSwitch(
            { domain: "switch", action: "settings", server: g.serverHandle, entity: value },
            interaction,
          );
          // Show the select's placeholder again, so the same member can be chosen twice.
          void this.refreshGroupViews(g.serverId, { force: true });
          return;
        }
        case "members":
          await this.updateOrDefer(
            interaction,
            this.groupPickerPayload(
              `${g.group.name}: members`,
              groupId("setmembers"),
              this.groupCandidates(g.serverId, g.group.id),
              groupId("view"),
            ),
          );
          return;
        case "setmembers": {
          const ids = this.memberIdsFrom(g.serverHandle, interaction.values);
          if (!ids) {
            await interaction.replyEphemeral(STALE_STATE_MESSAGE);
            return;
          }
          await this.core.setSwitchGroupMembers(g.serverId, g.group.id, ids);
          await this.showGroupPanelInPlace(g, interaction);
          // Switches that left have their own rows again; new members lose theirs.
          await this.syncGroup(g.serverId);
          return;
        }
        case "delete":
          await this.updateOrDefer(
            interaction,
            toPanelPayload(
              buildGroupDeleteConfirmPanel({
                serverHandle: g.serverHandle,
                groupHandle: g.groupHandle,
                name: g.group.name,
              }),
            ),
          );
          return;
        case "delete-confirm":
          await this.core.deleteSwitchGroup(g.serverId, g.group.id);
          this.dropGroupViews(g.serverId, g.group.id);
          await this.updateOrDefer(
            interaction,
            toPanelPayload(
              buildGroupNoticePanel(
                `🗑 Deleted the group **${escapeMarkdown(trimText(g.group.name, 100))}**. Its switches have their own rows again.`,
              ),
            ),
          );
          await this.syncGroup(g.serverId);
          return;
        default:
          await interaction.deferUpdate?.();
      }
    } catch (err) {
      this.log.warn(
        { err, serverId: g.serverId, groupId: g.group.id, action: parsed.action },
        "switch group action failed",
      );
      await this.replyFailure(interaction, err);
    }
  }

  /**
   * Turn every member of a group on or off. Each member goes through its own
   * state lock (a member already pending is left alone, and one already
   * confirmed at the target is skipped: the server reports no change for it),
   * and the members are actuated one after another, so bot-core's client
   * queues them through the rate limiter. A member whose actuation fails
   * restores its own prior confirmed value (or what the server now reports);
   * the others go on. A partial failure is reported to the clicker once.
   */
  private async actuateGroup(
    g: ResolvedGroup,
    requested: boolean,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const { serverId } = g;
    // Acknowledge first, as for a switch: the repaint and the round-trips are slow.
    await interaction.deferUpdate?.();
    const clicked: LockKey[] = [];
    for (const entityId of g.group.entityIds) {
      const key: LockKey = { serverId, entityId };
      const snapshot = this.stateLock.snapshot(key);
      if (snapshot?.phase !== "pending" && snapshot?.value === requested) continue;
      if (!this.stateLock.click(key, requested).changed) continue;
      this.groupClicked.add(lockId(key));
      clicked.push(key);
    }
    await this.renderPanels(serverId, ["switches"], { immediate: true });
    if (clicked.length === 0) return;

    const failed: { key: LockKey; err: unknown }[] = [];
    for (const key of clicked) {
      try {
        await this.core.toggleEntity(serverId, key.entityId, requested);
      } catch (err) {
        this.log.warn(
          { err, ...key, groupId: g.group.id },
          "toggleEntity for a group member failed",
        );
        this.groupClicked.delete(lockId(key));
        const reported = await this.safeEntityValue(serverId, key.entityId);
        if (reported === undefined) this.stateLock.cancel(key);
        else this.stateLock.confirm(key, reported);
        failed.push({ key, err });
      }
    }
    this.log.info(
      {
        serverId,
        groupId: g.group.id,
        target: requested ? "on" : "off",
        actuated: clicked.length - failed.length,
        failed: failed.length,
      },
      "switch group actuated",
    );
    if (failed.length === 0) return;
    await this.renderPanels(serverId, ["switches"], { immediate: true });
    await this.replyFailure(
      interaction,
      failed[0]!.err,
      this.groupFailureContext(
        g,
        failed.map((f) => f.key.entityId),
        clicked.length,
        "didn't switch",
      ),
    );
  }

  /** 🔄 Refresh on a group whose state is unknown: read every member from the server. */
  private async refreshGroup(
    g: ResolvedGroup,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    await interaction.deferUpdate?.();
    const failed: { entityId: number; err: unknown }[] = [];
    for (const entityId of g.group.entityIds) {
      try {
        const info = await this.core.getEntity(g.serverId, entityId);
        this.stateLock.confirm({ serverId: g.serverId, entityId }, info.value ?? false);
      } catch (err) {
        this.log.warn({ err, serverId: g.serverId, entityId }, "group member refresh failed");
        failed.push({ entityId, err });
      }
    }
    await this.renderPanels(g.serverId, ["switches"], { immediate: true });
    if (failed.length > 0) {
      await this.replyFailure(
        interaction,
        failed[0]!.err,
        this.groupFailureContext(
          g,
          failed.map((f) => f.entityId),
          g.group.entityIds.length,
          "couldn't be read",
        ),
      );
    }
  }

  /** `⚠️ 2 of 3 switches in "Turrets" didn't switch: A, B.` */
  private groupFailureContext(
    g: ResolvedGroup,
    failedIds: readonly number[],
    of: number,
    outcome: string,
  ): string {
    const entities = this.core.listEntities(g.serverId);
    const names = failedIds.map((id) => {
      const entity = entities.find((e) => e.entityId === id);
      return entity ? this.entityLabel(entity) : `switch ${id}`;
    });
    return `⚠️ ${failedIds.length} of ${of} switches in "${g.group.name}" ${outcome}: ${names.join(", ")}.`;
  }

  /**
   * Resolve a group custom ID's server and group handles, and check the group
   * still exists. Undefined for anything else (an entity handle, a stale panel).
   */
  private resolveGroup(parsed: ParsedCustomId): ResolvedGroup | undefined {
    if (!parsed.server || !parsed.entity) return undefined;
    const serverId = this.handles.idFor(parsed.server);
    const key = this.handles.idFor(parsed.entity);
    if (!serverId || !key) return undefined;
    const prefix = HandleRegistry.groupKey(serverId, "");
    if (!key.startsWith(prefix)) return undefined;
    const groupId = key.slice(prefix.length);
    const group = this.core.listSwitchGroups(serverId).find((x) => x.id === groupId);
    return group
      ? { serverId, group, serverHandle: parsed.server, groupHandle: parsed.entity }
      : undefined;
  }

  /** A group's ephemeral panel as it stands, or undefined when the group is gone. */
  private groupPanelPayload(serverId: string, groupId: string): PanelPayload | undefined {
    const group = this.core.listSwitchGroups(serverId).find((g) => g.id === groupId);
    if (!group) return undefined;
    return toPanelPayload(
      buildSwitchGroupPanel({
        serverHandle: this.handles.register(serverId),
        groupHandle: this.handles.register(HandleRegistry.groupKey(serverId, groupId)),
        name: group.name,
        status: this.core.getServerStatus(serverId).status,
        members: this.groupMembers(serverId, group),
      }),
    );
  }

  /** Choosing a group in "Manage a switch…": its panel, as a new ephemeral reply. */
  private async openGroupPanel(
    g: ResolvedGroup,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const payload = this.groupPanelPayload(g.serverId, g.group.id);
    if (!payload || !interaction.replyEphemeralPanel) {
      await interaction.deferUpdate?.();
      return;
    }
    const handle = await interaction.replyEphemeralPanel(payload);
    this.registerGroupView(g, interaction.userId, (p) => handle.editPanel(p), payload);
  }

  /** Show a group's panel in place of the clicked ephemeral message (Cancel, after an edit). */
  private async showGroupPanelInPlace(
    g: ResolvedGroup,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const payload =
      this.groupPanelPayload(g.serverId, g.group.id) ??
      toPanelPayload(buildGroupNoticePanel("🗑 This group no longer exists."));
    if (!interaction.update) {
      await interaction.deferUpdate?.();
      return;
    }
    await interaction.update(payload);
    const editReply = interaction.editReply;
    if (editReply) this.registerGroupView(g, interaction.userId, (p) => editReply(p), payload);
  }

  /** Remember an open group panel, so member state changes reach it while its token lasts. */
  private registerGroupView(
    g: ResolvedGroup,
    userId: string | undefined,
    edit: (payload: PanelPayload) => Promise<void>,
    shown: PanelPayload,
  ): void {
    this.groupViews.set(`${g.serverId}/${g.group.id}/${userId ?? "?"}`, {
      serverId: g.serverId,
      groupId: g.group.id,
      edit,
      expiresAt: this.now().getTime() + GROUP_VIEW_TTL_MS,
      fingerprint: JSON.stringify(shown),
    });
  }

  /** Forget every open panel of a deleted group. */
  private dropGroupViews(serverId: string, groupId: string): void {
    for (const [key, view] of this.groupViews) {
      if (view.serverId === serverId && view.groupId === groupId) this.groupViews.delete(key);
    }
  }

  /**
   * Re-render every open group panel of a server whose content changed (or all
   * of them, with `force`). Edits to one panel run one at a time, each
   * rendering the latest state. A panel whose token has run out, or whose edit
   * fails, is forgotten. Never rejects.
   */
  private async refreshGroupViews(serverId: string, opts: { force?: boolean } = {}): Promise<void> {
    const runs: Promise<void>[] = [];
    for (const [key, view] of this.groupViews) {
      if (view.serverId !== serverId) continue;
      view.chain = (view.chain ?? Promise.resolve()).then(() =>
        this.paintGroupView(key, view, Boolean(opts.force)),
      );
      runs.push(view.chain);
    }
    await Promise.all(runs);
  }

  private async paintGroupView(key: string, view: GroupView, force: boolean): Promise<void> {
    if (this.groupViews.get(key) !== view) return; // replaced or dropped meanwhile
    if (view.expiresAt <= this.now().getTime()) {
      this.groupViews.delete(key);
      return;
    }
    const live = this.groupPanelPayload(view.serverId, view.groupId);
    const payload = live ?? toPanelPayload(buildGroupNoticePanel("🗑 This group no longer exists."));
    if (!live) this.groupViews.delete(key);
    const fingerprint = JSON.stringify(payload);
    if (!force && fingerprint === view.fingerprint) return;
    view.fingerprint = fingerprint;
    try {
      await view.edit(payload);
    } catch (err) {
      this.groupViews.delete(key);
      this.log.debug(
        { err, serverId: view.serverId, groupId: view.groupId },
        "group panel edit failed; no longer kept live",
      );
    }
  }

  /**
   * "➕ New group…" in "Manage a switch…": ask for the group's name (a modal;
   * its submit then offers the members). Says so at once if every switch is
   * already in a group.
   */
  private async startGroupCreate(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const serverId = parsed.server ? this.handles.idFor(parsed.server) : undefined;
    if (!serverId) {
      await interaction.replyEphemeral(STALE_STATE_MESSAGE);
      return;
    }
    if (this.groupCandidates(serverId).length === 0) {
      await interaction.replyEphemeral(NO_UNGROUPED_SWITCH_MESSAGE);
      return;
    }
    if (!interaction.showModal) {
      await interaction.deferUpdate?.();
      return;
    }
    await interaction.showModal(
      groupNameModal(
        buildCustomId({ domain: "group", action: "create", server: parsed.server }),
        "New switch group",
      ),
    );
  }

  /** A group panel's ✏ Rename: the name modal, prefilled (submitted as `group:rename`). */
  private async showGroupRenameModal(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const g = this.resolveGroup(parsed);
    if (!g) {
      await interaction.replyEphemeral(STALE_STATE_MESSAGE);
      return;
    }
    if (!interaction.showModal) {
      await interaction.deferUpdate?.();
      return;
    }
    await interaction.showModal(
      groupNameModal(
        buildCustomId({
          domain: "group",
          action: "rename",
          server: g.serverHandle,
          entity: g.groupHandle,
        }),
        "Rename group",
        g.group.name,
      ),
    );
  }

  /**
   * The member picker's answer for a new group: create it from the name kept in
   * its draft, show its panel in place, and lay out the Switches message.
   */
  private async finishGroupCreate(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const serverHandle = parsed.server;
    const serverId = serverHandle ? this.handles.idFor(serverHandle) : undefined;
    const token = parsed.entity;
    const draft = token ? this.groupDrafts.get(token) : undefined;
    if (!serverHandle || !serverId || !token || !draft || draft.serverId !== serverId) {
      await this.updateOrDefer(
        interaction,
        toPanelPayload(buildGroupNoticePanel(GROUP_FORM_EXPIRED_MESSAGE)),
      );
      return;
    }
    const ids = this.memberIdsFrom(serverHandle, interaction.values);
    if (!ids) {
      await interaction.replyEphemeral(STALE_STATE_MESSAGE);
      return;
    }
    try {
      const group = await this.core.createSwitchGroup(serverId, draft.name, ids);
      this.groupDrafts.delete(token);
      const g: ResolvedGroup = {
        serverId,
        group,
        serverHandle,
        groupHandle: this.handles.register(HandleRegistry.groupKey(serverId, group.id)),
      };
      await this.showGroupPanelInPlace(g, interaction);
      // Its members' own rows give way to the group's.
      await this.syncGroup(serverId);
    } catch (err) {
      this.log.warn({ err, serverId }, "switch group create failed");
      await this.replyFailure(interaction, err);
    }
  }

  /**
   * The switches a group may hold: those in no other group, its current members
   * first (so they are always among the select's 25 options), each marked
   * whether it is a member now.
   */
  private groupCandidates(
    serverId: string,
    groupId?: string,
  ): { entityHandle: string; label: string; selected: boolean }[] {
    const groups = this.core.listSwitchGroups(serverId);
    const own = new Set(groups.find((g) => g.id === groupId)?.entityIds ?? []);
    const taken = new Set(groups.filter((g) => g.id !== groupId).flatMap((g) => g.entityIds));
    const switches = this.sortedEntities(serverId).filter(
      (e) => e.entityType === "switch" && !taken.has(e.entityId),
    );
    const ordered = [
      ...switches.filter((e) => own.has(e.entityId)),
      ...switches.filter((e) => !own.has(e.entityId)),
    ];
    return ordered.map((e) => ({
      entityHandle: this.handles.register(HandleRegistry.entityKey(serverId, e.entityId)),
      label: this.entityLabel(e),
      selected: own.has(e.entityId),
    }));
  }

  private groupPickerPayload(
    heading: string,
    selectId: string,
    options: readonly { entityHandle: string; label: string; selected?: boolean }[],
    cancelId?: string,
  ): PanelPayload {
    return toPanelPayload(
      buildSwitchGroupPickerPanel({
        heading,
        selectId,
        options,
        maxMembers: SWITCH_GROUP_MAX_MEMBERS,
        cancelId,
      }),
    );
  }

  /** Keep a new group's name until its members are picked; returns the draft's token. */
  private newGroupDraft(serverId: string, name: string): string {
    const now = this.now().getTime();
    for (const [token, draft] of this.groupDrafts) {
      if (draft.expiresAt <= now) this.groupDrafts.delete(token);
    }
    const token = `d${(++this.groupDraftSeq).toString(36)}`;
    this.groupDrafts.set(token, { serverId, name, expiresAt: now + GROUP_DRAFT_TTL_MS });
    return token;
  }

  /**
   * The entity ids a member select chose (values are entity handles), or
   * undefined when none was chosen or any does not resolve on this server.
   */
  private memberIdsFrom(
    serverHandle: string,
    values: readonly string[] | undefined,
  ): number[] | undefined {
    const ids: number[] = [];
    for (const value of values ?? []) {
      const resolved = this.resolveEntity({
        domain: "switch",
        action: "settings",
        server: serverHandle,
        entity: value,
      });
      if (!resolved) return undefined;
      ids.push(resolved.entityId);
    }
    return ids.length > 0 ? ids : undefined;
  }

  /** Acknowledge a component click by re-rendering its ephemeral message, if possible. */
  private async updateOrDefer(
    interaction: DispatchableInteraction,
    payload: PanelPayload,
  ): Promise<void> {
    if (interaction.update) await interaction.update(payload);
    else await interaction.deferUpdate?.();
  }

  // ── periodic status refresh ──────────────────────────────────────────────────

  /**
   * Begin the periodic Server-message refresh. Idempotent: a no-op when already
   * running or when the interval is disabled (`<= 0`). Uses a fixed-delay,
   * self-rescheduling timer (TimerProvider exposes only one-shot setTimer) so the
   * next tick is scheduled only after the prior refresh settles — back-to-back
   * runs can't overlap, and a slow Rust+ round-trip can't pile up timers.
   */
  private startStatusRefresh(): void {
    if (this.statusRefreshActive || this.statusRefreshIntervalMs <= 0) return;
    this.statusRefreshActive = true;
    const schedule = () => {
      if (!this.statusRefreshActive) return;
      this.statusRefreshTimer = this.timers.setTimer(() => {
        void this.refreshConnectedServerMessages().finally(schedule);
      }, this.statusRefreshIntervalMs);
    };
    schedule();
  }

  /** Stop the periodic refresh (cancels the pending tick; see `statusRefreshActive`). */
  private stopStatusRefresh(): void {
    this.statusRefreshActive = false;
    if (this.statusRefreshTimer !== undefined) {
      this.timers.clearTimer(this.statusRefreshTimer);
      this.statusRefreshTimer = undefined;
    }
  }

  /**
   * One refresh tick: re-fetch + edit the Server message of every connected
   * server. Other servers are skipped (they can't answer getInfo, and their
   * message already reads reconnecting or offline from the status event).
   * Per-server failures are swallowed so one bad server can't stall the others
   * or the loop.
   *
   * Spends as few edits as it can, since Discord caps edits to old messages: no
   * "Refreshing…" pre-edit and no game clock, so a tick where players/queue and
   * the team are unchanged renders the same payload and the edit pipeline skips
   * it.
   */
  private async refreshConnectedServerMessages(): Promise<void> {
    for (const server of this.core.listServers()) {
      if (!this.idsFor(server)?.server) continue;
      if (this.core.getServerStatus(server.id).status !== "connected") continue;
      try {
        await this.refreshServerMessage(server.id, { coalesce: true });
      } catch (err) {
        this.log.warn({ err, serverId: server.id }, "periodic status refresh failed");
      }
    }
  }

  /**
   * Re-fetch a server's status and team, and edit its Server message.
   *
   * `coalesce` callers (the manual Refresh button + the periodic tick) drop out
   * when a refresh is already in flight for this server, so overlapping getInfo
   * round-trips can't stack. Other callers are authoritative and always paint.
   *
   * `manual` is the Refresh button: it paints a disabled "⏳ Refreshing…" button
   * for the getInfo round-trip, re-enables it on the final render, and shows the
   * game clock. Both edits skip the debounce, since the member is watching.
   * Every other render is automatic: no clock (it changes every tick, so it would
   * make every tick an edit) and a debounced edit.
   */
  private async refreshServerMessage(
    serverId: string,
    opts: { coalesce?: boolean; manual?: boolean } = {},
  ): Promise<void> {
    const server = this.core.listServers().find((s) => s.id === serverId);
    if (!server || !this.idsFor(server)?.server) return;
    if (opts.coalesce) {
      if (this.statusRefreshInFlight.has(serverId)) return;
      this.statusRefreshInFlight.add(serverId);
    }
    try {
      const immediate = Boolean(opts.manual);
      if (opts.manual && this.core.getServerStatus(serverId).status === "connected") {
        // Disable the button for the fetch window, keeping the last-known
        // players/queue and team so the message doesn't blank meanwhile.
        await this.renderPanels(serverId, ["server"], {
          immediate,
          extras: { refreshing: true },
        });
      }
      const timeLabel = await this.fetchServerData(serverId, { clock: immediate });
      await this.renderPanels(serverId, ["server"], { immediate, extras: { timeLabel } });
    } finally {
      if (opts.coalesce) this.statusRefreshInFlight.delete(serverId);
    }
  }

  /**
   * Bring a server's players/queue and team up to date for its Server message,
   * by its connection. Connected: fetch them live (and the game clock, when
   * `clock`: only a manual Refresh shows it), and remember them.
   * Reconnecting: keep the last known ones. Offline: forget them. Returns the
   * clock's label, when fetched.
   */
  private async fetchServerData(
    serverId: string,
    opts: { clock: boolean },
  ): Promise<string | undefined> {
    const { status } = this.core.getServerStatus(serverId);
    if (status === "offline") {
      this.lastServerInfo.delete(serverId);
      this.lastTeam.delete(serverId);
      this.statusNotes.delete(serverId);
      return undefined;
    }
    if (status !== "connected") return undefined;
    try {
      this.lastServerInfo.set(serverId, await this.core.getServerInfo(serverId));
      this.statusNotes.delete(serverId);
    } catch (err) {
      this.log.warn({ err, serverId }, "getServerInfo for the Server message failed");
      // Say why, rather than leaving "fetching status…" up for good.
      this.lastServerInfo.delete(serverId);
      this.statusNotes.set(serverId, `⚠️ Couldn't fetch status: ${shortFailureReason(err)}`);
    }
    try {
      this.lastTeam.set(serverId, await this.core.getTeam(serverId));
    } catch (err) {
      this.log.warn({ err, serverId }, "getTeam for the Server message failed");
    }
    if (!opts.clock) return undefined;
    try {
      return formatGameTime(await this.core.getServerTime(serverId));
    } catch (err) {
      this.log.warn({ err, serverId }, "getServerTime for the Server message failed");
      return undefined;
    }
  }

  /**
   * Alarm settings. Settings (from the "Manage an alarm…" select) open an
   * ephemeral menu; the selects inside it persist the notification level or the
   * Pushover severity, repaint the Alarms message where it shows, and refresh
   * the ephemeral menu's selected default in place.
   */
  private async handleAlarm(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const ids = this.resolveEntity(parsed);
    if (!ids) {
      await interaction.deferUpdate?.();
      return;
    }
    const entity = this.core.listEntities(ids.serverId).find((e) => e.entityId === ids.entityId);
    const label = entity?.label ?? `${entity?.entityType ?? "alarm"} ${ids.entityId}`;
    const settingsPanel = (opts?: {
      severity?: PushoverSeverity;
      notificationLevel?: AlarmNotificationLevel;
    }) =>
      toPanelPayload(
        buildAlarmSettingsPanel({
          serverHandle: parsed.server ?? "",
          entityHandle: parsed.entity ?? "",
          label,
          notificationLevel: opts?.notificationLevel,
          pushoverSeverity: opts?.severity,
          pushoverConfigured: this.core.isPushoverConfigured(),
        }),
      );
    try {
      if (parsed.action === "settings") {
        if (interaction.replyEphemeralPanel) {
          await interaction.replyEphemeralPanel(
            settingsPanel({
              severity: entity?.pushoverSeverity,
              notificationLevel: entity?.notificationLevel,
            }),
          );
        } else {
          await interaction.deferUpdate?.();
        }
        return;
      }
      if (parsed.action === "severity") {
        // Persist the chosen priority ("off" clears it), repaint the Alarms
        // message so the line's paging flips, then refresh the menu in place.
        const value = interaction.values?.[0];
        const severity = value === "off" ? null : ((value ?? null) as PushoverSeverity | null);
        if (value) {
          await this.core.setAlarmPushoverSeverity(ids.serverId, ids.entityId, severity);
          // A member's choice: shown at once.
          await this.renderPanels(ids.serverId, ["alarms"], { immediate: true });
        }
        if (interaction.update) {
          await interaction.update(
            settingsPanel({
              severity: severity ?? undefined,
              notificationLevel: entity?.notificationLevel,
            }),
          );
        } else {
          await interaction.deferUpdate?.();
        }
        return;
      }
      if (parsed.action === "notify") {
        // Persist how the alarm notifies on fire ("default", Normal, clears it), then refresh
        // the ephemeral menu in place. The Alarms message does not show it.
        const value = interaction.values?.[0];
        const level =
          value === "default" ? null : ((value ?? null) as AlarmNotificationLevel | null);
        if (value) {
          await this.core.setAlarmNotificationLevel(ids.serverId, ids.entityId, level);
        }
        if (interaction.update) {
          await interaction.update(
            settingsPanel({
              severity: entity?.pushoverSeverity,
              notificationLevel: level ?? undefined,
            }),
          );
        } else {
          await interaction.deferUpdate?.();
        }
        return;
      }
      if (this.isRemovalAction(parsed.action)) {
        await this.handleEntityRemoval("alarm", parsed, interaction, ids, label, () =>
          settingsPanel({
            severity: entity?.pushoverSeverity,
            notificationLevel: entity?.notificationLevel,
          }),
        );
        return;
      }
      await interaction.deferUpdate?.();
    } catch (err) {
      // Tell the member, like the switch and camera handlers do. The failure can
      // land before the acknowledgement (a bot-core call threw) or after it;
      // replyFailure replies or follows up accordingly and never throws.
      this.log.warn({ err, action: parsed.action }, "alarm action failed");
      await this.replyFailure(interaction, err);
    }
  }

  /** Whether a parsed action is part of the device-removal confirm flow. */
  private isRemovalAction(action: string): boolean {
    return action === "remove" || action === "remove-confirm" || action === "remove-cancel";
  }

  /**
   * Shared remove-device flow for every device's settings. `remove` shows a
   * confirm panel, `remove-cancel` returns to the settings, and
   * `remove-confirm` forgets the entity (whose `entityRemoved` event takes its
   * row off the panel) and shows a "removed" notice. All update the ephemeral
   * menu in place.
   */
  private async handleEntityRemoval(
    domain: RemovableDomain,
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
    ids: { serverId: string; entityId: number },
    label: string,
    rebuildSettings: () => PanelPayload,
  ): Promise<void> {
    const updateOrDefer = async (payload: PanelPayload) => {
      if (interaction.update) await interaction.update(payload);
      else await interaction.deferUpdate?.();
    };
    if (parsed.action === "remove") {
      await updateOrDefer(
        toPanelPayload(
          buildRemoveConfirmPanel({
            domain,
            serverHandle: parsed.server ?? "",
            entityHandle: parsed.entity ?? "",
            label,
          }),
        ),
      );
      return;
    }
    if (parsed.action === "remove-cancel") {
      await updateOrDefer(rebuildSettings());
      return;
    }
    // remove-confirm
    await this.core.removeEntity(ids.serverId, ids.entityId);
    await updateOrDefer(toPanelPayload(buildRemovedNoticePanel(label)));
  }

  /** Called by the state-lock machine when a confirmation never arrives. */
  private async onLockTimeout(key: LockKey, result: LockResult): Promise<void> {
    this.log.warn({ ...key }, "state-lock timeout; restoring prior state");
    this.groupClicked.delete(lockId(key));
    await this.renderPanels(key.serverId, ["switches"], { immediate: true });
    // The ephemeral warning is best-effort; the original interaction token has
    // likely expired, so the desktop host may post it to the control channel.
    if (result.warn) {
      this.log.info({ ...key }, COULD_NOT_CONFIRM_MESSAGE);
      const entity = this.core.listEntities(key.serverId).find((e) => e.entityId === key.entityId);
      void this.writeAudit(
        auditUnconfirmed({ time: this.now(), label: entity?.label ?? "switch" }),
      );
    }
  }

  /**
   * The on/off value the server currently reports for an entity, or `undefined`
   * when it cannot be read (offline, entity gone, no value in the answer).
   */
  private async safeEntityValue(serverId: string, entityId: number): Promise<boolean | undefined> {
    try {
      const info = await this.core.getEntity(serverId, entityId);
      return info.value;
    } catch {
      return undefined;
    }
  }

  // ── setup hub ────────────────────────────────────────────────────────────────

  /** Build the Setup hub payload from current config (channels, roles, toggles). */
  private setupHubPayload(): PanelPayload {
    const config = this.core.getConfig();
    // Leave out a chosen role the server no longer has, when the cache can tell.
    const roles = this.serverRoles(this.guildId ?? config.discordGuildId);
    const existing = (ids: readonly string[]) =>
      roles ? ids.filter((id) => roles.some((r) => r.id === id)) : [...ids];
    return toPanelPayload(
      buildSetupPanel({
        controlChannelId: config.controlChannelId,
        loggingChannelId: config.loggingChannelId,
        adminRoleIds: existing(config.roleCapabilities.admin),
        userRoleIds: existing(config.roleCapabilities.user),
        startOnLogin: config.startOnLogin,
        pushoverConfigured: this.core.isPushoverConfigured(),
      }),
    );
  }

  /**
   * A server's roles, from the gateway cache (the Guilds intent keeps it
   * current, so no REST call). `undefined` when the server isn't cached.
   */
  private serverRoles(guildId: string | undefined): ServerRole[] | undefined {
    if (!guildId) return undefined;
    const guilds = (this.client as { guilds?: unknown } | undefined)?.guilds as
      { cache?: { get(id: string): unknown } } | undefined;
    const guild = guilds?.cache?.get(guildId) as
      { roles?: { cache?: { values(): Iterable<unknown> } } } | undefined;
    const cache = guild?.roles?.cache;
    if (!cache) return undefined;
    const roles: ServerRole[] = [];
    for (const role of cache.values()) {
      const r = role as { id?: unknown; name?: unknown; managed?: unknown };
      if (typeof r.id !== "string" || typeof r.name !== "string") continue;
      roles.push({ id: r.id, name: r.name, managed: r.managed === true });
    }
    return roles;
  }

  /**
   * With no admin or user roles chosen, adopt the server's roles named "Conduit
   * Admin" and "Conduit" ({@link adoptNamedRoles}) and save them, so members
   * with those roles can use Conduit without anyone choosing them in the Setup
   * hub. Runs when the adapter is ready and when the Setup hub opens. A role
   * chosen by hand is never replaced. Best-effort: a failure is logged.
   */
  private async adoptConduitRoles(
    guildId: string | undefined,
    trigger: "ready" | "setup",
  ): Promise<void> {
    const roles = this.serverRoles(guildId);
    if (!roles) return;
    const adopted = adoptNamedRoles(this.core.getConfig().roleCapabilities, roles);
    if (!adopted) return;
    try {
      await this.core.setRoleCapabilities(adopted);
      this.log.info(
        { guildId, trigger, admin: adopted.admin, user: adopted.user },
        "discord: adopted the Conduit roles by name",
      );
    } catch (err) {
      this.log.warn({ err, guildId, trigger }, "discord: adopting the Conduit roles failed");
    }
  }

  private async handleSetup(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    switch (parsed.action) {
      case "channel":
      case "logChannel": {
        const channelId = interaction.values?.[0];
        if (channelId) {
          if (parsed.action === "channel") {
            await this.core.setControlChannel(channelId);
          } else {
            await this.core.setLoggingChannel(channelId);
          }
          // The Setup hub is ephemeral; re-render it in place so it reflects the
          // freshly-chosen channel.
          if (interaction.update) await interaction.update(this.setupHubPayload());
          else await interaction.deferUpdate?.();
          // Setting the control channel is the self-heal trigger for the first-run
          // ordering gap: a server can pair (and its onServerPaired post fire) before
          // a control channel exists, so those posts no-op. Reconstruct now so the
          // panels appear immediately instead of only after the next restart.
          if (parsed.action === "channel") await this.repostAllPanels();
        } else {
          await interaction.deferUpdate?.();
        }
        return;
      }
      case "adminRoles":
      case "userRoles": {
        const config = this.core.getConfig();
        const next = {
          admin: [...config.roleCapabilities.admin],
          user: [...config.roleCapabilities.user],
        };
        if (parsed.action === "adminRoles") next.admin = interaction.values ?? [];
        else next.user = interaction.values ?? [];
        await this.core.setRoleCapabilities(next);
        await interaction.replyEphemeral("✅ Role permissions updated.");
        return;
      }
      case "addDevice": {
        // Reply with the transient pairing panel (armed) as an ephemeral message —
        // visible only to this admin. Stash its handle so onEntityPaired can
        // auto-dismiss it once the device pairs. Falls back to deferUpdate in the
        // (test) case where the seam isn't provided.
        if (interaction.replyEphemeralPanel) {
          this.pairingDismiss = await interaction.replyEphemeralPanel(
            toPanelPayload(buildPairingPanel({ armed: true })),
          );
        } else {
          await interaction.deferUpdate?.();
        }
        void this.core.beginPairing();
        return;
      }
      case "repost": {
        // Setup → Rebuild panels. The custom id keeps its old name, so Setup hubs
        // already posted keep working.
        await interaction.deferUpdate?.();
        // Delete and post every server's Conduit Panel afresh, in order: the
        // fix-up path for a panel buried under other messages, or out of order.
        await this.repostAllPanels();
        return;
      }
      case "startOnLogin": {
        // Flip the persisted preference. bot-core announces the change and the
        // desktop host applies it to the OS login item; the hub is re-rendered in
        // place so the button label reflects the new value.
        await this.core.setStartOnLogin(!this.core.getConfig().startOnLogin);
        if (interaction.update) await interaction.update(this.setupHubPayload());
        else await interaction.deferUpdate?.();
        return;
      }
      default:
        await interaction.deferUpdate?.();
    }
  }

  // ── storage monitor ──────────────────────────────────────────────────────────

  /**
   * Storage monitor actions: 🔍 Contents on its row (the full contents,
   * ephemerally), its settings from the "Manage a monitor…" select, and the
   * settings' Watch, Refresh and Remove. Watch and Refresh update the ephemeral
   * settings in place and repaint the Storage message.
   */
  private async handleMonitor(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const ids = this.resolveEntity(parsed);
    if (!ids) {
      await interaction.deferUpdate?.();
      return;
    }
    const key = HandleRegistry.entityKey(ids.serverId, ids.entityId);
    const entity = this.core.listEntities(ids.serverId).find((e) => e.entityId === ids.entityId);
    const label = entity ? this.entityLabel(entity) : `storageMonitor ${ids.entityId}`;
    const settingsPanel = () =>
      toPanelPayload(
        buildMonitorSettingsPanel({
          serverHandle: parsed.server ?? "",
          entityHandle: parsed.entity ?? "",
          label,
          info: this.monitorInfo.get(key),
          watch: entity ? this.isWatched(entity) : false,
        }),
      );
    try {
      switch (parsed.action) {
        case "settings":
        case "contents": {
          const payload =
            parsed.action === "settings"
              ? settingsPanel()
              : toPanelPayload(
                  buildMonitorContentsPanel({ label, info: this.monitorInfo.get(key) }),
                );
          if (interaction.replyEphemeralPanel) await interaction.replyEphemeralPanel(payload);
          else await interaction.deferUpdate?.();
          return;
        }
        case "watch": {
          const next = !(entity ? this.isWatched(entity) : false);
          await this.panelStore.setEntityWatch(ids.serverId, ids.entityId, next);
          this.watchOverride.set(key, next);
          // Flip the button in the settings, then the row's 👁.
          if (interaction.update) await interaction.update(settingsPanel());
          else await interaction.deferUpdate?.();
          await this.renderPanels(ids.serverId, ["storage"], { immediate: true });
          return;
        }
        case "refresh": {
          // Read the contents now; a failure is reported after the acknowledgement.
          await interaction.deferUpdate?.();
          const info = await this.core.getEntity(ids.serverId, ids.entityId);
          await this.updateMonitor(ids.serverId, ids.entityId, info, true, { immediate: true });
          await interaction.editReply?.(settingsPanel());
          return;
        }
        default:
          if (this.isRemovalAction(parsed.action)) {
            await this.handleEntityRemoval(
              "monitor",
              parsed,
              interaction,
              ids,
              label,
              settingsPanel,
            );
            return;
          }
          await interaction.deferUpdate?.();
      }
    } catch (err) {
      this.log.warn({ err, ...ids, action: parsed.action }, "monitor action failed");
      await this.replyFailure(interaction, err);
    }
  }

  /**
   * Remember a storage monitor's latest contents and, when asked, repaint the
   * Storage message. `update` may be a full `getEntityInfo` result or an
   * `entityChanged` broadcast (which carries the same storage fields).
   * `repaint: "upkeep"` (an unwatched monitor's change) repaints only for a tool
   * cupboard's upkeep: at once when its {@link UpkeepState} changed, else when
   * the Storage message was last drawn from a monitor's contents at least
   * {@link UPKEEP_REPAINT_INTERVAL_MS} ago. `options` is passed to the repaint's
   * edit (`immediate` for a member's Refresh; a broadcast's repaint is
   * debounced, so a busy box becomes one edit).
   */
  private async updateMonitor(
    serverId: string,
    entityId: number,
    update: Partial<EntityInfo>,
    repaint: boolean | "upkeep",
    options: SubmitOptions = {},
  ): Promise<void> {
    const key = HandleRegistry.entityKey(serverId, entityId);
    const previous = this.monitorInfo.get(key);
    const info: EntityInfo = {
      entityId,
      type: "storageMonitor",
      items: update.items ?? [],
      capacity: update.capacity,
      hasProtection: update.hasProtection,
      protectionExpiry: update.protectionExpiry,
    };
    this.monitorInfo.set(key, info);
    const before: UpkeepState = previous ? upkeepState(previous) : "none";
    const after = upkeepState(info);
    if (before !== after) {
      this.log.info(
        {
          serverId,
          entityId,
          upkeep: after,
          was: before,
          hasProtection: info.hasProtection,
          protectionExpiry: info.protectionExpiry,
          capacity: info.capacity,
        },
        "storage monitor upkeep changed",
      );
    }
    this.armUpkeepCheck(serverId, entityId, info);
    const draw = repaint === "upkeep" ? this.upkeepRepaintDue(serverId, before, after) : repaint;
    if (!draw) return;
    this.storagePaintedAt.set(serverId, this.now().getTime());
    await this.renderPanels(serverId, ["storage"], options);
  }

  /**
   * Whether an unwatched monitor's change should repaint the Storage message:
   * never for a plain box; for a tool cupboard, at once when it starts or stops
   * protecting the base, else once {@link UPKEEP_REPAINT_INTERVAL_MS} has passed
   * since the message was last drawn from a monitor's contents.
   */
  private upkeepRepaintDue(serverId: string, before: UpkeepState, after: UpkeepState): boolean {
    if (before !== after) return true;
    if (after === "none") return false;
    const paintedAt = this.storagePaintedAt.get(serverId);
    return (
      paintedAt === undefined || this.now().getTime() - paintedAt >= UPKEEP_REPAINT_INTERVAL_MS
    );
  }

  /**
   * Arm (or move) a tool cupboard's re-read for just after its upkeep runs out,
   * so its row turns to "decaying" even if the cupboard never broadcasts again.
   * Disarmed when it reports no future expiry. A re-read that finds the expiry
   * moved on (someone refilled it) arms itself again through
   * {@link updateMonitor}; one that finds it still past does not, so it cannot loop.
   */
  private armUpkeepCheck(serverId: string, entityId: number, info: EntityInfo): void {
    const key = HandleRegistry.entityKey(serverId, entityId);
    const expiry = info.protectionExpiry ?? 0;
    if (this.upkeepChecks.get(key)?.expiry === expiry) return;
    this.clearUpkeepCheck(key);
    const untilExpiryMs = expiry * 1000 - this.now().getTime();
    if (expiry <= 0 || untilExpiryMs <= 0) return;
    const handle = this.timers.setTimer(
      () => {
        this.upkeepChecks.delete(key);
        void this.readUpkeep(serverId, entityId, "expiry");
      },
      // A longer wait is cut to the timer limit; reading early re-arms it.
      Math.min(untilExpiryMs + UPKEEP_RECHECK_GRACE_MS, MAX_TIMER_MS),
    );
    this.upkeepChecks.set(key, { handle, expiry });
  }

  /** Disarm both of a tool cupboard's pending reads: after a broadcast and at its expiry. */
  private clearUpkeepTimers(key: string): void {
    const read = this.upkeepReads.get(key);
    if (read !== undefined) this.timers.clearTimer(read);
    this.upkeepReads.delete(key);
    this.clearUpkeepCheck(key);
  }

  /** Disarm a tool cupboard's re-read at its upkeep expiry, if armed. */
  private clearUpkeepCheck(key: string): void {
    const armed = this.upkeepChecks.get(key);
    if (!armed) return;
    this.timers.clearTimer(armed.handle);
    this.upkeepChecks.delete(key);
  }

  /**
   * Read a tool cupboard directly, for the upkeep its broadcasts do not carry:
   * after a `change` (its broadcast), or at its upkeep `expiry`. A watched
   * cupboard's row is repainted; an unwatched one's as {@link updateMonitor}'s
   * `"upkeep"` decides, except at its expiry, which always repaints.
   * Best-effort: a failure (server offline) is logged, and the server's
   * reconnect refreshes every monitor anyway.
   */
  private async readUpkeep(
    serverId: string,
    entityId: number,
    occasion: "change" | "expiry",
  ): Promise<void> {
    const entity = this.core.listEntities(serverId).find((e) => e.entityId === entityId);
    if (entity?.entityType !== "storageMonitor") return;
    try {
      const info = await this.core.getEntity(serverId, entityId);
      const fields = { serverId, entityId, occasion, upkeep: upkeepState(info) };
      if (occasion === "expiry") this.log.info(fields, "tool cupboard read for its upkeep");
      else this.log.debug(fields, "tool cupboard read for its upkeep");
      const repaint = occasion === "expiry" || this.isWatched(entity) ? true : "upkeep";
      await this.updateMonitor(serverId, entityId, info, repaint);
    } catch (err) {
      this.log.warn(
        { err, serverId, entityId, occasion },
        "tool cupboard read for its upkeep failed",
      );
    }
  }

  // ── pairing cancel ───────────────────────────────────────────────────────────

  /**
   * [Cancel] on the transient pairing panel: stop the armed fcm wait and re-render
   * the panel to a disabled "cancelled" state. The panel isn't tracked by id, so
   * the edit goes through the interaction's own message via update().
   */
  private async handlePairingCancel(interaction: DispatchableInteraction): Promise<void> {
    await this.core.cancelPairing();
    // The armed wait is over; drop the stashed dismiss handle (the click itself
    // re-renders the ephemeral panel below).
    this.pairingDismiss = undefined;
    const payload = toPanelPayload(buildPairingPanel({ armed: false, cancelled: true }));
    if (interaction.update) {
      await interaction.update(payload);
    } else {
      await interaction.deferUpdate?.();
    }
  }

  // ── generic read/refresh actions ─────────────────────────────────────────────

  private async handleGenericAction(
    parsed: ParsedCustomId,
    _interaction: DispatchableInteraction,
  ): Promise<void> {
    // Refresh-style actions re-fetch + edit the relevant message.
    const serverId = parsed.server ? this.handles.idFor(parsed.server) : undefined;
    if (!serverId) return;
    try {
      switch (parsed.domain) {
        case "server": {
          // refresh: re-fetch status + team and edit the Server message.
          // Coalesced: a click while a refresh is already running for this server
          // is dropped. manual: grey the button out for the fetch window so the
          // click reads as working, and show the game clock.
          await this.refreshServerMessage(serverId, { coalesce: true, manual: true });
          return;
        }
        default:
          return;
      }
    } catch (err) {
      this.log.warn({ err, domain: parsed.domain }, "generic action failed");
    }
  }

  /**
   * Camera actions: 📷 Capture on its row (the still is shown ephemerally to
   * the member), and its settings from the "Manage a camera…" select (Rename,
   * Remove).
   */
  private async handleCamera(
    parsed: ParsedCustomId,
    interaction: DispatchableInteraction,
  ): Promise<void> {
    const ids = this.resolveEntity(parsed);
    if (!ids) {
      await interaction.deferUpdate?.();
      return;
    }
    const entity = this.core.listEntities(ids.serverId).find((e) => e.entityId === ids.entityId);
    const label = entity ? this.entityLabel(entity) : `camera ${ids.entityId}`;
    const settingsPanel = () =>
      toPanelPayload(
        buildCameraSettingsPanel({
          serverHandle: parsed.server ?? "",
          entityHandle: parsed.entity ?? "",
          label,
        }),
      );

    if (parsed.action === "settings") {
      if (interaction.replyEphemeralPanel) await interaction.replyEphemeralPanel(settingsPanel());
      else await interaction.deferUpdate?.();
      return;
    }
    if (this.isRemovalAction(parsed.action)) {
      try {
        await this.handleEntityRemoval("camera", parsed, interaction, ids, label, settingsPanel);
      } catch (err) {
        this.log.warn({ err, ...ids }, "camera removal failed");
        await this.replyFailure(interaction, err);
      }
      return;
    }
    if (parsed.action !== "capture") {
      await interaction.deferUpdate?.();
      return;
    }

    // Capture: acknowledge first (the subscribe→accumulate→render round-trip takes
    // ~1–2s, past the 3s interaction-ack budget), then post the rendered still.
    const key = HandleRegistry.entityKey(ids.serverId, ids.entityId);
    const cooling = this.cameraCooldowns.get(key);
    if (cooling) {
      // The button is disabled while cooling down, but a click from a panel
      // that has not been redrawn yet (or two members at once) can still land.
      const seconds = Math.max(1, Math.ceil((cooling.until - this.now().getTime()) / 1000));
      await interaction.replyEphemeral(
        `⏳ This camera was just captured. Try again in ${seconds}s.`,
      );
      return;
    }
    await interaction.deferUpdate?.();
    if (!entity) return;
    this.startCameraCooldown(ids.serverId, key);
    const identifier = entity.identifier ?? entity.label ?? String(ids.entityId);
    try {
      const bytes = await this.core.getCameraFrame(ids.serverId, identifier);
      const entityHandle = this.handles.register(key);
      const filename = `camera-${entityHandle}.png`;
      const capturedLabel = `${this.now().toISOString().replace("T", " ").slice(0, 19)} UTC`;
      const frame = (capturedBy?: string) => ({
        ...toPanelPayload(
          buildCameraFramePanel({ label, frameAttachment: filename, capturedLabel, capturedBy }),
        ),
        files: [new AttachmentBuilder(Buffer.from(bytes), { name: filename })],
      });
      // The still goes to the logging channel, @silent like every log line (an
      // ordinary message would notify every member left on "All Messages"),
      // mentioning who pressed Capture: it highlights for them and counts in
      // their mentions, and no one else's mention is parsed. With no logging
      // channel, or when that post fails, it is shown to the member alone
      // instead, so it is never lost.
      const logChannelId = this.core.getConfig().loggingChannelId;
      if (logChannelId) {
        const capturedBy = interaction.userId
          ? `<@${interaction.userId}>`
          : interaction.userName && `@${interaction.userName}`;
        const posted = await this.sendMessage(logChannelId, frame(capturedBy), {
          users: interaction.userId ? [interaction.userId] : [],
        });
        if (posted) {
          this.log.info({ ...ids, channelId: logChannelId }, "camera still posted to the log");
          return;
        }
      }
      await interaction.replyEphemeralPanel?.(frame());
    } catch (err) {
      this.log.warn({ err, ...ids }, "camera capture failed");
      await this.replyFailure(interaction, err);
    }
  }

  /**
   * Disable a camera's Capture for {@link CAMERA_COOLDOWN_MS}: redraw its row at
   * once with the button disabled, and again when the cooldown runs out.
   */
  private startCameraCooldown(serverId: string, key: string): void {
    const handle = this.timers.setTimer(() => {
      this.cameraCooldowns.delete(key);
      void this.renderPanels(serverId, ["cameras"], { immediate: true });
    }, CAMERA_COOLDOWN_MS);
    this.cameraCooldowns.set(key, { handle, until: this.now().getTime() + CAMERA_COOLDOWN_MS });
    void this.renderPanels(serverId, ["cameras"], { immediate: true });
  }

  // ── slash commands + modals ──────────────────────────────────────────────────

  private async handleSlashCommand(interaction: {
    commandName: string;
    guildId?: string | null;
    options: { getSubcommand(): string };
    member: unknown;
    reply(opts: {
      content?: string;
      components?: APIMessageTopLevelComponent[];
      flags?: number;
    }): Promise<unknown>;
  }): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const required = requiredCapabilityFor("setup", sub === "setup" ? "channel" : "");
    const cap = sub === "setup" ? "admin" : "user";
    const roleIds = this.extractRoleIds(interaction as unknown as Interaction);
    const allowed =
      isAllowed(roleIds, this.core.getConfig().roleCapabilities, cap as "admin" | "user") ||
      this.isGuildAdministrator(interaction as unknown as Interaction);
    void required;
    const user = this.extractUser(interaction as unknown as Interaction);
    if (!allowed) {
      await interaction.reply({
        content: DENIAL_MESSAGE,
        flags: MessageFlags.Ephemeral,
      });
      void this.writeAudit(
        auditDenied({
          time: this.now(),
          ...user,
          domain: "slash",
          action: sub,
        }),
      );
      return;
    }
    void this.writeAudit(auditSlash({ time: this.now(), ...user, command: `conduit ${sub}` }));
    if (sub === "setup") {
      // The Setup hub is a transient, admin-only config surface: always render it
      // as the ephemeral reply itself (visible only to the invoking admin, no
      // lingering channel message). Hub actions edit this ephemeral message in
      // place; device panels it spawns are posted persistently to the control
      // channel. Roles named for Conduit are adopted first if none are chosen,
      // so the hub opens with them selected (cache only: no delay to the reply).
      await this.adoptConduitRoles(
        interaction.guildId ?? this.guildId ?? this.core.getConfig().discordGuildId,
        "setup",
      );
      const payload = this.setupHubPayload();
      await interaction.reply({
        components: payload.components,
        flags: payload.flags | MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: this.quickStatus(),
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async handleModalSubmit(interaction: {
    customId: string;
    member?: unknown;
    fields: { getTextInputValue(id: string): string };
    /** Set by discord.js once the interaction has been replied to / deferred. */
    replied?: boolean;
    deferred?: boolean;
    reply(opts: {
      content?: string;
      components?: APIMessageTopLevelComponent[];
      flags?: number;
    }): Promise<unknown>;
    /** Acknowledge now with a pending reply; `editReply` then fills it in. */
    deferReply(opts: { flags?: number }): Promise<unknown>;
    editReply(opts: { content: string }): Promise<unknown>;
    followUp(opts: { content: string; flags?: number }): Promise<unknown>;
  }): Promise<void> {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;

    // ── per-click permission check — no interaction bypasses this ──
    const required = requiredCapabilityFor(parsed.domain, parsed.action);
    const roleIds = this.extractRoleIds(interaction as unknown as Interaction);
    const config = this.core.getConfig();
    const allowed =
      isAllowed(roleIds, config.roleCapabilities, required) ||
      (this.isGuildAdministrator(interaction as unknown as Interaction) &&
        ADMIN_BYPASS_DOMAINS.has(parsed.domain));
    const user = this.extractUser(interaction as unknown as Interaction);
    if (!allowed) {
      const hasAnyRole = isAllowed(roleIds, config.roleCapabilities, "user");
      await interaction.reply({
        content: hasAnyRole || required === "admin" ? DENIAL_MESSAGE : NO_ROLE_MESSAGE,
        flags: MessageFlags.Ephemeral,
      });
      void this.writeAudit(
        auditDenied({
          time: this.now(),
          ...user,
          domain: parsed.domain,
          action: parsed.action,
        }),
      );
      return;
    }

    // Every handler follows the same three steps:
    //   1. validate the input and answer bad input at once (`rejectInput`) —
    //      nothing slow has happened yet;
    //   2. `acknowledge()` with a deferred ephemeral reply BEFORE touching
    //      bot-core or Discord REST. Discord drops an interaction that is not
    //      acknowledged within 3 seconds, and that work (a Rust+ round-trip, a
    //      panel edit, a panel layout) has no such bound;
    //   3. `finish()` by editing the deferred reply into the outcome.
    const ephemeral = MessageFlags.Ephemeral;
    let outcomeSent = false;
    let outcome: "ok" | "rejected" | "failed" = "ok";
    const rejectInput = async (content: string): Promise<void> => {
      outcome = "rejected";
      await interaction.reply({ content, flags: ephemeral });
    };
    const acknowledge = async (): Promise<void> => {
      await interaction.deferReply({ flags: ephemeral });
    };
    const finish = async (content: string): Promise<void> => {
      await interaction.editReply({ content });
      outcomeSent = true;
    };
    // The one exception to step 2: an outcome that needs no slow work at all
    // (no bot-core call, no panel edit), such as the next step of a form, is
    // answered at once with an ephemeral panel. That reply is the acknowledgement.
    const answerWithPanel = async (payload: PanelPayload): Promise<void> => {
      await interaction.reply({
        components: payload.components,
        flags: payload.flags | ephemeral,
      });
      outcomeSent = true;
    };

    try {
      if (parsed.domain === "pairing" && parsed.action === "label") {
        const ids = this.resolveEntity(parsed);
        if (!ids) {
          // The device behind this modal is gone (stale handles): say so rather
          // than claim the label was saved.
          await rejectInput(STALE_STATE_MESSAGE);
          return;
        }
        const label = interaction.fields.getTextInputValue("label");
        await acknowledge();
        await this.core.setEntityLabel(ids.serverId, ids.entityId, label);
        void this.writeAudit(
          auditModal({ time: this.now(), ...user, summary: `labelled device "${label}"` }),
        );
        // Report success as soon as the label is persisted; laying out the panel
        // below is the slow part, and a failure there is reported as a follow-up.
        await finish("✅ Saved.");
        // The label is the sort key: the row moves into alphabetical order within
        // its type's message, which is an edit in place, never a repost.
        await this.syncGroup(ids.serverId);
      } else if (parsed.domain === "switch" && parsed.action === "autodelay") {
        const ids = this.resolveEntity(parsed);
        const raw = interaction.fields.getTextInputValue("seconds").trim();
        const seconds = Number(raw);
        if (
          !ids ||
          !Number.isInteger(seconds) ||
          seconds < SWITCH_AUTO_DELAY_MIN ||
          seconds > SWITCH_AUTO_DELAY_MAX
        ) {
          await rejectInput(
            `⚠️ Enter a whole number of seconds between ${SWITCH_AUTO_DELAY_MIN} and ${SWITCH_AUTO_DELAY_MAX}.`,
          );
          return;
        }
        // Persisting the delay re-arms the auto-revert timer, which reads the
        // switch's live state from the server — acknowledge first.
        await acknowledge();
        await this.core.setSwitchAutoDelaySeconds(ids.serverId, ids.entityId, seconds);
        // Repaint the Switches message so the row's auto-revert line shows the new delay.
        await this.renderPanels(ids.serverId, ["switches"], { immediate: true });
        void this.writeAudit(
          auditModal({ time: this.now(), ...user, summary: `set auto-revert delay ${seconds}s` }),
        );
        await finish(`✅ Auto-revert delay set to ${seconds}s. Reopen Settings to see it.`);
      } else if (parsed.domain === "group" && parsed.action === "create") {
        // A new switch group's name; its members are picked next.
        const serverId = parsed.server ? this.handles.idFor(parsed.server) : undefined;
        const name = interaction.fields.getTextInputValue("name").trim();
        if (
          !parsed.server ||
          !serverId ||
          !this.core.listServers().some((s) => s.id === serverId)
        ) {
          await rejectInput(STALE_STATE_MESSAGE);
          return;
        }
        if (!name) {
          await rejectInput("⚠️ Give the group a name.");
          return;
        }
        const candidates = this.groupCandidates(serverId);
        if (candidates.length === 0) {
          await rejectInput(NO_UNGROUPED_SWITCH_MESSAGE);
          return;
        }
        // Nothing slow: the switches are bot-core's in-memory state. The name
        // waits in a draft (a custom ID cannot carry free text).
        const token = this.newGroupDraft(serverId, name);
        await answerWithPanel(
          this.groupPickerPayload(
            `New group: ${name}`,
            buildCustomId({
              domain: "group",
              action: "create-members",
              server: parsed.server,
              entity: token,
            }),
            candidates,
          ),
        );
      } else if (parsed.domain === "group" && parsed.action === "rename") {
        const g = this.resolveGroup(parsed);
        const name = interaction.fields.getTextInputValue("name").trim();
        if (!g) {
          await rejectInput(STALE_STATE_MESSAGE);
          return;
        }
        if (!name) {
          await rejectInput("⚠️ Give the group a name.");
          return;
        }
        await acknowledge();
        await this.core.renameSwitchGroup(g.serverId, g.group.id, name);
        void this.writeAudit(
          auditModal({ time: this.now(), ...user, summary: `renamed switch group "${name}"` }),
        );
        await finish("✅ Renamed.");
        // The name is the sort key: the row moves within the Switches message.
        await this.syncGroup(g.serverId);
      } else if (parsed.domain === "setup" && parsed.action === "cameraAdd") {
        const serverId = parsed.server ? this.handles.idFor(parsed.server) : undefined;
        const identifier = interaction.fields.getTextInputValue("identifier").trim();
        const label = interaction.fields.getTextInputValue("label").trim();
        if (!serverId || !identifier) {
          await rejectInput("⚠️ A camera identifier is required.");
          return;
        }
        await acknowledge();
        await this.core.addCamera(serverId, identifier, label || undefined);
        // addCamera emits `entityPaired`, which drives onEntityPaired → the panel
        // layout (same path as FCM-paired switches/alarms). Nothing to lay out here.
        void this.writeAudit(
          auditModal({ time: this.now(), ...user, summary: `added camera "${identifier}"` }),
        );
        await finish(
          "✅ Camera added. Use **Capture** on its row in the Cameras panel to grab a still. " +
            "Rust+ can't show cameras while you're connected to the server in-game.",
        );
      } else if (parsed.domain === "setup" && parsed.action === "pushover") {
        const appToken = interaction.fields.getTextInputValue("appToken").trim();
        const userKey = interaction.fields.getTextInputValue("userKey").trim();
        if (!appToken && !userKey) {
          await acknowledge();
          await this.core.clearPushoverCredentials();
          void this.writeAudit(
            auditModal({ time: this.now(), ...user, summary: "disabled Pushover" }),
          );
          await finish("✅ Pushover disabled.");
        } else if (appToken && userKey) {
          await acknowledge();
          await this.core.setPushoverCredentials(appToken, userKey);
          void this.writeAudit(
            auditModal({ time: this.now(), ...user, summary: "set Pushover credentials" }),
          );
          await finish("✅ Pushover configured.");
        } else {
          // Exactly one field filled — reject rather than store a half-credential.
          await rejectInput(
            "⚠️ Pushover needs **both** the application token and the user/group key. Enter both, or leave both empty to disable.",
          );
        }
      } else {
        // A permitted modal this build has no handler for (e.g. one opened from a
        // panel posted by an older version). Acknowledge it so the member is not
        // left looking at a spinner that ends in "Something went wrong".
        await rejectInput("⚠️ That form is no longer available. Reopen the menu and try again.");
      }
    } catch (err) {
      outcome = "failed";
      this.log.error({ err }, "modal submit failed");
      void this.writeAudit(
        auditFailure({
          time: this.now(),
          ...user,
          summary: `${parsed.domain}:${parsed.action}`,
          reason: shortFailureReason(err),
        }),
      );
      // Report the failure through whichever call the interaction's state allows
      // — a second reply() would throw InteractionAlreadyReplied and the member
      // would never see the error:
      //   - acknowledged, outcome not sent yet → edit the deferred reply (this
      //     replaces the pending "thinking…" placeholder);
      //   - outcome already shown (the label path fails laying out the panel) → add
      //     a follow-up below it;
      //   - never acknowledged → reply.
      // The send itself can fail (token expired): log it, never throw.
      const content = friendlyError(err);
      const awaitingOutcome = Boolean(interaction.deferred) && !outcomeSent;
      try {
        if (awaitingOutcome) await interaction.editReply({ content });
        else if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content, flags: ephemeral });
        } else await interaction.reply({ content, flags: ephemeral });
      } catch (replyErr) {
        this.log.warn({ replyErr, customId: interaction.customId }, "error reply failed");
      }
    } finally {
      this.log.info(this.interactionLogFields(parsed, user.userId, outcome), "modal handled");
    }
  }

  private quickStatus(): string {
    const servers = this.core.listServers();
    if (servers.length === 0) return "No servers paired yet — pair one in-game to begin.";
    return servers.map((s) => `🛰 ${s.name}`).join("\n");
  }

  // ── domain events → panels ───────────────────────────────────────────────────

  /**
   * Subscribe to bot-core's domain events. Every listener is registered through
   * `listen`/`listenRaw`, which record how to detach it, so {@link stop} can
   * remove exactly what was added here. Starts by detaching any previous set, so
   * the wiring can never be stacked.
   */
  private wireDomainEvents(): void {
    this.unwireDomainEvents();

    // bot-core is an EventEmitter; its typed `on` overload has no `off` twin, so
    // the untyped emitter surface is used to register and remove by reference.
    const emitter = this.core as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): unknown;
      off(event: string, listener: (...args: unknown[]) => void): unknown;
    };
    const listenRaw = (event: string, listener: (...args: unknown[]) => void): void => {
      emitter.on(event, listener);
      this.domainUnsubscribers.push(() => emitter.off(event, listener));
    };
    const listen = <E extends keyof BotCoreEventMap>(
      event: E,
      listener: (...args: BotCoreEventMap[E]) => void,
    ): void => listenRaw(event, listener as (...args: unknown[]) => void);

    listen("entityChanged", ({ serverId, change }) => {
      void this.onEntityChanged(serverId, change);
    });
    listen("entityRefreshed", ({ serverId, entityId, info }) => {
      void this.onEntityRefreshed(serverId, entityId, info);
    });
    listen("authRenewalNeeded", (notice) => {
      void this.onAuthRenewalNeeded(notice);
    });
    listen("serverStatusChanged", (change) => {
      void this.onServerStatusChanged(change);
    });
    listen("alarmTriggered", (alarm) => {
      void this.onAlarmTriggered(alarm);
    });
    listen("playerDeath", (death) => {
      void this.onPlayerDeath(death);
    });
    listen("teamChat", ({ serverId, message }) => {
      void this.onTeamChat(serverId, message);
    });
    listen("entityPaired", (entity) => {
      void this.onEntityPaired(entity);
    });
    listen("entityRemoved", ({ serverId, entityId }) => {
      void this.onEntityRemoved(serverId, entityId);
    });
    listen("serverPaired", (server) => {
      void this.onServerPaired(server);
    });
  }

  /** Remove every bot-core listener {@link wireDomainEvents} registered. */
  private unwireDomainEvents(): void {
    const detach = this.domainUnsubscribers;
    this.domainUnsubscribers = [];
    for (const off of detach) off();
  }

  /** entityChanged closes the switch state-lock, and repaints the device's row. */
  async onEntityChanged(serverId: string, change: EntityChange): Promise<void> {
    const key: LockKey = { serverId, entityId: change.entityId };
    const entity = this.core.listEntities(serverId).find((e) => e.entityId === change.entityId);
    // Watch is a storage monitor's "tell me about changes" switch: when it is
    // off, its changes are still recorded (Refresh shows them) but post no line
    // and repaint the panel only for a tool cupboard's upkeep, at a bounded rate
    // (see updateMonitor), so a busy box can't flood the logging channel or
    // spend the channel's edit rate limit.
    const announce = entity?.entityType !== "storageMonitor" || this.isWatched(entity);
    // The confirmation of a group action's member: the group action wrote the
    // one audit line, so this change writes none of its own.
    const pending = this.stateLock.snapshot(key);
    const groupConfirm =
      this.groupClicked.delete(lockId(key)) &&
      pending?.phase === "pending" &&
      pending.requested === (change.value ?? false);
    if (entity && announce && !groupConfirm) {
      const line = auditEntityChange({
        time: this.now(),
        label: entity.label ?? entity.entityType,
        entityType: entity.entityType,
        value: change.value,
      });
      // A firing alarm (rising edge) notifies per its notification level; every
      // other change, an alarm resetting included, is a silent log line. The
      // @here alert stays a plain-text line: a mention inside a Components V2
      // message pushes an empty notification.
      if (entity.entityType === "alarm" && change.value === true) {
        const { text, delivery } = alarmMentionPrefix(entity.notificationLevel);
        void this.writeAudit(`${text}${line}`, delivery);
      } else {
        void this.writeAudit(line);
      }
    }
    if (entity?.entityType === "switch") {
      // The confirmation of a click is shown at once (the member is watching
      // "Switching…"); a change made elsewhere (in game) is debounced.
      const clicked = this.stateLock.snapshot(key)?.phase === "pending";
      const result = this.stateLock.confirm(key, change.value ?? false);
      if (result.changed) {
        await this.renderPanels(serverId, ["switches"], { immediate: clicked });
      }
    } else if (entity?.entityType === "alarm") {
      // The alarm's line (and its message) is red while it sounds.
      if (this.setAlarmFiring(serverId, change.entityId, change.value ?? false)) {
        await this.renderPanels(serverId, ["alarms"]);
      }
    } else if (entity?.entityType === "storageMonitor") {
      await this.onMonitorChanged(serverId, change, announce);
    }
  }

  /**
   * A storage monitor's broadcast. Its contents are always kept (Refresh and
   * later repaints show them), and a watched monitor's row is repainted.
   *
   * A tool cupboard's broadcast carries its new contents but not its new
   * upkeep: seen live, emptying one broadcast the empty contents with the
   * expiry from before, and refilling one broadcast the old "no expiry", while
   * a direct read had the true value. So its broadcast keeps the upkeep last
   * read, and the cupboard is read again once the burst settles
   * ({@link UPKEEP_REREAD_DELAY_MS}); that read decides an unwatched
   * cupboard's repaint.
   */
  private async onMonitorChanged(
    serverId: string,
    change: EntityChange,
    watched: boolean,
  ): Promise<void> {
    const { entityId } = change;
    const known = this.monitorInfo.get(HandleRegistry.entityKey(serverId, entityId));
    const cupboard =
      upkeepState(change) !== "none" || (known !== undefined && upkeepState(known) !== "none");
    if (!cupboard) {
      await this.updateMonitor(serverId, entityId, change, watched ? true : "upkeep");
      return;
    }
    const update = known
      ? { ...change, hasProtection: known.hasProtection, protectionExpiry: known.protectionExpiry }
      : change;
    await this.updateMonitor(serverId, entityId, update, watched);
    this.scheduleUpkeepRead(serverId, entityId);
  }

  /**
   * Read a tool cupboard {@link UPKEEP_REREAD_DELAY_MS} after its latest
   * broadcast; each broadcast in the meantime pushes the read back, so a
   * burst (several stacks taken out) costs one read.
   */
  private scheduleUpkeepRead(serverId: string, entityId: number): void {
    const key = HandleRegistry.entityKey(serverId, entityId);
    const pending = this.upkeepReads.get(key);
    if (pending !== undefined) this.timers.clearTimer(pending);
    this.upkeepReads.set(
      key,
      this.timers.setTimer(() => {
        this.upkeepReads.delete(key);
        void this.readUpkeep(serverId, entityId, "change");
      }, UPKEEP_REREAD_DELAY_MS),
    );
  }

  /** Record whether an alarm is sounding; true when that changed what its line shows. */
  private setAlarmFiring(serverId: string, entityId: number, firing: boolean): boolean {
    const key = HandleRegistry.entityKey(serverId, entityId);
    const changed = (this.alarmFiring.get(key) ?? false) !== firing;
    this.alarmFiring.set(key, firing);
    return changed;
  }

  /**
   * A device's state as read when its server (re)connected. Settles a switch's
   * lock on the server's value, an alarm's sounding state and a monitor's
   * contents, and repaints the row if that changed it, so a device that changed
   * during an outage stops showing its old state. Not a change event: nothing is
   * written to the audit log.
   */
  async onEntityRefreshed(serverId: string, entityId: number, info: EntityInfo): Promise<void> {
    const entity = this.core.listEntities(serverId).find((e) => e.entityId === entityId);
    switch (entity?.entityType) {
      case "storageMonitor":
        await this.updateMonitor(serverId, entityId, info, true);
        return;
      case "alarm":
        if (this.setAlarmFiring(serverId, entityId, info.value ?? false)) {
          await this.renderPanels(serverId, ["alarms"]);
        }
        return;
      case "switch": {
        const result = this.stateLock.confirm({ serverId, entityId }, info.value ?? false);
        if (result.changed) await this.renderPanels(serverId, ["switches"]);
        return;
      }
      default:
        return;
    }
  }

  /**
   * A server's connection changed. bot-core holds a dropped server at
   * `reconnecting` for its grace period, so a blip is reconnecting → connected:
   * the panel shows 🟡 and disables its actions meanwhile, but nothing goes to
   * the logging channel. Only going `offline`, and coming back from it, write a
   * line.
   */
  private async onServerStatusChanged(change: {
    serverId: string;
    status: ServerConnectionStatus;
    previous: ServerConnectionStatus;
  }): Promise<void> {
    const { serverId, status, previous } = change;
    const server = this.core.listServers().find((s) => s.id === serverId);
    const line =
      status === "offline"
        ? ("offline" as const)
        : status === "connected" && previous === "offline"
          ? ("online" as const)
          : undefined;
    if (line) {
      void this.writeAudit(
        auditServerStatus({ time: this.now(), name: server?.name ?? serverId, status: line }),
      );
    }
    // Every message shows the connection: its accent, the Server message's
    // status, and every action button (disabled unless connected). A
    // "connected" event also pulls the live players/queue and team first.
    await this.fetchServerData(serverId, { clock: false });
    await this.renderPanels(serverId, PANEL_KINDS);
  }

  /**
   * The Steam sign-in needs renewing (one of bot-core's escalating reminders,
   * or a rejection). Posted to the logging channel, or to the control channel
   * when there is none, as a notifying message that @mentions the Conduit admin
   * roles: without a renewed sign-in Conduit loses its servers, so this must
   * reach the people who can fix it. With no admin roles set it still notifies.
   */
  async onAuthRenewalNeeded(notice: {
    reason: "expiring" | "expired" | "rejected";
    expiresAt?: string;
  }): Promise<void> {
    const config = this.core.getConfig();
    const channelId = config.loggingChannelId ?? config.controlChannelId;
    if (!channelId) return;
    const roles = [...new Set(config.roleCapabilities.admin)];
    const line = auditAuthRenewal({ time: this.now(), ...notice });
    await this.sendText(channelId, `${roleMentionPrefix(roles)}${line}`, {
      notify: true,
      mentions: { roles },
    });
  }

  // Alarm + death are audit-log events: they post a plain line to the logging
  // channel (no control-channel panel). No-op when no logging channel is set.
  // The FCM alarm push names no paired alarm entity, so it has no level of its
  // own: it notifies as Normal (no mention).
  private async onAlarmTriggered(alarm: { title: string; message: string }): Promise<void> {
    await this.writeAudit(
      auditAlarm({ time: this.now(), title: alarm.title, message: alarm.message }),
      { notify: true },
    );
  }

  private async onPlayerDeath(death: { name: string; message?: string }): Promise<void> {
    await this.writeAudit(
      auditDeath({ time: this.now(), name: death.name, message: death.message }),
    );
  }

  private async onTeamChat(
    serverId: string,
    message: { name: string; message: string },
  ): Promise<void> {
    void this.writeAudit(
      auditTeamChat({
        time: this.now(),
        name: message.name,
        message: message.message,
      }),
    );
    // A team-chat message implies the roster may have shifted; re-fetch and
    // edit the Server message, which carries the team line.
    await this.refreshServerMessage(serverId, { coalesce: true });
  }

  private async onEntityPaired(entity: PairedEntity): Promise<void> {
    const server = this.core.listServers().find((s) => s.id === entity.serverId);
    if (!server) return;
    void this.writeAudit(
      auditEntityPaired({
        time: this.now(),
        label: entity.label ?? `entity ${entity.entityId}`,
        entityType: entity.entityType,
      }),
    );
    // A row is about to be shown for this device: register interest so the
    // server starts broadcasting its changes (it only does so after a
    // getEntityInfo), and seed a switch's lock with its real state so the row
    // shows it instead of "Unknown". Without this a freshly paired device
    // stayed silent until the next restart or "Rebuild panels".
    await this.registerInterestAndSeed(entity, "pairing");
    // bot-core upserts the entity before emitting `entityPaired`, so it is already
    // in `listEntities`. Its row lands in alphabetical order within its type's
    // message; the first device of a type reposts the group, to keep the order.
    await this.syncGroup(entity.serverId);
    // Auto-dismiss the transient ephemeral pairing panel now the device is paired
    // and on the panel. Best-effort: the interaction token may have expired
    // (pairing took >15 min).
    if (this.pairingDismiss) {
      const dismiss = this.pairingDismiss;
      this.pairingDismiss = undefined;
      try {
        await dismiss.delete();
      } catch (err) {
        this.log.warn({ err }, "pairing panel auto-dismiss failed (token expired?)");
      }
    }
  }

  /**
   * An entity was removed from state. Take its row off the panel: its type's
   * message is edited, or deleted when it was the last device of that type.
   */
  private async onEntityRemoved(serverId: string, entityId: number): Promise<void> {
    void this.writeAudit(
      auditInteraction({
        time: this.now(),
        userId: undefined,
        userName: undefined,
        summary: `entity removed: ${serverId}:${entityId}`,
      }),
    );
    // Drop any switch lock for it, so a still-pending confirmation timeout does
    // not fire later for a device that no longer exists.
    this.stateLock.forget({ serverId, entityId });
    this.groupClicked.delete(lockId({ serverId, entityId }));
    const key = HandleRegistry.entityKey(serverId, entityId);
    this.monitorInfo.delete(key);
    this.clearUpkeepTimers(key);
    this.alarmFiring.delete(key);
    this.watchOverride.delete(key);
    await this.syncGroup(serverId);
  }

  private async onServerPaired(server: PairedServer): Promise<void> {
    void this.writeAudit(auditServerPaired({ time: this.now(), name: server.name }));
    // From the server's current connection: a new server shows offline until
    // the connect event brings in its live status and team; a re-paired one that
    // stayed connected shows it live (its connection did not change, so no
    // event will).
    await this.fetchServerData(server.id, { clock: false });
    // A re-pair (in-game "Resend Pair", or a new playerToken) keeps the panel:
    // edited in place, forced, which also learns whether it still exists. A new
    // server, or one whose panel is gone (10008), has its group posted. Any other
    // failure keeps the ids, and the next render retries. The stored ids
    // are read inside the queue: an operation queued earlier (a reconstruct, say)
    // may have posted this server's panel meanwhile.
    await this.withPanelQueue(() => this.syncGroupUnqueued(server.id, { verify: true }));
  }

  // ── posting helpers ──────────────────────────────────────────────────────────

  /** Post a panel to the configured control channel. Returns its id, or undefined. */
  private async postMessage(payload: {
    components: unknown[];
    flags: number;
    files?: unknown[];
    attachments?: unknown[];
  }): Promise<PanelRef | undefined> {
    const channelId = this.core.getConfig().controlChannelId;
    if (!channelId) {
      this.log.warn({}, "no control channel; cannot post panel");
      return undefined;
    }
    return this.sendMessage(channelId, payload);
  }

  /**
   * Low-level send to a channel id; resolves the channel via the client
   * cache/fetch. Always `@silent`. `delivery.users` lists the only user ids
   * whose mentions Discord may act on (a camera still mentions the member who
   * captured it); by default no mention is.
   */
  private async sendMessage(
    channelId: string,
    payload: {
      components: unknown[];
      flags: number;
      files?: unknown[];
      attachments?: unknown[];
    },
    delivery: { users?: readonly string[] } = {},
  ): Promise<PanelRef | undefined> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) return undefined;
    try {
      // Panels are status displays, never alerts: post them @silent, and never let
      // a device or server name ping anyone. Discord accepts the suppress
      // flag only when a message is created, so edits leave it out.
      const users = delivery.users ?? [];
      const message = await channel.send({
        ...payload,
        flags: payload.flags | MessageFlags.SuppressNotifications,
        allowedMentions:
          users.length > 0
            ? { ...PANEL_ALLOWED_MENTIONS, users: [...users] }
            : PANEL_ALLOWED_MENTIONS,
      } as never);
      this.unreachableChannels.delete(channelId);
      return { messageId: message.id };
    } catch (err) {
      this.log.error({ err, channelId }, "send panel failed");
      this.reportPostError(channelId, err);
      return undefined;
    }
  }

  /**
   * Surface a failed send to the host (tray health) instead of only logging it.
   * Pulls Discord's numeric error `code` off a `DiscordAPIError` when present so
   * the host can distinguish a permission/access problem (50013 / 50001) — the
   * "the bot can't post here" case — from a generic transient failure.
   */
  private reportPostError(channelId: string, err: unknown): void {
    const code = (err as { code?: unknown })?.code;
    const numericCode = typeof code === "number" ? code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    this.onPostError({
      channelId,
      code: numericCode,
      message,
      permission: numericCode === 50013 || numericCode === 50001,
      ...(numericCode === DISCORD_EDIT_CAP ? { editCap: true } : {}),
    });
  }

  /**
   * Append one plain-text line to the configured logging channel. No-op when no
   * logging channel is set (logging is opt-in). Best-effort: a failed send is
   * logged and swallowed so it never disrupts the originating action. Silent
   * and mention-free unless `delivery` says otherwise (see {@link sendText}).
   */
  private async writeAudit(line: string, delivery: AuditDelivery = {}): Promise<void> {
    const channelId = this.core.getConfig().loggingChannelId;
    if (!channelId) return;
    await this.sendText(channelId, line, delivery);
  }

  /**
   * Low-level plain-text send to a channel id (the audit-log path). By default
   * the line is `@silent` (the suppress-notifications flag: it marks the
   * channel unread but pushes nothing) and Discord parses no mentions in it, so
   * a device label or team-chat message containing `@everyone` never pings.
   * `delivery.notify` sends it as an ordinary message; `delivery.mentions`
   * opts in to exactly the mentions the caller put in the line.
   */
  private async sendText(
    channelId: string,
    content: string,
    delivery: AuditDelivery = {},
  ): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) return;
    const roles = delivery.mentions?.roles;
    const allowedMentions = {
      parse: delivery.mentions?.everyone ? ["everyone"] : [],
      ...(roles && roles.length > 0 ? { roles: [...roles] } : {}),
    };
    try {
      await channel.send({
        content,
        allowedMentions,
        ...(delivery.notify ? {} : { flags: MessageFlags.SuppressNotifications }),
      } as never);
    } catch (err) {
      this.log.error({ err, channelId }, "send audit line failed");
      this.reportPostError(channelId, err);
    }
  }

  /**
   * Live-edit a stored panel in the control channel through the edit pipeline.
   * Every in-place edit of a known panel comes through here:
   * - an edit identical to the last one sent to that panel is skipped;
   * - an automatic edit (a broadcast, a reconnect, the periodic refresh) waits
   *   out a short debounce, so a burst of changes becomes one edit;
   * - `immediate` is for a member's click: no debounce (switch feedback must not
   *   lag), but an identical payload is still skipped;
   * - `force` edits even when nothing changed (the reconcile, which edits to
   *   learn whether the panel still exists);
   * - one edit per panel is in flight at a time, and after a 30046 the panel's
   *   edits pause instead of retrying.
   * An `immediate` edit resolves with what became of it (see
   * {@link SubmitOutcome}). A debounced one resolves `queued` at once, so no
   * caller (a domain-event handler, or the panel queue) waits out the debounce;
   * the pipeline never rejects, so nothing is left unhandled.
   */
  private async editPanel(
    messageId: string,
    payload: PanelEditPayload,
    options: SubmitOptions = {},
  ): Promise<SubmitOutcome | "queued"> {
    const result = this.edits.submit(messageId, payload, options);
    return options.immediate || !this.debounceEdits ? result : "queued";
  }

  /**
   * Edit a stored panel message (never the interaction webhook): the edit
   * pipeline's one write; call {@link editPanel} instead. Only a `gone` outcome
   * (10008 Unknown Message) means the panel no longer exists; see
   * {@link PanelWriteOutcome}.
   */
  private async editMessage(
    channelId: string | undefined,
    messageId: string,
    payload: PanelEditPayload,
  ): Promise<PanelWriteOutcome> {
    return this.writePanel("edit", channelId, messageId, (m) =>
      m.edit({ ...payload, allowedMentions: PANEL_ALLOWED_MENTIONS } as never),
    );
  }

  /**
   * Delete a stored panel message; outcomes as for {@link editMessage}. Drops
   * any edit still waiting for it in the pipeline.
   */
  private async deleteMessage(
    channelId: string | undefined,
    messageId: string,
  ): Promise<PanelWriteOutcome> {
    this.edits.forget(messageId);
    return this.writePanel("delete", channelId, messageId, (m) => m.delete());
  }

  /** Fetch a stored panel message and edit or delete it, classifying any failure. */
  private async writePanel(
    op: "edit" | "delete",
    channelId: string | undefined,
    messageId: string,
    write: (message: ChannelMessage) => Promise<unknown>,
  ): Promise<PanelWriteOutcome> {
    if (!channelId) return "unreachable";
    if (!this.client) return "failed";
    try {
      const channel = await this.lookupTextChannel(channelId);
      if (!channel) {
        return this.panelChannelUnreachable(op, channelId, messageId, undefined);
      }
      await write(await channel.messages.fetch(messageId));
    } catch (err) {
      const outcome = panelErrorOutcome(err);
      if (outcome === "gone") {
        this.log.info({ op, channelId, messageId }, "panel message is gone");
      } else if (outcome === "unreachable") {
        this.panelChannelUnreachable(op, channelId, messageId, err);
      } else if (outcome === "capped") {
        // The edit pipeline asks rebuildOnEditCap whether to rebuild or pause;
        // that path logs it and tells the host.
      } else {
        this.log.warn({ op, err, channelId, messageId }, "panel write failed; keeping its id");
      }
      return outcome;
    }
    this.unreachableChannels.delete(channelId);
    return "ok";
  }

  /**
   * Record that the control channel could not be reached for a panel write.
   * Warn and tell the host the first time; after that only debug, until a write
   * to the channel succeeds again, so a lost permission does not flood the log.
   */
  private panelChannelUnreachable(
    op: "edit" | "delete",
    channelId: string,
    messageId: string,
    err: unknown,
  ): "unreachable" {
    if (this.unreachableChannels.has(channelId)) {
      this.log.debug({ op, channelId, messageId }, "panel channel still unreachable");
      return "unreachable";
    }
    this.unreachableChannels.add(channelId);
    this.log.warn(
      { op, err, channelId, messageId },
      "panel channel unreachable; keeping stored panel ids",
    );
    if (err !== undefined) this.reportPostError(channelId, err);
    return "unreachable";
  }

  /** Resolve a text-sendable channel by id, fetching when not cached; logs a failure. */
  private async fetchTextChannel(channelId: string): Promise<TextChannelLike | undefined> {
    if (!this.client) return undefined;
    try {
      return asTextChannel(
        this.client.channels.cache.get(channelId) ?? (await this.client.channels.fetch(channelId)),
      );
    } catch (err) {
      this.log.warn({ err, channelId }, "channel fetch failed");
      return undefined;
    }
  }

  /**
   * Resolve a text-sendable channel by id, fetching when not cached. Throws what
   * the fetch throws; undefined when not logged in or the channel cannot hold
   * messages.
   */
  private async lookupTextChannel(channelId: string): Promise<TextChannelLike | undefined> {
    if (!this.client) return undefined;
    return asTextChannel(
      this.client.channels.cache.get(channelId) ?? (await this.client.channels.fetch(channelId)),
    );
  }

  // ── small helpers ────────────────────────────────────────────────────────────

  /** Resolve a parsed customId's server+entity handles back to ids. */
  private resolveEntity(
    parsed: ParsedCustomId,
  ): { serverId: string; entityId: number } | undefined {
    if (!parsed.server || !parsed.entity) return undefined;
    const serverId = this.handles.idFor(parsed.server);
    const entityKey = this.handles.idFor(parsed.entity);
    if (!serverId || !entityKey) return undefined;
    // entityKey is "serverId/entityId" (see HandleRegistry.entityKey). A
    // "Manage…" select's value names the entity on its own, so check it belongs
    // to the server the control is for.
    const slash = entityKey.lastIndexOf("/");
    if (slash < 0 || entityKey.slice(0, slash) !== serverId) return undefined;
    const entityId = Number(entityKey.slice(slash + 1));
    if (!Number.isFinite(entityId)) return undefined;
    return { serverId, entityId };
  }

  /** Pull the invoking user's id/username off any interaction (for the audit log). */
  private extractUser(interaction: Interaction): {
    userId?: string;
    userName?: string;
  } {
    const user = (interaction as { user?: { id?: string; username?: string } }).user;
    return { userId: user?.id, userName: user?.username };
  }

  /** Pull role ids off an interaction member, tolerating both cache shapes. */
  private extractRoleIds(interaction: Interaction): string[] {
    const member = (interaction as { member?: unknown }).member;
    if (!member || typeof member !== "object") return [];
    const roles = (member as { roles?: unknown }).roles;
    if (!roles) return [];
    // GuildMemberRoleManager exposes a `cache` Collection of <id, Role>.
    if (typeof roles === "object" && "cache" in roles) {
      const cache = (roles as { cache: { keys(): Iterable<string> } }).cache;
      return [...cache.keys()];
    }
    // Raw API member: roles is a string[] of ids.
    if (Array.isArray(roles)) return roles as string[];
    return [];
  }

  /**
   * Discord-permission bootstrap bypass for the `/conduit` slash commands and
   * the Setup hub flow.
   *
   * On a fresh install the role map is empty (`admin: [], user: []`), so no
   * member resolves any capability — which would lock *everyone*, including the
   * server owner, out of `/conduit setup`/`/conduit status` *and* every button
   * in the Setup hub, with no way to assign the first roles. The bypass admits a
   * member who is EITHER:
   *   - the guild owner (`guild.ownerId === user.id`) — the most direct, always-
   *     reliable signal and the literal "server owner can always" guarantee, or
   *   - a holder of Discord's Administrator permission (a belt-and-suspenders
   *     check that also covers non-owner admins, and that does not depend on the
   *     guild being cached).
   *
   * Such a member may run the bootstrap slash commands and actuate Setup-hub /
   * pairing actions (see {@link ADMIN_BYPASS_DOMAINS}); from there they map roles
   * and normal gating takes over. Scoped to the setup flow by design —
   * device-control buttons stay strictly role-gated even for the owner.
   */
  private isGuildAdministrator(interaction: Interaction): boolean {
    // Most reliable: the literal guild owner. `guild` is cached under the Guilds
    // intent; `user` is always present. This alone satisfies the request that the
    // server owner can always drive setup, even if the permission bitfield below
    // is somehow absent from the interaction payload.
    const i = interaction as {
      guild?: { ownerId?: string } | null;
      user?: { id?: string } | null;
      memberPermissions?: { has(p: bigint): boolean } | null;
    };
    const ownerId = i.guild?.ownerId;
    const userId = i.user?.id;
    if (ownerId && userId && ownerId === userId) return true;

    try {
      return Boolean(i.memberPermissions?.has(PermissionFlagsBits.Administrator));
    } catch {
      return false;
    }
  }

  /** Expose the state-lock machine for tests/diagnostics. */
  get stateLockMachine(): StateLockMachine {
    return this.stateLock;
  }

  /** Expose the handle registry for tests/diagnostics. */
  get handleRegistry(): HandleRegistry {
    return this.handles;
  }
}

/**
 * Format the in-game clock (hour-of-day float, 0–24) as a 24-hour "HH:MM" label
 * for the status panel. Normalizes out-of-range values and rolls 59.5→00:00.
 */
export function formatGameTime(time: GameTime): string {
  const total = ((time.time % 24) + 24) % 24;
  let hours = Math.floor(total);
  let minutes = Math.round((total - hours) * 60);
  if (minutes === 60) {
    minutes = 0;
    hours = (hours + 1) % 24;
  }
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

// Re-export AttachmentBuilder usage indirectly so camera media wiring has a
// concrete dependency; the desktop host attaches frame bytes when capturing.
export { AttachmentBuilder };

// Keep the AppConfig import meaningful for downstream typing.
export type { AppConfig };
