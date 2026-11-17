/**
 * @conduit/fcm — public entry point.
 *
 * Everything to do with Google push delivery and Rust+ pairing.
 * The one fragile dependency (`@liamcottle/push-receiver`) is quarantined
 * behind {@link PushReceiverDriver} in `driver/pushReceiverDriver.ts`; all other
 * code here depends only on that interface. Depends only on the push library
 * (+ HTTP via Node's global `fetch`) and emits typed events. No Discord,
 * Electron, or Rust+ client.
 */

export { FcmService } from "./service.js";
export type { FcmServiceDeps, FcmEventMap } from "./service.js";

export type {
  FcmCredentials,
  FcmRawCredentials,
  FcmRegisterOptions,
  PairingNotification,
  AlarmNotification,
  DeathNotification,
} from "./types.js";

// The quarantine seam + its real adapter, for the desktop app to wire up.
export {
  createPushReceiverDriver,
  type PushReceiverDriver,
  type PushConnection,
  type RawPush,
} from "./driver/pushReceiverDriver.js";

// Network seams (injectable; exported so callers can swap mocks in tests).
export { exchangeExpoPushToken, type ExpoExchangeFn } from "./net/expo.js";
export {
  registerWithCompanionApi,
  type CompanionRegisterFn,
  type CompanionRegisterInput,
  type CompanionRegisterResult,
} from "./net/companion.js";

// Steam login contract: the URL to open and the redirect that ends it.
export { FACEPUNCH_LOGIN_URL, RUST_PLUS_AUTH_REDIRECT } from "./constants.js";

// Decoding (exported so it can be unit-tested / reused).
export { decodePush, type DecodedPush } from "./decode.js";

// Typed errors.
export { FcmError, AuthError, PairingError, ConnectionError } from "./errors.js";

// Redaction + logger seam.
export { redact, noopLogger, REDACTED, SENSITIVE_KEYS, type Logger } from "./redact.js";
