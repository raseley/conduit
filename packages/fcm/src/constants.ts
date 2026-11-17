/**
 * Network constants for the Rust+ pairing/registration flow.
 *
 * These match the values the official Rust+ companion app uses and that the
 * community `rustplus.js` `fcm-register` tooling drives. They are grouped here
 * so a Facepunch/Google change is a one-file edit.
 */

/** Firebase sender id for the Rust+ companion app. */
export const RUSTPLUS_FCM_SENDER_ID = "976529667804";

/**
 * Full Firebase/GCM app identity for the Rust+ companion app, as driven by the
 * community `rustplus.js` `fcm-register` tooling. These are passed to the push
 * library's modern `AndroidFCM.register(...)` path, which performs an anonymous
 * GCM check-in (so Google mints the `androidId`/`securityToken`) followed by a
 * Firebase installation + FCM registration. The legacy `register(senderId)`
 * path is unusable here — it feeds the app id into a numeric `Long`, throwing
 * "interior hyphen" on the UUID it generates.
 *
 * All values are public client identifiers of the shipped Rust+ Android app.
 */
export const RUSTPLUS_FCM_CONFIG = {
  apiKey: "AIzaSyB5y2y-Tzqb4-I4Qnlsh_9naYv_TD8pCvY",
  projectId: "rust-companion-app",
  gcmSenderId: RUSTPLUS_FCM_SENDER_ID,
  gmsAppId: "1:976529667804:android:d6f1ddeb4403b338fea619",
  androidPackageName: "com.facepunch.rust.companion",
  androidPackageCert: "E28D05345FB78A7A1A63D70F4A302DBF426CA5AD",
} as const;

/** Expo experience the Rust+ app registers under. */
export const EXPO_EXPERIENCE_ID = "@facepunch/RustCompanion";

/** Expo "project" appId used in the push-token exchange. */
export const EXPO_APP_ID = "com.facepunch.rust.companion";

/** Expo getExpoPushToken endpoint (FCM → ExponentPushToken). */
export const EXPO_PUSH_TOKEN_URL = "https://exp.host/--/api/v2/push/getExpoPushToken";

/** Facepunch Companion API push-registration endpoint. */
export const COMPANION_REGISTER_URL = "https://companion-rust.facepunch.com/api/push/register";

/**
 * Address Facepunch's `/app` endpoint redirects to at the end of a Rust+ login,
 * with `token` and `steamId` appended as query parameters. It is the Rust+ app's
 * own URL scheme: the host's login window must catch the redirect, never follow it.
 */
export const RUST_PLUS_AUTH_REDIRECT = "rust-plus://rust-auth-session";

/**
 * Facepunch Steam-login page the operator authenticates against, carrying the
 * return chain the official app uses since Facepunch's October 2026 change:
 * `/login` → Steam → `/app` → `302 Location: rust-plus://rust-auth-session?token=…`.
 * Opened without a `returnUrl`, the page falls back to its landing page and no
 * token is ever handed over.
 */
export const FACEPUNCH_LOGIN_URL =
  "https://companion-rust.facepunch.com/login?returnUrl=" +
  encodeURIComponent("/app?returnUrl=" + encodeURIComponent(RUST_PLUS_AUTH_REDIRECT));

/**
 * Companion `PushKind` for an FCM/Expo push registration. The Rust+ app sends
 * `3` for the Expo-layered token path.
 */
export const COMPANION_PUSH_KIND = 3;

/**
 * Steam auth tokens issued by the Companion API live roughly two weeks.
 * Used as the default expiry when the API response does
 * not carry one explicitly.
 */
export const STEAM_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
