/**
 * Start-on-login wiring — guarded glue around
 * `app.setLoginItemSettings` / `app.getLoginItemSettings`.
 *
 * The preference lives in {@link AppConfig.startOnLogin} (toggled from the
 * Discord Setup hub). The coordinator reflects it into the OS login-item
 * registration through this module — at startup, whenever bot-core reports the
 * preference changed, and after a reset — receiving {@link applyStartOnLogin}
 * as an injected seam so it stays electron-free. We guard the call so it is a
 * no-op on Linux and cannot throw if `app` is unavailable (e.g. tests). Electron's
 * `setLoginItemSettings` is fully supported on Windows + macOS and ignored on
 * Linux.
 *
 * ## Which command the login item runs
 * On Windows the login item is a `HKCU\…\Run\Conduit` value: an executable plus
 * arguments. Packaged, `process.execPath` *is* `Conduit.exe`, so `--hidden` is
 * the only argument. Run from source, `process.execPath` is the bare
 * `electron.exe` and the app directory must be passed as its first argument, or
 * the login item would open Electron's default window instead of Conduit.
 *
 * The portable exe is a wrapper: on every launch it unpacks the app into a
 * temporary folder, runs it from there, and deletes the folder on exit. There
 * `process.execPath` is that temporary copy, which is gone by the next sign-in,
 * so the login item must name the wrapper itself. The wrapper passes its path
 * in `PORTABLE_EXECUTABLE_FILE`, and hands its own arguments (`--hidden`) on to
 * the app.
 *
 * Electron only reports (`getLoginItemSettings`) an entry whose `path` and `args`
 * match the ones it is asked about, so reading and writing share one option
 * builder, {@link loginItemOptions}.
 */

import { app } from "electron";

import { APP_NAME } from "./constants.js";

/**
 * Command-line flag the login item launches with: start straight into the tray,
 * without opening any window (see {@link isHiddenLaunch}).
 */
export const HIDDEN_FLAG = "--hidden";

/** What {@link loginItemOptions} needs to know about the running app. */
export interface LoginItemContext {
  /** `app.isPackaged`: running from the built `.exe` rather than from source. */
  isPackaged: boolean;
  /** `process.execPath`: `Conduit.exe` packaged, `electron.exe` from source. */
  execPath: string;
  /** `app.getAppPath()`: the app directory Electron loads when run from source. */
  appPath: string;
  /**
   * `PORTABLE_EXECUTABLE_FILE`: the portable exe the user launched, set only
   * when the app runs from that wrapper.
   */
  portableExecutable?: string;
}

/** The `path`/`args` pair identifying Conduit's login item. */
export interface LoginItemOptions {
  /**
   * Executable to launch; omitted for the installed app (Electron defaults to
   * `process.execPath`).
   */
  path?: string;
  args: string[];
}

/**
 * Build the login item's `path` and `args`. Pure; used for both
 * `setLoginItemSettings` and `getLoginItemSettings` so the read matches the write.
 */
export function loginItemOptions(ctx: LoginItemContext): LoginItemOptions {
  // Electron writes the Run value as `path args…` joined with spaces, quoting
  // nothing, so a path with a space (C:\Users\Jane Doe\…) would split.
  if (ctx.isPackaged) {
    // The portable wrapper, not the temporary copy it unpacked and will delete.
    if (ctx.portableExecutable) {
      return { path: quoted(ctx.portableExecutable), args: [HIDDEN_FLAG] };
    }
    return hasSpace(ctx.execPath)
      ? { path: quoted(ctx.execPath), args: [HIDDEN_FLAG] }
      : { args: [HIDDEN_FLAG] };
  }
  return { path: quoted(ctx.execPath), args: [quoted(ctx.appPath), HIDDEN_FLAG] };
}

function hasSpace(value: string): boolean {
  return /\s/.test(value);
}

/** `value` in double quotes when it contains a space; unchanged otherwise. */
function quoted(value: string): string {
  return hasSpace(value) ? `"${value}"` : value;
}

/** Whether this process was launched by the login item (with {@link HIDDEN_FLAG}). */
export function isHiddenLaunch(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_FLAG);
}

/** The login-item options for the running app. */
function currentLoginItemOptions(): LoginItemOptions {
  return loginItemOptions({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE || undefined,
  });
}

/**
 * Apply the start-on-login preference. Safe to call anywhere: it only touches the
 * OS login item on Windows/macOS and swallows any platform error.
 */
export function applyStartOnLogin(enabled: boolean): void {
  if (process.platform === "linux") return; // unsupported; no-op
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      name: APP_NAME,
      // Launch hidden to the tray (no flash of the wizard on boot).
      ...currentLoginItemOptions(),
    });
  } catch {
    // Non-fatal: the app still runs; the operator can toggle it again later.
  }
}

/** Read the current OS login-item state (best-effort; false off Windows/macOS). */
export function isStartOnLoginEnabled(): boolean {
  if (process.platform === "linux") return false;
  try {
    return app.getLoginItemSettings(currentLoginItemOptions()).openAtLogin;
  } catch {
    return false;
  }
}
