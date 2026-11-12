/**
 * dither-calendar beside the hub (calendar.ts, docs/calendar.md): /calendar/* forwarded to a fake calendar, the plans
 * kept from its event stream, and reminders delivered. The fake listens on port 0 and holds its event stream open;
 * every wait is on an event (a stream chunk, a broadcast), never a timer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { CalendarLink, calendarChain, calendarUrl, checkNotice, notifyAllowed, ReminderDelivery, REMINDER_RULE_ID } from '../src/calendar.ts';
import { Devices } from '../src/devices.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-calendar-'));
// The chat app's shell: /calendar/ must never answer with it.
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>CHAT SHELL</title>');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------------ a fake calendar

type Seen = { method: string; path: string; search: string; headers: Record<string, string>; body: string };

function fakeCalendar() {
  const seen: Seen[] = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const opened: ((n: number) => void)[] = [];
  const state = { now: 1_000_000, waiting: 0, plans: [] as P.CalendarPlanView[], sinces: [] as number[] };
  const enc = new TextEncoder();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      seen.push({ method: req.method, path: url.pathname, search: url.search, headers, body: req.method === 'GET' ? '' : await req.text() });
      if (url.pathname === '/api/stream') {
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            ctl = c;
            streams.add(c);
            c.enqueue(enc.encode(`retry: 2000\ndata: ${JSON.stringify({ t: 'hello', now: state.now })}\n\n`));
            for (const f of opened.splice(0)) f(streams.size);
          },
          cancel: () => void streams.delete(ctl),
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/api/chat/plans') {
        const since = Number(url.searchParams.get('since'));
        state.sinces.push(since);
        return Response.json({ now: state.now, waiting: state.waiting, plans: state.plans.filter((p) => p.updatedAt >= since) } satisfies P.CalendarPlans);
      }
      if (url.pathname === '/moved') return new Response(null, { status: 302, headers: { location: '/day/2026-11-14' } });
      if (url.pathname === '/elsewhere') return new Response(null, { status: 302, headers: { location: 'https://example.org/x' } });
      if (url.pathname.startsWith('/api/')) return Response.json({ ok: true, path: url.pathname });
      return new Response('<!doctype html><title>Calendar</title>' + 'x'.repeat(4000), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    seen,
    state,
    send: (ev: unknown) => {
      for (const c of streams) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
    },
    /** Resolves once a stream is open (now, if one is). */
    streamOpen: () => (streams.size ? Promise.resolve(streams.size) : new Promise<number>((r) => opened.push(r))),
  };
}

const plan = (id: string, updatedAt: number, over: Partial<P.CalendarPlanView> = {}): P.CalendarPlanView => ({
  id,
  conversationId: 'cnv_1',
  messageId: `msg_${id}`,
  lastMessageId: `msg_${id}_last`,
  title: 'Dinner',
  location: null,
  allDay: false,
  startAt: 1_800_000_000_000,
  endAt: 1_800_000_003_600,
  startDate: null,
  endDate: null,
  timeZone: 'Europe/Berlin',
  state: 'suggested',
  change: null,
  verdict: 'suggest',
  event: null,
  open: '#/chats',
  updatedAt,
  ...over,
});

/** Broadcasts as they come, and a promise for the next one that matches. */
function events() {
  const all: P.ClientEvent[] = [];
  const waiters: { pred: (e: P.ClientEvent) => boolean; resolve: (e: P.ClientEvent) => void }[] = [];
  return {
    all,
    broadcast: (evs: P.ClientEvent[]) => {
      for (const e of evs) {
        all.push(e);
        for (const w of waiters.splice(0)) (w.pred(e) ? w.resolve(e) : waiters.push(w));
      }
    },
    next: <T extends P.ClientEvent>(pred: (e: P.ClientEvent) => boolean) => new Promise<T>((resolve) => waiters.push({ pred, resolve: resolve as (e: P.ClientEvent) => void })),
  };
}

const sup = { authorize: () => null, online: () => true, command: async () => ({}), note() {}, liveViewUrl: () => null } as any;
function hub(opts: { calendar?: CalendarLink; onReminder?: (n: P.ReminderNotice) => Promise<P.ReminderResult> } = {}) {
  const store = new Store(':memory:', mediaSigner('s'));
  const h = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's', ...opts });
  const port = h.start().port!;
  return { h, store, base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
}

// ------------------------------------------------------------------ the proxy

describe('the proxy', () => {
  const cal = fakeCalendar();
  const link = new CalendarLink({ url: cal.url, broadcast: () => {} });
  let H: ReturnType<typeof hub>;
  beforeAll(() => void (H = hub({ calendar: link })));
  afterAll(() => {
    H.h.stop();
    cal.server.stop(true);
  });

  test('/calendar redirects to /calendar/, keeping the query', async () => {
    const r = await fetch(`${H.base}/calendar?x=1`, { redirect: 'manual' });
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe('/calendar/?x=1');
  });

  test('path, query and the forwarded headers arrive', async () => {
    const r = await fetch(`${H.base}/calendar/api/events?from=1&to=2&q=a%20b`, { headers: { 'x-test': 'yes', 'accept-encoding': 'gzip' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, path: '/api/events' });
    const s = cal.seen.at(-1)!;
    expect(s.path).toBe('/api/events');
    expect(s.search).toBe('?from=1&to=2&q=a%20b');
    expect(s.headers['x-test']).toBe('yes');
    expect(s.headers['x-forwarded-host']).toBe(H.host);
    expect(s.headers['x-forwarded-proto']).toBe('http');
    expect(s.headers['x-forwarded-prefix']).toBe('/calendar');
    expect(s.headers['accept-encoding']).toBe('identity');
    // The calendar's own address, not the hub's.
    expect(s.headers.host).toBe(new URL(cal.url).host);
  });

  test('the web app under /calendar/ is the calendar, compressed on the way like the hub’s own', async () => {
    const r = await fetch(`${H.base}/calendar/`, { headers: { 'accept-encoding': 'gzip' }, decompress: false } as RequestInit);
    expect(cal.seen.at(-1)!.path).toBe('/');
    expect(r.headers.get('content-encoding')).toBe('gzip');
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await r.arrayBuffer())))).toContain('<title>Calendar</title>');
  });

  test('a Location on the calendar gets the prefix; one elsewhere is left alone', async () => {
    const r = await fetch(`${H.base}/calendar/moved`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/calendar/day/2026-11-14');
    expect((await fetch(`${H.base}/calendar/elsewhere`, { redirect: 'manual' })).headers.get('location')).toBe('https://example.org/x');
  });

  test('a write from another site is refused; from the hub’s own page it goes through with its body', async () => {
    const before = cal.seen.length;
    const foreign = await fetch(`${H.base}/calendar/api/proposals/p1/accept`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(foreign.status).toBe(403);
    expect(cal.seen.length).toBe(before);
    const own = await fetch(`${H.base}/calendar/api/proposals/p1/accept`, { method: 'POST', headers: { origin: H.base, 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(own.status).toBe(200);
    const s = cal.seen.at(-1)!;
    expect([s.method, s.path, s.body]).toEqual(['POST', '/api/proposals/p1/accept', '{"a":1}']);
    expect(s.headers.origin).toBe(H.base);
  });

  test('the event stream comes through at once and stays open, unbuffered', async () => {
    const ctl = new AbortController();
    const r = await fetch(`${H.base}/calendar/api/stream`, { headers: { 'accept-encoding': 'gzip, zstd' }, signal: ctl.signal });
    expect(r.headers.get('content-type')).toStartWith('text/event-stream');
    expect(r.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(r.headers.get('content-encoding')).toBeNull();
    const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
    let got = '';
    while (!got.includes('"hello"')) got += (await reader.read()).value ?? '';
    // Still open: something the calendar writes later arrives too.
    cal.send({ t: 'changed', what: ['events'] });
    while (!got.includes('"changed"')) got += (await reader.read()).value ?? '';
    ctl.abort();
  });
});

describe('without a calendar', () => {
  test('a demo hub has none; a real hub has the default unless told off', () => {
    expect(calendarUrl({ DITHER_CALENDAR_URL: 'http://127.0.0.1:9' }, true)).toBeNull();
    expect(calendarUrl({}, true)).toBeNull();
    expect(calendarUrl({}, false)).toBe('http://127.0.0.1:8470');
    expect(calendarUrl({ DITHER_CALENDAR_URL: 'off' }, false)).toBeNull();
    expect(calendarUrl({ DITHER_CALENDAR_URL: '' }, false)).toBeNull();
    expect(calendarUrl({ DITHER_CALENDAR_URL: 'http://127.0.0.1:9/' }, false)).toBe('http://127.0.0.1:9');
  });

  test('off: 404, JSON for the API and a page for the rest, never the chat app; nothing in the bootstrap', async () => {
    const H = hub();
    try {
      const api = await fetch(`${H.base}/calendar/api/state`);
      expect(api.status).toBe(404);
      expect(await api.json()).toEqual({ error: 'calendar is off on this hub' });
      for (const p of ['/calendar/', '/calendar/assets/x.js', '/calendar/week']) {
        const r = await fetch(H.base + p);
        expect(r.status).toBe(404);
        const text = await r.text();
        expect(text).toContain('Calendar is not set up on this hub');
        expect(text).not.toContain('CHAT SHELL');
      }
      expect((await fetch(`${H.base}/api/plans`)).status).toBe(404);
      expect('calendar' in (await (await fetch(`${H.base}/api/bootstrap`)).json())).toBe(false);
    } finally {
      H.h.stop();
    }
  });

  test('not answering: 502, JSON for the API and a page with Retry for the rest', async () => {
    // Port 1: nothing listens there.
    const H = hub({ calendar: new CalendarLink({ url: 'http://127.0.0.1:1', broadcast: () => {} }) });
    try {
      const api = await fetch(`${H.base}/calendar/api/state`);
      expect(api.status).toBe(502);
      expect(await api.json()).toEqual({ error: 'the calendar is not answering' });
      const page = await fetch(`${H.base}/calendar/`);
      expect(page.status).toBe(502);
      const text = await page.text();
      expect(text).toContain('Retry');
      expect(text).not.toContain('CHAT SHELL');
      // The bootstrap says there is a calendar, not reached yet.
      expect((await (await fetch(`${H.base}/api/bootstrap`)).json()).calendar).toEqual({ path: '/calendar/', reachable: false, waiting: 0 });
    } finally {
      H.h.stop();
    }
  });
});

// ------------------------------------------------------------------ plans

describe('plans from the event stream', () => {
  const cal = fakeCalendar();
  const ev = events();
  const link = new CalendarLink({ url: cal.url, broadcast: ev.broadcast, debounceMs: 0, log: () => {} });
  let H: ReturnType<typeof hub>;
  beforeAll(() => void (H = hub({ calendar: link })));
  afterAll(() => {
    link.stop();
    H.h.stop();
    cal.server.stop(true);
  });

  test('on hello it reads them all, and says the calendar is reachable', async () => {
    cal.state.plans = [plan('a', 900_000)];
    cal.state.waiting = 1;
    const full = ev.next<Extract<P.ClientEvent, { t: 'plans' }>>((e) => e.t === 'plans');
    const reach = ev.next<Extract<P.ClientEvent, { t: 'calendar' }>>((e) => e.t === 'calendar');
    link.start();
    expect(await full).toEqual({ t: 'plans', plans: [plan('a', 900_000)], replace: true });
    expect(await reach).toEqual({ t: 'calendar', reachable: true, waiting: 1 });
    expect(cal.state.sinces).toEqual([0]);
    const r = (await (await fetch(`${H.base}/api/plans`)).json()) as P.PlansView;
    expect(r).toEqual({ plans: [plan('a', 900_000)], reachable: true, waiting: 1 });
    expect((await (await fetch(`${H.base}/api/bootstrap`)).json()).calendar).toEqual({ path: '/calendar/', reachable: true, waiting: 1 });
  });

  test('a change to proposals reads what changed since a little before the last answer', async () => {
    cal.state.now = 2_000_000;
    cal.state.plans = [plan('a', 900_000), plan('b', 1_999_000, { state: 'added', open: '#/day/2026-11-14' })];
    const delta = ev.next<Extract<P.ClientEvent, { t: 'plans' }>>((e) => e.t === 'plans');
    cal.send({ t: 'changed', what: ['proposals'] });
    const d = await delta;
    expect(d.replace).toBeUndefined();
    expect(d.plans.map((p) => p.id)).toEqual(['b']);
    // 1_000_000 was the last answer's `now`: 5 s before it.
    expect(cal.state.sinces.at(-1)).toBe(995_000);
    expect(((await (await fetch(`${H.base}/api/plans`)).json()) as P.PlansView).plans.map((p) => p.id)).toEqual(['b', 'a']);
  });

  test('a change to settings alone is not read', async () => {
    const asked = cal.state.sinces.length;
    cal.send({ t: 'changed', what: ['settings'] });
    // Then one that is, so the wait ends on an event: only that one asked.
    const delta = ev.next((e) => e.t === 'plans');
    cal.send({ t: 'changed', what: ['events'] });
    await delta;
    expect(cal.state.sinces.length).toBe(asked + 1);
  });

  test('hello replaces the cache', async () => {
    cal.state.plans = [plan('c', 2_100_000)];
    cal.state.waiting = 0;
    const full = ev.next<Extract<P.ClientEvent, { t: 'plans' }>>((e) => e.t === 'plans');
    cal.send({ t: 'hello', now: cal.state.now });
    expect((await full).replace).toBe(true);
    expect(link.plans().map((p) => p.id)).toEqual(['c']);
    expect(cal.state.sinces.at(-1)).toBe(0);
    expect(((await (await fetch(`${H.base}/api/plans`)).json()) as P.PlansView).waiting).toBe(0);
  });
});

// ------------------------------------------------------------------ reminders

const notice = (over: Partial<P.ReminderNotice> = {}): P.ReminderNotice => ({
  id: 'evt_1|1800000000000|10',
  eventKey: 'evt_1',
  title: 'Standup',
  allDay: false,
  startAt: 1_800_000_000_000,
  endAt: 1_800_000_900_000,
  startDate: null,
  timeZone: 'Europe/Berlin',
  location: 'Room 2',
  when: 'in 10 min · 10:00–10:15',
  minutesBefore: 10,
  late: false,
  open: '#/day/2026-01-15',
  meetingUrl: 'https://meet.example/abc',
  ...over,
});

describe('reminders', () => {
  test('only a process on this machine that is not a browser may deliver one', () => {
    const req = (origin?: string) => new Request('http://127.0.0.1/api/calendar/notify', { method: 'POST', headers: origin ? { origin } : {} });
    expect(notifyAllowed('127.0.0.1', req())).toBe(true);
    expect(notifyAllowed('::1', req())).toBe(true);
    expect(notifyAllowed('::ffff:127.0.0.1', req())).toBe(true);
    expect(notifyAllowed('100.64.0.9', req())).toBe(false);
    expect(notifyAllowed('::ffff:100.64.0.9', req())).toBe(false);
    expect(notifyAllowed('fd7a:115c:a1e0::9', req())).toBe(false);
    expect(notifyAllowed('127.0.0.1', req('http://127.0.0.1:8470'))).toBe(false);
    expect(notifyAllowed('127.0.0.1', req('null'))).toBe(false);
  });

  test('a bad notice is named', () => {
    expect(checkNotice(notice())).toBeNull();
    expect(checkNotice({ ...notice(), id: '' })).toBe('id');
    expect(checkNotice({ ...notice(), title: 'x'.repeat(201) })).toBe('title');
    expect(checkNotice({ ...notice(), open: 'day/2026' })).toBe('open');
    expect(checkNotice({ ...notice(), meetingUrl: 'javascript:alert(1)' })).toBe('meetingUrl');
    expect(checkNotice(null)).toBe('not an object');
  });

  function deliveryWith(o: { quietHours?: boolean; quiet?: string[] } = {}) {
    const notified: Extract<P.ClientEvent, { t: 'notify' }>[] = [];
    const pushed: { title: string; body: string; extra: Record<string, unknown>; skip: string[]; level: string }[] = [];
    const sent: [string, unknown][] = [];
    const d = new ReminderDelivery({
      now: () => 5_000_000,
      inQuietHours: () => !!o.quietHours,
      quietDevices: () => o.quiet ?? [],
      desktops: () => ['laptop'],
      notification: () => 'nid_1',
      sent: (nid, r) => void sent.push([nid, r]),
      notify: (ev) => void notified.push(ev),
      push: async (title, body, extra, skip, level) => (pushed.push({ title, body, extra, skip, level }), { devices: 2 - skip.length, accepted: 2 - skip.length }),
    });
    return { d, notified, pushed, sent };
  }

  test('an alert, on every device, with where it opens', async () => {
    const { d, notified, pushed, sent } = deliveryWith();
    expect(await d.deliver(notice())).toEqual({ ok: true, tier: 'push', devices: 2, accepted: 2 });
    const calendar = { open: '#/day/2026-01-15', eventKey: 'evt_1', reminderId: 'evt_1|1800000000000|10', meetingUrl: 'https://meet.example/abc' };
    expect(notified).toEqual([{ t: 'notify', title: 'Standup', body: 'in 10 min · 10:00–10:15 · Room 2', reasons: ['Calendar reminder'], calendar, nid: 'nid_1' }]);
    expect(pushed).toEqual([{ title: 'Standup', body: 'in 10 min · 10:00–10:15 · Room 2', extra: { calendar, tier: 'push', level: 'push', nid: 'nid_1' }, skip: [], level: 'push' }]);
    expect(sent).toEqual([['nid_1', { devices: 2, accepted: 2 }]]);
  });

  test('in quiet hours it is held quiet: no sound, and off the desktops', async () => {
    const { d, notified, pushed } = deliveryWith({ quietHours: true });
    expect(await d.deliver(notice())).toMatchObject({ ok: true, tier: 'quiet' });
    expect(notified[0]).toMatchObject({ level: 'quiet', reasons: ['Held by quiet hours'] });
    expect(pushed[0]).toMatchObject({ skip: ['laptop'], level: 'quiet', extra: { tier: 'quiet', level: 'quiet' } });
  });

  test('a device whose rule turns the calendar off is skipped', async () => {
    const store = new Store(':memory:', mediaSigner('s'));
    const devices = new Devices(store, new Triage(store));
    devices.otherChain = calendarChain;
    devices.hello('dev_phone1', 'Phone', null);
    devices.hello('dev_laptop1', 'Laptop', null);
    expect(devices.setRule('dev_phone1', 'network', 'calendar', 'none')).toBeNull();
    expect(devices.quietOn(REMINDER_RULE_ID, false)).toEqual(['dev_phone1']);
    const { d, notified, pushed } = deliveryWith({ quiet: devices.quietOn(REMINDER_RULE_ID, false) });
    await d.deliver(notice());
    expect(pushed[0].skip).toEqual(['dev_phone1']);
    expect(notified[0].quiet).toEqual(['dev_phone1']);
  });

  test('a repeated id is a duplicate, and notifies once, even when both come at once', async () => {
    const { d, pushed } = deliveryWith();
    const [a, b] = await Promise.all([d.deliver(notice()), d.deliver(notice())]);
    expect(a).toEqual({ ok: true, tier: 'push', devices: 2, accepted: 2 });
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect(await d.deliver(notice())).toEqual({ ok: true, duplicate: true, tier: 'push', devices: 2, accepted: 2 });
    expect(pushed.length).toBe(1);
    // Another lead time for the same event is its own reminder.
    await d.deliver(notice({ id: 'evt_1|1800000000000|60', minutesBefore: 60 }));
    expect(pushed.length).toBe(2);
  });

  test('over HTTP: from loopback without an Origin only; a bad body is 400', async () => {
    const got: P.ReminderNotice[] = [];
    const H = hub({ onReminder: async (n) => (got.push(n), { ok: true, tier: 'push', devices: 0, accepted: 0 }) });
    try {
      const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${H.base}/api/calendar/notify`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      expect((await post(notice(), { origin: H.base })).status).toBe(403);
      expect((await post({ ...notice(), when: 7 })).status).toBe(400);
      const ok = await post(notice());
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, tier: 'push', devices: 0, accepted: 0 });
      expect(got.map((n) => n.id)).toEqual([notice().id]);
    } finally {
      H.h.stop();
    }
  });
});
