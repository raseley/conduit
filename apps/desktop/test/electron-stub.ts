/**
 * Test-only stub for the `electron` module.
 *
 * Electron's binary is not installed in CI/sandbox (`pnpm install` no longer
 * downloads it), and importing `electron` outside an Electron process tries to
 * download it or fails. That breaks vitest's module collection for any
 * file that imports `electron` — even files whose electron use is confined to
 * functions we never call in a unit test (e.g. the pure `extractTokenFromUrl` in
 * `steam-window.ts`, or `main.ts`'s composition-root exports).
 *
 * This stub provides just enough inert surface that those modules *import* without
 * crashing. The unit tests still only exercise the electron-free logic; nothing
 * here is a real Electron implementation. Wired via `vitest.config.ts`'s alias.
 */

const noop = (): void => {};

/** A do-nothing safeStorage so `SafeStorageSecretBox` can be imported (not used). */
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString("utf8"),
};

export const app = {
  // Intentionally NOT a function shaped like Electron's, so main.ts's
  // `typeof app.whenReady === "function"` guard is false and runApp never boots.
  getPath: () => "",
  getVersion: () => "0.0.0-test",
  requestSingleInstanceLock: () => true,
  whenReady: undefined as unknown,
  on: noop,
  quit: noop,
  setLoginItemSettings: noop,
  getLoginItemSettings: () => ({ openAtLogin: false }),
};

export class BrowserWindow {}
export class Tray {}
export const Menu = { buildFromTemplate: () => ({}) };
export const nativeImage = { createFromBuffer: () => ({}) };
export const ipcMain = { handle: noop };
export const clipboard = { writeText: async (): Promise<void> => {} };
export const screen = {
  getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 0, height: 0 } }),
};
export const contextBridge = { exposeInMainWorld: noop };
export const ipcRenderer = { invoke: async () => undefined, on: noop, removeListener: noop };

export default {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  clipboard,
  screen,
  safeStorage,
};
