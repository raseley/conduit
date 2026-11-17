/**
 * Clean domain types for `@conduit/rustplus-client`.
 *
 * These flatten/normalize the raw protobufjs payloads from
 * `@conduit/rustplus-proto` into plain JSON-friendly shapes so consumers
 * (notably `@conduit/bot-core`) never touch protobufjs `Long`/message classes.
 * 64-bit ids (Steam64) are surfaced as decimal **strings** to avoid precision
 * loss; everything else is a `number`/`string`/`boolean`.
 *
 * The mapping functions live in `./mappers.ts`.
 */

/** Logical entity kind, normalized from the proto `AppEntityType` enum. */
export type EntityType = "switch" | "alarm" | "storageMonitor" | "unknown";

/** Flattened {@link https | AppInfo}: static + live server status. */
export interface ServerInfo {
  name: string;
  headerImage: string;
  url: string;
  /** Map name (e.g. "Procedural Map"). */
  map: string;
  mapSize: number;
  /** Wipe time as a Unix epoch (seconds). */
  wipeTime: number;
  players: number;
  maxPlayers: number;
  queuedPlayers: number;
  seed?: number;
  salt?: number;
  logoImage?: string;
  /** Nexus name, when the server is part of a Nexus. */
  nexus?: string;
  nexusId?: number;
  nexusZone?: string;
}

/** Flattened `AppTime` — in-game clock + day/night schedule. */
export interface GameTime {
  /** Real-world minutes per in-game day. */
  dayLengthMinutes: number;
  timeScale: number;
  /** In-game hour at which the sun rises (0–24). */
  sunrise: number;
  /** In-game hour at which the sun sets (0–24). */
  sunset: number;
  /** Current in-game time as an hour-of-day float (0–24). */
  time: number;
  /** Convenience: `true` when `sunrise <= time < sunset`. */
  isDay: boolean;
}

/** A member of the operator's in-game team (`AppTeamInfo.Member`). */
export interface TeamMember {
  /** Steam64 id as a decimal string. */
  steamId: string;
  name: string;
  x: number;
  y: number;
  isOnline: boolean;
  /** Spawn time as a Unix epoch (seconds). */
  spawnTime: number;
  isAlive: boolean;
  /** Death time as a Unix epoch (seconds). */
  deathTime: number;
}

/** Flattened `AppTeamInfo`. */
export interface TeamInfo {
  /** Steam64 id of the team leader, as a decimal string. */
  leaderSteamId: string;
  members: TeamMember[];
}

/** A single item stack inside a storage entity (`AppEntityPayload.Item`). */
export interface EntityItem {
  itemId: number;
  quantity: number;
  itemIsBlueprint: boolean;
}

/**
 * Flattened `AppEntityInfo`. Shape varies by {@link EntityType}: switches/alarms
 * carry `value`; storage monitors carry `items`/`capacity`/`hasProtection`.
 */
export interface EntityInfo {
  entityId: number;
  type: EntityType;
  /** On/off state for switches and alarms. */
  value?: boolean;
  /** Storage-monitor contents. */
  items: EntityItem[];
  /** Storage-monitor slot capacity. */
  capacity?: number;
  /** Storage-monitor (tool cupboard) decay protection flag. */
  hasProtection?: boolean;
  /** Protection expiry as a Unix epoch (seconds), when applicable. */
  protectionExpiry?: number;
}

/**
 * A pushed entity-state change (`AppEntityChanged`), emitted as the
 * `entityChanged` event. The server only broadcasts these after a prior
 * `getEntityInfo` on the entity.
 */
export interface EntityChange {
  entityId: number;
  /** On/off state for switches/alarms (the common case). */
  value?: boolean;
  /** Storage-monitor contents, when the changed entity is a monitor. */
  items: EntityItem[];
  capacity?: number;
  hasProtection?: boolean;
  protectionExpiry?: number;
}

/** A single team-chat message (`AppTeamMessage`), emitted as `teamChat`. */
export interface TeamChatMessage {
  /** Steam64 id of the sender, as a decimal string. */
  steamId: string;
  name: string;
  message: string;
  /** Chat color string (e.g. team-member hex). */
  color: string;
  /** Message time as a Unix epoch (seconds). */
  time: number;
}
