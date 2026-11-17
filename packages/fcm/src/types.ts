/**
 * Public types for @conduit/fcm.
 *
 * These are the shapes the desktop app persists (encrypted) and that bot-core
 * consumes. They intentionally do NOT leak any `@liamcottle/push-receiver`
 * types — the library is quarantined behind {@link PushReceiverDriver}.
 */

/** Raw FCM/GCM credential blobs as produced by the push library. */
export interface FcmRawCredentials {
  /** FCM subscription result (`{ token, … }`) plus the local ECDH keys. */
  fcm: unknown;
  /**
   * GCM subscription. Critically holds `androidId` + `securityToken`, the two
   * values the persistent `listen()` connection authenticates with. Treated as
   * opaque by everything except the driver adapter.
   */
  gcm: unknown;
}

/**
 * The full credential bundle fcm owns. The desktop app persists this encrypted
 * (`StoredCredentials.fcm`) and hands it back to `startListening` /
 * `refresh`.
 */
export interface FcmCredentials {
  /** FCM subscription result + local keys (opaque outside the driver). */
  fcm: unknown;
  /** GCM subscription holding `androidId`/`securityToken` (opaque). */
  gcm: unknown;
  /** Expo push token (`ExponentPushToken[…]`) layered on top of FCM. */
  expoPushToken: string;
  /** Facepunch/Steam auth token; refreshed by the Companion API (~2-week life). */
  steamAuthToken: string;
  /** ISO-8601 timestamp at which {@link steamAuthToken} expires. */
  steamTokenExpiresAt: string;
}

/** A decoded server/entity pairing push. */
export interface PairingNotification {
  type: "server" | "entity";
  /**
   * Server address for a direct connection. Absent on current servers: since
   * Facepunch's move to its companion socket, pairing pushes carry no ip/port,
   * and clients connect by {@link id} instead.
   */
  ip?: string;
  /** Rust+ companion port (`app.port`) for a direct connection; absent with {@link ip}. */
  port?: number;
  name: string;
  desc: string;
  id: string;
  playerId: string;
  playerToken: string;
  /** Present only when `type === "entity"`. */
  entityId?: number;
  /** Present only when `type === "entity"`. */
  entityType?: number;
}

/**
 * A decoded alarm push — a smart-alarm firing relayed through the Companion
 * push channel. Derived from the same pairing-push JSON envelope (it carries a
 * `title`/`message` and a server reference instead of connection details).
 */
export interface AlarmNotification {
  title: string;
  message: string;
  /** Companion server id this alarm belongs to (the payload `id`/`serverId`). */
  serverId?: string;
  /** Operator SteamID, when the payload includes it. */
  playerId?: string;
}

/**
 * A decoded death push — relayed by the Companion backend when the operator's
 * player dies. Carries the victim's name/SteamID, an optional human-readable
 * cause, and a server reference. Derived from the same push envelope
 * (`type === "death"`) and decoded defensively, since the payload fields vary.
 */
export interface DeathNotification {
  /** Name of the player who died (payload `targetName`), or a generic fallback. */
  name: string;
  /** SteamID of the player who died, when present (payload `targetId`). */
  targetId?: string;
  /** Human-readable death message/cause, when the payload carries one. */
  message?: string;
  /** Companion server id this death belongs to (the payload `id`/`serverId`). */
  serverId?: string;
}

/** Options for {@link FcmService.register}. */
export interface FcmRegisterOptions {
  /**
   * Called with the Facepunch login URL once FCM registration + the Expo
   * exchange have produced a device token. The host (desktop = Electron
   * `BrowserWindow`, headless = print URL) drives the browser; fcm stays
   * UI-free.
   *
   * The Steam token round-trips back into fcm out of band via
   * {@link FcmService.submitSteamToken}. This callback resolves once the host
   * has handed the captured token over (or it may resolve immediately after
   * calling `submitSteamToken` itself — both orderings are supported; see the
   * `register` docs).
   */
  onSteamLogin: (url: string) => Promise<void>;
}
