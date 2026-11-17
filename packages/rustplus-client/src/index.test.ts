import { AddressInfo } from "node:net";

import { AppMessage, AppRequest, Long } from "@conduit/rustplus-proto";
import type { rustplus } from "@conduit/rustplus-proto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { AuthError, EntityNotFoundError, RustPlusClient, TokenBucket } from "./index.js";

/** Encode an AppMessage (response or broadcast) to the wire format. */
function encodeMessage(msg: rustplus.IAppMessage): Uint8Array {
  return AppMessage.encode(msg).finish();
}

/**
 * A controllable in-process mock Rust+ WebSocket server. Decodes incoming
 * AppRequests and lets a test register a responder keyed by the request shape.
 */
class MockServer {
  readonly wss: WebSocketServer;
  readonly sockets = new Set<WebSocket>();
  /** Called for every decoded AppRequest; returns the reply message(s). */
  onRequest: ((req: rustplus.AppRequest, socket: WebSocket) => void) | null = null;
  /** Records every request the server received. */
  readonly received: rustplus.AppRequest[] = [];

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.binaryType = "arraybuffer";
      socket.on("message", (data) => {
        const bytes =
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
        // AppRequest is decoded by re-using the proto codec indirectly: the
        // client encodes an AppRequest, so we decode it here.
        const req = decodeAppRequest(bytes);
        this.received.push(req);
        this.onRequest?.(req, socket);
      });
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  static async start(): Promise<MockServer> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    return new MockServer(wss);
  }

  get port(): number {
    return (this.wss.address() as AddressInfo).port;
  }

  send(socket: WebSocket, msg: rustplus.IAppMessage): void {
    socket.send(encodeMessage(msg));
  }

  /** Send a message to every connected client. */
  broadcast(msg: rustplus.IAppMessage): void {
    for (const s of this.sockets) s.send(encodeMessage(msg));
  }

  /** Drop all current connections (simulate a network drop). */
  dropConnections(): void {
    for (const s of this.sockets) s.terminate();
    this.sockets.clear();
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

// Decode AppRequest on the server side via the proto package's AppRequest class.
function decodeAppRequest(bytes: Uint8Array): rustplus.AppRequest {
  return AppRequest.decode(bytes);
}

function makeClient(port: number, opts = {}): RustPlusClient {
  return new RustPlusClient({
    ip: "127.0.0.1",
    port,
    playerId: "76561190000000000",
    playerToken: "123456789",
    requestTimeoutMs: 2000,
    ...opts,
  });
}

describe("RustPlusClient — request/response correlation", () => {
  let server: MockServer;

  beforeEach(async () => {
    server = await MockServer.start();
  });
  afterEach(async () => {
    await server.close();
  });

  it("getInfo round-trips a mock AppInfo into a typed ServerInfo", async () => {
    server.onRequest = (req, socket) => {
      if (req.getInfo) {
        server.send(socket, {
          response: {
            seq: req.seq,
            info: {
              name: "Test Server",
              headerImage: "",
              url: "",
              map: "Procedural Map",
              mapSize: 4000,
              wipeTime: 1700000000,
              players: 42,
              maxPlayers: 200,
              queuedPlayers: 3,
            },
          },
        });
      }
    };

    const client = makeClient(server.port);
    await client.connect();
    const info = await client.getInfo();
    expect(info.name).toBe("Test Server");
    expect(info.players).toBe(42);
    expect(info.maxPlayers).toBe(200);
    expect(info.map).toBe("Procedural Map");
    await client.disconnect();
  });

  it("setEntityValue resolves on AppSuccess", async () => {
    server.onRequest = (req, socket) => {
      if (req.setEntityValue) {
        expect(req.entityId.toString()).toBe("555");
        expect(req.setEntityValue.value).toBe(true);
        server.send(socket, {
          response: { seq: req.seq, success: {} },
        });
      }
    };
    const client = makeClient(server.port);
    await client.connect();
    await expect(client.setEntityValue(555, true)).resolves.toBeUndefined();
    await client.disconnect();
  });

  it("getEntityInfo flattens payload and tracks the entity", async () => {
    server.onRequest = (req, socket) => {
      if (req.getEntityInfo) {
        server.send(socket, {
          response: {
            seq: req.seq,
            entityInfo: { type: 1, payload: { value: true } },
          },
        });
      }
    };
    const client = makeClient(server.port);
    await client.connect();
    const info = await client.getEntityInfo(999);
    expect(info.entityId).toBe(999);
    expect(info.type).toBe("switch");
    expect(info.value).toBe(true);
    expect(client.tracked).toContain(999);
    await client.disconnect();
  });

  it("surfaces an AuthError when the server rejects the credentials (not_found on getInfo)", async () => {
    server.onRequest = (req, socket) => {
      server.send(socket, {
        response: { seq: req.seq, error: { error: "not_found" } },
      });
    };
    const client = makeClient(server.port);
    await client.connect();
    await expect(client.getInfo()).rejects.toBeInstanceOf(AuthError);
    await client.disconnect();
  });

  it("surfaces an EntityNotFoundError when the server returns not_found but accepts the credentials", async () => {
    server.onRequest = (req, socket) => {
      if (req.getTime) {
        server.send(socket, {
          response: {
            seq: req.seq,
            time: { dayLengthMinutes: 60, timeScale: 1, sunrise: 6, sunset: 18, time: 12 },
          },
        });
        return;
      }
      server.send(socket, {
        response: { seq: req.seq, error: { error: "not_found" } },
      });
    };
    const client = makeClient(server.port);
    await client.connect();
    const err = await client.getEntityInfo(999).catch((e) => e);
    expect(err).toBeInstanceOf(EntityNotFoundError);
    // A missing entity is contextual, not a credential failure → not an AuthError.
    expect(err).not.toBeInstanceOf(AuthError);
    await client.disconnect();
  });
});

describe("RustPlusClient — broadcast decoding", () => {
  let server: MockServer;
  beforeEach(async () => {
    server = await MockServer.start();
  });
  afterEach(async () => {
    await server.close();
  });

  it("emits entityChanged with the flattened shape", async () => {
    const client = makeClient(server.port);
    await client.connect();
    const changed = new Promise((resolve) => client.once("entityChanged", resolve));
    server.broadcast({
      broadcast: {
        entityChanged: { entityId: Long.fromNumber(42, true), payload: { value: false } },
      },
    });
    const change = (await changed) as { entityId: number; value: boolean };
    expect(change.entityId).toBe(42);
    expect(change.value).toBe(false);
    await client.disconnect();
  });

  it("emits teamChat for a new team message broadcast", async () => {
    const client = makeClient(server.port);
    await client.connect();
    const msg = new Promise((resolve) => client.once("teamChat", resolve));
    server.broadcast({
      broadcast: {
        teamMessage: {
          message: {
            steamId: Long.fromString("76561190000000001", true),
            name: "Alice",
            message: "hello team",
            color: "#ffffff",
            time: 1700000123,
          },
        },
      },
    });
    const chat = (await msg) as {
      steamId: string;
      name: string;
      message: string;
    };
    expect(chat.name).toBe("Alice");
    expect(chat.message).toBe("hello team");
    expect(chat.steamId).toBe("76561190000000001");
    await client.disconnect();
  });

  it("emits the raw 'message' event for every broadcast", async () => {
    const client = makeClient(server.port);
    await client.connect();
    const raw = new Promise((resolve) => client.once("message", resolve));
    server.broadcast({
      broadcast: {
        entityChanged: { entityId: Long.fromNumber(7, true), payload: { value: true } },
      },
    });
    const m = (await raw) as rustplus.AppMessage;
    expect(m.broadcast?.entityChanged?.entityId?.toString()).toBe("7");
    await client.disconnect();
  });
});

describe("TokenBucket — rate limiting with fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues requests beyond capacity and completes them in order as it refills", async () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
    const order: number[] = [];
    const N = 6;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(bucket.acquire(1).then(() => void order.push(i)));
    }
    // First 3 are immediately satisfiable.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([0, 1, 2]);

    // Each subsequent second refills exactly one token → one more completes.
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([0, 1, 2, 3]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);

    await Promise.all(promises);
    // None dropped.
    expect(order).toHaveLength(N);
  });

  it("preserves FIFO ordering even for mixed costs", async () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 });
    const order: string[] = [];
    const a = bucket.acquire(2).then(() => order.push("a")); // consumes all
    const b = bucket.acquire(1).then(() => order.push("b")); // queues
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(["a", "b"]);
    await Promise.all([a, b]);
  });
});

describe("RustPlusClient — rate limiter queues real requests", () => {
  let server: MockServer;
  beforeEach(async () => {
    server = await MockServer.start();
  });
  afterEach(async () => {
    await server.close();
  });

  it("does not drop requests when the bucket is exhausted", async () => {
    let answered = 0;
    server.onRequest = (req, socket) => {
      if (req.getInfo) {
        answered++;
        server.send(socket, {
          response: {
            seq: req.seq,
            info: {
              name: "S",
              headerImage: "",
              url: "",
              map: "m",
              mapSize: 1,
              wipeTime: 1,
              players: 1,
              maxPlayers: 1,
              queuedPlayers: 0,
            },
          },
        });
      }
    };
    const client = makeClient(server.port, {
      rateLimit: { capacity: 2, refillPerSecond: 50 },
      requestTimeoutMs: 5000,
    });
    await client.connect();
    const results = await Promise.all([
      client.getInfo(),
      client.getInfo(),
      client.getInfo(),
      client.getInfo(),
    ]);
    expect(results).toHaveLength(4);
    expect(answered).toBe(4);
    await client.disconnect();
  });
});

describe("RustPlusClient — reconnect & re-subscribe", () => {
  let server: MockServer;
  beforeEach(async () => {
    server = await MockServer.start();
  });
  afterEach(async () => {
    await server.close();
  });

  it("reconnects after a drop and re-issues getEntityInfo for tracked entities", async () => {
    const entityInfoReqs: number[] = [];
    server.onRequest = (req, socket) => {
      if (req.getEntityInfo) {
        entityInfoReqs.push(Number(req.entityId.toString()));
        server.send(socket, {
          response: {
            seq: req.seq,
            entityInfo: { type: 1, payload: { value: true } },
          },
        });
      }
    };

    const client = makeClient(server.port, {
      reconnect: { initialDelayMs: 20, maxDelayMs: 50, jitter: 0 },
    });
    await client.connect();
    await client.getEntityInfo(111);
    await client.getEntityInfo(222);
    expect(entityInfoReqs).toEqual([111, 222]);

    const reconnected = new Promise<void>((resolve) => client.once("connected", () => resolve()));
    // Simulate a network drop (not a manual disconnect).
    server.dropConnections();
    await reconnected;

    // Allow re-subscription requests to flow.
    await vi.waitFor(
      () => {
        expect(entityInfoReqs).toContain(111);
        expect(entityInfoReqs.filter((e) => e === 111).length).toBe(2);
        expect(entityInfoReqs.filter((e) => e === 222).length).toBe(2);
      },
      { timeout: 3000 },
    );

    await client.disconnect();
  });

  it("does not retry forever and surfaces an error when maxRetries is hit", async () => {
    // Point the client at a dead port so connect fails, with a tiny retry cap.
    const deadPort = server.port;
    await server.close();

    const client = new RustPlusClient({
      ip: "127.0.0.1",
      port: deadPort,
      playerId: "1",
      playerToken: "1",
      reconnect: {
        initialDelayMs: 5,
        maxDelayMs: 10,
        jitter: 0,
        maxRetries: 2,
      },
    });

    // Initial connect rejects.
    await expect(client.connect()).rejects.toBeTruthy();
    await client.disconnect();
  });
});

describe("RustPlusClient — auth failure does not blind-retry", () => {
  let server: MockServer;
  beforeEach(async () => {
    server = await MockServer.start();
  });
  afterEach(async () => {
    await server.close();
  });

  it("surfaces AuthError to the caller without entering an infinite loop", async () => {
    server.onRequest = (req, socket) => {
      server.send(socket, {
        response: { seq: req.seq, error: { error: "banned" } },
      });
    };
    const client = makeClient(server.port);
    await client.connect();
    const err = await client.getInfo().catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    // The connection is still alive (auth error on a request ≠ socket drop).
    expect(client.connected).toBe(true);
    await client.disconnect();
  });

  it("captureCameraFrame subscribes, renders accumulated rays, and unsubscribes", async () => {
    server.onRequest = (req, socket) => {
      if (req.cameraSubscribe) {
        server.send(socket, {
          response: { seq: req.seq, cameraSubscribeInfo: { width: 8, height: 8 } },
        });
      } else if (req.cameraUnsubscribe) {
        server.send(socket, { response: { seq: req.seq, success: {} } });
      }
    };
    const client = makeClient(server.port);
    await client.connect();

    const framePromise = client.captureCameraFrame("CAM1");
    // Stream more than the accumulation threshold so it resolves early.
    await vi.waitFor(() => expect(server.received.some((r) => r.cameraSubscribe)).toBe(true));
    for (let i = 0; i < 16; i++) {
      server.broadcast({
        broadcast: { cameraRays: { sampleOffset: i, rayData: new Uint8Array([255, 255, 192, 0]) } },
      });
    }

    const png = await framePromise;
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await vi.waitFor(() => expect(server.received.some((r) => r.cameraUnsubscribe)).toBe(true));
    await client.disconnect();
  });

  it("captureCameraFrame rejects when the subscribe response lacks camera info", async () => {
    server.onRequest = (req, socket) => {
      if (req.cameraSubscribe) {
        server.send(socket, { response: { seq: req.seq, success: {} } });
      } else if (req.cameraUnsubscribe) {
        server.send(socket, { response: { seq: req.seq, success: {} } });
      }
    };
    const client = makeClient(server.port);
    await client.connect();
    const capture = client.captureCameraFrame("CAM1");
    await expect(capture).rejects.toThrow(/cameraSubscribeInfo/i);
    await expect(capture).rejects.toMatchObject({
      name: "CameraUnavailableError",
      reason: "notFound",
    });
    await vi.waitFor(() => expect(server.received.some((r) => r.cameraUnsubscribe)).toBe(true));
    await client.disconnect();
  });

  it("captureCameraFrame rejects when no rays arrive before the timeout", async () => {
    server.onRequest = (req, socket) => {
      if (req.cameraSubscribe) {
        server.send(socket, {
          response: { seq: req.seq, cameraSubscribeInfo: { width: 8, height: 8 } },
        });
      } else if (req.cameraUnsubscribe) {
        server.send(socket, { response: { seq: req.seq, success: {} } });
      }
    };
    const client = makeClient(server.port, { cameraCaptureTimeoutMs: 100 });
    await client.connect();
    const capture = client.captureCameraFrame("CAM1");
    await expect(capture).rejects.toThrow(/no cameraRays before timeout/i);
    await expect(capture).rejects.toMatchObject({
      name: "CameraUnavailableError",
      reason: "noFrames",
    });
    await client.disconnect();
  });

  it("captureCameraFrame renders a partial frame when only some rays arrive", async () => {
    server.onRequest = (req, socket) => {
      if (req.cameraSubscribe) {
        server.send(socket, {
          response: { seq: req.seq, cameraSubscribeInfo: { width: 8, height: 8 } },
        });
      } else if (req.cameraUnsubscribe) {
        server.send(socket, { response: { seq: req.seq, success: {} } });
      }
    };
    const client = makeClient(server.port, { cameraCaptureTimeoutMs: 150 });
    await client.connect();
    const framePromise = client.captureCameraFrame("CAM1");
    await vi.waitFor(() => expect(server.received.some((r) => r.cameraSubscribe)).toBe(true));
    server.broadcast({
      broadcast: { cameraRays: { sampleOffset: 0, rayData: new Uint8Array([255, 255, 192, 0]) } },
    });
    const png = await framePromise; // timer fires with one frame → still renders
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await client.disconnect();
  });

  it("getCameraFrame delegates to captureCameraFrame (ignoring the frame index)", async () => {
    server.onRequest = (req, socket) => {
      if (req.cameraSubscribe) {
        server.send(socket, {
          response: { seq: req.seq, cameraSubscribeInfo: { width: 8, height: 8 } },
        });
      } else if (req.cameraUnsubscribe) {
        server.send(socket, { response: { seq: req.seq, success: {} } });
      }
    };
    const client = makeClient(server.port);
    await client.connect();
    const framePromise = client.getCameraFrame("CAM1", 0);
    await vi.waitFor(() => expect(server.received.some((r) => r.cameraSubscribe)).toBe(true));
    for (let i = 0; i < 16; i++) {
      server.broadcast({
        broadcast: { cameraRays: { sampleOffset: i, rayData: new Uint8Array([255, 255, 192, 0]) } },
      });
    }
    const png = await framePromise;
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await client.disconnect();
  });
});
