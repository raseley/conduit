/**
 * The timer seam for the push client's deadlines, so tests (and a driver test
 * with its own fake clock) can drive timeouts without real waiting. Same shape
 * as the `TimerProvider` seams in bot-core and discord.
 */

export interface TimerProvider {
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** The global timers, read at call time so `vi.useFakeTimers()` applies. */
export const defaultTimers: TimerProvider = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
