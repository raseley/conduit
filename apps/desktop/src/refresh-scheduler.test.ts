import { afterEach, describe, it, expect, vi } from "vitest";

import {
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_REFRESH_THRESHOLD_MS,
  msUntilExpiry,
  nextWakeDelayMs,
  RefreshScheduler,
  runRefreshCheck,
  shouldRefresh,
} from "./refresh-scheduler.js";

const DAY = 24 * 60 * 60 * 1000;

describe("shouldRefresh", () => {
  const now = Date.parse("2026-06-13T00:00:00.000Z");

  it("does not refresh when the token is comfortably in the future", () => {
    const expiry = new Date(now + 9 * DAY).toISOString();
    expect(shouldRefresh({ steamTokenExpiresAt: expiry, now })).toBe(false);
  });

  it("refreshes within the 2-day threshold", () => {
    const expiry = new Date(now + 1 * DAY).toISOString();
    expect(shouldRefresh({ steamTokenExpiresAt: expiry, now })).toBe(true);
  });

  it("refreshes when already expired", () => {
    const expiry = new Date(now - 1 * DAY).toISOString();
    expect(shouldRefresh({ steamTokenExpiresAt: expiry, now })).toBe(true);
  });

  it("refreshes on a missing or invalid expiry (self-heal)", () => {
    expect(shouldRefresh({ steamTokenExpiresAt: undefined, now })).toBe(true);
    expect(shouldRefresh({ steamTokenExpiresAt: "not-a-date", now })).toBe(true);
  });

  it("honors a custom threshold", () => {
    const expiry = new Date(now + 5 * DAY).toISOString();
    expect(shouldRefresh({ steamTokenExpiresAt: expiry, now, thresholdMs: 6 * DAY })).toBe(true);
    expect(DEFAULT_REFRESH_THRESHOLD_MS).toBe(2 * DAY);
  });
});

describe("msUntilExpiry", () => {
  const now = Date.parse("2026-06-13T00:00:00.000Z");
  it("clamps to zero for past/invalid expiries", () => {
    expect(msUntilExpiry(new Date(now - DAY).toISOString(), now)).toBe(0);
    expect(msUntilExpiry(undefined, now)).toBe(0);
  });
  it("returns the remaining ms for a future expiry", () => {
    expect(msUntilExpiry(new Date(now + 3 * DAY).toISOString(), now)).toBe(3 * DAY);
  });
});

describe("runRefreshCheck", () => {
  const now = Date.parse("2026-06-13T00:00:00.000Z");

  it.each([
    ["far from expiry (no refresh)", 9],
    ["within the threshold (after the refresh)", 1],
  ])("runs afterCheck when %s", async (_label, days) => {
    const order: string[] = [];
    await runRefreshCheck({
      getExpiry: async () => new Date(now + days * DAY).toISOString(),
      refresh: async () => {
        order.push("refresh");
      },
      afterCheck: async () => {
        order.push("afterCheck");
      },
      now: () => now,
    });
    expect(order.at(-1)).toBe("afterCheck");
  });

  it("a failing afterCheck is logged, not thrown", async () => {
    const warn = vi.fn();
    const result = await runRefreshCheck({
      getExpiry: async () => new Date(now + 9 * DAY).toISOString(),
      refresh: vi.fn(),
      afterCheck: async () => {
        throw new Error("boom");
      },
      now: () => now,
      log: { info: vi.fn(), warn },
    });
    expect(result).toEqual({ attempted: false });
    expect(warn).toHaveBeenCalled();
  });

  it("does NOT refresh when the token is far from expiry", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const result = await runRefreshCheck({
      getExpiry: async () => new Date(now + 9 * DAY).toISOString(),
      refresh,
      now: () => now,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: false });
  });

  it("refreshes + reports success when within the threshold", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const result = await runRefreshCheck({
      getExpiry: async () => new Date(now + 1 * DAY).toISOString(),
      refresh,
      now: () => now,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ attempted: true, succeeded: true });
  });

  it("does not throw when refresh fails; reports failure for a retry", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("network"));
    const result = await runRefreshCheck({
      getExpiry: async () => new Date(now).toISOString(),
      refresh,
      now: () => now,
    });
    expect(result).toEqual({ attempted: true, succeeded: false });
  });

  it("no-ops when there are no credentials yet (pre-bootstrap)", async () => {
    const refresh = vi.fn();
    const result = await runRefreshCheck({
      getExpiry: async () => undefined,
      refresh,
      now: () => now,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: false });
  });
});

// Wake at each Steam sign-in reminder milestone, not only hourly, so an
// escalating reminder (48h before expiry down to expired) is never late.
describe("nextWakeDelayMs", () => {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const now = Date.parse("2026-06-13T00:00:00.000Z");
  const expiringIn = (ms: number) => new Date(now + ms).toISOString();

  it("is the hourly tick while the next milestone is further away", () => {
    expect(nextWakeDelayMs(expiringIn(10 * DAY), now)).toBe(DEFAULT_REFRESH_INTERVAL_MS);
    expect(nextWakeDelayMs(expiringIn(23 * HOUR), now)).toBe(HOUR);
  });

  it("is the next milestone when that comes before the hourly tick", () => {
    expect(nextWakeDelayMs(expiringIn(48 * HOUR + 10 * MIN), now)).toBe(10 * MIN);
    expect(nextWakeDelayMs(expiringIn(90 * MIN), now)).toBe(30 * MIN);
    expect(nextWakeDelayMs(expiringIn(3 * MIN), now)).toBe(2 * MIN);
    expect(nextWakeDelayMs(expiringIn(30 * 1000), now)).toBe(30 * 1000);
  });

  it("falls back to the hourly tick once expired or without an expiry", () => {
    expect(nextWakeDelayMs(expiringIn(-MIN), now)).toBe(DEFAULT_REFRESH_INTERVAL_MS);
    expect(nextWakeDelayMs(undefined, now)).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });
});

describe("RefreshScheduler", () => {
  const MIN = 60 * 1000;
  const START = Date.parse("2026-06-13T00:00:00.000Z");

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A scheduler whose refresh always fails (as after expiry) and records each step. */
  function harness(expiresAt: string | undefined) {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const steps: { step: "refresh" | "check"; at: number }[] = [];
    const scheduler = new RefreshScheduler({
      getExpiry: async () => expiresAt,
      refresh: async () => {
        steps.push({ step: "refresh", at: Date.now() - START });
        throw new Error("refused");
      },
      afterCheck: async () => {
        steps.push({ step: "check", at: Date.now() - START });
      },
      now: () => Date.now(),
    });
    const checksAt = () => steps.filter((s) => s.step === "check").map((s) => s.at);
    return { scheduler, steps, checksAt };
  }

  it("checks at once, then hourly while no milestone is near", async () => {
    const { scheduler, checksAt } = harness(new Date(START + 10 * DAY).toISOString());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(checksAt()).toEqual([0]);

    await vi.advanceTimersByTimeAsync(60 * MIN - 1);
    expect(checksAt()).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(checksAt()).toEqual([0, 60 * MIN]);
    scheduler.stop();
  });

  it("wakes at each milestone before the hourly tick, refreshing before each check", async () => {
    // 62 minutes left: milestones at 2 (1h), 32 (30 min), 57 (5 min), 61 (1 min), 62 (expiry).
    const { scheduler, steps, checksAt } = harness(new Date(START + 62 * MIN).toISOString());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(122 * MIN);

    expect(checksAt().slice(0, 6)).toEqual([0, 2, 32, 57, 61, 62].map((m) => m * MIN));
    // Expired: back to hourly.
    expect(checksAt()[6]).toBe(122 * MIN);
    // Every wake attempts the refresh first, then checks.
    for (let i = 0; i < steps.length; i += 2) {
      expect([steps[i]?.step, steps[i + 1]?.step]).toEqual(["refresh", "check"]);
      expect(steps[i]?.at).toBe(steps[i + 1]?.at);
    }
    scheduler.stop();
  });

  it("stop() arms nothing more", async () => {
    const { scheduler, checksAt } = harness(new Date(START + 62 * MIN).toISOString());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5 * 60 * MIN);
    expect(checksAt()).toEqual([0]);
  });
});
