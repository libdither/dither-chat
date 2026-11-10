/**
 * A clock for tests (src/clock.ts): time stands still until the test moves it, and each timer fires when time reaches
 * it, in order, with a real turn of the event loop after each so the promises it starts settle first. Code handed this
 * clock waits seconds of pacing in a few milliseconds, and the same steps happen in the same order every run.
 *
 * Everything the code under test waits on should be on this clock (FakeMailBackend's answers are, once given it):
 * time only moves on once a couple of turns go by with nothing due.
 */
import type { Clock } from '../../src/clock.ts';

interface FakeTimer {
  at: number;
  seq: number;
  fn: () => void;
}

const turn = () => new Promise<void>((r) => setImmediate(r));

export class FakeClock implements Clock {
  private t: number;
  private timers: FakeTimer[] = [];
  private seq = 0;

  constructor(start = Date.now()) {
    this.t = start;
  }

  now = () => this.t;

  setTimeout = (fn: () => void, ms: number): FakeTimer => {
    const timer = { at: this.t + Math.max(0, ms || 0), seq: this.seq++, fn };
    let i = this.timers.length;
    while (i > 0 && this.timers[i - 1].at > timer.at) i--;
    this.timers.splice(i, 0, timer);
    return timer;
  };

  clearTimeout = (timer: unknown) => {
    const i = this.timers.indexOf(timer as FakeTimer);
    if (i >= 0) this.timers.splice(i, 1);
  };

  /** Timers set and not fired. */
  get pending() {
    return this.timers.length;
  }

  /** Fires what is due now, a turn after each, until two turns go by with nothing due (or `stop` holds after one). */
  async settle(stop: () => boolean = () => false) {
    for (let idle = 0; idle < 2; ) {
      await turn();
      if (stop()) return;
      const due = this.timers[0];
      if (due && due.at <= this.t) {
        this.timers.shift();
        due.fn();
        idle = 0;
      } else idle++;
    }
  }

  /** Time moves on by `ms`, each timer firing at its time. */
  async advance(ms: number) {
    const end = this.t + ms;
    await this.settle();
    while (this.timers.length && this.timers[0].at <= end) {
      this.t = Math.max(this.t, this.timers[0].at);
      await this.settle();
    }
    this.t = end;
    await this.settle();
  }

  /** Time moves on, timer by timer, until `f` holds; it fails once that would take more than `ms` of this clock's time. */
  async until(f: () => unknown, ms = 60_000, what = 'condition') {
    const end = this.t + ms;
    for (;;) {
      await this.settle();
      if (await f()) return;
      this.next(end, what);
    }
  }

  /** Time moves on until `p` settles; its value, at once, as an `await` has it (what is due after it waits). */
  async wait<T>(p: Promise<T>, ms = 60_000, what = 'the promise'): Promise<T> {
    let done = false;
    const watched = p.finally(() => (done = true));
    // Rejected before it is awaited below: not unhandled meanwhile.
    watched.catch(() => {});
    const end = this.t + ms;
    for (;;) {
      await this.settle(() => done);
      if (done) return watched;
      this.next(end, what);
    }
  }

  /** Time moves to the next timer, if it is set for `end` or before. */
  private next(end: number, what: string) {
    const next = this.timers[0];
    if (!next || next.at > end) throw new Error(`timed out waiting for ${what} (${next ? 'nothing due in time' : 'no timer set'})`);
    this.t = Math.max(this.t, next.at);
  }
}
