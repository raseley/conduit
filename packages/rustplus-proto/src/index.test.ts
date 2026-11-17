import { describe, it, expect } from "vitest";
import {
  encodeRequest,
  decodeMessage,
  AppRequest,
  AppMessage,
  AppResponse,
  AppBroadcast,
  AppInfo,
  AppEntityType,
  Long,
  rustplus,
} from "./index.js";

/**
 * Round-trip encode/decode fixtures. Each fixture builds a small,
 * proto-faithful message, runs it through the codec, and asserts structural
 * equality on the decoded result.
 */
describe("@conduit/rustplus-proto codec", () => {
  // Real Rust+ playerIds are Steam64 ids that exceed Number.MAX_SAFE_INTEGER,
  // so 64-bit fields are modelled as Long (codegen uses `--force-long`).
  // Building them via Long.fromString preserves full precision.
  const STEAM_ID = "76561198000000000";
  const PLAYER_ID = Long.fromString(STEAM_ID, true);

  it("round-trips a getInfo AppRequest", () => {
    const req = {
      seq: 1,
      playerId: PLAYER_ID,
      playerToken: 123456789,
      getInfo: {},
    };

    const buf = encodeRequest(req);
    expect(buf).toBeInstanceOf(Uint8Array);

    const decoded = AppRequest.decode(buf);
    expect(decoded.seq).toBe(1);
    expect(decoded.playerId.toString()).toBe(STEAM_ID);
    expect(decoded.playerToken).toBe(123456789);
    // The getInfo oneof-style field is present (an AppEmpty).
    expect(decoded.getInfo).toBeTruthy();
    expect(decoded.getTime).toBeNull();
  });

  it("round-trips a setEntityValue AppRequest", () => {
    const req = {
      seq: 42,
      playerId: PLAYER_ID,
      playerToken: 987654321,
      entityId: Long.fromNumber(1234567, true),
      setEntityValue: { value: true },
    };

    const decoded = AppRequest.decode(encodeRequest(req));
    expect(decoded.seq).toBe(42);
    expect(decoded.entityId.toString()).toBe("1234567");
    expect(decoded.setEntityValue).toBeTruthy();
    expect(decoded.setEntityValue?.value).toBe(true);
  });

  it("round-trips a sendTeamMessage AppRequest", () => {
    const req = {
      seq: 7,
      playerId: PLAYER_ID,
      playerToken: 1,
      sendTeamMessage: { message: "hello team" },
    };

    const decoded = AppRequest.decode(encodeRequest(req));
    expect(decoded.sendTeamMessage?.message).toBe("hello team");
  });

  it("round-trips an AppMessage carrying an AppInfo response", () => {
    const info = {
      name: "My Rust Server",
      headerImage: "",
      url: "https://example.com",
      map: "Procedural Map",
      mapSize: 4000,
      wipeTime: 1700000000,
      players: 142,
      maxPlayers: 200,
      queuedPlayers: 3,
      seed: 12345,
    };
    const message = {
      response: { seq: 1, info },
    };

    const buf = AppMessage.encode(message).finish();
    const decoded = decodeMessage(buf);

    expect(decoded.response).toBeTruthy();
    expect(decoded.response?.seq).toBe(1);
    expect(decoded.response?.info?.name).toBe("My Rust Server");
    expect(decoded.response?.info?.players).toBe(142);
    expect(decoded.response?.info?.maxPlayers).toBe(200);
    expect(decoded.response?.info?.queuedPlayers).toBe(3);
    expect(decoded.response?.info).toBeInstanceOf(AppInfo);
  });

  it("round-trips an AppMessage broadcast (entityChanged)", () => {
    const message = {
      broadcast: {
        entityChanged: {
          entityId: Long.fromNumber(1234567, true),
          payload: { value: false },
        },
      },
    };

    const decoded = decodeMessage(AppMessage.encode(message).finish());
    expect(decoded.broadcast).toBeInstanceOf(AppBroadcast);
    expect(decoded.broadcast?.entityChanged?.entityId?.toString()).toBe("1234567");
    expect(decoded.broadcast?.entityChanged?.payload?.value).toBe(false);
  });

  it("round-trips an AppMessage broadcast (teamMessage)", () => {
    const message = {
      broadcast: {
        teamMessage: {
          message: {
            steamId: PLAYER_ID,
            name: "Alice",
            message: "raid incoming",
            color: "#ffffff",
            time: 1700000000,
          },
        },
      },
    };

    const decoded = decodeMessage(AppMessage.encode(message).finish());
    expect(decoded.broadcast?.teamMessage?.message?.name).toBe("Alice");
    expect(decoded.broadcast?.teamMessage?.message?.message).toBe("raid incoming");
  });

  it("exposes the AppEntityType enum and the full generated namespace", () => {
    expect(AppEntityType.Switch).toBe(1);
    expect(AppEntityType.Alarm).toBe(2);
    expect(AppEntityType.StorageMonitor).toBe(3);
    // The raw namespace is re-exported for messages not surfaced individually.
    expect(rustplus.AppResponse).toBe(AppResponse);
    expect(typeof rustplus.Vector3).toBe("function");
  });

  // Long-running servers issue entity ids above 2^32. As uint32 they were
  // truncated on decode (and a request named the wrong entity).
  const BIG_ENTITY_ID = "4294967301"; // 2^32 + 5

  it("round-trips an entity id above 2^32 on AppRequest", () => {
    const buf = encodeRequest({
      seq: 2,
      playerId: PLAYER_ID,
      playerToken: 1,
      entityId: Long.fromString(BIG_ENTITY_ID, true),
      getEntityInfo: {},
    });
    expect(AppRequest.decode(buf).entityId.toString()).toBe(BIG_ENTITY_ID);
  });

  it("decodes an entity id above 2^32 on an AppEntityChanged broadcast", () => {
    const buf = AppMessage.encode({
      broadcast: {
        entityChanged: {
          entityId: Long.fromString(BIG_ENTITY_ID, true),
          payload: { value: true },
        },
      },
    }).finish();
    expect(decodeMessage(buf).broadcast?.entityChanged?.entityId?.toString()).toBe(BIG_ENTITY_ID);
  });

  it("still decodes an entity id a uint32 sender wrote (varints are wire-compatible)", () => {
    // Field 1 written as a uint32 varint, 4242: tag 0x08, then 0x92 0x21.
    const uint32Bytes = new Uint8Array([0x08, 0x92, 0x21]);
    expect(rustplus.AppEntityChanged.decode(uint32Bytes).entityId.toString()).toBe("4242");
  });
});
