/**
 * The stall log (docs/perf.md, "The hub's own stalls"). The hub answers everything on one thread, so anything that
 * holds it for long holds up every device. A timer that should fire every `everyMs` and fires late says how long the
 * loop was held; the work that began in that time (background jobs, requests and adapter events note themselves with
 * `noteWork`, a few into a small ring) says what held it. For the first ten minutes after a start every hold of 200 ms
 * or more is logged, later only those of two seconds or more, and once the ten minutes are over one line sums them up:
 *
 *   stall: 23.8 s from 10.4 s after start: embeddings refit, GET /api/bootstrap
 *   stalls: 3 of 200 ms or more in the first 10 min, the longest 23.8 s (embeddings refit)
 *
 * Every hold of `overMs` or more, at any time, also goes to `record` (docs/tracing.md): main.ts writes them to
 * event-loop-stalls.ndjson beside the trace, with the spans that were on the thread and what the process did while it
 * was held (CPU time, page faults, context switches), which tells JavaScript work from a wait on the disk or on memory.
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

/** The process's counters that say what a hold was made of (process.resourceUsage(), in µs and counts). */
export interface Usage {
  userCPUTime: number;
  systemCPUTime: number;
  minorPageFault: number;
  majorPageFault: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
}

/** One hold, as event-loop-stalls.ndjson keeps it. */
export interface StallRecord {
  /** Unix ms when it ended. */
  atMs: number;
  heldMs: number;
  afterStartMs: number;
  work: string;
  spans: { name: string; traceId: string; spanId: string; open?: true }[];
  /** What the process did from the last tick to this one: CPU in ms, the rest counts. */
  cpuUserMs?: number;
  cpuSystemMs?: number;
  minorFaults?: number;
  majorFaults?: number;
  voluntarySwitches?: number;
  involuntarySwitches?: number;
}

export interface StallOptions {
  everyMs?: number;
  /** Holds this long or longer are logged while `forMs` lasts... */
  overMs?: number;
  forMs?: number;
  /** ...and these after it. */
  laterOverMs?: number;
  log?: (line: string) => void;
  now?: () => number;
  /** Every hold of `overMs` or more, at any time (not only the first `forMs`). */
  record?: ((r: StallRecord) => void) | null;
  /** The spans on the thread between two times (trace.ts spansBetween). */
  spans?: (from: number, to: number) => StallRecord['spans'];
  /** The process's counters; null leaves them out. */
  usage?: (() => Usage) | null;
  wallNow?: () => number;
}

export class StallWatch {
  private readonly o: Required<StallOptions>;
  private start = 0;
  private last = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private summed = false;
  private lastUsage: Usage | null = null;
  /** Holds logged in the first `forMs`, and the longest with what began in it. */
  count = 0;
  longest: { ms: number; what: string } | null = null;

  constructor(o: StallOptions = {}) {
    this.o = {
      everyMs: 100,
      overMs: 200,
      forMs: 10 * 60_000,
      laterOverMs: 2000,
      log: (l) => console.log(l),
      now: () => performance.now(),
      record: null,
      spans: () => [],
      usage: () => process.resourceUsage(),
      wallNow: () => Date.now(),
      ...o,
    };
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
    this.lastUsage = this.o.usage ? this.o.usage() : null;
    return this;
  }

  /** The timer fired: was it late? (A test calls it with its own clock.) */
  check(t = this.o.now()) {
    const held = t - this.last - this.o.everyMs;
    const early = this.last - this.start < this.o.forMs;
    const usage = this.o.usage ? this.o.usage() : null;
    if (held >= this.o.overMs && this.o.record) {
      const u = usage && this.lastUsage ? usage : null;
      const was = this.lastUsage!;
      this.o.record({
        atMs: this.o.wallNow(),
        heldMs: Math.round(held),
        afterStartMs: Math.round(this.last - this.start),
        work: workBetween(this.last, t),
        spans: this.o.spans(this.last, t),
        ...(u
          ? {
              cpuUserMs: Math.round((u.userCPUTime - was.userCPUTime) / 1000),
              cpuSystemMs: Math.round((u.systemCPUTime - was.systemCPUTime) / 1000),
              minorFaults: u.minorPageFault - was.minorPageFault,
              majorFaults: u.majorPageFault - was.majorPageFault,
              voluntarySwitches: u.voluntaryContextSwitches - was.voluntaryContextSwitches,
              involuntarySwitches: u.involuntaryContextSwitches - was.involuntaryContextSwitches,
            }
          : {}),
      });
    }
    this.lastUsage = usage;
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

/** A write transaction this long or longer is logged (`timedWrite`). */
export const SLOW_WRITE_MS = 500;

/**
 * A write transaction, logged when it took SLOW_WRITE_MS or more: its statements and its commit, which waits on the
 * hub's thread for the disk (synchronous FULL) or for another connection's lock (busy_timeout). A hold the stall log
 * names only as "adapter events" or "flush" is then one of these, or plainly not.
 */
export function timedWrite<T>(what: string, fn: () => T, log: (line: string) => void = (l) => console.warn(l), now: () => number = () => performance.now()): T {
  return timed(what, fn, log, now, (ms) => `slow write: ${secs(ms)} in one transaction (${what})`);
}

/**
 * Work that runs in one piece on the hub's thread and does not note itself otherwise (what an answer from mail's
 * backend sets off, say): noted, and logged as `slow: <time> in <what>` when it took SLOW_WRITE_MS or more.
 */
export function timedWork<T>(what: string, fn: () => T, log: (line: string) => void = (l) => console.warn(l), now: () => number = () => performance.now()): T {
  noteWork(what);
  return timed(what, fn, log, now, (ms) => `slow: ${secs(ms)} in ${what}`);
}

function timed<T>(what: string, fn: () => T, log: (line: string) => void, now: () => number, line: (ms: number) => string): T {
  const t = now();
  try {
    return fn();
  } finally {
    const ms = now() - t;
    if (ms >= SLOW_WRITE_MS) log(line(ms));
  }
}
