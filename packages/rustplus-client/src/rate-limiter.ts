/**
 * Token-bucket rate limiter.
 *
 * The Rust+ game server enforces a token-bucket rate limit on the WebSocket and
 * a cap on concurrent connections. This module models the client side of that:
 * every outgoing request must first acquire its token cost. When the bucket is
 * exhausted, requests **queue** (FIFO) and drain as tokens refill — they are
 * never dropped. Per-request costs live in {@link DEFAULT_REQUEST_COSTS} and are
 * overridable.
 *
 * The defaults mirror the server, read from the decompiled `CompanionServer`
 * namespace (late-2023 builds; the `Ailtop/RustDocuments` and
 * `MillionthOdin16/RustChangelog` dumps agree):
 * - `Listener`: `new TokenBucketList<ulong>(25.0, 3.0)`, i.e. 25 tokens
 *   refilling at 3/s, keyed **per steamId**. The bucket is therefore shared with
 *   the player's phone app and any other client using the same steamId.
 * - `TokenCost` overrides: default 1; `getMap` 5; `sendTeamMessage` and
 *   `sendClanMessage` 2; `cameraInput` 0.01.
 * - A refused request still costs a token (`TokenBucket.TryTake`), and once
 *   the balance falls to -10 the server closes the socket without an error.
 *   So on a `rate_limit` answer the client empties its own bucket too
 *   ({@link TokenBucket.exhaust}) instead of retrying into a deeper deficit.
 */

import { RateLimitError } from "./errors.js";

/**
 * Configuration for the client-side token bucket. The defaults
 * ({@link DEFAULT_TOKEN_BUCKET}) are the server's own values.
 */
export interface TokenBucketConfig {
  /** Maximum tokens the bucket can hold. Default {@link DEFAULT_TOKEN_BUCKET}. */
  capacity: number;
  /** Tokens replenished per second. */
  refillPerSecond: number;
  /**
   * Default token cost for a request when no per-method override applies.
   * Defaults to `1`.
   */
  costPerRequest?: number;
}

/** Logical request kinds, used to look up a per-method token cost. */
export type RequestCostKind =
  | "default"
  | "getInfo"
  | "getTime"
  | "getTeamInfo"
  | "getEntityInfo"
  | "setEntityValue"
  | "sendTeamMessage"
  | "getMap"
  | "camera";

/**
 * Default per-method token costs: the server's `TokenCost` values (see the
 * module docs). `camera` (subscribe/unsubscribe) costs the server's default of
 * 1; we charge 5 so frame captures cannot crowd out control requests, which
 * over-reserves harmlessly. Overridable per client.
 */
export const DEFAULT_REQUEST_COSTS: Record<RequestCostKind, number> = {
  default: 1,
  getInfo: 1,
  getTime: 1,
  getTeamInfo: 1,
  getEntityInfo: 1,
  setEntityValue: 1,
  sendTeamMessage: 2,
  getMap: 5,
  camera: 5,
};

/** The server's bucket: 25 tokens, refilling at 3/s (see the module docs). */
export const DEFAULT_TOKEN_BUCKET: Required<TokenBucketConfig> = {
  capacity: 25,
  refillPerSecond: 3,
  costPerRequest: 1,
};

interface Waiter {
  cost: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * A refilling token bucket that queues acquisitions when empty. Time-based
 * refill is computed lazily from `Date.now()`, so it behaves correctly under
 * `vi.useFakeTimers()` (which fakes `Date.now`) as well as in production.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private tokens: number;
  private lastRefill: number;
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: TokenBucketConfig) {
    this.capacity = config.capacity;
    this.refillPerSecond = config.refillPerSecond;
    this.tokens = config.capacity;
    this.lastRefill = Date.now();
  }

  /** Tokens currently available (after a lazy refill). For tests/diagnostics. */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  /** Number of requests currently waiting on tokens. */
  get pending(): number {
    return this.queue.length;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;
  }

  /**
   * Acquire `cost` tokens, resolving immediately if available, otherwise
   * queueing (FIFO) until enough tokens have refilled. Never drops a request.
   *
   * @throws RateLimitError if `cost` exceeds the bucket capacity (it could never
   *   be satisfied).
   */
  acquire(cost: number): Promise<void> {
    if (cost > this.capacity) {
      return Promise.reject(
        new RateLimitError(
          `Request cost ${cost} exceeds bucket capacity ${this.capacity}; it can never be satisfied`,
        ),
      );
    }
    this.refill();
    // Only consume immediately if nothing is queued ahead (preserve FIFO order).
    if (this.queue.length === 0 && this.tokens >= cost) {
      this.tokens -= cost;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ cost, resolve, reject });
      this.scheduleDrain();
    });
  }

  /** Attempt to satisfy queued waiters in order, scheduling a retry if blocked. */
  private drain(): void {
    this.timer = null;
    this.refill();
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (this.tokens >= next.cost) {
        this.tokens -= next.cost;
        this.queue.shift();
        next.resolve();
      } else {
        break;
      }
    }
    if (this.queue.length > 0) {
      this.scheduleDrain();
    }
  }

  /** Schedule the next drain attempt for when the head waiter can be served. */
  private scheduleDrain(): void {
    if (this.timer !== null) return;
    const head = this.queue[0];
    if (!head) return;
    const deficit = head.cost - this.tokens;
    const waitMs = deficit <= 0 ? 0 : Math.ceil((deficit / this.refillPerSecond) * 1000);
    this.timer = setTimeout(() => this.drain(), Math.max(waitMs, 0));
    // Don't keep the event loop alive purely for a queued token refill.
    if (typeof this.timer === "object" && this.timer?.unref) {
      this.timer.unref();
    }
  }

  /**
   * Empty the bucket and take `penalty` more, so nothing is granted until it
   * has refilled past zero. Called when the server answers `rate_limit`: the
   * server's bucket is empty (it may be shared with another client) and it
   * charged the refused request a further token, so ours must stop granting
   * too. Queued waiters stay queued and are served once the balance recovers.
   */
  exhaust(penalty = 0): void {
    this.refill();
    this.tokens = Math.min(this.tokens, 0) - penalty;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleDrain();
  }

  /**
   * Reject every queued waiter (e.g. on disconnect) so callers don't hang.
   * Tokens are left untouched.
   */
  rejectAll(err: Error): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const waiters = this.queue.splice(0, this.queue.length);
    for (const w of waiters) {
      w.reject(err);
    }
  }
}
