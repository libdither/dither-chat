/**
 * Sending with more than words (docs/sending.md): Send later's waits, holds and refusals (sendlater.ts), the send's
 * silent and no-ping flags passed only where the account says it can (server.ts), and saved messages, reminders,
 * previews off and a network's own scheduled messages through the routes (sendextras.ts) against the demo world's
 * Discord account run in process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { SEND_LATER_LATE_MS } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { type DueReminder } from '../src/saved.ts';
import { SendExtras } from '../src/sendextras.ts';
import { type LaterSend, SendLater } from '../src/sendlater.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-sending-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MIN = 60_000;

describe('Send later', () => {
  let store: Store;
  let later: SendLater;
  let t = Date.UTC(2026, 10, 12, 12);
  const clock = { now: () => t, setTimeout: () => 0, clearTimeout: () => {} };
  let online = true;
  let answer: () => Response = () => Response.json({ ok: true, accountId: 'x', messageId: 'msg_sent' });
  const sends: { cid: string; b: LaterSend }[] = [];
  const dropped: string[][] = [];
  const events: P.ClientEvent[] = [];
  let acc = '';
  let cid = '';

  beforeAll(() => {
    store = new Store(join(dir, 'later.sqlite'), mediaSigner('s'));
    const a = store.createAccount({ network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
    acc = a.id;
    store.ingest(a, { t: 'conversation', conversation: { nativeId: '100', shape: 'direct', participants: ['1', '2'] } });
    cid = hubId('cnv', 'discord', '100');
    later = new SendLater(store, {
      send: async (c, b) => (sends.push({ cid: c, b }), answer()),
      online: () => online,
      files: (ids) => (ids.includes('gone') ? null : ids.map((i) => `${i}.png`)),
      dropFiles: (ids) => dropped.push(ids),
      broadcast: (evs) => events.push(...evs),
      clock,
    });
  });
  afterAll(() => store.db.close());

  test('a time that is not ahead, or too far, is refused before anything is kept', () => {
    expect(() => later.create({ conversationId: cid, accountId: acc, body: 'x', dueAt: t - MIN })).toThrow('at least a minute');
    expect(() => later.create({ conversationId: cid, accountId: acc, body: 'x', dueAt: t + 400 * 24 * 60 * MIN })).toThrow('within a year');
    expect(() => later.create({ conversationId: cid, accountId: acc, body: ' ', dueAt: t + 10 * MIN })).toThrow('empty');
    expect(() => later.create({ conversationId: cid, accountId: acc, body: 'x', attachments: ['gone'], dueAt: t + 10 * MIN })).toThrow('expired');
    expect(later.list()).toEqual([]);
  });

  test('it goes out at its time through the send, once, under its own id, with its flags', async () => {
    const v = later.create({ conversationId: cid, accountId: acc, body: 'hello later', replyTo: 'msg_q', attachments: ['u1'], silent: true, mentionReplied: false, dueAt: t + 10 * MIN });
    expect(v).toMatchObject({ where: 'hub', state: 'waiting', files: ['u1.png'], silent: true, mentionReplied: false });
    expect(later.heldUploads().has('u1')).toBe(true);
    expect(events.at(-1)).toMatchObject({ t: 'scheduled' });
    await later.tick();
    expect(sends.length).toBe(0);
    t += 10 * MIN;
    await later.tick();
    expect(sends).toEqual([{ cid, b: { body: 'hello later', accountId: acc, clientId: v.id, replyTo: 'msg_q', attachments: ['u1'], silent: true, mentionReplied: false } }]);
    expect(later.get(v.id)).toMatchObject({ state: 'sent', messageId: 'msg_sent' });
    expect(later.heldUploads().has('u1')).toBe(false);
    await later.tick();
    expect(sends.length).toBe(1);
    // Gone from the list a while after.
    t += 11 * MIN;
    expect(later.list().find((x) => x.id === v.id)).toBeUndefined();
  });

  test('with its account away it waits and says so, and goes once it is back', async () => {
    const v = later.create({ conversationId: cid, accountId: acc, body: 'when you are back', dueAt: t + 5 * MIN });
    online = false;
    t += 5 * MIN;
    await later.tick();
    expect(later.get(v.id)).toMatchObject({ state: 'waiting', note: 'Waiting for Discord · main to connect' });
    online = true;
    t += 10 * MIN;
    await later.tick();
    expect(later.get(v.id)!.state).toBe('sent');
  });

  test('never sent more than a set time late without asking: held, then Send now sends it', async () => {
    const before = sends.length;
    const v = later.create({ conversationId: cid, accountId: acc, body: 'too late?', dueAt: t + 5 * MIN });
    online = false;
    t += 5 * MIN + SEND_LATER_LATE_MS + MIN;
    await later.tick();
    expect(later.get(v.id)!.state).toBe('held');
    expect(later.get(v.id)!.note).toContain('Send it now, or cancel it');
    online = true;
    await later.tick();
    expect(sends.length).toBe(before);
    expect(() => later.edit(v.id, { body: 'still too late' })).toThrow('pick a new time');
    expect((await later.sendNow(v.id)).state).toBe('sent');
    expect(sends.length).toBe(before + 1);
  });

  test('a refusal leaves it failed with the reason; a new time makes it wait again; cancel lets its files go', async () => {
    answer = () => Response.json({ error: 'Accept the message request first' }, { status: 409 });
    const v = later.create({ conversationId: cid, accountId: acc, body: 'refused', attachments: ['u2'], dueAt: t + 2 * MIN });
    t += 2 * MIN;
    await later.tick();
    expect(later.get(v.id)).toMatchObject({ state: 'failed', note: 'Accept the message request first' });
    expect(later.edit(v.id, { body: 'refused, again', dueAt: t + 3 * MIN })).toMatchObject({ state: 'waiting', note: null, body: 'refused, again' });
    later.cancel(v.id);
    expect(dropped.at(-1)).toEqual(['u2']);
    expect(later.get(v.id)).toBeNull();
    answer = () => Response.json({ ok: true, accountId: acc, messageId: 'msg_sent2' });
  });

  test('gone offline between the look and the send: it waits again rather than failing', async () => {
    answer = () => Response.json({ error: 'no connected account can send here' }, { status: 409 });
    const v = later.create({ conversationId: cid, accountId: acc, body: 'race', dueAt: t + 2 * MIN });
    t += 2 * MIN;
    await later.tick();
    expect(later.get(v.id)!.state).toBe('waiting');
    answer = () => Response.json({ ok: true, accountId: acc, messageId: 'msg_sent3' });
    later.cancel(v.id);
  });

  test('a restart in the middle of a send never sends it again by itself', () => {
    const v = later.create({ conversationId: cid, accountId: acc, body: 'mid-send', dueAt: t + 2 * MIN });
    store.db.query(`UPDATE send_later SET state = 'sending' WHERE id = ?`).run(v.id);
    const again = new SendLater(store, { send: async () => answer(), online: () => true, files: () => [], dropFiles: () => {}, broadcast: () => {}, clock });
    expect(again.get(v.id)).toMatchObject({ state: 'failed' });
    expect(again.get(v.id)!.note).toContain('may have been sent');
  });
});

describe('the send passes silent and no-ping only where the account can', () => {
  const sent: any[] = [];
  let hub: HubServer;
  let store: Store;
  let port = 0;
  let dc = '';
  const send = (conv: string, body: unknown) => fetch(`http://127.0.0.1:${port}/api/conversations/${conv}/send`, { method: 'POST', body: JSON.stringify(body) });

  beforeAll(() => {
    store = new Store(join(dir, 'flags.sqlite'), mediaSigner('s'));
    const sup = { authorize: () => null, online: () => true, command: async (_: string, c: any) => (sent.push(c), { nativeId: 'x' }) } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: join(dir, 'flags'), webDist: dir, secret: 's' });
    port = hub.start().port!;
    const a = store.createAccount({ network: 'discord', label: 'dc', color: '#000', adapter: 'discord' });
    store.ingest(a, { t: 'hello', network: 'discord', version: '1', capabilities: ['send'] });
    store.ingest(a, { t: 'status', status: 'online', self: { nativeId: '1', isSelf: true } });
    store.ingest(a, { t: 'conversation', conversation: { nativeId: '200', shape: 'group', name: 'g', participants: ['1', '2'] } });
    store.ingest(a, { t: 'message', message: { nativeId: '300', conversation: '200', author: '2', ts: Date.now(), body: 'q' } });
    dc = hubId('cnv', 'discord', '200');
  });
  afterAll(() => {
    hub.stop();
    store.db.close();
  });

  test('without the capabilities: refused, and the adapter is never asked', async () => {
    const r1 = await send(dc, { body: 'shh', silent: true });
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as any).error).toContain('cannot send silently');
    const r2 = await send(dc, { body: 'no ping', replyTo: hubId('msg', 'discord', '300'), mentionReplied: false });
    expect(r2.status).toBe(409);
    expect(sent.length).toBe(0);
    // A plain send carries neither.
    expect((await send(dc, { body: 'plain', replyTo: hubId('msg', 'discord', '300'), mentionReplied: true })).status).toBe(200);
    expect(sent.at(-1).silent).toBeUndefined();
    expect(sent.at(-1).mentionReplied).toBeUndefined();
  });

  test('with them: both go to the adapter; no-ping only on a reply', async () => {
    const a = store.accounts()[0];
    store.ingest(a, { t: 'hello', network: 'discord', version: '1', capabilities: ['send', 'silentSend', 'replyMention'] });
    expect((await send(dc, { body: 'shh', silent: true, replyTo: hubId('msg', 'discord', '300'), mentionReplied: false })).status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ t: 'send', body: 'shh', replyTo: '300', silent: true, mentionReplied: false });
    expect((await send(dc, { body: 'not a reply', mentionReplied: false })).status).toBe(200);
    expect(sent.at(-1).mentionReplied).toBeUndefined();
  });

  test('Send later through the route: a chat or a conversation, its account picked now, refusals as words', async () => {
    const post = (b: unknown) => fetch(`http://127.0.0.1:${port}/api/scheduled`, { method: 'POST', body: JSON.stringify(b) });
    const r = await post({ conversationId: dc, body: 'later', dueAt: Date.now() + 10 * MIN, silent: true });
    expect(r.status).toBe(200);
    const v = (await r.json()) as P.ScheduledSendView;
    expect(v).toMatchObject({ where: 'hub', conversationId: dc, accountId: store.accounts()[0].id, silent: true, state: 'waiting' });
    const bad = await post({ conversationId: dc, body: 'later', dueAt: Date.now() - 1 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain('at least a minute');
    const list = (await (await fetch(`http://127.0.0.1:${port}/api/scheduled`)).json()) as { items: P.ScheduledSendView[] };
    expect(list.items.map((x) => x.id)).toEqual([v.id]);
    const del = await fetch(`http://127.0.0.1:${port}/api/scheduled/${v.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
  });
});

describe('saved on the network, reminders, previews off, its own scheduled messages (demo Discord)', () => {
  const dd = join(dir, 'demo');
  let store: Store;
  let extras: SendExtras;
  const adapters = new Map<string, { command: (c: P.AdapterCommand) => void; stop(): void }>();
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const due: DueReminder[] = [];
  const MAIN = 'acc_demo-discord-main';

  const req = (method: string, path: string, body?: unknown) =>
    extras.route(new Request(`http://hub${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), new URL(`http://hub${path}`), path.split('?')[0]).then(async (r) => ({ status: r!.status, body: (await r!.json()) as any }));

  beforeAll(() => {
    mkdirSync(dd, { recursive: true });
    store = new Store(join(dd, 'hub.sqlite'), mediaSigner('s'));
    store.reminderDue = (r) => due.push(r);
    store.db.transaction(() => {
      for (const acc of createDemoAccounts(store)) {
        const adir = join(dd, acc.id);
        mkdirSync(adir, { recursive: true });
        const a = demoFactory(acc, adir)! as unknown as { command: (c: P.AdapterCommand) => void; stop(): void; start(e: (ev: P.AdapterEvent) => void): void };
        adapters.set(acc.id, a);
        a.start((ev) => {
          if (ev.t === 'reply') {
            const p = pending.get(ev.id);
            pending.delete(ev.id);
            if (ev.ok) p?.resolve(ev.result);
            else p?.reject(new Error(ev.error));
            return;
          }
          store.ingest(store.account(acc.id)!, ev);
        });
      }
    })();
    store.flush();
    extras = new SendExtras({
      store,
      online: () => true,
      command: <T>(account: string, cmd: any) =>
        new Promise<T>((resolve, reject) => {
          const id = crypto.randomUUID();
          pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
          adapters.get(account)!.command({ ...cmd, id });
        }),
      send: async () => Response.json({ ok: true }),
      chatRoute: () => 'no chats here',
      pickAccount: (c, requested) => {
        const vs = store.vantageAccounts('conversation', c);
        return requested && vs.includes(requested) ? requested : (vs.find((a) => a === MAIN) ?? vs[0] ?? null);
      },
      files: () => [],
      dropFiles: () => {},
      broadcast: () => {},
      flush: () => store.flush(),
      messages: (ids) => {
        const views = store.messageViews(store.raw(`SELECT * FROM message WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)));
        return { messages: views, identities: store.identitiesOf(views) };
      },
    });
  });
  afterAll(() => {
    for (const a of adapters.values()) a.stop();
    store.db.close();
  });

  const someMessage = (own: boolean) => {
    const self = store.account(MAIN)!.self_identity;
    const r = store.one<{ id: string }>(
      `SELECT m.id FROM message m JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = m.conversation_id AND v.account_id = ? WHERE m.network = 'discord' AND m.author_id ${own ? '=' : '!='} ? ORDER BY m.ts DESC LIMIT 1`,
      MAIN,
      self,
    );
    if (!r) throw new Error('no message');
    return r.id;
  };

  test('save with a reminder, list it fresh with its message, then remove it', async () => {
    const mid = someMessage(false);
    const dueAt = Date.now() + 60 * MIN;
    const saved = await req('POST', `/api/messages/${mid}/save`, { dueAt });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ accountId: MAIN, messageId: mid, dueAt });
    const page = await req('GET', '/api/saved?fresh=1');
    expect(page.body.saved.map((s: P.SavedView) => s.messageId)).toEqual([mid]);
    expect(page.body.messages.map((m: P.MessageView) => m.id)).toEqual([mid]);
    expect(page.body.errors).toEqual([]);
    expect((await req('POST', `/api/messages/${mid}/save`, { remove: true })).status).toBe(200);
    expect((await req('GET', '/api/saved')).body.saved).toEqual([]);
  });

  test('a reminder that comes due on the network is handed on to notify', () => {
    const acc = store.account(MAIN)!;
    store.ingest(acc, { t: 'reminderDue', saved: { conversation: '1', message: '424242', savedAt: 1, dueAt: 2, summary: { author: 'Kai', text: 'call me' } } });
    expect(due.at(-1)).toMatchObject({ accountId: MAIN, messageId: hubId('msg', 'discord', '424242'), dueAt: 2 });
  });

  test('previews come off your own message only', async () => {
    expect((await req('POST', `/api/messages/${someMessage(false)}/remove-previews`)).status).toBe(403);
    expect((await req('POST', `/api/messages/${someMessage(true)}/remove-previews`)).status).toBe(200);
  });

  test("the network's own scheduled messages sit beside the hub's, and can be cancelled", async () => {
    const list = (await req('GET', '/api/scheduled?network=1')).body.items as P.ScheduledSendView[];
    const native = list.filter((x) => x.where === 'network');
    expect(native.length).toBeGreaterThan(0);
    expect(native[0]).toMatchObject({ accountId: MAIN, body: 'Happy birthday! 🎂' });
    expect((await req('DELETE', `/api/scheduled/${native[0].id}`)).status).toBe(200);
    const again = (await req('GET', '/api/scheduled?network=1')).body.items as P.ScheduledSendView[];
    expect(again.filter((x) => x.where === 'network' && x.accountId === MAIN)).toEqual([]);
  });

  test('silent is refused for an account that cannot, before it is kept', async () => {
    const sig = store.accounts().find((a) => a.network === 'signal')!;
    const conv = store.one<{ target_id: string }>(`SELECT target_id FROM vantage WHERE account_id = ? AND target_kind = 'conversation' LIMIT 1`, sig.id)!.target_id;
    const r = await req('POST', '/api/scheduled', { conversationId: conv, accountId: sig.id, body: 'x', silent: true, dueAt: Date.now() + 10 * MIN });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('cannot send silently');
  });
});
