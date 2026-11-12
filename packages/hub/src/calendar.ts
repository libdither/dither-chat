/**
 * dither-calendar beside the hub (docs/calendar.md): the calendar's web app and API under /calendar/, the plans it
 * found in chats kept here for the chips under messages, and its reminders delivered as notifications.
 *
 * The calendar is another server on this machine (DITHER_CALENDAR_URL, http://127.0.0.1:8470 by default; off on a demo
 * hub). The hub forwards /calendar/<rest> to it, holds its event stream over loopback, and asks it for the plans that
 * changed whenever the stream says proposals or events did. The calendar never calls the hub about plans; it calls
 * only POST /api/calendar/notify, from loopback with no Origin.
 */
import type * as P from '@dither-chat/protocol';

/** Request headers never forwarded: hop-by-hop, the Host (the forwarded one says it), and the encoding (asked as identity). */
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'host', 'accept-encoding']);
/** Response headers never passed back: hop-by-hop. */
const HOP_BACK = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
const hopByHop = (name: string, set: Set<string>) => set.has(name) || name.startsWith('proxy-');

/** Plans kept: past this many, the oldest by updatedAt go. */
export const MAX_PLANS = 2000;
/** The calendar writes a keepalive every 25 s: this long without a byte, the stream is dead. */
export const WATCHDOG_MS = 70_000;
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 60_000;
/** A delta asks from a little before the last answer's `now`, for writes that raced it. */
const OVERLAP_MS = 5000;

/** The page shown under /calendar/ (not its API) when there is no calendar, or it does not answer. Never the chat app. */
function page(title: string, text: string, retry: boolean, status: number): Response {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px system-ui;max-width:32em;margin:3em auto;padding:0 1em;line-height:1.5;color:#ccc;background:#1e1f22}a{color:#8cb8f0}</style>
<h1>${title}</h1><p>${text}</p>${retry ? '<p><a href="">Retry</a></p>' : ''}`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/** /calendar/* on a hub without a calendar: 404, JSON for the API, else a small page. */
export function calendarOff(path: string): Response {
  if (path.startsWith('/calendar/api/')) return Response.json({ error: 'calendar is off on this hub' }, { status: 404 });
  return page('Calendar is not set up on this hub', 'This hub has no calendar beside it (DITHER_CALENDAR_URL, docs/calendar.md).', false, 404);
}

/** The calendar's address from the environment: the default on a real hub, never on a demo hub; `off` or empty is none. */
export function calendarUrl(env: Record<string, string | undefined>, demo: boolean): string | null {
  const v = (env.DITHER_CALENDAR_URL ?? (demo ? '' : 'http://127.0.0.1:8470')).trim();
  if (demo || !v || v === 'off') return null;
  return v.replace(/\/+$/, '');
}

export interface CalendarLinkOpts {
  url: string;
  broadcast: (evs: P.ClientEvent[]) => void;
  fetch?: typeof fetch;
  /** How long after a change on the stream the plans are asked for (1 s; tests use 0). */
  debounceMs?: number;
  log?: (msg: string) => void;
}

export class CalendarLink {
  private readonly url: string;
  private readonly f: typeof fetch;
  private cache = new Map<string, P.CalendarPlanView>();
  private reachable = false;
  private waiting = 0;
  /** The last answer's `now`: the next delta asks from a little before it. Null until a full read. */
  private lastNow: number | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private backoff = BACKOFF_MIN;
  private retryTimer?: Timer;
  private watchdog?: Timer;
  private debounce?: Timer;
  /** One read of the plans at a time; a change meanwhile asks again after it. */
  private reading: Promise<void> | null = null;
  private again: 'full' | 'delta' | null = null;

  constructor(private opts: CalendarLinkOpts) {
    this.url = opts.url.replace(/\/+$/, '');
    this.f = opts.fetch ?? fetch;
  }

  view(): P.CalendarLinkView {
    return { path: '/calendar/', reachable: this.reachable, waiting: this.waiting };
  }

  /** The cache, newest first. */
  plans(): P.CalendarPlanView[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  plansView(): P.PlansView {
    return { plans: this.plans(), reachable: this.reachable, waiting: this.waiting };
  }

  // ---------------------------------------------------------------- the proxy

  /**
   * /calendar/<rest> to the calendar's /<rest>. The caller has checked the tailnet, the Host and (for writes) the
   * Origin. The body streams both ways; an event stream is marked so nothing on the way buffers it.
   */
  async proxy(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === '/calendar') return new Response(null, { status: 308, headers: { location: `/calendar/${url.search}` } });
    const rest = path.slice('/calendar'.length) || '/';
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!hopByHop(k, HOP)) headers.set(k, v);
    });
    // Behind Caddy the hub sees http; Caddy says what the browser used.
    const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(/:$/, '');
    headers.set('x-forwarded-host', req.headers.get('host') ?? url.host);
    headers.set('x-forwarded-proto', proto === 'https' ? 'https' : 'http');
    headers.set('x-forwarded-prefix', '/calendar');
    headers.set('accept-encoding', 'identity');
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let up: Response;
    try {
      up = await this.f(`${this.url}${rest}${url.search}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: req.body, duplex: 'half' } : {}),
        redirect: 'manual',
        signal: req.signal,
        decompress: false,
      } as RequestInit);
    } catch (e) {
      if (path.startsWith('/calendar/api/')) return Response.json({ error: 'the calendar is not answering' }, { status: 502 });
      return page('The calendar is not answering', `The hub could not reach dither-calendar (${String((e as Error)?.message ?? e).slice(0, 120)}).`, true, 502);
    }
    const out = new Headers();
    up.headers.forEach((v, k) => {
      if (!hopByHop(k, HOP_BACK)) out.append(k, v);
    });
    const loc = up.headers.get('location');
    if (loc && loc.startsWith('/') && !loc.startsWith('//')) out.set('location', `/calendar${loc}`);
    if ((up.headers.get('content-type') ?? '').startsWith('text/event-stream')) out.set('cache-control', 'no-store, no-transform');
    return new Response(up.body, { status: up.status, statusText: up.statusText, headers: out });
  }

  // ---------------------------------------------------------------- plans, from the event stream

  start() {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop() {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    clearTimeout(this.debounce);
  }

  private log(msg: string) {
    (this.opts.log ?? ((m: string) => console.warn(m)))(`calendar: ${msg}`);
  }

  private setReachable(r: boolean, waiting = this.waiting) {
    if (r === this.reachable && waiting === this.waiting) return;
    this.reachable = r;
    this.waiting = waiting;
    this.opts.broadcast([{ t: 'calendar', reachable: r, waiting }]);
  }

  private async connect() {
    if (!this.running) return;
    const ctl = new AbortController();
    this.abort = ctl;
    this.feed();
    try {
      const res = await this.f(`${this.url}/api/stream`, { headers: { accept: 'text/event-stream' }, signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(`stream answered ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.feed();
        buf += value;
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data) this.onEvent(data);
        }
      }
      throw new Error('stream ended');
    } catch (e) {
      if (!this.running || ctl.signal.aborted && this.abort !== ctl) return;
      if (this.reachable) this.log(`lost the event stream (${String((e as Error)?.message ?? e)})`);
      this.setReachable(false);
      clearTimeout(this.watchdog);
      this.retryTimer = setTimeout(() => void this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    }
  }

  /** A byte arrived: the watchdog starts over. */
  private feed() {
    clearTimeout(this.watchdog);
    const ctl = this.abort;
    this.watchdog = setTimeout(() => {
      if (ctl && this.abort === ctl) ctl.abort(new Error('no keepalive'));
    }, WATCHDOG_MS);
  }

  private onEvent(data: string) {
    let e: { t?: string; what?: string[] };
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    if (e.t === 'hello') {
      this.backoff = BACKOFF_MIN;
      clearTimeout(this.debounce);
      void this.read('full');
    } else if (e.t === 'changed' && Array.isArray(e.what) && (e.what.includes('proposals') || e.what.includes('events'))) {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.read('delta'), this.opts.debounceMs ?? 1000);
    }
  }

  /** Reads the plans: all of them (`full`, replacing the cache) or those changed since the last answer. */
  read(kind: 'full' | 'delta'): Promise<void> {
    if (this.reading) {
      this.again = this.again === 'full' || kind === 'full' ? 'full' : 'delta';
      return this.reading;
    }
    const full = kind === 'full' || this.lastNow === null;
    this.reading = this.fetchPlans(full).finally(() => {
      this.reading = null;
      const next = this.again;
      this.again = null;
      if (next && this.running) void this.read(next);
    });
    return this.reading;
  }

  private async fetchPlans(full: boolean) {
    const since = full ? 0 : Math.max(0, this.lastNow! - OVERLAP_MS);
    let r: P.CalendarPlans;
    try {
      const res = await this.f(`${this.url}/api/chat/plans?since=${since}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`plans answered ${res.status}`);
      r = (await res.json()) as P.CalendarPlans;
      if (!Array.isArray(r?.plans)) throw new Error('plans: not a list');
    } catch (e) {
      this.log(String((e as Error)?.message ?? e));
      // The stream may still be up; the plans are not. The next change or hello asks again.
      this.setReachable(false);
      return;
    }
    this.lastNow = typeof r.now === 'number' ? r.now : Date.now();
    const valid = r.plans.filter((p) => p && typeof p.id === 'string' && typeof p.messageId === 'string');
    if (full) this.cache.clear();
    for (const p of valid) this.cache.set(p.id, p);
    this.trim();
    if (full) this.opts.broadcast([{ t: 'plans', plans: this.plans(), replace: true }]);
    else if (valid.length) this.opts.broadcast([{ t: 'plans', plans: valid.filter((p) => this.cache.has(p.id)) }]);
    this.setReachable(true, typeof r.waiting === 'number' ? r.waiting : this.waiting);
  }

  private trim() {
    if (this.cache.size <= MAX_PLANS) return;
    const old = [...this.cache.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const p of old.slice(0, this.cache.size - MAX_PLANS)) this.cache.delete(p.id);
  }
}

// ------------------------------------------------------------------ reminders

/**
 * Who may call POST /api/calendar/notify: a process on this machine that is not a browser. Caddy reaches the hub over
 * the tailnet address, so a request from another device is never loopback here.
 */
export function notifyAllowed(ip: string, req: Request): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  return (ip === '::1' || v4.startsWith('127.')) && !req.headers.get('origin');
}

const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
const numOrNull = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x));
const strOrNull = (x: unknown, max: number) => x === null || str(x, max);

/** A ReminderNotice the hub will deliver, or why not. */
export function checkNotice(x: any): string | null {
  if (!x || typeof x !== 'object') return 'not an object';
  if (!str(x.id, 400) || !x.id) return 'id';
  if (!str(x.eventKey, 300) || !x.eventKey) return 'eventKey';
  if (!str(x.title, 200)) return 'title';
  if (typeof x.allDay !== 'boolean') return 'allDay';
  if (!numOrNull(x.startAt) || !numOrNull(x.endAt)) return 'startAt/endAt';
  if (!strOrNull(x.startDate, 10)) return 'startDate';
  if (!str(x.timeZone, 64)) return 'timeZone';
  if (!strOrNull(x.location, 200)) return 'location';
  if (!str(x.when, 200)) return 'when';
  if (typeof x.minutesBefore !== 'number' || !Number.isFinite(x.minutesBefore)) return 'minutesBefore';
  if (typeof x.late !== 'boolean') return 'late';
  if (!str(x.open, 300) || !x.open.startsWith('#')) return 'open';
  if (!strOrNull(x.meetingUrl, 2000) || (x.meetingUrl && !/^https?:\/\//i.test(x.meetingUrl))) return 'meetingUrl';
  return null;
}

/** Rule keys for a reminder (devices.ts otherChain): the calendar is a network of its own, `network:calendar`. */
export const REMINDER_RULE_ID = 'calendar:reminders';
export function calendarChain(id: string): string[] | null {
  return id.startsWith('calendar:') ? ['network:calendar'] : null;
}

/** Ids already delivered: a repeat (the calendar's retry after a lost answer) is answered without notifying again. */
export const SEEN_MAX = 2000;
export const SEEN_MS = 48 * 3_600_000;

export interface ReminderDeps {
  now?: () => number;
  inQuietHours: (now: number) => boolean;
  /** Devices whose rules keep calendar reminders off them (devices.quietOn('calendar:reminders')). */
  quietDevices: () => string[];
  /** Push registrations that are not phones. */
  desktops: () => string[];
  /** The activity log's id for it, or null. */
  notification: () => string | null;
  sent: (nid: string, r: { devices: number; accepted: number }) => void;
  /** To open pages (server.notify). */
  notify: (ev: Extract<P.ClientEvent, { t: 'notify' }>) => void;
  push: (title: string, body: string, extra: Record<string, unknown>, skip: string[], level: 'push' | 'quiet') => Promise<{ devices: number; accepted: number }>;
}

/** The hub's side of a reminder (docs/calendar.md "Reminders"): an alert on every device, or held quiet in quiet hours. */
export class ReminderDelivery {
  private seen = new Map<string, { at: number; result: Extract<P.ReminderResult, { ok: true }> | null }>();

  constructor(private deps: ReminderDeps) {}

  async deliver(n: P.ReminderNotice): Promise<P.ReminderResult> {
    const now = (this.deps.now ?? Date.now)();
    for (const [id, s] of this.seen) {
      if (s.at > now - SEEN_MS && this.seen.size <= SEEN_MAX) break;
      this.seen.delete(id);
    }
    const prior = this.seen.get(n.id);
    if (prior && prior.at > now - SEEN_MS) {
      return prior.result ? { ...prior.result, duplicate: true } : { ok: true, duplicate: true, tier: 'push', devices: 0, accepted: 0 };
    }
    // Taken before the first await, so two posts of the same id at once notify once.
    this.seen.set(n.id, { at: now, result: null });
    const tier: 'push' | 'quiet' = this.deps.inQuietHours(now) ? 'quiet' : 'push';
    const quiet = this.deps.quietDevices();
    const skip = tier === 'push' ? quiet : [...new Set([...quiet, ...this.deps.desktops()])];
    const nid = this.deps.notification();
    const calendar: P.CalendarNotifyRef = { open: n.open, eventKey: n.eventKey, reminderId: n.id, meetingUrl: n.meetingUrl };
    const title = n.title || '(No title)';
    const body = [n.when, n.location].filter(Boolean).join(' · ');
    const reasons = [tier === 'quiet' ? 'Held by quiet hours' : n.late ? 'Calendar reminder, sent late' : 'Calendar reminder'];
    this.deps.notify({ t: 'notify', title, body, reasons, calendar, ...(tier === 'quiet' ? { level: 'quiet' as const } : {}), ...(nid ? { nid } : {}), ...(quiet.length ? { quiet } : {}) });
    try {
      const r = await this.deps.push(title, body, { calendar, tier, level: tier, ...(nid ? { nid } : {}) }, skip, tier);
      if (nid) this.deps.sent(nid, r);
      const result = { ok: true as const, tier, devices: r.devices, accepted: r.accepted };
      this.seen.delete(n.id);
      this.seen.set(n.id, { at: now, result });
      return result;
    } catch (e) {
      // Not delivered: the calendar retries the same id, and that one is not a repeat.
      this.seen.delete(n.id);
      return { ok: false, error: String((e as Error)?.message ?? e) };
    }
  }
}
