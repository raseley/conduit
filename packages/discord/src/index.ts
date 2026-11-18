/**
 * @conduit/discord
 *
 * Tier 1: the primary user surface. Owns the complete Discord
 * interaction model — persistent Components V2 panels, buttons, native
 * channel/role selects, free-text modals, the two bootstrap slash commands, and
 * per-click role-based permission checks. Allowed to import `discord.js`; never
 * reaches past `@conduit/bot-core`.
 *
 * The host (the desktop app) does:
 * ```ts
 * const adapter = new DiscordAdapter({ core, token, logger, panelStore });
 * await adapter.start();
 * // …later…
 * await adapter.stop();
 * ```
 */

export {
  DiscordAdapter,
  DISCORD_EDIT_CAP,
  EDIT_CAP_REBUILD_INTERVAL_MS,
  formatGameTime,
  type DiscordAdapterOptions,
  type DispatchableInteraction,
  type EphemeralPanelPayload,
  type DispatchOutcome,
  type ClientFactory,
  type Logger,
  type PostErrorInfo,
  type ReconcileReport,
} from "./adapter.js";

export {
  buildCustomId,
  parseCustomId,
  CUSTOM_ID_PREFIX,
  CUSTOM_ID_MAX_LENGTH,
  type CustomIdDomain,
  type CustomIdParts,
  type ParsedCustomId,
} from "./customId.js";

export { HandleRegistry, type Handle } from "./handles.js";

export {
  CONDUIT_ROLE_NAMES,
  adoptNamedRoles,
  isAllowed,
  resolveCapability,
  requiredCapabilityFor,
  type RequiredCapability,
  type ServerRole,
} from "./permissions.js";

export {
  StateLockMachine,
  type LockKey,
  type LockPhase,
  type LockResult,
  type LockSnapshot,
  type TimerProvider,
} from "./state-lock.js";

export { NoopPanelStore, type PanelStore } from "./panel-store.js";

export { PanelQueue } from "./panel-queue.js";

export {
  EditPipeline,
  EDIT_DEBOUNCE_MS,
  EDIT_CAP_BACKOFF_MS,
  EDIT_CAP_BACKOFF_MAX_MS,
  type EditOutcome,
  type EditPipelineOptions,
  type SubmitOptions,
  type SubmitOutcome,
} from "./edit-pipeline.js";

export {
  toPanelPayload,
  buildSwitchSettingsPanel,
  buildAlarmSettingsPanel,
  buildMonitorSettingsPanel,
  buildMonitorContentsPanel,
  buildCameraSettingsPanel,
  buildCameraFramePanel,
  buildSetupPanel,
  buildSwitchGroupPanel,
  buildSwitchGroupPickerPanel,
  layoutServer,
  switchGroupState,
  measurePayload,
  withinBudget,
  MESSAGE_MAX_COMPONENTS,
  MESSAGE_MAX_TEXT,
  PANEL_BANNER_URL,
  PANEL_KINDS,
  SWITCH_ROW_COMPONENTS,
  type AlarmRowState,
  type CameraRowState,
  type LayoutOptions,
  type MonitorRowState,
  type PanelKind,
  type PanelMessage,
  type PanelPayload,
  type PayloadBudget,
  type ServerLayoutState,
  type SwitchesRow,
  type SwitchGroupMember,
  type SwitchGroupRowState,
  type SwitchGroupState,
  type SwitchRowState,
} from "./panels.js";

export {
  DENIAL_MESSAGE,
  NO_ROLE_MESSAGE,
  COULD_NOT_CONFIRM_MESSAGE,
  GENERIC_FAILURE_MESSAGE,
  NO_CONTROL_CHANNEL_MESSAGE,
  ENTITY_NOT_FOUND_MESSAGE,
  STALE_STATE_MESSAGE,
  CAMERA_PLAYER_ONLINE_MESSAGE,
  CAMERA_NOT_FOUND_MESSAGE,
  CAMERA_NO_FRAMES_MESSAGE,
  friendlyError,
  shortFailureReason,
} from "./errors.js";
