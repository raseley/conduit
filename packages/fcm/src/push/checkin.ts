/**
 * GCM check-in: the POST that mints a device (androidId + securityToken) on
 * first run, and that the push client repeats before every connect.
 *
 * Portions derived from @liamcottle/push-receiver's `gcm/index.js` (MIT
 * License, Copyright (c) 2017 Matthieu Lemoine;
 * https://github.com/liamcottle/push-receiver): the URL, header and body.
 *
 * Unlike push-receiver, which retries a failed check-in forever (and so blocked
 * startup while offline), this makes ONE attempt, bounded by a 15 s timeout,
 * and reports the outcome as a typed {@link ConnectionError} whose `failure`
 * says what went wrong; retrying is the caller's decision.
 */

import { ConnectionError, ProtocolError } from "../errors.js";
import type { HttpsRequest, HttpsResponse } from "./http.js";
import { DEFAULT_IDENTITY, type PushIdentity } from "./identity.js";
import { decodeCheckinResponse, encodeCheckinRequest, type DeviceCredentials } from "./messages.js";

export const CHECKIN_URL = "https://android.clients.google.com/checkin";

/** The one header push-receiver sends with a check-in. */
const CHECKIN_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/x-protobuf",
});

/** How long one check-in may take before it counts as no response. */
export const CHECKIN_TIMEOUT_MS = 15_000;

/** The longest `Retry-After` honoured: a server asking for more is capped at an hour. */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export interface CheckInOptions {
  httpsRequest: HttpsRequest;
  /** Cancels the check-in (combined with the 15 s timeout). */
  signal?: AbortSignal;
  /** The stored device, for a re-check-in; omit both for a first-run check-in. */
  androidId?: string;
  securityToken?: string;
  /** Who to present as; defaults to the shipped profile. */
  identity?: PushIdentity;
  /** Clock for an HTTP-date `Retry-After`; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Check in with Google. Resolves with the device's `{ androidId,
 * securityToken }` as decimal strings.
 *
 * Throws {@link ConnectionError} with `failure`:
 * - `network`: no response (transport error, timeout, or the caller aborted);
 * - `credentials`: HTTP 400 or 401 (Google rejected the device), or stored
 *   credentials too malformed to send;
 * - `refused`: any other non-200, or a 200 whose body does not decode; on a 429
 *   or 503 it carries the parsed `Retry-After` as `retryAfterMs`.
 */
export async function checkIn(options: CheckInOptions): Promise<DeviceCredentials> {
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const body = encodeRequest(identity, options.androidId, options.securityToken);

  const response = await send(options, body);

  if (response.status === 200) {
    try {
      return decodeCheckinResponse(response.body);
    } catch (err) {
      throw new ConnectionError("Check-in reply from Google could not be decoded", {
        failure: "refused",
        cause: err,
      });
    }
  }
  if (response.status === 400 || response.status === 401) {
    throw new ConnectionError(`Google rejected the device at check-in (HTTP ${response.status})`, {
      failure: "credentials",
    });
  }
  const retryAfterMs =
    response.status === 429 || response.status === 503
      ? parseRetryAfter(response.headers["retry-after"], (options.now ?? Date.now)())
      : undefined;
  throw new ConnectionError(`Google refused the check-in (HTTP ${response.status})`, {
    failure: "refused",
    retryAfterMs,
  });
}

function encodeRequest(
  identity: PushIdentity,
  androidId: string | undefined,
  securityToken: string | undefined,
): Uint8Array {
  if ((androidId === undefined) !== (securityToken === undefined)) {
    throw new ConnectionError("Check-in needs both the androidId and securityToken, or neither", {
      failure: "credentials",
    });
  }
  try {
    return encodeCheckinRequest(
      identity,
      androidId !== undefined && securityToken !== undefined
        ? { androidId, securityToken }
        : undefined,
    );
  } catch (err) {
    if (err instanceof ProtocolError) {
      throw new ConnectionError("Stored push credentials are malformed", {
        failure: "credentials",
        cause: err,
      });
    }
    throw err;
  }
}

/** One POST, bounded by the timeout and the caller's signal. */
async function send(options: CheckInOptions, body: Uint8Array): Promise<HttpsResponse> {
  if (options.signal?.aborted) {
    throw new ConnectionError("Check-in was cancelled", {
      failure: "network",
      cause: options.signal.reason,
    });
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CHECKIN_TIMEOUT_MS);
  const onCallerAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  // Settle on abort even if the seam ignores its signal, so the timeout is a
  // hard bound.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([
      options.httpsRequest({
        method: "POST",
        url: CHECKIN_URL,
        headers: { ...CHECKIN_HEADERS },
        body,
        signal: controller.signal,
      }),
      aborted,
    ]);
  } catch (err) {
    if (timedOut) {
      throw new ConnectionError(`Check-in got no response within ${CHECKIN_TIMEOUT_MS} ms`, {
        failure: "network",
        cause: err,
      });
    }
    if (options.signal?.aborted) {
      throw new ConnectionError("Check-in was cancelled", { failure: "network", cause: err });
    }
    if (err instanceof ConnectionError && err.failure !== undefined) throw err;
    throw new ConnectionError("Check-in got no response from Google", {
      failure: "network",
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

/** An IMF-fixdate, the HTTP-date form servers send: `Fri, 27 Nov 2026 12:00:45 GMT`. */
const HTTP_DATE = /^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

/**
 * Parse a `Retry-After` header (delay-seconds or an HTTP-date) into ms from
 * `now`, clamped to [0, {@link MAX_RETRY_AFTER_MS}]. Undefined when absent or
 * unreadable.
 */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^[0-9]+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else if (HTTP_DATE.test(trimmed)) {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  } else {
    // Not `Date.parse` on anything: it accepts far more than HTTP dates.
    return undefined;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}
