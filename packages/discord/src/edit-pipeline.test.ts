import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  EDIT_CAP_BACKOFF_MAX_MS,
  EDIT_CAP_BACKOFF_MS,
  EDIT_DEBOUNCE_MS,
  EditPipeline,
  type EditOutcome,
  type EditPipelineOptions,
} from "./edit-pipeline.js";
import type { TimerProvider } from "./state-lock.js";

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const fakeTimers: TimerProvider = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Text payloads; a payload starting with "file:" can't be compared. */
function makePipeline(overrides: Partial<EditPipelineOptions<string>> = {}) {
  const sent: { messageId: string; payload: string }[] = [];
  const outcomes: EditOutcome[] = [];
  let gate: Promise<void> | undefined;
  const capped: { messageId: string; backoffMs: number }[] = [];
  const pipeline = new EditPipeline<string>({
    send: async (messageId, payload) => {
      sent.push({ messageId, payload });
      if (gate) await gate;
      return outcomes.shift() ?? "ok";
    },
    fingerprint: (payload) => (payload.startsWith("file:") ? undefined : payload),
    timers: fakeTimers,
    onCapped: (messageId, backoffMs) => capped.push({ messageId, backoffMs }),
    ...overrides,
  });
  return {
    pipeline,
    sent,
    capped,
    payloads: () => sent.map((s) => s.payload),
    /** Answer the next sends with these outcomes (then "ok"). */
    answer: (...next: EditOutcome[]) => outcomes.push(...next),
    /** Hold every send until the returned function is called. */
    hold: (): (() => void) => {
      const d = deferred();
      gate = d.promise;
      return () => {
        gate = undefined;
        d.resolve();
      };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("EditPipeline", () => {
  it("sends after the debounce, then skips the same payload", async () => {
    const p = makePipeline();
    const first = p.pipeline.submit("m1", "a");
    expect(p.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(await first).toBe("ok");
    expect(p.payloads()).toEqual(["a"]);

    expect(await p.pipeline.submit("m1", "a")).toBe("skipped");
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(p.payloads()).toEqual(["a"]);
  });

  it("folds a burst into one edit carrying the newest payload", async () => {
    const p = makePipeline();
    const results = [
      p.pipeline.submit("m1", "a"),
      p.pipeline.submit("m1", "b"),
      p.pipeline.submit("m1", "c"),
    ];
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(await Promise.all(results)).toEqual(["ok", "ok", "ok"]);
    expect(p.payloads()).toEqual(["c"]);
  });

  it("skips a burst that ends where the message already is", async () => {
    const p = makePipeline();
    p.pipeline.submit("m1", "a");
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    const results = [p.pipeline.submit("m1", "b"), p.pipeline.submit("m1", "a")];
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(await Promise.all(results)).toEqual(["skipped", "skipped"]);
    expect(p.payloads()).toEqual(["a"]);
  });

  it("keeps messages independent", async () => {
    const p = makePipeline();
    p.pipeline.submit("m1", "a");
    p.pipeline.submit("m2", "a");
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(p.sent).toEqual([
      { messageId: "m1", payload: "a" },
      { messageId: "m2", payload: "a" },
    ]);
  });

  it("sends an immediate payload at once, still skipping an identical one", async () => {
    const p = makePipeline();
    expect(await p.pipeline.submit("m1", "a", { immediate: true })).toBe("ok");
    expect(p.payloads()).toEqual(["a"]);
    expect(await p.pipeline.submit("m1", "a", { immediate: true })).toBe("skipped");
    expect(p.payloads()).toEqual(["a"]);
  });

  it("an immediate payload takes over a debounced one", async () => {
    const p = makePipeline();
    const slow = p.pipeline.submit("m1", "a");
    const now = p.pipeline.submit("m1", "b", { immediate: true });
    expect(await now).toBe("ok");
    expect(await slow).toBe("ok");
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(p.payloads()).toEqual(["b"]);
  });

  it("force sends even an identical payload", async () => {
    const p = makePipeline();
    await p.pipeline.submit("m1", "a", { immediate: true });
    expect(await p.pipeline.submit("m1", "a", { immediate: true, force: true })).toBe("ok");
    expect(p.payloads()).toEqual(["a", "a"]);
  });

  it("always sends a payload it cannot compare, and the one after it", async () => {
    const p = makePipeline();
    await p.pipeline.submit("m1", "a", { immediate: true });
    await p.pipeline.submit("m1", "file:x", { immediate: true });
    await p.pipeline.submit("m1", "file:x", { immediate: true });
    await p.pipeline.submit("m1", "a", { immediate: true });
    expect(p.payloads()).toEqual(["a", "file:x", "file:x", "a"]);
  });

  it("keeps one edit in flight per message, then sends the newest after it", async () => {
    const p = makePipeline();
    const release = p.hold();
    const first = p.pipeline.submit("m1", "a", { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    const second = p.pipeline.submit("m1", "b", { immediate: true });
    const third = p.pipeline.submit("m1", "c", { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.payloads()).toEqual(["a"]);
    release();
    expect(await first).toBe("ok");
    expect(await second).toBe("ok");
    expect(await third).toBe("ok");
    expect(p.payloads()).toEqual(["a", "c"]);
  });

  it("debounces what arrives during an edit in flight", async () => {
    const p = makePipeline();
    const release = p.hold();
    p.pipeline.submit("m1", "a", { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    const later = p.pipeline.submit("m1", "b");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.payloads()).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(await later).toBe("ok");
    expect(p.payloads()).toEqual(["a", "b"]);
  });

  it("lets the same payload through again after a failed edit", async () => {
    const p = makePipeline();
    p.answer("failed");
    expect(await p.pipeline.submit("m1", "a", { immediate: true })).toBe("failed");
    expect(await p.pipeline.submit("m1", "a", { immediate: true })).toBe("ok");
    expect(p.payloads()).toEqual(["a", "a"]);
  });

  it("counts a throwing send as failed", async () => {
    const p = makePipeline({
      send: async () => {
        throw new Error("boom");
      },
    });
    expect(await p.pipeline.submit("m1", "a", { immediate: true })).toBe("failed");
  });

  it("sends at once when the debounce is 0", async () => {
    const p = makePipeline({ debounceMs: 0 });
    expect(await p.pipeline.submit("m1", "a")).toBe("ok");
    expect(p.payloads()).toEqual(["a"]);
  });

  it("forget drops what was waiting and answers it gone", async () => {
    const p = makePipeline();
    const waiting = p.pipeline.submit("m1", "a");
    p.pipeline.forget("m1");
    expect(await waiting).toBe("gone");
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(p.sent).toHaveLength(0);
  });

  it("clear forgets every message", async () => {
    const p = makePipeline();
    const a = p.pipeline.submit("m1", "a");
    const b = p.pipeline.submit("m2", "b");
    p.pipeline.clear();
    expect(await Promise.all([a, b])).toEqual(["gone", "gone"]);
    await vi.advanceTimersByTimeAsync(EDIT_DEBOUNCE_MS);
    expect(p.sent).toHaveLength(0);
  });

  describe("Discord's 30046 edit cap", () => {
    it("does not retry: pauses the message, then sends the newest payload when the pause ends", async () => {
      const p = makePipeline();
      p.answer("capped");
      expect(await p.pipeline.submit("m1", "a", { immediate: true })).toBe("capped");
      expect(p.capped).toEqual([{ messageId: "m1", backoffMs: EDIT_CAP_BACKOFF_MS }]);
      expect(p.pipeline.isPaused("m1")).toBe(true);

      // Paused: nothing is sent, however urgent; the newest payload is kept.
      expect(await p.pipeline.submit("m1", "b", { immediate: true })).toBe("deferred");
      expect(await p.pipeline.submit("m1", "c")).toBe("deferred");
      await vi.advanceTimersByTimeAsync(EDIT_CAP_BACKOFF_MS - 1);
      expect(p.payloads()).toEqual(["a"]);

      await vi.advanceTimersByTimeAsync(1);
      expect(p.payloads()).toEqual(["a", "c"]);
      expect(p.pipeline.isPaused("m1")).toBe(false);
    });

    it("resends the refused payload when nothing newer arrived", async () => {
      const p = makePipeline();
      p.answer("capped");
      await p.pipeline.submit("m1", "a", { immediate: true });
      await vi.advanceTimersByTimeAsync(EDIT_CAP_BACKOFF_MS);
      expect(p.payloads()).toEqual(["a", "a"]);
    });

    it("doubles the pause while Discord keeps refusing, up to the maximum, and resets it on success", async () => {
      const p = makePipeline();
      p.answer("capped", "capped", "capped", "capped", "capped", "capped");
      await p.pipeline.submit("m1", "a", { immediate: true });
      const pauses = [EDIT_CAP_BACKOFF_MS];
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(pauses.at(-1)!);
        pauses.push(Math.min(EDIT_CAP_BACKOFF_MAX_MS, pauses.at(-1)! * 2));
      }
      expect(p.capped.map((c) => c.backoffMs)).toEqual(pauses);
      expect(Math.max(...pauses)).toBe(EDIT_CAP_BACKOFF_MAX_MS);

      // The next resend succeeds; a later 30046 starts from the first pause again.
      await vi.advanceTimersByTimeAsync(pauses.at(-1)!);
      p.answer("capped");
      await p.pipeline.submit("m1", "b", { immediate: true });
      expect(p.capped.at(-1)!.backoffMs).toBe(EDIT_CAP_BACKOFF_MS);
    });

    it("answers deferred to whoever submitted while the refused edit was in flight", async () => {
      const p = makePipeline();
      p.answer("capped");
      const release = p.hold();
      const first = p.pipeline.submit("m1", "a", { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      const second = p.pipeline.submit("m1", "b", { immediate: true });
      release();
      expect(await first).toBe("capped");
      expect(await second).toBe("deferred");
      await vi.advanceTimersByTimeAsync(EDIT_CAP_BACKOFF_MS);
      expect(p.payloads()).toEqual(["a", "b"]);
    });

    it("pauses only the refused message", async () => {
      const p = makePipeline();
      p.answer("capped");
      await p.pipeline.submit("m1", "a", { immediate: true });
      expect(await p.pipeline.submit("m2", "a", { immediate: true })).toBe("ok");
    });

    describe("when the host replaces the message", () => {
      it("asks first, then forgets the message instead of pausing it", async () => {
        const asked: string[] = [];
        const p = makePipeline({
          replaceOnCap: (messageId) => {
            asked.push(messageId);
            return true;
          },
        });
        p.answer("capped");
        expect(await p.pipeline.submit("m1", "a", { immediate: true })).toBe("capped");
        expect(asked).toEqual(["m1"]);
        expect(p.capped).toEqual([]);
        expect(p.pipeline.isPaused("m1")).toBe(false);

        // Nothing is resent: the replacement renders from current state.
        await vi.advanceTimersByTimeAsync(EDIT_CAP_BACKOFF_MAX_MS);
        expect(p.payloads()).toEqual(["a"]);
      });

      it("drops what was submitted while the refused edit was in flight", async () => {
        const p = makePipeline({ replaceOnCap: () => true });
        p.answer("capped");
        const release = p.hold();
        const first = p.pipeline.submit("m1", "a", { immediate: true });
        await vi.advanceTimersByTimeAsync(0);
        const second = p.pipeline.submit("m1", "b", { immediate: true });
        release();
        expect(await first).toBe("capped");
        expect(await second).toBe("capped");
        await vi.advanceTimersByTimeAsync(EDIT_CAP_BACKOFF_MAX_MS);
        expect(p.payloads()).toEqual(["a"]);
      });

      it("pauses as before when the host declines", async () => {
        const p = makePipeline({ replaceOnCap: () => false });
        p.answer("capped");
        await p.pipeline.submit("m1", "a", { immediate: true });
        expect(p.capped).toEqual([{ messageId: "m1", backoffMs: EDIT_CAP_BACKOFF_MS }]);
        expect(p.pipeline.isPaused("m1")).toBe(true);
      });
    });
  });
});
