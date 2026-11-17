/**
 * {@link RustPlusClient} — manages a single authenticated WebSocket connection
 * to one Rust server.
 *
 * Responsibilities: request/response correlation, server-pushed broadcasts as
 * typed events, token-bucket rate limiting, automatic reconnection with
 * exponential backoff + jitter, and re-subscription of tracked entities
 * on reconnect (the server only broadcasts entity changes after a prior
 * `getEntityInfo`). Depends only on `ws` and
 * `@conduit/rustplus-proto`.
 */

import { EventEmitter } from "node:events";

import { Long, decodeMessage, encodeRequest } from "@conduit/rustplus-proto";
import type { rustplus } from "@conduit/rustplus-proto";
import WebSocket from "ws";

import {
  AuthError,
  CameraUnavailableError,
  ConnectionError,
  EntityNotFoundError,
  ProtocolError,
  RateLimitError,
} from "./errors.js";
import { DEFAULT_REQUEST_COSTS, DEFAULT_TOKEN_BUCKET, TokenBucket } from "./rate-limiter.js";
import type { RequestCostKind, TokenBucketConfig } from "./rate-limiter.js";
import { renderFrames } from "./camera.js";
import type { CameraRayFrame } from "./camera.js";
import {
  entityIdToWire,
  mapEntityChange,
  mapEntityInfo,
  mapGameTime,
  mapServerInfo,
  mapTeamChatMessage,
  mapTeamInfo,
} from "./mappers.js";
import type {
  EntityChange,
  EntityInfo,
  GameTime,
  ServerInfo,
  TeamChatMessage,
  TeamInfo,
} from "./types.js";

/** Tuning for automatic reconnection. */
export interface ReconnectConfig {
  /** Whether to auto-reconnect on a recoverable disconnect. Default `true`. */
  enabled?: boolean;
  /** First backoff delay in ms. Default `1000`. */
  initialDelayMs?: number;
  /** Backoff ceiling in ms. Default `30000`. */
  maxDelayMs?: number;
  /** Exponential growth factor. Default `2`. */
  factor?: number;
  /** Random jitter fraction (0–1) applied to each delay. Default `0.3`. */
  jitter?: number;
  /**
   * Maximum consecutive reconnect attempts before giving up and emitting a
   * terminal `error`. `Infinity` retries forever. Default `Infinity`.
   */
  maxRetries?: number;
}

/**
 * Waits before retrying a handshake the companion socket refused with 401/403,
 * in ms. A refusal can be a passing fault on Facepunch's side, so the token is
 * only reported as refused (`authRejected`) once the retry after the last wait
 * has been refused too: 30 seconds after the first refusal.
 */
export const AUTH_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 15_000];

/** Facepunch's companion socket host (the route the official Rust+ app uses). */
export const COMPANION_SOCKET_BASE = "wss://companion-rust.facepunch.com/socket/";

/** First WebSocket subprotocol of a companion-socket handshake; the second is the token. */
export const COMPANION_AUTH_SUBPROTOCOL = "rustplus.auth.v1";

/**
 * Route through Facepunch's companion socket,
 * `wss://companion-rust.facepunch.com/socket/{serverId}`. Facepunch's backend
 * relays to the game server; current servers no longer advertise an address for
 * direct connections at all (their pairing push carries no `ip`/`port`).
 */
export interface CompanionRoute {
  /** Facepunch's server id: the pairing notification's `id`. */
  serverId: string;
  /**
   * The Rust+ companion auth token (the Steam login token). Read at every
   * (re)connect, so a renewed token is picked up without rebuilding the client.
   * It travels only in the handshake's subprotocol header, never in the URL.
   */
  getAuthToken: () => string | undefined;
}

/** Options for {@link RustPlusClient}. */
export interface RustPlusClientOptions {
  /** Server address for a direct connection, `ws://{ip}:{port}`. Unused with {@link companion}. */
  ip?: string;
  /** The server's Rust+ companion port (`app.port`) for a direct connection. */
  port?: number;
  /**
   * Connect through Facepunch's companion socket. Takes precedence over
   * `ip`/`port`. One of the two routes is required.
   */
  companion?: CompanionRoute;
  /** Operator SteamID (Steam64) as a decimal string. */
  playerId: string;
  /** Per-player auth token from the pairing notification. */
  playerToken: string;
  /** Token-bucket rate-limit config. */
  rateLimit?: Partial<TokenBucketConfig>;
  /** Per-method token cost overrides. */
  requestCosts?: Partial<Record<RequestCostKind, number>>;
  /** Reconnection tuning. */
  reconnect?: ReconnectConfig;
  /**
   * Re-issue `getEntityInfo` for every tracked entity after an automatic
   * reconnect, so the server resumes broadcasting their changes. Default
   * `true`. A host that re-subscribes itself on the `connected` event (because
   * it wants the results) sets `false`, so each entity is requested once, not
   * twice.
   */
  resubscribeOnReconnect?: boolean;
  /** Per-request timeout in ms before a `ConnectionError` is raised. Default `30000`. */
  requestTimeoutMs?: number;
  /**
   * How long to collect `AppCameraRays` broadcasts before rendering a frame, in ms.
   * Default `5000`. Capture resolves early once enough frames accrue.
   */
  cameraCaptureTimeoutMs?: number;
  /**
   * WebSocket factory override (test seam — defaults to the `ws` constructor).
   * `protocols` carries the companion-socket subprotocols, and is empty for a
   * direct connection.
   */
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket;
}

/**
 * Type a refused WebSocket handshake. On the companion socket, 401/403 means the
 * auth token was rejected (expired, or garbled) — a credential failure the host
 * must fix by signing in again; 404 means Facepunch does not know the server id.
 */
export function handshakeError(status: number): Error {
  if (status === 401 || status === 403) {
    return new AuthError(`companion socket rejected the auth token (HTTP ${status})`, {
      credential: "authToken",
    });
  }
  if (status === 404) {
    return new ConnectionError("companion socket does not know this server id (HTTP 404)");
  }
  if (status >= 502 && status <= 504) {
    // Facepunch's side is up but cannot reach the game server: usually a
    // server restart. The reconnect backoff keeps trying.
    return new ConnectionError(
      `companion socket can't reach the game server (HTTP ${status}); it may be restarting`,
    );
  }
  return new ConnectionError(`server refused the WebSocket handshake (HTTP ${status})`);
}

/** base64url (RFC 4648 §5) without padding: the token's form in the handshake. */
export function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

interface PendingRequest {
  resolve: (response: rustplus.AppResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Internal connection state machine. */
type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

/**
 * Server `AppError.error` strings that always mean the player may not use the
 * companion API, whatever the request. Only `banned` qualifies: the server's
 * request validation (`CompanionServer` `Util.ToErrorCode`) can produce only
 * `not_found`, `rate_limit` and `banned`, and `not_found` is ambiguous (see
 * `RustPlusClient#classifyNotFound`). Every other string is a contextual
 * failure and becomes a {@link ProtocolError} carrying it, except
 * {@link PLAYER_ONLINE}.
 */
const AUTH_ERROR_STRINGS = new Set(["banned"]);

/**
 * The camera handler's refusal while the paired player is connected to the
 * server in-game: it will not stream a camera over Rust+ then. Raised as a
 * {@link CameraUnavailableError} so the host can tell the user what to do.
 */
const PLAYER_ONLINE = "player_online";

/** The server's answer to a request that failed validation (see `classifyNotFound`). */
const NOT_FOUND = "not_found";

/** Is `err` the raw `not_found` answer, before {@link RustPlusClient} classifies it? */
function isNotFoundAnswer(err: unknown): err is ProtocolError {
  return err instanceof ProtocolError && err.serverError === NOT_FOUND;
}

/** The request payload's name in `partial` (`getInfo`, `getEntityInfo`, …), for messages. */
function requestName(partial: Partial<rustplus.IAppRequest>): string {
  return Object.keys(partial).find((k) => k !== "entityId") ?? "request";
}

/**
 * Typed event map for {@link RustPlusClient}. Exposed for consumers that want a
 * strongly-typed `on`/`emit` surface.
 */
export interface RustPlusClientEvents {
  connected: [];
  disconnected: [{ code: number; reason: string }];
  /** An automatic reconnect is scheduled: its 1-based attempt number and backoff delay. */
  reconnecting: [{ attempt: number; delayMs: number }];
  error: [Error];
  /**
   * The companion socket refused the auth token on the first try and on every
   * retry ({@link AUTH_RETRY_DELAYS_MS}). The client has stopped: it needs a
   * new token (or a direct address) and a fresh {@link RustPlusClient.connect}.
   */
  authRejected: [AuthError];
  /** Every raw broadcast `AppMessage`. */
  message: [rustplus.AppMessage];
  entityChanged: [EntityChange];
  teamChat: [TeamChatMessage];
}

/**
 * Authenticated Rust+ WebSocket client. See module docs.
 *
 * @example
 * ```ts
 * const client = new RustPlusClient({ ip, port, playerId, playerToken });
 * client.on("entityChanged", (c) => console.log(c.entityId, c.value));
 * await client.connect();
 * const info = await client.getInfo();
 * ```
 */
export class RustPlusClient extends EventEmitter {
  readonly options: RustPlusClientOptions;

  private ws: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private seq = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly bucket: TokenBucket;
  private readonly costs: Record<RequestCostKind, number>;
  private readonly reconnectConfig: Required<ReconnectConfig>;
  private readonly requestTimeoutMs: number;
  private readonly cameraCaptureTimeoutMs: number;
  private readonly wsFactory: (url: string, protocols: string[]) => WebSocket;

  /** Entities the caller has registered interest in, re-subscribed on reconnect. */
  private readonly trackedEntities = new Set<number>();

  private reconnectAttempts = 0;
  /** Handshakes refused with 401/403 in a row; indexes {@link AUTH_RETRY_DELAYS_MS}. */
  private authRefusals = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Promise/resolvers for an in-flight `connect()` call. */
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  /** Set true once the user explicitly calls `disconnect()`. */
  private manualClose = false;
  /**
   * The credential probe in flight, shared by every request whose `not_found`
   * it is classifying (a reconnect re-subscription can raise several at once).
   */
  private credentialProbe: Promise<boolean> | null = null;
  /** The route the latest socket dialled. */
  private lastRoute: "companion" | "direct" | undefined;

  constructor(options: RustPlusClientOptions) {
    super();
    this.options = options;

    const rl = options.rateLimit ?? {};
    this.bucket = new TokenBucket({
      capacity: rl.capacity ?? DEFAULT_TOKEN_BUCKET.capacity,
      refillPerSecond: rl.refillPerSecond ?? DEFAULT_TOKEN_BUCKET.refillPerSecond,
      costPerRequest: rl.costPerRequest ?? DEFAULT_TOKEN_BUCKET.costPerRequest,
    });

    this.costs = { ...DEFAULT_REQUEST_COSTS, ...options.requestCosts };

    const rc = options.reconnect ?? {};
    this.reconnectConfig = {
      enabled: rc.enabled ?? true,
      initialDelayMs: rc.initialDelayMs ?? 1000,
      maxDelayMs: rc.maxDelayMs ?? 30000,
      factor: rc.factor ?? 2,
      jitter: rc.jitter ?? 0.3,
      maxRetries: rc.maxRetries ?? Infinity,
    };

    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.cameraCaptureTimeoutMs = options.cameraCaptureTimeoutMs ?? 5000;
    this.wsFactory =
      options.webSocketFactory ??
      ((url, protocols) => (protocols.length ? new WebSocket(url, protocols) : new WebSocket(url)));

    if (!options.companion && (!options.ip || options.port === undefined)) {
      throw new ConnectionError("no route to the server: need a companion route or ip + port");
    }
  }

  /** The WebSocket URL derived from the connection options. Never carries a credential. */
  get url(): string {
    try {
      return this.resolveRoute().url;
    } catch {
      // No usable route right now (no token, no direct address): name the
      // companion socket it would dial.
      return this.companionUrl();
    }
  }

  /**
   * The route the latest (re)connect dialled: Facepunch's companion socket, or
   * a direct connection. `undefined` before the first attempt. For logs.
   */
  get route(): "companion" | "direct" | undefined {
    return this.lastRoute;
  }

  private companionUrl(): string {
    return COMPANION_SOCKET_BASE + encodeURIComponent(this.options.companion?.serverId ?? "");
  }

  private hasDirectAddress(): boolean {
    return Boolean(this.options.ip) && this.options.port !== undefined;
  }

  /**
   * The route for this (re)connect, decided afresh each time. The companion
   * socket is preferred, with subprotocols `[rustplus.auth.v1,
   * base64url(token)]`. Without a token (never signed in, or the host withdrew
   * a rejected one) a server that also has a direct address is dialled
   * directly, with no subprotocols; otherwise this throws an
   * {@link AuthError} naming the auth token.
   */
  private resolveRoute(): { url: string; protocols: string[] } {
    const companion = this.options.companion;
    if (companion) {
      const token = companion.getAuthToken();
      if (token) {
        return {
          url: this.companionUrl(),
          protocols: [COMPANION_AUTH_SUBPROTOCOL, toBase64Url(token)],
        };
      }
      if (!this.hasDirectAddress()) {
        throw new AuthError("no Rust+ companion auth token: sign in with Steam again", {
          credential: "authToken",
        });
      }
    }
    return { url: `ws://${this.options.ip}:${this.options.port}`, protocols: [] };
  }

  /** `true` once the socket is open and ready to carry requests. */
  get connected(): boolean {
    return this.state === "connected";
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Open the WebSocket and resolve once it is connected. Rejects with a
   * {@link ConnectionError} if the initial connection fails, or if
   * {@link disconnect} is called before the socket opens.
   *
   * A failed attempt rejects at once, so the caller learns why, and the client
   * then keeps trying exactly as it does after a dropped connection (backoff
   * for an unreachable server, {@link AUTH_RETRY_DELAYS_MS} for a refused
   * token), emitting `connected` when it gets through. A host that starts
   * before the game server does is connected once the server is up, with
   * nobody having to call `connect()` again. {@link disconnect} stops it.
   *
   * Calling this while an automatic reconnect is under way takes that attempt
   * over instead of racing it with a second socket: a backoff wait is cancelled
   * and a fresh socket opened now; a reconnect socket already in flight is
   * adopted, and the returned promise settles with it.
   */
  connect(): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.connectResolve) {
      return Promise.reject(new ConnectionError("connect() already in progress"));
    }
    this.manualClose = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      // A socket that exists here can only be a reconnect attempt still waiting
      // to open (a first connect in flight was rejected above). Leave its
      // attempt count alone so it re-subscribes tracked entities when it opens.
      if (this.ws) return;
      this.reconnectAttempts = 0;
      this.authRefusals = 0;
      this.openSocket();
    });
  }

  /**
   * Close the connection and stop reconnecting. Pending requests — and a
   * {@link connect} still waiting for its socket to open — are rejected with a
   * {@link ConnectionError}.
   */
  disconnect(): Promise<void> {
    this.manualClose = true;
    this.state = "closed";
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Settle a connect() that is still waiting on the socket. The socket's
    // 'close' is ignored once it is detached below, so nothing else would ever
    // settle that promise — and its resolvers would block every later connect().
    if (this.connectReject) {
      const reject = this.connectReject;
      this.connectResolve = null;
      this.connectReject = null;
      reject(new ConnectionError("client disconnected before the connection opened"));
    }
    this.failAllPending(new ConnectionError("client disconnected"));
    this.bucket.rejectAll(new ConnectionError("client disconnected"));
    const ws = this.ws;
    this.ws = null;
    if (!ws) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => resolve();
      ws.once("close", done);
      try {
        ws.close();
      } catch {
        resolve();
        return;
      }
      // Safety net: resolve even if 'close' never fires.
      const t = setTimeout(() => {
        ws.removeListener("close", done);
        resolve();
      }, 1000);
      if (typeof t === "object" && t.unref) t.unref();
    });
  }

  private openSocket(): void {
    this.state = this.reconnectAttempts > 0 ? "reconnecting" : "connecting";
    let route: { url: string; protocols: string[] };
    try {
      route = this.resolveRoute();
    } catch (err) {
      this.handleOpenFailure(err as Error);
      return;
    }
    this.lastRoute = route.protocols.length > 0 ? "companion" : "direct";
    let ws: WebSocket;
    try {
      ws = this.wsFactory(route.url, route.protocols);
    } catch (err) {
      this.handleOpenFailure(new ConnectionError("failed to construct WebSocket", { cause: err }));
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    // Every handler is bound to the socket it was registered on and ignores it
    // once it is no longer the current one (detached by disconnect(), or
    // replaced). A late event from an old socket must never be mistaken for one
    // from its successor.
    const current = (): boolean => this.ws === ws;

    // A refused handshake (a non-101 answer). The companion socket answers 403
    // to a rejected auth token and 404 to an unknown server id. Listening here
    // stops `ws` from aborting by itself with a bare "Unexpected server
    // response"; terminate() then aborts it, emitting 'error' and 'close' as
    // usual. The typed failure replaces the generic error, and rejects a
    // pending connect() in place of "closed before open".
    let handshakeFailure: Error | undefined;
    ws.on("unexpected-response", (_req, res) => {
      if (!current()) return;
      handshakeFailure = handshakeError(res.statusCode ?? 0);
      this.emitError(handshakeFailure);
      ws.terminate();
    });
    ws.on("open", () => {
      if (current()) this.handleOpen();
    });
    ws.on("message", (data: WebSocket.RawData) => {
      if (current()) this.handleMessage(data);
    });
    ws.on("error", (err: Error) => {
      if (current() && !handshakeFailure) this.handleSocketError(err);
    });
    ws.on("close", (code: number, reason: Buffer) =>
      this.handleClose(ws, code, reason?.toString() ?? "", handshakeFailure),
    );
  }

  private handleOpen(): void {
    this.state = "connected";
    const wasReconnect = this.reconnectAttempts > 0;
    this.reconnectAttempts = 0;
    this.authRefusals = 0;
    // Resolve the pending connect() promise (first connect only).
    if (this.connectResolve) {
      this.connectResolve();
      this.connectResolve = null;
      this.connectReject = null;
    }
    this.emit("connected");
    if (wasReconnect && this.options.resubscribeOnReconnect !== false) {
      // Re-subscribe to tracked entities so the server resumes broadcasting
      // their changes. Fire-and-forget; failures surface as
      // 'error' events but must not crash the reconnect.
      void this.resubscribeEntities();
    }
  }

  private async resubscribeEntities(): Promise<void> {
    for (const entityId of this.trackedEntities) {
      try {
        await this.getEntityInfo(entityId);
      } catch (err) {
        this.emitError(
          err instanceof Error ? err : new ProtocolError("re-subscribe failed", { cause: err }),
        );
      }
    }
  }

  private handleSocketError(err: Error): void {
    // `ws` emits 'error' then 'close'; surface it but let 'close' drive recovery.
    this.emitError(new ConnectionError(err.message, { cause: err }));
  }

  /**
   * Emit an `error` event without crashing the process when no listener is
   * attached. Node's EventEmitter throws on a listener-less `error` emit; a
   * library should never take the host down for an out-of-band transport error,
   * so we swallow it when unobserved (request rejections still propagate via
   * their promises).
   */
  private emitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }

  private handleOpenFailure(err: Error): void {
    this.rejectPendingConnect(err);
    if (err instanceof AuthError) {
      // No token to offer and no direct address: nothing was dialled, and
      // waiting changes nothing. Stop until the host has a token and connects.
      this.state = "closed";
      return;
    }
    this.scheduleReconnect();
  }

  /** Reject a `connect()` that is still pending, if there is one. */
  private rejectPendingConnect(err: Error): void {
    if (!this.connectReject) return;
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    reject(err);
  }

  /**
   * The companion socket refused the auth token. Try again after the next wait
   * in {@link AUTH_RETRY_DELAYS_MS}; once those are used up, stop and report it.
   */
  private handleAuthRefusal(err: AuthError): void {
    const { enabled, maxRetries } = this.reconnectConfig;
    const delay = AUTH_RETRY_DELAYS_MS[this.authRefusals];
    if (enabled && delay !== undefined && this.reconnectAttempts < maxRetries) {
      this.authRefusals += 1;
      this.scheduleReconnect(delay);
      return;
    }
    this.authRefusals = 0;
    this.state = "closed";
    this.emit("authRejected", err);
  }

  private handleClose(ws: WebSocket, code: number, reason: string, failure?: Error): void {
    // 'close' is the last event a socket emits; drop its listeners either way.
    ws.removeAllListeners();
    // Not the current socket: disconnect() already detached it (and settled
    // everything that was waiting on it), or a newer socket has replaced it.
    // Its close says nothing about the live connection.
    if (this.ws !== ws) return;

    this.ws = null;
    this.failAllPending(new ConnectionError(`socket closed (${code})`));

    this.state = "idle";
    this.emit("disconnected", { code, reason });

    // A connect() still pending fails with this close, so its caller learns why
    // at once; the retries below carry on without it.
    this.rejectPendingConnect(
      failure ?? new ConnectionError(`connection closed before open (${code})`),
    );

    if (failure instanceof AuthError) {
      this.handleAuthRefusal(failure);
      return;
    }
    // Only refusals in a row count against the token.
    this.authRefusals = 0;
    this.scheduleReconnect();
  }

  /** Schedule the next attempt: after `fixedDelayMs`, or else the backoff. */
  private scheduleReconnect(fixedDelayMs?: number): void {
    if (!this.reconnectConfig.enabled) {
      this.state = "closed";
      return;
    }
    if (this.reconnectAttempts >= this.reconnectConfig.maxRetries) {
      this.state = "closed";
      this.emitError(
        new ConnectionError(`giving up after ${this.reconnectAttempts} reconnect attempts`),
      );
      return;
    }
    const delay = fixedDelayMs ?? this.computeBackoff(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.state = "reconnecting";
    this.emit("reconnecting", { attempt: this.reconnectAttempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose) return;
      this.openSocket();
    }, delay);
    if (typeof this.reconnectTimer === "object" && this.reconnectTimer?.unref) {
      this.reconnectTimer.unref();
    }
  }

  /** Exponential backoff with jitter, capped. */
  private computeBackoff(attempt: number): number {
    const { initialDelayMs, maxDelayMs, factor, jitter } = this.reconnectConfig;
    const base = Math.min(maxDelayMs, initialDelayMs * Math.pow(factor, attempt));
    const rand = (Math.random() * 2 - 1) * jitter; // ±jitter
    return Math.max(0, Math.round(base * (1 + rand)));
  }

  // ── Message handling ─────────────────────────────────────────────────────

  private handleMessage(data: WebSocket.RawData): void {
    let message: rustplus.AppMessage;
    try {
      const bytes = toUint8Array(data);
      message = decodeMessage(bytes);
    } catch (err) {
      this.emitError(new ProtocolError("failed to decode AppMessage", { cause: err }));
      return;
    }

    if (message.response) {
      // protobufjs decodes nested messages into concrete instances, so the
      // statically-`IAppResponse` field is an `AppResponse` at runtime.
      this.handleResponse(message.response as rustplus.AppResponse);
      return;
    }
    if (message.broadcast) {
      this.handleBroadcast(message);
      return;
    }
    // Empty message — ignore.
  }

  private handleResponse(response: rustplus.AppResponse): void {
    const seq = response.seq;
    const pending = this.pending.get(seq);
    if (!pending) {
      // Unmatched response (e.g. after a timeout already fired) — ignore.
      return;
    }
    this.pending.delete(seq);
    clearTimeout(pending.timer);

    if (response.error) {
      // protobufjs decodes an absent `optional string` to its prototype default
      // `""`, never `undefined`, so this has to be a falsy check.
      const errStr = response.error.error || "unknown";
      if (AUTH_ERROR_STRINGS.has(errStr)) {
        pending.reject(new AuthError(`server rejected request: ${errStr}`));
      } else if (errStr === "rate_limit") {
        // The server's bucket (per steamId, so shared with the player's phone
        // app) is empty, and refusing this request cost it a further token.
        // Empty ours too, so nothing more is sent until it has refilled:
        // otherwise each retry digs the server's balance deeper, and at -10 the
        // server closes the socket without a word.
        this.bucket.exhaust(1);
        pending.reject(new RateLimitError(`server rate limit: ${errStr}`));
      } else if (errStr === PLAYER_ONLINE) {
        pending.reject(
          new CameraUnavailableError(`server error: ${errStr} (the player is connected in-game)`, {
            reason: "playerOnline",
          }),
        );
      } else {
        // Including `not_found`, which `send` classifies once it knows which
        // request it answered.
        pending.reject(
          new ProtocolError(`server error: ${errStr}`, {
            serverError: errStr,
          }),
        );
      }
      return;
    }
    pending.resolve(response);
  }

  private handleBroadcast(message: rustplus.AppMessage): void {
    // Always surface the raw broadcast.
    this.emit("message", message);
    const broadcast = message.broadcast;
    if (!broadcast) return;

    if (broadcast.entityChanged) {
      let change: EntityChange;
      try {
        change = mapEntityChange(broadcast.entityChanged);
      } catch (err) {
        // An id we cannot hold exactly: report it, keep the connection.
        this.emitError(err instanceof Error ? err : new ProtocolError(String(err)));
        return;
      }
      this.emit("entityChanged", change);
    }
    if (broadcast.teamMessage?.message) {
      this.emit("teamChat", mapTeamChatMessage(broadcast.teamMessage.message));
    }
  }

  private failAllPending(err: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const p of entries) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  // ── Request plumbing ───────────────────────────────────────────────────────

  private nextSeq(): number {
    // uint32; wrap and skip 0 (0 is a valid response seq but we never want to
    // collide with an "unset" default).
    this.seq = (this.seq + 1) >>> 0;
    if (this.seq === 0) this.seq = 1;
    return this.seq;
  }

  /**
   * Low-level send: rate-limit, assign a `seq`, encode, and await the correlated
   * response. The `partial` carries exactly one request-payload field
   * (e.g. `{ getInfo: {} }`). A `not_found` answer rejects as a raw
   * {@link ProtocolError}; {@link send} classifies it.
   */
  private async sendOnce(
    partial: Partial<rustplus.IAppRequest>,
    costKind: RequestCostKind = "default",
  ): Promise<rustplus.AppResponse> {
    await this.bucket.acquire(this.costs[costKind] ?? this.costs.default);

    if (this.state !== "connected" || !this.ws) {
      throw new ConnectionError("not connected");
    }

    const seq = this.nextSeq();
    const request: rustplus.IAppRequest = {
      seq,
      playerId: Long.fromString(this.options.playerId, true),
      playerToken: Number(this.options.playerToken),
      ...partial,
    };

    let bytes: Uint8Array;
    try {
      bytes = encodeRequest(request);
    } catch (err) {
      throw new ProtocolError("failed to encode AppRequest", { cause: err });
    }

    return new Promise<rustplus.AppResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new ConnectionError(`request ${seq} timed out`));
      }, this.requestTimeoutMs);
      if (typeof timer === "object" && timer.unref) timer.unref();

      this.pending.set(seq, { resolve, reject, timer });

      try {
        this.ws!.send(bytes, (err) => {
          if (err) {
            const p = this.pending.get(seq);
            if (p) {
              this.pending.delete(seq);
              clearTimeout(p.timer);
            }
            reject(new ConnectionError("send failed", { cause: err }));
          }
        });
      } catch (err) {
        this.pending.delete(seq);
        clearTimeout(timer);
        reject(new ConnectionError("send threw", { cause: err }));
      }
    });
  }

  /**
   * Escape hatch: send a fully-formed {@link rustplus.AppRequest}
   * and receive the raw {@link rustplus.AppResponse}. `seq`, `playerId`, and
   * `playerToken` are overwritten with the client's own values, so callers only
   * supply the payload field(s) and optional `entityId`.
   */
  async sendRequest(req: rustplus.IAppRequest): Promise<rustplus.AppResponse> {
    const { seq: _seq, playerId: _pid, playerToken: _pt, ...payload } = req;
    return this.send(payload, payload.getMap ? "getMap" : "default");
  }

  /**
   * Send a request and await its response, turning a `not_found` answer into
   * the error it actually means (see {@link classifyNotFound}).
   */
  private async send(
    partial: Partial<rustplus.IAppRequest>,
    costKind: RequestCostKind = "default",
  ): Promise<rustplus.AppResponse> {
    try {
      return await this.sendOnce(partial, costKind);
    } catch (err) {
      if (!isNotFoundAnswer(err)) throw err;
      throw await this.classifyNotFound(partial);
    }
  }

  /**
   * Work out what a `not_found` answer means. The server sends it for two
   * different failures (`CompanionServer` request validation):
   *
   * - The player check, run on almost every request, fails: `playerId` is 0 or
   *   `playerToken` is not the player's current token (they ran
   *   `app.regeneratetoken`). A credential failure → {@link AuthError}.
   * - The entity check, run on entity requests, fails: the entity is gone, is
   *   not a smart device, or sits under a tool cupboard the player is not
   *   authorised on → {@link EntityNotFoundError}.
   *
   * A request that names no entity can only have failed the player check. For
   * an entity request, a `getTime` probe (which runs only the player check)
   * tells the two apart. If the probe fails some other way (timeout, dropped
   * socket, rate limit) the cause stays unknown and the probe's error is
   * returned, so an entity is not untracked on a guess.
   */
  private async classifyNotFound(partial: Partial<rustplus.IAppRequest>): Promise<Error> {
    const name = requestName(partial);
    const entityId = partial.entityId;
    if (entityId === undefined || entityId === null) {
      return new AuthError(
        `server answered ${NOT_FOUND} to ${name}: the playerId/playerToken were rejected`,
        { credential: "playerToken" },
      );
    }
    let credentialsOk: boolean;
    try {
      credentialsOk = await this.probeCredentials();
    } catch (probeErr) {
      return probeErr instanceof Error
        ? probeErr
        : new ConnectionError("credential probe failed", { cause: probeErr });
    }
    if (!credentialsOk) {
      return new AuthError(
        `server answered ${NOT_FOUND} to ${name} for entity ${entityId} and to a ` +
          "credential probe: the playerId/playerToken were rejected",
        { credential: "playerToken" },
      );
    }
    return new EntityNotFoundError(
      `entity ${entityId} ${NOT_FOUND}: removed, not a smart device, or not covered by a ` +
        "tool cupboard the player is authorised on",
    );
  }

  /**
   * Resolve `true` when the server accepts this client's credentials (a
   * `getTime` succeeds), `false` when it answers `not_found`. Concurrent
   * callers share one probe.
   */
  private probeCredentials(): Promise<boolean> {
    if (!this.credentialProbe) {
      this.credentialProbe = this.sendOnce({ getTime: {} }, "getTime")
        .then(
          () => true,
          (err: unknown) => {
            if (isNotFoundAnswer(err)) return false;
            throw err;
          },
        )
        .finally(() => {
          this.credentialProbe = null;
        });
    }
    return this.credentialProbe;
  }

  // ── Typed convenience wrappers ─────────────────────────────────────────────

  /** Fetch static + live server info (`getInfo`). */
  async getInfo(): Promise<ServerInfo> {
    const res = await this.send({ getInfo: {} }, "getInfo");
    if (!res.info) throw new ProtocolError("getInfo: missing info in response");
    return mapServerInfo(res.info);
  }

  /** Fetch the in-game clock (`getTime`). */
  async getTime(): Promise<GameTime> {
    const res = await this.send({ getTime: {} }, "getTime");
    if (!res.time) throw new ProtocolError("getTime: missing time in response");
    return mapGameTime(res.time);
  }

  /** Fetch the operator's team roster (`getTeamInfo`). */
  async getTeamInfo(): Promise<TeamInfo> {
    const res = await this.send({ getTeamInfo: {} }, "getTeamInfo");
    if (!res.teamInfo) {
      throw new ProtocolError("getTeamInfo: missing teamInfo in response");
    }
    return mapTeamInfo(res.teamInfo);
  }

  /**
   * Fetch a single entity's state (`getEntityInfo`). Also registers the entity
   * as "tracked", so the client re-issues this request on reconnect — the server
   * only broadcasts entity changes after a prior `getEntityInfo`.
   *
   * Tracking is recorded up front and survives a transient failure (a timeout,
   * a dropped socket) and a credential failure: the reconnect re-subscription
   * is what retries it. It is undone on an {@link EntityNotFoundError}: the
   * server will not let this player reach the entity (removed in-game, the
   * server wiped, or the player lost tool-cupboard authorisation), so
   * re-requesting it on every reconnect would only spend rate-limit tokens to
   * raise the same error again. Use {@link untrackEntity} to stop tracking an
   * entity that still exists.
   *
   * @throws {AuthError} when the server rejects the credentials. It answers
   *   `not_found` then, as for a missing entity; a `getTime` probe tells the
   *   two apart.
   * @throws {EntityNotFoundError} when the credentials are good but the entity
   *   cannot be reached.
   */
  async getEntityInfo(entityId: number): Promise<EntityInfo> {
    this.trackedEntities.add(entityId);
    let res: rustplus.AppResponse;
    try {
      res = await this.send(
        { entityId: entityIdToWire(entityId), getEntityInfo: {} },
        "getEntityInfo",
      );
    } catch (err) {
      if (err instanceof EntityNotFoundError) this.trackedEntities.delete(entityId);
      throw err;
    }
    if (!res.entityInfo) {
      throw new ProtocolError("getEntityInfo: missing entityInfo in response");
    }
    const info = mapEntityInfo(res.entityInfo);
    info.entityId = entityId;
    return info;
  }

  /**
   * Set a switch/alarm on or off (`setEntityValue`). Resolves once the server
   * acknowledges with `AppSuccess`; the confirming state change arrives later as
   * an `entityChanged` broadcast.
   */
  async setEntityValue(entityId: number, value: boolean): Promise<void> {
    const res = await this.send(
      { entityId: entityIdToWire(entityId), setEntityValue: { value } },
      "setEntityValue",
    );
    if (!res.success) {
      throw new ProtocolError("setEntityValue: server did not acknowledge with success");
    }
  }

  /** Send a message to team chat (`sendTeamMessage`). */
  async sendTeamMessage(message: string): Promise<void> {
    const res = await this.send({ sendTeamMessage: { message } }, "sendTeamMessage");
    if (!res.success) {
      throw new ProtocolError("sendTeamMessage: server did not acknowledge with success");
    }
  }

  /**
   * Stop tracking an entity so it is no longer re-subscribed on reconnect. Does
   * not unsubscribe server-side (the protocol has no such request); it only
   * affects this client's reconnect behaviour.
   */
  untrackEntity(entityId: number): void {
    this.trackedEntities.delete(entityId);
  }

  /** Entity ids currently tracked for reconnect re-subscription. */
  get tracked(): readonly number[] {
    return [...this.trackedEntities];
  }

  /**
   * Capture a single still image from an in-game CCTV camera.
   *
   * Subscribes via `cameraSubscribe` (using the string `cameraId` the player set on
   * the Computer Station), collects `AppCameraRays` broadcasts until enough frames
   * accrue for a clean image (or {@link RustPlusClientOptions.cameraCaptureTimeoutMs}
   * elapses), renders them to a PNG, then `cameraUnsubscribe`s (best-effort).
   *
   * @throws {ConnectionError} if not connected or the socket drops mid-capture.
   * @throws {CameraUnavailableError} with `reason`:
   *   - `playerOnline` if the server answers `player_online`: it will not show a
   *     camera while the paired player is connected to it in-game;
   *   - `notFound` if the subscribe response lacks `cameraSubscribeInfo` (camera
   *     missing/renamed);
   *   - `noFrames` if no rays arrive before the timeout (which may also mean the
   *     player is in-game).
   */
  async captureCameraFrame(cameraId: string): Promise<Uint8Array> {
    if (!this.connected) throw new ConnectionError("not connected");

    const sub = await this.send({ cameraSubscribe: { cameraId } }, "camera");
    const info = sub.cameraSubscribeInfo;
    if (!info || !info.width || !info.height) {
      await this.cameraUnsubscribeQuiet();
      throw new CameraUnavailableError(
        `cameraSubscribe(${cameraId}): missing cameraSubscribeInfo (camera unavailable)`,
        { reason: "notFound" },
      );
    }
    const width = info.width;
    const height = info.height;
    const frames: CameraRayFrame[] = [];
    const TARGET_FRAMES = 15;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (err?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.off("message", onMessage);
          this.off("disconnected", onDrop);
          if (err) reject(err);
          else resolve();
        };
        const onMessage = (msg: rustplus.AppMessage): void => {
          const rays = msg.broadcast?.cameraRays;
          if (!rays) return;
          frames.push({
            sampleOffset: rays.sampleOffset ?? 0,
            rayData: rays.rayData ?? new Uint8Array(),
          });
          if (frames.length >= TARGET_FRAMES) finish();
        };
        const onDrop = (): void =>
          finish(new ConnectionError("disconnected during camera capture"));
        const timer = setTimeout(() => {
          if (frames.length > 0) {
            finish(); // render a partial frame from what arrived
          } else {
            finish(
              new CameraUnavailableError(
                `captureCameraFrame(${cameraId}): no cameraRays before timeout ` +
                  "(camera may be unviewable while a player is connected in-game)",
                { reason: "noFrames" },
              ),
            );
          }
        }, this.cameraCaptureTimeoutMs);
        if (typeof timer === "object" && timer.unref) timer.unref();

        this.on("message", onMessage);
        this.once("disconnected", onDrop);
      });
      return await renderFrames(width, height, frames);
    } finally {
      await this.cameraUnsubscribeQuiet();
    }
  }

  /** Best-effort `cameraUnsubscribe` that swallows errors (used for cleanup). */
  private async cameraUnsubscribeQuiet(): Promise<void> {
    try {
      if (this.connected) await this.send({ cameraUnsubscribe: {} }, "camera");
    } catch {
      /* fire-and-forget: releasing the camera must not surface its own failure */
    }
  }

  /**
   * @deprecated Prefer {@link captureCameraFrame}. Frames are accumulated, not
   * index-addressed, so `frame` is ignored. Retained for the existing call site.
   */
  getCameraFrame(identifier: string, frame: number): Promise<Uint8Array> {
    void frame;
    return this.captureCameraFrame(identifier);
  }
}

/** Normalize the various `ws` RawData forms into a `Uint8Array`. */
function toUint8Array(data: WebSocket.RawData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    // Array of Buffer fragments.
    return new Uint8Array(Buffer.concat(data));
  }
  // Buffer (a Uint8Array subclass) or a typed array view.
  const view = data as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}
