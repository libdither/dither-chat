/**
 * The stall log (docs/perf.md, "The hub's own stalls"). The hub answers everything on one thread, so anything that
 * holds it for long holds up every device. A timer that should fire every `everyMs` and fires late says how long the
 * loop was held; the work that began in that time (background jobs, requests and adapter events note themselves with
 * `noteWork`, a few into a small ring) says what held it. For the first ten minutes after a start every hold of 200 ms
 * or more is logged, later only those of two seconds or more, and once the ten minutes are over one line sums them up:
 *
 *   stall: 23.8 s from 10.4 s after start: embeddings refit, GET /api/bootstrap
 *   stalls: 3 of 200 ms or more in the first 10 min, the longest 23.8 s (embeddings refit)
 */
type Note = { at: number; what: string };

const RING = 64;
const ring: Note[] = [];
let head = 0;

/** Something that starts now on the hub's thread: a slice of a job, a request, a batch of adapter events. */
export function noteWork(what: string, at = performance.now()) {
  ring[head] = { at, what };
  head = (head + 1) % RING;
}

/** What began between `from` and `to`, each once with how often, in order. */
export function workBetween(from: number, to: number): string {
  const seen = new Map<string, number>();
  for (let i = 0; i < ring.length; i++) {
    const n = ring[(head + i) % ring.length];
    if (n && n.at >= from && n.at <= to) seen.set(n.what, (seen.get(n.what) ?? 0) + 1);
  }
  return [...seen].map(([w, k]) => (k > 1 ? `${w} ×${k}` : w)).join(', ') || 'nothing noted';
}

/** A request's path with its ids left out: `/api/conversations/:id/messages`. */
export function pathShape(path: string): string {
  return path
    .split('/')
    .map((s) => (s.length > 24 || /[\d_]/.test(s) ? ':id' : s))
    .join('/');
}

const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

export interface StallOptions {
  everyMs?: number;
  /** Holds this long or longer are logged while `forMs` lasts... */
  overMs?: number;
  forMs?: number;
  /** ...and these after it. */
  laterOverMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

export class StallWatch {
  private readonly o: Required<StallOptions>;
  private start = 0;
  private last = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private summed = false;
  /** Holds logged in the first `forMs`, and the longest with what began in it. */
  count = 0;
  longest: { ms: number; what: string } | null = null;

  constructor(o: StallOptions = {}) {
    this.o = { everyMs: 100, overMs: 200, forMs: 10 * 60_000, laterOverMs: 2000, log: (l) => console.log(l), now: () => performance.now(), ...o };
  }

  /** Watch from now: a timer every `everyMs`. */
  begin() {
    this.from(this.o.now());
    this.timer = setInterval(() => this.check(), this.o.everyMs);
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }

  /** Count from `t` (a test's clock, without the timer). */
  from(t: number) {
    this.start = this.last = t;
    return this;
  }

  /** The timer fired: was it late? (A test calls it with its own clock.) */
  check(t = this.o.now()) {
    const held = t - this.last - this.o.everyMs;
    const early = this.last - this.start < this.o.forMs;
    if (held >= (early ? this.o.overMs : this.o.laterOverMs)) {
      const what = workBetween(this.last, t);
      this.o.log(`stall: ${secs(held)} from ${secs(this.last - this.start)} after start: ${what}`);
      if (early) {
        this.count++;
        if (!this.longest || held > this.longest.ms) this.longest = { ms: held, what };
      }
    }
    this.last = t;
    if (!this.summed && t - this.start >= this.o.forMs) {
      this.summed = true;
      const mins = Math.round(this.o.forMs / 60_000);
      this.o.log(
        this.count
          ? `stalls: ${this.count} of ${secs(this.o.overMs)} or more in the first ${mins} min, the longest ${secs(this.longest!.ms)} (${this.longest!.what})`
          : `stalls: none of ${secs(this.o.overMs)} or more in the first ${mins} min`,
      );
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
