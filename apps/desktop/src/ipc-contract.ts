/**
 * Typed IPC contract between the Electron main process and the renderer
 * (bootstrap wizard + tray status window).
 *
 * The renderer runs with `contextIsolation: true` and `nodeIntegration: false`
 * so it cannot touch Node or Electron directly. It talks to the
 * main process only through the narrow, typed bridge defined here and exposed by
 * the `preload.ts` `contextBridge`. Keeping the channel names + payload shapes in
 * one electron-free module lets both sides import the same types and lets the
 * (pure) shapes be referenced in tests.
 *
 * Convention: `invoke:*` channels are renderer→main request/response
 * (`ipcRenderer.invoke` ↔ `ipcMain.handle`); `event:*` channels are main→renderer
 * pushes (`webContents.send` ↔ `ipcRenderer.on`).
 */

import type { WizardSnapshot } from "./wizard-machine.js";

/** Which renderer surface a window hosts (chosen via a query param / preload). */
export type RendererSurface = "wizard" | "status";

// ── Wizard (renderer → main) ────────────────────────────────────────────────

/**
 * Check the Discord bot token live with Discord and store it (the "bot" step).
 * The check also yields the Application ID, which is stored too.
 */
export const IPC_WIZARD_SUBMIT_DISCORD_TOKEN = "invoke:wizard:submitDiscordToken";
/** Verify the Server Members intent is on, via the application's flags (the "intents" step). */
export const IPC_WIZARD_CHECK_INTENTS = "invoke:wizard:checkIntents";
/**
 * Find the server the bot was invited to (the "invite" step): one is stored
 * and the wizard advances, several produce a picker, none a retry. The three
 * ways to choose a server each carry the "Create the Conduit channels for me"
 * box: when ticked, Conduit creates its channels in the server before advancing.
 */
export const IPC_WIZARD_DETECT_SERVER = "invoke:wizard:detectServer";
/** Store the server picked from the detected list (by id; must be one of the choices). */
export const IPC_WIZARD_SELECT_SERVER = "invoke:wizard:selectServer";
/** Validate + store a manually entered Server (guild) id (the invite step's fallback). */
export const IPC_WIZARD_SUBMIT_SERVER_ID = "invoke:wizard:submitServerId";
/**
 * After Conduit couldn't create its channels: `true` tries again (e.g. after
 * re-inviting the bot with Manage Channels), `false` continues without them.
 */
export const IPC_WIZARD_SETUP_CHANNELS = "invoke:wizard:setupChannels";
/** Kick off FCM registration + Steam login (opens the Steam BrowserWindow). */
export const IPC_WIZARD_CONNECT_STEAM = "invoke:wizard:connectSteam";
/** Arm pairing (fcm.startListening) and wait for the first server pairing. */
export const IPC_WIZARD_BEGIN_PAIRING = "invoke:wizard:beginPairing";
/** Cancel an in-flight pairing wait. */
export const IPC_WIZARD_CANCEL_PAIRING = "invoke:wizard:cancelPairing";
/** Finish the wizard: persist final state and drop to the tray. */
export const IPC_WIZARD_FINISH = "invoke:wizard:finish";
/** Read the current wizard machine state (e.g. on window open). */
export const IPC_WIZARD_GET_STATE = "invoke:wizard:getState";

// ── App-wide (renderer → main) ──────────────────────────────────────────────

/** Open a URL in the user's default browser (instructional/invite links). */
export const IPC_OPEN_EXTERNAL = "invoke:app:openExternal";

/**
 * Wipe all configuration back to a vanilla state and delete every tracked
 * Discord panel. Prompts for native confirmation in the main process; resolves
 * `true` if the reset ran, `false` if the user cancelled.
 */
export const IPC_RESET_CONFIG = "invoke:app:resetConfig";

// ── Status window (renderer → main) ─────────────────────────────────────────

/** Read the current coordinator health snapshot for the tray window. */
export const IPC_STATUS_GET = "invoke:status:get";
/** Assemble + return a redacted diagnostics bundle ("Copy diagnostics"). */
export const IPC_STATUS_COPY_DIAGNOSTICS = "invoke:status:copyDiagnostics";
/** Sign in with Steam again (renew the companion auth token) from the tray. */
export const IPC_STATUS_RENEW_STEAM = "invoke:status:renewSteam";

// ── Main → renderer pushes ──────────────────────────────────────────────────

/** Wizard machine state changed (e.g. registration progress, pairing received). */
export const IPC_EVENT_WIZARD_STATE = "event:wizard:state";
/** Coordinator health changed (status window live-updates). */
export const IPC_EVENT_STATUS = "event:status";

// ── Payload shapes ───────────────────────────────────────────────────────────

/**
 * Result of a validate-and-store wizard submission (bot token, picked server,
 * or Server ID). `ok` is false on a validation failure, with a friendly
 * `message` (never a stack); the same shape is also pushed via the wizard-state
 * event so the renderer can render the inline error either way.
 */
export interface SubmitResult {
  ok: boolean;
  /** Friendly validation message when `ok` is false (never a stack). */
  message?: string;
}

/** Result of a pairing wait. */
export interface BeginPairingResult {
  /** A server was paired. */
  paired: boolean;
  /** The paired server's display name, when `paired`. */
  serverName?: string;
}

/** One status row in the tray window (wireframe). */
export interface StatusRow {
  id: string;
  /** Maps to a `status-*` token dot. */
  level: "online" | "idle" | "down";
  /** Primary label, e.g. the server name or "Push listener (FCM)". */
  label: string;
  /** Muted caption, e.g. "connected · 14:21" or "reconnecting…". */
  caption: string;
}

/** Full health snapshot the tray window renders. */
export interface StatusSnapshot {
  /** Worst-of all rows; drives the tray icon color + the header chip. */
  overall: "online" | "idle" | "down";
  rows: StatusRow[];
  /** e.g. "Steam token renews in 9 days" (text-muted caption). */
  tokenCaption: string;
  /** The operator must sign in with Steam again: show the "Sign in again" button. */
  steamSignInNeeded?: boolean;
}

/** Outcome of {@link ConduitBridge.renewSteamSignIn}. Never carries a token or URL. */
export interface SteamRenewalResult {
  ok: boolean;
  /** One line for the status window. */
  message: string;
}

/**
 * The typed API the preload `contextBridge` exposes to the renderer as
 * `window.conduit`. Every method is a thin wrapper over an `ipcRenderer.invoke`
 * / `ipcRenderer.on`. Declared here (electron-free) so the renderer + preload +
 * tests share one contract.
 */
export interface ConduitBridge {
  surface: RendererSurface;

  // wizard
  getWizardState(): Promise<WizardSnapshot>;
  submitDiscordToken(token: string): Promise<SubmitResult>;
  /** Verify the Server Members intent is enabled; advances when it is. */
  checkIntents(): Promise<WizardSnapshot>;
  /**
   * Look for the server the bot was invited to. `createChannels`: the "Create
   * the Conduit channels for me" box, here and in the next two.
   */
  detectServer(createChannels: boolean): Promise<WizardSnapshot>;
  /** Pick one of the detected servers (`WizardSnapshot.serverChoices`). */
  selectServer(serverId: string, createChannels: boolean): Promise<SubmitResult>;
  /** Manual fallback: a Server ID copied with Developer Mode. */
  submitServerId(serverId: string, createChannels: boolean): Promise<SubmitResult>;
  /** After a channel fallback: try creating them again (`true`) or continue without. */
  setupChannels(create: boolean): Promise<WizardSnapshot>;
  connectSteam(): Promise<WizardSnapshot>;
  beginPairing(): Promise<BeginPairingResult>;
  cancelPairing(): Promise<void>;
  finishWizard(): Promise<void>;
  onWizardState(cb: (snapshot: WizardSnapshot) => void): () => void;

  // app
  openExternal(url: string): Promise<void>;
  /** Reset everything to vanilla (deletes panels). Resolves false if cancelled. */
  resetConfig(): Promise<boolean>;

  // status
  getStatus(): Promise<StatusSnapshot>;
  copyDiagnostics(): Promise<string>;
  /** Sign in with Steam again (opens the Steam window). */
  renewSteamSignIn(): Promise<SteamRenewalResult>;
  onStatus(cb: (snapshot: StatusSnapshot) => void): () => void;
}

// Re-export the wizard snapshot type so the contract is self-contained.
export type { WizardSnapshot } from "./wizard-machine.js";
