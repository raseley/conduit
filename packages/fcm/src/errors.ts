/**
 * Typed error categories for the fcm package.
 *
 * Adapters (desktop wizard, bot-core) translate these into friendly
 * Discord/wizard messages; raw stack traces are never shown to end users.
 * fcm only ever surfaces the three categories it can produce:
 *
 * - {@link AuthError}       — Steam/Companion authentication failed or expired.
 * - {@link PairingError}    — a received push payload could not be decoded.
 * - {@link ConnectionError} — registration HTTP or the push transport failed.
 */

/** Base class so callers can `instanceof FcmError` to catch any fcm error. */
export class FcmError extends Error {
  /** Stable machine-readable category, handy for logging/branching. */
  readonly category: "auth" | "pairing" | "connection";

  constructor(
    category: "auth" | "pairing" | "connection",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.category = category;
    this.name = new.target.name;
    // Restore prototype chain for older transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Steam login / Companion API registration / token-refresh authentication failure. */
export class AuthError extends FcmError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("auth", message, options);
  }
}

/**
 * A push payload arrived but could not be safely parsed into a
 * {@link PairingNotification}/{@link AlarmNotification}. Thrown by the decoder
 * and caught by the listener so a single malformed payload never crashes the
 * persistent connection.
 */
export class PairingError extends FcmError {
  /**
   * When a payload field failed validation: every field of the payload mapped
   * to the *shape* of its value (`"string"`, `"empty string"`, `"number"`, …),
   * never the value itself, so it is safe to log even though the payload carries
   * a `playerToken`. Lets a changed payload format be diagnosed from the log.
   */
  readonly payloadShape?: Record<string, string>;

  constructor(
    message: string,
    options?: { cause?: unknown; payloadShape?: Record<string, string> },
  ) {
    super("pairing", message, options);
    this.payloadShape = options?.payloadShape;
  }
}

/** A registration HTTP call or the persistent push transport failed. */
export class ConnectionError extends FcmError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("connection", message, options);
  }
}
