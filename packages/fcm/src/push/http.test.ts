import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { describe, expect, it } from "vitest";

import { ConnectionError } from "../errors.js";
import { CHECKIN_REQUESTS } from "./fixtures/checkin.js";
import { createNodeHttpsRequest, type NodeRequestFn } from "./http.js";

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

const checkinBody = new Uint8Array(Buffer.from(CHECKIN_REQUESTS.existing.bodyHex, "hex"));

describe("createNodeHttpsRequest", () => {
  it("sends exactly push-receiver's check-in headers, in its order and spelling", async () => {
    const { request, calls } = fakeNodeRequest();
    const pending = createNodeHttpsRequest({ request })({
      method: "POST",
      url: "https://android.clients.google.com/checkin",
      headers: { "Content-Type": "application/x-protobuf" },
      body: checkinBody,
    });
    const [call] = calls;
    // Node itself appends `Connection` (keep-alive with the default agent, as
    // it did for push-receiver), so the captured list minus that one is what
    // this module must hand Node.
    const captured = CHECKIN_REQUESTS.existing.headers.filter(
      ([name]) => name.toLowerCase() !== "connection",
    );
    expect(Object.entries(call!.options.headers ?? {})).toEqual(captured);
    expect(CHECKIN_REQUESTS.existing.headers.at(-1)).toEqual(["Connection", "keep-alive"]);
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

  it("drops a caller's own host, content-length and connection headers", async () => {
    const { request, calls } = fakeNodeRequest();
    void createNodeHttpsRequest({ request })({
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

  it("sends no content-length without a body", async () => {
    const { request, calls } = fakeNodeRequest();
    void createNodeHttpsRequest({ request })({
      method: "GET",
      url: "https://example.test/",
      headers: {},
    });
    expect(calls[0]!.options.headers).toEqual({ host: "example.test" });
    expect(calls[0]!.req.body).toBeUndefined();
  });

  it("joins repeated response headers", async () => {
    const { request, calls } = fakeNodeRequest();
    const pending = createNodeHttpsRequest({ request })({
      method: "GET",
      url: "https://example.test/",
      headers: {},
    });
    calls[0]!.respond(503, { "retry-after": "5", "x-multi": ["a", "b"] }, []);
    await expect(pending).resolves.toMatchObject({
      status: 503,
      headers: { "retry-after": "5", "x-multi": "a, b" },
    });
  });

  it("rejects with a network ConnectionError when no response arrives", async () => {
    const { request, calls } = fakeNodeRequest();
    const pending = createNodeHttpsRequest({ request })({
      method: "POST",
      url: "https://example.test/",
      headers: {},
      body: new Uint8Array(1),
    });
    calls[0]!.req.emit("error", new Error("ECONNREFUSED"));
    await expect(pending).rejects.toMatchObject({ name: "ConnectionError", failure: "network" });
  });

  it("rejects when the response is cut off mid-body", async () => {
    const { request, calls } = fakeNodeRequest();
    const pending = createNodeHttpsRequest({ request })({
      method: "GET",
      url: "https://example.test/",
      headers: {},
    });
    const res = calls[0]!.start(200, {});
    res.emit("data", Buffer.from("partial"));
    res.emit("close");
    await expect(pending).rejects.toMatchObject({ name: "ConnectionError", failure: "network" });
  });

  it("refuses a response over the size cap and stops reading", async () => {
    const { request, calls } = fakeNodeRequest();
    const pending = createNodeHttpsRequest({ request, maxResponseBytes: 4 })({
      method: "GET",
      url: "https://example.test/",
      headers: {},
    });
    calls[0]!.respond(200, {}, ["abc", "def"]);
    await expect(pending).rejects.toMatchObject({ name: "ConnectionError", failure: "refused" });
    expect(calls[0]!.req.destroyed).toBe(true);
  });

  it("rejects an already-aborted signal without sending", async () => {
    const { request, calls } = fakeNodeRequest();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createNodeHttpsRequest({ request })({
        method: "GET",
        url: "https://example.test/",
        headers: {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ failure: "network" });
    expect(calls).toHaveLength(0);
  });

  it("passes the caller's signal to Node", async () => {
    const { request, calls } = fakeNodeRequest();
    const controller = new AbortController();
    void createNodeHttpsRequest({ request })({
      method: "GET",
      url: "https://example.test/",
      headers: {},
      signal: controller.signal,
    });
    expect(calls[0]!.options.signal).toBe(controller.signal);
  });

  it("only speaks https", async () => {
    const { request, calls } = fakeNodeRequest();
    await expect(
      createNodeHttpsRequest({ request })({
        method: "GET",
        url: "http://example.test/",
        headers: {},
      }),
    ).rejects.toBeInstanceOf(ConnectionError);
    expect(calls).toHaveLength(0);
  });
});
