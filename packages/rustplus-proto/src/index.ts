/**
 * @conduit/rustplus-proto
 *
 * Owns the vendored `proto/rustplus.proto` schema, the generated TypeScript
 * message types (emitted into `./generated` by `pnpm gen:proto`, using
 * protobufjs static-module), and a thin encode/decode codec. No network,
 * no state.
 *
 * The Rust+ protocol: requests are `AppRequest` messages; responses
 * and server-pushed broadcasts are `AppMessage` messages. This package exposes
 * the generated message classes plus two thin codec helpers. Correlation,
 * sequence numbers, rate limiting, and reconnection are NOT handled here — that
 * is the `@conduit/rustplus-client`'s job.
 */

import Long from "long";

import { rustplus } from "./generated/rustplus.js";

// 64-bit protobuf fields (e.g. `playerId`, `steamId`) are modelled as `Long`
// to preserve full precision (Steam64 ids exceed Number.MAX_SAFE_INTEGER).
// Re-exported so downstream callers can build them: `Long.fromString(steamId)`.
export { Long };

// ── Generated message classes ────────────────────────────────────────────────
// Re-exported for downstream consumers (`@conduit/rustplus-client`, etc.).
// Names mirror the messages defined in `proto/rustplus.proto`.

export const {
  // Envelope
  AppRequest,
  AppMessage,
  AppResponse,
  AppBroadcast,
  // Request payloads
  AppEmpty,
  AppSendMessage,
  AppSetEntityValue,
  AppPromoteToLeader,
  AppGetNexusAuth,
  AppFlag,
  AppCameraSubscribe,
  AppCameraInput,
  // Response payloads
  AppSuccess,
  AppError,
  AppInfo,
  AppTime,
  AppMap,
  AppTeamInfo,
  AppTeamChat,
  AppTeamMessage,
  AppEntityInfo,
  AppEntityPayload,
  AppMapMarkers,
  AppMarker,
  AppClanInfo,
  AppClanChat,
  AppClanMessage,
  AppNexusAuth,
  AppCameraInfo,
  // Broadcast payloads
  AppTeamChanged,
  AppNewTeamMessage,
  AppEntityChanged,
  AppClanChanged,
  AppNewClanMessage,
  AppCameraRays,
  // Enums
  AppEntityType,
  AppMarkerType,
} = rustplus;

// The full namespace, for anything not re-exported individually above
// (Vector2/3/4, Color, Ray, ClanInfo, etc.).
export { rustplus };

// ── Type aliases ─────────────────────────────────────────────────────────────
// protobufjs generates both a message class (`AppRequest`) and a plain-object
// interface (`IAppRequest`). The class instances are what `encode`/`decode`
// operate on. Downstream code may pass either the class or a plain object that
// satisfies the interface; encode accepts `I*`-shaped plain objects.

export type AppRequest = rustplus.AppRequest;
export type IAppRequest = rustplus.IAppRequest;
export type AppMessage = rustplus.AppMessage;
export type IAppMessage = rustplus.IAppMessage;
export type AppResponse = rustplus.AppResponse;
export type IAppResponse = rustplus.IAppResponse;
export type AppBroadcast = rustplus.AppBroadcast;
export type IAppBroadcast = rustplus.IAppBroadcast;

// ── Thin codec ───────────────────────────────────────────────────────────────

/**
 * Encode an `AppRequest` to the Rust+ wire format.
 *
 * Accepts either an `AppRequest` instance or a plain object satisfying the
 * generated `IAppRequest` shape. Thin wrapper over the generated encoder —
 * no sequence/correlation logic (that is the client's responsibility).
 */
export function encodeRequest(req: rustplus.IAppRequest): Uint8Array {
  return rustplus.AppRequest.encode(req).finish();
}

/**
 * Decode a Rust+ wire-format buffer into an `AppMessage` (a response or a
 * server-pushed broadcast). Thin wrapper over the generated decoder.
 */
export function decodeMessage(buf: Uint8Array): rustplus.AppMessage {
  return rustplus.AppMessage.decode(buf);
}
