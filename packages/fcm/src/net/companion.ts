/**
 * Facepunch Companion API registration.
 *
 * POSTs the Expo push token + Steam auth token to `/api/push/register`. The API
 * returns a refreshed Steam auth token (~2-week life) — the same call serves
 * both first-time registration and {@link FcmService.refresh}. Injectable so
 * tests mock it.
 */

import { COMPANION_PUSH_KIND, COMPANION_REGISTER_URL, STEAM_TOKEN_TTL_MS } from "../constants.js";
import { AuthError, ConnectionError } from "../errors.js";

/** Inputs to a Companion push-register call. */
export interface CompanionRegisterInput {
  /** Expo push token from the Expo exchange. */
  expoPushToken: string;
  /** Current Steam auth token captured from the Facepunch login / prior creds. */
  steamAuthToken: string;
  /** Stable device id (the FCM/GCM androidId, or any stable per-install id). */
  deviceId: string;
}

/** What the Companion API hands back: a refreshed token + its expiry. */
export interface CompanionRegisterResult {
  /** Refreshed Steam auth token. */
  steamAuthToken: string;
  /** ISO-8601 expiry (server-provided, else now + ~2 weeks). */
  steamTokenExpiresAt: string;
}

/** The single network seam for Companion registration. */
export type CompanionRegisterFn = (
  input: CompanionRegisterInput,
) => Promise<CompanionRegisterResult>;

/** Default implementation over Node 20's global `fetch`. */
export const registerWithCompanionApi: CompanionRegisterFn = async ({
  expoPushToken,
  steamAuthToken,
  deviceId,
}) => {
  let res: Response;
  try {
    res = await fetch(COMPANION_REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        AuthToken: steamAuthToken,
        DeviceId: deviceId,
        PushKind: COMPANION_PUSH_KIND,
        PushToken: expoPushToken,
      }),
    });
  } catch (cause) {
    throw new ConnectionError("Companion API registration request failed", {
      cause,
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`Companion API rejected the Steam auth token (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new ConnectionError(`Companion API registration returned HTTP ${res.status}`);
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // The API echoes a refreshed token; tolerate a couple of casings. If it omits
  // one (it sometimes just 200s), the existing token remains valid.
  const refreshed =
    (body.AuthToken as string | undefined) ??
    (body.authToken as string | undefined) ??
    steamAuthToken;

  const expiresRaw =
    (body.ExpiresAt as string | undefined) ?? (body.expiresAt as string | undefined);
  const steamTokenExpiresAt =
    expiresRaw && !Number.isNaN(Date.parse(expiresRaw))
      ? new Date(expiresRaw).toISOString()
      : new Date(Date.now() + STEAM_TOKEN_TTL_MS).toISOString();

  return { steamAuthToken: refreshed, steamTokenExpiresAt };
};
