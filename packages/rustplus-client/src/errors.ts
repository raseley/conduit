/**
 * Typed error categories for `@conduit/rustplus-client`.
 *
 * Callers (e.g. `@conduit/bot-core`) discriminate on these classes to drive
 * recovery: an {@link AuthError} means the credentials need replacing rather
 * than the request retrying, a {@link RateLimitError} signals local
 * back-pressure, and so on. All extend the base {@link RustPlusError} so a
 * single `instanceof` check can catch any library-originated failure.
 */

/** Base class for every error surfaced by this library. */
export class RustPlusError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      // `cause` is standard on Error since ES2022 but we set it defensively so
      // it survives older transpilation targets too.
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Restore prototype chain for older transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Authentication / authorization failure, so retrying with the same
 * credentials is pointless. Raised when:
 * - the server rejects the `playerId` / `playerToken` on a request (it answers
 *   `not_found`; see `RustPlusClient#classifyNotFound`), or answers `banned`;
 * - the companion socket refuses the auth token at the handshake (401/403).
 *
 * A request-level AuthError is terminal **for the request that raised it
 * only**; the client takes no connection-level action. The `playerToken`
 * travels on each request, not on the socket, so the socket stays open, other
 * requests are unaffected, and a later drop reconnects with backoff exactly like
 * any other.
 *
 * Acting on it is the host's job: obtain fresh credentials (re-pair the server
 * for a new `playerToken`, or sign in again for a new auth token) and build a
 * new client with them, or call `disconnect()` to stop this one from
 * reconnecting.
 */
export class AuthError extends RustPlusError {
  /**
   * Which credential was rejected, when known: the companion socket's auth
   * token (the Steam login; renewed by signing in again), or the pairing's
   * `playerToken` (renewed by re-pairing the server). Absent for a ban.
   */
  readonly credential?: "authToken" | "playerToken";

  constructor(
    message: string,
    options?: { cause?: unknown; credential?: "authToken" | "playerToken" },
  ) {
    super(message, options);
    this.credential = options?.credential;
  }
}

/**
 * A request was refused for rate limiting: the server answered `rate_limit`
 * (its bucket for this steamId is empty; it is shared with the player's phone
 * app, and the client then empties its own bucket so later requests wait), or
 * the local bucket could never satisfy the request's cost. Normal local
 * back-pressure queues silently and does not throw.
 */
export class RateLimitError extends RustPlusError {}

/**
 * The WebSocket transport failed: connect refused, socket closed mid-request,
 * request timed out, or the client was disconnected while a request was
 * pending.
 */
export class ConnectionError extends RustPlusError {}

/**
 * The server will not let this player reach an entity: it answered
 * `not_found` to an entity request while accepting the player's credentials.
 * (The server answers bad credentials with `not_found` too; the client tells
 * the two apart with a probe and raises {@link AuthError} for those.) The
 * entity was removed in-game, the server was wiped (resetting entity ids), it
 * is not a smart device, or it sits under a tool cupboard the player is not
 * authorised on. The host should say so rather than refresh credentials.
 */
export class EntityNotFoundError extends RustPlusError {}

/**
 * Why a CCTV camera could not be shown (see {@link CameraUnavailableError}):
 * - `playerOnline`: the server answered `player_online`. It will not stream a
 *   camera over Rust+ while the paired player is connected to it in-game.
 * - `notFound`: the subscribe was answered without camera details, so the
 *   identifier is wrong or renamed, or the camera is gone.
 * - `noFrames`: the camera sent no image before the capture timeout.
 */
export type CameraUnavailableReason = "playerOnline" | "notFound" | "noFrames";

/**
 * A CCTV camera capture failed for a reason the user can act on, named by
 * {@link reason}. Raised by `captureCameraFrame`, and for any request the
 * server answers with `player_online` (only its camera handler sends that).
 */
export class CameraUnavailableError extends RustPlusError {
  readonly reason: CameraUnavailableReason;

  constructor(message: string, options: { cause?: unknown; reason: CameraUnavailableReason }) {
    super(message, options);
    this.reason = options.reason;
  }
}

/**
 * The server returned an `AppError`, or a message could not be
 * decoded/correlated. Carries the raw server error string when present.
 */
export class ProtocolError extends RustPlusError {
  /** The raw `AppError.error` string from the server, when available. */
  readonly serverError?: string;

  constructor(message: string, options?: { cause?: unknown; serverError?: string }) {
    super(message, options);
    this.serverError = options?.serverError;
  }
}
