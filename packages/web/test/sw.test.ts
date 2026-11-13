/** public/sw.js against a stand-in for its worker scope: what it shows, sends and closes. Chromium itself: scripts/verify-reply.ts. */
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const src = await Bun.file(resolve(import.meta.dir, '../public/sw.js')).text();

function worker(opts: { canReply?: boolean; fetch?: (url: string, init: any) => Promise<Response> } = {}) {
  const listeners: Record<string, (e: any) => void> = {};
  const shown: { title: string; o: any }[] = [];
  const closed: string[] = [];
  const fetched: { url: string; body: any; method: string }[] = [];
  const opened: string[] = [];
  const registration = {
    showNotification: async (title: string, o: any) => void shown.push({ title, o }),
    getNotifications: async ({ tag }: { tag: string }) => [{ close: () => closed.push(`other:${tag}`) }],
  };
  const self: any = { registration, addEventListener: (t: string, fn: (e: any) => void) => (listeners[t] = fn), clients: { matchAll: async () => [], openWindow: async (u: string) => void opened.push(u) } };
  const NotificationEvent: any = function () {};
  if (opts.canReply !== false) NotificationEvent.prototype.reply = null;
  const fetchStub = async (url: string, init: any) => {
    fetched.push({ url, body: init.body ? JSON.parse(init.body) : undefined, method: init.method });
    return (opts.fetch ?? (async () => Response.json({ ok: true })))(url, init);
  };
  new Function('self', 'fetch', 'NotificationEvent', 'caches', src)(self, fetchStub, NotificationEvent, {});
  const run = async (type: string, e: any) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners[type]({ ...e, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  const push = (d: unknown) => run('push', { data: { json: () => d } });
  const click = (data: unknown, action = '', reply: string | null | undefined = null) => run('notificationclick', { action, reply, notification: { tag: 'cnv_1', data, close: () => closed.push('it') } });
  const dismiss = (data: unknown) => run('notificationclose', { notification: { data } });
  return { shown, closed, fetched, opened, push, click, dismiss };
}

const actions = (w: ReturnType<typeof worker>) => w.shown.at(-1)!.o.actions.map((a: any) => a.action);

test('a text action only where the browser can read the text and the hub said it may go out', async () => {
  const yes = worker();
  await yes.push({ title: 't', conversationId: 'cnv_1', canReply: true, replyTo: 'msg_1' });
  expect(yes.shown[0].o.actions[0]).toMatchObject({ action: 'reply', type: 'text' });
  expect(actions(yes)).toEqual(['reply', 'open']);
  expect(yes.shown[0].o.data.replyTo).toBe('msg_1');

  const firefox = worker({ canReply: false });
  await firefox.push({ title: 't', conversationId: 'cnv_1', canReply: true });
  expect(actions(firefox)).toEqual(['open']);

  const encrypted = worker();
  await encrypted.push({ title: 't', conversationId: 'cnv_1' });
  expect(actions(encrypted)).toEqual(['open']);

  const inbox = worker();
  await inbox.push({ title: 't', inbox: true });
  expect(actions(inbox)).toEqual([]);
  expect(inbox.shown[0].o.tag).toBe('dither-inbox');
});

test('a reply goes through the normal send, and clears the notification', async () => {
  const w = worker();
  await w.click({ conversationId: 'cnv_1', replyTo: 'msg_1' }, 'reply', '  on my way ');
  expect(w.fetched).toEqual([{ url: '/api/conversations/cnv_1/send', method: 'POST', body: { body: 'on my way', replyTo: 'msg_1' } }]);
  expect(w.closed).toEqual(['it', 'other:cnv_1']);
  expect(w.shown).toEqual([]);
  expect(w.opened).toEqual([]);
});

test('a refusal shows what the hub said, and keeps what was typed', async () => {
  const w = worker({ fetch: async () => Response.json({ error: 'Sending to encrypted Matrix rooms is not supported yet' }, { status: 409 }) });
  await w.click({ conversationId: 'cnv_1' }, 'reply', 'hello');
  expect(w.shown[0].title).toBe('Reply not sent');
  expect(w.shown[0].o.body).toBe('Sending to encrypted Matrix rooms is not supported yet. You wrote: hello');
  expect(w.shown[0].o.tag).toBe('cnv_1');
  expect(w.shown[0].o.data.conversationId).toBe('cnv_1');
  expect(w.closed).toEqual([]);
});

test('no answer at all is a failure too, and an answer without JSON is not a crash', async () => {
  const down = worker({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await down.click({ conversationId: 'cnv_1' }, 'reply', 'hello');
  expect(down.shown[0].o.body).toStartWith('Could not reach the hub.');
  const gate = worker({ fetch: async () => new Response('cross-site request refused', { status: 403 }) });
  await gate.click({ conversationId: 'cnv_1' }, 'reply', 'hello');
  expect(gate.shown[0].o.body).toStartWith('The hub answered 403.');
});

test('a button with no text, or an empty reply, just opens the conversation', async () => {
  for (const reply of [null, undefined, '   ']) {
    const w = worker();
    await w.click({ conversationId: 'cnv_1' }, 'reply', reply);
    expect(w.fetched).toEqual([]);
    expect(w.opened).toEqual(['/#/inbox/c/cnv_1']);
    expect(w.closed).toEqual(['it']);
  }
});

test('a click elsewhere never sends', async () => {
  const w = worker();
  await w.click({ conversationId: 'cnv_1' }, 'open', 'stale');
  expect(w.fetched).toEqual([]);
  expect(w.opened).toEqual(['/#/inbox/c/cnv_1']);
});

/** The fetch handler alone, against a cache that holds one build's shell. */
function shell(cached: Record<string, string>, net: (url: string) => Promise<Response> = async () => new Response('network')) {
  let onFetch: (e: any) => void = () => {};
  const self: any = { addEventListener: (t: string, fn: (e: any) => void) => t === 'fetch' && (onFetch = fn), location: { origin: 'https://hub.example' } };
  const fetched: string[] = [];
  const cache = { match: async (r: any) => (cached[typeof r === 'string' ? r : new URL(r.url).pathname] !== undefined ? new Response(cached[typeof r === 'string' ? r : new URL(r.url).pathname]) : undefined), put: async () => {} };
  const fetchStub = async (r: any) => (fetched.push(typeof r === 'string' ? r : r.url), net(typeof r === 'string' ? r : r.url));
  new Function('self', 'fetch', 'NotificationEvent', 'caches', 'location', src)(self, fetchStub, function () {}, { open: async () => cache }, self.location);
  return {
    fetched,
    async get(path: string, mode = 'navigate'): Promise<string | null> {
      let res: Promise<Response> | null = null;
      onFetch({ request: { method: 'GET', url: 'https://hub.example' + path, mode }, respondWith: (p: Promise<Response>) => (res = p) });
      return res ? (await res as Response).text() : null;
    },
  };
}

test('opening the app never waits on the network: navigations get the cached shell', async () => {
  const s = shell({ '/index.html': 'cached shell' });
  expect(await s.get('/')).toBe('cached shell');
  expect(await s.get('/?source=pwa')).toBe('cached shell');
  expect(s.fetched).toEqual([]);
});

test('without a cached shell, the network', async () => {
  const s = shell({});
  expect(await s.get('/')).toBe('network');
});

test("the hub's own pages are never the app", async () => {
  const s = shell({ '/index.html': 'cached shell' });
  for (const p of ['/api/bootstrap', '/media/x/y', '/ca.crt', '/voice/dave/0123456789abcdef/libdave.mjs', '/calendar', '/calendar/', '/calendar/index.html']) expect(await s.get(p)).toBeNull();
  // The calendar's files (docs/calendar.md) are its own, not this build's.
  for (const p of ['/calendar/assets/index-abc.js', '/calendar/api/stream', '/calendar/sw.js']) expect(await s.get(p, 'cors')).toBeNull();
  expect(await s.get('/api/live', 'cors')).toBeNull();
});

test('what became of a push goes to the activity log, by its id and the device, and only when it has an id', async () => {
  const w = worker();
  await w.push({ title: 't', conversationId: 'cnv_1', nid: 'n1', device: 'sub1' });
  const events = () => w.fetched.filter((f) => f.url === '/api/activity/notifications').map((f) => f.body.events[0]);
  expect(events().map((e) => [e.id, e.device, e.event])).toEqual([
    ['n1', 'sub1', 'delivered'],
    ['n1', 'sub1', 'shown'],
  ]);
  expect(w.shown[0].o.data).toMatchObject({ nid: 'n1', device: 'sub1' });
  // The tap opens the conversation with the push's id in the hash, so the page can link the visit.
  await w.click(w.shown[0].o.data);
  expect(w.opened).toEqual(['/#/inbox/c/cnv_1?n=n1']);
  expect(events().at(-1)).toMatchObject({ id: 'n1', event: 'tapped' });
  await w.dismiss(w.shown[0].o.data);
  expect(events().at(-1)).toMatchObject({ id: 'n1', event: 'dismissed' });

  // A reply from the notification is an outcome too.
  await w.click(w.shown[0].o.data, 'reply', 'ok');
  expect(events().at(-1)).toMatchObject({ id: 'n1', event: 'replied' });

  const quiet = worker();
  await quiet.push({ title: 't', conversationId: 'cnv_1' });
  await quiet.click({ conversationId: 'cnv_1' });
  expect(quiet.fetched).toEqual([]);
  expect(quiet.opened).toEqual(['/#/inbox/c/cnv_1']);
});

test('the network badges in sw.js are the app’s own glyphs and colours', async () => {
  const { GLYPH } = await import('../src/brand.ts');
  const { NETWORK_META } = await import('@dither-chat/protocol');
  const nets = new Function(`${src.match(/const NETWORKS = \{[\s\S]*?\n\};/)![0]}; return NETWORKS;`)();
  for (const [n, glyph] of Object.entries(GLYPH)) expect(nets[n]).toEqual({ color: (NETWORK_META as any)[n].color, glyph });
});

test('a page without push hands its notification to the worker; without a canvas it keeps the app icon', async () => {
  const listeners: Record<string, (e: any) => void> = {};
  const shown: any[] = [];
  const self: any = { registration: { showNotification: async (title: string, o: any) => void shown.push({ title, o }) }, addEventListener: (t: string, fn: any) => (listeners[t] = fn), clients: { matchAll: async () => [] } };
  new Function('self', 'fetch', 'NotificationEvent', 'caches', src)(self, async () => Response.json({}), function () {}, {});
  let done: Promise<unknown> = Promise.resolve();
  listeners.message({ data: { t: 'notify', d: { title: 'Ana · Signal', body: 'hi', conversationId: 'cnv_1', network: 'signal', icon: '/media/x/y', nid: 'n1' } }, waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  expect(shown[0].title).toBe('Ana · Signal');
  expect(shown[0].o).toMatchObject({ tag: 'cnv_1', icon: '/icon-192.png', badge: '/icon-192.png', data: { nid: 'n1' } });
});

test("a group's or channel's own picture over the sender's; a DM, or a group without one, the sender's", async () => {
  // Just enough canvas for looks() to draw; what it fetches is the picture it chose.
  const g: any = globalThis;
  const saved = { OffscreenCanvas: g.OffscreenCanvas, Path2D: g.Path2D, createImageBitmap: g.createImageBitmap };
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  g.OffscreenCanvas = class {
    getContext() {
      return ctx;
    }
    async convertToBlob() {
      return new Blob([new Uint8Array([1])]);
    }
  };
  g.Path2D = class {};
  g.createImageBitmap = async () => ({ width: 1, height: 1 });
  try {
    const pictures: string[] = [];
    const w = worker({ fetch: async (url) => (pictures.push(url), new Response('x')) });
    const base = { title: 't', conversationId: 'cnv_1', network: 'discord', icon: '/media/sender' };
    await w.push({ ...base, conv: { title: 'Trip', shape: 'group', icon: '/media/group' } });
    await w.push({ ...base, conv: { title: 'general', shape: 'channel', icon: '/media/server' } });
    await w.push({ ...base, icon: '/media/ann', conv: { title: 'Ann', shape: 'direct', icon: '/media/ann-dm' } });
    await w.push({ ...base, icon: '/media/bo', conv: { title: 'Trip', shape: 'group' } });
    await w.push({ ...base, icon: '/media/cy' });
    expect(pictures).toEqual(['/media/group', '/media/server', '/media/ann', '/media/bo', '/media/cy']);
    // No picture at all: still drawn (the letter on a disc), with nothing fetched.
    await w.push({ title: 'Zed', conversationId: 'cnv_2', network: 'discord', conv: { title: 'Zed', shape: 'group' } });
    expect(pictures).toHaveLength(5);
    expect(w.shown.at(-1)!.o.icon).toStartWith('data:image/png;base64,');
  } finally {
    Object.assign(g, saved);
  }
});

const titles = (w: ReturnType<typeof worker>) => w.shown.at(-1)!.o.actions.map((a: any) => a.title);
const base = { title: 't', conversationId: 'cnv_1', messageId: 'msg_1' };

test('the actions go by the tier: an alert Reply and "Not urgent", a Conversation Reply and "Should have alerted", a list row both marks', async () => {
  const w = worker();
  await w.push({ ...base, canReply: true, tier: 'push', level: 'push' });
  expect(titles(w)).toEqual(['Reply', 'Not urgent']);
  expect(actions(w)).toEqual(['reply', 'wrong']);
  await w.push({ ...base, canReply: true, tier: 'quiet', level: 'quiet' });
  expect(titles(w)).toEqual(['Reply', 'Should have alerted']);
  expect(actions(w)).toEqual(['reply', 'alert']);
  await w.push({ ...base, canReply: true, tier: 'digest', level: 'quiet' });
  expect(titles(w)).toEqual(['Less like this', 'Should have alerted']);
  expect(actions(w)).toEqual(['less', 'alert']);
  // Where no reply can be typed, or the hub said it may not go out: the mark alone, and for a list row both.
  const firefox = worker({ canReply: false });
  await firefox.push({ ...base, canReply: true, tier: 'push' });
  expect(titles(firefox)).toEqual(['Not urgent']);
  await firefox.push({ ...base, tier: 'quiet' });
  expect(titles(firefox)).toEqual(['Should have alerted']);
  await firefox.push({ ...base, tier: 'digest' });
  expect(titles(firefox)).toEqual(['Less like this', 'Should have alerted']);
  // Without the message's id there is nothing to mark: it opens, as before.
  await w.push({ title: 't', conversationId: 'cnv_1', tier: 'quiet' });
  expect(actions(w)).toEqual(['open']);
  // Mail takes only "Less like this", and has no alert marks.
  await w.push({ ...base, messageId: 'mml_1', mailThreadId: 'cnv_1', tier: 'digest', level: 'quiet' });
  expect(titles(w)).toEqual(['Less like this']);
  await w.push({ ...base, messageId: 'mml_1', mailThreadId: 'cnv_1', tier: 'push', level: 'push' });
  expect(actions(w)).toEqual(['open']);
});

test('only an alert may sound: a Conversation and a list row are silent, whatever else the push says', async () => {
  const w = worker();
  const said = () => {
    const o = w.shown.at(-1)!.o;
    return { silent: o.silent, renotify: o.renotify };
  };
  await w.push({ ...base, tier: 'push', level: 'push' });
  expect(said()).toEqual({ silent: false, renotify: true });
  await w.push({ ...base, tier: 'quiet', level: 'quiet' });
  expect(said()).toEqual({ silent: true, renotify: false });
  await w.push({ ...base, tier: 'digest', level: 'quiet' });
  expect(said()).toEqual({ silent: true, renotify: false });
  await w.push({ ...base, tier: 'quiet', level: 'quiet', alert: true });
  expect(said()).toEqual({ silent: true, renotify: false });
  await w.push({ ...base, tier: 'digest', level: 'quiet', alert: true });
  expect(said()).toEqual({ silent: true, renotify: false });
  // An alert the hub sends as an update to one already showing: no second sound.
  await w.push({ ...base, tier: 'push', level: 'push', alert: false });
  expect(said()).toEqual({ silent: true, renotify: false });
  // The tier wins over the level beside it.
  await w.push({ ...base, tier: 'digest', level: 'push' });
  expect(said()).toEqual({ silent: true, renotify: false });
  expect(titles(w)).toEqual(['Less like this', 'Should have alerted']);
});

test('a hub from before the tiers says only the level: quiet is a silent Conversation, anything else an alert', async () => {
  const w = worker();
  await w.push({ ...base, canReply: true, level: 'quiet' });
  expect(w.shown.at(-1)!.o).toMatchObject({ silent: true, renotify: false });
  expect(titles(w)).toEqual(['Reply', 'Should have alerted']);
  await w.push({ ...base, canReply: true, level: 'push' });
  expect(w.shown.at(-1)!.o).toMatchObject({ silent: false, renotify: true });
  expect(titles(w)).toEqual(['Reply', 'Not urgent']);
  await w.push({ ...base, canReply: true });
  expect(w.shown.at(-1)!.o).toMatchObject({ silent: false, renotify: true });
  expect(titles(w)).toEqual(['Reply', 'Not urgent']);
});

test('a mark from the notification tells the hub what it says, closes it, and opens nothing', async () => {
  for (const [action, body] of [
    ['wrong', { alert: false }],
    ['alert', { alert: true }],
    ['less', { less: true }],
  ] as const) {
    const w = worker();
    await w.click({ conversationId: 'cnv_1', messageId: 'msg_1' }, action);
    expect(w.fetched).toEqual([{ url: '/api/messages/msg_1/feedback', method: 'POST', body }]);
    expect(w.closed).toEqual(['it']);
    expect(w.opened).toEqual([]);
  }
  // Without a message, or with an action from a notification shown before the tiers, it opens the conversation.
  const none = worker();
  await none.click({ conversationId: 'cnv_1' }, 'less');
  expect(none.fetched).toEqual([]);
  expect(none.opened).toEqual(['/#/inbox/c/cnv_1']);
  const old = worker();
  await old.click({ conversationId: 'cnv_1', messageId: 'msg_1' }, 'up');
  expect(old.fetched).toEqual([]);
  expect(old.opened).toEqual(['/#/inbox/c/cnv_1']);
});

test('a conversation shows its unread lines, and sounds only when the hub says so', async () => {
  const w = worker();
  const lines = [
    { author: 'Ann', key: 'p1', body: 'are you coming', ts: 1 },
    { author: 'Bo', key: 'p2', body: 'leaving at 6', ts: 2 },
  ];
  await w.push({ title: 'Family', body: 'Bo: leaving at 6', conversationId: 'cnv_1', tier: 'push', level: 'push', alert: false, count: 3, conv: { title: 'Family', shape: 'group' }, lines });
  expect(w.shown.at(-1)!.title).toBe('Family (3)');
  expect(w.shown.at(-1)!.o.body).toBe('Ann: are you coming\nBo: leaving at 6');
  expect(w.shown.at(-1)!.o).toMatchObject({ tag: 'cnv_1', renotify: false, silent: true });
  await w.push({ title: 'Ann · Signal', conversationId: 'cnv_2', tier: 'push', level: 'push', alert: true, conv: { title: 'Ann', shape: 'direct' }, lines: lines.slice(0, 1).concat({ ...lines[0], body: 'hello?' }) });
  expect(w.shown.at(-1)!.title).toBe('Ann · Signal');
  expect(w.shown.at(-1)!.o.body).toBe('are you coming\nhello?');
  expect(w.shown.at(-1)!.o).toMatchObject({ renotify: true, silent: false });
  // An older hub: no lines, and an alert always sounds.
  await w.push({ title: 'Old', body: 'hi', conversationId: 'cnv_3', level: 'push' });
  expect(w.shown.at(-1)!.o).toMatchObject({ body: 'hi', renotify: true, silent: false });
  // A list row's lines are grouped the same way, silently.
  await w.push({ title: 'Family', conversationId: 'cnv_1', tier: 'digest', level: 'quiet', count: 2, conv: { title: 'Family', shape: 'group' }, lines });
  expect(w.shown.at(-1)!.title).toBe('Family (2)');
  expect(w.shown.at(-1)!.o).toMatchObject({ tag: 'cnv_1', body: 'Ann: are you coming\nBo: leaving at 6', renotify: false, silent: true });
});

test('a request (docs/add.md): silent, a notification of its own, and a tap opens it under Requests', async () => {
  const w = worker();
  await w.push({ title: 'Jules invited you to Nix Hackathon 2026', body: 'On Matrix matrix.org. It waits under Requests.', requestId: 'req_abc', level: 'quiet', tier: 'digest', importance: 0.7, nid: 'n7', device: 'd' });
  expect(w.shown.at(-1)!.o).toMatchObject({ tag: 'request:req_abc', silent: true, renotify: false, actions: [] });
  // From a hub before the tiers, the same.
  await w.push({ title: 'Jules invited you', requestId: 'req_old', level: 'quiet' });
  expect(w.shown.at(-1)!.o).toMatchObject({ tag: 'request:req_old', silent: true, renotify: false, actions: [] });
  w.shown.pop();
  await w.click(w.shown.at(-1)!.o.data);
  expect(w.opened).toEqual(['/#/requests/req_abc?n=n7']);
});

test('a notice (docs/notices.md): one notification per group, its marks, and a tap opens it under Notices', async () => {
  const w = worker();
  await w.push({ title: 'GitHub · o/r', body: 'Secret leaked', conversationId: 'ntg_g', noticeId: 'ntc_a', messageId: 'ntc_a', network: 'notice', tier: 'push', level: 'push', alert: true, nid: 'n9', device: 'd' });
  expect(w.shown.at(-1)!.o).toMatchObject({ tag: 'ntg_g', renotify: true, silent: false });
  expect(w.shown.at(-1)!.o.actions.map((a: { action: string }) => a.action)).toEqual(['wrong']);
  await w.click(w.shown.at(-1)!.o.data);
  expect(w.opened).toEqual(['/#/notices/ntc_a?n=n9']);
  // A group's id without its notice (quiet hours' summary): Notices.
  await w.click({ conversationId: 'ntg_g' });
  expect(w.opened.at(-1)).toBe('/#/notices');
});

test('a calendar reminder (docs/calendar.md): one per event, Join opens the meeting, a tap opens the calendar there', async () => {
  const w = worker();
  const calendar = { open: '#/day/2026-11-14', eventKey: 'evt_1', reminderId: 'evt_1|1|10', meetingUrl: 'https://meet.example/abc' };
  await w.push({ title: 'Standup', body: 'in 10 min · 10:00–10:15', calendar, tier: 'push', level: 'push', nid: 'n9', device: 'd' });
  expect(w.shown.at(-1)!.o).toMatchObject({ tag: 'calendar:evt_1', silent: false, renotify: true });
  expect(actions(w)).toEqual(['join']);
  await w.click(w.shown.at(-1)!.o.data, 'join');
  expect(w.opened).toEqual(['https://meet.example/abc']);
  await w.click(w.shown.at(-1)!.o.data);
  expect(w.opened.at(-1)).toBe('/#/calendar/day/2026-11-14');
  // Without a meeting, no action; held by quiet hours, silent.
  await w.push({ title: 'Dentist', calendar: { ...calendar, eventKey: 'evt_2', meetingUrl: null }, tier: 'quiet', level: 'quiet' });
  expect(w.shown.at(-1)!.o).toMatchObject({ tag: 'calendar:evt_2', silent: true, actions: [] });
  // Join with a link that is not a web page opens the calendar instead.
  await w.click({ calendar: { ...calendar, meetingUrl: 'javascript:alert(1)' } }, 'join');
  expect(w.opened.at(-1)).toBe('/#/calendar/day/2026-11-14');
});

test('a clear push closes the conversation and shows nothing', async () => {
  const w = worker();
  await w.push({ clear: 'cnv_9', device: 'd' });
  expect(w.shown.length).toBe(0);
  expect(w.closed).toEqual(['other:cnv_9']);
});

test('a page out of sight lets a new build in only while no window of the app is in sight; the bar always does', async () => {
  const run = async (data: unknown, windows: { visibilityState: string }[]) => {
    const listeners: Record<string, (e: any) => void> = {};
    let skipped = 0;
    const self: any = {
      registration: {},
      addEventListener: (t: string, fn: (e: any) => void) => (listeners[t] = fn),
      skipWaiting: () => void skipped++,
      clients: { matchAll: async (o: any) => (o?.includeUncontrolled ? windows : []) },
    };
    new Function('self', 'fetch', 'NotificationEvent', 'caches', src)(self, async () => Response.json({}), function () {}, {});
    let done: Promise<unknown> = Promise.resolve();
    listeners.message({ data, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    return skipped;
  };
  const hidden = { visibilityState: 'hidden' };
  const visible = { visibilityState: 'visible' };
  expect(await run({ t: 'skipWaiting', unlessSeen: true }, [hidden, hidden])).toBe(1);
  expect(await run({ t: 'skipWaiting', unlessSeen: true }, [hidden, visible])).toBe(0);
  expect(await run('skipWaiting', [visible])).toBe(1);
});

/** A cache as the Cache API keeps one: entries in the order they went in, a put of the same URL going last. */
function fakeCache() {
  const m = new Map<string, any>();
  return {
    m,
    match: async (r: any) => m.get(typeof r === 'string' ? r : r.url),
    put: async (r: any, res: any) => void (m.delete(r.url), m.set(r.url, res)),
    delete: async (r: any) => m.delete(typeof r === 'string' ? r : r.url),
    keys: async () => [...m.keys()].map((url) => ({ url })),
  };
}

/** A response from this origin ('basic'), as the browser hands the worker one. */
function served(type: string, size: number, status = 200) {
  const r = new Response('x'.repeat(Math.min(size, 16)), { status, headers: { 'content-type': type, 'content-length': String(size) } });
  Object.defineProperty(r, 'type', { value: 'basic' });
  return r;
}

/** The fetch and message handlers, with pictures served from `net` and kept in a cache of their own. */
function pictures(net: (url: string) => Response = () => served('image/png', 2000)) {
  const on: Record<string, (e: any) => void> = {};
  const self: any = { addEventListener: (t: string, fn: (e: any) => void) => (on[t] = fn), location: { origin: 'https://hub.example' } };
  const fetched: string[] = [];
  const media = fakeCache();
  const caches = { open: async (name: string) => (name.startsWith('dither-media-') ? media : fakeCache()) };
  new Function('self', 'fetch', 'NotificationEvent', 'caches', 'location', src)(self, async (r: any) => (fetched.push(r.url), net(r.url)), function () {}, caches, self.location);
  return {
    fetched,
    media,
    /** null: the worker left it to the network. */
    async get(path: string, o: { destination?: string; range?: boolean } = {}): Promise<Response | null> {
      let res: Promise<Response> | null = null;
      const later: Promise<unknown>[] = [];
      on.fetch({
        request: { method: 'GET', url: 'https://hub.example' + path, mode: 'no-cors', destination: o.destination ?? 'image', headers: new Headers(o.range ? { range: 'bytes=0-' } : {}) },
        respondWith: (p: Promise<Response>) => (res = p),
        waitUntil: (p: Promise<unknown>) => void later.push(p),
      });
      const out = res ? await res : null;
      await Promise.all(later);
      return out;
    },
    async message(data: unknown) {
      let done: Promise<unknown> = Promise.resolve();
      on.message({ data, waitUntil: (p: Promise<unknown>) => (done = p) });
      await done;
    },
  };
}

test('a picture is fetched once, then comes from the cache, a page’s own fetch of it too', async () => {
  const w = pictures();
  expect((await w.get('/media/sig/abc?a=acc_1'))?.status).toBe(200);
  expect((await w.get('/media/sig/abc?a=acc_1'))?.status).toBe(200);
  expect((await w.get('/media/sig/abc?a=acc_1', { destination: '' }))?.status).toBe(200);
  expect((await w.get('/emoji/discord/123'))?.status).toBe(200);
  await w.get('/emoji/discord/123');
  expect(w.fetched).toEqual(['https://hub.example/media/sig/abc?a=acc_1', 'https://hub.example/emoji/discord/123']);
});

test('only whole, small images are kept: not a range, a video, a refusal, or something too big or of no stated size', async () => {
  const types: Record<string, Response> = {};
  const w = pictures((url) => types[new URL(url).pathname]!);
  // A range request (a video seeking) and a video element's request go straight to the network.
  expect(await w.get('/media/sig/vid', { range: true })).toBeNull();
  expect(await w.get('/media/sig/vid', { destination: 'video' })).toBeNull();
  const kinds: [string, () => Response][] = [
    ['/media/sig/mp4', () => served('video/mp4', 2000)],
    ['/media/sig/gone', () => served('image/png', 9, 404)],
    ['/media/sig/huge', () => served('image/jpeg', 600 * 1024)],
    ['/media/sig/pdf', () => served('application/pdf', 2000)],
    ['/media/sig/unsized', () => {
      const r = new Response('x', { headers: { 'content-type': 'image/png' } });
      r.headers.delete('content-length');
      Object.defineProperty(r, 'type', { value: 'basic' });
      return r;
    }],
  ];
  for (const [p, make] of kinds) {
    types[p] = make();
    await w.get(p, { destination: '' });
    types[p] = make();
    await w.get(p, { destination: '' });
  }
  expect(w.media.m.size).toBe(0);
  expect(w.fetched.length).toBe(kinds.length * 2);
});

test('past its bounds the oldest pictures go first', async () => {
  const w = pictures();
  // Already full to the count, every entry small: the next 25 new ones push out the 25 oldest.
  for (let i = 0; i < 4000; i++) w.media.m.set(`https://hub.example/media/s/old${i}`, served('image/png', 100));
  for (let i = 0; i < 25; i++) await w.get(`/media/s/new${i}`);
  expect(w.media.m.size).toBe(4000);
  expect(w.media.m.has('https://hub.example/media/s/old24')).toBe(false);
  expect(w.media.m.has('https://hub.example/media/s/old25')).toBe(true);
  expect(w.media.m.has('https://hub.example/media/s/new24')).toBe(true);
  // By bytes: 127 kept and 25 new of 512 KB are 76 MB; the 24 oldest go, leaving 64 MB.
  const big = pictures(() => served('image/png', 512 * 1024));
  for (let i = 0; i < 127; i++) big.media.m.set(`https://hub.example/media/s/big${i}`, served('image/png', 512 * 1024));
  for (let i = 0; i < 25; i++) await big.get(`/media/s/more${i}`);
  expect(big.media.m.size).toBe(128);
  expect(big.media.m.has('https://hub.example/media/s/big23')).toBe(false);
  expect(big.media.m.has('https://hub.example/media/s/big24')).toBe(true);
});

test('pictures fetched through an account that left go; the rest, and emoji, stay', async () => {
  const w = pictures();
  for (const p of ['/media/s/a?a=acc_1', '/media/s/b?a=acc_2', '/media/s/c?a=acc_2', '/media/s/d', '/emoji/discord/1']) await w.get(p);
  await w.message({ t: 'keepAccounts', ids: ['acc_1'] });
  expect([...w.media.m.keys()].map((u) => u.slice('https://hub.example'.length))).toEqual(['/media/s/a?a=acc_1', '/media/s/d', '/emoji/discord/1']);
});

test('a call ringing you (docs/calls.md): one per call, kept up, Answer opens the chat and Decline stops it everywhere', async () => {
  const w = worker();
  await w.push({ title: 'Ann is calling', body: 'Discord call. Answer or decline.', conversationId: 'cnv_1', call: { id: 'cll_1', tag: 'call:cll_1', canAnswer: true, canDecline: true } });
  expect(w.shown[0].o).toMatchObject({ tag: 'call:cll_1', requireInteraction: true, renotify: true });
  expect(actions(w)).toEqual(['answer', 'decline']);
  await w.click(w.shown[0].o.data, 'decline');
  expect(w.fetched.at(-1)).toMatchObject({ url: '/api/calls/cll_1/decline', method: 'POST' });
  expect(w.opened).toEqual([]);
  await w.click(w.shown[0].o.data, 'answer');
  expect(w.opened.at(-1)).toContain('/#/inbox/c/cnv_1');
  // Signal from here: no Answer, and Decline only where the account can.
  const sig = worker();
  await sig.push({ title: 'Ann is calling', conversationId: 'cnv_2', call: { id: 'cll_2', canAnswer: false, canDecline: false } });
  expect(actions(sig)).toEqual([]);
  expect(sig.shown[0].o.tag).toBe('call:cll_2');
});
