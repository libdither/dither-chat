/**
 * One queue per mail account (docs/mail-design.md §3.5): six priorities, at most two pieces of work at once. A piece
 * of work makes its own calls (a mail.changes pass with `more`, a relist, a body fetch); the queue decides when it
 * starts.
 *
 *   P0 user      what a page is waiting for: a body, a page of an open mailbox
 *   P1 keep-up   mail.changes, and the first sync
 *   P2 prefetch  bodies nobody asked for yet (slice 2)
 *   P3 backfill  older pages (slice 2), and a kept account's walk (keep.ts)
 *   P4 archive   a kept account's bodies and mailbox counts (keep.ts)
 *   P5 audit     Gmail's month windows searched (keep.ts): the lowest
 *
 * The same `key` queued twice is one piece of work (two mail.changed for one mailbox make one changes pass). The
 * manager's `limited` answer puts the work back and holds the queue, from 2 s, doubling. Other failures that may pass
 * (backend.ts troubleOf: transient, or a 502) fail the work and hold the background (P1 and lower) from 2 s, doubling
 * to 10 min with jitter, until a call succeeds; `streak` says since when, for the bug watch (sync.ts report). Slice 2's
 * budgets plug in as `gate`.
 */
import { type Clock, realClock } from '../clock.ts';
import { asMailError, backoffMs, MailCallError, type MailTrouble, troubleOf } from './backend.ts';

export type Priority = 0 | 1 | 2 | 3 | 4 | 5;
export const P0 = 0, P1 = 1, P2 = 2, P3 = 3, P4 = 4, P5 = 5;
const LOWEST = P5;

interface Task {
  p: Priority;
  key: string | null;
  fn: () => Promise<unknown>;
  done: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class MailQueue {
  private waiting: Task[][] = Array.from({ length: LOWEST + 1 }, () => []);
  private running = new Set<Task>();
  private holdUntil = 0;
  private backoff = 0;
  private timer: unknown = null;
  private stopped = false;
  /** Background work waits until then: failures that may pass came one after another. */
  private quietUntil = 0;
  /**
   * Failures that may pass, one after another with no success between: how many, since when, of which kind, and
   * whether the bug watch heard of this streak.
   */
  readonly streak: { n: number; since: number; kind: MailTrouble | null; reported: boolean } = { n: 0, since: 0, kind: null, reported: false };
  /** The jitter's dice (tests fix it). */
  random: () => number = Math.random;
  /**
   * How long work of this priority must wait before it may start (0: now). Slice 2 sets it for its budgets: P2 to P5
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
    if (this.stopped) return Promise.reject(stoppedError());
    if (key) {
      for (const q of this.waiting) {
        const t = q.find((x) => x.key === key);
        if (t) {
          // Asked for sooner than it was queued: it moves up, and starts now if it may. Without the pump it sat until
          // something else ended or the gate's timer for the line it had left went off: a body fetched ahead (P2),
          // then asked for by a page (P0), waited out the ten quiet seconds a page's call gives the background.
          if (p < t.p) {
            q.splice(q.indexOf(t), 1);
            t.p = p;
            this.waiting[p].push(t);
            this.pump();
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
    for (const q of this.waiting) for (const t of q.splice(0)) t.reject(stoppedError());
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
      for (let p = 0 as Priority; p <= LOWEST; p = (p + 1) as Priority) {
        if (!this.waiting[p].length) continue;
        if (p > P0 && now < this.quietUntil) {
          wait = Math.min(wait, this.quietUntil - now);
          continue;
        }
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
        this.quietUntil = 0;
        Object.assign(this.streak, { n: 0, since: 0, kind: null, reported: false });
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
        } else {
          if (!this.stopped) this.failed(err);
          t.reject(err);
        }
        this.pump();
      },
    );
  }

  /** A failure that may pass lengthens the streak and the background's wait; any other leaves both as they are. */
  private failed(err: MailCallError) {
    const kind = troubleOf(err);
    if (kind !== 'transient' && kind !== 'layout') return;
    const now = this.now();
    const s = this.streak;
    // Another kind of trouble is another state: its own streak.
    if (s.kind !== kind) Object.assign(s, { n: 0, since: now, kind, reported: false });
    s.n++;
    this.quietUntil = now + backoffMs(s.n, 2_000, 600_000, this.random);
  }
}

/** Work turned away because the account stopped syncing (it went, or the hub is stopping): not a failure. */
const stoppedError = () => new MailCallError('the account stopped syncing', undefined, 'stopped');
