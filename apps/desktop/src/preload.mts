/**
 * Preload — the contextBridge that exposes the typed {@link ConduitBridge} to the
 * renderer.
 *
 * The renderer runs with `contextIsolation: true` and `nodeIntegration: false`,
 * so it has NO access to Node or Electron. This preload is the only privileged
 * code in the renderer process; it exposes a single, narrow `window.conduit`
 * object whose every method is a thin wrapper over a typed `ipcRenderer.invoke`
 * or `ipcRenderer.on`. No raw `ipcRenderer` is ever exposed.
 *
 * The surface ("wizard" vs "status") is read from the window's URL hash so one
 * preload serves both renderer windows.
 *
 * ## ESM/CJS note
 * This file is authored as `preload.mts` so `tsc` emits `preload.mjs`. The
 * `.mjs` extension is REQUIRED: Electron decides whether a preload is ESM by its
 * file extension alone — a `.js` preload is treated as CommonJS even in a
 * `"type": "module"` package, so its `import`s throw and the bridge never loads.
 * ESM preloads also require the owning `BrowserWindow` to set `sandbox: false`
 * (which `app-windows.ts` does for both renderer windows). `contextIsolation`
 * stays `true`, so isolation/security is unaffected by disabling the sandbox.
 */

import { contextBridge, ipcRenderer } from "electron";

import {
  IPC_OPEN_EXTERNAL,
  IPC_RESET_CONFIG,
  IPC_STATUS_COPY_DIAGNOSTICS,
  IPC_STATUS_RENEW_STEAM,
  IPC_STATUS_GET,
  IPC_EVENT_STATUS,
  IPC_EVENT_WIZARD_STATE,
  IPC_WIZARD_CHECK_INTENTS,
  IPC_WIZARD_DETECT_SERVER,
  IPC_WIZARD_SELECT_SERVER,
  IPC_WIZARD_SETUP_CHANNELS,
  IPC_WIZARD_BEGIN_PAIRING,
  IPC_WIZARD_CANCEL_PAIRING,
  IPC_WIZARD_CONNECT_STEAM,
  IPC_WIZARD_FINISH,
  IPC_WIZARD_GET_STATE,
  IPC_WIZARD_SUBMIT_DISCORD_TOKEN,
  IPC_WIZARD_SUBMIT_SERVER_ID,
  type BeginPairingResult,
  type ConduitBridge,
  type RendererSurface,
  type StatusSnapshot,
  type SteamRenewalResult,
  type SubmitResult,
  type WizardSnapshot,
} from "./ipc-contract.js";

function currentSurface(): RendererSurface {
  // `location` exists in the renderer (DOM) context this preload runs in, but the
  // strict main tsconfig has no DOM lib; read it off globalThis defensively.
  const loc = (globalThis as { location?: { hash?: string } }).location;
  return loc?.hash?.includes("status") ? "status" : "wizard";
}

const bridge: ConduitBridge = {
  surface: currentSurface(),

  // ── wizard ────────────────────────────────────────────────────────────────
  getWizardState: () => ipcRenderer.invoke(IPC_WIZARD_GET_STATE) as Promise<WizardSnapshot>,
  submitDiscordToken: (token: string) =>
    ipcRenderer.invoke(IPC_WIZARD_SUBMIT_DISCORD_TOKEN, token) as Promise<SubmitResult>,
  checkIntents: () => ipcRenderer.invoke(IPC_WIZARD_CHECK_INTENTS) as Promise<WizardSnapshot>,
  detectServer: (createChannels: boolean) =>
    ipcRenderer.invoke(IPC_WIZARD_DETECT_SERVER, createChannels) as Promise<WizardSnapshot>,
  selectServer: (serverId: string, createChannels: boolean) =>
    ipcRenderer.invoke(IPC_WIZARD_SELECT_SERVER, serverId, createChannels) as Promise<SubmitResult>,
  submitServerId: (serverId: string, createChannels: boolean) =>
    ipcRenderer.invoke(
      IPC_WIZARD_SUBMIT_SERVER_ID,
      serverId,
      createChannels,
    ) as Promise<SubmitResult>,
  setupChannels: (create: boolean) =>
    ipcRenderer.invoke(IPC_WIZARD_SETUP_CHANNELS, create) as Promise<WizardSnapshot>,
  connectSteam: () => ipcRenderer.invoke(IPC_WIZARD_CONNECT_STEAM) as Promise<WizardSnapshot>,
  beginPairing: () => ipcRenderer.invoke(IPC_WIZARD_BEGIN_PAIRING) as Promise<BeginPairingResult>,
  cancelPairing: () => ipcRenderer.invoke(IPC_WIZARD_CANCEL_PAIRING) as Promise<void>,
  finishWizard: () => ipcRenderer.invoke(IPC_WIZARD_FINISH) as Promise<void>,
  onWizardState: (cb: (snapshot: WizardSnapshot) => void) => {
    const handler = (_e: unknown, snapshot: WizardSnapshot): void => cb(snapshot);
    ipcRenderer.on(IPC_EVENT_WIZARD_STATE, handler);
    return () => ipcRenderer.removeListener(IPC_EVENT_WIZARD_STATE, handler);
  },

  // ── app ───────────────────────────────────────────────────────────────────
  openExternal: (url: string) => ipcRenderer.invoke(IPC_OPEN_EXTERNAL, url) as Promise<void>,
  resetConfig: () => ipcRenderer.invoke(IPC_RESET_CONFIG) as Promise<boolean>,

  // ── status ────────────────────────────────────────────────────────────────
  getStatus: () => ipcRenderer.invoke(IPC_STATUS_GET) as Promise<StatusSnapshot>,
  copyDiagnostics: () => ipcRenderer.invoke(IPC_STATUS_COPY_DIAGNOSTICS) as Promise<string>,
  renewSteamSignIn: () => ipcRenderer.invoke(IPC_STATUS_RENEW_STEAM) as Promise<SteamRenewalResult>,
  onStatus: (cb: (snapshot: StatusSnapshot) => void) => {
    const handler = (_e: unknown, snapshot: StatusSnapshot): void => cb(snapshot);
    ipcRenderer.on(IPC_EVENT_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC_EVENT_STATUS, handler);
  },
};

contextBridge.exposeInMainWorld("conduit", bridge);
