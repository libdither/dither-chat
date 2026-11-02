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
  return { shown, closed, fetched, opened, push, click };
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
