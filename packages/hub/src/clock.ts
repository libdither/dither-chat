/**
 * The time and the timers, in one object code can be handed: the real ones by default, a test's own (test/fixtures/
 * clock.ts) so pacing that takes seconds (rate budgets, backoffs, pauses between pages) runs in no time. Intervals
 * minutes apart stay on the real timers.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as Timer),
};

/** Waits `ms` on a clock. */
export const sleep = (clock: Clock, ms: number) => new Promise<void>((r) => clock.setTimeout(r, ms));

/** A real timer that does not keep the process alive; on a test's clock, nothing to do. */
export const unref = (timer: unknown) => (timer as { unref?: () => void } | null)?.unref?.();
