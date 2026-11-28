import { describe, expect, it } from "vitest";

import { ProtocolError } from "../errors.js";
import { CHECKIN_REQUESTS, CHECKIN_RESPONSES } from "./fixtures/checkin.js";
import { HEARTBEATS, LOGIN_REQUESTS, SERVER_FRAMES, SERVER_STREAM } from "./fixtures/mcs.js";
import { encodeFrame } from "./framer.js";
import type { PushIdentity } from "./identity.js";
import {
  decodeCheckinResponse,
  decodeClose,
  decodeDataMessageStanza,
  decodeHeartbeatAck,
  decodeHeartbeatPing,
  decodeLoginResponse,
  decodeStreamErrorStanza,
  encodeCheckinRequest,
  encodeHeartbeatAck,
  encodeHeartbeatPing,
  encodeLoginRequest,
  loginDeviceId,
  MCS_VERSION,
  McsTag,
} from "./messages.js";
import { Writer } from "./wire.js";

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * The legacy identity, pinned here rather than imported, so these byte-for-byte
 * tests stay valid whichever profile `identity.ts` ships.
 */
const PINNED_LEGACY: PushIdentity = {
  name: "legacy",
  checkin: { deviceType: 3, chromePlatform: 2, chromeVersion: "63.0.3234.0", chromeChannel: 1 },
  login: { id: "chrome-63.0.3234.0", networkType: 1 },
};

describe("check-in request encoding matches push-receiver byte for byte", () => {
  it.each(Object.entries(CHECKIN_REQUESTS))("%s", (_name, fixture) => {
    const credentials =
      fixture.androidId !== null && fixture.securityToken !== null
        ? { androidId: fixture.androidId, securityToken: fixture.securityToken }
        : undefined;
    expect(toHex(encodeCheckinRequest(PINNED_LEGACY, credentials))).toBe(fixture.bodyHex);
  });
});

describe("check-in response decoding", () => {
  it.each(Object.entries(CHECKIN_REQUESTS))(
    "gives the same ids push-receiver decoded (%s)",
    (_name, fixture) => {
      const reply = CHECKIN_RESPONSES[fixture.reply];
      expect(decodeCheckinResponse(fromHex(reply.hex))).toEqual(fixture.decoded);
    },
  );

  it("reads ids at and above 2^63 as unsigned decimals", () => {
    expect(decodeCheckinResponse(fromHex(CHECKIN_RESPONSES.high.hex))).toEqual({
      androidId: "9223372036854775808",
      securityToken: "18446744073709551615",
    });
  });

  it("fails closed when an id is missing or zero", () => {
    const onlyId = new Writer().bool(1, true).fixed64(7, 5n).finish();
    const zeroToken = new Writer().fixed64(7, 5n).fixed64(8, 0n).finish();
    expect(() => decodeCheckinResponse(onlyId)).toThrow(ProtocolError);
    expect(() => decodeCheckinResponse(zeroToken)).toThrow(ProtocolError);
    expect(() => decodeCheckinResponse(new Uint8Array())).toThrow(ProtocolError);
  });

  it("fails closed on an id with the wrong wire type", () => {
    const varintId = new Writer().uint64(7, 5n).fixed64(8, 6n).finish();
    expect(() => decodeCheckinResponse(varintId)).toThrow(/android_id has wire type 0/);
  });

  it("fails closed on a truncated reply", () => {
    const hex = CHECKIN_RESPONSES.ordinary.hex;
    expect(() => decodeCheckinResponse(fromHex(hex.slice(0, hex.length - 6)))).toThrow(
      ProtocolError,
    );
  });

  it("rejects stored credentials that are not 64-bit decimals", () => {
    expect(() =>
      encodeCheckinRequest(PINNED_LEGACY, { androidId: "abc", securityToken: "1" }),
    ).toThrow(ProtocolError);
    expect(() =>
      encodeCheckinRequest(PINNED_LEGACY, {
        androidId: "1",
        securityToken: "18446744073709551616",
      }),
    ).toThrow(ProtocolError);
  });
});

describe("login request encoding matches push-receiver byte for byte", () => {
  it.each(Object.entries(LOGIN_REQUESTS))("%s", (_name, fixture) => {
    const payload = encodeLoginRequest(PINNED_LEGACY, {
      androidId: fixture.androidId,
      securityToken: fixture.securityToken,
      persistentIds: fixture.persistentIds,
    });
    const frame = encodeFrame(McsTag.LoginRequest, payload, { version: MCS_VERSION });
    expect(toHex(frame)).toBe(fixture.frameHex);
  });

  it("copies push-receiver's signed device_id for androidIds at and above 2^63", () => {
    expect(loginDeviceId(2n ** 63n)).toBe("android--8000000000000000");
    expect(loginDeviceId(2n ** 64n - 1n)).toBe("android--1");
    expect(loginDeviceId(2n ** 63n - 1n)).toBe("android-7fffffffffffffff");
    for (const fixture of Object.values(LOGIN_REQUESTS)) {
      expect(loginDeviceId(BigInt(fixture.androidId))).toBe(fixture.deviceId);
    }
  });

  it("rejects credentials that are not 64-bit decimals", () => {
    expect(() =>
      encodeLoginRequest(PINNED_LEGACY, {
        androidId: "-5",
        securityToken: "1",
        persistentIds: [],
      }),
    ).toThrow(ProtocolError);
    expect(() =>
      encodeLoginRequest(PINNED_LEGACY, {
        androidId: "5",
        securityToken: "token",
        persistentIds: [],
      }),
    ).toThrow(ProtocolError);
  });

  it("writes the identity it is given, not a built-in one", () => {
    const other: PushIdentity = {
      name: "test",
      checkin: { ...PINNED_LEGACY.checkin, chromeVersion: "999.0.0.0" },
      login: { id: "chrome-999.0.0.0", networkType: 1 },
    };
    const login = Buffer.from(
      encodeLoginRequest(other, { androidId: "1", securityToken: "2", persistentIds: [] }),
    );
    const checkin = Buffer.from(encodeCheckinRequest(other));
    expect(login.includes("chrome-999.0.0.0")).toBe(true);
    expect(checkin.includes("999.0.0.0")).toBe(true);
    expect(login.includes("63.0.3234.0")).toBe(false);
  });
});

describe("heartbeat encoding matches protobufjs byte for byte", () => {
  it("an empty ping", () => {
    expect(toHex(encodeHeartbeatPing())).toBe(HEARTBEATS.pingEmpty.hex);
  });

  it("a ping and an ack with last_stream_id_received", () => {
    expect(toHex(encodeHeartbeatPing(HEARTBEATS.ping.input))).toBe(HEARTBEATS.ping.hex);
    expect(toHex(encodeHeartbeatAck(HEARTBEATS.ack.input))).toBe(HEARTBEATS.ack.hex);
  });
});

describe("decoding server frames", () => {
  it("a successful LoginResponse, with Google's heartbeat interval", () => {
    expect(decodeLoginResponse(fromHex(SERVER_FRAMES.loginResponseOk.hex))).toEqual({
      heartbeatIntervalMs: 300000,
    });
  });

  it("a LoginResponse carrying an error", () => {
    expect(decodeLoginResponse(fromHex(SERVER_FRAMES.loginResponseError.hex))).toEqual({
      error: { code: 401, message: "made-up message", type: "made-up-type" },
    });
  });

  it("a negative error code, ten bytes on the wire", () => {
    expect(decodeLoginResponse(fromHex(SERVER_FRAMES.loginResponseNegativeCode.hex))).toEqual({
      error: { code: -1 },
    });
  });

  it("a DataMessageStanza: ids, app data, sent (seconds) and queued", () => {
    const { input, hex } = SERVER_FRAMES.dataMessage;
    expect(decodeDataMessageStanza(fromHex(hex))).toEqual({
      persistentId: input.persistentId,
      from: input.from,
      category: input.category,
      appData: input.appData.map(({ key, value }) => ({ key, value })),
      sent: "1764000000",
      queued: 2,
      hasRawData: false,
    });
  });

  it("an encrypted DataMessageStanza: raw_data noted, never kept", () => {
    const decoded = decodeDataMessageStanza(fromHex(SERVER_FRAMES.dataMessageEncrypted.hex));
    expect(decoded.hasRawData).toBe(true);
    expect(decoded.appData.map((entry) => entry.key)).toEqual(["crypto-key", "encryption"]);
    expect(decoded.sent).toBe("1764000001");
    expect(decoded.queued).toBeUndefined();
    expect(JSON.stringify(decoded)).not.toContain("ciphertext");
  });

  it("a minimal DataMessageStanza has no sent, queued or persistent id", () => {
    expect(decodeDataMessageStanza(fromHex(SERVER_FRAMES.dataMessageMinimal.hex))).toEqual({
      from: "000000000000",
      category: "com.facepunch.rust.companion",
      appData: [],
      hasRawData: false,
    });
  });

  it("HeartbeatPing and HeartbeatAck from Google", () => {
    expect(decodeHeartbeatPing(fromHex(SERVER_FRAMES.heartbeatPing.hex))).toEqual({
      streamId: 2,
      lastStreamIdReceived: 6,
      status: "1",
    });
    expect(decodeHeartbeatAck(fromHex(SERVER_FRAMES.heartbeatAck.hex))).toEqual({
      streamId: 3,
      lastStreamIdReceived: 7,
    });
  });

  it("Close and StreamErrorStanza", () => {
    expect(decodeClose(fromHex(SERVER_FRAMES.close.hex))).toEqual({});
    expect(decodeStreamErrorStanza(fromHex(SERVER_FRAMES.streamError.hex))).toEqual({
      type: "made-up-error-type",
      text: "made-up text",
    });
  });

  it("uses the MCS tags push-receiver's constants define", () => {
    for (const frame of Object.values(SERVER_FRAMES)) {
      expect(McsTag[frame.type as keyof typeof McsTag]).toBe(frame.tag);
    }
    // The fixtures' tags and version byte are read from push-receiver's
    // constants by the capture script, so this is not a self-check.
    expect(SERVER_STREAM.version).toBe(MCS_VERSION);
    expect(McsTag).toMatchObject({ HeartbeatPing: 0, HeartbeatAck: 1, LoginRequest: 2 });
  });
});

describe("decoders fail closed", () => {
  it("on a truncated stanza", () => {
    const hex = SERVER_FRAMES.dataMessage.hex;
    for (const cut of [1, 7, 40, hex.length / 2 - 1]) {
      expect(() => decodeDataMessageStanza(fromHex(hex.slice(0, cut * 2)))).toThrow(ProtocolError);
    }
  });

  it("on invalid UTF-8 in app data", () => {
    const badValue = new Writer()
      .message(7, (entry) => entry.string(1, "body").bytes(2, fromHex("c328")))
      .finish();
    expect(() => decodeDataMessageStanza(badValue)).toThrow(/UTF-8/);
  });

  it("on an app_data entry missing its value", () => {
    const noValue = new Writer().message(7, (entry) => entry.string(1, "body")).finish();
    expect(() => decodeDataMessageStanza(noValue)).toThrow(/key or value/);
  });

  it("on a known field with the wrong wire type", () => {
    const sentAsString = new Writer().string(18, "1764000000").finish();
    expect(() => decodeDataMessageStanza(sentAsString)).toThrow(/sent has wire type 2/);
    const errorAsVarint = new Writer().int32(3, 1).finish();
    expect(() => decodeLoginResponse(errorAsVarint)).toThrow(ProtocolError);
  });

  it("on group wire types, even in an otherwise empty Close", () => {
    expect(() => decodeClose(fromHex("0b"))).toThrow(/group/);
    expect(() => decodeStreamErrorStanza(fromHex("0c"))).toThrow(/group/);
  });

  it("skips unknown fields, fixed32 included", () => {
    const known = new Writer().string(1, "kept").finish();
    // Field 30 as fixed32, then field 31 as a varint.
    const unknown = fromHex("f50101020304" + "f80107");
    expect(decodeStreamErrorStanza(new Uint8Array([...known, ...unknown]))).toEqual({
      type: "kept",
    });
  });
});
