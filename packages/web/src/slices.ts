/**
 * Drawing a timeline in slices (docs/perf.md): when it shows, its newest FIRST messages, and then SLICE more each time
 * the page is idle, up to all it asks for. Showing 60 or 150 messages was one task of 0.3 s on a phone; this makes it a
 * few short ones, and the newest are on screen after the first.
 */

/** Messages drawn when a timeline shows: a phone's screenful and more. */
export const FIRST = 15;
/** Messages each slice after it adds. */
export const SLICE = 15;

/**
 * How much of what a timeline asks for (its messages `start` to `end`) is drawn so far, counted up from `end`. Counted
 * from the newest end, so a message arriving or an older page coming in moves nothing that is drawn.
 */
export class Slices {
  key = '';
  /** How many up from the end are drawn; null when everything asked for is. */
  n: number | null = null;
  /** The timeline whose view has been seen full, so slices before its first paint stop being needed. */
  filled = '';

  /** A timeline shows (or another one in its place): its newest FIRST, then slices. */
  begin(key: string) {
    if (key === this.key) return;
    this.key = key;
    this.n = FIRST;
    this.filled = '';
  }

  /** Where drawing starts, of what is asked for. */
  start(start: number, end: number): number {
    return this.n === null ? start : Math.max(start, end - this.n);
  }

  /** One slice more; once that reaches `start`, all of it. */
  next(start: number, end: number) {
    if (this.n === null) return;
    this.n += SLICE;
    if (end - this.n <= start) this.n = null;
  }

  /** What is asked for is drawn at once (a message linked to, back to the newest). */
  whole() {
    this.n = null;
  }

  /** More is asked for above the `drawn` messages drawn now: the first slice of it at once, the rest in slices. */
  extend(drawn: number) {
    this.n = drawn + SLICE;
  }
}

type Idle = { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };

/** Runs `fn` once the page is idle, or after `timeout` ms at the latest. Returns a cancel. */
export function whenIdle(fn: () => void, timeout = 300): () => void {
  const g = globalThis as Idle;
  if (g.requestIdleCallback) {
    const id = g.requestIdleCallback(fn, { timeout });
    return () => g.cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
}
