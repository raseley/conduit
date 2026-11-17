/**
 * Pushover delivery — the concrete {@link PushoverNotifier} the desktop injects
 * into {@link BotCore}.
 *
 * A single form-encoded POST to the Pushover messages API. Exposed as a plain
 * function (with an injectable `fetch` seam) so it unit-tests without real
 * network and without an Electron binary — mirroring the fcm `net/` seams.
 */

import type { PushoverMessage, PushoverNotifier } from "@conduit/bot-core";

/** Pushover messages endpoint. */
export const PUSHOVER_MESSAGES_URL = "https://api.pushover.net/1/messages.json";

/** Raised when a Pushover send fails (network or non-2xx response). */
export class PushoverError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PushoverError";
  }
}

/** Injectable `fetch` seam (defaults to Node 20's global `fetch`). */
export type FetchFn = typeof fetch;

/**
 * Build a {@link PushoverNotifier} backed by `fetch`. The default uses the
 * global `fetch`; tests pass a fake.
 */
export function createPushoverNotifier(fetchFn: FetchFn = fetch): PushoverNotifier {
  return async (msg: PushoverMessage): Promise<void> => {
    const body = new URLSearchParams({
      token: msg.appToken,
      user: msg.userKey,
      title: msg.title,
      message: msg.message,
      priority: String(msg.priority),
    });

    let res: Response;
    try {
      res = await fetchFn(PUSHOVER_MESSAGES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (cause) {
      throw new PushoverError("Pushover send request failed", { cause });
    }

    if (!res.ok) {
      // 4xx from Pushover means bad credentials or a malformed message; surface
      // the status so the operator can correct it.
      throw new PushoverError(`Pushover API returned HTTP ${res.status}`);
    }
  };
}

/** Default notifier over the global `fetch`. */
export const sendPushover: PushoverNotifier = createPushoverNotifier();
