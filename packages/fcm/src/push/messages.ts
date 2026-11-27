/**
 * Encoders and decoders for the MCS and check-in messages the push client
 * uses, built on `wire.ts`. Only the fields Conduit sends or reads are
 * handled; every other field is skipped.
 *
 * Portions derived from @liamcottle/push-receiver (MIT License, Copyright (c)
 * 2017 Matthieu Lemoine; https://github.com/liamcottle/push-receiver): the
 * values sent and the MCS tag numbers. Field numbers and types follow
 * Chromium's `mcs.proto`, `checkin.proto` and `android_checkin.proto` as
 * bundled in push-receiver (BSD 3-Clause License, Copyright 2013-2014 The
 * Chromium Authors; https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
 *
 * Encoders write fields in ascending field-number order, as protobufjs does, so
 * their output is byte-identical to push-receiver's (pinned by the fixture
 * tests). Decoders return plain objects or throw {@link ProtocolError}: a known
 * field with the wrong wire type, or a missing field Conduit relies on, fails
 * closed. 64-bit values cross this module's edges as decimal strings.
 */

import { ProtocolError } from "../errors.js";
import type { PushIdentity } from "./identity.js";
import { parseUint64Decimal, Reader, WireType, Writer } from "./wire.js";

/**
 * The MCS protocol version byte the client sends first. Chromium's
 * `kMCSVersion`.
 */
export const MCS_VERSION = 41;

/**
 * MCS message tags (Chromium's `MCSProtoTag`, push-receiver's `constants.js`):
 * the byte before each frame's size. Only the tags the push client handles are
 * listed; the framer passes any other tag through as-is.
 */
export const McsTag = {
  HeartbeatPing: 0,
  HeartbeatAck: 1,
  LoginRequest: 2,
  LoginResponse: 3,
  Close: 4,
  /** Sent by Google after login (acks and the like); recognised and ignored. */
  IqStanza: 7,
  DataMessageStanza: 8,
  StreamErrorStanza: 10,
} as const;

// Protocol constants, as Chrome's GCM client and push-receiver send them. These
// are part of the protocol rather than the identity: they do not describe the
// device.

/** `AndroidCheckinRequest.version`: 3, the incremental-gservices protocol. */
const CHECKIN_PROTOCOL_VERSION = 3;
/** `AndroidCheckinRequest.user_serial_number`: the primary user profile. */
const CHECKIN_USER_SERIAL_NUMBER = 0;
/** `LoginRequest.domain`. */
const MCS_DOMAIN = "mcs.android.com";
/** `LoginRequest.auth_service`: ANDROID_ID, authenticate as the checked-in device. */
const AUTH_SERVICE_ANDROID_ID = 2;
/** `LoginRequest.setting`: Chrome's default login setting. */
const LOGIN_SETTING = { name: "new_vc", value: "1" } as const;
/** `LoginRequest.adaptive_heartbeat`: off, as Chrome sends it. */
const ADAPTIVE_HEARTBEAT = false;
/** `LoginRequest.use_rmq2`: "Must be true" per mcs.proto. */
const USE_RMQ2 = true;

/** The stored device credentials, as decimal strings. */
export interface DeviceCredentials {
  androidId: string;
  securityToken: string;
}

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

/**
 * `checkin_proto.AndroidCheckinRequest`. Without credentials this is the
 * first-run check-in that mints a device; with them, the re-check-in done
 * before every connect.
 */
export function encodeCheckinRequest(
  identity: PushIdentity,
  credentials?: DeviceCredentials,
): Uint8Array {
  const w = new Writer();
  if (credentials) {
    // `id` is a signed int64 but the androidId is unsigned (Google returns it as
    // fixed64). push-receiver converts with a signed `Long.fromString`, which
    // wraps an id at or above 2^63 to the same 64-bit pattern this writes.
    w.int64(2, parseUint64Decimal(credentials.androidId, "androidId"));
  }
  w.message(4, (checkin) => {
    checkin.int32(12, identity.checkin.deviceType);
    checkin.message(13, (build) => {
      build.int32(1, identity.checkin.chromePlatform);
      build.string(2, identity.checkin.chromeVersion);
      build.int32(3, identity.checkin.chromeChannel);
    });
  });
  if (credentials) {
    w.fixed64(13, parseUint64Decimal(credentials.securityToken, "securityToken"));
  }
  w.int32(14, CHECKIN_PROTOCOL_VERSION);
  w.int32(22, CHECKIN_USER_SERIAL_NUMBER);
  return w.finish();
}

/**
 * `checkin_proto.AndroidCheckinResponse`: the device's androidId and
 * securityToken (fixed64 on the wire, unsigned decimal strings out). Both must
 * be present and non-zero; nothing else in the reply is used.
 */
export function decodeCheckinResponse(bytes: Uint8Array): DeviceCredentials {
  const r = new Reader(bytes);
  let androidId: bigint | undefined;
  let securityToken: bigint | undefined;
  while (!r.done) {
    const { field, wireType } = r.tag();
    if (field === 7) {
      expectWireType("AndroidCheckinResponse.android_id", wireType, WireType.Fixed64);
      androidId = r.fixed64();
    } else if (field === 8) {
      expectWireType("AndroidCheckinResponse.security_token", wireType, WireType.Fixed64);
      securityToken = r.fixed64();
    } else {
      r.skip(wireType);
    }
  }
  if (!androidId || !securityToken) {
    throw new ProtocolError("check-in response is missing the androidId or securityToken");
  }
  return { androidId: androidId.toString(), securityToken: securityToken.toString() };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/** What the MCS login carries besides the identity. */
export interface LoginInput extends DeviceCredentials {
  /** Persistent ids of pushes already received, so Google does not resend them. */
  persistentIds: readonly string[];
}

/**
 * `mcs_proto.LoginRequest` (the payload only; frame it with tag
 * {@link McsTag.LoginRequest} after the {@link MCS_VERSION} byte).
 */
export function encodeLoginRequest(identity: PushIdentity, input: LoginInput): Uint8Array {
  const androidId = parseUint64Decimal(input.androidId, "androidId");
  parseUint64Decimal(input.securityToken, "securityToken");
  const w = new Writer();
  w.string(1, identity.login.id);
  w.string(2, MCS_DOMAIN);
  // The ids go out as the stored decimal strings, verbatim, as push-receiver
  // sends them.
  w.string(3, input.androidId);
  w.string(4, input.androidId);
  w.string(5, input.securityToken);
  w.string(6, loginDeviceId(androidId));
  w.message(8, (setting) => {
    setting.string(1, LOGIN_SETTING.name);
    setting.string(2, LOGIN_SETTING.value);
  });
  for (const id of input.persistentIds) {
    w.string(10, id);
  }
  w.bool(12, ADAPTIVE_HEARTBEAT);
  w.bool(14, USE_RMQ2);
  w.int32(16, AUTH_SERVICE_ANDROID_ID);
  w.int32(17, identity.login.networkType);
  return w.finish();
}

/**
 * `LoginRequest.device_id`: "android-" and the androidId in hex.
 *
 * Copies push-receiver's quirk on purpose: it converts with a SIGNED
 * `Long.fromString(androidId).toString(16)`, so an androidId at or above 2^63
 * comes out negative, `android--…` (2^63 gives `android--8000000000000000`).
 * Devices registered by push-receiver have logged in that way all along, so the
 * same string keeps their login unchanged.
 */
export function loginDeviceId(androidId: bigint): string {
  return `android-${BigInt.asIntN(64, androidId).toString(16)}`;
}

/** The part of `mcs_proto.LoginResponse` the client acts on. */
export interface LoginResponse {
  /** Set when the login failed; absent on success. */
  error?: { code?: number; message?: string; type?: string };
  /** `heartbeat_config.interval_ms`, when Google suggests one. */
  heartbeatIntervalMs?: number;
}

/** `mcs_proto.LoginResponse`. */
export function decodeLoginResponse(bytes: Uint8Array): LoginResponse {
  const r = new Reader(bytes);
  const out: LoginResponse = {};
  while (!r.done) {
    const { field, wireType } = r.tag();
    if (field === 3) {
      expectWireType("LoginResponse.error", wireType, WireType.LengthDelimited);
      out.error = decodeErrorInfo(r.bytes());
    } else if (field === 7) {
      expectWireType("LoginResponse.heartbeat_config", wireType, WireType.LengthDelimited);
      const interval = decodeHeartbeatConfigInterval(r.bytes());
      if (interval !== undefined) out.heartbeatIntervalMs = interval;
    } else {
      r.skip(wireType);
    }
  }
  return out;
}

function decodeErrorInfo(bytes: Uint8Array): NonNullable<LoginResponse["error"]> {
  const r = new Reader(bytes);
  const out: NonNullable<LoginResponse["error"]> = {};
  while (!r.done) {
    const { field, wireType } = r.tag();
    if (field === 1) {
      expectWireType("ErrorInfo.code", wireType, WireType.Varint);
      out.code = r.int32();
    } else if (field === 2) {
      expectWireType("ErrorInfo.message", wireType, WireType.LengthDelimited);
      out.message = r.string();
    } else if (field === 3) {
      expectWireType("ErrorInfo.type", wireType, WireType.LengthDelimited);
      out.type = r.string();
    } else {
      r.skip(wireType);
    }
  }
  return out;
}

function decodeHeartbeatConfigInterval(bytes: Uint8Array): number | undefined {
  const r = new Reader(bytes);
  let interval: number | undefined;
  while (!r.done) {
    const { field, wireType } = r.tag();
    if (field === 3) {
      expectWireType("HeartbeatConfig.interval_ms", wireType, WireType.Varint);
      interval = r.int32();
    } else {
      r.skip(wireType);
    }
  }
  return interval;
}

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

/** The fields of `HeartbeatPing` / `HeartbeatAck` (identical messages). */
export interface Heartbeat {
  streamId?: number;
  lastStreamIdReceived?: number;
  /** `status`, an int64 bitmask, as a decimal string. */
  status?: string;
}

/** `mcs_proto.HeartbeatPing`: the client's keep-alive probe. */
export function encodeHeartbeatPing(fields: { lastStreamIdReceived?: number } = {}): Uint8Array {
  return encodeHeartbeat(fields);
}

/** `mcs_proto.HeartbeatAck`: the client's answer to Google's ping. */
export function encodeHeartbeatAck(fields: { lastStreamIdReceived?: number } = {}): Uint8Array {
  return encodeHeartbeat(fields);
}

function encodeHeartbeat(fields: { lastStreamIdReceived?: number }): Uint8Array {
  const w = new Writer();
  if (fields.lastStreamIdReceived !== undefined) {
    w.int32(2, fields.lastStreamIdReceived);
  }
  return w.finish();
}

/** `mcs_proto.HeartbeatPing` from Google. */
export function decodeHeartbeatPing(bytes: Uint8Array): Heartbeat {
  return decodeHeartbeat("HeartbeatPing", bytes);
}

/** `mcs_proto.HeartbeatAck` from Google. */
export function decodeHeartbeatAck(bytes: Uint8Array): Heartbeat {
  return decodeHeartbeat("HeartbeatAck", bytes);
}

function decodeHeartbeat(name: string, bytes: Uint8Array): Heartbeat {
  const r = new Reader(bytes);
  const out: Heartbeat = {};
  while (!r.done) {
    const { field, wireType } = r.tag();
    if (field === 1) {
      expectWireType(`${name}.stream_id`, wireType, WireType.Varint);
      out.streamId = r.int32();
    } else if (field === 2) {
      expectWireType(`${name}.last_stream_id_received`, wireType, WireType.Varint);
      out.lastStreamIdReceived = r.int32();
    } else if (field === 3) {
      expectWireType(`${name}.status`, wireType, WireType.Varint);
      out.status = r.int64().toString();
    } else {
      r.skip(wireType);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stanzas from Google
// ---------------------------------------------------------------------------

/** The part of `mcs_proto.DataMessageStanza` (a push) the client uses. */
export interface DataMessageStanza {
  /** Google's id for this push, acknowledged at the next login. */
  persistentId?: string;
  /** The sender (project number). */
  from?: string;
  /** The target app's package name. */
  category?: string;
  /** The push's key/value data, in wire order. */
  appData: { key: string; value: string }[];
  /**
   * When the sender sent it: `sent`, an int64 in SECONDS per mcs.proto, as a
   * decimal string.
   */
  sent?: string;
  /** `queued`: how long Google held it before this flush, in seconds. */
  queued?: number;
  /**
   * Whether `raw_data` (a binary, normally encrypted, payload) is present. The
   * bytes are not kept: Conduit never decrypts a push.
   */
  hasRawData: boolean;
}

/** `mcs_proto.DataMessageStanza`. */
export function decodeDataMessageStanza(bytes: Uint8Array): DataMessageStanza {
  const r = new Reader(bytes);
  const out: DataMessageStanza = { appData: [], hasRawData: false };
  while (!r.done) {
    const { field, wireType } = r.tag();
    switch (field) {
      case 3:
        expectWireType("DataMessageStanza.from", wireType, WireType.LengthDelimited);
        out.from = r.string();
        break;
      case 5:
        expectWireType("DataMessageStanza.category", wireType, WireType.LengthDelimited);
        out.category = r.string();
        break;
      case 7:
        expectWireType("DataMessageStanza.app_data", wireType, WireType.LengthDelimited);
        out.appData.push(decodeAppData(r.bytes()));
        break;
      case 9:
        expectWireType("DataMessageStanza.persistent_id", wireType, WireType.LengthDelimited);
        out.persistentId = r.string();
        break;
      case 18:
        expectWireType("DataMessageStanza.sent", wireType, WireType.Varint);
        out.sent = r.int64().toString();
        break;
      case 19:
        expectWireType("DataMessageStanza.queued", wireType, WireType.Varint);
        out.queued = r.int32();
        break;
      case 21:
        expectWireType("DataMessageStanza.raw_data", wireType, WireType.LengthDelimited);
        r.skip(wireType);
        out.hasRawData = true;
        break;
      default:
        r.skip(wireType);
    }
  }
  return out;
}

/** `mcs_proto.AppData`: both `key` and `value` are required. */
function decodeAppData(bytes: Uint8Array): { key: string; value: string } {
  const r = new Reader(bytes);
  let key: string | undefined;
  let value: string | undefined;
  while (!r.done) {
    const { field, wireType } = r.tag();
    if (field === 1) {
      expectWireType("AppData.key", wireType, WireType.LengthDelimited);
      key = r.string();
    } else if (field === 2) {
      expectWireType("AppData.value", wireType, WireType.LengthDelimited);
      value = r.string();
    } else {
      r.skip(wireType);
    }
  }
  if (key === undefined || value === undefined) {
    throw new ProtocolError("app_data entry is missing its key or value");
  }
  return { key, value };
}

/** `mcs_proto.Close`: an empty message; decoding only checks it is well formed. */
export function decodeClose(bytes: Uint8Array): Record<string, never> {
  const r = new Reader(bytes);
  while (!r.done) {
    r.skip(r.tag().wireType);
  }
  return {};
}

/** `mcs_proto.StreamErrorStanza`: Google reporting a stream error before it closes. */
export interface StreamErrorStanza {
  type?: string;
  text?: string;
}

/** `mcs_proto.StreamErrorStanza`. */
export function decodeStreamErrorStanza(bytes: Uint8Array): StreamErrorStanza {
  const r = new Reader(bytes);
  const out: StreamErrorStanza = {};
  while (!r.done) {
    const { field, wireType } = r.tag();
    if (field === 1) {
      expectWireType("StreamErrorStanza.type", wireType, WireType.LengthDelimited);
      out.type = r.string();
    } else if (field === 2) {
      expectWireType("StreamErrorStanza.text", wireType, WireType.LengthDelimited);
      out.text = r.string();
    } else {
      r.skip(wireType);
    }
  }
  return out;
}

function expectWireType(field: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new ProtocolError(`${field} has wire type ${actual}, expected ${expected}`);
  }
}
