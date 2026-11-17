/**
 * FcmService — the public face of @conduit/fcm.
 *
 * Orchestrates the three sub-responsibilities:
 *  1. Registration  — FCM/GCM device + Expo exchange + Steam login + Companion.
 *  2. Listening      — persistent push connection, dedupe, decode, typed events.
 *  3. Credential lifecycle — expose creds for encrypted persistence + refresh().
 *
 * Every fragile/network thing is behind an injectable seam (the driver and the
 * two `fetch` functions), so this class is fully testable without real I/O and
 * the upstream push library never reaches past the driver.
 */

import { EventEmitter } from "node:events";

import { decodePush } from "./decode.js";
import { AuthError, PairingError } from "./errors.js";
import { FACEPUNCH_LOGIN_URL, RUSTPLUS_FCM_CONFIG, RUSTPLUS_FCM_SENDER_ID } from "./constants.js";
import {
  createPushReceiverDriver,
  type AndroidFcmConfig,
  type PushConnection,
  type PushReceiverDriver,
} from "./driver/pushReceiverDriver.js";
import { registerWithCompanionApi, type CompanionRegisterFn } from "./net/companion.js";
import { exchangeExpoPushToken, type ExpoExchangeFn } from "./net/expo.js";
import { noopLogger, redact, type Logger } from "./redact.js";
import type {
  AlarmNotification,
  DeathNotification,
  FcmCredentials,
  FcmRegisterOptions,
  PairingNotification,
} from "./types.js";

/** Dependencies that may be injected (all default to real implementations). */
export interface FcmServiceDeps {
  /** The quarantined push-receiver seam. */
  driver?: PushReceiverDriver;
  /** Expo push-token exchange. */
  expoExchange?: ExpoExchangeFn;
  /** Companion API push registration / refresh. */
  companionRegister?: CompanionRegisterFn;
  /** Optional logger; defaults to a no-op (fcm is silent unless injected). */
  logger?: Logger;
  /** FCM sender id (override only for testing). */
  senderId?: string;
  /** Firebase/GCM app identity for registration (override only for testing). */
  fcmConfig?: AndroidFcmConfig;
}

/** Typed event map for documentation + the overloaded `on`. */
export interface FcmEventMap {
  serverPairing: [PairingNotification];
  entityPairing: [PairingNotification];
  alarm: [AlarmNotification];
  death: [DeathNotification];
  credentialsRefreshed: [FcmCredentials];
  /**
   * A push was handled: its `persistentId`, emitted once per new id after the
   * push is routed — whether it decoded or not, so an undecodable push is not
   * retried forever either. The host persists these and passes them back to
   * {@link FcmService.startListening} so a restart does not replay them.
   */
  pushHandled: [string];
  /** Non-fatal listener errors (e.g. a malformed payload that was skipped). */
  error: [Error];
}

export class FcmService extends EventEmitter {
  private readonly driver: PushReceiverDriver;
  private readonly expoExchange: ExpoExchangeFn;
  private readonly companionRegister: CompanionRegisterFn;
  private readonly log: Logger;
  private readonly senderId: string;
  private readonly fcmConfig: AndroidFcmConfig;

  /** Live push connection, when listening. */
  private connection?: PushConnection;
  /** Seen persistent ids, to suppress replays across reconnects. */
  private readonly seenIds = new Set<string>();
  /** Resolver for the Steam token captured out of band during register(). */
  private steamTokenResolver?: (token: string) => void;

  constructor(deps: FcmServiceDeps = {}) {
    super();
    // `log` first: the default driver is handed the same logger so the push
    // socket lifecycle + raw-push arrivals are visible without extra wiring.
    this.log = deps.logger ?? noopLogger;
    this.driver = deps.driver ?? createPushReceiverDriver(undefined, this.log);
    this.expoExchange = deps.expoExchange ?? exchangeExpoPushToken;
    this.companionRegister = deps.companionRegister ?? registerWithCompanionApi;
    this.senderId = deps.senderId ?? RUSTPLUS_FCM_SENDER_ID;
    this.fcmConfig = deps.fcmConfig ?? RUSTPLUS_FCM_CONFIG;
  }

  // ── Registration ────────────────────────────────────────────────────────

  /**
   * First-run registration. Drives: FCM/GCM device registration →
   * Expo token exchange → Steam login (via `onSteamLogin`, UI hosted by the
   * desktop app) → Companion `/api/push/register`. Returns the full
   * {@link FcmCredentials} for the caller to persist encrypted.
   *
   * **Steam token round-trip.** fcm stays UI-free, so the host owns the browser
   * and must hand the captured Steam auth token back. There are two supported
   * orderings, and you can use whichever is cleaner for the host:
   *   1. Call {@link submitSteamToken} from inside `onSteamLogin` once captured,
   *      then resolve the callback; or
   *   2. resolve `onSteamLogin` first and call {@link submitSteamToken} after.
   * `register` waits for whichever arrives. This is the exact seam bot-core /
   * desktop integrate against.
   */
  async register(opts: FcmRegisterOptions): Promise<FcmCredentials> {
    this.log.info({ senderId: this.senderId }, "fcm: registering device");

    // 1. FCM/GCM device registration (behind the driver).
    const raw = await this.driver.register(this.fcmConfig);

    // 2. Expo push-token exchange — needs the raw FCM device token.
    const deviceToken = this.extractFcmToken(raw.fcm);
    const expoPushToken = await this.expoExchange(deviceToken);
    this.log.debug({ expoPushToken: "[set]" }, "fcm: obtained Expo push token");

    // 3. Steam login. Arm the round-trip resolver, then invoke the host's
    //    browser-hosting callback. Resolve when the token has been submitted.
    const steamAuthToken = await this.awaitSteamToken(opts.onSteamLogin);

    // 4. Companion API registration → refreshed Steam token (~2-week life).
    const deviceId = this.extractDeviceId(raw.gcm);
    const { steamAuthToken: refreshed, steamTokenExpiresAt } = await this.companionRegister({
      expoPushToken,
      steamAuthToken,
      deviceId,
    });

    const credentials: FcmCredentials = {
      fcm: raw.fcm,
      gcm: raw.gcm,
      expoPushToken,
      steamAuthToken: refreshed,
      steamTokenExpiresAt,
    };
    this.log.info({ credentials: redact(credentials) }, "fcm: registration complete");
    return credentials;
  }

  /**
   * Deliver the Steam auth token captured by the host's browser back into a
   * pending {@link register} call. Safe to call from inside `onSteamLogin` or
   * after it resolves. Throws if no registration is awaiting a token.
   */
  submitSteamToken(steamAuthToken: string): void {
    if (!steamAuthToken) {
      throw new AuthError("submitSteamToken called with an empty token");
    }
    if (!this.steamTokenResolver) {
      throw new AuthError("submitSteamToken called but no registration is awaiting a Steam token");
    }
    const resolve = this.steamTokenResolver;
    this.steamTokenResolver = undefined;
    resolve(steamAuthToken);
  }

  private async awaitSteamToken(onSteamLogin: (url: string) => Promise<void>): Promise<string> {
    const tokenPromise = new Promise<string>((resolve) => {
      this.steamTokenResolver = resolve;
    });
    try {
      await onSteamLogin(FACEPUNCH_LOGIN_URL);
    } catch (cause) {
      this.steamTokenResolver = undefined;
      throw new AuthError("Steam login was cancelled or failed", { cause });
    }
    return tokenPromise;
  }

  // ── Listening ─────────────────────────────────────────────────────────────

  /**
   * Open the persistent push connection. Pre-seeds dedupe state
   * with `persistentIds` so old notifications are not replayed, decodes each
   * push, and emits the matching typed event. A malformed payload raises a
   * {@link PairingError} that is caught and emitted as `error` — the listener
   * survives. Every newly handled push then emits `pushHandled` with its id,
   * which the host persists and passes back here on the next start.
   */
  async startListening(credentials: FcmCredentials, persistentIds: string[] = []): Promise<void> {
    if (this.connection) {
      await this.stopListening();
    }
    for (const id of persistentIds) this.seenIds.add(id);

    this.log.info({ persistentIds: persistentIds.length }, "fcm: starting push listener");

    this.connection = await this.driver.listen(
      { fcm: credentials.fcm, gcm: credentials.gcm },
      [...this.seenIds],
      (push) => this.handlePush(push.persistentId, push.notification),
    );
  }

  /** Tear down the persistent connection. Idempotent. */
  async stopListening(): Promise<void> {
    if (this.connection) {
      this.log.info({}, "fcm: stopping push listener");
      this.connection.destroy();
      this.connection = undefined;
    }
  }

  /** Decode + route a single push, deduping by persistentId. */
  private handlePush(persistentId: string | undefined, notification: unknown) {
    if (persistentId) {
      if (this.seenIds.has(persistentId)) {
        this.log.debug({ persistentId }, "fcm: dropping replayed push");
        return;
      }
      this.seenIds.add(persistentId);
    }

    try {
      const decoded = decodePush(notification);
      // The kind and ids only: a pairing also carries its playerToken.
      this.log.info(
        {
          persistentId,
          kind: decoded.kind,
          ...("pairing" in decoded
            ? { serverId: decoded.pairing.id, entityId: decoded.pairing.entityId }
            : {}),
        },
        "fcm: push decoded",
      );
      switch (decoded.kind) {
        case "serverPairing":
          this.emit("serverPairing", decoded.pairing);
          break;
        case "entityPairing":
          this.emit("entityPairing", decoded.pairing);
          break;
        case "alarm":
          this.emit("alarm", decoded.alarm);
          break;
        case "death":
          this.emit("death", decoded.death);
          break;
      }
    } catch (err) {
      // A bad payload must never kill the connection. Log redacted + emit.
      // payloadShape names the payload's fields and the shape of each value —
      // never a value — so a changed push format is diagnosable from the log.
      const payloadShape = err instanceof PairingError ? err.payloadShape : undefined;
      this.log.warn(
        { persistentId, error: (err as Error).message, payloadShape },
        "fcm: failed to decode push",
      );
      this.emit("error", err as Error);
    }

    // Reported after routing, decoded or not: the host persists the id so a
    // restart's startListening seeds it and the push is never processed again.
    if (persistentId) this.emit("pushHandled", persistentId);
  }

  // ── Credential lifecycle ───────────────────────────────────────────────────

  /**
   * Refresh the ~2-week Steam token. Re-registers the existing Expo
   * token with the Companion API and returns new {@link FcmCredentials}. Emits
   * `credentialsRefreshed` so the desktop app can persist + reconnect.
   */
  async refresh(credentials: FcmCredentials): Promise<FcmCredentials> {
    this.log.info({}, "fcm: refreshing Steam token");
    const deviceId = this.extractDeviceId(credentials.gcm);
    const { steamAuthToken, steamTokenExpiresAt } = await this.companionRegister({
      expoPushToken: credentials.expoPushToken,
      steamAuthToken: credentials.steamAuthToken,
      deviceId,
    });

    const refreshed: FcmCredentials = {
      ...credentials,
      steamAuthToken,
      steamTokenExpiresAt,
    };
    this.emit("credentialsRefreshed", refreshed);
    return refreshed;
  }

  /**
   * Sign in with Steam again and re-register with the Companion API, keeping
   * this device's existing FCM/Expo registration (so the push listener and
   * every pairing carry on). Use it when {@link refresh} can no longer renew
   * the token: Facepunch refuses an expired one. The Steam token round-trips
   * exactly as in {@link register}: the host's `onSteamLogin` opens the login
   * page and hands the captured token to {@link submitSteamToken}.
   *
   * Emits `credentialsRefreshed`, like {@link refresh}.
   */
  async renew(credentials: FcmCredentials, opts: FcmRegisterOptions): Promise<FcmCredentials> {
    this.log.info({}, "fcm: renewing the Steam sign-in");
    const deviceId = this.extractDeviceId(credentials.gcm);
    const steamAuthToken = await this.awaitSteamToken(opts.onSteamLogin);
    const registered = await this.companionRegister({
      expoPushToken: credentials.expoPushToken,
      steamAuthToken,
      deviceId,
    });
    const renewed: FcmCredentials = {
      ...credentials,
      steamAuthToken: registered.steamAuthToken,
      steamTokenExpiresAt: registered.steamTokenExpiresAt,
    };
    this.emit("credentialsRefreshed", renewed);
    return renewed;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Pull the FCM device token out of the opaque `fcm` blob. */
  private extractFcmToken(fcm: unknown): string {
    const f = (fcm ?? {}) as Record<string, unknown>;
    // Shape: `{ fcm: { token }, gcm, keys }` (whole register blob) or `{ token }`.
    const inner = (f.fcm ?? f) as Record<string, unknown>;
    const token = inner.token;
    if (typeof token === "string" && token.length > 0) return token;
    throw new AuthError("FCM registration did not yield a device token");
  }

  /** Derive a stable device id from the GCM subscription (androidId). */
  private extractDeviceId(gcm: unknown): string {
    const g = (gcm ?? {}) as Record<string, unknown>;
    const id = g.androidId ?? g.android_id;
    return id != null ? String(id) : "conduit-device";
  }
}
