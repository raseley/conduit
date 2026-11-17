import { describe, it, expect, vi } from "vitest";

import { createPushoverNotifier, PushoverError, PUSHOVER_MESSAGES_URL } from "./pushover.js";

describe("createPushoverNotifier", () => {
  it("POSTs a form-encoded message to the Pushover API", async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    const notify = createPushoverNotifier(fetchFn as unknown as typeof fetch);

    await notify({
      appToken: "app-tok",
      userKey: "user-key",
      title: "🚨 Front door",
      message: "Front door triggered on My Server.",
      priority: 1,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(PUSHOVER_MESSAGES_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(init.body as string);
    expect(params.get("token")).toBe("app-tok");
    expect(params.get("user")).toBe("user-key");
    expect(params.get("priority")).toBe("1");
    expect(params.get("title")).toBe("🚨 Front door");
    expect(params.get("message")).toBe("Front door triggered on My Server.");
  });

  it("throws PushoverError on a non-2xx response", async () => {
    const fetchFn = vi.fn(async () => new Response("bad token", { status: 400 }));
    const notify = createPushoverNotifier(fetchFn as unknown as typeof fetch);
    await expect(
      notify({ appToken: "x", userKey: "y", title: "t", message: "m", priority: 0 }),
    ).rejects.toBeInstanceOf(PushoverError);
  });

  it("wraps a network failure in PushoverError", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const notify = createPushoverNotifier(fetchFn as unknown as typeof fetch);
    await expect(
      notify({ appToken: "x", userKey: "y", title: "t", message: "m", priority: 0 }),
    ).rejects.toBeInstanceOf(PushoverError);
  });
});
