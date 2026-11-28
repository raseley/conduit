/**
 * The HTTPS seam for the push client's calls to Google (Firebase installation,
 * check-in, `register3`).
 *
 * These calls do not use `fetch`: Node's `fetch` adds headers push-receiver
 * never sent (`user-agent: node`, `accept`, `accept-language`,
 * `sec-fetch-mode`, `accept-encoding`), some of which cannot be removed, and
 * Conduit should look to Google exactly as it always has. The production
 * {@link nodeHttpsRequest} uses `node:https` and sends ONLY the headers it is
 * given plus `host` and `content-length`, which it sets itself, and the
 * `Connection` header Node adds; the same set push-receiver's HTTP client
 * (`request`) sent. Tests inject a fake {@link HttpsRequest}.
 *
 * TLS certificates are verified (Node's default); this module never turns that
 * off.
 */

import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as nodeRequest, type RequestOptions } from "node:https";
import { ConnectionError } from "../errors.js";
import { defaultTimers, type TimerProvider } from "./timers.js";

/** One HTTPS request. */
export interface HttpsRequestInit {
  method: "GET" | "POST";
  url: string;
  /** Exactly the headers to send (besides `host`, `content-length`, `Connection`). */
  headers: Record<string, string>;
  /** Required for a POST. */
  body?: Uint8Array;
  /**
   * Cancels the request, and makes the caller responsible for its deadline:
   * without a signal the request has its own {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   */
  signal?: AbortSignal;
}

/** The response: any status (a non-2xx is not an error here), headers lower-cased. */
export interface HttpsResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Performs one HTTPS request; resolves with any complete response. The
 * production implementation rejects with a {@link ConnectionError}:
 *
 * - failure `network`: no response (connection or TLS failure, or no response
 *   within the default timeout);
 * - failure `refused`: Google answered, but the response was cut off mid-body
 *   or ran over {@link MAX_RESPONSE_BYTES};
 * - no failure kind: the caller's signal aborted it (an abort is not a failure
 *   of Google's), or the request itself was unusable (a bad or non-https URL, a
 *   POST without a body, a header Node will not send).
 */
export type HttpsRequest = (request: HttpsRequestInit) => Promise<HttpsResponse>;

/**
 * The largest response body accepted, 1 MiB. Google's replies here are a few
 * hundred bytes; the cap keeps a misbehaving server from filling memory.
 */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * The deadline for a request made without a signal, so no caller can wait
 * forever on a server that never answers. Matches the check-in timeout.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** The `node:https` `request` function, narrowed to the call shape used here. */
export type NodeRequestFn = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

/** Headers this module sets itself; a caller's copy of them is dropped. */
const MANAGED_HEADERS = new Set(["host", "content-length", "connection"]);

/**
 * Build an {@link HttpsRequest} over `node:https`. `request` is the seam for
 * tests that check what reaches Node; production uses the default.
 */
export function createNodeHttpsRequest(
  deps: {
    request?: NodeRequestFn;
    maxResponseBytes?: number;
    timeoutMs?: number;
    timers?: TimerProvider;
  } = {},
): HttpsRequest {
  const send = deps.request ?? (nodeRequest as NodeRequestFn);
  const maxResponseBytes = deps.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const timers = deps.timers ?? defaultTimers;

  return (init) =>
    new Promise<HttpsResponse>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(init.url);
      } catch (err) {
        reject(new ConnectionError("Request URL is not valid", { cause: err }));
        return;
      }
      if (url.protocol !== "https:") {
        reject(new ConnectionError("Only https URLs are allowed"));
        return;
      }
      // `request` sent a bodiless POST with a lower-case `content-length: 0`
      // before `Connection`; Node would add `Content-Length: 0` after it. Every
      // call to Google has a body, so rather than mimic that, refuse.
      if (init.method === "POST" && init.body === undefined) {
        reject(new ConnectionError("A POST needs a body"));
        return;
      }
      if (init.signal?.aborted) {
        reject(new ConnectionError("Request was aborted", { cause: init.signal.reason }));
        return;
      }

      // The caller's headers in their order, then `host` and `content-length`,
      // lower-case, the order and spelling `request` used. Node adds
      // `Connection` itself (keep-alive with its default agent, as with
      // `request`).
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(init.headers)) {
        if (!MANAGED_HEADERS.has(name.toLowerCase())) headers[name] = value;
      }
      headers["host"] = url.host;
      if (init.body !== undefined) {
        headers["content-length"] = String(init.body.byteLength);
      }

      let settled = false;
      let responseStarted = false;
      let timedOut = false;
      let timer: unknown;
      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) timers.clearTimer(timer);
        outcome();
      };
      const failWith = (err: ConnectionError): void => settle(() => reject(err));
      /** A transport error: say what it means for whoever counts failures. */
      const failTransport = (cause?: unknown): void => {
        if (timedOut) {
          failWith(
            new ConnectionError(`No response within ${timeoutMs} ms`, {
              failure: "network",
              cause,
            }),
          );
        } else if (init.signal?.aborted) {
          // The caller cancelled; not a failure of the connection to Google.
          failWith(new ConnectionError("Request was aborted", { cause }));
        } else if (responseStarted) {
          failWith(new ConnectionError("Response was cut off", { failure: "refused", cause }));
        } else {
          failWith(
            new ConnectionError("Request failed before a response arrived", {
              failure: "network",
              cause,
            }),
          );
        }
      };

      let req: ClientRequest | undefined;
      try {
        req = send(
          {
            method: init.method,
            protocol: "https:",
            hostname: url.hostname,
            port: url.port === "" ? 443 : Number(url.port),
            path: `${url.pathname}${url.search}`,
            headers,
            signal: init.signal,
          },
          (res) => {
            responseStarted = true;
            const chunks: Buffer[] = [];
            let total = 0;
            res.on("data", (chunk: Buffer) => {
              if (settled) return;
              total += chunk.byteLength;
              if (total > maxResponseBytes) {
                failWith(
                  new ConnectionError(`Response is over ${maxResponseBytes} bytes`, {
                    failure: "refused",
                  }),
                );
                req?.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => {
              settle(() =>
                resolve({
                  status: res.statusCode ?? 0,
                  headers: flattenHeaders(res.headers),
                  body: new Uint8Array(Buffer.concat(chunks)),
                }),
              );
            });
            res.on("error", (err) => failTransport(err));
            // A socket that closes mid-body ends the response without "end".
            res.on("close", () => failTransport());
          },
        );
        req.on("error", (err) => failTransport(err));
        if (init.signal === undefined) {
          timer = timers.setTimer(() => {
            timedOut = true;
            failTransport();
            req?.destroy();
          }, timeoutMs);
        }
        req.end(init.body === undefined ? undefined : Buffer.from(init.body));
      } catch (err) {
        // Node checks headers as the request is built and throws a TypeError
        // (ERR_INVALID_CHAR for a value with a newline, ERR_INVALID_HTTP_TOKEN
        // for a bad name); turn that into a typed rejection.
        failWith(new ConnectionError("Request could not be sent", { cause: err }));
        req?.destroy();
      }
    });
}

/** The production {@link HttpsRequest}. */
export const nodeHttpsRequest: HttpsRequest = createNodeHttpsRequest();

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
