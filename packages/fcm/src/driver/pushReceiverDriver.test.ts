import { describe, it, expect, vi } from "vitest";

import { createPushReceiverDriver, type AndroidFcmConfig } from "./pushReceiverDriver.js";
import type { RawPush } from "./pushReceiverDriver.js";

const config: AndroidFcmConfig = {
  apiKey: "api-key",
  projectId: "rust-companion-app",
  gcmSenderId: "976529667804",
  gmsAppId: "1:976529667804:android:deadbeef",
  androidPackageName: "com.facepunch.rust.companion",
  androidPackageCert: "CERT",
};

/** A fake upstream module: records register args, captures the Client's handler. */
function makeFakeModule() {
  let handler: ((stanza: unknown) => void) | undefined;
  const destroy = vi.fn();
  const connect = vi.fn(async () => {});
  const registerArgs: unknown[] = [];

  class FakeClient {
    constructor(
      readonly androidId: string | number,
      readonly securityToken: string | number,
      readonly persistentIds: string[],
    ) {}
    on(event: string, cb: (stanza: unknown) => void): void {
      // Only the data handler drives the assertions; lifecycle ("connect"/
      // "disconnect") subscriptions are accepted and ignored.
      if (event === "ON_DATA_RECEIVED") handler = cb;
    }
    connect = connect;
    destroy = destroy;
  }

  const mod = {
    AndroidFCM: {
      register: vi.fn(async (...args: unknown[]) => {
        registerArgs.push(...args);
        return {
          gcm: { androidId: "android-1", securityToken: "sec-1" },
          fcm: { token: "fcm-token-1" },
        };
      }),
    },
    Client: FakeClient,
  };

  return {
    load: () => mod as never,
    emit: (stanza: unknown) => handler?.(stanza),
    destroy,
    connect,
    registerArgs,
  };
}

describe("createPushReceiverDriver.register", () => {
  it("calls AndroidFCM.register with the config in order and maps the result", async () => {
    const fake = makeFakeModule();
    const driver = createPushReceiverDriver(fake.load);

    const raw = await driver.register(config);

    expect(fake.registerArgs).toEqual([
      config.apiKey,
      config.projectId,
      config.gcmSenderId,
      config.gmsAppId,
      config.androidPackageName,
      config.androidPackageCert,
    ]);
    expect(raw).toEqual({
      fcm: { token: "fcm-token-1" },
      gcm: { androidId: "android-1", securityToken: "sec-1" },
    });
  });

  it("wraps an upstream registration failure in a ConnectionError", async () => {
    const driver = createPushReceiverDriver(
      () =>
        ({
          AndroidFCM: {
            register: async () => {
              throw new Error("interior hyphen");
            },
          },
          Client: class {},
        }) as never,
    );

    await expect(driver.register(config)).rejects.toMatchObject({
      message: "FCM/GCM device registration failed",
    });
  });
});

describe("createPushReceiverDriver.listen", () => {
  const creds = {
    fcm: { token: "fcm-token-1" },
    gcm: { androidId: "android-1", securityToken: "sec-1" },
  };

  it("folds a DataMessageStanza app_data list into a { data: { body } } envelope", async () => {
    const fake = makeFakeModule();
    const driver = createPushReceiverDriver(fake.load);
    const pushes: RawPush[] = [];

    await driver.listen(creds, [], (p) => pushes.push(p));

    fake.emit({
      persistentId: "p1",
      appData: [
        { key: "body", value: '{"type":"server"}' },
        { key: "from", value: "sender" },
      ],
    });

    expect(pushes).toEqual([
      {
        persistentId: "p1",
        notification: { data: { body: '{"type":"server"}', from: "sender" } },
      },
    ]);
  });

  it("logs raw push arrivals with the app_data key names but not their values", async () => {
    const fake = makeFakeModule();
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const driver = createPushReceiverDriver(fake.load, log);

    await driver.listen(creds, [], () => {});
    fake.emit({
      persistentId: "p1",
      appData: [
        { key: "body", value: '{"type":"server","playerToken":"SECRET"}' },
        { key: "from", value: "sender" },
      ],
    });

    expect(log.info).toHaveBeenCalledWith(
      { persistentId: "p1", appDataKeys: ["body", "from"] },
      "fcm: raw push received",
    );
    // The sensitive body value must never reach the log payload.
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain("SECRET");
  });

  it("suppresses replays of already-seen persistentIds", async () => {
    const fake = makeFakeModule();
    const driver = createPushReceiverDriver(fake.load);
    const pushes: RawPush[] = [];

    await driver.listen(creds, ["seen-1"], (p) => pushes.push(p));

    fake.emit({ persistentId: "seen-1", appData: [{ key: "body", value: "{}" }] });
    fake.emit({ persistentId: "fresh", appData: [{ key: "body", value: "{}" }] });
    fake.emit({ persistentId: "fresh", appData: [{ key: "body", value: "{}" }] });

    expect(pushes.map((p) => p.persistentId)).toEqual(["fresh"]);
  });

  it("destroy() tears down the underlying client", async () => {
    const fake = makeFakeModule();
    const driver = createPushReceiverDriver(fake.load);

    const conn = await driver.listen(creds, [], () => {});
    conn.destroy();

    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it("throws ConnectionError when the gcm blob lacks auth fields", async () => {
    const fake = makeFakeModule();
    const driver = createPushReceiverDriver(fake.load);

    await expect(driver.listen({ fcm: {}, gcm: {} }, [], () => {})).rejects.toMatchObject({
      message:
        "push-receiver credentials missing androidId/securityToken; cannot open the push connection",
    });
  });
});
