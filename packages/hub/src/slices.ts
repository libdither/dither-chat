/**
 * Background work in slices (docs/perf.md, "The hub's own stalls"). The hub answers every device on one thread, so a
 * job that takes seconds is written as a generator that yields every few milliseconds' worth of work, and `sliced`
 * runs it about `budgetMs` at a time, giving the event loop a turn in between: requests that came in meanwhile are
 * answered before the next slice. The work and its result are the same as running it straight through (`whole`).
 *
 * What a generator yields is how much work it did since it last yielded, in rows (a row read, or an example visited
 * once): `onSlice` is told each slice's sum, which is how a test sees that no slice does too much without a clock.
 */
import { noteWork } from './stalls.ts';

export interface SliceOptions {
  /** How long a slice may run, in the clock's ms. */
  budgetMs?: number;
  /** The clock slices are kept by: performance.now(), or a test's. */
  clock?: () => number;
  /** How the event loop gets its turn between slices. */
  pause?: () => Promise<unknown>;
  /** Each slice's work, in what the generator yielded, once the slice is over. */
  onSlice?: (rows: number) => void;
}

/** A slice's length: short enough that a request waits at most about this long behind background work. */
export const SLICE_MS = 20;
/** Rows a generator works through between yields, at most: a few milliseconds of the hub's heaviest kind. */
export const SLICE_ROWS = 4096;

const turn = () => new Promise<void>((r) => setTimeout(r, 0));

/** Run `g` to its end, `budgetMs` at a time, with a turn of the event loop between. `name` is for the stall log. */
export async function sliced<T>(name: string, g: Generator<number | undefined, T>, o: SliceOptions = {}): Promise<T> {
  const clock = o.clock ?? (() => performance.now());
  const budget = o.budgetMs ?? SLICE_MS;
  const pause = o.pause ?? turn;
  noteWork(name);
  let start = clock();
  let rows = 0;
  for (;;) {
    const r = g.next();
    if (r.done) {
      if (rows) o.onSlice?.(rows);
      return r.value;
    }
    rows += r.value ?? 0;
    if (clock() - start >= budget) {
      o.onSlice?.(rows);
      rows = 0;
      await pause();
      noteWork(name);
      start = clock();
    }
  }
}

/**
 * For an async loop that cannot be a generator (it awaits fetches as it goes): `await s.rows(n)` every few hundred
 * rows gives the event loop a turn once the slice's time is up; `s.fresh()` after an await of its own starts a new
 * slice, and `s.end()` reports the last.
 */
export function asyncSlices(name: string, o: SliceOptions = {}) {
  const clock = o.clock ?? (() => performance.now());
  const budget = o.budgetMs ?? SLICE_MS;
  const pause = o.pause ?? turn;
  noteWork(name);
  let start = clock();
  let done = 0;
  return {
    async rows(n: number) {
      done += n;
      if (clock() - start < budget) return;
      o.onSlice?.(done);
      done = 0;
      await pause();
      noteWork(name);
      start = clock();
    },
    fresh() {
      if (done) o.onSlice?.(done);
      done = 0;
      noteWork(name);
      start = clock();
    },
    end() {
      if (done) o.onSlice?.(done);
      done = 0;
    },
  };
}

/** All of it at once: for scripts and tests that want the answer, not the turns. */
export function whole<T>(g: Generator<number | undefined, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}
