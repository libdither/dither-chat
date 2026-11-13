/**
 * The page's errors, to the hub's traces/errors.ndjson (POST /api/errors; docs/tracing.md "Errors"): a throw nothing
 * caught, a rejection nothing handled, and an API call answered with 5xx (but 503 and 504) or that could not reach the
 * hub. Not 4xx, not an abort, not while offline. `where` is the page's route as a template (`#/inbox/c/:id`), never an id or anything
 * typed; `message` is an Error's message (the hub clips it). At most 20 reports a minute, the same one at most once a
 * minute. Reporting never throws.
 */

declare const __BUILD_SHA__: string;
const VERSION = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : undefined;

/** The words of the app's addresses (routes.ts); every other segment is an id, a name or something typed. */
const WORDS = new Set(['inbox', 'c', 'people', 'graph', 'p', 'i', 'about', 's', 'groups', 'spaces', 'f', 'accounts', 'settings', 'triage', 'model', 'directory', 'search', 'requests', 'notices', 'mail', 'l', 't', 'calendar']);

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

export interface PageError {
  name: string;
  message: string;
  stack?: string;
  status?: number;
}

const limiter = new ReportLimiter();
/** Errors already sent, so a rejection of one api() reported is not sent twice. */
const sent = new WeakSet<object>();

/** Send one report, if the limits allow. Never throws. */
export function reportPageError(e: PageError, error?: unknown): void {
  try {
    if (error && typeof error === 'object') {
      if (sent.has(error)) return;
      sent.add(error);
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const where = routeTemplate(location.hash);
    if (!limiter.allow(`${e.name}\u0000${e.message}\u0000${where}`, Date.now())) return;
    const body = { name: e.name, message: String(e.message).slice(0, 600), stack: (e.stack ?? '').slice(0, 4000), where, ...(e.status ? { status: e.status } : {}), ...(VERSION ? { version: VERSION } : {}) };
    void fetch('/api/errors', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
  } catch {}
}

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

/** An error object's report, or null for what is not one to send (an abort, an api() 4xx). */
export function pageError(e: unknown): PageError | null {
  if (e === null || e === undefined || isAbort(e)) return null;
  const status = (e as { status?: unknown }).status;
  if (typeof status === 'number' && (status < 500 || status === 503 || status === 504)) return null;
  if (typeof e === 'object' && typeof (e as Error).message === 'string')
    return { name: String((e as Error).name || 'Error'), message: (e as Error).message, stack: typeof (e as Error).stack === 'string' ? (e as Error).stack : undefined };
  return { name: typeof e, message: `a ${typeof e} was thrown, not an Error` };
}

/**
 * api()'s failures: an answer of 5xx, or a fetch that did not reach the hub. 503 (an account offline, the manager not
 * reachable) and 504 (a timeout) are states the page shows, as the hub leaves them out of its own reports.
 */
export function reportApiFailure(method: string, path: string, e: unknown, status?: number): void {
  if (isAbort(e)) return;
  if (status !== undefined && (status < 500 || status === 503 || status === 504)) return;
  const what = `${method} ${apiTemplate(path)}`;
  const msg = status !== undefined ? `${what} answered ${status}` : `${what} failed: ${(e as Error)?.message ?? 'no answer'}`;
  reportPageError({ name: status !== undefined ? 'ApiError' : 'FetchError', message: msg, stack: (e as Error)?.stack, status }, e);
}

let installed = false;

/** window.onerror and unhandledrejection, once. */
export function installErrorReports(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
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
