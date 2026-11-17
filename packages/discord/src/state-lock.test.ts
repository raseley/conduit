/**
 * Focused unit suite for the switch state-lock machine.
 *
 * `index.test.ts` covers the headline click → confirm / timeout path through the
 * public surface; this suite pins every state and transition of the machine in
 * isolation: seeding, pending entry, duplicate clicks, confirming and
 * non-matching reports, the timeout → warn → synced(prior) path, independence
 * across switches, and cleanup. Time is driven by a hand-rolled manual clock
 * injected through the `TimerProvider` seam — no real sleeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  StateLockMachine,
  type LockKey,
  type LockResult,
  type TimerProvider,
} from "./state-lock.js";

// ── fakes + fixtures ─────────────────────────────────────────────────────────

/** A manual clock: timers only fire when the test advances it. */
class ManualTimers implements TimerProvider {
  /** Every `ms` passed to `setTimer`, in call order. */
  readonly armedWith: number[] = [];
  /** Every handle returned by `setTimer`, in call order. */
  readonly handles: number[] = [];
  /** Every handle passed to `clearTimer`, in call order. */
  readonly cleared: unknown[] = [];
  /** Every callback ever armed, kept even after it is cleared or fired. */
  readonly callbacks: Array<() => void> = [];

  private nowMs = 0;
  private nextHandle: number;
  private readonly live = new Map<number, { at: number; cb: () => void }>();

  /**
   * Handles count up from `firstHandle`. The default of 1 makes every handle
   * truthy, like a Node `Timeout`; pass 0 to model a provider whose first handle
   * is falsy (the seam types handles as `unknown`, so that is allowed).
   */
  constructor(firstHandle = 1) {
    this.nextHandle = firstHandle;
  }

  setTimer(cb: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.live.set(handle, { at: this.nowMs + ms, cb });
    this.armedWith.push(ms);
    this.handles.push(handle);
    this.callbacks.push(cb);
    return handle;
  }

  clearTimer(handle: unknown): void {
    this.cleared.push(handle);
    this.live.delete(handle as number);
  }

  /** Number of timers armed and not yet fired or cleared. */
  get liveCount(): number {
    return this.live.size;
  }

  /** Move the clock forward, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.live.entries()]
        .filter(([, t]) => t.at <= target)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.live.delete(handle);
      this.nowMs = timer.at;
      timer.cb();
    }
    this.nowMs = target;
  }
}

const TIMEOUT_MS = 1000;

function makeKey(overrides: Partial<LockKey> = {}): LockKey {
  return { serverId: "s1", entityId: 5, ...overrides };
}

interface TimeoutCall {
  key: LockKey;
  result: LockResult;
}

/** A machine wired to a manual clock, recording every `onTimeout` call. */
function makeMachine(
  overrides: {
    timeoutMs?: number;
    onTimeout?: (key: LockKey, result: LockResult) => void;
    /** First handle the timer source hands out (default 1; 0 = a falsy handle). */
    firstHandle?: number;
  } = {},
) {
  const timers = new ManualTimers(overrides.firstHandle);
  const timeouts: TimeoutCall[] = [];
  const machine = new StateLockMachine({
    timeoutMs: overrides.timeoutMs ?? TIMEOUT_MS,
    timers,
    onTimeout: (key, result) => {
      timeouts.push({ key, result });
      overrides.onTimeout?.(key, result);
    },
  });
  return { machine, timers, timeouts };
}

// ── seed / snapshot ──────────────────────────────────────────────────────────

describe("StateLockMachine: seed + snapshot", () => {
  it("has no snapshot for a switch it has never seen", () => {
    const { machine } = makeMachine();
    expect(machine.snapshot(makeKey())).toBeUndefined();
  });

  it.each([true, false])("seeds a synced, enabled snapshot showing %s", (value) => {
    const { machine, timers } = makeMachine();
    const key = makeKey();

    machine.seed(key, value);

    expect(machine.snapshot(key)).toEqual({ phase: "synced", value, buttonsDisabled: false });
    expect(timers.armedWith).toEqual([]);
  });

  it("re-seeding replaces the confirmed value", () => {
    const { machine } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);

    machine.seed(key, false);

    expect(machine.snapshot(key)?.value).toBe(false);
  });

  it("looks a switch up by value, not by key object identity", () => {
    const { machine } = makeMachine();
    machine.seed(makeKey(), true);
    expect(machine.snapshot(makeKey())?.value).toBe(true);
  });

  it("hands out detached snapshots", () => {
    const { machine } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);

    const snap = machine.snapshot(key);
    if (!snap) throw new Error("expected a snapshot");
    snap.value = false;
    snap.phase = "pending";
    snap.buttonsDisabled = true;

    expect(machine.snapshot(key)).toEqual({ phase: "synced", value: true, buttonsDisabled: false });
  });
});

// ── click → pending ──────────────────────────────────────────────────────────

describe("StateLockMachine: click", () => {
  it("enters pending with buttons disabled, still showing the last confirmed value", () => {
    const { machine } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);

    const result = machine.click(key, false);

    expect(result).toEqual({
      snapshot: { phase: "pending", value: true, buttonsDisabled: true, requested: false },
      changed: true,
      warn: false,
    });
    expect(machine.snapshot(key)).toEqual(result.snapshot);
  });

  it("arms exactly one timer for the configured timeout", () => {
    const { machine, timers } = makeMachine({ timeoutMs: 7500 });
    const key = makeKey();
    machine.seed(key, false);

    machine.click(key, true);

    expect(timers.armedWith).toEqual([7500]);
    expect(timers.liveCount).toBe(1);
    expect(timers.cleared).toEqual([]);
  });

  it("locks a never-seeded switch too", () => {
    const { machine, timers } = makeMachine();
    const key = makeKey();

    const result = machine.click(key, true);

    expect(result.changed).toBe(true);
    expect(result.snapshot.phase).toBe("pending");
    expect(result.snapshot.buttonsDisabled).toBe(true);
    expect(timers.liveCount).toBe(1);
  });

  it.each([true, false])(
    "does not present requested=%s as the value of a never-seeded switch",
    (requested) => {
      const { machine } = makeMachine();
      const key = makeKey();

      const result = machine.click(key, requested);

      // Pending, but with no confirmed value: the request is not a confirmation.
      expect(result.snapshot).toEqual({ phase: "pending", buttonsDisabled: true, requested });
      expect(result.snapshot.value).toBeUndefined();
      expect(machine.snapshot(key)?.value).toBeUndefined();
    },
  );

  it("ignores a duplicate click while pending and does not re-arm the timer", () => {
    const { machine, timers } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    const second = machine.click(key, false);

    expect(second).toEqual({
      snapshot: { phase: "pending", value: true, buttonsDisabled: true, requested: false },
      changed: false,
      warn: false,
    });
    expect(timers.armedWith).toHaveLength(1);
    expect(timers.cleared).toEqual([]);
  });

  it("does not let a duplicate click extend the original deadline", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    timers.advance(TIMEOUT_MS - 1);
    machine.click(key, false);
    timers.advance(1);

    expect(timeouts).toHaveLength(1);
  });

  it("ignores an opposite click while pending, keeping the original prior state", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    const opposite = machine.click(key, true);

    expect(opposite.changed).toBe(false);
    expect(opposite.snapshot.phase).toBe("pending");
    expect(timers.armedWith).toHaveLength(1);

    timers.advance(TIMEOUT_MS);
    expect(timeouts).toHaveLength(1);
    expect(machine.snapshot(key)?.value).toBe(true);
  });
});

// ── confirm ──────────────────────────────────────────────────────────────────

describe("StateLockMachine: confirm", () => {
  it("closes a pending lock on the matching report and clears its timer", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    const result = machine.confirm(key, false);

    expect(result).toEqual({
      snapshot: { phase: "synced", value: false, buttonsDisabled: false },
      changed: true,
      warn: false,
    });
    expect(timers.cleared).toEqual([timers.handles[0]]);
    expect(timers.liveCount).toBe(0);

    timers.advance(TIMEOUT_MS * 10);
    expect(timeouts).toEqual([]);
  });

  it("closes a pending lock on a report that differs from the request, showing the reported value", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false); // asked for OFF…

    const result = machine.confirm(key, true); // …server reports it is still ON

    expect(result).toEqual({
      snapshot: { phase: "synced", value: true, buttonsDisabled: false },
      changed: true,
      warn: false,
    });
    expect(timers.liveCount).toBe(0);

    timers.advance(TIMEOUT_MS * 10);
    expect(timeouts).toEqual([]);
  });

  it("reports an unsolicited broadcast as changed only when the value differs", () => {
    const { machine, timers } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);

    const same = machine.confirm(key, true);
    expect(same.changed).toBe(false);
    expect(same.snapshot).toEqual({ phase: "synced", value: true, buttonsDisabled: false });

    const flipped = machine.confirm(key, false);
    expect(flipped.changed).toBe(true);
    expect(flipped.snapshot).toEqual({ phase: "synced", value: false, buttonsDisabled: false });

    expect(timers.cleared).toEqual([]);
  });

  it("starts tracking a never-seen switch from its first broadcast", () => {
    const { machine, timers } = makeMachine();
    const key = makeKey();

    const result = machine.confirm(key, true);

    expect(result).toEqual({
      snapshot: { phase: "synced", value: true, buttonsDisabled: false },
      changed: true,
      warn: false,
    });
    expect(machine.snapshot(key)).toEqual(result.snapshot);
    expect(timers.armedWith).toEqual([]);
  });

  it("allows a fresh click, with a fresh timer, once the lock has closed", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);
    machine.confirm(key, false);

    const again = machine.click(key, true);

    expect(again.changed).toBe(true);
    expect(again.snapshot).toEqual({
      phase: "pending",
      value: false,
      buttonsDisabled: true,
      requested: true,
    });
    expect(timers.armedWith).toHaveLength(2);
    expect(timers.liveCount).toBe(1);

    // The second lock times out against the value confirmed by the first.
    timers.advance(TIMEOUT_MS);
    expect(timeouts).toHaveLength(1);
    expect(machine.snapshot(key)?.value).toBe(false);
  });
});

// ── timeout → warn → synced(prior) ───────────────────────────────────────────

describe("StateLockMachine: timeout", () => {
  it("fires at the timeout and not a millisecond before", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    timers.advance(TIMEOUT_MS - 1);
    expect(timeouts).toEqual([]);
    expect(machine.snapshot(key)?.phase).toBe("pending");

    timers.advance(1);
    expect(timeouts).toHaveLength(1);
  });

  it.each([
    { prior: true, requested: false },
    { prior: false, requested: true },
  ])(
    "restores prior=$prior and re-enables buttons when requested=$requested is never confirmed",
    ({ prior, requested }) => {
      const { machine, timers } = makeMachine();
      const key = makeKey();
      machine.seed(key, prior);
      machine.click(key, requested);

      timers.advance(TIMEOUT_MS);

      expect(machine.snapshot(key)).toEqual({
        phase: "synced",
        value: prior,
        buttonsDisabled: false,
      });
    },
  );

  it.each([true, false])(
    "a never-seeded switch times out to unknown, not to requested=%s",
    (requested) => {
      const { machine, timers, timeouts } = makeMachine();
      const key = makeKey();
      machine.click(key, requested);

      timers.advance(TIMEOUT_MS);

      // Nothing was ever confirmed, so there is nothing to "restore": the
      // snapshot must not claim the state the member merely asked for.
      const settled = machine.snapshot(key);
      expect(settled).toEqual({ phase: "synced", buttonsDisabled: false });
      expect(settled?.value).toBeUndefined();
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]?.result).toEqual({
        snapshot: { phase: "warn", buttonsDisabled: false },
        changed: true,
        warn: true,
      });
      expect(timeouts[0]?.result.snapshot.value).toBeUndefined();
    },
  );

  it("an unknown switch learns its value from the first report after a timeout", () => {
    const { machine, timers } = makeMachine();
    const key = makeKey();
    machine.click(key, true);
    timers.advance(TIMEOUT_MS);

    const report = machine.confirm(key, false);

    expect(report).toEqual({
      snapshot: { phase: "synced", value: false, buttonsDisabled: false },
      changed: true,
      warn: false,
    });
  });

  it("a retry on a still-unknown switch stays unknown while pending", () => {
    const { machine, timers } = makeMachine();
    const key = makeKey();
    machine.click(key, true);
    timers.advance(TIMEOUT_MS);

    const retry = machine.click(key, true);

    expect(retry.changed).toBe(true);
    expect(retry.snapshot.phase).toBe("pending");
    expect(retry.snapshot.value).toBeUndefined();
  });

  it("hands onTimeout the switch key and a warn result carrying the restored value", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey({ serverId: "srv-a", entityId: 42 });
    machine.seed(key, true);
    machine.click(key, false);

    timers.advance(TIMEOUT_MS);

    expect(timeouts).toEqual([
      {
        key: { serverId: "srv-a", entityId: 42 },
        result: {
          snapshot: { phase: "warn", value: true, buttonsDisabled: false },
          changed: true,
          warn: true,
        },
      },
    ]);
  });

  it("has already settled back to synced by the time onTimeout runs", () => {
    const seenInCallback: unknown[] = [];
    const reclicks: LockResult[] = [];
    const key = makeKey();
    const { machine, timers } = makeMachine({
      onTimeout: (k) => {
        seenInCallback.push(machine.snapshot(k));
        if (reclicks.length === 0) reclicks.push(machine.click(k, false));
      },
    });
    machine.seed(key, true);
    machine.click(key, false);

    timers.advance(TIMEOUT_MS);

    expect(seenInCallback).toEqual([{ phase: "synced", value: true, buttonsDisabled: false }]);
    // A retry issued from inside the callback is accepted as a brand-new lock.
    expect(reclicks[0]?.changed).toBe(true);
    expect(machine.snapshot(key)?.phase).toBe("pending");
    expect(timers.liveCount).toBe(1);
  });

  it("fires only once per pending lock", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    timers.advance(TIMEOUT_MS * 20);

    expect(timeouts).toHaveLength(1);
    expect(timers.liveCount).toBe(0);
  });

  it("restores the prior state even when no onTimeout handler is wired", () => {
    const timers = new ManualTimers();
    const machine = new StateLockMachine({ timeoutMs: TIMEOUT_MS, timers });
    const key = makeKey();
    machine.seed(key, false);
    machine.click(key, true);

    expect(() => timers.advance(TIMEOUT_MS)).not.toThrow();

    expect(machine.snapshot(key)).toEqual({
      phase: "synced",
      value: false,
      buttonsDisabled: false,
    });
  });

  it("still applies a confirming report that arrives after the timeout", () => {
    const { machine, timers } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);
    timers.advance(TIMEOUT_MS); // gave up: restored to ON

    const late = machine.confirm(key, false); // the server did switch it OFF after all

    expect(late).toEqual({
      snapshot: { phase: "synced", value: false, buttonsDisabled: false },
      changed: true,
      warn: false,
    });
  });

  it("lets the member retry after a timeout, and that retry can time out again", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);
    timers.advance(TIMEOUT_MS);

    const retry = machine.click(key, false);
    expect(retry.changed).toBe(true);
    expect(retry.snapshot).toEqual({
      phase: "pending",
      value: true,
      buttonsDisabled: true,
      requested: false,
    });

    timers.advance(TIMEOUT_MS);
    expect(timeouts).toHaveLength(2);
    expect(timeouts[1]?.result.warn).toBe(true);
    expect(machine.snapshot(key)).toEqual({ phase: "synced", value: true, buttonsDisabled: false });
  });
});

// ── cancel ───────────────────────────────────────────────────────────────────

describe("StateLockMachine: cancel", () => {
  it.each([true, false])("releases a pending lock back to prior=%s without warning", (prior) => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, prior);
    machine.click(key, !prior);

    const result = machine.cancel(key);

    expect(result).toEqual({
      snapshot: { phase: "synced", value: prior, buttonsDisabled: false },
      changed: true,
      warn: false,
    });
    expect(machine.snapshot(key)).toEqual(result.snapshot);
    // The timeout is disarmed, so no could-not-confirm warning follows.
    expect(timers.cleared).toEqual([timers.handles[0]]);
    timers.advance(TIMEOUT_MS * 10);
    expect(timeouts).toEqual([]);
  });

  it("leaves a never-seeded switch unknown rather than adopting the request", () => {
    const { machine } = makeMachine();
    const key = makeKey();
    machine.click(key, true);

    const result = machine.cancel(key);

    expect(result.changed).toBe(true);
    expect(result.snapshot).toEqual({ phase: "synced", buttonsDisabled: false });
    expect(result.snapshot.value).toBeUndefined();
  });

  it("is a no-op for a switch that is not pending", () => {
    const { machine, timers } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);

    const result = machine.cancel(key);

    expect(result).toEqual({
      snapshot: { phase: "synced", value: true, buttonsDisabled: false },
      changed: false,
      warn: false,
    });
    expect(timers.cleared).toEqual([]);
  });

  it("is a no-op for a switch it has never seen, and does not start tracking it", () => {
    const { machine } = makeMachine();
    const key = makeKey();

    const result = machine.cancel(key);

    expect(result.changed).toBe(false);
    expect(result.warn).toBe(false);
    expect(machine.snapshot(key)).toBeUndefined();
  });

  it("allows a fresh click after a cancel", () => {
    const { machine, timers } = makeMachine();
    const key = makeKey();
    machine.seed(key, false);
    machine.click(key, true);
    machine.cancel(key);

    const retry = machine.click(key, true);

    expect(retry.changed).toBe(true);
    expect(retry.snapshot).toEqual({
      phase: "pending",
      value: false,
      buttonsDisabled: true,
      requested: true,
    });
    expect(timers.liveCount).toBe(1);
  });
});

// ── falsy timer handles ──────────────────────────────────────────────────────

describe("StateLockMachine: a timer source whose first handle is 0", () => {
  it("hands out 0 as its first handle (the premise of this suite)", () => {
    const { machine, timers } = makeMachine({ firstHandle: 0 });
    machine.seed(makeKey(), true);
    machine.click(makeKey(), false);
    expect(timers.handles).toEqual([0]);
  });

  it.each([
    {
      name: "confirm",
      settle: (m: StateLockMachine, k: LockKey) => void m.confirm(k, false),
    },
    { name: "seed", settle: (m: StateLockMachine, k: LockKey) => m.seed(k, false) },
    { name: "forget", settle: (m: StateLockMachine, k: LockKey) => m.forget(k) },
    { name: "cancel", settle: (m: StateLockMachine, k: LockKey) => void m.cancel(k) },
  ])("$name clears the falsy handle, so the timeout never fires", ({ settle }) => {
    const { machine, timers, timeouts } = makeMachine({ firstHandle: 0 });
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    settle(machine, key);

    expect(timers.cleared).toEqual([0]);
    expect(timers.liveCount).toBe(0);
    timers.advance(TIMEOUT_MS * 10);
    expect(timeouts).toEqual([]);
  });

  it("a re-click after the lock closed arms a fresh timer and leaves none behind", () => {
    const { machine, timers, timeouts } = makeMachine({ firstHandle: 0 });
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false); // handle 0
    machine.confirm(key, false);

    machine.click(key, true); // handle 1

    expect(timers.handles).toEqual([0, 1]);
    expect(timers.cleared).toEqual([0]);
    expect(timers.liveCount).toBe(1);
    // Only the second click's deadline is live: exactly one timeout fires.
    timers.advance(TIMEOUT_MS * 10);
    expect(timeouts).toHaveLength(1);
  });

  it("still times out normally on the falsy handle when nothing settles it", () => {
    const { machine, timers, timeouts } = makeMachine({ firstHandle: 0 });
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    timers.advance(TIMEOUT_MS);

    expect(timeouts).toHaveLength(1);
    expect(machine.snapshot(key)).toEqual({ phase: "synced", value: true, buttonsDisabled: false });
  });
});

// ── independence across switches ─────────────────────────────────────────────

describe("StateLockMachine: independent locks", () => {
  it("keeps two switches on the same server separate", () => {
    const { machine } = makeMachine();
    const a = makeKey({ entityId: 1 });
    const b = makeKey({ entityId: 2 });
    machine.seed(a, true);
    machine.seed(b, false);

    machine.click(a, false);

    expect(machine.snapshot(a)?.phase).toBe("pending");
    expect(machine.snapshot(b)).toEqual({ phase: "synced", value: false, buttonsDisabled: false });
    // B is not locked by A's pending click.
    expect(machine.click(b, true).changed).toBe(true);
  });

  it("keeps the same entity id on two servers separate", () => {
    const { machine } = makeMachine();
    const onS1 = makeKey({ serverId: "s1", entityId: 9 });
    const onS2 = makeKey({ serverId: "s2", entityId: 9 });
    machine.seed(onS1, true);
    machine.seed(onS2, true);
    machine.click(onS1, false);

    const result = machine.confirm(onS2, false);

    expect(result.snapshot).toEqual({ phase: "synced", value: false, buttonsDisabled: false });
    // The report for s2 must not close s1's lock.
    expect(machine.snapshot(onS1)).toEqual({
      phase: "pending",
      value: true,
      buttonsDisabled: true,
      requested: false,
    });
  });

  it("confirming one switch leaves another switch's timer running", () => {
    const { machine, timers, timeouts } = makeMachine();
    const a = makeKey({ entityId: 1 });
    const b = makeKey({ entityId: 2 });
    machine.seed(a, true);
    machine.seed(b, true);
    machine.click(a, false);
    machine.click(b, false);

    machine.confirm(a, false);
    timers.advance(TIMEOUT_MS);

    expect(timeouts.map((t) => t.key)).toEqual([b]);
    expect(machine.snapshot(a)).toEqual({ phase: "synced", value: false, buttonsDisabled: false });
    expect(machine.snapshot(b)).toEqual({ phase: "synced", value: true, buttonsDisabled: false });
  });

  it("times staggered locks out at their own deadlines, each with its own key", () => {
    const { machine, timers, timeouts } = makeMachine();
    const first = makeKey({ serverId: "s1", entityId: 1 });
    const second = makeKey({ serverId: "s2", entityId: 1 });
    machine.seed(first, true);
    machine.seed(second, false);

    machine.click(first, false);
    timers.advance(400);
    machine.click(second, true);

    timers.advance(TIMEOUT_MS - 400); // first's deadline
    expect(timeouts.map((t) => t.key)).toEqual([first]);
    expect(machine.snapshot(second)?.phase).toBe("pending");

    timers.advance(400); // second's deadline
    expect(timeouts.map((t) => t.key)).toEqual([first, second]);
    expect(timeouts[0]?.result.snapshot.value).toBe(true);
    expect(timeouts[1]?.result.snapshot.value).toBe(false);
  });
});

// ── cleanup: forget / seed ───────────────────────────────────────────────────

describe("StateLockMachine: cleanup", () => {
  it("forget drops a pending switch and cancels its timeout", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    machine.forget(key);

    expect(machine.snapshot(key)).toBeUndefined();
    expect(timers.cleared).toEqual([timers.handles[0]]);
    expect(timers.liveCount).toBe(0);

    timers.advance(TIMEOUT_MS * 10);
    expect(timeouts).toEqual([]);
    expect(machine.snapshot(key)).toBeUndefined();
  });

  it("forget is a no-op for a switch that was never seen", () => {
    const { machine, timers } = makeMachine();
    expect(() => machine.forget(makeKey())).not.toThrow();
    expect(timers.cleared).toEqual([]);
  });

  it("forget only drops the switch it was asked to", () => {
    const { machine, timers, timeouts } = makeMachine();
    const kept = makeKey({ entityId: 1 });
    const dropped = makeKey({ entityId: 2 });
    machine.seed(kept, true);
    machine.seed(dropped, true);
    machine.click(kept, false);
    machine.click(dropped, false);

    machine.forget(dropped);
    timers.advance(TIMEOUT_MS);

    expect(machine.snapshot(dropped)).toBeUndefined();
    expect(timeouts.map((t) => t.key)).toEqual([kept]);
  });

  it("a forgotten switch starts over as a brand-new lock", () => {
    const { machine, timers } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);
    machine.forget(key);

    machine.seed(key, false);
    const result = machine.click(key, true);

    expect(result).toEqual({
      snapshot: { phase: "pending", value: false, buttonsDisabled: true, requested: true },
      changed: true,
      warn: false,
    });
    expect(timers.liveCount).toBe(1);
  });

  it("seeding a pending switch cancels the lock and adopts the seeded value", () => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    machine.seed(key, false);

    expect(machine.snapshot(key)).toEqual({
      phase: "synced",
      value: false,
      buttonsDisabled: false,
    });
    expect(timers.cleared).toEqual([timers.handles[0]]);

    timers.advance(TIMEOUT_MS * 10);
    expect(timeouts).toEqual([]);
    expect(machine.snapshot(key)?.value).toBe(false);
  });

  it.each([
    {
      name: "a confirm",
      settle: (m: StateLockMachine, k: LockKey) => void m.confirm(k, false),
      expected: { phase: "synced", value: false, buttonsDisabled: false },
    },
    {
      name: "a re-seed",
      settle: (m: StateLockMachine, k: LockKey) => m.seed(k, false),
      expected: { phase: "synced", value: false, buttonsDisabled: false },
    },
    {
      name: "a forget",
      settle: (m: StateLockMachine, k: LockKey) => m.forget(k),
      expected: undefined,
    },
  ])("ignores a stale timer callback that fires after $name", ({ settle, expected }) => {
    const { machine, timers, timeouts } = makeMachine();
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);
    settle(machine, key);

    // Simulate a timer source whose callback slips through despite the clear.
    const stale = timers.callbacks[0];
    if (!stale) throw new Error("expected an armed timer callback");
    stale();

    expect(timeouts).toEqual([]);
    expect(machine.snapshot(key)).toEqual(expected);
  });
});

// ── default timer source ─────────────────────────────────────────────────────

describe("StateLockMachine: default timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms a real timeout on click when no TimerProvider is injected", () => {
    const fired: LockKey[] = [];
    const machine = new StateLockMachine({
      timeoutMs: TIMEOUT_MS,
      onTimeout: (key) => fired.push(key),
    });
    const key = makeKey();
    machine.seed(key, true);

    machine.click(key, false);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([key]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: "confirm", settle: (m: StateLockMachine, k: LockKey) => void m.confirm(k, false) },
    { name: "forget", settle: (m: StateLockMachine, k: LockKey) => m.forget(k) },
    { name: "seed", settle: (m: StateLockMachine, k: LockKey) => m.seed(k, false) },
  ])("$name leaves no real timer behind", ({ settle }) => {
    const machine = new StateLockMachine({ timeoutMs: TIMEOUT_MS });
    const key = makeKey();
    machine.seed(key, true);
    machine.click(key, false);

    settle(machine, key);

    expect(vi.getTimerCount()).toBe(0);
  });
});
