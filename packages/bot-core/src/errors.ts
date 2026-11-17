/**
 * Typed error categories for `@conduit/bot-core`.
 *
 * bot-core is the bridge every Discord interaction lands on, so its failures
 * must be discriminable: the discord adapter turns a thrown error into
 * user-facing copy by matching on `err.name` (`friendlyError`), and a bare
 * `Error` collapses to the generic message. Errors that originate *below*
 * bot-core (`@conduit/rustplus-client`'s `AuthError` / `ConnectionError` / …,
 * `@conduit/fcm`'s `FcmError`s) propagate unchanged; the classes here cover the
 * failures bot-core itself detects:
 *
 * - {@link StateError}      — the request refers to state bot-core doesn't hold
 *                             (unknown server/entity, wrong entity kind, server
 *                             not connected).
 * - {@link ValidationError} — the caller supplied a value bot-core rejects
 *                             (empty camera identifier, out-of-range delay).
 *
 * All extend {@link BotCoreError} so a single `instanceof` check catches any
 * bot-core-originated failure.
 */

/** Base class for every error bot-core itself raises. */
export class BotCoreError extends Error {
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
 * The operation targets state bot-core does not hold, or holds in an
 * incompatible shape: an unknown server or entity, an entity of the wrong kind
 * (e.g. a switch-only setting applied to an alarm), or a server with no
 * connected client. Retrying unchanged will not help — the caller's view of the
 * world (typically a stale Discord panel) is out of date.
 */
export class StateError extends BotCoreError {}

/**
 * A caller-supplied value failed bot-core's validation (e.g. an empty camera
 * identifier or an auto-revert delay outside the accepted range). The message is
 * written to be safe to show to the operator.
 */
export class ValidationError extends BotCoreError {}
