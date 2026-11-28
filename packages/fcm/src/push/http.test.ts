import { EventEmitter } from "node:events";
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import net, { type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { ConnectionError } from "../errors.js";
import { checkIn } from "./checkin.js";
import { CHECKIN_REQUESTS, CHECKIN_RESPONSES } from "./fixtures/checkin.js";
import {
  createNodeHttpsRequest,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type HttpsRequest,
  type NodeRequestFn,
} from "./http.js";
import type { TimerProvider } from "./timers.js";

/** Stands in for Node's ClientRequest: records what would be written. */
class FakeClientRequest extends EventEmitter {
  body: Buffer | undefined;
  ended = false;
  destroyed = false;

  end(body?: Buffer): void {
    this.body = body;
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/** Stands in for Node's IncomingMessage. */
class FakeResponse extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string | string[]>,
  ) {
    super();
  }
}

/** A fake `https.request` that captures each call for the test to answer. */
function fakeNodeRequest() {
  const calls: {
    options: RequestOptions;
    req: FakeClientRequest;
    /** Begin a response; the test emits its events. */
    start: (status: number, headers: Record<string, string | string[]>) => FakeResponse;
    /** A complete response: the chunks, then end and close. */
    respond: (status: number, headers: Record<string, string | string[]>, body: string[]) => void;
  }[] = [];
  const request: NodeRequestFn = (options, callback) => {
    const req = new FakeClientRequest();
    const start = (status: number, headers: Record<string, string | string[]>) => {
      const res = new FakeResponse(status, headers);
      callback(res as unknown as IncomingMessage);
      return res;
    };
    calls.push({
      options,
      req,
      start,
      respond: (status, headers, body) => {
        const res = start(status, headers);
        for (const chunk of body) res.emit("data", Buffer.from(chunk));
        res.emit("end");
        res.emit("close");
      },
    });
    return req as unknown as ClientRequest;
  };
  return { request, calls };
}

/** A hand-driven TimerProvider. */
function fakeTimers() {
  const pending = new Map<number, { cb: () => void; ms: number }>();
  let next = 0;
  const timers: TimerProvider = {
    setTimer: (cb, ms) => {
      pending.set(++next, { cb, ms });
      return next;
    },
    clearTimer: (handle) => {
      pending.delete(handle as number);
    },
  };
  const fireAll = (): void => {
    for (const [id, timer] of [...pending]) {
      pending.delete(id);
      timer.cb();
    }
  };
  return { timers, pending, fireAll };
}

/** The seam over the fake transport, with fake timers so nothing real waits. */
function fakeSeam(deps: { maxResponseBytes?: number } = {}) {
  const { request, calls } = fakeNodeRequest();
  const clock = fakeTimers();
  const send = createNodeHttpsRequest({ request, timers: clock.timers, ...deps });
  return { send, calls, clock };
}

const checkinBody = new Uint8Array(Buffer.from(CHECKIN_REQUESTS.existing.bodyHex, "hex"));

describe("createNodeHttpsRequest", () => {
  it("hands Node exactly push-receiver's check-in headers, in its order and spelling", async () => {
    const { send, calls } = fakeSeam();
    const pending = send({
      method: "POST",
      url: "https://android.clients.google.com/checkin",
      headers: { "Content-Type": "application/x-protobuf" },
      body: checkinBody,
    });
    const [call] = calls;
    // Node itself appends `Connection` (keep-alive with the default agent, as
    // it did for push-receiver; the loopback test below checks the wire), so
    // the captured list minus that one is what this module hands Node.
    const captured = CHECKIN_REQUESTS.existing.headers.filter(
      ([name]) => name.toLowerCase() !== "connection",
    );
    expect(Object.entries(call!.options.headers ?? {})).toEqual(captured);
    // No agent override: Node's default https agent, as push-receiver's
    // `request` used.
    expect(call!.options.agent).toBeUndefined();
    expect(call!.options).toMatchObject({
      method: "POST",
      protocol: "https:",
      hostname: "android.clients.google.com",
      port: 443,
      path: CHECKIN_REQUESTS.existing.path,
    });
    expect(call!.req.body?.toString("hex")).toBe(CHECKIN_REQUESTS.existing.bodyHex);

    call!.respond(200, { "content-type": "application/x-protobuf" }, ["ab", "cd"]);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ "content-type": "application/x-protobuf" });
    expect(Buffer.from(res.body).toString()).toBe("abcd");
  });

  it("drops a caller's own host, content-length and connection headers", () => {
    const { send, calls } = fakeSeam();
    void send({
      method: "POST",
      url: "https://example.test:8443/p?q=1",
      headers: { Host: "evil", "Content-Length": "999", Connection: "close", "X-Kept": "1" },
      body: new Uint8Array(3),
    });
    expect(calls[0]!.options.headers).toEqual({
      "X-Kept": "1",
      host: "example.test:8443",
      "content-length": "3",
    });
    expect(calls[0]!.options).toMatchObject({ port: 8443, path: "/p?q=1" });
  });

  it("sends no content-length on a GET", () => {
    const { send, calls } = fakeSeam();
    void send({ method: "GET", url: "https://example.test/", headers: {} });
    expect(calls[0]!.options.headers).toEqual({ host: "example.test" });
    expect(calls[0]!.req.body).toBeUndefined();
  });

  it("refuses a POST without a body rather than send different headers from request", async () => {
    const { send, calls } = fakeSeam();
    const err = await send({ method: "POST", url: "https://example.test/", headers: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).failure).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("joins repeated response headers", async () => {
    const { send, calls } = fakeSeam();
    const pending = send({ method: "GET", url: "https://example.test/", headers: {} });
    calls[0]!.respond(503, { "retry-after": "5", "x-multi": ["a", "b"] }, []);
    await expect(pending).resolves.toMatchObject({
      status: 503,
      headers: { "retry-after": "5", "x-multi": "a, b" },
    });
  });

  it("no response is a network failure", async () => {
    const { send, calls } = fakeSeam();
    const pending = send({
      method: "POST",
      url: "https://example.test/",
      headers: {},
      body: new Uint8Array(1),
    });
    calls[0]!.req.emit("error", new Error("ECONNREFUSED"));
    await expect(pending).rejects.toMatchObject({
      name: "ConnectionError",
      failure: "network",
      message: "Request failed before a response arrived",
    });
  });

  it("a response cut off mid-body is refused: Google had answered", async () => {
    const { send, calls } = fakeSeam();
    const pending = send({ method: "GET", url: "https://example.test/", headers: {} });
    const res = calls[0]!.start(200, {});
    res.emit("data", Buffer.from("partial"));
    res.emit("close");
    await expect(pending).rejects.toMatchObject({
      name: "ConnectionError",
      failure: "refused",
      message: "Response was cut off",
    });
  });

  it("a request error after the headers arrived is a cut-off response too", async () => {
    const { send, calls } = fakeSeam();
    const pending = send({ method: "GET", url: "https://example.test/", headers: {} });
    calls[0]!.start(200, {});
    calls[0]!.req.emit("error", new Error("ECONNRESET"));
    await expect(pending).rejects.toMatchObject({ failure: "refused" });
  });

  it("refuses a response over the size cap and stops reading", async () => {
    const { send, calls } = fakeSeam({ maxResponseBytes: 4 });
    const pending = send({ method: "GET", url: "https://example.test/", headers: {} });
    calls[0]!.respond(200, {}, ["abc", "def"]);
    await expect(pending).rejects.toMatchObject({ name: "ConnectionError", failure: "refused" });
    expect(calls[0]!.req.destroyed).toBe(true);
  });

  it("an already-aborted signal rejects without sending, and is not a failure", async () => {
    const { send, calls } = fakeSeam();
    const controller = new AbortController();
    controller.abort();
    const err = await send({
      method: "GET",
      url: "https://example.test/",
      headers: {},
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).failure).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("an abort after the headers arrived is not a failure either", async () => {
    const { send, calls } = fakeSeam();
    const controller = new AbortController();
    const pending = send({
      method: "GET",
      url: "https://example.test/",
      headers: {},
      signal: controller.signal,
    });
    calls[0]!.start(200, {});
    controller.abort();
    // What Node does on abort: the request errors with an AbortError.
    calls[0]!.req.emit("error", new Error("The operation was aborted"));
    const err = await pending.catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ConnectionError", message: "Request was aborted" });
    expect((err as ConnectionError).failure).toBeUndefined();
  });

  it("passes the caller's signal to Node, and leaves the deadline to the caller", () => {
    const { send, calls, clock } = fakeSeam();
    const controller = new AbortController();
    void send({
      method: "GET",
      url: "https://example.test/",
      headers: {},
      signal: controller.signal,
    });
    expect(calls[0]!.options.signal).toBe(controller.signal);
    expect(clock.pending.size).toBe(0);
  });

  it("without a signal, gives up after its own 15 s timeout", async () => {
    const { send, calls, clock } = fakeSeam();
    const pending = send({ method: "GET", url: "https://example.test/", headers: {} });
    expect([...clock.pending.values()].map((t) => t.ms)).toEqual([DEFAULT_REQUEST_TIMEOUT_MS]);
    clock.fireAll();
    await expect(pending).rejects.toMatchObject({
      name: "ConnectionError",
      failure: "network",
      message: `No response within ${DEFAULT_REQUEST_TIMEOUT_MS} ms`,
    });
    expect(calls[0]!.req.destroyed).toBe(true);
  });

  it("clears its own timer once the response is complete", async () => {
    const { send, calls, clock } = fakeSeam();
    const pending = send({ method: "GET", url: "https://example.test/", headers: {} });
    calls[0]!.respond(200, {}, ["ok"]);
    await pending;
    expect(clock.pending.size).toBe(0);
  });

  it("only speaks https", async () => {
    const { send, calls } = fakeSeam();
    await expect(
      send({ method: "GET", url: "http://example.test/", headers: {} }),
    ).rejects.toBeInstanceOf(ConnectionError);
    expect(calls).toHaveLength(0);
  });
});

/**
 * A local TCP server on 127.0.0.1 that records each raw request and answers
 * with a fixed HTTP response. Nothing leaves the machine.
 */
async function loopbackServer(responseBody: Uint8Array) {
  const requests: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const headEnd = received.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      const head = received.subarray(0, headEnd).toString("latin1");
      const length = Number(/\r\ncontent-length: *([0-9]+)/i.exec(head)?.[1] ?? 0);
      if (received.byteLength < headEnd + 4 + length) return;
      requests.push(received);
      received = Buffer.alloc(0);
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/x-protobuf\r\n` +
          `Content-Length: ${responseBody.byteLength}\r\n\r\n`,
      );
      socket.write(responseBody);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // The module's request options, sent over plain HTTP to the local server.
  // Node's default http agent has the same keep-alive default as its https one.
  const request: NodeRequestFn = (options, callback) =>
    http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", port }, callback);
  return {
    requests,
    httpsRequest: createNodeHttpsRequest({ request }) as HttpsRequest,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Split a raw request into its request line, header lines and body. */
function parseRaw(raw: Buffer): { lines: string[]; body: Buffer } {
  const headEnd = raw.indexOf("\r\n\r\n");
  return {
    lines: raw.subarray(0, headEnd).toString("latin1").split("\r\n"),
    body: raw.subarray(headEnd + 4),
  };
}

describe("what Node actually writes (loopback)", () => {
  it.each(Object.entries(CHECKIN_REQUESTS))(
    "the %s check-in matches push-receiver's raw request line, headers and body",
    async (_name, fixture) => {
      const reply = new Uint8Array(Buffer.from(CHECKIN_RESPONSES[fixture.reply].hex, "hex"));
      const server = await loopbackServer(reply);
      try {
        const device = await checkIn({
          httpsRequest: server.httpsRequest,
          androidId: fixture.androidId ?? undefined,
          securityToken: fixture.securityToken ?? undefined,
        });
        expect(device).toEqual(fixture.decoded);
        expect(server.requests).toHaveLength(1);
        const { lines, body } = parseRaw(server.requests[0]!);
        expect(lines).toEqual([
          `${fixture.method} ${fixture.path} HTTP/1.1`,
          ...fixture.headers.map(([name, value]) => `${name}: ${value}`),
        ]);
        // Spelled out once, so a fixture change cannot hide a header change.
        expect(lines.slice(1).map((line) => line.split(":")[0])).toEqual([
          "Content-Type",
          "host",
          "content-length",
          "Connection",
        ]);
        expect(lines.at(-1)).toBe("Connection: keep-alive");
        expect(body.toString("hex")).toBe(fixture.bodyHex);
      } finally {
        await server.close();
      }
    },
  );

  it.each([
    ["a value with a newline", { "X-Bad": "a\nb" }, "ERR_INVALID_CHAR"],
    ["a name Node will not send", { "Bad Name": "x" }, "ERR_INVALID_HTTP_TOKEN"],
  ])("rejects %s with a typed error, not Node's TypeError", async (_name, headers, code) => {
    const server = await loopbackServer(new Uint8Array());
    try {
      const err = await server
        .httpsRequest({
          method: "POST",
          url: "https://android.clients.google.com/checkin",
          headers,
          body: new Uint8Array(1),
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectionError);
      expect((err as ConnectionError).message).toBe("Request could not be sent");
      expect(((err as ConnectionError).cause as { code?: string }).code).toBe(code);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
