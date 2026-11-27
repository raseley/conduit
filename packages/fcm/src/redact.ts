/**
 * Redaction + logging seam.
 *
 * fcm handles the most sensitive material in the whole app: FCM/GCM security
 * tokens, the Steam auth token, the Expo push token, and — in pairing payloads —
 * the per-player `playerToken`. NONE of these may ever reach a log sink or a
 * diagnostics blob.
 *
 * This module provides:
 *  - a tiny structural {@link Logger} type so the desktop app can inject its
 *    `pino` instance WITHOUT fcm taking a pino dependency (it stays lean),
 *  - {@link redact}, a deep cloner that masks any field whose key is sensitive
 *    and is the ONLY function fcm uses on any log/diagnostic path.
 *
 * Default logger is a no-op: fcm is silent unless a logger is injected.
 */

/** Minimal structural logger. Compatible with pino, console, etc. */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** A logger that discards everything. fcm's default — no output unless injected. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Replacement string written in place of any redacted value. */
export const REDACTED = "[REDACTED]";

/**
 * The single source of truth for field names whose values must never be logged.
 * Covers the Steam auth token, FCM/GCM secrets, the Expo token, the
 * pairing-payload `playerToken`, the common aliases the upstream library and
 * Companion API use for the same secrets, and the Pushover credentials the host
 * app persists.
 *
 * Written in the canonical camelCase spelling the code actually uses, because
 * consumers differ in how they match: {@link redact} compares case-insensitively,
 * while the desktop logger derives case-sensitive pino `redact.paths` and the
 * diagnostics scrubber derives a regex from this same list. Add a new secret
 * here and every redaction layer picks it up — never keep a second list.
 */
export const SENSITIVE_KEYS: readonly string[] = Object.freeze([
  "playerToken",
  "steamAuthToken",
  "steamToken",
  "authToken",
  "expoPushToken",
  "pushToken",
  "securityToken",
  // The GCM device id. The push client handles it as a bare value (the login's
  // `user`, `resource` and `device_id`), not only inside `gcm`.
  "androidId",
  "privateKey",
  "secret",
  "authSecret",
  "token",
  "keys",
  "fcm",
  "gcm",
  "appToken",
  "userKey",
]);

/** Lower-cased lookup form of {@link SENSITIVE_KEYS} for case-insensitive matching. */
const SENSITIVE_KEYS_LOWER = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

/**
 * Deep-clone `value`, replacing any sensitive field (by key name) with
 * {@link REDACTED}. Safe to hand straight to a logger. Non-plain values
 * (strings, numbers, etc.) pass through unchanged; cycles are broken.
 *
 * Always run a payload through this before logging — never log a raw
 * credential object or pairing payload.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value as object)) {
    return "[Circular]";
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS_LOWER.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(v, seen);
    }
  }
  return out;
}
