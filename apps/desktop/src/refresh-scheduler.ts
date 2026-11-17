/**
 * Credential-refresh scheduler.
 *
 * The Steam auth token returned by the Companion API expires after ~2 weeks.
 * When it nears expiry, the coordinator must call `bot-core.refreshCredentials()`
 * (which refreshes via fcm, persists the new credentials, and reconnects affected
 * clients). This module keeps the *decision* — "should we refresh now?" — as a
 * pure function and the *loop* as a small driver that injects a clock + the
 * refresh fn, so all the logic is unit-testable without Electron timers.
 *
 * The loop also wakes at each Steam sign-in reminder milestone (bot-core's
 * `AUTH_RENEWAL_MILESTONES_MS`, down to one minute before expiry), so the
 * coordinator's `afterCheck` asks bot-core for a reminder when it falls due.
 */

import { nextAuthRenewalMilestoneAt, type TimerProvider } from "@conduit/bot-core";

/** Two days — refresh once the token is within this window of expiry. */
export const DEFAULT_REFRESH_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000;

/** Pure decision input. */
export interface RefreshDecisionInput {
  /** ISO-8601 expiry of the current Steam token (`StoredCredentials.steamTokenExpiresAt`). */
  steamTokenExpiresAt: string | undefined;
  /** Current time (ms epoch). */
  now: number;
  /** Refresh when `expiry - now <= threshold` (defaults to {@link DEFAULT_REFRESH_THRESHOLD_MS}). */
  thresholdMs?: number;
}

/**
 * Pure predicate: should we refresh the Steam token now? True when the token is
 * within the threshold of expiry (or already expired). A missing/invalid expiry
 * is treated as "refresh" so a corrupt timestamp self-heals on the next tick.
 */
export function shouldRefresh(input: RefreshDecisionInput): boolean {
  const threshold = input.thresholdMs ?? DEFAULT_REFRESH_THRESHOLD_MS;
  if (!input.steamTokenExpiresAt) return true;
  const expiry = Date.parse(input.steamTokenExpiresAt);
  if (Number.isNaN(expiry)) return true;
  return expiry - input.now <= threshold;
}

/** Milliseconds until the token renews (clamped to >= 0); for the tray caption. */
export function msUntilExpiry(steamTokenExpiresAt: string | undefined, now: number): number {
  if (!steamTokenExpiresAt) return 0;
  const expiry = Date.parse(steamTokenExpiresAt);
  if (Number.isNaN(expiry)) return 0;
  return Math.max(0, expiry - now);
}

/** Dependencies injected into {@link runRefreshCheck} / {@link RefreshScheduler}. */
export interface RefreshSchedulerDeps {
  /** Read the current token expiry (undefined when no credentials are stored). */
  getExpiry(): Promise<string | undefined>;
  /** Perform the refresh (bot-core.refreshCredentials), persist + reconnect. */
  refresh(): Promise<void>;
  /** Current time (ms epoch); injectable for tests. */
  now(): number;
  /** Refresh threshold (defaults to {@link DEFAULT_REFRESH_THRESHOLD_MS}). */
  thresholdMs?: number;
  /**
   * Runs at the end of every check, after any refresh attempt (the coordinator
   * asks bot-core whether the operator must sign in again). Never fails the
   * check: a rejection is logged.
   */
  afterCheck?(): Promise<void>;
  /** Optional logger. */
  log?: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

/** Outcome of one check (returned for tests + logging). */
export interface RefreshCheckResult {
  /** Whether a refresh was attempted this tick. */
  attempted: boolean;
  /** Whether the attempt succeeded (false if it threw; only set when attempted). */
  succeeded?: boolean;
}

/**
 * Run exactly one refresh check (the pure-ish unit the loop calls each tick).
 * Reads the expiry, decides via {@link shouldRefresh}, and refreshes if due.
 * Never throws: a failed refresh is caught so the loop keeps running and retries
 * next tick.
 */
export async function runRefreshCheck(deps: RefreshSchedulerDeps): Promise<RefreshCheckResult> {
  const result = await refreshIfDue(deps);
  if (deps.afterCheck) {
    try {
      await deps.afterCheck();
    } catch (err) {
      deps.log?.warn({ err }, "credential refresh: post-check failed");
    }
  }
  return result;
}

async function refreshIfDue(deps: RefreshSchedulerDeps): Promise<RefreshCheckResult> {
  const expiry = await deps.getExpiry();
  if (
    !shouldRefresh({
      steamTokenExpiresAt: expiry,
      now: deps.now(),
      thresholdMs: deps.thresholdMs,
    })
  ) {
    return { attempted: false };
  }
  // No credentials at all → nothing to refresh yet (pre-bootstrap).
  if (expiry === undefined) return { attempted: false };

  try {
    await deps.refresh();
    deps.log?.info({}, "credential refresh: succeeded");
    return { attempted: true, succeeded: true };
  } catch (err) {
    deps.log?.warn({ err }, "credential refresh: failed (will retry)");
    return { attempted: true, succeeded: false };
  }
}

/** Default poll interval: hourly. The refresh threshold is days, so this is ample. */
export const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Pure: how long to sleep after a check finished at `now`. The earlier of the
 * next hourly tick (`intervalMs` from now) and the next sign-in reminder
 * milestone for the token expiring at `steamTokenExpiresAt`.
 */
export function nextWakeDelayMs(
  steamTokenExpiresAt: string | undefined,
  now: number,
  intervalMs: number = DEFAULT_REFRESH_INTERVAL_MS,
): number {
  const milestoneAt = nextAuthRenewalMilestoneAt(steamTokenExpiresAt, now);
  if (milestoneAt === undefined) return intervalMs;
  return Math.min(intervalMs, milestoneAt - now);
}

const defaultTimers: TimerProvider = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * A thin driver around {@link runRefreshCheck}: runs a check at once, then
 * after each check sleeps until {@link nextWakeDelayMs} (the next hourly tick
 * or the next reminder milestone, whichever is first). Checks never overlap.
 * The timer is injectable; tests use fake timers.
 */
export class RefreshScheduler {
  private timer?: unknown;
  /** Bumped by start/stop, so a check in flight from an earlier run does not re-arm. */
  private generation = 0;
  private running = false;

  constructor(
    private readonly deps: RefreshSchedulerDeps,
    /** Longest sleep between checks. Default: hourly. */
    private readonly intervalMs: number = DEFAULT_REFRESH_INTERVAL_MS,
    private readonly timers: TimerProvider = defaultTimers,
  ) {}

  /** Start the loop. Runs an immediate check, then wakes as above. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.wake(++this.generation);
  }

  /** Stop the loop. A check already in flight finishes but arms nothing. */
  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer !== undefined) {
      this.timers.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private async wake(generation: number): Promise<void> {
    this.timer = undefined;
    let delay = this.intervalMs;
    try {
      await runRefreshCheck(this.deps);
      delay = nextWakeDelayMs(await this.deps.getExpiry(), this.deps.now(), this.intervalMs);
    } catch (err) {
      this.deps.log?.warn({ err }, "credential refresh: check failed (will retry)");
    }
    if (generation !== this.generation) return;
    this.timer = this.timers.setTimer(() => void this.wake(generation), delay);
    // Don't keep the process alive solely for this timer.
    (this.timer as { unref?: () => void } | undefined)?.unref?.();
  }
}
