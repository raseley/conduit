/**
 * Desktop-app constants (electron-free).
 */

/** App display name (window titles, tray tooltip). */
export const APP_NAME = "Conduit";

/** Hostname of the Facepunch companion login page (token-capture allow-list). */
export const FACEPUNCH_LOGIN_HOST = "companion-rust.facepunch.com";

/** Fixed wizard window size (~520×640). */
export const WIZARD_SIZE = { width: 520, height: 640 } as const;

/** Fixed tray status window size (~360×420). */
export const STATUS_SIZE = { width: 360, height: 420 } as const;
