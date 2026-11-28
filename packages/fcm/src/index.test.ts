import { describe, it, expect, vi } from "vitest";

import {
  ConnectionError,
  FcmError,
  FcmService,
  PairingError,
  ProtocolError,
  redact,
  REDACTED,
  SENSITIVE_KEYS,
  decodePush,
} from "./index.js";
import type { PushReceiverDriver, RawPush, PushConnection } from "./driver/pushReceiverDriver.js";
import type { FcmCredentials } from "./types.js";

/** A fake driver whose register output and listen callback the test controls. */
function makeFakeDriver(): {
  driver: PushReceiverDriver;
  emit: (push: RawPush) => void;
  destroyed: () => boolean;
} {
  let onPush: ((p: RawPush) => void) | undefined;
  let destroyed = false;
  const driver: PushReceiverDriver = {
    register: vi.fn(async () => ({
      fcm: { fcm: { token: "device-token-abc" }, keys: { privateKey: "pk" } },
      gcm: { androidId: "111", securityToken: "sec-222" },
    })),
    listen: vi.fn(async (_creds, _ids, cb): Promise<PushConnection> => {
      onPush = cb;
      return {
        destroy: () => {
          destroyed = true;
        },
      };
    }),
  };
  return {
    driver,
    emit: (push) => onPush?.(push),
    destroyed: () => destroyed,
  };
}

function serverPairingBody() {
  return JSON.stringify({
    img: "",
    port: "28017",
    ip: "1.2.3.4",
    name: "My Server",
    id: "srv-uuid",
    type: "server",
    url: "",
    desc: "a server",
    playerId: "765",
    playerToken: "PLAYER-SECRET",
  });
}

function entityPairingBody() {
  return JSON.stringify({
    port: "28017",
    ip: "1.2.3.4",
    name: "Base Lights",
    id: "srv-uuid",
    type: "entity",
    desc: "",
    playerId: "765",
    playerToken: "PLAYER-SECRET",
    entityId: "4242",
    entityType: "1",
  });
}

const baseCreds: FcmCredentials = {
  fcm: { fcm: { token: "device-token-abc" } },
  gcm: { androidId: "111", securityToken: "sec-222" },
  expoPushToken: "ExponentPushToken[xyz]",
  steamAuthToken: "STEAM-OLD",
  steamTokenExpiresAt: "2026-01-01T00:00:00.000Z",
};

describe("FcmService.register", () => {
  it("produces FcmCredentials via the full happy path", async () => {
    const { driver } = makeFakeDriver();
    const expoExchange = vi.fn(async () => "ExponentPushToken[new]");
    const companionRegister = vi.fn(async () => ({
      steamAuthToken: "STEAM-FRESH",
      steamTokenExpiresAt: "2026-06-27T00:00:00.000Z",
    }));

    const svc = new FcmService({ driver, expoExchange, companionRegister });

    const onSteamLogin = vi.fn(async (url: string) => {
      // Without the returnUrl chain Facepunch ends the login on its landing
      // page and never hands over a token.
      expect(url).toBe(
        "https://companion-rust.facepunch.com/login?returnUrl=" +
          "%2Fapp%3FreturnUrl%3Drust-plus%253A%252F%252Frust-auth-session",
      );
      // Round-trip the captured Steam token back into fcm.
      svc.submitSteamToken("STEAM-CAPTURED");
    });

    const creds = await svc.register({ onSteamLogin });

    expect(onSteamLogin).toHaveBeenCalledOnce();
    expect(expoExchange).toHaveBeenCalledWith("device-token-abc");
    expect(companionRegister).toHaveBeenCalledWith({
      expoPushToken: "ExponentPushToken[new]",
      steamAuthToken: "STEAM-CAPTURED",
      deviceId: "111",
    });
    expect(creds).toMatchObject({
      expoPushToken: "ExponentPushToken[new]",
      steamAuthToken: "STEAM-FRESH",
      steamTokenExpiresAt: "2026-06-27T00:00:00.000Z",
    });
    expect(creds.gcm).toBeDefined();
  });

  it("supports submitSteamToken being called after onSteamLogin resolves", async () => {
    const { driver } = makeFakeDriver();
    const svc = new FcmService({
      driver,
      expoExchange: vi.fn(async () => "ExponentPushToken[new]"),
      companionRegister: vi.fn(async () => ({
        steamAuthToken: "STEAM-FRESH",
        steamTokenExpiresAt: "2026-06-27T00:00:00.000Z",
      })),
    });

    // onSteamLogin resolves immediately; token is submitted on a later tick.
    const onSteamLogin = vi.fn(async () => {
      setTimeout(() => svc.submitSteamToken("STEAM-LATE"), 5);
    });

    const creds = await svc.register({ onSteamLogin });
    expect(creds.steamAuthToken).toBe("STEAM-FRESH");
  });
});

describe("FcmService.startListening — decoding & routing", () => {
  it("decodes a server-pairing payload → serverPairing event", async () => {
    const { driver, emit } = makeFakeDriver();
    const svc = new FcmService({ driver });
    const handler = vi.fn();
    svc.on("serverPairing", handler);

    await svc.startListening(baseCreds);
    emit({
      persistentId: "p1",
      notification: { data: { body: serverPairingBody() } },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toEqual({
      type: "server",
      ip: "1.2.3.4",
      port: 28017,
      name: "My Server",
      desc: "a server",
      id: "srv-uuid",
      playerId: "765",
      playerToken: "PLAYER-SECRET",
    });
  });

  // Each decoded push is logged with its kind and ids, never its token.
  it("logs the decoded kind of a push, without the pairing's playerToken", async () => {
    const { driver, emit } = makeFakeDriver();
    const lines: { obj: unknown; msg?: string }[] = [];
    const logger = {
      debug: () => {},
      info: (obj: unknown, msg?: string) => lines.push({ obj, msg }),
      warn: () => {},
      error: () => {},
    };
    const svc = new FcmService({ driver, logger });
    svc.on("serverPairing", () => {});

    await svc.startListening(baseCreds);
    emit({ persistentId: "p9", notification: { data: { body: serverPairingBody() } } });

    const line = lines.find((l) => l.msg === "fcm: push decoded");
    expect(line?.obj).toEqual({ persistentId: "p9", kind: "serverPairing", serverId: "srv-uuid" });
    expect(JSON.stringify(lines)).not.toContain("PLAYER-SECRET");
  });

  it("decodes an entity payload → entityPairing with entityId/entityType", async () => {
    const { driver, emit } = makeFakeDriver();
    const svc = new FcmService({ driver });
    const handler = vi.fn();
    svc.on("entityPairing", handler);

    await svc.startListening(baseCreds);
    emit({
      persistentId: "p2",
      notification: { data: { body: entityPairingBody() } },
    });

    expect(handler).toHaveBeenCalledOnce();
    const n = handler.mock.calls[0][0];
    expect(n.type).toBe("entity");
    expect(n.entityId).toBe(4242);
    expect(n.entityType).toBe(1);
  });

  it("routes an alarm payload → alarm event", async () => {
    const { driver, emit } = makeFakeDriver();
    const svc = new FcmService({ driver });
    const handler = vi.fn();
    svc.on("alarm", handler);

    await svc.startListening(baseCreds);
    emit({
      persistentId: "p3",
      notification: {
        data: {
          body: JSON.stringify({
            type: "alarm",
            title: "Raid!",
            message: "Your base is under attack",
            id: "srv-uuid",
          }),
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      title: "Raid!",
      message: "Your base is under attack",
      serverId: "srv-uuid",
      playerId: undefined,
    });
  });

  it("routes a death payload → death event", async () => {
    const { driver, emit } = makeFakeDriver();
    const svc = new FcmService({ driver });
    const handler = vi.fn();
    svc.on("death", handler);

    await svc.startListening(baseCreds);
    emit({
      persistentId: "p4",
      notification: {
        data: {
          body: JSON.stringify({
            type: "death",
            targetName: "Survivor",
            targetId: "76561198000000000",
            message: "was killed by a bear",
            id: "srv-uuid",
          }),
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      name: "Survivor",
      targetId: "76561198000000000",
      message: "was killed by a bear",
      serverId: "srv-uuid",
    });
  });

  it("emits a PairingError (not crash) for a malformed payload; listener survives", async () => {
    const { driver, emit } = makeFakeDriver();
    const svc = new FcmService({ driver });
    const errHandler = vi.fn();
    const okHandler = vi.fn();
    svc.on("error", errHandler);
    svc.on("serverPairing", okHandler);

    await svc.startListening(baseCreds);

    // Malformed: body is not valid JSON.
    emit({
      persistentId: "bad",
      notification: { data: { body: "not-json{{{" } },
    });
    expect(errHandler).toHaveBeenCalledOnce();
    expect(errHandler.mock.calls[0][0]).toBeInstanceOf(PairingError);

    // The connection is still alive: a good payload still routes.
    emit({
      persistentId: "good",
      notification: { data: { body: serverPairingBody() } },
    });
    expect(okHandler).toHaveBeenCalledOnce();
  });

  it("dedupes by persistentId to prevent replay", async () => {
    const { driver, emit } = makeFakeDriver();
    const svc = new FcmService({ driver });
    const handler = vi.fn();
    svc.on("serverPairing", handler);

    // Pre-seed a persistentId as already-seen.
    await svc.startListening(baseCreds, ["dup"]);

    // Replayed id is dropped.
    emit({
      persistentId: "dup",
      notification: { data: { body: serverPairingBody() } },
    });
    expect(handler).not.toHaveBeenCalled();

    // First delivery of a fresh id routes.
    emit({
      persistentId: "fresh",
      notification: { data: { body: serverPairingBody() } },
    });
    expect(handler).toHaveBeenCalledOnce();

    // Re-delivery of that same id is suppressed.
    emit({
      persistentId: "fresh",
      notification: { data: { body: serverPairingBody() } },
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("emits pushHandled once per new id, for decoded and undecodable pushes alike", async () => {
    const { driver, emit } = makeFakeDriver();
    const svc = new FcmService({ driver });
    const handled: string[] = [];
    svc.on("pushHandled", (id: string) => handled.push(id));
    svc.on("error", () => {});

    await svc.startListening(baseCreds, ["seeded"]);

    emit({ persistentId: "ok", notification: { data: { body: serverPairingBody() } } });
    emit({ persistentId: "bad", notification: { data: { body: "not-json{{{" } } });
    emit({ persistentId: "ok", notification: { data: { body: serverPairingBody() } } });
    emit({ persistentId: "seeded", notification: { data: { body: serverPairingBody() } } });
    emit({ notification: { data: { body: serverPairingBody() } } });

    expect(handled).toEqual(["ok", "bad"]);
  });

  it("a push handled before a restart is not processed again after it", async () => {
    const before = makeFakeDriver();
    const first = new FcmService({ driver: before.driver });
    const persisted: string[] = [];
    first.on("pushHandled", (id: string) => persisted.push(id));
    first.on("error", () => {});
    await first.startListening(baseCreds);
    before.emit({ persistentId: "alarm-1", notification: { data: { body: serverPairingBody() } } });
    before.emit({ persistentId: "garbled", notification: { data: { body: "not-json{{{" } } });
    await first.stopListening();

    // A fresh service (the restarted process), seeded from what was persisted.
    const after = makeFakeDriver();
    const second = new FcmService({ driver: after.driver });
    const routed = vi.fn();
    const errors = vi.fn();
    second.on("serverPairing", routed);
    second.on("error", errors);
    await second.startListening(baseCreds, persisted);

    after.emit({ persistentId: "alarm-1", notification: { data: { body: serverPairingBody() } } });
    after.emit({ persistentId: "garbled", notification: { data: { body: "not-json{{{" } } });

    expect(routed).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("stopListening destroys the connection", async () => {
    const { driver, destroyed } = makeFakeDriver();
    const svc = new FcmService({ driver });
    await svc.startListening(baseCreds);
    expect(destroyed()).toBe(false);
    await svc.stopListening();
    expect(destroyed()).toBe(true);
  });
});

describe("FcmService.refresh", () => {
  it("returns refreshed creds and emits credentialsRefreshed", async () => {
    const { driver } = makeFakeDriver();
    const companionRegister = vi.fn(async () => ({
      steamAuthToken: "STEAM-REFRESHED",
      steamTokenExpiresAt: "2026-07-01T00:00:00.000Z",
    }));
    const svc = new FcmService({ driver, companionRegister });

    const emitted = vi.fn();
    svc.on("credentialsRefreshed", emitted);

    const out = await svc.refresh(baseCreds);

    expect(companionRegister).toHaveBeenCalledWith({
      expoPushToken: "ExponentPushToken[xyz]",
      steamAuthToken: "STEAM-OLD",
      deviceId: "111",
    });
    expect(out.steamAuthToken).toBe("STEAM-REFRESHED");
    expect(out.steamTokenExpiresAt).toBe("2026-07-01T00:00:00.000Z");
    // Unchanged fields are preserved.
    expect(out.expoPushToken).toBe("ExponentPushToken[xyz]");
    expect(emitted).toHaveBeenCalledWith(out);
  });
});

// The companion auth token expires after 14 days and Facepunch refuses to
// refresh an expired one, so the operator signs in with Steam again.
describe("FcmService.renew", () => {
  it("signs in again and re-registers on the existing device, without a new FCM registration", async () => {
    const { driver } = makeFakeDriver();
    const register = vi.spyOn(driver, "register");
    const expoExchange = vi.fn(async () => "ExponentPushToken[new]");
    const companionRegister = vi.fn(async () => ({
      steamAuthToken: "STEAM-RENEWED",
      steamTokenExpiresAt: "2026-12-01T00:00:00.000Z",
    }));
    const svc = new FcmService({ driver, expoExchange, companionRegister });
    const emitted = vi.fn();
    svc.on("credentialsRefreshed", emitted);

    const onSteamLogin = vi.fn(async () => {
      svc.submitSteamToken("STEAM-SIGNED-IN");
    });
    const out = await svc.renew(baseCreds, { onSteamLogin });

    expect(onSteamLogin).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
    expect(expoExchange).not.toHaveBeenCalled();
    expect(companionRegister).toHaveBeenCalledWith({
      expoPushToken: "ExponentPushToken[xyz]",
      steamAuthToken: "STEAM-SIGNED-IN",
      deviceId: "111",
    });
    expect(out).toEqual({
      ...baseCreds,
      steamAuthToken: "STEAM-RENEWED",
      steamTokenExpiresAt: "2026-12-01T00:00:00.000Z",
    });
    expect(emitted).toHaveBeenCalledWith(out);
  });

  it("propagates a failed sign-in and emits nothing", async () => {
    const { driver } = makeFakeDriver();
    const companionRegister = vi.fn();
    const svc = new FcmService({ driver, companionRegister });
    const emitted = vi.fn();
    svc.on("credentialsRefreshed", emitted);

    await expect(
      svc.renew(baseCreds, {
        onSteamLogin: async () => {
          throw new Error("window closed");
        },
      }),
    ).rejects.toThrow();
    expect(companionRegister).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
  });
});

describe("redaction", () => {
  it("never leaks tokens / playerToken / fcm-gcm secrets", () => {
    const redacted = redact({
      steamAuthToken: "STEAM-SECRET",
      expoPushToken: "ExponentPushToken[secret]",
      gcm: { securityToken: "sec", androidId: "111" },
      pairing: { name: "ok", playerToken: "PLAYER-SECRET", ip: "1.2.3.4" },
    }) as Record<string, any>;

    const blob = JSON.stringify(redacted);
    expect(blob).not.toContain("STEAM-SECRET");
    expect(blob).not.toContain("PLAYER-SECRET");
    expect(blob).not.toContain("ExponentPushToken[secret]");
    expect(redacted.steamAuthToken).toBe(REDACTED);
    expect(redacted.pairing.playerToken).toBe(REDACTED);
    // Non-sensitive values survive.
    expect(redacted.pairing.name).toBe("ok");
    expect(redacted.pairing.ip).toBe("1.2.3.4");
  });

  it("masks every key in the shared SENSITIVE_KEYS list, case-insensitively", () => {
    expect(SENSITIVE_KEYS.length).toBeGreaterThan(0);
    for (const key of SENSITIVE_KEYS) {
      const redacted = redact({
        [key]: "LEAK",
        nested: { [key.toUpperCase()]: "LEAK", [key.toLowerCase()]: "LEAK" },
      }) as Record<string, any>;
      expect(redacted[key], key).toBe(REDACTED);
      expect(JSON.stringify(redacted), key).not.toContain("LEAK");
    }
  });

  it("covers the Pushover credentials the host persists", () => {
    const redacted = redact({ pushover: { appToken: "APP", userKey: "USER" } }) as Record<
      string,
      any
    >;
    expect(redacted.pushover).toEqual({ appToken: REDACTED, userKey: REDACTED });
  });

  it("masks a bare androidId, which the push client handles outside gcm", () => {
    const redacted = redact({ device: { androidId: "4123456789012345678" } });
    expect(JSON.stringify(redacted)).not.toContain("4123456789012345678");
  });

  it("handles cycles without throwing", () => {
    const a: Record<string, unknown> = { name: "x" };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
});

describe("typed errors", () => {
  it("ProtocolError is an FcmError in the protocol category", () => {
    const err = new ProtocolError("bad frame", { cause: new Error("inner") });
    expect(err).toBeInstanceOf(FcmError);
    expect(err.name).toBe("ProtocolError");
    expect(err.category).toBe("protocol");
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("ConnectionError carries its safe-to-log failure kind, code and retry delay", () => {
    const err = new ConnectionError("register3 failed", {
      failure: "refused",
      code: "PHONE_REGISTRATION_ERROR",
      retryAfterMs: 30_000,
    });
    expect(err.category).toBe("connection");
    expect(err.failure).toBe("refused");
    expect(err.code).toBe("PHONE_REGISTRATION_ERROR");
    expect(err.retryAfterMs).toBe(30_000);
    const bare = new ConnectionError("dropped");
    expect(bare.failure).toBeUndefined();
    expect(bare.code).toBeUndefined();
    expect(bare.retryAfterMs).toBeUndefined();
  });
});

describe("decodePush (direct)", () => {
  it("parses a server pairing with numeric coercion", () => {
    const out = decodePush({ data: { body: serverPairingBody() } });
    expect(out.kind).toBe("serverPairing");
    if (out.kind === "serverPairing") {
      expect(out.pairing.port).toBe(28017);
      expect(out.pairing.playerToken).toBe("PLAYER-SECRET");
    }
  });

  it("throws PairingError on missing required fields", () => {
    expect(() => decodePush({ data: { body: JSON.stringify({ type: "server" }) } })).toThrow(
      PairingError,
    );
  });

  it("reports the payload's field shapes, never its values, when a field is unusable", () => {
    const body = JSON.stringify({
      type: "server",
      ip: "",
      port: 28082,
      name: "My Server",
      id: "bd66965a-0000-4000-8000-000000000000",
      playerId: "",
      playerToken: "PLAYER-SECRET",
      extra: null,
    });
    let caught: unknown;
    try {
      decodePush({ data: { body } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PairingError);
    const err = caught as PairingError;
    expect(err.message).toBe('pairing payload has an unusable (empty string) "playerId"');
    expect(err.payloadShape).toEqual({
      type: "string",
      ip: "empty string",
      port: "number",
      name: "string",
      id: "string",
      playerId: "empty string",
      playerToken: "string",
      extra: "null",
    });
    expect(JSON.stringify(err.payloadShape)).not.toContain("PLAYER-SECRET");
  });

  // Regression (live test 2026-11-16): since Facepunch's companion socket, a
  // server pairing push carries no ip/port. This is the exact field set seen.
  it("decodes a current server pairing that carries no ip or port", () => {
    const body = JSON.stringify({
      id: "ccaf8155-b9cd-42ff-a288-5942a31aba42",
      name: "My Server",
      desc: "",
      img: "",
      logo: "",
      url: "",
      playerId: "76561198000000000",
      playerToken: "-123456",
      type: "server",
    });
    const out = decodePush({ data: { body } });
    expect(out.kind).toBe("serverPairing");
    if (out.kind === "serverPairing") {
      expect(out.pairing.id).toBe("ccaf8155-b9cd-42ff-a288-5942a31aba42");
      expect(out.pairing.ip).toBeUndefined();
      expect(out.pairing.port).toBeUndefined();
      expect(out.pairing.playerToken).toBe("-123456");
    }
  });

  it("decodes an entity pairing without ip/port and never mistakes it for an alarm", () => {
    const body = JSON.stringify({
      id: "ccaf8155-b9cd-42ff-a288-5942a31aba42",
      name: "Smart Switch",
      title: "Smart Switch",
      playerId: "76561198000000000",
      playerToken: "42",
      type: "entity",
      entityId: "123456",
      entityType: "1",
    });
    const out = decodePush({ data: { body } });
    expect(out.kind).toBe("entityPairing");
    if (out.kind === "entityPairing") expect(out.pairing.entityId).toBe(123456);
  });

  // Entity ids are 64-bit; long-running servers issue ids above 2^32.
  function entityBody(entityId: unknown): string {
    return JSON.stringify({
      id: "ccaf8155-b9cd-42ff-a288-5942a31aba42",
      name: "Smart Switch",
      playerId: "76561198000000000",
      playerToken: "42",
      type: "entity",
      entityId,
      entityType: "1",
    });
  }

  it("keeps an entity id above 2^32 exactly", () => {
    const out = decodePush({ data: { body: entityBody("4294967301") } });
    expect(out.kind).toBe("entityPairing");
    if (out.kind === "entityPairing") expect(out.pairing.entityId).toBe(4294967301);
  });

  it.each([["9007199254740993"], ["-5"], ["12.5"], ["0x10"], [""]])(
    "rejects entity id %j instead of rounding it onto another id",
    (entityId) => {
      expect(() => decodePush({ data: { body: entityBody(entityId) } })).toThrow(PairingError);
    },
  );

  it("throws PairingError on an unrecognised type", () => {
    expect(() => decodePush({ data: { body: JSON.stringify({ type: "wat" }) } })).toThrow(
      PairingError,
    );
  });
});
