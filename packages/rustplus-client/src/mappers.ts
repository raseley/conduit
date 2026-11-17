/**
 * Pure mapping functions from raw protobufjs payloads
 * (`@conduit/rustplus-proto`) to the clean domain types in `./types.ts`.
 *
 * Centralizing the conversions keeps `Long` and protobufjs message shapes out
 * of the public surface: callers receive plain objects with 64-bit ids rendered
 * as decimal strings.
 */

import { AppEntityType, Long } from "@conduit/rustplus-proto";
import type { rustplus } from "@conduit/rustplus-proto";

import { ProtocolError } from "./errors.js";

import type {
  EntityChange,
  EntityInfo,
  EntityItem,
  EntityType,
  GameTime,
  ServerInfo,
  TeamChatMessage,
  TeamInfo,
  TeamMember,
} from "./types.js";

/**
 * Render a protobuf 64-bit field (which protobufjs may deliver as a `Long`,
 * a `number`, or a numeric `string`) as a decimal string with full precision.
 */
export function longToString(value: Long | number | string | null | undefined): string {
  if (value === null || value === undefined) return "0";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  // `Long` instance.
  return (value as Long).toString();
}

/** Coerce a possibly-`Long` numeric field to a JS `number` (32-bit-range fields). */
function toNumber(value: Long | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return (value as Long).toNumber();
}

/**
 * Entity ids are the server's 64-bit `NetworkableId`s. Long-running servers
 * issue ids above 2^32, so the wire fields are `uint64`; the domain keeps them
 * as JS `number`s, which are exact up to 2^53 (`Number.MAX_SAFE_INTEGER`),
 * far beyond any id a server will reach. These two conversions are the
 * boundary: both reject an id a `number` cannot hold exactly, rather than
 * address the wrong device.
 */
export function entityIdToWire(entityId: number): Long {
  if (!Number.isSafeInteger(entityId) || entityId < 0) {
    throw new ProtocolError(`entity id ${entityId} is not a non-negative safe integer`);
  }
  return Long.fromNumber(entityId, true);
}

/** The wire `uint64` entity id as a `number`; see {@link entityIdToWire}. */
export function entityIdFromWire(value: Long | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const text =
    typeof value === "object" ? Long.fromValue(value).toUnsigned().toString() : String(value);
  const id = Number(text);
  if (!Number.isSafeInteger(id) || String(id) !== text) {
    throw new ProtocolError(`entity id ${text} does not fit a JS number exactly`);
  }
  return id;
}

/** Map the proto `AppEntityType` enum to the domain {@link EntityType}. */
export function mapEntityType(
  type: rustplus.AppEntityType | number | null | undefined,
): EntityType {
  switch (type) {
    case AppEntityType.Switch:
      return "switch";
    case AppEntityType.Alarm:
      return "alarm";
    case AppEntityType.StorageMonitor:
      return "storageMonitor";
    default:
      return "unknown";
  }
}

export function mapServerInfo(info: rustplus.IAppInfo): ServerInfo {
  return {
    name: info.name ?? "",
    headerImage: info.headerImage ?? "",
    url: info.url ?? "",
    map: info.map ?? "",
    mapSize: info.mapSize ?? 0,
    wipeTime: info.wipeTime ?? 0,
    players: info.players ?? 0,
    maxPlayers: info.maxPlayers ?? 0,
    queuedPlayers: info.queuedPlayers ?? 0,
    seed: info.seed ?? undefined,
    salt: info.salt ?? undefined,
    logoImage: info.logoImage ?? undefined,
    nexus: info.nexus ?? undefined,
    nexusId: info.nexusId ?? undefined,
    nexusZone: info.nexusZone ?? undefined,
  };
}

export function mapGameTime(time: rustplus.IAppTime): GameTime {
  const sunrise = time.sunrise ?? 0;
  const sunset = time.sunset ?? 0;
  const current = time.time ?? 0;
  return {
    dayLengthMinutes: time.dayLengthMinutes ?? 0,
    timeScale: time.timeScale ?? 0,
    sunrise,
    sunset,
    time: current,
    isDay: current >= sunrise && current < sunset,
  };
}

function mapTeamMember(m: rustplus.AppTeamInfo.IMember): TeamMember {
  return {
    steamId: longToString(m.steamId),
    name: m.name ?? "",
    x: m.x ?? 0,
    y: m.y ?? 0,
    isOnline: m.isOnline ?? false,
    spawnTime: m.spawnTime ?? 0,
    isAlive: m.isAlive ?? false,
    deathTime: m.deathTime ?? 0,
  };
}

export function mapTeamInfo(info: rustplus.IAppTeamInfo): TeamInfo {
  return {
    leaderSteamId: longToString(info.leaderSteamId),
    members: (info.members ?? []).map(mapTeamMember),
  };
}

function mapItem(item: rustplus.AppEntityPayload.IItem): EntityItem {
  return {
    itemId: item.itemId ?? 0,
    quantity: item.quantity ?? 0,
    itemIsBlueprint: item.itemIsBlueprint ?? false,
  };
}

export function mapEntityInfo(info: rustplus.IAppEntityInfo): EntityInfo {
  const payload = info.payload ?? {};
  return {
    // entityId is not carried on AppEntityInfo itself; the client fills it in.
    entityId: 0,
    type: mapEntityType(info.type),
    value: payload.value ?? undefined,
    items: (payload.items ?? []).map(mapItem),
    capacity: payload.capacity ?? undefined,
    hasProtection: payload.hasProtection ?? undefined,
    protectionExpiry: payload.protectionExpiry ?? undefined,
  };
}

export function mapEntityChange(changed: rustplus.IAppEntityChanged): EntityChange {
  const payload = changed.payload ?? {};
  return {
    entityId: entityIdFromWire(changed.entityId),
    value: payload.value ?? undefined,
    items: (payload.items ?? []).map(mapItem),
    capacity: payload.capacity ?? undefined,
    hasProtection: payload.hasProtection ?? undefined,
    protectionExpiry: payload.protectionExpiry ?? undefined,
  };
}

export function mapTeamChatMessage(msg: rustplus.IAppTeamMessage): TeamChatMessage {
  return {
    steamId: longToString(msg.steamId),
    name: msg.name ?? "",
    message: msg.message ?? "",
    color: msg.color ?? "",
    time: toNumber(msg.time),
  };
}
