/**
 * THE QUARANTINE FILE.
 *
 * `@liamcottle/push-receiver` is the project's single fragile dependency: it
 * ships no TypeScript types and its small API surface has shifted across
 * versions. This is the ONLY file in the codebase allowed to
 * `import` (well, `require`) it. Everything else in fcm — and the whole app —
 * depends solely on the {@link PushReceiverDriver} interface defined here. If
 * the library breaks or its API moves, the blast radius is exactly this file.
 *
 * We adapt the library's two operations into a stable shape:
 *  - `register(config)` → opaque {@link FcmRawCredentials}
 *  - `listen(creds, persistentIds, onPush)` → a {@link PushConnection} handle
 *
 * ## Which library APIs we use (and which we avoid)
 * `@liamcottle/push-receiver@0.0.4` ships two registration paths and two listen
 * surfaces; only one of each works for the modern Firebase/Rust+ flow:
 *  - **register**: we use `AndroidFCM.register(...)`, NOT the top-level
 *    `register(senderId)`. The latter forwards a generated `wp:receiver…#<uuid>`
 *    app id where an `androidId` is expected and feeds it to `Long.fromString`,
 *    which throws `interior hyphen` on the UUID — registration can never succeed.
 *  - **listen**: we construct a `Client` and subscribe to `ON_DATA_RECEIVED`,
 *    NOT the top-level `listen(...)` helper (which only forwards the never-fired
 *    `ON_NOTIFICATION_RECEIVED`). Rust+ pushes arrive unencrypted, so the data
 *    event is the one that carries them. The stanza's `app_data` key/value list
 *    is folded into a `{ data: { body, … } }` envelope — the exact shape
 *    `decode.ts` parses. Decoding still lives there, not here.
 */

import { createRequire } from "node:module";
import { ConnectionError } from "../errors.js";
import { noopLogger, type Logger } from "../redact.js";
import type { FcmRawCredentials } from "../types.js";

/**
 * Firebase/GCM app identity required by `AndroidFCM.register`. The Rust+ values
 * live in `constants.ts`; tests inject a fake driver and never need real ones.
 */
export interface AndroidFcmConfig {
  apiKey: string;
  projectId: string;
  gcmSenderId: string;
  gmsAppId: string;
  androidPackageName: string;
  androidPackageCert: string;
}

/** A raw push as the library delivers it; opaque to fcm until decoded. */
export interface RawPush {
  /** Library-assigned id used to dedupe replays across reconnects. */
  persistentId?: string;
  /** The notification envelope (`{ data, … }`); decoded downstream. */
  notification: unknown;
}

/** Handle to a live persistent push connection. */
export interface PushConnection {
  /** Tear the connection down. Idempotent. */
  destroy(): void;
}

/**
 * Stable seam over the push library. fcm depends only on this; tests provide a
 * fake, and the real implementation ({@link createPushReceiverDriver}) is the
 * sole adapter to the upstream package.
 */
export interface PushReceiverDriver {
  /** Register a virtual device with Firebase/FCM and return opaque credentials. */
  register(config: AndroidFcmConfig): Promise<FcmRawCredentials>;

  /**
   * Open the persistent connection and invoke `onPush` for each notification.
   * `persistentIds` are previously-seen ids the transport should not replay.
   */
  listen(
    credentials: FcmRawCredentials,
    persistentIds: string[],
    onPush: (push: RawPush) => void,
  ): Promise<PushConnection>;
}

/** Minimal structural view of the upstream module (it has no types). */
interface PushReceiverModule {
  /** Modern Firebase registration: anonymous check-in + FCM token. */
  AndroidFCM: {
    register(
      apiKey: string,
      projectId: string,
      gcmSenderId: string,
      gmsAppId: string,
      androidPackageName: string,
      androidPackageCert: string,
    ): Promise<{
      gcm: { androidId: string | number; securityToken: string | number };
      fcm: { token: string };
    }>;
  };
  /** Persistent MCS push client; emits `ON_DATA_RECEIVED` per notification. */
  Client: new (
    androidId: string | number,
    securityToken: string | number,
    persistentIds: string[],
  ) => PushReceiverClient;
}

/** The subset of the upstream `Client` we drive. */
interface PushReceiverClient {
  on(event: "ON_DATA_RECEIVED", cb: (stanza: unknown) => void): void;
  /** Socket lifecycle the upstream `Client` emits (used only for logging). */
  on(event: "connect" | "disconnect", cb: () => void): void;
  connect(): Promise<void> | void;
  destroy(): void;
}

/** One `app_data` entry from a decoded MCS DataMessageStanza. */
interface AppDataEntry {
  key?: unknown;
  value?: unknown;
}

/**
 * Fold a stanza's `app_data` key/value list into the `{ data: { body, … } }`
 * envelope `decode.ts` expects. `protobufjs` decodes the `repeated AppData`
 * field as an array; Rust+ carries its JSON payload under the `body` key.
 */
function stanzaToNotification(stanza: unknown): {
  persistentId?: string;
  notification: unknown;
} {
  const s = (stanza ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(s.appData) ? (s.appData as AppDataEntry[]) : [];
  const data: Record<string, string> = {};
  for (const entry of entries) {
    if (typeof entry?.key === "string") {
      data[entry.key] = typeof entry.value === "string" ? entry.value : "";
    }
  }
  return {
    persistentId: typeof s.persistentId === "string" ? s.persistentId : undefined,
    notification: { data },
  };
}

/**
 * Read `androidId`/`securityToken` out of the library's GCM subscription blob.
 * Centralised here so the one place that knows the library's internal shape is
 * this adapter.
 */
function extractGcmAuth(gcm: unknown): {
  androidId: string;
  securityToken: string;
} {
  const g = (gcm ?? {}) as Record<string, unknown>;
  const androidId = g.androidId ?? g.android_id;
  const securityToken = g.securityToken ?? g.security_token;
  if (androidId == null || securityToken == null) {
    throw new ConnectionError(
      "push-receiver credentials missing androidId/securityToken; cannot open the push connection",
    );
  }
  return { androidId: String(androidId), securityToken: String(securityToken) };
}

/**
 * Build the real driver backed by `@liamcottle/push-receiver`. Loaded lazily
 * via `createRequire` so the rest of fcm (and its tests) never transitively
 * pulls the untyped CommonJS library into the type graph.
 */
export function createPushReceiverDriver(
  loadModule: () => PushReceiverModule = defaultLoad,
  log: Logger = noopLogger,
): PushReceiverDriver {
  return {
    async register(config) {
      let lib: PushReceiverModule;
      try {
        lib = loadModule();
      } catch (cause) {
        throw new ConnectionError("failed to load @liamcottle/push-receiver", { cause });
      }
      let result: {
        gcm: { androidId: string | number; securityToken: string | number };
        fcm: { token: string };
      };
      try {
        result = await lib.AndroidFCM.register(
          config.apiKey,
          config.projectId,
          config.gcmSenderId,
          config.gmsAppId,
          config.androidPackageName,
          config.androidPackageCert,
        );
      } catch (cause) {
        throw new ConnectionError("FCM/GCM device registration failed", {
          cause,
        });
      }
      // `AndroidFCM.register` yields `{ gcm: { androidId, securityToken }, fcm:
      // { token } }`. We keep `fcm` (the FCM subscription) and `gcm` (which holds
      // androidId/securityToken for the listen connection) as opaque blobs.
      return { fcm: result.fcm, gcm: result.gcm };
    },

    async listen(credentials, persistentIds, onPush) {
      const lib = loadModule();
      const { androidId, securityToken } = extractGcmAuth(credentials.gcm);
      const seen = new Set(persistentIds);
      try {
        const client = new lib.Client(androidId, securityToken, persistentIds);
        // Socket lifecycle — surfaced so a silently-retrying connection (the
        // upstream `Client` reconnects on its own) is visible in the logs. We
        // never log the credentials, only the connection state.
        client.on("connect", () => log.info({}, "fcm: push socket connected (MCS)"));
        client.on("disconnect", () =>
          log.warn({}, "fcm: push socket disconnected; library will retry"),
        );
        // Rust+ pushes are unencrypted, so they surface as `ON_DATA_RECEIVED`
        // (this fork never fires `ON_NOTIFICATION_RECEIVED`). Fold each stanza
        // into the envelope `decode.ts` parses.
        client.on("ON_DATA_RECEIVED", (stanza: unknown) => {
          const push = stanzaToNotification(stanza);
          // Only the app_data KEY names are safe to log — the `body` value
          // carries the pairing payload (incl. playerToken). Never log values.
          const data = (push.notification as { data?: Record<string, unknown> })?.data;
          const appDataKeys = data ? Object.keys(data) : [];
          if (push.persistentId && seen.has(push.persistentId)) {
            log.debug({ persistentId: push.persistentId }, "fcm: driver dropping replayed push");
            return;
          }
          if (push.persistentId) seen.add(push.persistentId);
          log.info({ persistentId: push.persistentId, appDataKeys }, "fcm: raw push received");
          onPush(push);
        });
        log.info({}, "fcm: opening push connection (MCS)");
        // connect() resolves once the socket + parser are wired; matching the
        // upstream helper, we do not block on the first message.
        await client.connect();
        log.info({}, "fcm: push connection established");
        return {
          destroy() {
            try {
              client.destroy();
            } catch {
              /* already torn down */
            }
          },
        };
      } catch (cause) {
        throw new ConnectionError("failed to open the FCM push connection", {
          cause,
        });
      }
    },
  };
}

/** Default loader: `require('@liamcottle/push-receiver')`. */
function defaultLoad(): PushReceiverModule {
  const require = createRequire(import.meta.url);
  return require("@liamcottle/push-receiver") as PushReceiverModule;
}
