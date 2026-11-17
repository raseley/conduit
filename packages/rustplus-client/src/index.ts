/**
 * @conduit/rustplus-client
 *
 * Manages a single authenticated WebSocket connection to one Rust server:
 * request/response correlation, server-pushed broadcasts as typed events,
 * token-bucket rate limiting, automatic reconnection, and re-subscription of
 * tracked entities. Depends only on `@conduit/rustplus-proto` (+ `ws`). No
 * Discord, Electron, or FCM. This is a publishable library.
 *
 * @example
 * ```ts
 * import { RustPlusClient } from "@conduit/rustplus-client";
 *
 * // Through Facepunch's companion socket (current servers advertise no ip/port):
 * const client = new RustPlusClient({
 *   companion: { serverId: "ccaf8155-…", getAuthToken: () => steamAuthToken },
 *   playerId: "7656119...",   // Steam64 as a string
 *   playerToken: "123456789",
 * });
 * // Or directly, to a server that still accepts it: { ip: "1.2.3.4", port: 28082, … }
 *
 * client.on("entityChanged", (c) => console.log("entity", c.entityId, c.value));
 * client.on("teamChat", (m) => console.log(`${m.name}: ${m.message}`));
 *
 * await client.connect();
 * const info = await client.getInfo();
 * await client.getEntityInfo(123456);          // start receiving its broadcasts
 * await client.setEntityValue(123456, true);   // turn a switch on
 * ```
 */

export { AUTH_RETRY_DELAYS_MS, RustPlusClient } from "./client.js";
export type {
  RustPlusClientOptions,
  RustPlusClientEvents,
  ReconnectConfig,
  CompanionRoute,
} from "./client.js";

// Camera frame rendering — decode `AppCameraRays` broadcasts into a PNG. Exposed
// for consumers assembling frames from raw broadcasts via `sendRequest`/`message`.
export {
  IndexGenerator,
  buildSamplePositionBuffer,
  decodeRays,
  encodeFrameToPng,
  renderFrames,
} from "./camera.js";
export type { CameraRayFrame } from "./camera.js";

export { TokenBucket, DEFAULT_TOKEN_BUCKET, DEFAULT_REQUEST_COSTS } from "./rate-limiter.js";
export type { TokenBucketConfig, RequestCostKind } from "./rate-limiter.js";

export {
  RustPlusError,
  AuthError,
  RateLimitError,
  ConnectionError,
  EntityNotFoundError,
  CameraUnavailableError,
  ProtocolError,
} from "./errors.js";
export type { CameraUnavailableReason } from "./errors.js";

export type {
  EntityType,
  ServerInfo,
  GameTime,
  TeamMember,
  TeamInfo,
  EntityItem,
  EntityInfo,
  EntityChange,
  TeamChatMessage,
} from "./types.js";

// Mapping helpers, exported for advanced consumers who hold raw proto payloads
// (e.g. from `sendRequest`) and want the same normalization the client applies.
export {
  mapServerInfo,
  mapGameTime,
  mapTeamInfo,
  mapEntityInfo,
  mapEntityChange,
  mapTeamChatMessage,
  mapEntityType,
  longToString,
} from "./mappers.js";
