/**
 * @conduit/bot-core
 *
 * The coordinator core and the single bridge between the Discord tier and the
 * Rust server. Owns paired servers/entities, maps high-level
 * operations and configuration to `@conduit/rustplus-client` calls and persisted
 * state, and fans `@conduit/fcm` pairings + client broadcasts into domain events
 * the discord adapter subscribes to. Depends only on `@conduit/rustplus-client`
 * and `@conduit/fcm` — NO Discord, NO Electron.
 */

export {
  AUTH_RENEWAL_MILESTONES_MS,
  authRenewalMilestone,
  BotCore,
  DEFAULT_STATE_LOCK_TIMEOUT_MS,
  nextAuthRenewalMilestoneAt,
  SERVER_OFFLINE_GRACE_MS,
  SWITCH_AUTO_DELAY_DEFAULT,
  SWITCH_AUTO_DELAY_MIN,
  SWITCH_AUTO_DELAY_MAX,
  SWITCH_GROUP_MAX_MEMBERS,
  SWITCH_GROUP_NAME_MAX,
  severityToPriority,
  type AuthRenewalNotice,
  type AuthTokenState,
  type BotCoreOptions,
  type BotCoreEventMap,
  type ClientFactory,
  type Logger,
  type PushoverMessage,
  type PushoverNotifier,
  type ServerConnectionStatus,
  type ServerStatus,
  type TimerProvider,
} from "./bot-core.js";

export { BotCoreError, StateError, ValidationError } from "./errors.js";

export {
  capPersistentIds,
  InMemoryStateStore,
  MAX_PERSISTENT_IDS,
  type StateStore,
} from "./store.js";

export {
  defaultAppConfig,
  type AlarmNotificationLevel,
  type AppConfig,
  type Capability,
  type LegacyPanelIds,
  type PairedEntity,
  type PairedServer,
  type ServerPanelIds,
  type PushoverConfig,
  type PushoverSeverity,
  type RenewalReminderRecord,
  type RoleCapabilityMap,
  type StoredCredentials,
  type SwitchAutoAction,
  type SwitchGroup,
} from "./types.js";

// Re-export the domain types adapters render, so `@conduit/discord` consumes a
// single dependency surface (it never imports rustplus-client directly).
export type {
  EntityChange,
  EntityInfo,
  EntityItem,
  EntityType,
  GameTime,
  ServerInfo,
  TeamChatMessage,
  TeamInfo,
  TeamMember,
} from "@conduit/rustplus-client";

// The camera capture failure the adapter turns into user-facing copy.
export { CameraUnavailableError, type CameraUnavailableReason } from "@conduit/rustplus-client";

export type {
  AlarmNotification,
  DeathNotification,
  FcmCredentials,
  PairingNotification,
} from "@conduit/fcm";
