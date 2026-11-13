/**
 * Tracing (docs/tracing.md). Every unit of work the hub does at a boundary is a span: a request, a batch of adapter
 * events, a command to an adapter, a triage decision, a background job. A span knows its trace, its parent, how long it
 * took, a few attributes and whether it failed. Every finished span is one line of NDJSON in a file that rotates by
 * size, so the slow and the failed are found afterwards by a query (scripts/trace-summary.ts) instead of being chosen
 * when they are written: nothing has to guess in advance what "slow" means.
 *
 * The parent is carried by AsyncLocalStorage, so a span started inside another one, across any number of awaits, is its
 * child without passing anything along. A request that brings a W3C `traceparent` header joins that trace.
 *
 * Attributes are for ids, counts, kinds, statuses and route shapes: never message text, names or anything a person
 * wrote. The files stay in the data directory, which is private to the hub's user.
 *
 * With no sink set (tests, scripts) a span costs a function call: nothing is kept and no context is carried.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { noteWork } from './stalls.ts';

export type Attr = string | number | boolean | null;
export type Attrs = Record<string, Attr>;

/** One finished span, as written: one line of the trace file. The names follow OpenTelemetry's where they can. */
export interface SpanRecord {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Unix ms. */
  startMs: number;
  durationMs: number;
  attrs: Attrs;
  events?: { name: string; atMs: number; attrs?: Attrs }[];
  status: 'ok' | 'error';
  error?: string;
}

const hex = (bytes: number) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
};

export class Span {
  readonly spanId = hex(8);
  readonly traceId: string;
  readonly parentSpanId: string | undefined;
  /** performance.now() at start and end, for overlap with stalls. */
  readonly t0 = performance.now();
  t1 = 0;
  readonly startMs = Date.now();
  attrs: Attrs;
  events: { name: string; atMs: number; attrs?: Attrs }[] | undefined;
  failed: string | undefined;

  constructor(
    readonly name: string,
    attrs: Attrs,
    parent: { traceId: string; spanId: string } | undefined,
  ) {
    this.traceId = parent?.traceId ?? hex(16);
    this.parentSpanId = parent?.spanId;
    this.attrs = { ...attrs };
  }

  set(attrs: Attrs) {
    Object.assign(this.attrs, attrs);
    return this;
  }

  /** Something that happened inside the span, at a time: a phase reached, a retry, a reply. */
  event(name: string, attrs?: Attrs) {
    (this.events ??= []).push({ name, atMs: Math.round((performance.now() - this.t0) * 10) / 10, ...(attrs ? { attrs } : {}) });
    return this;
  }

  /** Mark it failed without throwing (a status the caller turns into an answer, like a 502). */
  fail(why: unknown) {
    this.failed = errorText(why);
    return this;
  }

  /** W3C trace context for a call that leaves this process. */
  get traceparent() {
    return `00-${this.traceId}-${this.spanId}-01`;
  }

  record(): SpanRecord {
    return {
      name: this.name,
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      startMs: this.startMs,
      durationMs: Math.round((this.t1 - this.t0) * 10) / 10,
      attrs: this.attrs,
      ...(this.events ? { events: this.events } : {}),
      status: this.failed === undefined ? 'ok' : 'error',
      ...(this.failed !== undefined ? { error: this.failed } : {}),
    };
  }
}

/** An error's message, short, without a stack: a status, a timeout, a reason. */
function errorText(e: unknown): string {
  const s = e instanceof Error ? `${e.name === 'Error' ? '' : `${e.name}: `}${e.message}` : String(e);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** A span that keeps nothing, for when tracing is off. */
const OFF = Object.freeze({
  set: () => OFF,
  event: () => OFF,
  fail: () => OFF,
  traceparent: undefined,
}) as unknown as Span;

const context = new AsyncLocalStorage<Span>();
let sink: ((r: SpanRecord) => void) | null = null;

/** Spans still running, and the last few finished, for the stall record (what was on the thread while it was held). */
const open = new Set<Span>();
const RECENT = 64;
const recent: Span[] = [];
let recentHead = 0;

/** Where finished spans go; null turns tracing off. */
export function setTraceSink(s: ((r: SpanRecord) => void) | null) {
  sink = s;
  open.clear();
  recent.length = 0;
  recentHead = 0;
}

export const tracing = () => sink !== null;

/** A W3C traceparent header's ids, if it is one. */
export function parseTraceparent(h: string | null | undefined): { traceId: string; spanId: string } | undefined {
  const m = h?.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return undefined;
  return { traceId: m[1]!, spanId: m[2]! };
}

export interface SpanOptions {
  /** A parent from outside this process (a request's traceparent). Without it, the current span is the parent. */
  parent?: { traceId: string; spanId: string };
  /** What the stall log calls it, if not the span's name. */
  note?: string;
}

/**
 * Run `fn` as a span named `name`. Its result, sync or a promise, comes back unchanged; a throw or a rejection marks the
 * span failed and is passed on. Every span also notes itself for the stall log (stalls.ts).
 */
export function span<T>(name: string, attrs: Attrs, fn: (s: Span) => T, o: SpanOptions = {}): T {
  noteWork(o.note ?? name);
  if (!sink) return fn(OFF);
  const s = new Span(name, attrs, o.parent ?? context.getStore());
  open.add(s);
  let r: T;
  try {
    r = context.run(s, fn, s);
  } catch (e) {
    s.fail(e);
    finish(s);
    throw e;
  }
  if (r instanceof Promise) {
    return r.then(
      (v) => {
        finish(s);
        return v;
      },
      (e) => {
        s.fail(e);
        finish(s);
        throw e;
      },
    ) as T;
  }
  finish(s);
  return r;
}

/**
 * A span started by hand, for work that is not one function: `end()` it when done, or `drop()` it if it turns out to be
 * nothing worth keeping (a flush with nothing in it). It does not become the current span, so it has no children.
 */
export function startSpan(name: string, attrs: Attrs = {}): Span & { end(): void; drop(): void } {
  if (!sink) {
    const off = { end() {}, drop() {}, set: () => off, event: () => off, fail: () => off, traceparent: undefined };
    return off as unknown as Span & { end(): void; drop(): void };
  }
  const s = new Span(name, attrs, context.getStore()) as Span & { end(): void; drop(): void };
  open.add(s);
  let done = false;
  s.end = () => {
    if (!done) finish(s);
    done = true;
  };
  s.drop = () => {
    open.delete(s);
    done = true;
  };
  return s;
}

function finish(s: Span) {
  s.t1 = performance.now();
  open.delete(s);
  recent[recentHead] = s;
  recentHead = (recentHead + 1) % RECENT;
  try {
    sink?.(s.record());
  } catch {}
}

/** The span this code runs in, to add attributes or events to it; a span that keeps nothing when there is none. */
export function currentSpan(): Span {
  return (sink && context.getStore()) || OFF;
}

/** Set attributes on the current span. */
export function annotate(attrs: Attrs) {
  currentSpan().set(attrs);
}

/** Spans that were on the thread between `from` and `to` (performance.now()): still open now, or finished in it. */
export function spansBetween(from: number, to: number, max = 8): { name: string; traceId: string; spanId: string; open?: true }[] {
  const out: { name: string; traceId: string; spanId: string; open?: true }[] = [];
  for (const s of open) if (out.length < max) out.push({ name: s.name, traceId: s.traceId, spanId: s.spanId, open: true });
  for (const s of recent) if (s && s.t1 >= from && s.t0 <= to && out.length < max) out.push({ name: s.name, traceId: s.traceId, spanId: s.spanId });
  return out;
}

// ------------------------------------------------------------------ files

export interface NdjsonFileOptions {
  /** Rotate when the file reaches this size... */
  maxBytes?: number;
  /** ...keeping this many older files (name.1 the newest). */
  keep?: number;
  /** Write what waits at least this often. */
  flushMs?: number;
  /** And at once when this much waits. */
  bufferBytes?: number;
}

/**
 * Lines appended to a file in batches, rotated by size. A write that fails is reported once and the batch dropped:
 * tracing never takes the hub down.
 */
export class NdjsonFile {
  private buf: string[] = [];
  private bufBytes = 0;
  private size: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private complained = false;
  private readonly o: Required<NdjsonFileOptions>;

  constructor(
    readonly path: string,
    o: NdjsonFileOptions = {},
  ) {
    this.o = { maxBytes: 10 * 1024 * 1024, keep: 10, flushMs: 1000, bufferBytes: 256 * 1024, ...o };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.size = existsSync(path) ? statSync(path).size : 0;
    this.timer = setInterval(() => this.flush(), this.o.flushMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  readonly push = (rec: unknown) => {
    const line = `${JSON.stringify(rec)}\n`;
    this.buf.push(line);
    this.bufBytes += line.length;
    if (this.bufBytes >= this.o.bufferBytes) this.flush();
  };

  flush() {
    if (!this.buf.length) return;
    const text = this.buf.join('');
    this.buf = [];
    this.bufBytes = 0;
    try {
      if (this.size > 0 && this.size + text.length > this.o.maxBytes) this.rotate();
      appendFileSync(this.path, text, { mode: 0o600 });
      this.size += Buffer.byteLength(text);
    } catch (e) {
      if (!this.complained) console.error(`trace: writing ${this.path} failed, dropping what it could not write:`, e);
      this.complained = true;
    }
  }

  private rotate() {
    const last = `${this.path}.${this.o.keep}`;
    if (existsSync(last)) rmSync(last);
    for (let i = this.o.keep - 1; i >= 1; i--) if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    renameSync(this.path, `${this.path}.1`);
    this.size = 0;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }
}
