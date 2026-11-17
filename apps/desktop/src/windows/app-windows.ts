/**
 * Renderer window factories.
 *
 * Two renderer surfaces share one HTML bundle + preload, distinguished by the
 * URL hash (`#wizard` / `#status`), which the preload reads to pick the bridge
 * surface:
 *   - **Bootstrap wizard** — a fixed ~520×640 window, shown once at
 *     first run.
 *   - **Tray status window** — a compact ~360×420 frameless popout,
 *     toggled from the tray.
 *
 * Both windows run with the security posture: `contextIsolation:true`,
 * `nodeIntegration:false`, and the Conduit preload (which is the only privileged
 * bridge). `sandbox:false` is set so the ESM preload loads (contextIsolation
 * still fully isolates the renderer — see preload.ts).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen } from "electron";

import { APP_ICON_PATH } from "../asset-paths.js";
import { STATUS_SIZE, WIZARD_SIZE } from "../constants.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * Compiled preload sits next to the windows dir at dist root. It MUST be a
 * `.mjs` file: Electron decides whether a preload is ESM purely by its file
 * extension, ignoring the package's `"type": "module"`. A `.js` ESM preload is
 * loaded as CommonJS, fails on its `import` statements, and never runs — leaving
 * `window.conduit` undefined and every wizard button inert. The source is
 * `preload.mts` so `tsc` emits `preload.mjs`.
 */
const PRELOAD_PATH = path.join(here, "..", "preload.mjs");
/** Static renderer HTML, copied into dist by the build (see README). */
const RENDERER_HTML = path.join(here, "..", "renderer", "index.html");

function baseWebPreferences(): Electron.WebPreferences {
  return {
    preload: PRELOAD_PATH,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false, // required for an ESM preload; isolation is unaffected
  };
}

/** Create the bootstrap wizard window. */
export function createWizardWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIZARD_SIZE.width,
    height: WIZARD_SIZE.height,
    resizable: false,
    title: "Conduit — Setup",
    icon: APP_ICON_PATH,
    backgroundColor: "#313338", // bg-base
    autoHideMenuBar: true,
    webPreferences: baseWebPreferences(),
  });
  void win.loadFile(RENDERER_HTML, { hash: "wizard" });
  return win;
}

/**
 * Create the read-only tray status window. A frameless,
 * skip-taskbar popout anchored near the tray; hidden until toggled.
 */
export function createStatusWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: STATUS_SIZE.width,
    height: STATUS_SIZE.height,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    icon: APP_ICON_PATH,
    backgroundColor: "#111214", // bg-floating
    webPreferences: baseWebPreferences(),
  });
  void win.loadFile(RENDERER_HTML, { hash: "status" });
  // Auto-hide when it loses focus (popout behavior).
  win.on("blur", () => {
    if (!win.isDestroyed()) win.hide();
  });
  return win;
}

/** Position the status window near the tray click point + show it. */
export function showStatusNearTray(win: BrowserWindow, trayBounds?: Electron.Rectangle): void {
  if (trayBounds) {
    const display = screen.getDisplayMatching(trayBounds);
    const x = Math.min(
      Math.round(trayBounds.x + trayBounds.width / 2 - STATUS_SIZE.width / 2),
      display.workArea.x + display.workArea.width - STATUS_SIZE.width,
    );
    const y = Math.max(display.workArea.y, trayBounds.y - STATUS_SIZE.height - 8);
    win.setPosition(Math.max(display.workArea.x, x), y);
  }
  win.show();
  win.focus();
}
