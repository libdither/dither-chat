/**
 * One queue per mail account (docs/mail-design.md §3.5): four priorities, at most two pieces of work at once. A piece
 * of work makes its own calls (a mail.changes pass with `more`, a relist, a body fetch); the queue decides when it
 * starts.
 *
 *   P0 user      what a page is waiting for: a body, a page of an open mailbox
 *   P1 keep-up   mail.changes, and the first sync
 *   P2 prefetch  bodies nobody asked for yet (slice 2)
 *   P3 backfill  older pages (slice 2)
 *
 * The same `key` queued twice is one piece of work (two mail.changed for one mailbox make one changes pass). The
 * manager's `limited` answer puts the work back and holds the queue, from 2 s, doubling. Slice 2's budgets plug in as
 * `gate`.
 */
import { type Clock, realClock } from '../clock.ts';
import { asMailError } from './backend.ts';

export type Priority = 0 | 1 | 2 | 3;
export const P0 = 0, P1 = 1, P2 = 2, P3 = 3;

interface Task {
  p: Priority;
  key: string | null;
  fn: () => Promise<unknown>;
  done: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class MailQueue {
  private waiting: Task[][] = [[], [], [], []];
  private running = new Set<Task>();
  private holdUntil = 0;
  private backoff = 0;
  private timer: unknown = null;
  private stopped = false;
  /**
   * How long work of this priority must wait before it may start (0: now). Slice 2 sets it for its budgets: P2 and P3
   * together at most 2 calls/s, and none for 10 s after a P0 call.
   */
  gate: (p: Priority, now: number) => number = () => 0;
  /** Told when a piece of work starts: slice 2's budgets count them. */
  onStart: (p: Priority, now: number) => void = () => {};
  /** Told when a piece of work ends, done or not (slice 2: how many background calls are in flight). */
  onEnd: (p: Priority, now: number) => void = () => {};

  constructor(
    private concurrency = 2,
    private now: () => number = Date.now,
    private clock: Pick<Clock, 'setTimeout' | 'clearTimeout'> = realClock,
  ) {}

  get size() {
    return this.waiting.reduce((n, q) => n + q.length, 0) + this.running.size;
  }

  /** Run `fn` at priority `p`. With a `key`, work under the same key that has not started yet is shared. */
  run<T>(p: Priority, key: string | null, fn: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(asMailError(new Error('stopped')));
    if (key) {
      for (const q of this.waiting) {
        const t = q.find((x) => x.key === key);
        if (t) {
          // Asked for sooner than it was queued: it moves up.
          if (p < t.p) {
            q.splice(q.indexOf(t), 1);
            t.p = p;
            this.waiting[p].push(t);
          }
          return t.done as Promise<T>;
        }
      }
    }
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<unknown>((a, b) => ((resolve = a), (reject = b)));
    // Nobody may be waiting on keep-up work: its failure is logged where it is queued.
    done.catch(() => {});
    this.waiting[p].push({ p, key, fn, done, resolve, reject });
    this.pump();
    return done as Promise<T>;
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    for (const q of this.waiting) for (const t of q.splice(0)) t.reject(asMailError(new Error('the account stopped syncing')));
  }

  private pump() {
    if (this.stopped) return;
    if (this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    let wait = Infinity;
    while (this.running.size < this.concurrency) {
      const now = this.now();
      if (now < this.holdUntil) {
        wait = Math.min(wait, this.holdUntil - now);
        break;
      }
      let next: Task | undefined;
      for (let p = 0 as Priority; p <= 3; p = (p + 1) as Priority) {
        if (!this.waiting[p].length) continue;
        const g = this.gate(p, now);
        if (g > 0) {
          wait = Math.min(wait, g);
          continue;
        }
        next = this.waiting[p].shift();
        break;
      }
      if (!next) break;
      this.start(next);
    }
    if (wait < Infinity && this.size > this.running.size) this.timer = this.clock.setTimeout(() => this.pump(), Math.max(10, wait));
  }

  private start(t: Task) {
    this.running.add(t);
    this.onStart(t.p, this.now());
    const p = t.p;
    t.fn().then(
      (v) => {
        this.backoff = 0;
        this.running.delete(t);
        this.onEnd(p, this.now());
        t.resolve(v);
        this.pump();
      },
      (e) => {
        this.running.delete(t);
        this.onEnd(p, this.now());
        const err = asMailError(e);
        if (err.code === 'limited' && !this.stopped) {
          // The manager's rate limit: back in front of its line, and everything waits a while.
          this.backoff = this.backoff ? Math.min(this.backoff * 2, 60_000) : 2_000;
          this.holdUntil = this.now() + this.backoff;
          this.waiting[t.p].unshift(t);
        } else t.reject(err);
        this.pump();
      },
    );
  }
}
