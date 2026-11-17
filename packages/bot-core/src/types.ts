/**
 * Persisted data model for `@conduit/bot-core`.
 *
 * These shapes are stored locally (SQLite or JSON via the desktop app; an
 * in-memory implementation ships here for tests/defaults). They are
 * persistence-agnostic and JSON-serializable — no class instances, no `Long`,
 * no protobuf — so a {@link StateStore} backend can round-trip them through
 * `JSON.stringify` or a SQLite column without losing fidelity.
 */

import type { FcmCredentials } from "@conduit/fcm";

/**
 * Two built-in permission tiers. Guild roles are mapped to each tier
 * via Role Select menus in the Discord Setup hub; the mapping is checked
 * per-click by the discord adapter, never here.
 */
export type Capability = "admin" | "user";

/** Discord role id → capability tier. */
export interface RoleCapabilityMap {
  /** Role ids granted admin (setup, pairing, permissions). */
  admin: string[];
  /** Role ids granted user (read + switch toggles). */
  user: string[];
}

/**
 * Secrets at rest. Encrypted by the desktop app via `safeStorage`
 * before persistence; bot-core only holds the cleartext shape in memory.
 */
export interface StoredCredentials {
  fcm: FcmCredentials;
  discordBotToken: string;
  /** ISO-8601 timestamp at which the Steam auth token expires. */
  steamTokenExpiresAt: string;
}

/** A Steam sign-in renewal reminder as persisted in {@link AppConfig}. */
export interface RenewalReminderRecord {
  /** The token expiry (`steamTokenExpiresAt`) the reminder was for, when known. */
  expiresAt?: string;
  reason: "expiring" | "expired" | "rejected";
  /** For `expiring`/`expired`: the milestone sent, in ms before expiry (`0` = at expiry). */
  milestoneMs?: number;
}

/** A paired Rust server. */
export interface PairedServer {
  /** Companion server id (uuid) from the pairing notification. */
  id: string;
  name: string;
  desc: string;
  /**
   * Address for a direct connection, from servers that predate Facepunch's
   * companion socket. Current pairing pushes carry no ip/port; Conduit connects
   * by {@link id} through the companion socket either way.
   */
  ip?: string;
  /** Rust+ companion port (`app.port`), alongside {@link ip}. */
  port?: number;
  /** Operator SteamID (Steam64) as a decimal string. */
  playerId: string;
  /**
   * Per-player auth token from the pairing notification. Secret: the desktop
   * store keeps it encrypted in `credentials.bin`, never in `state.json`.
   */
  playerToken: string;
  /** ISO-8601 timestamp the server was paired. */
  addedAt: string;
  /**
   * The message ids of this server's Conduit Panel in the control channel: one
   * Components V2 message per device type, posted once and then edited in
   * place. Absent until the panel is first posted, and in state files
   * that predate it.
   */
  panelMessageIds?: ServerPanelIds;
  /**
   * @deprecated The status panel of the per-device layout, replaced by the
   * Server message of {@link panelMessageIds}. Read only so the adapter can
   * delete the old message and clear this id (one-time migration).
   */
  statusPanelMessageId?: string;
  /**
   * @deprecated The team roster's own message, from before it moved into the
   * status panel. Read only so the adapter can delete the old message and clear
   * this id (one-time migration).
   */
  teamPanelMessageId?: string;
  /**
   * Switch groups on this server: several switches shown as one row with
   * one action. A switch belongs to at most one group. Absent when the server
   * has none, and in state files that predate groups.
   */
  switchGroups?: SwitchGroup[];
}

/**
 * A named set of paired switches on one server, actuated together.
 * Membership is explicit (not by shared name). JSON-serializable.
 */
export interface SwitchGroup {
  /** Stable id, unique on its server. Minted by bot-core. */
  id: string;
  /** Operator-chosen name. */
  name: string;
  /** Member switch entity ids, in the order the operator chose them. Never empty. */
  entityIds: number[];
}

/**
 * The message ids of a server's Conduit Panel, by message. A device type's
 * messages are an array, one id per page ("Switches 1/2", "2/2"); a type the
 * server has no devices of has none. JSON-serializable.
 */
export interface ServerPanelIds {
  /** The Server message: name, status, players, team. */
  server?: string;
  switches?: string[];
  alarms?: string[];
  storage?: string[];
  cameras?: string[];
}

/**
 * Which deprecated per-device panel ids to clear once their old messages have
 * been deleted (the one-time migration to the Conduit Panel).
 */
export interface LegacyPanelIds {
  /** {@link PairedServer.statusPanelMessageId}. */
  status?: boolean;
  /** {@link PairedServer.teamPanelMessageId}. */
  team?: boolean;
  /** Entities whose {@link PairedEntity.panelMessageId} to clear. */
  entityIds?: number[];
}

/** A paired in-game device. */
export interface PairedEntity {
  serverId: string;
  entityId: number;
  entityType: "switch" | "alarm" | "storageMonitor" | "camera";
  /** Camera identifier (cameras are addressed by name, not id). */
  identifier?: string;
  /** Operator-friendly name, set from a Discord modal. */
  label?: string;
  /**
   * @deprecated The device's own panel message, from before the Conduit Panel
   * put each device type in one message per server. Read only so the
   * adapter can delete the old message and clear this id (one-time migration).
   */
  panelMessageId?: string;
  /**
   * Storage monitor: announce changes (toggled from its panel's Watch button).
   * On: each change repaints the panel and posts a line to the logging channel.
   * Off (the default): changes post no line and are shown on Refresh or
   * reconnect, except that a tool cupboard's upkeep still repaints its row, at
   * a bounded rate.
   */
  watchChanges?: boolean;
  /**
   * Smart alarm: opt-in Pushover severity. When set (and global Pushover
   * credentials are configured — see {@link AppConfig.pushover}), a firing of
   * this alarm sends a Pushover notification at the mapped priority. Unset =
   * no Pushover for this alarm. Only meaningful for `entityType === "alarm"`.
   */
  pushoverSeverity?: PushoverSeverity;
  /**
   * Smart alarm: how its logging-channel line notifies when it fires. Unset =
   * Normal (notifies, mentions nobody; the default). `"silent"` sends it
   * `@silent`, `"active"` mentions `@here`, `"everyone"` mentions `@everyone`.
   * Only meaningful for `entityType === "alarm"`.
   */
  notificationLevel?: AlarmNotificationLevel;
  /**
   * Smart switch: optional timed auto-revert. When set, the switch is flipped
   * back after {@link autoActionDelaySeconds} whenever it enters the opposite
   * state — `"off"` (auto-off) forces it OFF after it turns ON; `"on"` (auto-on)
   * forces it ON after it turns OFF. Unset = disabled. Only meaningful for
   * `entityType === "switch"`.
   */
  autoAction?: SwitchAutoAction;
  /**
   * Smart switch: the auto-revert delay in seconds. Unset falls back to
   * {@link SWITCH_AUTO_DELAY_DEFAULT}. Only meaningful when {@link autoAction}
   * is set.
   */
  autoActionDelaySeconds?: number;
}

/** Per-alarm Pushover severity. Maps to a Pushover priority at send time. */
export type PushoverSeverity = "low" | "medium" | "high";

/**
 * Per-alarm notification level: how the logging-channel line notifies when the
 * alarm fires. Unset is the default, **Normal** (an ordinary, notifying message
 * that mentions nobody). `"silent"` → `@silent` (no push), `"active"` → `@here`,
 * `"everyone"` → `@everyone`.
 */
export type AlarmNotificationLevel = "silent" | "active" | "everyone";

/**
 * Per-switch auto-revert target. `"off"` = auto-off (force OFF after the switch
 * turns ON); `"on"` = auto-on (force ON after it turns OFF). Unset (on a
 * {@link PairedEntity}) means disabled. Only meaningful for
 * `entityType === "switch"`.
 */
export type SwitchAutoAction = "on" | "off";

/**
 * App configuration. Settings only, except {@link AppConfig.pushover}, whose keys
 * the desktop store keeps encrypted in `credentials.bin`, never in `state.json`.
 */
export interface AppConfig {
  /**
   * Discord Application (client) id. Required to register slash commands.
   * Collected in the bootstrap wizard and persisted here (it is not a secret).
   */
  discordAppId?: string;
  /**
   * Discord Server (guild) id. Scopes slash-command registration to one guild
   * so commands appear within seconds. Collected in the bootstrap wizard.
   */
  discordGuildId?: string;
  /** Set via a native Channel Select in the Setup hub. */
  controlChannelId?: string;
  /**
   * Optional audit-log channel. Set via a native Channel Select in the Setup
   * hub. When set, all Discord interactions and in-game events are mirrored here
   * as plain-text, timestamped lines. May be the same channel as
   * {@link controlChannelId}. Unset = logging disabled (opt-in).
   */
  loggingChannelId?: string;
  /**
   * Launch the app when the operator signs in to the OS. Toggled from the
   * Discord Setup hub via `BotCore.setStartOnLogin`; the desktop host mirrors it
   * into the OS login item.
   */
  startOnLogin: boolean;
  /** Discord role id → capability tier. */
  roleCapabilities: RoleCapabilityMap;
  /**
   * Pushover credentials, set from the Discord Setup hub. Both fields are
   * required for Pushover to be enabled; when unset (or partially set),
   * per-alarm {@link PairedEntity.pushoverSeverity} settings are inert.
   *
   * Secret: held on the config (rather than in {@link StoredCredentials}) so
   * panel builders can read it synchronously via `getConfig()`, but a persistent
   * store must keep it encrypted. The desktop `PersistentStateStore` writes it
   * to the encrypted `credentials.bin` and never to `state.json`, as it does
   * each server's `playerToken`.
   */
  pushover?: PushoverConfig;
  /**
   * The last Steam sign-in renewal reminder sent, with the token expiry it was
   * for, so a restart does not repeat it. Bookkeeping, not a setting: bot-core
   * writes it. Optional: absent until the first reminder (and in state files
   * that predate it). A record for another expiry is stale and ignored, so a
   * renewed sign-in starts the schedule over. Kept here rather than on
   * {@link StoredCredentials} so writing it never races a credential refresh.
   */
  steamRenewalReminder?: RenewalReminderRecord;
}

/** Global Pushover credentials. Both fields required for Pushover to be enabled. */
export interface PushoverConfig {
  /** Pushover application API token (identifies the app). */
  appToken: string;
  /** Pushover user or group key (identifies the recipient). */
  userKey: string;
}

/** A fresh, empty {@link AppConfig} (used as the in-memory store default). */
export function defaultAppConfig(): AppConfig {
  return {
    startOnLogin: false,
    roleCapabilities: { admin: [], user: [] },
  };
}
