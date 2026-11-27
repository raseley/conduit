import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionError, ProtocolError } from "../errors.js";
import {
  CHECKIN_TIMEOUT_MS,
  CHECKIN_URL,
  checkIn,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
} from "./checkin.js";
import { CHECKIN_REQUESTS, CHECKIN_RESPONSES } from "./fixtures/checkin.js";
import type { HttpsRequest, HttpsRequestInit, HttpsResponse } from "./http.js";
import type { PushIdentity } from "./identity.js";

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? []).toString("hex");

/** Pinned here so the request fixtures stay valid whichever profile ships. */
const PINNED_LEGACY: PushIdentity = {
  name: "legacy",
  checkin: { deviceType: 3, chromePlatform: 2, chromeVersion: "63.0.3234.0", chromeChannel: 1 },
  login: { id: "chrome-63.0.3234.0", networkType: 1 },
};

function response(overrides: Partial<HttpsResponse> = {}): HttpsResponse {
  return {
    status: 200,
    headers: {},
    body: fromHex(CHECKIN_RESPONSES.ordinary.hex),
    ...overrides,
  };
}

/** A fake seam that records each request and answers with `reply`. */
function fakeHttps(reply: (req: HttpsRequestInit) => Promise<HttpsResponse>) {
  const requests: HttpsRequestInit[] = [];
  const httpsRequest: HttpsRequest = (req) => {
    requests.push(req);
    return reply(req);
  };
  return { httpsRequest, requests };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("checkIn", () => {
  it("first run: POSTs push-receiver's exact request and returns the minted device", async () => {
    const { httpsRequest, requests } = fakeHttps(async () => response());
    const device = await checkIn({ httpsRequest, identity: PINNED_LEGACY });
    expect(device).toEqual(CHECKIN_REQUESTS.fresh.decoded);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: CHECKIN_URL,
      headers: { "Content-Type": "application/x-protobuf" },
    });
    expect(Object.keys(requests[0]!.headers)).toEqual(["Content-Type"]);
    expect(toHex(requests[0]!.body)).toBe(CHECKIN_REQUESTS.fresh.bodyHex);
    expect(new URL(CHECKIN_URL).pathname).toBe(CHECKIN_REQUESTS.fresh.path);
  });

  it("re-check-in: sends the stored ids, including ones at and above 2^63", async () => {
    for (const fixture of [CHECKIN_REQUESTS.existing, CHECKIN_REQUESTS.highIds]) {
      const { httpsRequest, requests } = fakeHttps(async () =>
        response({ body: fromHex(CHECKIN_RESPONSES[fixture.reply].hex) }),
      );
      const device = await checkIn({
        httpsRequest,
        identity: PINNED_LEGACY,
        androidId: fixture.androidId!,
        securityToken: fixture.securityToken!,
      });
      expect(toHex(requests[0]!.body)).toBe(fixture.bodyHex);
      expect(device).toEqual(fixture.decoded);
    }
  });

  it("defaults to the shipped identity", async () => {
    const { httpsRequest, requests } = fakeHttps(async () => response());
    await checkIn({ httpsRequest });
    expect(Buffer.from(requests[0]!.body!).includes("63.0.3234.0")).toBe(true);
  });

  it.each([400, 401])("HTTP %i means Google rejected the credentials", async (status) => {
    const { httpsRequest } = fakeHttps(async () => response({ status, body: new Uint8Array() }));
    const err = await checkIn({ httpsRequest }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err).toMatchObject({ failure: "credentials", retryAfterMs: undefined });
    expect((err as Error).message).toContain(String(status));
  });

  it.each([403, 404, 500, 502])("HTTP %i is refused, with no retry delay", async (status) => {
    const { httpsRequest } = fakeHttps(async () =>
      response({ status, headers: { "retry-after": "30" }, body: new Uint8Array() }),
    );
    await expect(checkIn({ httpsRequest })).rejects.toMatchObject({
      name: "ConnectionError",
      failure: "refused",
      retryAfterMs: undefined,
    });
  });

  it("HTTP 429 carries Retry-After in ms", async () => {
    const { httpsRequest } = fakeHttps(async () =>
      response({ status: 429, headers: { "retry-after": "120" }, body: new Uint8Array() }),
    );
    await expect(checkIn({ httpsRequest })).rejects.toMatchObject({
      failure: "refused",
      retryAfterMs: 120_000,
    });
  });

  it("HTTP 503 reads an HTTP-date Retry-After against the injected clock, capped at an hour", async () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    const soon = fakeHttps(async () =>
      response({
        status: 503,
        headers: { "retry-after": "Fri, 27 Nov 2026 12:00:45 GMT" },
        body: new Uint8Array(),
      }),
    );
    await expect(
      checkIn({ httpsRequest: soon.httpsRequest, now: () => now }),
    ).rejects.toMatchObject({ failure: "refused", retryAfterMs: 45_000 });

    const far = fakeHttps(async () =>
      response({ status: 503, headers: { "retry-after": "86400" }, body: new Uint8Array() }),
    );
    await expect(checkIn({ httpsRequest: far.httpsRequest })).rejects.toMatchObject({
      retryAfterMs: MAX_RETRY_AFTER_MS,
    });
  });

  it("a 200 that does not decode is refused, with the ProtocolError as cause", async () => {
    const { httpsRequest } = fakeHttps(async () => response({ body: fromHex("0801") }));
    const err = await checkIn({ httpsRequest }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ConnectionError", failure: "refused" });
    expect((err as Error).cause).toBeInstanceOf(ProtocolError);
  });

  it("a transport failure is a network failure", async () => {
    const { httpsRequest } = fakeHttps(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    await expect(checkIn({ httpsRequest })).rejects.toMatchObject({
      name: "ConnectionError",
      failure: "network",
    });
  });

  it("keeps the seam's own failure kind", async () => {
    const { httpsRequest } = fakeHttps(async () => {
      throw new ConnectionError("too big", { failure: "refused" });
    });
    await expect(checkIn({ httpsRequest })).rejects.toMatchObject({ failure: "refused" });
  });

  it("gives up after 15 s with no response, even if the seam ignores its signal", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    const { httpsRequest } = fakeHttps((req) => {
      seenSignal = req.signal;
      return new Promise<never>(() => {});
    });
    const pending = checkIn({ httpsRequest });
    const outcome = expect(pending).rejects.toMatchObject({
      name: "ConnectionError",
      failure: "network",
    });
    await vi.advanceTimersByTimeAsync(CHECKIN_TIMEOUT_MS - 1);
    expect(seenSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(seenSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/15000 ms/);
  });

  it("stops at once when the caller aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { httpsRequest } = fakeHttps(() => new Promise<never>(() => {}));
    const pending = checkIn({ httpsRequest, signal: controller.signal });
    const outcome = expect(pending).rejects.toThrow(/cancelled/);
    controller.abort();
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { httpsRequest, requests } = fakeHttps(async () => response());
    await expect(checkIn({ httpsRequest, signal: controller.signal })).rejects.toMatchObject({
      failure: "network",
    });
    expect(requests).toHaveLength(0);
  });

  it("clears its timer after a reply", async () => {
    vi.useFakeTimers();
    const { httpsRequest } = fakeHttps(async () => response());
    await checkIn({ httpsRequest });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects half a credential pair, or malformed ids, without sending", async () => {
    const { httpsRequest, requests } = fakeHttps(async () => response());
    await expect(checkIn({ httpsRequest, androidId: "1" })).rejects.toMatchObject({
      failure: "credentials",
    });
    await expect(
      checkIn({ httpsRequest, androidId: "not-a-number", securityToken: "2" }),
    ).rejects.toMatchObject({ failure: "credentials" });
    expect(requests).toHaveLength(0);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");

  it.each([
    [undefined, undefined],
    ["0", 0],
    [" 7 ", 7_000],
    ["3600", MAX_RETRY_AFTER_MS],
    ["3601", MAX_RETRY_AFTER_MS],
    ["Fri, 27 Nov 2026 12:01:00 GMT", 60_000],
    ["Fri, 27 Nov 2026 11:00:00 GMT", 0],
    ["-5", undefined],
    ["soon", undefined],
  ])("%j gives %j", (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});
