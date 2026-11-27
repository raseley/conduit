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

/** One HTTPS request. */
export interface HttpsRequestInit {
  method: "GET" | "POST";
  url: string;
  /** Exactly the headers to send (besides `host`, `content-length`, `Connection`). */
  headers: Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal;
}

/** The response: any status (a non-2xx is not an error here), headers lower-cased. */
export interface HttpsResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Performs one HTTPS request. Rejects (with {@link ConnectionError}, failure
 * `network`, from the production implementation) only when no complete
 * response arrived.
 */
export type HttpsRequest = (request: HttpsRequestInit) => Promise<HttpsResponse>;

/**
 * The largest response body accepted, 1 MiB. Google's replies here are a few
 * hundred bytes; the cap keeps a misbehaving server from filling memory.
 */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

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
  deps: { request?: NodeRequestFn; maxResponseBytes?: number } = {},
): HttpsRequest {
  const send = deps.request ?? (nodeRequest as NodeRequestFn);
  const maxResponseBytes = deps.maxResponseBytes ?? MAX_RESPONSE_BYTES;

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
      if (init.signal?.aborted) {
        reject(
          new ConnectionError("Request was aborted", {
            failure: "network",
            cause: init.signal.reason,
          }),
        );
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
      const fail = (message: string, cause?: unknown): void => {
        if (settled) return;
        settled = true;
        reject(new ConnectionError(message, { failure: "network", cause }));
      };

      const req = send(
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
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            total += chunk.byteLength;
            if (total > maxResponseBytes) {
              settled = true;
              reject(
                new ConnectionError(`Response is over ${maxResponseBytes} bytes`, {
                  failure: "refused",
                }),
              );
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (settled) return;
            settled = true;
            resolve({
              status: res.statusCode ?? 0,
              headers: flattenHeaders(res.headers),
              body: new Uint8Array(Buffer.concat(chunks)),
            });
          });
          res.on("error", (err) => fail("Response was cut off", err));
          // A socket that closes mid-body ends the response without "end".
          res.on("close", () => fail("Response was cut off"));
        },
      );
      req.on("error", (err) => fail("Request failed before a response arrived", err));
      req.end(init.body === undefined ? undefined : Buffer.from(init.body));
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
