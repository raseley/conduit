/**
 * Switch state-lock state machine (THE core pattern).
 *
 * This is the most important behaviour in the adapter and the headline test
 * target, so it is implemented as a **pure, discord.js-free** state machine that
 * can be unit-tested without a gateway. The adapter owns the discord.js side
 * (disabling/refreshing the actual buttons) and drives this machine through its
 * transitions:
 *
 *   synced ──click──► pending ──confirm(entityChanged)───► synced
 *                            ├──timeout(N s)────────────► warn → synced(prior)
 *                            └──cancel(actuation failed)─► synced(prior)
 *
 * On `click` the machine records the *prior* known state and the *requested*
 * state, arms a timeout, and reports that the buttons should be disabled with a
 * pending indicator. On the confirming `entityChanged` for that entity it clears
 * the timeout and reports the new (confirmed) state with buttons re-enabled. If
 * the timeout fires first it restores the prior state and signals a warning so
 * the adapter can send the ephemeral "couldn't confirm — retry".
 *
 * The confirmed value is only ever what the server reported (a `seed` or a
 * `confirm`). A switch that has had neither is tracked with an *unknown* value
 * (`undefined`): a click never stands in for a confirmation, so a timeout or a
 * cancel on such a switch leaves it unknown rather than claiming the state the
 * member merely asked for.
 *
 * Timers are injected (a `setTimer`/`clearTimer` pair) so tests can drive them
 * with vitest fake timers or a manual clock.
 */

/** Lifecycle phase of one switch's lock. */
export type LockPhase = "synced" | "pending" | "warn";

/** Identifies the switch a lock belongs to. */
export interface LockKey {
  serverId: string;
  entityId: number;
}

/** A snapshot of a switch lock for rendering its panel. */
export interface LockSnapshot {
  phase: LockPhase;
  /**
   * Last server-confirmed on/off value (what the panel badge should show), or
   * `undefined` when the server has not reported this switch yet — unknown, not
   * "off". Never the merely-requested value.
   */
  value?: boolean;
  /** True while the buttons must be disabled (pending phase). */
  buttonsDisabled: boolean;
  /**
   * While pending: the value the member asked for ("Switching on…"). Only a
   * label for the wait; never shown as the switch's state.
   */
  requested?: boolean;
}

/** Outcome of feeding an event into the machine. */
export interface LockResult {
  snapshot: LockSnapshot;
  /** True when the adapter should re-render the panel for this switch. */
  changed: boolean;
  /** True when the adapter should send the ephemeral "couldn't confirm" warning. */
  warn: boolean;
}

/**
 * Injectable timer seam (defaults to Node globals). The handle is opaque: any
 * value a provider returns from `setTimer` — including a falsy one such as `0`
 * — is handed back to `clearTimer` unchanged. (`undefined` is the one value a
 * provider must not use as a handle; it means "no timer armed".)
 */
export interface TimerProvider {
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const defaultTimers: TimerProvider = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface LockEntry {
  phase: LockPhase;
  /** Last server-confirmed value; `undefined` until a seed or confirm. */
  value?: boolean;
  /** The value the user requested while pending. */
  requested?: boolean;
  /** The value to restore on timeout/cancel (`undefined` = still unknown). */
  prior?: boolean;
  /** Handle of the armed timeout; `undefined` when none is armed. */
  timer?: unknown;
}

function keyOf(key: LockKey): string {
  return `${key.serverId}:${key.entityId}`;
}

function snapshotOf(entry: LockEntry): LockSnapshot {
  return {
    phase: entry.phase,
    value: entry.value,
    buttonsDisabled: entry.phase === "pending",
    ...(entry.phase === "pending" && entry.requested !== undefined
      ? { requested: entry.requested }
      : {}),
  };
}

/**
 * Manages the state-lock for every switch the adapter has a panel for. One
 * instance lives on the adapter. Pure and synchronous except for the injected
 * timer; `onTimeout` is the callback the adapter wires so it can re-render the
 * panel and send the ephemeral warning when a confirmation never arrives.
 */
export class StateLockMachine {
  private readonly entries = new Map<string, LockEntry>();
  private readonly timers: TimerProvider;
  private readonly timeoutMs: number;
  private readonly onTimeout?: (key: LockKey, result: LockResult) => void;

  constructor(opts: {
    timeoutMs: number;
    timers?: TimerProvider;
    /** Called when a pending lock times out (adapter re-renders + warns). */
    onTimeout?: (key: LockKey, result: LockResult) => void;
  }) {
    this.timeoutMs = opts.timeoutMs;
    this.timers = opts.timers ?? defaultTimers;
    this.onTimeout = opts.onTimeout;
  }

  /** Seed/replace the known confirmed value for a switch (e.g. on panel build). */
  seed(key: LockKey, value: boolean): void {
    const k = keyOf(key);
    const existing = this.entries.get(k);
    if (existing) this.disarm(existing);
    this.entries.set(k, { phase: "synced", value });
  }

  /** Current snapshot for a switch, or `undefined` if never seen. */
  snapshot(key: LockKey): LockSnapshot | undefined {
    const entry = this.entries.get(keyOf(key));
    return entry ? snapshotOf(entry) : undefined;
  }

  /**
   * Transition: the member clicked ON/OFF (after the permission check passed).
   * Records prior + requested state, arms the timeout, and returns a snapshot
   * with the buttons disabled and a pending indicator. Ignores a second click
   * while already pending (returns `changed: false`) — the caller must not
   * actuate again for such a click.
   *
   * A switch seen here for the first time has no confirmed value; it enters
   * pending with `value: undefined`, which is also what a timeout restores.
   */
  click(key: LockKey, requested: boolean): LockResult {
    const k = keyOf(key);
    const entry: LockEntry = this.entries.get(k) ?? { phase: "synced" };

    if (entry.phase === "pending") {
      // Already mid-flight; don't double-actuate.
      return { snapshot: snapshotOf(entry), changed: false, warn: false };
    }

    entry.prior = entry.value;
    entry.requested = requested;
    entry.phase = "pending";
    this.disarm(entry);
    entry.timer = this.timers.setTimer(() => this.fireTimeout(key), this.timeoutMs);
    this.entries.set(k, entry);

    return { snapshot: snapshotOf(entry), changed: true, warn: false };
  }

  /**
   * Transition: the confirming tier-3 broadcast arrived for this entity. Clears
   * the timeout, records the confirmed value, and returns a re-enabled snapshot.
   * If the switch was not pending (an unsolicited broadcast) it still updates the
   * confirmed value so the panel stays accurate.
   */
  confirm(key: LockKey, value: boolean): LockResult {
    const k = keyOf(key);
    const entry = this.entries.get(k);
    if (!entry) {
      const fresh: LockEntry = { phase: "synced", value };
      this.entries.set(k, fresh);
      return { snapshot: snapshotOf(fresh), changed: true, warn: false };
    }
    this.disarm(entry);
    const changed = entry.phase !== "synced" || entry.value !== value;
    entry.phase = "synced";
    entry.value = value;
    entry.requested = undefined;
    entry.prior = undefined;
    return { snapshot: snapshotOf(entry), changed, warn: false };
  }

  /**
   * Transition: the actuation behind a pending click never reached the server
   * (the request itself failed), so no confirming broadcast is coming. Clears
   * the timeout and settles straight back to the prior confirmed value — which
   * stays unknown if it was unknown — without the could-not-confirm warning.
   * A no-op (`changed: false`) for a switch that is not pending or was never
   * seen.
   */
  cancel(key: LockKey): LockResult {
    const entry = this.entries.get(keyOf(key));
    if (!entry || entry.phase !== "pending") {
      const snapshot: LockSnapshot = entry
        ? snapshotOf(entry)
        : { phase: "synced", buttonsDisabled: false };
      return { snapshot, changed: false, warn: false };
    }
    this.disarm(entry);
    this.restorePrior(entry);
    entry.phase = "synced";
    return { snapshot: snapshotOf(entry), changed: true, warn: false };
  }

  /** Drop a switch (panel deleted/reposted). Clears any pending timer. */
  forget(key: LockKey): void {
    const k = keyOf(key);
    const entry = this.entries.get(k);
    if (entry) this.disarm(entry);
    this.entries.delete(k);
  }

  /**
   * Clear an entry's armed timeout, if any. Compares against `undefined`, not
   * truthiness: the {@link TimerProvider} handle is opaque, and a falsy handle
   * (`0`) is as real as any other.
   */
  private disarm(entry: LockEntry): void {
    if (entry.timer === undefined) return;
    this.timers.clearTimer(entry.timer);
    entry.timer = undefined;
  }

  /** Put back the value recorded at click time and drop the pending request. */
  private restorePrior(entry: LockEntry): void {
    entry.value = entry.prior;
    entry.requested = undefined;
    entry.prior = undefined;
  }

  private fireTimeout(key: LockKey): void {
    const k = keyOf(key);
    const entry = this.entries.get(k);
    if (!entry || entry.phase !== "pending") return;
    entry.timer = undefined;
    entry.phase = "warn";
    // Restore the prior confirmed value. Unknown stays unknown: the requested
    // value was never confirmed, so it is never presented as the state.
    this.restorePrior(entry);
    // After surfacing the warning, settle back to synced(prior).
    const result: LockResult = {
      snapshot: { ...snapshotOf(entry), phase: "warn" },
      changed: true,
      warn: true,
    };
    entry.phase = "synced";
    this.onTimeout?.(key, result);
  }
}
