/**
 * Expo push-token exchange.
 *
 * Trades the raw FCM device token for an `ExponentPushToken[…]`, which is what
 * the Companion API expects. Exposed as an injectable function so tests mock it
 * without real network.
 */

import { EXPO_APP_ID, EXPO_EXPERIENCE_ID, EXPO_PUSH_TOKEN_URL } from "../constants.js";
import { ConnectionError } from "../errors.js";

/** The single network seam for the Expo exchange; default uses global fetch. */
export type ExpoExchangeFn = (deviceToken: string) => Promise<string>;

/** Default implementation over Node 20's global `fetch`. */
export const exchangeExpoPushToken: ExpoExchangeFn = async (deviceToken) => {
  let res: Response;
  try {
    res = await fetch(EXPO_PUSH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: crypto.randomUUID(),
        experienceId: EXPO_EXPERIENCE_ID,
        appId: EXPO_APP_ID,
        deviceToken,
        type: "fcm",
        development: false,
      }),
    });
  } catch (cause) {
    throw new ConnectionError("Expo push-token exchange request failed", {
      cause,
    });
  }

  if (!res.ok) {
    throw new ConnectionError(`Expo push-token exchange returned HTTP ${res.status}`);
  }

  const body = (await res.json().catch(() => ({}))) as {
    data?: { expoPushToken?: string };
  };
  const token = body?.data?.expoPushToken;
  if (!token) {
    throw new ConnectionError("Expo push-token exchange response missing expoPushToken");
  }
  return token;
};
