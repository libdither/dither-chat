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
    fetched.push({ url, body: JSON.parse(init.body), method: init.method });
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

  const digest = worker();
  await digest.push({ title: 't', inbox: true });
  expect(actions(digest)).toEqual([]);
  expect(digest.shown[0].o.tag).toBe('dither-digest');
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
  for (const p of ['/api/bootstrap', '/media/x/y', '/ca.crt', '/voice/dave/0123456789abcdef/libdave.mjs']) expect(await s.get(p)).toBeNull();
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

test('votes come first: Important down to Active or right; Active up to Important or down to the digest', async () => {
  const loud = worker();
  await loud.push({ title: 't', conversationId: 'cnv_1', messageId: 'msg_1', level: 'push' });
  expect(actions(loud).slice(0, 2)).toEqual(['down', 'up']);
  const quiet = worker();
  await quiet.push({ title: 't', conversationId: 'cnv_1', messageId: 'msg_1', level: 'quiet' });
  expect(quiet.shown[0].o.actions.slice(0, 2).map((a: any) => a.title)).toEqual(['▲ Important', '▼ Digest']);
});
