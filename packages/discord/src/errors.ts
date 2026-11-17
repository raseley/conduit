/**
 * Friendly user-facing copy: never leak a stack trace to Discord.
 *
 * All denial/failure replies are ephemeral and phrased in a friendly voice:
 * short, plain, second-person, lightly warm. Protocol detail stays in the logs.
 */

/** The standard ephemeral denial reply. */
export const DENIAL_MESSAGE = "⛔ You need an admin role to do that.";

/** Denial when the member holds no mapped role at all. */
export const NO_ROLE_MESSAGE =
  "⛔ You don't have permission to use Conduit yet — ask an admin to grant your role.";

/** State-lock timeout ephemeral. */
export const COULD_NOT_CONFIRM_MESSAGE =
  "⚠️ Couldn't confirm the change — the server didn't report back. Try again in a moment.";

/** Generic failure when a bot-core call throws. */
export const GENERIC_FAILURE_MESSAGE =
  "⚠️ Something went wrong talking to the server. Please try again.";

/** Setup must be done before objects can be controlled. */
export const NO_CONTROL_CHANNEL_MESSAGE =
  "⚠️ No control channel is set yet. Run `/conduit setup` and pick one first.";

/**
 * The server will not let the player reach the device: it was removed in-game,
 * the map was wiped, or (often) the player is no longer authorised on the tool
 * cupboard that covers it. Re-pairing fixes only the first two.
 */
export const ENTITY_NOT_FOUND_MESSAGE =
  "🚫 The server couldn't find that device, or you're no longer authorised on the tool cupboard that covers it. If you lost TC access, re-authorise on it in-game. If the device was removed or the map was wiped, remove it from its **Settings**, then re-pair it.";

/**
 * bot-core no longer holds what the click refers to (unknown server/entity, wrong
 * device kind, or the server has no connected client) — a stale panel, usually.
 */
export const STALE_STATE_MESSAGE =
  "⚠️ Conduit can't act on that right now — the server isn't connected yet, or this device is no longer set up. Give it a moment and try again; if it keeps happening, re-pair the device.";

/**
 * The server will not show a camera while the paired player is connected to it
 * in-game (it answers `player_online`).
 */
export const CAMERA_PLAYER_ONLINE_MESSAGE =
  "📷 Rust+ can't show cameras while you're connected to the server in-game. Disconnect from the server, then try Capture again.";

/** The server knows no camera by that identifier (wrong, renamed, or gone). */
export const CAMERA_NOT_FOUND_MESSAGE =
  "📷 The server couldn't find that camera. Check the identifier set on it in-game; if it changed, **Remove** this panel and add the camera again.";

/** The camera sent no image before the capture timed out. */
export const CAMERA_NO_FRAMES_MESSAGE =
  "📷 The camera didn't send an image in time. Try Capture again. If it keeps failing, make sure you're not connected to the server in-game.";

/** A string property of a thrown value, read structurally (lower tiers' classes are not imported). */
function stringProp(err: unknown, key: string): string | undefined {
  if (!err || typeof err !== "object" || !(key in err)) return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The server's raw `AppError` code on a `ProtocolError`, when it is a plain
 * enum-like token (`player_online`, `no_permission`, …). It comes from the
 * server, not a user, but anything else is dropped rather than posted.
 */
function serverErrorCode(err: unknown): string | undefined {
  const code = stringProp(err, "serverError");
  return code !== undefined && /^[a-z0-9_]{1,40}$/i.test(code) ? code : undefined;
}

/**
 * A few words saying why an action failed, for the audit log in the logging
 * channel (the member gets {@link friendlyError}'s full sentence).
 */
export function shortFailureReason(err: unknown): string {
  const name = stringProp(err, "name") ?? "";
  switch (name) {
    case "AuthError":
      return "the server rejected Conduit's credentials";
    case "RateLimitError":
      return "rate-limited";
    case "ConnectionError":
      return "the server is unreachable";
    case "EntityNotFoundError":
      return "device not found, or no tool-cupboard access";
    case "StateError":
      return "not available right now";
    case "CameraUnavailableError":
      switch (stringProp(err, "reason")) {
        case "playerOnline":
          return "player is in-game";
        case "notFound":
          return "camera not found";
        case "noFrames":
          return "camera sent no image";
        default:
          return "camera unavailable";
      }
    case "ProtocolError": {
      // Name the server's code, so the next unmapped one is diagnosable from Discord.
      const code = serverErrorCode(err);
      return code ? `server refused: \`${code}\`` : "unexpected server response";
    }
    default:
      return "unexpected error";
  }
}

/**
 * Turn an arbitrary thrown value into a friendly, stack-free message. Known
 * categories (auth/rate-limit/connection/stale state) get a tailored line;
 * everything else falls back to the generic copy. The raw error is for logging
 * only.
 */
export function friendlyError(err: unknown): string {
  const name = stringProp(err, "name") ?? "";
  switch (name) {
    case "AuthError":
      return "⚠️ The server rejected Conduit's credentials. The operator may need to re-pair the server or sign in with Steam again.";
    case "RateLimitError":
      return "⏳ Slow down a moment — the server is rate-limiting requests.";
    case "ConnectionError":
      return "🔌 The server is unreachable right now. It'll reconnect automatically.";
    case "EntityNotFoundError":
      return ENTITY_NOT_FOUND_MESSAGE;
    case "StateError":
      return STALE_STATE_MESSAGE;
    case "CameraUnavailableError":
      switch (stringProp(err, "reason")) {
        case "playerOnline":
          return CAMERA_PLAYER_ONLINE_MESSAGE;
        case "notFound":
          return CAMERA_NOT_FOUND_MESSAGE;
        case "noFrames":
          return CAMERA_NO_FRAMES_MESSAGE;
        default:
          return GENERIC_FAILURE_MESSAGE;
      }
    default:
      return GENERIC_FAILURE_MESSAGE;
  }
}
