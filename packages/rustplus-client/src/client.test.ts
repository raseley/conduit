/**
 * Focused suite for {@link RustPlusClient} (`client.ts`).
 *
 * `index.test.ts` exercises the happy paths end-to-end against a real loopback
 * `WebSocketServer`. This suite drives the same public surface through the
 * `webSocketFactory` seam with a hand-rolled {@link FakeSocket} and fake timers,
 * so the timing-sensitive paths — request timeouts, backoff, reconnect,
 * re-subscription ordering — are asserted deterministically with no real IO.
 */

import { EventEmitter } from "node:events";

import { AppMessage, AppRequest, Long } from "@conduit/rustplus-proto";
import type { rustplus } from "@conduit/rustplus-proto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import {
  AuthError,
  CameraUnavailableError,
  ConnectionError,
  EntityNotFoundError,
  ProtocolError,
  RateLimitError,
  RustPlusClient,
  RustPlusError,
} from "./index.js";
import { AUTH_RETRY_DELAYS_MS, handshakeError, toBase64Url } from "./client.js";
import type { EntityChange, RustPlusClientOptions, TeamChatMessage } from "./index.js";

/** A Steam64 id beyond `Number.MAX_SAFE_INTEGER`, to prove 64-bit precision. */
const PLAYER_ID = "76561198000000001";
const PLAYER_TOKEN = "123456789";

/** A 64-bit wire entity id, as the server sends it. */
function wireId(entityId: number): Long {
  return Long.fromNumber(entityId, true);
}

/** A request the client wrote, decoded, with its entity id read back as a number. */
type SentRequest = Omit<rustplus.AppRequest, "entityId"> & { entityId: number };

function encodeMessage(msg: rustplus.IAppMessage): Uint8Array {
  return AppMessage.encode(msg).finish();
}

/**
 * Hand-rolled stand-in for a `ws` socket. The client only relies on the
 * EventEmitter surface plus `send`/`close`/`binaryType`; the extra methods are
 * the "server side" a test uses to drive it.
 */
class FakeSocket extends EventEmitter {
  binaryType = "nodebuffer";
  /** Every request the client wrote, decoded. */
  readonly sent: SentRequest[] = [];
  /** When set, `send` reports this error through its callback. */
  sendCallbackError: Error | null = null;
  /** When set, `send` throws synchronously. */
  sendThrows: Error | null = null;
  /** When set, `close` throws synchronously. */
  closeThrows: Error | null = null;
  /** When false, `close()` never emits `close` (a hung socket). */
  emitCloseOnClose = true;
  closeCalls = 0;

  constructor(
    readonly url: string,
    readonly protocols: string[] = [],
  ) {
    super();
  }

  /**
   * Like `ws`'s terminate() on a socket still handshaking: aborts it, then
   * emits 'error' and 'close'.
   */
  terminate(): void {
    this.emit("error", new Error("WebSocket was closed before the connection was established"));
    this.emit("close", 1006, Buffer.from(""));
  }

  /** Simulate the server refusing the handshake with an HTTP status. */
  refuseHandshake(statusCode: number): void {
    this.emit("unexpected-response", {}, { statusCode });
  }

  send(bytes: Uint8Array, cb?: (err?: Error) => void): void {
    if (this.sendThrows) throw this.sendThrows;
    const req = AppRequest.decode(bytes);
    this.sent.push(Object.assign(req, { entityId: Number(req.entityId.toString()) }));
    cb?.(this.sendCallbackError ?? undefined);
  }

  close(): void {
    this.closeCalls += 1;
    if (this.closeThrows) throw this.closeThrows;
    if (this.emitCloseOnClose) this.emit("close", 1000, Buffer.from(""));
  }

  // ── server-side controls ──

  open(): void {
    this.emit("open");
  }

  /** Deliver an encoded AppMessage as a pooled `Buffer` (non-zero byteOffset). */
  deliver(msg: rustplus.IAppMessage): void {
    this.emit("message", Buffer.from(encodeMessage(msg)));
  }

  /** Deliver an arbitrary raw frame. */
  deliverRaw(data: unknown): void {
    this.emit("message", data);
  }

  /** Simulate the transport dropping. */
  drop(code = 1006, reason = ""): void {
    this.emit("close", code, Buffer.from(reason));
  }

  fail(err: Error): void {
    this.emit("error", err);
  }

  get lastRequest(): SentRequest {
    const req = this.sent[this.sent.length - 1];
    if (!req) throw new RangeError("FakeSocket: no request has been sent");
    return req;
  }
}

interface Harness {
  client: RustPlusClient;
  /** Every socket the client has asked the factory for, in order. */
  sockets: FakeSocket[];
  /** The most recently created socket. */
  socket(): FakeSocket;
  /** When set, the factory throws instead of creating a socket. */
  factoryError: Error | null;
}

function makeHarness(overrides: Partial<RustPlusClientOptions> = {}): Harness {
  const harness: Harness = {
    client: undefined as unknown as RustPlusClient,
    sockets: [],
    socket() {
      const s = this.sockets[this.sockets.length - 1];
      if (!s) throw new RangeError("Harness: no socket has been created");
      return s;
    },
    factoryError: null,
  };
  harness.client = new RustPlusClient({
    ip: "10.0.0.1",
    port: 28082,
    playerId: PLAYER_ID,
    playerToken: PLAYER_TOKEN,
    requestTimeoutMs: 1000,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 0 },
    webSocketFactory: (url, protocols) => {
      if (harness.factoryError) throw harness.factoryError;
      const s = new FakeSocket(url, protocols);
      harness.sockets.push(s);
      return s as unknown as WebSocket;
    },
    ...overrides,
  });
  return harness;
}

/** A harness whose client has completed its first `connect()`. */
async function makeConnected(overrides: Partial<RustPlusClientOptions> = {}): Promise<Harness> {
  const h = makeHarness(overrides);
  const connecting = h.client.connect();
  h.socket().open();
  await connecting;
  return h;
}

/** Subscribe to `error` and return the live list of what was emitted. */
function collectErrors(client: RustPlusClient): Error[] {
  const errors: Error[] = [];
  client.on("error", (err: Error) => errors.push(err));
  return errors;
}

/** Let pending microtasks (rate-limit acquire → socket write) run. */
function flush(): Promise<unknown> {
  return vi.advanceTimersByTimeAsync(0);
}

/** Capture a promise's rejection without leaving it unhandled while timers advance. */
function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (err: unknown) => err,
  );
}

// ── response fixture factories ──

function infoResponse(seq: number, info: rustplus.IAppInfo = {}): rustplus.IAppMessage {
  return { response: { seq, info: { name: "Fixture Server", players: 1, ...info } } };
}

function entityInfoResponse(seq: number, value = true): rustplus.IAppMessage {
  return { response: { seq, entityInfo: { type: 1, payload: { value } } } };
}

function successResponse(seq: number): rustplus.IAppMessage {
  return { response: { seq, success: {} } };
}

function errorResponse(seq: number, error: string): rustplus.IAppMessage {
  return { response: { seq, error: { error } } };
}

function timeResponse(seq: number): rustplus.IAppMessage {
  return {
    response: {
      seq,
      time: { dayLengthMinutes: 60, timeScale: 1, sunrise: 6, sunset: 18, time: 12 },
    },
  };
}

/**
 * Answer the entity request in flight with `not_found`, then answer the
 * `getTime` credential probe the client sends to classify it: `"ok"` means the
 * credentials are good (so the entity is gone), `"not_found"` means they are not.
 */
async function answerNotFound(socket: FakeSocket, probe: "ok" | "not_found"): Promise<void> {
  socket.deliver(errorResponse(socket.lastRequest.seq, "not_found"));
  await flush();
  const probeReq = socket.lastRequest;
  if (!probeReq.getTime) throw new RangeError("answerNotFound: no credential probe was sent");
  socket.deliver(
    probe === "ok" ? timeResponse(probeReq.seq) : errorResponse(probeReq.seq, "not_found"),
  );
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Facepunch's companion socket: direct connections are being phased out, and
// current servers' pairing pushes carry no ip/port at all, so this is the only
// route to them.
describe("RustPlusClient — companion socket", () => {
  const SERVER_ID = "ccaf8155-b9cd-42ff-a288-5942a31aba42";
  const companion = (getAuthToken: () => string | undefined) => ({
    ip: undefined,
    port: undefined,
    companion: { serverId: SERVER_ID, getAuthToken },
  });

  it("dials /socket/{serverId}, sending the token only as a subprotocol", () => {
    const h = makeHarness(companion(() => "AUTH<<???>>TOKEN"));
    void h.client.connect();
    const url = `wss://companion-rust.facepunch.com/socket/${SERVER_ID}`;
    expect(h.client.url).toBe(url);
    expect(h.socket().url).toBe(url);
    // base64url without padding: '+' → '-', '/' → '_', '=' stripped.
    expect(h.socket().protocols).toEqual(["rustplus.auth.v1", toBase64Url("AUTH<<???>>TOKEN")]);
    expect(toBase64Url("<<???>>")).toBe("PDw_Pz8-Pg");
    expect(h.socket().url).not.toContain("AUTH");
  });

  it("takes precedence over ip/port when both are given", () => {
    const h = makeHarness({ companion: { serverId: SERVER_ID, getAuthToken: () => "T" } });
    void h.client.connect();
    expect(h.socket().url).toBe(`wss://companion-rust.facepunch.com/socket/${SERVER_ID}`);
  });

  it("reads the token afresh on every reconnect, so a renewed token is used", async () => {
    let token = "OLD";
    const h = await makeConnected(companion(() => token));
    token = "NEW";
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sockets).toHaveLength(2);
    expect(h.socket().protocols[1]).toBe(toBase64Url("NEW"));
  });

  it("rejects connect() with an AuthError, opening no socket, when there is no token", async () => {
    const h = makeHarness(companion(() => undefined));
    const outcome = await rejection(h.client.connect());
    expect(outcome).toBeInstanceOf(AuthError);
    expect((outcome as AuthError).credential).toBe("authToken");
    expect(h.sockets).toHaveLength(0);
  });

  it("reports the route the latest connect dialled", async () => {
    let token: string | undefined = "T";
    const h = makeHarness({ companion: { serverId: SERVER_ID, getAuthToken: () => token } });
    expect(h.client.route).toBeUndefined();
    const connecting = h.client.connect();
    expect(h.client.route).toBe("companion");
    h.socket().open();
    await connecting;
    token = undefined;
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.client.route).toBe("direct");
  });

  it("falls back to a direct connection when there is no token but the server has an address", async () => {
    const h = makeHarness({ companion: { serverId: SERVER_ID, getAuthToken: () => undefined } });
    const connecting = h.client.connect();
    expect(h.socket().url).toBe("ws://10.0.0.1:28082");
    expect(h.socket().protocols).toEqual([]);
    expect(h.client.url).toBe("ws://10.0.0.1:28082");
    h.socket().open();
    await connecting;
    expect(h.client.connected).toBe(true);
  });

  it("returns to the companion socket on the next reconnect once a token is available", async () => {
    let token: string | undefined = undefined;
    const h = await makeConnected({
      companion: { serverId: SERVER_ID, getAuthToken: () => token },
    });
    expect(h.socket().url).toBe("ws://10.0.0.1:28082");
    token = "RENEWED";
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.socket().url).toBe(`wss://companion-rust.facepunch.com/socket/${SERVER_ID}`);
  });

  it.each([401, 403])(
    "a %i handshake rejects connect() with an AuthError, reported once",
    async (status) => {
      const h = makeHarness(companion(() => "EXPIRED"));
      const errors = collectErrors(h.client);
      const connecting = rejection(h.client.connect());
      h.socket().refuseHandshake(status);
      const outcome = await connecting;
      expect(outcome).toBeInstanceOf(AuthError);
      expect((outcome as AuthError).credential).toBe("authToken");
      expect((outcome as Error).message).toContain(`HTTP ${status}`);
      // The typed error replaces ws's generic one rather than adding to it.
      expect(errors).toEqual([outcome]);
      expect(h.client.connected).toBe(false);
    },
  );

  it("retries a refused token after 5, 10 and 15 seconds, then reports it and stops", async () => {
    expect(AUTH_RETRY_DELAYS_MS).toEqual([5_000, 10_000, 15_000]);
    const h = makeHarness(companion(() => "EXPIRED"));
    collectErrors(h.client);
    const scheduled: number[] = [];
    h.client.on("reconnecting", (info) => scheduled.push(info.delayMs));
    const rejected: Error[] = [];
    h.client.on("authRejected", (err) => rejected.push(err));

    const connecting = rejection(h.client.connect());
    h.socket().refuseHandshake(403);
    expect(await connecting).toBeInstanceOf(AuthError);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
    h.socket().refuseHandshake(403);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sockets).toHaveLength(3);
    h.socket().refuseHandshake(403);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.sockets).toHaveLength(4);
    // Three retries are scheduled; none has been given up on yet.
    expect(scheduled).toEqual([5_000, 10_000, 15_000]);
    expect(rejected).toEqual([]);

    h.socket().refuseHandshake(403);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(AuthError);
    expect((rejected[0] as AuthError).credential).toBe("authToken");

    // Stopped: it needs a new token and a fresh connect().
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sockets).toHaveLength(4);
    expect(scheduled).toHaveLength(3);
    expect(h.client.connected).toBe(false);
  });

  it("a refusal that passes connects on a retry, and the next refusal starts the count over", async () => {
    const h = makeHarness(companion(() => "T"));
    collectErrors(h.client);
    const scheduled: number[] = [];
    h.client.on("reconnecting", (info) => scheduled.push(info.delayMs));
    const rejected: Error[] = [];
    h.client.on("authRejected", (err) => rejected.push(err));

    const connecting = rejection(h.client.connect());
    h.socket().refuseHandshake(403);
    await connecting;
    await vi.advanceTimersByTimeAsync(5_000);
    h.socket().refuseHandshake(403);
    await vi.advanceTimersByTimeAsync(10_000);
    h.socket().open();
    expect(h.client.connected).toBe(true);

    // Much later the connection drops and the handshake is refused again.
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    h.socket().refuseHandshake(403);
    expect(scheduled).toEqual([5_000, 10_000, 100, 5_000]);
    expect(rejected).toEqual([]);
  });

  it("only refusals in a row count: an unreachable server in between starts the count over", async () => {
    const h = makeHarness(companion(() => "T"));
    collectErrors(h.client);
    const scheduled: number[] = [];
    h.client.on("reconnecting", (info) => scheduled.push(info.delayMs));

    const connecting = rejection(h.client.connect());
    h.socket().refuseHandshake(403);
    await connecting;
    await vi.advanceTimersByTimeAsync(5_000);
    h.socket().refuseHandshake(502);
    await vi.advanceTimersByTimeAsync(200);
    h.socket().refuseHandshake(403);

    // 5s for the refusal, the backoff for the 502, then 5s again (not 10s).
    expect(scheduled).toEqual([5_000, 200, 5_000]);
  });

  it("gives a token refused during a reconnect the same three retries", async () => {
    const h = await makeConnected(companion(() => "EXPIRED-MEANWHILE"));
    collectErrors(h.client);
    const rejected: Error[] = [];
    h.client.on("authRejected", (err) => rejected.push(err));

    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    h.socket().refuseHandshake(403);
    for (const wait of AUTH_RETRY_DELAYS_MS) {
      expect(rejected).toEqual([]);
      await vi.advanceTimersByTimeAsync(wait);
      h.socket().refuseHandshake(403);
    }

    expect(rejected).toHaveLength(1);
    expect(h.sockets).toHaveLength(5);
  });

  it("stops reconnecting, instead of spinning, once there is no token and no direct address", async () => {
    let token: string | undefined = "T";
    const h = await makeConnected(companion(() => token));
    const scheduled: number[] = [];
    h.client.on("reconnecting", (info) => scheduled.push(info.delayMs));

    token = undefined; // withdrawn by the host: refused, or signed out
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(600_000);

    // The one attempt found nothing to dial, and no further ones were made.
    expect(scheduled).toEqual([100]);
    expect(h.sockets).toHaveLength(1);
  });

  it("a 404 handshake rejects connect() naming the unknown server id", async () => {
    const h = makeHarness(companion(() => "T"));
    const connecting = rejection(h.client.connect());
    h.socket().refuseHandshake(404);
    const outcome = await connecting;
    expect(outcome).toBeInstanceOf(ConnectionError);
    expect((outcome as Error).message).toContain("does not know this server id");
  });

  it.each([502, 503, 504])(
    "names a %i handshake as the game server being unreachable (seen during a restart)",
    (status) => {
      const err = handshakeError(status);
      expect(err).toBeInstanceOf(ConnectionError);
      expect(err.message).toBe(
        `companion socket can't reach the game server (HTTP ${status}); it may be restarting`,
      );
    },
  );

  it("maps refused handshakes to typed errors", () => {
    expect(handshakeError(403)).toBeInstanceOf(AuthError);
    expect(handshakeError(401)).toBeInstanceOf(AuthError);
    expect(handshakeError(404)).toBeInstanceOf(ConnectionError);
    expect(handshakeError(500).message).toBe("server refused the WebSocket handshake (HTTP 500)");
  });
});

describe("RustPlusClient — connect lifecycle", () => {
  it("connects directly to the server ip:port by default", () => {
    const h = makeHarness();
    void h.client.connect();
    expect(h.client.url).toBe("ws://10.0.0.1:28082");
    expect(h.socket().url).toBe("ws://10.0.0.1:28082");
  });

  it("offers no subprotocols on a direct connection", () => {
    const h = makeHarness();
    void h.client.connect();
    expect(h.socket().protocols).toEqual([]);
  });

  it("refuses to construct without a route", () => {
    expect(() => makeHarness({ ip: undefined, port: undefined })).toThrow(ConnectionError);
  });

  it("resolves connect() on open, emits 'connected', and flips `connected`", async () => {
    const h = makeHarness();
    let connectedEvents = 0;
    h.client.on("connected", () => (connectedEvents += 1));

    const connecting = h.client.connect();
    expect(h.client.connected).toBe(false);
    h.socket().open();
    await connecting;

    expect(h.client.connected).toBe(true);
    expect(connectedEvents).toBe(1);
  });

  it("connect() on an already-connected client resolves without a second socket", async () => {
    const h = await makeConnected();
    await expect(h.client.connect()).resolves.toBeUndefined();
    expect(h.sockets).toHaveLength(1);
  });

  it("rejects an overlapping connect() while the first is still in flight", async () => {
    const h = makeHarness();
    const first = h.client.connect();
    const second = rejection(h.client.connect());

    const err = await second;
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/already in progress/);
    expect(h.sockets).toHaveLength(1);

    // The original attempt is unaffected.
    h.socket().open();
    await expect(first).resolves.toBeUndefined();
  });

  it("fails the first connect() when the socket closes before opening, then keeps trying", async () => {
    const h = makeHarness();
    const scheduled: { attempt: number; delayMs: number }[] = [];
    h.client.on("reconnecting", (info) => scheduled.push(info));
    let connectedEvents = 0;
    h.client.on("connected", () => (connectedEvents += 1));

    const connecting = rejection(h.client.connect());
    h.socket().drop(1006);

    // The caller learns why at once...
    const err = await connecting;
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/closed before open \(1006\)/);

    // ...and the client carries on with the same backoff as after a drop.
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sockets).toHaveLength(2);
    h.socket().drop(1006);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sockets).toHaveLength(3);
    expect(scheduled).toEqual([
      { attempt: 1, delayMs: 100 },
      { attempt: 2, delayMs: 200 },
    ]);

    h.socket().open();
    expect(h.client.connected).toBe(true);
    expect(connectedEvents).toBe(1);
  });

  it("connects a server that was unreachable at the first connect once it is up", async () => {
    // The host started before the game server did: the companion socket
    // answers 502 until the server is reachable.
    const h = makeHarness({
      ip: undefined,
      port: undefined,
      companion: { serverId: "srv", getAuthToken: () => "T" },
    });
    let connectedEvents = 0;
    h.client.on("connected", () => (connectedEvents += 1));
    collectErrors(h.client);

    const connecting = rejection(h.client.connect());
    h.socket().refuseHandshake(502);
    expect(await connecting).toBeInstanceOf(ConnectionError);

    await vi.advanceTimersByTimeAsync(100);
    h.socket().refuseHandshake(502);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sockets).toHaveLength(3);
    h.socket().open();

    expect(h.client.connected).toBe(true);
    expect(connectedEvents).toBe(1);
  });

  it("disconnect() stops the retries of a failed first connect", async () => {
    const h = makeHarness();
    const connecting = rejection(h.client.connect());
    h.socket().drop(1006);
    await connecting;

    await h.client.disconnect();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sockets).toHaveLength(1);
  });

  it("does not retry a failed first connect when reconnect is disabled", async () => {
    const h = makeHarness({ reconnect: { enabled: false } });
    const connecting = rejection(h.client.connect());
    h.socket().drop(1006);
    await connecting;

    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sockets).toHaveLength(1);
  });

  it("can connect() again after a failed first attempt", async () => {
    const h = makeHarness();
    const failed = rejection(h.client.connect());
    h.socket().drop(1006);
    await failed;

    const retry = h.client.connect();
    expect(h.sockets).toHaveLength(2);
    h.socket().open();
    await retry;
    expect(h.client.connected).toBe(true);
  });

  it("rejects connect() with the cause when the socket cannot be constructed", async () => {
    const h = makeHarness();
    const boom = new TypeError("bad url");
    h.factoryError = boom;

    const err = await rejection(h.client.connect());
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error & { cause?: unknown }).cause).toBe(boom);
    expect(h.client.connected).toBe(false);
  });

  it("surfaces a transport error as a ConnectionError 'error' event carrying the cause", async () => {
    const h = await makeConnected();
    const errors = collectErrors(h.client);
    const cause = new Error("ECONNRESET");

    h.socket().fail(cause);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ConnectionError);
    expect(errors[0]!.message).toBe("ECONNRESET");
    expect((errors[0] as Error & { cause?: unknown }).cause).toBe(cause);
    // 'error' alone does not tear the connection down — 'close' drives recovery.
    expect(h.client.connected).toBe(true);
  });

  it("does not throw on a transport error when nobody listens for 'error'", async () => {
    const h = await makeConnected();
    expect(() => h.socket().fail(new Error("ECONNRESET"))).not.toThrow();
  });

  it("disconnect() before the socket opens rejects the pending connect()", async () => {
    const h = makeHarness();
    const connecting = rejection(h.client.connect());

    await h.client.disconnect();

    const err = await connecting;
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/disconnected before the connection opened/);
    expect(h.socket().closeCalls).toBe(1);
    expect(h.client.connected).toBe(false);
  });

  it("can connect() again after disconnect() interrupted a pending connect()", async () => {
    const h = makeHarness();
    const interrupted = rejection(h.client.connect());
    await h.client.disconnect();
    await interrupted;

    const retry = h.client.connect();
    expect(h.sockets).toHaveLength(2);
    h.socket().open();
    await expect(retry).resolves.toBeUndefined();
    expect(h.client.connected).toBe(true);
  });

  it("ignores a socket that opens after disconnect() abandoned it", async () => {
    const h = makeHarness();
    let connectedEvents = 0;
    h.client.on("connected", () => (connectedEvents += 1));
    const interrupted = rejection(h.client.connect());
    const abandoned = h.socket();
    abandoned.emitCloseOnClose = false; // the transport is slow to wind down
    void h.client.disconnect();
    await interrupted;

    abandoned.open();

    expect(h.client.connected).toBe(false);
    expect(connectedEvents).toBe(0);
  });
});

describe("RustPlusClient — events from a superseded socket", () => {
  /**
   * A connected client whose socket has been disconnected but has not emitted
   * `close` yet, with a replacement `connect()` already in flight.
   */
  async function reconnectingOverSlowClose(): Promise<{
    h: Harness;
    old: FakeSocket;
    fresh: FakeSocket;
    connecting: Promise<void>;
  }> {
    const h = await makeConnected();
    const old = h.socket();
    old.emitCloseOnClose = false; // its 'close' arrives late, driven by the test
    void h.client.disconnect();
    const connecting = h.client.connect();
    const fresh = h.socket();
    expect(fresh).not.toBe(old);
    return { h, old, fresh, connecting };
  }

  it("connects when connect() follows a disconnect() that was not awaited", async () => {
    const h = await makeConnected();

    void h.client.disconnect();
    const connecting = h.client.connect();
    h.socket().open();

    await expect(connecting).resolves.toBeUndefined();
    expect(h.sockets).toHaveLength(2);
    expect(h.client.connected).toBe(true);
  });

  it("an old socket's late close does not fail the connect() that replaced it", async () => {
    const { h, old, fresh, connecting } = await reconnectingOverSlowClose();
    const drops: unknown[] = [];
    h.client.on("disconnected", (d) => drops.push(d));

    old.drop(1000); // the old socket finally reports its close

    fresh.open();
    await expect(connecting).resolves.toBeUndefined();
    expect(h.client.connected).toBe(true);
    expect(drops).toEqual([]);

    // The new socket is still the one being listened to.
    const info = h.client.getInfo();
    await flush();
    fresh.deliver(infoResponse(fresh.lastRequest.seq, { name: "Still Here" }));
    await expect(info).resolves.toMatchObject({ name: "Still Here" });
  });

  it("an old socket's late close does not tear down an established connection", async () => {
    const { h, old, fresh, connecting } = await reconnectingOverSlowClose();
    fresh.open();
    await connecting;
    const drops: unknown[] = [];
    h.client.on("disconnected", (d) => drops.push(d));
    const inFlight = h.client.getInfo();
    await flush();

    old.drop(1006);

    // No disconnect, no reconnect, and the in-flight request is untouched.
    await vi.advanceTimersByTimeAsync(500);
    expect(drops).toEqual([]);
    expect(h.sockets).toHaveLength(2);
    expect(h.client.connected).toBe(true);
    fresh.deliver(infoResponse(fresh.lastRequest.seq));
    await expect(inFlight).resolves.toMatchObject({ name: "Fixture Server" });
  });

  it("does not surface errors or frames from a socket it has let go of", async () => {
    const { h, old, fresh, connecting } = await reconnectingOverSlowClose();
    fresh.open();
    await connecting;
    const errors = collectErrors(h.client);
    const raw: unknown[] = [];
    h.client.on("message", (m) => raw.push(m));

    old.fail(new Error("WebSocket was closed before the connection was established"));
    old.deliver({
      broadcast: { entityChanged: { entityId: wireId(1), payload: { value: true } } },
    });

    expect(errors).toEqual([]);
    expect(raw).toEqual([]);
  });

  it("stops listening to a disconnected socket once it reports its close", async () => {
    const h = await makeConnected();
    const old = h.socket();

    await h.client.disconnect();

    for (const event of ["open", "message", "error", "close"]) {
      expect(old.listenerCount(event)).toBe(0);
    }
  });
});

describe("RustPlusClient — connect() during an automatic reconnect", () => {
  it("cancels the backoff wait and connects now, on a single socket", async () => {
    const h = await makeConnected();
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(50); // mid-backoff: no reconnect socket yet
    expect(h.sockets).toHaveLength(1);

    const connecting = h.client.connect();
    expect(h.sockets).toHaveLength(2);
    h.socket().open();
    await connecting;

    // The cancelled attempt never fires a second, competing socket.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.client.connected).toBe(true);
  });

  it("adopts a reconnect socket already in flight instead of opening another", async () => {
    const h = await makeConnected();
    const tracked = h.client.getEntityInfo(111);
    await flush();
    h.socket().deliver(entityInfoResponse(h.socket().lastRequest.seq));
    await tracked;
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100); // the reconnect socket exists, unopened
    expect(h.sockets).toHaveLength(2);

    const connecting = h.client.connect();
    expect(h.sockets).toHaveLength(2);
    h.socket().open();
    await expect(connecting).resolves.toBeUndefined();
    await flush();

    // It is still the reconnect it started as: tracked entities re-subscribe.
    expect(h.socket().sent.map((r) => r.entityId)).toEqual([111]);
  });

  it("rejects when the adopted reconnect socket closes before opening", async () => {
    const h = await makeConnected();
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);

    const connecting = rejection(h.client.connect());
    h.socket().drop(1006);

    const err = await connecting;
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/closed before open \(1006\)/);
  });
});

describe("RustPlusClient — request/response correlation", () => {
  it("stamps each request with an increasing seq and the client's own credentials", async () => {
    const h = await makeConnected();
    void rejection(h.client.getInfo());
    void rejection(h.client.getTime());
    await flush();

    const [first, second] = h.socket().sent;
    expect(first!.seq).toBe(1);
    expect(second!.seq).toBe(2);
    expect(first!.getInfo).toBeTruthy();
    expect(second!.getTime).toBeTruthy();
    for (const req of [first!, second!]) {
      // Full 64-bit precision survives the Long round-trip.
      expect(String(req.playerId)).toBe(PLAYER_ID);
      expect(req.playerToken).toBe(Number(PLAYER_TOKEN));
    }
  });

  it("resolves out-of-order responses to the callers that issued them", async () => {
    const h = await makeConnected();
    const info = h.client.getInfo();
    const time = h.client.getTime();
    const entity = h.client.getEntityInfo(7);
    await flush();

    const [infoReq, timeReq, entityReq] = h.socket().sent;
    // Answer in reverse order.
    h.socket().deliver(entityInfoResponse(entityReq!.seq, false));
    h.socket().deliver({
      response: { seq: timeReq!.seq, time: { sunrise: 6, sunset: 18, time: 12 } },
    });
    h.socket().deliver(infoResponse(infoReq!.seq, { name: "Out Of Order" }));

    await expect(info).resolves.toMatchObject({ name: "Out Of Order" });
    await expect(time).resolves.toMatchObject({ time: 12, isDay: true });
    await expect(entity).resolves.toMatchObject({ entityId: 7, type: "switch", value: false });
  });

  it("ignores a response whose seq matches no pending request", async () => {
    const h = await makeConnected();
    const errors = collectErrors(h.client);
    let settled = false;
    const info = h.client.getInfo().finally(() => (settled = true));
    await flush();

    h.socket().deliver(infoResponse(9999, { name: "Stranger" }));
    await flush();
    expect(settled).toBe(false);
    expect(errors).toEqual([]);

    h.socket().deliver(infoResponse(h.socket().lastRequest.seq, { name: "Mine" }));
    await expect(info).resolves.toMatchObject({ name: "Mine" });
  });

  it("sendRequest overrides caller-supplied seq/credentials and returns the raw response", async () => {
    const h = await makeConnected();
    const pending = h.client.sendRequest({
      seq: 4242,
      playerId: Long.fromString("1", true),
      playerToken: 1,
      entityId: wireId(31),
      getEntityInfo: {},
    });
    await flush();

    const req = h.socket().lastRequest;
    expect(req.seq).toBe(1);
    expect(String(req.playerId)).toBe(PLAYER_ID);
    expect(req.playerToken).toBe(Number(PLAYER_TOKEN));
    expect(req.entityId).toBe(31);
    expect(req.getEntityInfo).toBeTruthy();

    h.socket().deliver(entityInfoResponse(req.seq));
    const res = await pending;
    expect(res.seq).toBe(1);
    expect(res.entityInfo?.payload?.value).toBe(true);
    // The escape hatch does not register the entity for re-subscription.
    expect(h.client.tracked).toEqual([]);
  });

  it("times a request out with a ConnectionError after exactly requestTimeoutMs", async () => {
    const h = await makeConnected({ requestTimeoutMs: 1000 });
    let settled = false;
    const outcome = rejection(h.client.getInfo().finally(() => (settled = true)));

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/request 1 timed out/);
    // A slow server is not a dropped socket.
    expect(h.client.connected).toBe(true);
  });

  it("drops a late response to a timed-out request and keeps serving new ones", async () => {
    const h = await makeConnected({ requestTimeoutMs: 1000 });
    const errors = collectErrors(h.client);
    const timedOut = rejection(h.client.getInfo());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await timedOut).toBeInstanceOf(ConnectionError);
    const staleSeq = h.socket().lastRequest.seq;

    const next = h.client.getInfo();
    await flush();
    const nextSeq = h.socket().lastRequest.seq;
    expect(nextSeq).not.toBe(staleSeq);

    // The stale answer arrives first; it must not resolve the new request.
    h.socket().deliver(infoResponse(staleSeq, { name: "Stale" }));
    h.socket().deliver(infoResponse(nextSeq, { name: "Fresh" }));

    await expect(next).resolves.toMatchObject({ name: "Fresh" });
    expect(errors).toEqual([]);
  });

  it("rejects a request made before connect() without creating a socket", async () => {
    const h = makeHarness();
    const err = await rejection(h.client.getInfo());
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/not connected/);
    expect(h.sockets).toHaveLength(0);
  });

  it("rejects with the cause when the socket reports a send failure", async () => {
    const h = await makeConnected();
    const cause = new Error("EPIPE");
    h.socket().sendCallbackError = cause;

    const err = await rejection(h.client.getInfo());
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/send failed/);
    expect((err as Error & { cause?: unknown }).cause).toBe(cause);
  });

  it("rejects with the cause when the socket throws on send", async () => {
    const h = await makeConnected();
    const cause = new Error("socket not open");
    h.socket().sendThrows = cause;

    const err = await rejection(h.client.getInfo());
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/send threw/);
    expect((err as Error & { cause?: unknown }).cause).toBe(cause);
  });

  it("recovers from a failed send: the next request is correlated normally", async () => {
    const h = await makeConnected();
    h.socket().sendThrows = new Error("socket not open");
    await rejection(h.client.getInfo());

    h.socket().sendThrows = null;
    const next = h.client.getInfo();
    await flush();
    h.socket().deliver(infoResponse(h.socket().lastRequest.seq, { name: "Recovered" }));
    await expect(next).resolves.toMatchObject({ name: "Recovered" });
  });

  it.each<[string, (bytes: Uint8Array) => unknown]>([
    ["a Buffer", (bytes) => Buffer.from(bytes)],
    [
      "an ArrayBuffer",
      (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ],
    [
      "an array of Buffer fragments",
      (bytes) => [Buffer.from(bytes.subarray(0, 2)), Buffer.from(bytes.subarray(2))],
    ],
  ])("decodes a frame delivered as %s", async (_label, toRaw) => {
    const h = await makeConnected();
    const info = h.client.getInfo();
    await flush();

    const bytes = encodeMessage(infoResponse(h.socket().lastRequest.seq, { name: "Framed" }));
    h.socket().deliverRaw(toRaw(bytes));

    await expect(info).resolves.toMatchObject({ name: "Framed" });
  });

  it("reports an undecodable frame as a ProtocolError and keeps the connection usable", async () => {
    const h = await makeConnected();
    const errors = collectErrors(h.client);

    // Field 1, length-delimited, claims 5 bytes but only 1 follows.
    h.socket().deliverRaw(Buffer.from([0x0a, 0x05, 0x01]));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ProtocolError);
    expect(errors[0]!.message).toMatch(/failed to decode AppMessage/);
    expect((errors[0] as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(h.client.connected).toBe(true);

    const info = h.client.getInfo();
    await flush();
    h.socket().deliver(infoResponse(h.socket().lastRequest.seq, { name: "Still Here" }));
    await expect(info).resolves.toMatchObject({ name: "Still Here" });
  });

  it("does not throw on an undecodable frame when nobody listens for 'error'", async () => {
    const h = await makeConnected();
    expect(() => h.socket().deliverRaw(Buffer.from([0x0a, 0x05, 0x01]))).not.toThrow();
  });

  it("ignores an empty AppMessage (neither response nor broadcast)", async () => {
    const h = await makeConnected();
    const errors = collectErrors(h.client);
    const raw: unknown[] = [];
    h.client.on("message", (m) => raw.push(m));

    h.socket().deliverRaw(Buffer.alloc(0));

    expect(raw).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("RustPlusClient — AppError → typed error mapping", () => {
  // The server's validation can only produce not_found, rate_limit and banned
  // (a bad playerToken also answers not_found); every other string is
  // contextual and kept raw on a ProtocolError, except the camera handler's
  // player_online.
  it.each<[string, new (...args: never[]) => RustPlusError, string]>([
    ["banned", AuthError, "AuthError"],
    ["rate_limit", RateLimitError, "RateLimitError"],
    ["player_online", CameraUnavailableError, "CameraUnavailableError"],
    ["wrong_type", ProtocolError, "ProtocolError"],
    ["invalid_token", ProtocolError, "ProtocolError"],
    ["blocked", ProtocolError, "ProtocolError"],
    ["no_permission", ProtocolError, "ProtocolError"],
    ["no_player", ProtocolError, "ProtocolError"],
  ])("maps server error %j to its typed class with a stable name", async (error, cls, name) => {
    const h = await makeConnected();
    const outcome = rejection(h.client.getEntityInfo(1));
    await flush();
    h.socket().deliver(errorResponse(h.socket().lastRequest.seq, error));

    const err = await outcome;
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(RustPlusError);
    // The discord adapter's friendlyError() matches on `name`.
    expect((err as Error).name).toBe(name);
    expect((err as Error).message).toContain(error);
    if (cls === ProtocolError) expect((err as ProtocolError).serverError).toBe(error);
    if (cls === CameraUnavailableError) {
      expect((err as CameraUnavailableError).reason).toBe("playerOnline");
    }
  });

  it.each<[string, (c: RustPlusClient) => Promise<unknown>]>([
    ["getInfo", (c) => c.getInfo()],
    ["getTime", (c) => c.getTime()],
    ["getTeamInfo", (c) => c.getTeamInfo()],
    ["sendTeamMessage", (c) => c.sendTeamMessage("hi")],
  ])("not_found on %s (names no entity) is a credential failure", async (_name, call) => {
    const h = await makeConnected();
    const outcome = rejection(call(h.client));
    await flush();
    h.socket().deliver(errorResponse(h.socket().lastRequest.seq, "not_found"));

    const err = await outcome;
    expect(err).toBeInstanceOf(AuthError);
    expect((err as Error).message).toContain("not_found");
    // Nothing to tell apart, so no probe.
    expect(h.socket().sent).toHaveLength(1);
  });

  it("not_found on an entity request, with the probe also not_found, is an AuthError and keeps tracking", async () => {
    const h = await makeConnected();
    const outcome = rejection(h.client.getEntityInfo(7));
    await flush();
    await answerNotFound(h.socket(), "not_found");

    const err = await outcome;
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).credential).toBe("playerToken");
    expect(err).not.toBeInstanceOf(EntityNotFoundError);
    expect(h.client.tracked).toEqual([7]);
    expect(h.socket().sent.map((r) => (r.getTime ? "getTime" : r.entityId))).toEqual([
      7,
      "getTime",
    ]);
  });

  it("not_found on an entity request, with the probe succeeding, is an EntityNotFoundError and untracks", async () => {
    const h = await makeConnected();
    const outcome = rejection(h.client.getEntityInfo(7));
    await flush();
    await answerNotFound(h.socket(), "ok");

    const err = await outcome;
    expect(err).toBeInstanceOf(EntityNotFoundError);
    expect((err as Error).name).toBe("EntityNotFoundError");
    expect((err as Error).message).toContain("not_found");
    expect(h.client.tracked).toEqual([]);
  });

  it("not_found on setEntityValue is classified by the same probe", async () => {
    const h = await makeConnected();
    const outcome = rejection(h.client.setEntityValue(7, true));
    await flush();
    await answerNotFound(h.socket(), "not_found");
    expect(await outcome).toBeInstanceOf(AuthError);
  });

  it("a server that answers every request not_found (bad playerToken) never untracks", async () => {
    const h = await makeConnected();
    const outcomes = [1, 2, 3].map((id) => rejection(h.client.getEntityInfo(id)));
    await flush();
    // All three in flight; answer each, then the single shared probe.
    for (const req of [...h.socket().sent]) {
      h.socket().deliver(errorResponse(req.seq, "not_found"));
    }
    await flush();
    const probes = h.socket().sent.filter((r) => r.getTime);
    expect(probes).toHaveLength(1);
    h.socket().deliver(errorResponse(probes[0]!.seq, "not_found"));

    for (const err of await Promise.all(outcomes)) expect(err).toBeInstanceOf(AuthError);
    expect(h.client.tracked).toEqual([1, 2, 3]);
  });

  it("keeps tracking when the probe itself fails, surfacing the probe's error", async () => {
    const h = await makeConnected({ requestTimeoutMs: 1000 });
    const outcome = rejection(h.client.getEntityInfo(7));
    await flush();
    h.socket().deliver(errorResponse(h.socket().lastRequest.seq, "not_found"));
    await flush();
    expect(h.socket().lastRequest.getTime).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1000); // probe never answered

    const err = await outcome;
    expect(err).toBeInstanceOf(ConnectionError);
    expect(h.client.tracked).toEqual([7]);
  });

  it("carries the raw server string on a ProtocolError for unrecognized errors", async () => {
    const h = await makeConnected();
    const outcome = rejection(h.client.setEntityValue(1, true));
    await flush();
    h.socket().deliver(errorResponse(h.socket().lastRequest.seq, "wrong_type"));

    const err = await outcome;
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).serverError).toBe("wrong_type");
  });

  it.each<[string, rustplus.IAppError]>([
    ["no error string", {}],
    ["an empty error string", { error: "" }],
  ])("reports an AppError with %s as an 'unknown' ProtocolError, not a success", async (_l, e) => {
    const h = await makeConnected();
    const outcome = rejection(h.client.setEntityValue(1, true));
    await flush();
    h.socket().deliver({ response: { seq: h.socket().lastRequest.seq, error: e } });

    const err = await outcome;
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).message).toBe("server error: unknown");
    expect((err as ProtocolError).serverError).toBe("unknown");
  });

  it("rejects only the correlated request; siblings still resolve", async () => {
    const h = await makeConnected();
    const bad = rejection(h.client.getEntityInfo(1));
    const good = h.client.getEntityInfo(2);
    await flush();

    const [badReq, goodReq] = h.socket().sent;
    h.socket().deliver(errorResponse(badReq!.seq, "wrong_type"));
    h.socket().deliver(entityInfoResponse(goodReq!.seq));

    expect(await bad).toBeInstanceOf(ProtocolError);
    await expect(good).resolves.toMatchObject({ entityId: 2 });
  });

  it("an AuthError is terminal for the request: no socket teardown, no blind reconnect", async () => {
    const h = await makeConnected();
    let disconnects = 0;
    h.client.on("disconnected", () => (disconnects += 1));
    const outcome = rejection(h.client.getInfo());
    await flush();
    h.socket().deliver(errorResponse(h.socket().lastRequest.seq, "not_found"));
    expect(await outcome).toBeInstanceOf(AuthError);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.socket().closeCalls).toBe(0);
    expect(disconnects).toBe(0);
    expect(h.client.connected).toBe(true);
  });

  it("an AuthError leaves reconnection alone: a later drop still reconnects with backoff", async () => {
    const h = await makeConnected();
    const outcome = rejection(h.client.getInfo());
    await flush();
    h.socket().deliver(errorResponse(h.socket().lastRequest.seq, "not_found"));
    expect(await outcome).toBeInstanceOf(AuthError);

    // Stopping the retry is the host's job (disconnect / build a new client);
    // the client treats this drop like any other.
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sockets).toHaveLength(2);
    h.socket().open();
    expect(h.client.connected).toBe(true);
  });

  it("disconnect() after an AuthError is how the host stops the reconnect", async () => {
    const h = await makeConnected();
    const outcome = rejection(h.client.getInfo());
    await flush();
    h.socket().deliver(errorResponse(h.socket().lastRequest.seq, "not_found"));
    expect(await outcome).toBeInstanceOf(AuthError);

    await h.client.disconnect();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(h.sockets).toHaveLength(1);
    expect(h.client.connected).toBe(false);
  });
});

// Entity ids are 64-bit on the server; long-running servers exceed 2^32.
describe("RustPlusClient — 64-bit entity ids", () => {
  const BIG = 2 ** 32 + 5;

  it("puts an entity id above 2^32 on the wire unchanged", async () => {
    const h = await makeConnected();
    const info = h.client.getEntityInfo(BIG);
    const set = rejection(h.client.setEntityValue(BIG, true));
    await flush();
    expect(h.socket().sent.map((r) => r.entityId)).toEqual([BIG, BIG]);

    const [infoReq, setReq] = h.socket().sent;
    h.socket().deliver(entityInfoResponse(infoReq!.seq));
    h.socket().deliver(successResponse(setReq!.seq));
    await expect(info).resolves.toMatchObject({ entityId: BIG });
    expect(await set).toBeUndefined();
    expect(h.client.tracked).toEqual([BIG]);
  });

  it("emits entityChanged with an id above 2^32 unchanged", async () => {
    const h = await makeConnected();
    const changes: EntityChange[] = [];
    h.client.on("entityChanged", (c: EntityChange) => changes.push(c));

    h.socket().deliver({
      broadcast: { entityChanged: { entityId: wireId(BIG), payload: { value: true } } },
    });

    expect(changes.map((c) => c.entityId)).toEqual([BIG]);
  });

  it("reports a broadcast id a JS number cannot hold as an error, not a wrong entityChanged", async () => {
    const h = await makeConnected();
    const errors = collectErrors(h.client);
    const changes: EntityChange[] = [];
    h.client.on("entityChanged", (c: EntityChange) => changes.push(c));

    h.socket().deliver({
      broadcast: {
        entityChanged: {
          entityId: Long.fromString("9007199254740993", true), // 2^53 + 1
          payload: { value: true },
        },
      },
    });

    expect(changes).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ProtocolError);
    expect(h.client.connected).toBe(true);
  });

  it.each([[-1], [1.5], [2 ** 53]])("rejects entity id %p without sending anything", async (id) => {
    const h = await makeConnected();
    const err = await rejection(h.client.setEntityValue(id, true));
    expect(err).toBeInstanceOf(ProtocolError);
    expect(h.socket().sent).toEqual([]);
  });
});

describe("RustPlusClient — typed wrappers", () => {
  it.each<
    [string, (c: RustPlusClient) => Promise<unknown>, (seq: number) => rustplus.IAppMessage, RegExp]
  >([
    ["getInfo", (c) => c.getInfo(), successResponse, /getInfo: missing info/],
    ["getTime", (c) => c.getTime(), successResponse, /getTime: missing time/],
    ["getTeamInfo", (c) => c.getTeamInfo(), successResponse, /getTeamInfo: missing teamInfo/],
    [
      "getEntityInfo",
      (c) => c.getEntityInfo(5),
      successResponse,
      /getEntityInfo: missing entityInfo/,
    ],
    [
      "setEntityValue",
      (c) => c.setEntityValue(5, true),
      infoResponse,
      /setEntityValue: server did not acknowledge/,
    ],
    [
      "sendTeamMessage",
      (c) => c.sendTeamMessage("hi"),
      infoResponse,
      /sendTeamMessage: server did not acknowledge/,
    ],
  ])(
    "%s rejects with a ProtocolError when the response carries the wrong payload",
    async (_name, call, wrongReply, expected) => {
      const h = await makeConnected();
      const outcome = rejection(call(h.client));
      await flush();
      h.socket().deliver(wrongReply(h.socket().lastRequest.seq));

      const err = await outcome;
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as Error).message).toMatch(expected);
    },
  );

  it("getTime reports night outside the sunrise–sunset window", async () => {
    const h = await makeConnected();
    const time = h.client.getTime();
    await flush();
    h.socket().deliver({
      response: {
        seq: h.socket().lastRequest.seq,
        time: { dayLengthMinutes: 60, timeScale: 1, sunrise: 6, sunset: 18, time: 18 },
      },
    });

    // sunset is exclusive: time === sunset is already night.
    await expect(time).resolves.toEqual({
      dayLengthMinutes: 60,
      timeScale: 1,
      sunrise: 6,
      sunset: 18,
      time: 18,
      isDay: false,
    });
  });

  it("getTeamInfo renders 64-bit steam ids as full-precision strings", async () => {
    const h = await makeConnected();
    const team = h.client.getTeamInfo();
    await flush();
    h.socket().deliver({
      response: {
        seq: h.socket().lastRequest.seq,
        teamInfo: {
          leaderSteamId: Long.fromString(PLAYER_ID, true),
          members: [
            { steamId: Long.fromString(PLAYER_ID, true), name: "Leader", isOnline: true },
            { steamId: Long.fromString("76561198000000002", true), name: "Mate", isAlive: true },
          ],
        },
      },
    });

    const info = await team;
    expect(info.leaderSteamId).toBe(PLAYER_ID);
    expect(info.members.map((m) => [m.steamId, m.name, m.isOnline, m.isAlive])).toEqual([
      [PLAYER_ID, "Leader", true, false],
      ["76561198000000002", "Mate", false, true],
    ]);
  });

  it("setEntityValue and sendTeamMessage put their arguments on the wire", async () => {
    const h = await makeConnected();
    const set = h.client.setEntityValue(88, false);
    await flush();
    const setReq = h.socket().lastRequest;
    expect(setReq.entityId).toBe(88);
    expect(setReq.setEntityValue?.value).toBe(false);
    h.socket().deliver(successResponse(setReq.seq));
    await expect(set).resolves.toBeUndefined();

    const chat = h.client.sendTeamMessage("raid at dawn");
    await flush();
    const chatReq = h.socket().lastRequest;
    expect(chatReq.sendTeamMessage?.message).toBe("raid at dawn");
    h.socket().deliver(successResponse(chatReq.seq));
    await expect(chat).resolves.toBeUndefined();
  });
});

describe("RustPlusClient — rate limiting", () => {
  it("rejects a request whose cost can never fit the bucket, without sending it", async () => {
    const h = await makeConnected({
      rateLimit: { capacity: 2, refillPerSecond: 1 },
      requestCosts: { getInfo: 3 },
    });

    const err = await rejection(h.client.getInfo());
    expect(err).toBeInstanceOf(RateLimitError);
    expect(h.socket().sent).toHaveLength(0);
  });

  it("queues requests past capacity and writes them FIFO as the bucket refills", async () => {
    const h = await makeConnected({
      rateLimit: { capacity: 1, refillPerSecond: 1 },
      requestTimeoutMs: 60_000,
    });
    const all = [1, 2, 3].map((id) => rejection(h.client.getEntityInfo(id)));
    const sentIds = (): Array<number | null | undefined> => h.socket().sent.map((r) => r.entityId);

    await flush();
    expect(sentIds()).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentIds()).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentIds()).toEqual([1, 2, 3]);

    await h.client.disconnect();
    await Promise.all(all);
  });

  it("charges the server's costs: sendTeamMessage 2, getMap 5", async () => {
    // 6 tokens: a team message (2) and a getMap (5) cannot both fit.
    const h = await makeConnected({
      rateLimit: { capacity: 6, refillPerSecond: 1 },
      requestTimeoutMs: 60_000,
    });
    const msg = rejection(h.client.sendTeamMessage("hi"));
    const map = rejection(h.client.sendRequest({ getMap: {} }));
    await flush();
    expect(h.socket().sent).toHaveLength(1);
    // 4 left, getMap needs 5: one more second of refill.
    await vi.advanceTimersByTimeAsync(999);
    expect(h.socket().sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.socket().sent).toHaveLength(2);
    expect(h.socket().lastRequest.getMap).toBeTruthy();

    await h.client.disconnect();
    await Promise.all([msg, map]);
  });

  it("after a rate_limit answer, sends nothing more until the bucket has refilled", async () => {
    const h = await makeConnected({
      rateLimit: { capacity: 25, refillPerSecond: 3 },
      requestTimeoutMs: 60_000,
    });
    const first = rejection(h.client.getInfo());
    await flush();
    h.socket().deliver(errorResponse(h.socket().lastRequest.seq, "rate_limit"));
    expect(await first).toBeInstanceOf(RateLimitError);

    // The local bucket still held 24 tokens, but the server's is empty and
    // charged the refusal a token: the next request waits for -1 → 1, i.e.
    // 2 tokens at 3/s.
    const next = h.client.getTime();
    await flush();
    expect(h.socket().sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(666);
    expect(h.socket().sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.socket().sent).toHaveLength(2);
    h.socket().deliver(timeResponse(h.socket().lastRequest.seq));
    await expect(next).resolves.toMatchObject({ isDay: true });
  });

  it("disconnect() rejects requests still queued on the bucket", async () => {
    const h = await makeConnected({ rateLimit: { capacity: 1, refillPerSecond: 1 } });
    const inFlight = rejection(h.client.getEntityInfo(1));
    const queued = rejection(h.client.getEntityInfo(2));
    await flush();
    expect(h.socket().sent).toHaveLength(1);

    await h.client.disconnect();

    for (const err of [await inFlight, await queued]) {
      expect(err).toBeInstanceOf(ConnectionError);
      expect((err as Error).message).toMatch(/client disconnected/);
    }
    // The queued request never reached the wire.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.socket().sent).toHaveLength(1);
  });
});

describe("RustPlusClient — disconnect & pending requests", () => {
  it("rejects every in-flight request when the socket drops and reports the close", async () => {
    const h = await makeConnected();
    const drops: Array<{ code: number; reason: string }> = [];
    h.client.on("disconnected", (d: { code: number; reason: string }) => drops.push(d));
    const a = rejection(h.client.getInfo());
    const b = rejection(h.client.getEntityInfo(3));
    await flush();

    h.socket().drop(1006, "going away");

    for (const err of [await a, await b]) {
      expect(err).toBeInstanceOf(ConnectionError);
      expect((err as Error).message).toMatch(/socket closed \(1006\)/);
    }
    expect(drops).toEqual([{ code: 1006, reason: "going away" }]);
    expect(h.client.connected).toBe(false);
  });

  it("a rejected in-flight request does not also fire its timeout later", async () => {
    const h = await makeConnected({ reconnect: { enabled: false } });
    const errors = collectErrors(h.client);
    const outcome = rejection(h.client.getInfo());
    await flush();
    h.socket().drop(1006);
    expect(await outcome).toBeInstanceOf(ConnectionError);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("manual disconnect rejects in-flight requests, closes the socket, and never reconnects", async () => {
    const h = await makeConnected();
    const outcome = rejection(h.client.getInfo());
    await flush();

    await h.client.disconnect();

    const err = await outcome;
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/client disconnected/);
    expect(h.socket().closeCalls).toBe(1);
    expect(h.client.connected).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sockets).toHaveLength(1);
  });

  it("rejects requests made after disconnect()", async () => {
    const h = await makeConnected();
    await h.client.disconnect();

    const err = await rejection(h.client.getInfo());
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/not connected/);
  });

  it("disconnect() resolves immediately when there is no socket", async () => {
    const h = makeHarness();
    await expect(h.client.disconnect()).resolves.toBeUndefined();
  });

  it("disconnect() resolves even if the socket throws on close", async () => {
    const h = await makeConnected();
    h.socket().closeThrows = new Error("already closed");
    await expect(h.client.disconnect()).resolves.toBeUndefined();
  });

  it("disconnect() resolves via the 1s safety net when 'close' never fires", async () => {
    const h = await makeConnected();
    h.socket().emitCloseOnClose = false;
    let done = false;
    void h.client.disconnect().then(() => (done = true));

    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("can connect() again on a fresh socket after disconnect()", async () => {
    const h = await makeConnected();
    await h.client.disconnect();

    const again = h.client.connect();
    expect(h.sockets).toHaveLength(2);
    h.socket().open();
    await again;
    expect(h.client.connected).toBe(true);

    // seq keeps counting on the new socket; correlation is unaffected.
    const info = h.client.getInfo();
    await flush();
    h.socket().deliver(infoResponse(h.socket().lastRequest.seq, { name: "Second Life" }));
    await expect(info).resolves.toMatchObject({ name: "Second Life" });
  });
});

describe("RustPlusClient — reconnect with backoff", () => {
  it("reconnects after a drop and emits 'connected' again", async () => {
    const h = await makeConnected();
    let connectedEvents = 0;
    h.client.on("connected", () => (connectedEvents += 1));

    h.socket().drop();
    expect(h.client.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sockets).toHaveLength(2);
    expect(h.client.connected).toBe(false); // socket created but not yet open

    h.socket().open();
    expect(h.client.connected).toBe(true);
    expect(connectedEvents).toBe(1);
  });

  it("rejects requests made while waiting to reconnect", async () => {
    const h = await makeConnected();
    h.socket().drop();

    const err = await rejection(h.client.getInfo());
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/not connected/);
  });

  it("backs off exponentially and caps at maxDelayMs (jitter 0)", async () => {
    const h = await makeConnected({
      reconnect: { initialDelayMs: 100, maxDelayMs: 300, factor: 2, jitter: 0 },
    });
    h.socket().drop();

    // Expected waits: 100, 200, then capped at 300, 300.
    let expectedSockets = 1;
    for (const delay of [100, 200, 300, 300]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.sockets).toHaveLength(expectedSockets);
      await vi.advanceTimersByTimeAsync(1);
      expectedSockets += 1;
      expect(h.sockets).toHaveLength(expectedSockets);
      // The attempt fails before opening → next backoff step.
      h.socket().drop();
    }
  });

  it.each<[string, number, number]>([
    ["the upper jitter bound", 1, 150],
    ["the lower jitter bound", 0, 50],
    ["no skew at the midpoint", 0.5, 100],
  ])("applies ±jitter to the delay: %s", async (_label, random, expectedDelay) => {
    vi.spyOn(Math, "random").mockReturnValue(random);
    const h = await makeConnected({
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 0.5 },
    });
    h.socket().drop();

    await vi.advanceTimersByTimeAsync(expectedDelay - 1);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
  });

  it("emits 'reconnecting' with the attempt number and delay before each try", async () => {
    const h = await makeConnected();
    const scheduled: { attempt: number; delayMs: number }[] = [];
    h.client.on("reconnecting", (r: { attempt: number; delayMs: number }) => scheduled.push(r));

    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    h.socket().drop(); // the retry fails too

    expect(scheduled).toEqual([
      { attempt: 1, delayMs: 100 },
      { attempt: 2, delayMs: 200 },
    ]);
  });

  it("resets the backoff after a successful reconnect", async () => {
    const h = await makeConnected();
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    h.socket().drop(); // attempt 1 fails → next wait is 200
    await vi.advanceTimersByTimeAsync(200);
    h.socket().open(); // attempt 2 succeeds
    expect(h.sockets).toHaveLength(3);

    h.socket().drop();
    // Back to the initial delay, not 400.
    await vi.advanceTimersByTimeAsync(99);
    expect(h.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(4);
  });

  it("gives up after maxRetries with a terminal ConnectionError", async () => {
    const h = await makeConnected({
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 0, maxRetries: 2 },
    });
    const errors = collectErrors(h.client);

    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    h.socket().drop(); // retry 1 fails
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sockets).toHaveLength(3);
    expect(errors).toEqual([]);
    h.socket().drop(); // retry 2 fails → cap reached

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ConnectionError);
    expect(errors[0]!.message).toMatch(/giving up after 2 reconnect attempts/);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sockets).toHaveLength(3);
    expect(h.client.connected).toBe(false);
  });

  it("does not reconnect at all when reconnect is disabled", async () => {
    const h = await makeConnected({ reconnect: { enabled: false } });
    let disconnects = 0;
    h.client.on("disconnected", () => (disconnects += 1));

    h.socket().drop();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(disconnects).toBe(1);
    expect(h.sockets).toHaveLength(1);
    expect(h.client.connected).toBe(false);
  });

  it("keeps backing off when the socket cannot even be constructed, then recovers", async () => {
    const h = await makeConnected();
    h.factoryError = new Error("ENETUNREACH");
    h.socket().drop();

    await vi.advanceTimersByTimeAsync(100); // attempt 1: factory throws
    expect(h.sockets).toHaveLength(1);

    h.factoryError = null;
    await vi.advanceTimersByTimeAsync(199);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // attempt 2 after the doubled delay
    expect(h.sockets).toHaveLength(2);

    h.socket().open();
    expect(h.client.connected).toBe(true);
  });

  it("disconnect() during backoff cancels the pending reconnect", async () => {
    const h = await makeConnected();
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(50);

    await h.client.disconnect();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(h.sockets).toHaveLength(1);
    expect(h.client.connected).toBe(false);
  });

  it("stops listening to a dropped socket", async () => {
    const h = await makeConnected();
    const old = h.socket();
    const raw: unknown[] = [];
    h.client.on("message", (m) => raw.push(m));

    old.drop();
    await vi.advanceTimersByTimeAsync(100);
    h.socket().open();

    // A frame from the dead socket must not reach consumers.
    old.deliver({
      broadcast: { entityChanged: { entityId: wireId(1), payload: { value: true } } },
    });
    expect(raw).toEqual([]);

    h.socket().deliver({
      broadcast: { entityChanged: { entityId: wireId(2), payload: { value: true } } },
    });
    expect(raw).toHaveLength(1);
  });
});

describe("RustPlusClient — re-subscription on reconnect", () => {
  /** Connect, then track `ids` via answered getEntityInfo calls. */
  async function connectedAndTracking(
    ids: number[],
    overrides: Partial<RustPlusClientOptions> = {},
  ): Promise<Harness> {
    const h = await makeConnected(overrides);
    for (const id of ids) {
      const info = h.client.getEntityInfo(id);
      await flush();
      h.socket().deliver(entityInfoResponse(h.socket().lastRequest.seq));
      await info;
    }
    return h;
  }

  /** Drop the live socket and bring up the replacement. */
  async function reconnect(h: Harness): Promise<void> {
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    h.socket().open();
    await flush();
  }

  it("sends nothing on the first connect", async () => {
    const h = await makeConnected();
    await flush();
    expect(h.socket().sent).toEqual([]);
  });

  it("re-issues getEntityInfo for tracked entities one at a time, in tracking order", async () => {
    const h = await connectedAndTracking([111, 222, 333]);
    expect(h.client.tracked).toEqual([111, 222, 333]);

    await reconnect(h);
    const fresh = h.socket();

    // Sequential: the next request waits for the previous answer.
    for (const [index, id] of [111, 222, 333].entries()) {
      expect(fresh.sent).toHaveLength(index + 1);
      expect(fresh.lastRequest.entityId).toBe(id);
      expect(fresh.lastRequest.getEntityInfo).toBeTruthy();
      fresh.deliver(entityInfoResponse(fresh.lastRequest.seq));
      await flush();
    }
    expect(fresh.sent).toHaveLength(3);
  });

  it("sends nothing on reconnect with resubscribeOnReconnect: false (the host re-subscribes)", async () => {
    const h = await connectedAndTracking([111, 222], { resubscribeOnReconnect: false });
    let connectedEvents = 0;
    h.client.on("connected", () => (connectedEvents += 1));

    await reconnect(h);

    expect(connectedEvents).toBe(1);
    expect(h.socket().sent).toEqual([]);
    expect(h.client.tracked).toEqual([111, 222]);
  });

  it("skips entities that were untracked before the drop", async () => {
    const h = await connectedAndTracking([111, 222]);
    h.client.untrackEntity(111);
    expect(h.client.tracked).toEqual([222]);

    await reconnect(h);
    const fresh = h.socket();
    fresh.deliver(entityInfoResponse(fresh.lastRequest.seq));
    await flush();

    expect(fresh.sent.map((r) => r.entityId)).toEqual([222]);
  });

  it("re-subscribes again on every subsequent reconnect", async () => {
    const h = await connectedAndTracking([111]);

    for (let round = 0; round < 2; round++) {
      await reconnect(h);
      const fresh = h.socket();
      expect(fresh.sent.map((r) => r.entityId)).toEqual([111]);
      fresh.deliver(entityInfoResponse(fresh.lastRequest.seq));
      await flush();
    }
    expect(h.sockets).toHaveLength(3);
  });

  it("surfaces a failed re-subscribe as an 'error' event and continues with the rest", async () => {
    const h = await connectedAndTracking([111, 222]);
    const errors = collectErrors(h.client);

    await reconnect(h);
    const fresh = h.socket();
    await answerNotFound(fresh, "ok"); // 111 is gone

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(EntityNotFoundError);

    expect(fresh.lastRequest.entityId).toBe(222);
    fresh.deliver(entityInfoResponse(fresh.lastRequest.seq));
    await flush();
    expect(fresh.sent.filter((r) => r.getEntityInfo).map((r) => r.entityId)).toEqual([111, 222]);
    expect(errors).toHaveLength(1);
    expect(h.client.connected).toBe(true);
  });

  it("stops re-requesting an entity once the server answers not_found", async () => {
    const h = await connectedAndTracking([111, 222]);
    const errors = collectErrors(h.client);

    await reconnect(h);
    const first = h.socket();
    await answerNotFound(first, "ok"); // 111 was wiped
    first.deliver(entityInfoResponse(first.lastRequest.seq));
    await flush();
    expect(h.client.tracked).toEqual([222]);
    expect(errors).toHaveLength(1);

    // The next reconnect asks only for the entity that still exists, and the
    // gone one raises no further error.
    await reconnect(h);
    const second = h.socket();
    second.deliver(entityInfoResponse(second.lastRequest.seq));
    await flush();
    expect(second.sent.map((r) => r.entityId)).toEqual([222]);
    expect(errors).toHaveLength(1);
  });

  it("never tracks an entity whose first getEntityInfo answers not_found", async () => {
    const h = await makeConnected();
    const outcome = rejection(h.client.getEntityInfo(404));
    await flush();
    await answerNotFound(h.socket(), "ok");
    expect(await outcome).toBeInstanceOf(EntityNotFoundError);
    expect(h.client.tracked).toEqual([]);

    await reconnect(h);
    expect(h.socket().sent).toEqual([]);
  });

  it.each<[string, string]>([
    ["a rate-limit answer", "rate_limit"],
    ["a ban", "banned"],
    ["an unrecognized server error", "wrong_type"],
  ])(
    "keeps tracking an entity after %s (only EntityNotFoundError untracks)",
    async (_label, error) => {
      const h = await makeConnected();
      const outcome = rejection(h.client.getEntityInfo(111));
      await flush();
      h.socket().deliver(errorResponse(h.socket().lastRequest.seq, error));
      await outcome;

      expect(h.client.tracked).toEqual([111]);
    },
  );

  it("keeps tracking an entity whose request timed out, and retries it on reconnect", async () => {
    const h = await makeConnected({ requestTimeoutMs: 1000 });
    const outcome = rejection(h.client.getEntityInfo(111));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBeInstanceOf(ConnectionError);
    expect(h.client.tracked).toEqual([111]);

    await reconnect(h);
    expect(h.socket().sent.map((r) => r.entityId)).toEqual([111]);
  });

  it("a failed re-subscribe with no 'error' listener does not crash or reject unhandled", async () => {
    const h = await connectedAndTracking([111]);

    await reconnect(h);
    const fresh = h.socket();
    expect(() => fresh.deliver(errorResponse(fresh.lastRequest.seq, "not_found"))).not.toThrow();
    await flush();
    fresh.deliver(timeResponse(fresh.lastRequest.seq));
    await flush();
    expect(h.client.connected).toBe(true);
  });

  it("an AuthError during re-subscribe is reported but does not trigger another reconnect", async () => {
    const h = await connectedAndTracking([111, 222]);
    const errors = collectErrors(h.client);

    await reconnect(h);
    const fresh = h.socket();
    await answerNotFound(fresh, "not_found");
    await answerNotFound(fresh, "not_found");

    expect(errors).toHaveLength(2);
    for (const err of errors) expect(err).toBeInstanceOf(AuthError);
    // Bad credentials say nothing about the entities: both stay tracked.
    expect(h.client.tracked).toEqual([111, 222]);

    // Bad credentials must not start a blind retry loop.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.sockets).toHaveLength(2);
    expect(fresh.closeCalls).toBe(0);
    expect(h.client.connected).toBe(true);
  });

  it("a re-subscribe that times out is reported and does not stall the remaining entities", async () => {
    const h = await connectedAndTracking([111, 222], { requestTimeoutMs: 1000 });
    const errors = collectErrors(h.client);

    await reconnect(h);
    const fresh = h.socket();
    expect(fresh.sent.map((r) => r.entityId)).toEqual([111]);

    await vi.advanceTimersByTimeAsync(1000); // 111 never answered
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ConnectionError);
    expect(errors[0]!.message).toMatch(/timed out/);
    expect(fresh.sent.map((r) => r.entityId)).toEqual([111, 222]);
  });
});

describe("RustPlusClient — broadcasts as typed events", () => {
  it("emits the raw 'message' before the typed 'entityChanged', with storage payload flattened", async () => {
    const h = await makeConnected();
    const order: string[] = [];
    const changes: EntityChange[] = [];
    h.client.on("message", () => order.push("message"));
    h.client.on("entityChanged", (c: EntityChange) => {
      order.push("entityChanged");
      changes.push(c);
    });

    h.socket().deliver({
      broadcast: {
        entityChanged: {
          entityId: wireId(4200),
          payload: {
            capacity: 24,
            hasProtection: true,
            protectionExpiry: 1_700_000_000,
            items: [
              { itemId: -151838493, quantity: 5000, itemIsBlueprint: false },
              { itemId: 317398316, quantity: 1, itemIsBlueprint: true },
            ],
          },
        },
      },
    });

    expect(order).toEqual(["message", "entityChanged"]);
    expect(changes).toMatchObject([
      {
        entityId: 4200,
        capacity: 24,
        hasProtection: true,
        protectionExpiry: 1_700_000_000,
        items: [
          { itemId: -151838493, quantity: 5000, itemIsBlueprint: false },
          { itemId: 317398316, quantity: 1, itemIsBlueprint: true },
        ],
      },
    ]);
  });

  it("emits both typed events when one broadcast carries an entity change and a team message", async () => {
    const h = await makeConnected();
    const changes: EntityChange[] = [];
    const chats: TeamChatMessage[] = [];
    h.client.on("entityChanged", (c: EntityChange) => changes.push(c));
    h.client.on("teamChat", (m: TeamChatMessage) => chats.push(m));

    h.socket().deliver({
      broadcast: {
        entityChanged: { entityId: wireId(9), payload: { value: true } },
        teamMessage: {
          message: {
            steamId: Long.fromString(PLAYER_ID, true),
            name: "Alice",
            message: "lights on",
            color: "#55aaff",
            time: 1_700_000_123,
          },
        },
      },
    });

    expect(changes.map((c) => [c.entityId, c.value])).toEqual([[9, true]]);
    expect(chats).toEqual([
      {
        steamId: PLAYER_ID,
        name: "Alice",
        message: "lights on",
        color: "#55aaff",
        time: 1_700_000_123,
      },
    ]);
  });

  it("does not emit 'teamChat' for a team-message envelope with no message", async () => {
    const h = await makeConnected();
    const raw: unknown[] = [];
    const chats: unknown[] = [];
    h.client.on("message", (m) => raw.push(m));
    h.client.on("teamChat", (m) => chats.push(m));

    h.socket().deliver({ broadcast: { teamMessage: {} } });

    expect(raw).toHaveLength(1);
    expect(chats).toEqual([]);
  });

  it("surfaces broadcasts it has no typed event for only as raw 'message'", async () => {
    const h = await makeConnected();
    const raw: rustplus.AppMessage[] = [];
    const typed: unknown[] = [];
    h.client.on("message", (m: rustplus.AppMessage) => raw.push(m));
    h.client.on("entityChanged", (c) => typed.push(c));
    h.client.on("teamChat", (c) => typed.push(c));

    h.socket().deliver({
      broadcast: { cameraRays: { sampleOffset: 3, rayData: new Uint8Array([1, 2, 3]) } },
    });

    expect(raw).toHaveLength(1);
    expect(raw[0]!.broadcast?.cameraRays?.sampleOffset).toBe(3);
    expect(typed).toEqual([]);
  });

  it("does not emit 'message' for responses", async () => {
    const h = await makeConnected();
    const raw: unknown[] = [];
    h.client.on("message", (m) => raw.push(m));

    const info = h.client.getInfo();
    await flush();
    h.socket().deliver(infoResponse(h.socket().lastRequest.seq));
    await info;

    expect(raw).toEqual([]);
  });

  it("keeps delivering broadcasts on the socket created by a reconnect", async () => {
    const h = await makeConnected();
    const changes: EntityChange[] = [];
    h.client.on("entityChanged", (c: EntityChange) => changes.push(c));

    h.socket().drop();
    await vi.advanceTimersByTimeAsync(100);
    h.socket().open();
    h.socket().deliver({
      broadcast: { entityChanged: { entityId: wireId(5), payload: { value: true } } },
    });

    expect(changes.map((c) => c.entityId)).toEqual([5]);
  });
});

describe("RustPlusClient — camera capture failure paths", () => {
  it("rejects captureCameraFrame with a ConnectionError when not connected", async () => {
    const h = makeHarness();
    const err = await rejection(h.client.captureCameraFrame("CAM1"));
    expect(err).toBeInstanceOf(ConnectionError);
    expect(h.sockets).toHaveLength(0);
  });

  it("rejects an in-progress capture with a ConnectionError when the socket drops", async () => {
    const h = await makeConnected({ reconnect: { enabled: false } });
    const outcome = rejection(h.client.captureCameraFrame("CAM1"));
    await flush();

    const sub = h.socket().lastRequest;
    expect(sub.cameraSubscribe?.cameraId).toBe("CAM1");
    h.socket().deliver({
      response: { seq: sub.seq, cameraSubscribeInfo: { width: 8, height: 8 } },
    });
    await flush();

    h.socket().drop(1006);

    const err = await outcome;
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/disconnected during camera capture/);
    // Cleanup is skipped on a dead connection: only the subscribe was ever sent.
    expect(h.socket().sent).toHaveLength(1);
  });

  it("rejects with CameraUnavailableError(playerOnline) when the player is in-game", async () => {
    const h = await makeConnected();
    const outcome = rejection(h.client.captureCameraFrame("CAM1"));
    await flush();

    h.socket().deliver(errorResponse(h.socket().lastRequest.seq, "player_online"));

    const err = await outcome;
    expect(err).toBeInstanceOf(CameraUnavailableError);
    expect((err as CameraUnavailableError).name).toBe("CameraUnavailableError");
    expect((err as CameraUnavailableError).reason).toBe("playerOnline");
    // The subscribe was refused, so there is nothing to unsubscribe from.
    expect(h.socket().sent).toHaveLength(1);
  });

  it("rejects with CameraUnavailableError(notFound) when the subscribe has no camera info", async () => {
    const h = await makeConnected();
    const outcome = rejection(h.client.captureCameraFrame("CAM1"));
    await flush();

    h.socket().deliver({ response: { seq: h.socket().lastRequest.seq, success: {} } });
    await flush();
    // Best-effort release of whatever the server subscribed.
    const unsub = h.socket().lastRequest;
    expect(unsub.cameraUnsubscribe).toBeTruthy();
    h.socket().deliver({ response: { seq: unsub.seq, success: {} } });

    const err = await outcome;
    expect(err).toBeInstanceOf(CameraUnavailableError);
    expect((err as CameraUnavailableError).reason).toBe("notFound");
  });

  it("rejects with CameraUnavailableError(noFrames) when no rays arrive before the timeout", async () => {
    const h = await makeConnected({ cameraCaptureTimeoutMs: 1000 });
    const outcome = rejection(h.client.captureCameraFrame("CAM1"));
    await flush();

    h.socket().deliver({
      response: { seq: h.socket().lastRequest.seq, cameraSubscribeInfo: { width: 8, height: 8 } },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const unsub = h.socket().lastRequest;
    expect(unsub.cameraUnsubscribe).toBeTruthy();
    h.socket().deliver({ response: { seq: unsub.seq, success: {} } });

    const err = await outcome;
    expect(err).toBeInstanceOf(CameraUnavailableError);
    expect((err as CameraUnavailableError).reason).toBe("noFrames");
  });
});
