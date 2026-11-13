/**
 * dither-calendar beside the hub (calendar.ts, calendar-account.ts, docs/calendar.md): /calendar/* forwarded to a fake
 * calendar, the plans kept from its event stream, the calendar account (its seed, the calendar following it, the
 * adapter link both ways) and reminders as its messages. The fakes listen on port 0 and hold their streams and sockets
 * open; every wait is on an event (a stream chunk, a broadcast, a socket frame), never a timer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { CalendarLink, calendarUrl } from '../src/calendar.ts';
import { CALENDAR_ADDED, CalendarAccounts, CalendarBridge, CHAT_ADAPTER_PATH, seedCalendarAccount } from '../src/calendar-account.ts';
import { Devices } from '../src/devices.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Supervisor } from '../src/supervisor.ts';
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

const sup = { authorize: () => null, online: () => true, command: async () => ({}), note() {}, liveViewUrl: () => null, writeSecret() {}, start() {}, stop: async () => {}, forget: async () => {} } as any;
/** A hub with this calendar link on (as an enabled calendar account would have it), or a calendar holder of its own. */
function hub(opts: { calendar?: CalendarLink; accounts?: (store: Store) => { link(): CalendarLink | undefined; sync(): void } } = {}) {
  const store = new Store(':memory:', mediaSigner('s'));
  const link = opts.calendar;
  const calendar = opts.accounts ? opts.accounts(store) : link ? { link: () => link, sync() {} } : undefined;
  const h = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's', calendar });
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


// ------------------------------------------------------------------ the calendar account

describe('the first start with calendar accounts', () => {
  const fresh = () => new Store(':memory:', mediaSigner('s'));
  const calendars = (s: Store) => s.accounts().filter((a) => a.network === 'calendar');

  test('a hub that had the default calendar gets an account for it, once', () => {
    const s = fresh();
    const acc = seedCalendarAccount(s, {}, false)!;
    expect(acc).toMatchObject({ network: 'calendar', adapter: 'calendar', label: 'Calendar', enabled: 1, demo: 0 });
    expect(JSON.parse(acc.config)).toEqual({ url: 'http://127.0.0.1:8470' });
    expect(s.accountView(acc).url).toBe('http://127.0.0.1:8470');
    expect(seedCalendarAccount(s, {}, false)).toBeNull();
    expect(calendars(s)).toHaveLength(1);
  });

  test('DITHER_CALENDAR_URL says where; off, empty or a demo hub add none', () => {
    const s = fresh();
    expect(JSON.parse(seedCalendarAccount(s, { DITHER_CALENDAR_URL: 'http://127.0.0.1:9471/' }, false)!.config)).toEqual({ url: 'http://127.0.0.1:9471' });
    for (const [env, demo] of [[{ DITHER_CALENDAR_URL: 'off' }, false], [{ DITHER_CALENDAR_URL: '' }, false], [{}, true], [{ DITHER_CALENDAR_URL: 'http://127.0.0.1:9' }, true]] as const) {
      const t = fresh();
      expect(seedCalendarAccount(t, env, demo)).toBeNull();
      expect(calendars(t)).toEqual([]);
      // Nothing was done, so nothing is written down: a later start without `off` still adds it.
      expect(t.db.query('SELECT 1 FROM meta WHERE key = ?').get(CALENDAR_ADDED)).toBeNull();
    }
  });

  test('removing it sticks: the next start adds none', () => {
    const s = fresh();
    const acc = seedCalendarAccount(s, {}, false)!;
    s.deleteAccount(acc.id);
    expect(seedCalendarAccount(s, {}, false)).toBeNull();
    expect(calendars(s)).toEqual([]);
  });

  test('one added by hand before is left as it is', () => {
    const s = fresh();
    s.createAccount({ network: 'calendar', label: 'Mine', color: '#000', adapter: 'calendar', config: { url: 'http://127.0.0.1:9472' } });
    expect(seedCalendarAccount(s, {}, false)).toBeNull();
    expect(calendars(s).map((a) => a.label)).toEqual(['Mine']);
    expect(s.db.query('SELECT 1 FROM meta WHERE key = ?').get(CALENDAR_ADDED)).not.toBeNull();
  });
});

describe('the calendar follows its account', () => {
  const cal = fakeCalendar();
  afterAll(() => cal.server.stop(true));

  test('on while an enabled calendar account is; disabling or removing it turns it off, and pages hear both', async () => {
    const ev = events();
    const s = new Store(':memory:', mediaSigner('s'));
    const c = new CalendarAccounts(s, { broadcast: ev.broadcast, demo: false, debounceMs: 0 });
    c.sync();
    expect(c.link()).toBeUndefined();
    c.start();
    const acc = s.createAccount({ network: 'calendar', label: 'Calendar', color: '#000', adapter: 'calendar', config: { url: cal.url } });
    c.sync();
    expect(c.url()).toBe(cal.url);
    expect(ev.all[0]).toEqual({ t: 'calendar', reachable: false, waiting: 0 });
    // The link reads the calendar at the account's address.
    await ev.next((e) => e.t === 'calendar' && e.reachable);
    s.updateAccount(acc.id, { enabled: 0 });
    c.sync();
    expect(c.link()).toBeUndefined();
    expect(ev.all.at(-1)).toEqual({ t: 'calendar', reachable: false, waiting: 0, off: true });
    s.updateAccount(acc.id, { enabled: 1 });
    c.sync();
    expect(c.link()).toBeDefined();
    s.deleteAccount(acc.id);
    c.sync();
    expect(c.link()).toBeUndefined();
    expect(ev.all.at(-1)).toMatchObject({ off: true });
    c.stop();
  });

  test('a demo hub never has one, whatever its accounts say', () => {
    const s = new Store(':memory:', mediaSigner('s'));
    const acc = s.createAccount({ network: 'calendar', label: 'Calendar', color: '#000', adapter: 'calendar', config: { url: cal.url } });
    const c = new CalendarAccounts(s, { broadcast: () => {}, demo: true });
    c.sync();
    expect(c.link()).toBeUndefined();
    expect(c.factory(acc)).toBeNull();
  });

  test('POST /api/accounts: one calendar, at an http(s) address (the default when none), and removing it turns it off', async () => {
    let c!: CalendarAccounts;
    const H = hub({ accounts: (store) => (c = new CalendarAccounts(store, { broadcast: () => {}, demo: false, debounceMs: 0 })) });
    c.start();
    const add = (config: unknown) => fetch(`${H.base}/api/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: 'calendar', config }) });
    try {
      expect((await add({ url: 'ftp://x' })).status).toBe(400);
      const ok = await add({});
      expect(ok.status).toBe(200);
      const view = (await ok.json()) as P.AccountView;
      expect(view).toMatchObject({ network: 'calendar', label: 'Calendar', url: 'http://127.0.0.1:8470' });
      expect(H.store.account(view.id)!.adapter).toBe('calendar');
      expect(H.store.db.query('SELECT 1 FROM meta WHERE key = ?').get(CALENDAR_ADDED)).not.toBeNull();
      expect(((await (await fetch(`${H.base}/api/bootstrap`)).json()) as P.Bootstrap).calendar).toMatchObject({ path: '/calendar/' });
      expect((await add({ url: cal.url })).status).toBe(409);
      expect((await fetch(`${H.base}/api/accounts/${view.id}`, { method: 'DELETE' })).status).toBe(200);
      expect(c.link()).toBeUndefined();
      expect(((await (await fetch(`${H.base}/api/bootstrap`)).json()) as P.Bootstrap).calendar).toBeUndefined();
      expect((await fetch(`${H.base}/calendar/api/state`)).status).toBe(404);
      // Reminders come as the calendar's messages now: the old door is gone.
      expect((await fetch(`${H.base}/api/calendar/notify`, { method: 'POST', body: '{}' })).status).toBe(404);
    } finally {
      c.stop();
      H.h.stop();
    }
  });
});

// ------------------------------------------------------------------ the adapter link

type Frame = Record<string, any>;
/** A calendar service's adapter endpoint: says hello on connect, records the hub's commands, answers as told. */
function fakeService() {
  const got: Frame[] = [];
  const sockets = new Set<any>();
  const waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  const opened: (() => void)[] = [];
  const state = { answer: true, refuse: false };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (new URL(req.url).pathname === CHAT_ADAPTER_PATH && !state.refuse && srv.upgrade(req, { data: {} })) return undefined;
      return new Response('no', { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        const send = (ev: unknown) => ws.send(JSON.stringify(ev));
        send({ t: 'hello', network: 'calendar', version: 'test', capabilities: ['send', 'personRefs'], protocol: 1 });
        send({ t: 'status', status: 'online', self: { nativeId: 'owner', displayName: 'You', isSelf: true } });
        send({ t: 'identity', identity: { nativeId: 'calendar', displayName: 'Calendar' } });
        send({ t: 'conversation', conversation: { nativeId: 'calendar', shape: 'direct', participants: ['owner', 'calendar'] } });
        send({ t: 'message', message: { nativeId: 'w1', conversation: 'calendar', author: 'calendar', ts: 1_000, body: 'Tell me what to add.' }, live: false });
        for (const f of opened.splice(0)) f();
      },
      message(ws, raw) {
        const f = JSON.parse(String(raw)) as Frame;
        got.push(f);
        for (const w of waiters.splice(0)) (w.pred(f) ? w.resolve(f) : waiters.push(w));
        if (f.t === 'send' && state.answer) {
          ws.send(JSON.stringify({ t: 'message', message: { nativeId: `me:${f.id}`, conversation: f.conversation, author: 'owner', ts: 2_000, body: f.body }, live: true }));
          ws.send(JSON.stringify({ t: 'reply', id: f.id, ok: true, result: { nativeId: `me:${f.id}` } }));
          ws.send(JSON.stringify({ t: 'message', message: { nativeId: `re:${f.id}`, conversation: f.conversation, author: 'calendar', ts: 2_001, body: `Added ${f.body}` }, live: true }));
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    got,
    state,
    sockets,
    next: (pred: (f: Frame) => boolean) => new Promise<Frame>((resolve) => waiters.push({ pred, resolve })),
    connected: () => (sockets.size ? Promise.resolve() : new Promise<void>((r) => opened.push(r))),
    send: (ev: unknown) => {
      for (const ws of sockets) ws.send(JSON.stringify(ev));
    },
    dropAll: () => {
      for (const ws of sockets) ws.close(1001, 'going away');
    },
  };
}

describe('the bridge', () => {
  test('relays the service’s events and the hub’s commands both ways; a command it cannot ask fails at once', async () => {
    const svc = fakeService();
    const got: P.AdapterEvent[] = [];
    const waiters: { pred: (e: P.AdapterEvent) => boolean; resolve: (e: P.AdapterEvent) => void }[] = [];
    const next = (pred: (e: P.AdapterEvent) => boolean) => new Promise<P.AdapterEvent>((resolve) => waiters.push({ pred, resolve }));
    const emit = (e: P.AdapterEvent) => {
      got.push(e);
      for (const w of waiters.splice(0)) (w.pred(e) ? w.resolve(e) : waiters.push(w));
    };
    const b = new CalendarBridge({ url: svc.url });
    const hello = next((e) => e.t === 'hello');
    const snapshot = next((e) => e.t === 'message');
    // Before it is connected: answered at once, not after the supervisor's timeout.
    const early = next((e) => e.t === 'reply' && e.id === 'c0');
    b.start(emit);
    b.command({ t: 'markRead', id: 'c0', conversation: 'calendar', upTo: 'w1' });
    expect(await early).toEqual({ t: 'reply', id: 'c0', ok: false, error: 'the calendar is not connected' });
    expect(got[0]).toEqual({ t: 'status', status: 'connecting' });
    expect(await hello).toMatchObject({ network: 'calendar', capabilities: ['send', 'personRefs'] });
    await snapshot;
    const reply = next((e) => e.t === 'reply' && e.id === 'c1');
    b.command({ t: 'send', id: 'c1', conversation: 'calendar', body: 'dentist friday 3pm' });
    expect(await reply).toEqual({ t: 'reply', id: 'c1', ok: true, result: { nativeId: 'me:c1' } });
    expect(svc.got).toEqual([{ t: 'send', id: 'c1', conversation: 'calendar', body: 'dentist friday 3pm' }]);
    // The service goes away with a command unanswered: it fails now, and the account is offline.
    svc.state.answer = false;
    const asked = svc.next((f) => f.id === 'c2');
    const failed = next((e) => e.t === 'reply' && e.id === 'c2');
    b.command({ t: 'send', id: 'c2', conversation: 'calendar', body: 'x' });
    await asked;
    const offline = next((e) => e.t === 'status' && e.status === 'offline');
    const again = next((e) => e.t === 'hello');
    svc.dropAll();
    expect(await failed).toEqual({ t: 'reply', id: 'c2', ok: false, error: 'the calendar went away before it answered' });
    await offline;
    // And it dials again by itself.
    await again;
    b.stop();
    svc.server.stop(true);
  });

  test('through the supervisor: the service’s chat lands in the hub, and a send goes to it and back', async () => {
    const svc = fakeService();
    const store = new Store(':memory:', mediaSigner('s'));
    const fresh: string[] = [];
    const c = new CalendarAccounts(store, { broadcast: () => {}, demo: false, debounceMs: 0 });
    const s = new Supervisor(store, { hubAdapterUrl: 'ws://127.0.0.1:1/adapter', dataDir: dir, repoRoot: dir, inproc: (acc) => c.factory(acc), onFresh: (ids) => void fresh.push(...ids) });
    // Resolves once what the supervisor applied makes `pred` true.
    const checks: { pred: () => boolean; resolve: () => void }[] = [];
    s.onApplied = () => {
      for (const c of checks.splice(0)) (c.pred() ? c.resolve() : checks.push(c));
    };
    const until = (pred: () => boolean) => (pred() ? Promise.resolve() : new Promise<void>((resolve) => checks.push({ pred, resolve })));
    const acc = store.createAccount({ network: 'calendar', label: 'Calendar', color: '#000', adapter: 'calendar', config: { url: svc.url } });
    s.start(acc.id);
    await svc.connected();
    // The hello, the status and the snapshot are in once the backfilled message is.
    const welcome = () => store.one<{ body: string }>(`SELECT body FROM message WHERE network = 'calendar' AND native_id = 'w1'`);
    await until(() => !!welcome());
    expect(welcome()?.body).toBe('Tell me what to add.');
    expect(store.account(acc.id)).toMatchObject({ status: 'online', capabilities: JSON.stringify(['send', 'personRefs']) });
    const conv = store.one<{ id: string; shape: string }>(`SELECT id, shape FROM conversation WHERE network = 'calendar'`)!;
    expect(conv).toMatchObject({ shape: 'direct' });
    // Backfill notifies nothing.
    expect(fresh).toEqual([]);
    const r = await s.command<{ nativeId: string }>(acc.id, { t: 'send', conversation: 'calendar', body: 'lunch at noon' });
    expect(r.nativeId).toMatch(/^me:/);
    await until(() => fresh.length >= 1);
    // Your own message is not triaged; the calendar's answer is.
    expect(fresh.length).toBe(1);
    expect(store.one<{ body: string }>('SELECT body FROM message WHERE id = ?', fresh[0])?.body).toBe('Added lunch at noon');
    await s.stopAll();
    svc.server.stop(true);
  });
});

// ------------------------------------------------------------------ reminders: the calendar's messages

describe('reminders', () => {
  const night: P.QuietHours = { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC', allowStarred: true };
  const at = (h: number) => Date.UTC(2026, 10, 12, h);
  const world = () => {
    const store = new Store(':memory:', mediaSigner('s'));
    const triage = new Triage(store);
    triage.judge = async () => 0.01;
    const acc = store.createAccount({ network: 'calendar', label: 'Calendar', color: '#000', adapter: 'calendar', config: { url: 'http://127.0.0.1:1' } });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'owner', isSelf: true } });
    store.ingest(acc, { t: 'identity', identity: { nativeId: 'calendar', displayName: 'Calendar' } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'calendar', shape: 'direct', participants: ['owner', 'calendar'] } });
    let n = 0;
    const say = (body: string, extra?: Record<string, unknown>) => {
      const nativeId = `r${++n}`;
      store.ingest(acc, { t: 'message', message: { nativeId, conversation: 'calendar', author: 'calendar', ts: at(12) + n, body, ...(extra ? { extra } : {}) }, live: true });
      return store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
    };
    const cid = store.one<{ id: string }>(`SELECT id FROM conversation WHERE network = 'calendar'`)!.id;
    return { store, triage, acc, say, cid };
  };
  const reminder = (over: Partial<P.CalendarReminderRef> = {}) => ({ reminder: { id: 'evt_1|1800000000000|10', eventKey: 'evt_1', open: '#/day/2026-11-12', meetingUrl: null, late: false, ...over } });

  test('a reminder is an alert, the calendar’s other words are not', async () => {
    const w = world();
    const d = await w.triage.decide(w.say('**Standup** in 10 min · 10:00–10:15', reminder()), at(12));
    expect(d).toMatchObject({ decision: 'push', forced: true, reminder: true });
    expect(d!.reasons[0]).toBe('A reminder from Calendar');
    const late = await w.triage.decide(w.say('**Standup** now', reminder({ id: 'x', late: true })), at(12));
    expect(late!.reasons[0]).toBe('A reminder from Calendar, sent late');
    expect((await w.triage.decide(w.say('Added Dentist · Fri 14 Nov 15:00'), at(12)))?.decision).not.toBe('push');
  });

  test('in quiet hours it is held quiet, and left out of their summary', async () => {
    const w = world();
    w.store.setQuietHours(night);
    w.store.setQuietHeld(null);
    const d = await w.triage.decide(w.say('**Standup** in 10 min', reminder()), at(23));
    expect(d!.decision).toBe('quiet');
    expect(d!.reasons[0]).toBe('Held by quiet hours until 07:00');
    expect(w.store.quietHeld()).toBeNull();
  });

  test('a muted Calendar chat, or one kept to the list, does not alert', async () => {
    const w = world();
    w.store.setRule('conversation', w.cid, 'none');
    expect((await w.triage.decide(w.say('a', reminder()), at(12)))?.decision).toBe('silent');
    w.store.setRule('conversation', w.cid, 'digest');
    expect((await w.triage.decide(w.say('b', reminder({ id: 'y' })), at(12)))?.decision).not.toBe('push');
  });

  test('device rules on the Calendar network keep it off a device, and Mentions only does too', () => {
    const w = world();
    const devices = new Devices(w.store, w.triage);
    devices.hello('dev_phone1', 'Phone', null);
    devices.hello('dev_laptop1', 'Laptop', null);
    devices.hello('dev_tablet1', 'Tablet', null);
    expect(devices.chain(w.cid).at(-1)).toBe('network:calendar');
    expect(devices.setRule('dev_phone1', 'network', 'calendar', 'none')).toBeNull();
    expect(devices.setRule('dev_tablet1', 'network', 'calendar', 'mentions')).toBeNull();
    const id = w.say('**Standup** in 10 min', reminder());
    // A reminder mentions no one.
    expect(devices.addressed(id)).toBe(false);
    expect(devices.quietOn(w.cid, false).sort()).toEqual(['dev_phone1', 'dev_tablet1']);
  });
});
