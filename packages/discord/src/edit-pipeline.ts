/**
 * {@link EditPipeline} — every in-place edit of a known panel message goes
 * through here, so a panel spends as few of Discord's edits as it can.
 *
 * Discord caps edits to messages older than an hour (error 30046, "Maximum
 * number of edits to messages older than 1 hour reached"), and the cap is not
 * documented. Panels are long-lived, so every edit counts. Per message id the
 * pipeline:
 *
 * - **skips identical payloads**: a payload whose fingerprint matches the last
 *   one sent to that message makes no edit;
 * - **coalesces**: a submitted payload waits out a short debounce window, and
 *   only the newest payload submitted in the window is sent, so a burst of
 *   changes becomes one edit;
 * - is **single-flight**: at most one edit per message is in flight; whatever is
 *   submitted meanwhile goes out after it, newest first, never out of order;
 * - **on 30046** first asks the host whether it will replace the message
 *   (`replaceOnCap`; the adapter rebuilds every panel, at most once an hour).
 *   If so, the message is dropped. If not, the edit is not retried: the
 *   message's edits pause (5 min, doubling to 1 h while Discord keeps
 *   refusing), and the newest payload goes out when the pause ends.
 *
 * `immediate` skips the debounce (a member's click deserves feedback now) but
 * still skips an identical payload and still waits for an edit in flight.
 * `force` sends even an identical payload (the startup reconcile, which edits to
 * learn whether the message still exists).
 *
 * Discord-free and generic over the payload, so the adapter supplies how to
 * send and fingerprint one. Timers are injected.
 */

import type { TimerProvider } from "./state-lock.js";

/** What became of one edit sent to Discord (see the adapter's `PanelWriteOutcome`). */
export type EditOutcome = "ok" | "gone" | "unreachable" | "failed" | "capped";

/**
 * What became of a submitted payload: the outcome of the edit that carried it
 * (or a newer payload that replaced it), `skipped` when it matched what the
 * message already shows, or `deferred` when the message's edits are paused after
 * a 30046 (the payload is kept and sent when the pause ends).
 */
export type SubmitOutcome = EditOutcome | "skipped" | "deferred";

/** Options for one {@link EditPipeline.submit}. */
export interface SubmitOptions {
  /** Send without waiting out the debounce (still skips an identical payload). */
  immediate?: boolean;
  /** Send even when the payload matches the last one sent. */
  force?: boolean;
}

/** Construction options for {@link EditPipeline}. */
export interface EditPipelineOptions<P> {
  /** Make the edit. Should not throw; a throw counts as `failed`. */
  send(messageId: string, payload: P): Promise<EditOutcome>;
  /**
   * A string that is equal for two payloads exactly when they render the same.
   * `undefined` means the payload can't be compared (e.g. it carries a file), so
   * it is always sent, and the next payload after it is too.
   */
  fingerprint(payload: P): string | undefined;
  timers: TimerProvider;
  /** How long a non-immediate payload waits for newer ones. Default 750 ms; `0` sends at once. */
  debounceMs?: number;
  /** First pause after a 30046. Default 5 minutes; doubles while Discord keeps refusing. */
  capBackoffMs?: number;
  /** Longest pause after repeated 30046s. Default 1 hour. */
  capBackoffMaxMs?: number;
  /**
   * Asked on each 30046, before pausing: return true when the host will replace
   * the message (a freshly posted message is not subject to the cap). The
   * pipeline then forgets the message instead of pausing it, answering what was
   * waiting for it `capped`: the replacement renders from current state. Must
   * not call back into the pipeline synchronously. Default: never (always pause).
   */
  replaceOnCap?(messageId: string): boolean;
  /** Told about each 30046 that pauses a message, and how long its edits now pause. */
  onCapped?(messageId: string, backoffMs: number): void;
}

/** Default debounce: long enough to fold a burst, short enough to feel live. */
export const EDIT_DEBOUNCE_MS = 750;
/** Default first pause after Discord's 30046 edit cap. */
export const EDIT_CAP_BACKOFF_MS = 5 * 60_000;
/** Default longest pause after repeated 30046s. */
export const EDIT_CAP_BACKOFF_MAX_MS = 60 * 60_000;

/** The newest not-yet-sent payload for a message, and who waits on it. */
interface Pending<P> {
  payload: P;
  immediate: boolean;
  force: boolean;
  waiters: ((outcome: SubmitOutcome) => void)[];
}

/** Per-message state. */
interface Slot<P> {
  pending?: Pending<P>;
  /** Fingerprint of what the message shows, when known. */
  shown?: string;
  /** The debounce timer, or the 30046 pause timer while `paused`. */
  timer?: unknown;
  inFlight: boolean;
  /** True while edits are paused after a 30046. */
  paused: boolean;
  /** The current pause length; cleared by a successful edit. */
  backoffMs?: number;
}

export class EditPipeline<P> {
  private readonly slots = new Map<string, Slot<P>>();
  private readonly send: (messageId: string, payload: P) => Promise<EditOutcome>;
  private readonly fingerprint: (payload: P) => string | undefined;
  private readonly timers: TimerProvider;
  private readonly debounceMs: number;
  private readonly capBackoffMs: number;
  private readonly capBackoffMaxMs: number;
  private readonly replaceOnCap: (messageId: string) => boolean;
  private readonly onCapped: (messageId: string, backoffMs: number) => void;

  constructor(options: EditPipelineOptions<P>) {
    this.send = options.send;
    this.fingerprint = options.fingerprint;
    this.timers = options.timers;
    this.debounceMs = options.debounceMs ?? EDIT_DEBOUNCE_MS;
    this.capBackoffMs = options.capBackoffMs ?? EDIT_CAP_BACKOFF_MS;
    this.capBackoffMaxMs = options.capBackoffMaxMs ?? EDIT_CAP_BACKOFF_MAX_MS;
    this.replaceOnCap = options.replaceOnCap ?? (() => false);
    this.onCapped = options.onCapped ?? (() => {});
  }

  /**
   * Submit the payload a message should now show. Resolves once it was sent,
   * replaced by a newer payload that was sent, skipped, or deferred by a 30046
   * pause; never rejects.
   */
  submit(messageId: string, payload: P, options: SubmitOptions = {}): Promise<SubmitOutcome> {
    const slot = this.slotFor(messageId);
    const immediate = Boolean(options.immediate) || this.debounceMs <= 0;
    const force = Boolean(options.force);

    // Nothing queued or in flight, and the message already shows this: done.
    if (!force && !slot.pending && !slot.inFlight && !slot.paused) {
      const fp = this.fingerprint(payload);
      if (fp !== undefined && fp === slot.shown) return Promise.resolve("skipped");
    }

    // The newest payload wins; earlier waiters are answered by the edit that
    // carries it.
    const pending: Pending<P> = slot.pending ?? {
      payload,
      immediate: false,
      force: false,
      waiters: [],
    };
    pending.payload = payload;
    pending.immediate ||= immediate;
    pending.force ||= force;
    slot.pending = pending;

    if (slot.paused) return Promise.resolve("deferred");

    const result = new Promise<SubmitOutcome>((resolve) => pending.waiters.push(resolve));
    this.schedule(messageId, slot);
    return result;
  }

  /**
   * Forget a message (it was deleted, or is about to be): cancel its timer and
   * drop what was waiting to be sent, answering its waiters `answer` (`gone` by
   * default).
   */
  forget(messageId: string, answer: SubmitOutcome = "gone"): void {
    const slot = this.slots.get(messageId);
    if (!slot) return;
    this.slots.delete(messageId);
    if (slot.timer !== undefined) this.timers.clearTimer(slot.timer);
    slot.timer = undefined;
    const waiters = slot.pending?.waiters ?? [];
    slot.pending = undefined;
    for (const resolve of waiters) resolve(answer);
  }

  /** Forget every message (the adapter stopped, or every panel is being rebuilt). */
  clear(): void {
    for (const messageId of [...this.slots.keys()]) this.forget(messageId);
  }

  /** Whether edits to a message are paused after a 30046 (for tests and diagnostics). */
  isPaused(messageId: string): boolean {
    return this.slots.get(messageId)?.paused ?? false;
  }

  private slotFor(messageId: string): Slot<P> {
    let slot = this.slots.get(messageId);
    if (!slot) {
      slot = { inFlight: false, paused: false };
      this.slots.set(messageId, slot);
    }
    return slot;
  }

  /** Send the pending payload now, or arm the debounce, as it asks. */
  private schedule(messageId: string, slot: Slot<P>): void {
    if (!slot.pending || slot.inFlight || slot.paused) return;
    if (slot.pending.immediate) {
      if (slot.timer !== undefined) this.timers.clearTimer(slot.timer);
      slot.timer = undefined;
      void this.flush(messageId, slot);
      return;
    }
    if (slot.timer !== undefined) return;
    slot.timer = this.timers.setTimer(() => {
      slot.timer = undefined;
      void this.flush(messageId, slot);
    }, this.debounceMs);
  }

  private async flush(messageId: string, slot: Slot<P>): Promise<void> {
    if (this.slots.get(messageId) !== slot) return; // forgotten meanwhile
    const pending = slot.pending;
    if (!pending || slot.inFlight || slot.paused) return;
    slot.pending = undefined;

    const fp = this.fingerprint(pending.payload);
    if (!pending.force && fp !== undefined && fp === slot.shown) {
      for (const resolve of pending.waiters) resolve("skipped");
      return;
    }

    slot.inFlight = true;
    let outcome: EditOutcome;
    try {
      outcome = await this.send(messageId, pending.payload);
    } catch {
      outcome = "failed";
    }
    slot.inFlight = false;

    if (outcome === "ok") {
      slot.shown = fp;
      slot.backoffMs = undefined;
    } else {
      // The message's content is no longer known; let the next payload through.
      slot.shown = undefined;
    }
    if (outcome === "capped") {
      // A message the host replaces is dropped; anything else waits out a pause.
      if (this.replaceOnCap(messageId)) {
        if (this.slots.get(messageId) === slot) this.forget(messageId, "capped");
      } else {
        this.pause(messageId, slot, pending.payload);
      }
    }

    for (const resolve of pending.waiters) resolve(outcome);
    if (this.slots.get(messageId) === slot) this.schedule(messageId, slot);
  }

  /**
   * Discord refused the edit with 30046. Don't retry: keep the newest payload
   * and send it when the pause ends.
   */
  private pause(messageId: string, slot: Slot<P>, refused: P): void {
    slot.backoffMs = Math.min(
      this.capBackoffMaxMs,
      slot.backoffMs === undefined ? this.capBackoffMs : slot.backoffMs * 2,
    );
    slot.paused = true;
    slot.pending ??= { payload: refused, immediate: false, force: false, waiters: [] };
    // Anyone who submitted while the refused edit was in flight learns now.
    const waiting = slot.pending.waiters;
    slot.pending.waiters = [];
    for (const resolve of waiting) resolve("deferred");
    if (slot.timer !== undefined) this.timers.clearTimer(slot.timer);
    const backoffMs = slot.backoffMs;
    slot.timer = this.timers.setTimer(() => {
      slot.timer = undefined;
      slot.paused = false;
      if (slot.pending) slot.pending.immediate = true;
      if (this.slots.get(messageId) === slot) this.schedule(messageId, slot);
    }, backoffMs);
    this.onCapped(messageId, backoffMs);
  }
}
