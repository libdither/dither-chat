/**
 * The hub's errors, and the page's, as one structured file: `traces/errors.ndjson` in the data directory
 * (docs/tracing.md "Errors"). Its lines are a contract read by dither-accounts' bugwatch extractor, which groups them by
 * fingerprint, raises a notice for each new bug and starts a thread to fix it: fields are added, never renamed or
 * dropped.
 *
 * What goes in: a throw nothing caught, a rejection nothing handled, a request answered with 5xx, a background job or
 * span that failed, a failed or partial attempt to make a group or add people, and what the page reports
 * (POST /api/errors). What stays out: 4xx answers, rate limits, refusals the code expects, a client that went away.
 *
 * Privacy: `message` comes only from an Error's message, one line of at most 300 characters; `where` is a route
 * template, a span or a job's name; `extra` holds ids and short words. Never message text, names, drafts, search text,
 * request bodies or query strings.
 *
 * A storm cannot fill the disk: the same (source, where, name, message) is written at most once per 10 s, the ones in
 * between folded into the `count` of the next line written for it, and the file takes at most 600 lines per 10 min
 * (hub.log says when lines are dropped over it).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentSpan } from './trace.ts';

export type ErrorApp = 'hub' | 'web';
export type ErrorSource = 'uncaught' | 'rejection' | 'request' | 'job' | 'attempt' | 'client';

/** One line of errors.ndjson: the contract (docs/tracing.md "Errors"). */
export interface ErrorRecord {
  v: 1;
  at: number;
  app: ErrorApp;
  source: ErrorSource;
  where: string;
  name: string;
  message: string;
  stack: string[];
  status?: number;
  trace?: string;
  version?: string;
  extra?: Record<string, string | number | boolean>;
  /** How many occurrences this line stands for; absent means one. */
  count?: number;
}

export interface ErrorReport {
  source: ErrorSource;
  where: string;
  /** What was thrown: its name, message and stack are taken from it. */
  error?: unknown;
  /** Given instead of `error` (the page's report, a status with no Error behind it). */
  name?: string;
  message?: string;
  stack?: string[] | string;
  status?: number;
  /** The trace id; the current span's when left out. */
  trace?: string;
  extra?: Record<string, string | number | boolean | null | undefined>;
  app?: ErrorApp;
  /** The page's own build (a report from the page); the hub's otherwise. */
  version?: string;
}

export const MESSAGE_MAX = 300;
export const STACK_FRAMES = 10;
const FRAME_MAX = 300;
const WHERE_MAX = 120;
const NAME_MAX = 60;
const EXTRA_MAX = 80;

/** One line of at most `max` characters. */
export function oneLine(s: string, max = MESSAGE_MAX): string {
  const line = s.replace(/\s*[\r\n][\s\S]*$/, '').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What a person typed or a network named, taken out of a message: an email address, an @handle, a phone number or any
 * long run of digits (a phone number, a snowflake). Ids with a prefix (acc_…, cnv_…) stay. It keeps a notice off the
 * phone from carrying someone's number, and the same bug with another person in it one fingerprint.
 */
export function scrub(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/(^|[\s("'])@[\w.:-]+/g, '$1@<handle>')
    .replace(/\+?\d[\d ()-]{6,}\d/g, '<number>');
}

const errorLike = (e: unknown): e is { name?: unknown; message: string; stack?: unknown } =>
  e instanceof Error || (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string');

/** An error's class: its name, or its constructor's when the class left the name as Error (AboutError, MailCallError). */
function errorName(e: object): string {
  const n = (e as { name?: unknown }).name;
  const c = e.constructor?.name;
  return typeof n === 'string' && n && n !== 'Error' ? n : c && c !== 'Object' ? c : 'Error';
}

/**
 * At most 10 frames of a stack as `at fn (file:line:col)`, each with `root` taken off its paths and any origin
 * (`https://host`) taken off a URL, so a page's frames name the bundle file and not the hub's address. Firefox's
 * `fn@file:line:col` frames are written the same way.
 */
export function stackFrames(stack: unknown, root = ''): string[] {
  const lines = Array.isArray(stack) ? stack.map(String) : typeof stack === 'string' ? stack.split('\n') : [];
  const out: string[] = [];
  for (const l of lines) {
    let f = l.trim();
    if (!f.startsWith('at ')) {
      const m = f.match(/^([^@\s]*)@(.+:\d+:\d+)$/);
      if (!m) continue;
      f = m[1] ? `at ${m[1]} (${m[2]})` : `at ${m[2]}`;
    }
    let s = f.replaceAll('file://', '').replace(/\b(?:https?|wss?):\/\/[^/\s)]+/g, '');
    if (root) s = s.replaceAll(root.endsWith('/') ? root : `${root}/`, '');
    out.push(s.length > FRAME_MAX ? s.slice(0, FRAME_MAX) : s);
    if (out.length >= STACK_FRAMES) break;
  }
  return out;
}

const cleanExtra = (x: ErrorReport['extra']) => {
  if (!x) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(x)) {
    if (v === null || v === undefined) continue;
    out[k.slice(0, 40)] = typeof v === 'string' ? oneLine(v, EXTRA_MAX) : v;
  }
  return Object.keys(out).length ? out : undefined;
};

/** A request's context: whether something inside it was reported already, so the 5xx it ends in is not a second bug. */
const inRequest = new AsyncLocalStorage<{ reported: boolean }>();

/** Run a request's handler so a report from inside it is known to its answer (`reportedInRequest`). */
export function withRequest<T>(fn: () => T): T {
  return inRequest.run({ reported: false }, fn);
}

export const reportedInRequest = () => inRequest.getStore()?.reported ?? false;

export interface ErrorLogOptions {
  now?: () => number;
  /** Paths in stacks are written relative to this. */
  root?: string;
  /** This build's git short sha. */
  version?: string;
  dedupMs?: number;
  capLines?: number;
  capWindowMs?: number;
  /** Where the cap says it dropped lines (hub.log). */
  log?: (line: string) => void;
}

interface Pending {
  /** When a line was last written for this key. */
  wroteAt: number;
  /** Occurrences since, not yet written. */
  folded: number;
  /** The latest of them, to write when the window ends. */
  latest: ErrorRecord | null;
}

export class ErrorLog {
  private readonly o: Required<Omit<ErrorLogOptions, 'version'>> & { version?: string };
  private readonly keys = new Map<string, Pending>();
  /** Error objects already written, so one passed up through a span and then caught is one line. */
  private readonly seen = new WeakSet<object>();
  private windowStart = 0;
  private windowLines = 0;
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly write: (r: ErrorRecord) => void,
    o: ErrorLogOptions = {},
  ) {
    this.o = { now: Date.now, root: '', dedupMs: 10_000, capLines: 600, capWindowMs: 600_000, log: (l) => console.warn(l), ...o };
  }

  /** Write the folded counts whose window has ended, every `dedupMs`. */
  start() {
    this.timer ??= setInterval(() => this.sweep(), this.o.dedupMs);
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sweep(true);
  }

  /** Build the record and write it, fold it, or drop it over the cap. True when a line was written. Never throws. */
  report(r: ErrorReport): boolean {
    try {
      const e = r.error;
      if (e !== null && typeof e === 'object') {
        if (this.seen.has(e)) return false;
        this.seen.add(e);
      }
      const rec = this.record(r);
      const ctx = inRequest.getStore();
      if (ctx) ctx.reported = true;
      const key = `${rec.source}\u0000${rec.where}\u0000${rec.name}\u0000${rec.message}`;
      const now = rec.at;
      const p = this.keys.get(key);
      if (p && now - p.wroteAt < this.o.dedupMs) {
        p.folded++;
        p.latest = rec;
        return false;
      }
      const folded = p?.folded ?? 0;
      if (folded) rec.count = folded + 1;
      if (!this.put(rec)) return false;
      this.keys.set(key, { wroteAt: now, folded: 0, latest: null });
      return true;
    } catch {
      return false;
    }
  }

  /** The record a report makes: clipped, stacks relative to the repo, the trace and version filled in. */
  record(r: ErrorReport): ErrorRecord {
    const e = r.error;
    const like = errorLike(e);
    const name = oneLine(String(r.name ?? (like ? errorName(e) : e === undefined ? 'Error' : typeof e)), NAME_MAX) || 'Error';
    const message = oneLine(scrub(r.message ?? (like ? e.message : e === undefined ? '' : `a ${typeof e} was thrown, not an Error`)));
    const trace = r.trace ?? currentSpan().traceId;
    const version = r.version ?? this.o.version;
    const extra = cleanExtra(r.extra);
    return {
      v: 1,
      at: this.o.now(),
      app: r.app ?? 'hub',
      source: r.source,
      where: oneLine(r.where, WHERE_MAX) || '-',
      name,
      message,
      stack: stackFrames(r.stack ?? (like ? e.stack : undefined), this.o.root),
      ...(typeof r.status === 'number' && Number.isFinite(r.status) ? { status: r.status } : {}),
      ...(trace ? { trace } : {}),
      ...(version ? { version } : {}),
      ...(extra ? { extra } : {}),
    };
  }

  /** Folded occurrences whose window has ended, as lines (all of them when the log closes). */
  sweep(all = false) {
    const now = this.o.now();
    for (const [key, p] of this.keys) {
      if (p.folded && p.latest && (all || now - p.wroteAt >= this.o.dedupMs)) {
        const rec = { ...p.latest, count: p.folded };
        p.folded = 0;
        p.latest = null;
        p.wroteAt = now;
        this.put(rec);
      } else if (!p.folded && now - p.wroteAt >= this.o.capWindowMs) this.keys.delete(key);
    }
    this.rollWindow(now);
  }

  private rollWindow(now: number) {
    if (now - this.windowStart < this.o.capWindowMs) return;
    if (this.dropped) this.o.log(`errors: ${this.dropped} lines dropped over the cap of ${this.o.capLines} per ${Math.round(this.o.capWindowMs / 60_000)} min (traces/errors.ndjson)`);
    this.windowStart = now;
    this.windowLines = 0;
    this.dropped = 0;
  }

  private put(rec: ErrorRecord): boolean {
    this.rollWindow(rec.at);
    if (this.windowLines >= this.o.capLines) {
      if (!this.dropped) this.o.log(`errors: over the cap of ${this.o.capLines} lines per ${Math.round(this.o.capWindowMs / 60_000)} min; dropping until the window ends`);
      this.dropped++;
      return false;
    }
    this.windowLines++;
    this.write(rec);
    return true;
  }
}

let current: ErrorLog | null = null;

/** Where reports go; null (tests, scripts, DITHER_TRACE=0) turns them off. */
export function setErrorLog(l: ErrorLog | null) {
  current = l;
}

/** Report an error to traces/errors.ndjson. Never throws; does nothing when no log is set. */
export function reportError(r: ErrorReport): boolean {
  return current?.report(r) ?? false;
}

/** A background job's failure: the job's name, what was thrown, and ids. */
export function jobFailed(where: string, error: unknown, extra?: ErrorReport['extra']): void {
  // The hub stopping under a job (its database closed) is not a bug.
  if (/closed database|database is closed/i.test(String((error as Error)?.message ?? ''))) return;
  reportError({ source: 'job', where, error, extra });
}

// ------------------------------------------------------------------ the page's reports (POST /api/errors)

/** What the page may send, clipped and checked; null when it is not a report. */
export function clientReport(body: unknown): ErrorReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.message !== 'string' || typeof b.where !== 'string') return null;
  // A route template: `#/chat/:id`, never an id or anything typed (the page makes it; the hub holds it to the shape).
  const where = b.where.slice(0, WHERE_MAX);
  if (!/^#?\/[\w/:-]*$/.test(where)) return null;
  if (b.name !== undefined && typeof b.name !== 'string') return null;
  if (b.stack !== undefined && typeof b.stack !== 'string' && !Array.isArray(b.stack)) return null;
  if (b.status !== undefined && (typeof b.status !== 'number' || !Number.isInteger(b.status) || b.status < 0 || b.status > 599)) return null;
  if (b.version !== undefined && typeof b.version !== 'string') return null;
  const stack = Array.isArray(b.stack) ? b.stack.slice(0, STACK_FRAMES * 2).filter((f): f is string => typeof f === 'string') : (b.stack as string | undefined)?.slice(0, 8000);
  const version = typeof b.version === 'string' && /^[\w.\-+]{1,40}$/.test(b.version) ? b.version : undefined;
  return {
    app: 'web',
    source: 'client',
    where,
    name: (b.name as string | undefined) || 'Error',
    message: b.message,
    stack: stack ?? [],
    ...(typeof b.status === 'number' ? { status: b.status } : {}),
    ...(version ? { version } : {}),
    trace: '',
  };
}

/** At most `max` reports a minute from one client (by address). */
export class PerClientCap {
  private readonly seen = new Map<string, { start: number; n: number }>();
  constructor(
    private readonly max = 60,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  take(client: string): boolean {
    const t = this.now();
    let w = this.seen.get(client);
    if (!w || t - w.start >= this.windowMs) {
      if (this.seen.size > 1000) for (const [k, v] of this.seen) if (t - v.start >= this.windowMs) this.seen.delete(k);
      w = { start: t, n: 0 };
      this.seen.set(client, w);
    }
    return ++w.n <= this.max;
  }
}
