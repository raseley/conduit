/**
 * Typed error categories for the fcm package.
 *
 * Adapters (desktop wizard, bot-core) translate these into friendly
 * Discord/wizard messages; raw stack traces are never shown to end users.
 * fcm only ever surfaces the four categories it can produce:
 *
 * - {@link AuthError}       — Steam/Companion authentication failed or expired.
 * - {@link PairingError}    — a received push payload could not be decoded.
 * - {@link ConnectionError} — registration HTTP or the push transport failed.
 * - {@link ProtocolError}   — bytes from Google (an MCS frame or a protobuf
 *   message) were malformed.
 */

/** The closed set of {@link FcmError.category} values. */
export type FcmErrorCategory = "auth" | "pairing" | "connection" | "protocol";

/**
 * Why the push connection to Google failed, as far as Conduit can tell. Safe to
 * log (it carries no ids or tokens).
 *
 * - `network`     — no HTTP response, or a TCP/TLS failure before Google answered.
 * - `refused`     — Google answered but not usefully (for example a non-200
 *   check-in, or a reply that does not decode).
 * - `credentials` — Google rejected the device credentials (a check-in 400/401
 *   or a login error).
 */
export type PushFailure = "network" | "refused" | "credentials";

/** Base class so callers can `instanceof FcmError` to catch any fcm error. */
export class FcmError extends Error {
  /** Stable machine-readable category, handy for logging/branching. */
  readonly category: FcmErrorCategory;

  constructor(category: FcmErrorCategory, message: string, options?: { cause?: unknown }) {
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

/**
 * A registration HTTP call or the persistent push transport failed.
 *
 * The optional fields are all safe to log: none carries an id, token or body.
 */
export class ConnectionError extends FcmError {
  /** What kind of failure this was, when the push transport can tell. */
  readonly failure?: PushFailure;
  /** Google's `Error=<CODE>` from a `register3` reply, e.g. `PHONE_REGISTRATION_ERROR`. */
  readonly code?: string;
  /**
   * How long Google asked Conduit to wait before trying again (a parsed
   * `Retry-After` on a 429 or 503), in ms, clamped to an hour.
   */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: { cause?: unknown; failure?: PushFailure; code?: string; retryAfterMs?: number },
  ) {
    super("connection", message, options);
    this.failure = options?.failure;
    this.code = options?.code;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * Bytes received from Google were malformed: a bad MCS version byte, an
 * overlong varint, a frame size over the cap, a length running past the
 * buffer, invalid UTF-8, a group wire type, or a message missing a field
 * Conduit relies on. Thrown by the push codec (`push/`) so the caller can drop
 * and rebuild the connection rather than act on a corrupt stream. The encoders
 * throw it too for a value that cannot be put on the wire (an id that is not a
 * 64-bit decimal, say).
 */
export class ProtocolError extends FcmError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("protocol", message, options);
  }
}
