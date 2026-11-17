/**
 * Pairing/alarm payload decoding.
 *
 * A Rust+ push notification carries its real payload as a JSON string in
 * `data.body` (the envelope with id/name/desc/img/logo/url/type/playerId/
 * playerToken, plus entityId/entityType for an entity; servers from before
 * Facepunch's companion socket also sent ip/port). This module is the ONLY place that parses it, and it
 * does so defensively: any malformed payload throws a typed {@link PairingError}
 * rather than crashing the listener, which catches it and keeps the connection
 * alive.
 *
 * Output is one of three discriminated results so the service can route to the
 * right event without re-inspecting the payload.
 */

import { PairingError } from "./errors.js";
import type { AlarmNotification, DeathNotification, PairingNotification } from "./types.js";

/** Discriminated decode result routed to the matching FcmService event. */
export type DecodedPush =
  | { kind: "serverPairing"; pairing: PairingNotification }
  | { kind: "entityPairing"; pairing: PairingNotification }
  | { kind: "alarm"; alarm: AlarmNotification }
  | { kind: "death"; death: DeathNotification };

/** Pull the JSON `body` string out of a raw notification envelope. */
function extractBody(notification: unknown): Record<string, unknown> {
  if (!notification || typeof notification !== "object") {
    throw new PairingError("push notification was not an object");
  }
  const note = notification as Record<string, unknown>;
  // Envelope shape: `{ data: { body: "<json string>", … }, … }`. Some
  // transports deliver `data` already-parsed; handle both.
  const data = (note.data ?? note) as Record<string, unknown>;
  const rawBody = data.body ?? data;

  if (typeof rawBody === "string") {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (!parsed || typeof parsed !== "object") {
        throw new PairingError("decoded push body was not a JSON object");
      }
      return parsed as Record<string, unknown>;
    } catch (cause) {
      if (cause instanceof PairingError) throw cause;
      throw new PairingError("push body was not valid JSON", { cause });
    }
  }
  if (rawBody && typeof rawBody === "object") {
    return rawBody as Record<string, unknown>;
  }
  throw new PairingError("push notification had no decodable body");
}

/** Describe a value's shape without revealing it (see {@link PairingError.payloadShape}). */
function shapeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "string") return v.length === 0 ? "empty string" : "string";
  return typeof v;
}

/** Every field of a payload mapped to its value's shape. Values never leave this function. */
export function payloadShape(obj: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, shapeOf(v)]));
}

/** Require a non-empty string field, else raise a typed PairingError. */
function reqStr(obj: Record<string, unknown>, key: string, label: string): string {
  const v = obj[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  const problem = v === undefined ? "missing required field" : `has an unusable (${shapeOf(v)})`;
  throw new PairingError(`pairing payload ${problem} "${label}"`, {
    payloadShape: payloadShape(obj),
  });
}

/** Parse a numeric field that may arrive as a string (e.g. `"28017"`). */
/**
 * A required entity id. The server's ids are 64-bit; Conduit holds them as JS
 * numbers, exact up to 2^53, so anything that is not a non-negative safe
 * integer is rejected rather than rounded onto another device's id. The
 * payload usually carries it as a decimal string.
 */
function reqEntityId(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
  throw new PairingError(`pairing payload field "${key}" was not a valid entity id`, {
    payloadShape: payloadShape(obj),
  });
}

function optStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function optNum(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Decode a raw push into a typed, routed result. Throws {@link PairingError}
 * for any payload it cannot safely interpret.
 */
export function decodePush(notification: unknown): DecodedPush {
  const body = extractBody(notification);
  const type = typeof body.type === "string" ? body.type : undefined;

  // Death pushes fire when the operator's player dies. Checked before the alarm
  // heuristic below: a death payload can also carry a title with no `ip`, which
  // would otherwise be misrouted to `alarm`.
  if (type === "death") {
    const targetName =
      typeof body.targetName === "string" && body.targetName.length > 0
        ? body.targetName
        : undefined;
    const message =
      typeof body.message === "string" && body.message.length > 0
        ? body.message
        : typeof body.name === "string" && body.name.length > 0
          ? body.name
          : undefined;
    return {
      kind: "death",
      death: {
        name: targetName ?? "A player",
        targetId: typeof body.targetId === "string" ? body.targetId : undefined,
        message,
        serverId:
          typeof body.id === "string"
            ? body.id
            : typeof body.serverId === "string"
              ? body.serverId
              : undefined,
      },
    };
  }

  // Alarm pushes carry a title/message rather than pairing details. Pairing
  // pushes no longer carry an ip either, so the title heuristic must not
  // swallow a "server"/"entity" push.
  if (type === "alarm" || (type !== "server" && type !== "entity" && body.title != null)) {
    return {
      kind: "alarm",
      alarm: {
        title: typeof body.title === "string" ? body.title : "Alarm",
        message: typeof body.message === "string" ? body.message : "",
        serverId:
          typeof body.id === "string"
            ? body.id
            : typeof body.serverId === "string"
              ? body.serverId
              : undefined,
        playerId: typeof body.playerId === "string" ? body.playerId : undefined,
      },
    };
  }

  if (type !== "server" && type !== "entity") {
    throw new PairingError(`unrecognised pairing payload type: ${type ?? "<missing>"}`);
  }

  const pairing: PairingNotification = {
    type,
    // Absent on current servers (companion socket); kept when a server sends them.
    ip: optStr(body, "ip"),
    port: optNum(body, "port"),
    name: reqStr(body, "name", "name"),
    desc: typeof body.desc === "string" ? body.desc : "",
    id: reqStr(body, "id", "id"),
    playerId: reqStr(body, "playerId", "playerId"),
    playerToken: reqStr(body, "playerToken", "playerToken"),
  };

  if (type === "entity") {
    pairing.entityId = reqEntityId(body, "entityId");
    pairing.entityType = optNum(body, "entityType");
    return { kind: "entityPairing", pairing };
  }

  return { kind: "serverPairing", pairing };
}
