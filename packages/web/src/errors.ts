/**
 * The page's errors, to the hub's traces/errors.ndjson (POST /api/errors; docs/tracing.md "Errors"): a throw nothing
 * caught, a rejection nothing handled, and a time the hub could not be reached that was the hub's to answer for (HubLoss,
 * below). Not an answer with a status: the hub writes each 5xx it answers itself, so the page sending it too would make
 * one bug two. Not an abort, not while offline. `where` is the page's route as a template (`#/inbox/c/:id`), never an id or anything
 * typed; `message` is an Error's message (the hub clips it). At most 20 reports a minute, the same one at most once a
 * minute. Reporting never throws.
 */

declare const __BUILD_SHA__: string;
const VERSION = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : undefined;

/** The words of the app's addresses (routes.ts); every other segment is an id, a name or something typed. */
const WORDS = new Set(['inbox', 'c', 'people', 'graph', 'p', 'i', 'about', 's', 'groups', 'spaces', 'f', 'accounts', 'settings', 'triage', 'foryou', 'model', 'attention', 'directory', 'search', 'requests', 'notices', 'calibration', 'mail', 'l', 't', 'calendar']);

/** A hash as a route template: `#/inbox/c/dc_123?m=x` → `#/inbox/c/:id`. */
export function routeTemplate(hash: string): string {
  const path = hash.replace(/^#\/?/, '').split('?')[0];
  const parts = path.split('/').filter(Boolean).map((p) => (WORDS.has(p) ? p : ':id'));
  return `#/${parts.join('/')}`;
}

/** An API path as a template, as the hub names its requests (stalls.ts pathShape). Query strings dropped. */
export function apiTemplate(path: string): string {
  return path
    .split('?')[0]
    .split('/')
    .map((s) => (s.length > 24 || /[\d_]/.test(s) ? ':id' : s))
    .join('/');
}

/** At most `perMinute` reports a minute, and the same key at most once a minute. */
export class ReportLimiter {
  private times: number[] = [];
  private last = new Map<string, number>();
  constructor(
    private readonly perMinute = 20,
    private readonly sameMs = 60_000,
  ) {}

  allow(key: string, now: number): boolean {
    this.times = this.times.filter((t) => now - t < 60_000);
    if (this.times.length >= this.perMinute) return false;
    const l = this.last.get(key);
    if (l !== undefined && now - l < this.sameMs) return false;
    if (this.last.size > 200) this.last.clear();
    this.last.set(key, now);
    this.times.push(now);
    return true;
  }
}

interface PageError {
  name: string;
  message: string;
  stack?: string;
  status?: number;
  /** Ids, templates and numbers only (docs/tracing.md "Errors"). */
  extra?: Record<string, string | number | boolean>;
}

const limiter = new ReportLimiter();
/** Errors already sent, so a rejection of one api() reported is not sent twice. */
const sent = new WeakSet<object>();

/** Send one report, if the limits allow. Never throws. */
function reportPageError(e: PageError, error?: unknown): void {
  try {
    if (error && typeof error === 'object') {
      if (sent.has(error)) return;
      sent.add(error);
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const where = routeTemplate(location.hash);
    if (!limiter.allow(`${e.name}\u0000${e.message}\u0000${where}`, Date.now())) return;
    const body = { name: e.name, message: String(e.message).slice(0, 600), stack: (e.stack ?? '').slice(0, 4000), where, ...(e.status ? { status: e.status } : {}), ...(e.extra ? { extra: e.extra } : {}), ...(VERSION ? { version: VERSION } : {}) };
    void fetch('/api/errors', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
  } catch {}
}

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

/** An error object's report, or null for what is not one to send (an abort, an api() error with a status: the hub has it). */
export function pageError(e: unknown): PageError | null {
  if (e === null || e === undefined || isAbort(e)) return null;
  if (typeof (e as { status?: unknown }).status === 'number') return null;
  if (typeof e === 'object' && typeof (e as Error).message === 'string')
    return { name: String((e as Error).name || 'Error'), message: (e as Error).message, stack: typeof (e as Error).stack === 'string' ? (e as Error).stack : undefined };
  return { name: typeof e, message: `a ${typeof e} was thrown, not an Error` };
}

/**
 * A fetch that did not reach the hub ("Failed to fetch") is mostly not the hub's fault: the page reloading (a new build,
 * the bar's Reload) cuts its fetches off, a phone waking up has no network for a moment, the device goes offline, the
 * network changes under it. And a report can only arrive once the hub is reachable again, so each one that does arrive
 * was a loss that ended. So a failure starts a loss: the page asks `GET /api/health` until the hub answers, gathering
 * the other calls that fail meanwhile, and then judges the whole loss once (`lossVerdict`). Only a loss with none of
 * those reasons that lasted `BLIP_MS` or more is sent, as one report: "the hub was not reached for 10 s or more",
 * with the calls that failed in `extra`. The hub then drops it too if it was restarting or answering others meanwhile
 * (packages/hub/src/errors.ts `lossCovered`).
 */
export const BLIP_MS = 10_000;
/** A failure this soon after the page came into sight, back from the cache or onto another network: it was waking. */
const WAKE_MS = 15_000;
const PROBE_FIRST_MS = 1500;
const PROBE_MAX_MS = 30_000;
/** Still lost after this: stop asking (the page is likely asleep or gone); a later failure starts a new loss. */
const GIVE_UP_MS = 30 * 60_000;

export type LossVerdict = 'leaving' | 'offline' | 'woke' | 'blip' | 'report';

export interface Loss {
  start: number;
  /** The calls that failed, as templates (`GET /api/usage`), in order, at most 12. */
  calls: string[];
  stack?: string;
  /** The device said it was offline at some point. */
  offline: boolean;
  /** The page came into sight, went out of it, came back from the cache or changed network near or during the loss. */
  woke: boolean;
  /** The page started leaving. */
  left: boolean;
}

/** Why a loss that ended at `backAt` is not one to report, or 'report'. */
function lossVerdict(l: Loss, backAt: number): LossVerdict {
  if (l.left) return 'leaving';
  if (l.offline) return 'offline';
  if (l.woke) return 'woke';
  if (backAt - l.start < BLIP_MS) return 'blip';
  return 'report';
}

/** A loss's message: its length in a few steps, so one bug is one fingerprint whatever the calls and seconds. */
export function lossMessage(ms: number): string {
  const step = ms >= 300_000 ? '5 min' : ms >= 60_000 ? '1 min' : '10 s';
  return `the hub was not reached for ${step} or more`;
}

export interface LossEnv {
  now(): number;
  online(): boolean;
  leaving(): boolean;
  /** True once the hub answered anything at all. */
  probe(): Promise<boolean>;
  later(f: () => void, ms: number): unknown;
  /** A loss judged 'report': how long it lasted and how long ago it began, the calls, the first failure's stack. */
  send(r: { ms: number; ago: number; calls: string[]; stack?: string }): void;
  /** Every verdict, for the console. */
  judged?(v: LossVerdict, l: Loss, ms: number): void;
}

export class HubLoss {
  current: Loss | null = null;
  private wokeAt = -Infinity;
  constructor(private readonly env: LossEnv) {}

  /** The page came into sight or went out of it, came back from the cache, resumed, or the device changed network. */
  woke(): void {
    this.wokeAt = this.env.now();
    if (this.current) this.current.woke = true;
  }

  offline(): void {
    if (this.current) this.current.offline = true;
  }

  leaving(): void {
    if (this.current) this.current.left = true;
  }

  /** A call that did not reach the hub. */
  fail(call: string, stack?: string): void {
    const now = this.env.now();
    const l = this.current;
    if (l) {
      if (l.calls.length < 12 && !l.calls.includes(call)) l.calls.push(call);
      if (!this.env.online()) l.offline = true;
      return;
    }
    this.current = { start: now, calls: [call], stack, offline: !this.env.online(), woke: now - this.wokeAt < WAKE_MS, left: this.env.leaving() };
    this.ask(PROBE_FIRST_MS);
  }

  private ask(ms: number): void {
    this.env.later(() => void this.check(ms), ms);
  }

  private async check(ms: number): Promise<void> {
    const l = this.current;
    if (!l) return;
    if (this.env.leaving()) l.left = true;
    if (!this.env.online()) l.offline = true;
    // Leaving or offline already settles it: no need to ask the hub.
    if (l.left || l.offline) return this.end(l, this.env.now());
    let back = false;
    try {
      back = await this.env.probe();
    } catch {}
    if (back) return this.end(l, this.env.now());
    if (this.env.now() - l.start > GIVE_UP_MS) {
      this.current = null;
      return;
    }
    this.ask(Math.min(ms * 2, PROBE_MAX_MS));
  }

  private end(l: Loss, backAt: number): void {
    this.current = null;
    // Leaving while the hub answered: the page is going, and so is anything it would send.
    if (this.env.leaving()) l.left = true;
    const v = lossVerdict(l, backAt);
    const ms = backAt - l.start;
    this.env.judged?.(v, l, ms);
    if (v === 'report') this.env.send({ ms, ago: this.env.now() - l.start, calls: l.calls, stack: l.stack });
  }
}

let leaving = false;
function noteLeaving(now: boolean): void {
  leaving = now;
  if (now) loss.leaving();
}

const loss = new HubLoss({
  now: () => Date.now(),
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  leaving: () => leaving,
  probe: () =>
    fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(10_000) }).then(
      () => true,
      () => false,
    ),
  later: (f, ms) => setTimeout(f, ms),
  send: ({ ms, ago, calls, stack }) =>
    reportPageError({ name: 'FetchError', message: lossMessage(ms), stack, extra: { lostMs: Math.round(ms), lostAgo: Math.round(ago), calls: calls.join(', ') } }),
  judged: (v, l, ms) => {
    if (v !== 'leaving') console.info(`[dither] the hub was not reached for ${Math.round(ms / 100) / 10} s (${l.calls.length} calls): ${v === 'report' ? 'reported' : `not reported, ${v}`}`);
  },
});

/**
 * api()'s failures: a fetch that did not reach the hub joins the current loss (above). An answer with a status is not
 * sent: the hub wrote its own line for each 5xx (server.ts reportAnswer), and a 4xx is a refusal.
 */
export function reportApiFailure(method: string, path: string, e: unknown, status?: number): void {
  if (isAbort(e)) return;
  if (status !== undefined) return;
  // The rejection is the loss's to report: not again as an unhandled one.
  if (e && typeof e === 'object') sent.add(e);
  loss.fail(`${method} ${apiTemplate(path)}`, (e as Error)?.stack);
}

/** What the Android app kept about something that took it down (apps/android Crashes.kt), to send for it. */
interface AppCrash {
  where: string;
  name: string;
  message: string;
  stack?: string[];
  /** ms epoch it happened; it is sent on the next start. */
  at?: number;
  sdk?: number;
}

/** The Android app's crash reports, as app `android`, outside the page's limits (the app keeps at most 20). Never throws. */
export function reportAppCrashes(list: AppCrash[], version?: string): void {
  for (const c of list.slice(0, 20)) {
    try {
      if (typeof c?.where !== 'string' || typeof c.message !== 'string') continue;
      const extra = { ...(typeof c.at === 'number' ? { at: c.at } : {}), ...(typeof c.sdk === 'number' ? { sdk: c.sdk } : {}) };
      const body = { app: 'android', name: String(c.name || 'Error'), message: c.message.slice(0, 600), stack: Array.isArray(c.stack) ? c.stack.slice(0, 20) : [], where: c.where, extra, ...(version ? { version } : {}) };
      void fetch('/api/errors', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
    } catch {}
  }
}

let installed = false;

/** window.onerror and unhandledrejection, once. */
export function installErrorReports(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // beforeunload comes as a reload starts, pagehide as the page goes; pageshow is a page back from the back-forward cache.
  window.addEventListener('beforeunload', () => noteLeaving(true));
  window.addEventListener('pagehide', () => noteLeaving(true));
  window.addEventListener('pageshow', () => (noteLeaving(false), loss.woke()));
  // What makes a fetch fail without the hub being at fault: the device offline, the page asleep or waking, a new network.
  window.addEventListener('offline', () => loss.offline());
  document.addEventListener('visibilitychange', () => loss.woke());
  document.addEventListener('resume', () => loss.woke());
  (navigator as { connection?: EventTarget }).connection?.addEventListener?.('change', () => loss.woke());
  window.addEventListener('error', (ev) => {
    // A cross-origin script's "Script error." carries nothing, and a ResizeObserver loop is the browser's notice.
    if (!ev.error && (!ev.message || /^Script error\.?$|ResizeObserver loop/.test(ev.message))) return;
    const r = pageError(ev.error ?? new Error(ev.message));
    if (r) reportPageError(r, ev.error);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = pageError(ev.reason);
    if (r) reportPageError(r, ev.reason);
  });
}
