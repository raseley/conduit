/**
 * Tray + tray-icon recoloring.
 *
 * The tray icon is the Conduit mark with its ring and bar in the worst
 * current state's color, so the system tray itself is a status badge:
 * `status-online` (green) when all-healthy, `status-idle` (amber) when
 * reconnecting, `status-down` (red) when any connection is lost — the colors of
 * the Discord panels and the tray rows, the red lightened for contrast on navy.
 * The navy tile keeps the colored ring legible on light taskbars.
 *
 * The bitmaps are drawn at runtime by the electron-free `conduit-mark.ts`, at
 * 16px and 32px (scale factors 1 and 2) so high-DPI trays stay crisp; no
 * per-state asset is shipped. Clicking the tray toggles the read-only status
 * window.
 */

import { Tray, Menu, nativeImage, type NativeImage } from "electron";

import { rasterizeMark, statusVariant, toBgra, type MarkLevel } from "../conduit-mark.js";
import { APP_NAME } from "../constants.js";

/** The three status levels. */
export type TrayLevel = MarkLevel;

/** One representation of the tray icon, in the BGRA order Electron expects. */
function trayBitmap(level: TrayLevel, size: number): Buffer {
  const bgra = toBgra(rasterizeMark(statusVariant(level), size));
  return Buffer.from(bgra.buffer, bgra.byteOffset, bgra.byteLength);
}

/** Build the tray icon for a status level: 16px, plus 32px for 2× displays. */
export function buildTrayIcon(level: TrayLevel): NativeImage {
  const image = nativeImage.createFromBuffer(trayBitmap(level, 16), {
    width: 16,
    height: 16,
    scaleFactor: 1,
  });
  image.addRepresentation({
    scaleFactor: 2,
    width: 32,
    height: 32,
    buffer: trayBitmap(level, 32),
  });
  return image;
}

/** Controls the tray icon + context menu and surfaces a "show status" action. */
export class ConduitTray {
  private tray?: Tray;
  private level: TrayLevel = "down";

  constructor(
    private readonly onShowStatus: () => void,
    private readonly onQuit: () => void,
    /** Re-run the Steam sign-in, to renew an expiring or expired token. */
    private readonly onSignInAgain: () => void,
  ) {}

  /** Create the tray (call once the app is ready). */
  create(): void {
    this.tray = new Tray(buildTrayIcon(this.level));
    this.tray.setToolTip(APP_NAME);
    this.tray.on("click", () => this.onShowStatus());
    this.rebuildMenu();
  }

  /** Recolor the icon + tooltip to reflect the worst current state. */
  setLevel(level: TrayLevel): void {
    this.level = level;
    if (!this.tray) return;
    this.tray.setImage(buildTrayIcon(level));
    this.tray.setToolTip(`${APP_NAME} — ${captionForLevel(level)}`);
  }

  private rebuildMenu(): void {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: "Status…", click: () => this.onShowStatus() },
      { label: "Sign in with Steam again…", click: () => this.onSignInAgain() },
      { type: "separator" },
      { label: `Quit ${APP_NAME}`, click: () => this.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }
}

function captionForLevel(level: TrayLevel): string {
  switch (level) {
    case "online":
      return "all systems go";
    case "idle":
      return "reconnecting…";
    case "down":
      return "connection lost";
  }
}
