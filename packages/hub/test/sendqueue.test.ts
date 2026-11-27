/**
 * The send queue (sendqueue.ts, docs/sync.md "The send queue"): order within a chat, a repeat after a restart, a
 * restart mid-send, a held or in-doubt head blocking what is behind it, holds when the chat moved on, the countdown
 * while a device watches, and the answer older callers still get. A real hub over HTTP and its live socket, with a fake
 * account whose sends the test answers by hand, and a FakeClock for the countdown.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { FakeClock } from './fixtures/clock.ts';
import { memTempDir } from './fixtures/memdir.ts';

const dir = memTempDir('dither-sendq-');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A send the fake account was asked to make, to answer when the test says. */
interface Call {
  body: string;
  answer: (nativeId?: string) => void;
  fail: (e: Error) => void;
}

const lost = (code: string, message: string) => Object.assign(new Error(message), { code });

let worlds = 0;
/** A hub on a fresh store, whose account answers sends by hand (`auto` answers each at once, with an echo). */
function world() {
  const n = ++worlds;
  const store = new Store(':memory:', mediaSigner('s'));
  const clock = new FakeClock(1_000_000);
  const calls: Call[] = [];
  const callWaiters: (() => void)[] = [];
  const told: { title: string; body: string; conversationId: string }[] = [];
  let auto = true;
  let ts = 10_000;
  let native = 0;
  const sup = {
    authorize: () => null,
    online: () => true,
    command: (_id: string, c: any) => {
      if (c.t !== 'send') return Promise.resolve({});
      return new Promise((resolve, reject) => {
        const call: Call = {
          body: c.body,
          answer: (nativeId = `out-${++native}`) => {
            // The network's echo, as an adapter sends it after a send.
            message(nativeId, 'me', c.body);
            resolve({ nativeId });
          },
          fail: reject,
        };
        calls.push(call);
        for (const w of callWaiters.splice(0)) w();
        if (auto) call.answer();
      });
    },
    created: async () => {},
  } as any;
  const acc: AccountRow = store.createAccount({ network: 'discord', label: 'x', color: '#000', adapter: 'discord' });
  store.ingest(acc, { t: 'hello', network: 'discord', version: '1', capabilities: ['send'], self: { nativeId: 'me', name: 'Me' } });
  store.ingest(acc, { t: 'status', status: 'online' });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'c', shape: 'group', name: 'Chat' } });
  const conv = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'c'`)!.id;
  /** A message into the chat; its hub id. */
  const message = (nativeId: string, author: string, body: string) => {
    store.ingest(acc, { t: 'message', live: true, message: { nativeId, conversation: 'c', author, ts: (ts += 1000), body } });
    return store.one<{ id: string; ts: number }>(`SELECT id, ts FROM message WHERE native_id = ?`, nativeId)!;
  };
  let hub: HubServer;
  let url = '';
  const sockets: WebSocket[] = [];
  const open = () => {
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: join(dir, `w${n}`), webDist: dir, open: true, secret: 's', clock, onSendHeld: (t) => told.push(t) });
    url = `http://127.0.0.1:${hub.start().port}`;
  };
  open();
  const w = {
    store,
    clock,
    calls,
    told,
    conv,
    message,
    get hub() {
      return hub;
    },
    get url() {
      return url;
    },
    set auto(on: boolean) {
      auto = on;
    },
    /** The next time the account is asked to send: once `calls` has `count` of them. */
    callCount: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => (calls.length >= count ? resolve() : callWaiters.push(check));
        check();
      }),
    send: (b: Record<string, unknown>) => fetch(`${url}/api/conversations/${conv}/send`, { method: 'POST', body: JSON.stringify(b) }),
    act: (clientId: string, action: P.SendAction['action']) => fetch(`${url}/api/sends/${clientId}`, { method: 'POST', body: JSON.stringify({ action }) }),
    row: (clientId: string) => hub.queue.get(clientId)!,
    /** A hub stopped and a new one started over the same store, as a restart. */
    restart() {
      // The hub stops first, closing its sockets, as a real restart does.
      w.stop();
      w.start();
    },
    /** The two halves of a restart, for what happens between them. */
    stop() {
      hub.stop();
      sockets.splice(0);
    },
    start: () => open(),
    /** What /api/sync answers a page that last saw the journal at `from`. */
    sync: async (from: { v: number; epoch: string; seq: number }) =>
      (await (await fetch(`${url}/api/sync`, { method: 'POST', body: JSON.stringify({ v: from.v, epoch: from.epoch, since: from.seq, timelines: [] } satisfies P.SyncRequest) })).json()) as P.SyncResponse,
    /** A page's live socket, with the `sends` frames it got. */
    async socket() {
      const ws = new WebSocket(`${url.replace('http', 'ws')}/api/live`);
      sockets.push(ws);
      const frames: P.SendRow[][] = [];
      const waiters: (() => void)[] = [];
      const pongs: (() => void)[] = [];
      ws.onmessage = (e) => {
        if (e.data === 'pong') return void pongs.shift()?.();
        if (typeof e.data !== 'string') return;
        for (const ev of JSON.parse(e.data) as P.ClientEvent[]) if (ev.t === 'sends') frames.push(ev.rows);
        for (const f of waiters.splice(0)) f();
      };
      await new Promise((r) => (ws.onopen = r));
      return {
        ws,
        /**
         * Says it shows these chats at their newest message (P.ClientWatching). Resolves once the hub has taken it in:
         * a ping after it is answered after it.
         */
        watch: (ids: string[]) => {
          ws.send(JSON.stringify({ t: 'watching', label: 'Computer', conversationIds: ids } satisfies P.ClientWatching));
          ws.send('ping');
          return new Promise<void>((r) => pongs.push(r));
        },
        /** The first `sends` frame from now on whose rows pass `f`. */
        frame: (f: (rows: P.SendRow[]) => boolean) =>
          new Promise<P.SendRow[]>((resolve) => {
            const from = frames.length;
            const check = () => {
              const hit = frames.slice(from).find(f);
              if (hit) resolve(hit);
              else waiters.push(check);
            };
            check();
          }),
      };
    },
    close() {
      for (const s of sockets.splice(0)) s.close();
      hub.stop();
    },
  };
  return w;
}

let current: ReturnType<typeof world> | null = null;
const fresh = () => (current = world());
afterEach(() => {
  current?.close();
  current = null;
});

const byId = (rows: P.SendRow[], id: string) => rows.find((r) => r.clientId === id);

describe('order and keeping', () => {
  test('two sends in a chat go in order: the second waits while the first is slow', async () => {
    const w = fresh();
    w.auto = false;
    const a = (await (await w.send({ body: 'first', clientId: 'a', ack: 'hub' })).json()) as P.SendAccepted;
    expect(a.row.state).toBe('queued');
    const b = (await (await w.send({ body: 'second', clientId: 'b', ack: 'hub' })).json()) as P.SendAccepted;
    expect(b.row.state).toBe('queued');
    await w.callCount(1);
    expect(w.calls.map((c) => c.body)).toEqual(['first']);
    expect(w.row('a').state).toBe('sending');
    expect(w.row('b').state).toBe('queued');
    w.calls[0].answer();
    await w.callCount(2);
    expect(w.calls.map((c) => c.body)).toEqual(['first', 'second']);
    w.calls[1].answer();
    await w.hub.queue.settled('b');
    expect(w.row('a')).toMatchObject({ state: 'sent', messageId: expect.stringMatching(/^msg_/) });
    expect(w.row('b').state).toBe('sent');
  });

  test('a repeat of a send after a restart is the same send: answered, not sent again', async () => {
    const w = fresh();
    const first = await w.send({ body: 'once', clientId: 'r1' });
    expect(first.status).toBe(200);
    const { messageId } = (await first.json()) as P.SendResult;
    w.restart();
    const again = await w.send({ body: 'once', clientId: 'r1' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as P.SendResult).messageId).toBe(messageId!);
    const hubAck = (await (await w.send({ body: 'once', clientId: 'r1', ack: 'hub' })).json()) as P.SendAccepted;
    expect(hubAck.row.state).toBe('sent');
    expect(w.calls.length).toBe(1);
  });

  test('a restart while a send is with the account leaves it in doubt, not sent again', async () => {
    const w = fresh();
    w.auto = false;
    await w.send({ body: 'cut off', clientId: 'cut', ack: 'hub' });
    await w.callCount(1);
    w.restart();
    expect(w.row('cut')).toMatchObject({ state: 'unsure', error: expect.stringContaining('restarted') });
    const repeat = await w.send({ body: 'cut off', clientId: 'cut' });
    expect(repeat.status).toBe(504);
    expect(w.calls.length).toBe(1);
  });

  test('a page that catches up after the restart gets the send in doubt, though nothing was journaled since', async () => {
    const w = fresh();
    w.auto = false;
    await w.send({ body: 'cut off', clientId: 'cut', ack: 'hub' });
    await w.callCount(1);
    const from = w.store.journal.position();
    w.restart();
    const r = await w.sync(from);
    if (r.full) throw new Error(`a full bootstrap: ${r.reason}`);
    const sends = r.events.find((e): e is Extract<P.ClientEvent, { t: 'sends' }> => e.t === 'sends');
    expect(byId(sends!.rows, 'cut')?.state).toBe('unsure');
  });

  test('an answer that comes while the hub stops is kept: the send is sent, not in doubt', async () => {
    const w = fresh();
    w.auto = false;
    await w.send({ body: 'late answer', clientId: 'late', ack: 'hub' });
    await w.callCount(1);
    const before = w.hub.queue;
    w.stop();
    w.calls[0].answer();
    await before.settled('late');
    w.start();
    expect(w.row('late').state).toBe('sent');
  });

  test('queued sends go after a restart', async () => {
    const w = fresh();
    w.auto = false;
    await w.send({ body: 'head', clientId: 'h', ack: 'hub' });
    await w.callCount(1);
    await w.send({ body: 'behind', clientId: 'q', ack: 'hub' });
    w.restart();
    // The head is in doubt now and holds up the one behind it, until you say.
    expect(w.row('h').state).toBe('unsure');
    expect(w.row('q').state).toBe('queued');
    expect(w.hub.queue.blockedBy(w.conv, w.row('q').seq)?.clientId).toBe('h');
    w.auto = true;
    await w.act('h', 'cancel');
    await w.hub.queue.settled('q');
    expect(w.row('q').state).toBe('sent');
    expect(w.calls.map((c) => c.body)).toEqual(['head', 'behind']);
  });

  test('a head in doubt blocks the sends behind it; Send again sends it, then them', async () => {
    const w = fresh();
    w.auto = false;
    await w.send({ body: 'doubt', clientId: 'd', ack: 'hub' });
    await w.callCount(1);
    w.calls[0].fail(lost('timeout', 'the manager did not answer'));
    await w.hub.queue.settled('d');
    expect(w.row('d').state).toBe('unsure');
    // An older caller behind it is told the hub has it (202), not left waiting.
    const behind = await w.send({ body: 'behind' });
    expect(behind.status).toBe(202);
    const row = ((await behind.json()) as P.SendAccepted).row;
    expect(row.state).toBe('queued');
    expect(w.calls.length).toBe(1);
    w.auto = true;
    expect((await w.act('d', 'send')).status).toBe(200);
    await w.hub.queue.settled(row.clientId);
    expect(w.calls.map((c) => c.body)).toEqual(['doubt', 'doubt', 'behind']);
  });

  test('a refused head does not block: nothing went out, so the next goes', async () => {
    const w = fresh();
    w.auto = false;
    await w.send({ body: 'no', clientId: 'no', ack: 'hub' });
    await w.send({ body: 'yes', clientId: 'yes', ack: 'hub' });
    await w.callCount(1);
    w.calls[0].fail(lost('offline', 'the account is not connected'));
    await w.callCount(2);
    w.calls[1].answer();
    await w.hub.queue.settled('yes');
    expect(w.row('no')).toMatchObject({ state: 'failed', error: 'the account is not connected' });
    expect(w.row('yes').state).toBe('sent');
  });

  test('a repeat of a refused send is answered with the refusal, not sent again; Try again sends it', async () => {
    const w = fresh();
    w.auto = false;
    await w.send({ body: 'refused', clientId: 'f', ack: 'hub' });
    await w.callCount(1);
    // An error the hub cannot read: it may hide one that went out, so only you send it again.
    w.calls[0].fail(new Error('socket hang up'));
    await w.hub.queue.settled('f');
    expect(w.row('f').state).toBe('failed');
    const repeat = (await (await w.send({ body: 'refused', clientId: 'f', ack: 'hub' })).json()) as P.SendAccepted;
    expect(repeat.row.state).toBe('failed');
    expect(w.calls.length).toBe(1);
    w.auto = true;
    await w.act('f', 'send');
    await w.hub.queue.settled('f');
    expect(w.row('f').state).toBe('sent');
    expect(w.calls.length).toBe(2);
  });
});

describe('held when the chat moved on', () => {
  test('a message after what you saw holds it at once; the sends behind it wait with it', async () => {
    const w = fresh();
    const seen = w.message('m1', 'bob', 'hi');
    w.message('m2', 'bob', 'actually, wait');
    const a = (await (await w.send({ body: 'sure', clientId: 'a', ack: 'hub', seenUpTo: seen, device: 'dev1' })).json()) as P.SendAccepted;
    expect(a.row).toMatchObject({ state: 'held', hold: { count: 1 }, holdUntil: null });
    // Without seenUpTo it is never held, but it waits behind the held one.
    const b = await w.send({ body: 'and this', clientId: 'b' });
    expect(b.status).toBe(202);
    expect(w.row('b').state).toBe('queued');
    expect(w.calls.length).toBe(0);
    // Nobody watches the chat: you are told it waits.
    expect(w.told).toEqual([expect.objectContaining({ conversationId: w.conv, title: expect.stringContaining('waiting') })]);
    await w.act('a', 'cancel');
    await w.hub.queue.settled('b');
    expect(w.row('a').state).toBe('cancelled');
    expect(w.calls.map((c) => c.body)).toEqual(['and this']);
  });

  test("held right before it goes when someone wrote while it waited; this device's own earlier send is not news", async () => {
    const w = fresh();
    w.auto = false;
    const seen = w.message('m1', 'bob', 'hi');
    await w.send({ body: 'one', clientId: 'x', ack: 'hub', seenUpTo: seen, device: 'dev1' });
    await w.send({ body: 'two', clientId: 'a', ack: 'hub', seenUpTo: seen, device: 'dev1' });
    await w.callCount(1);
    w.message('m2', 'bob', 'new thought');
    w.calls[0].answer();
    await w.hub.queue.settled('a');
    // Its echo came too, and is this queue's own: only bob's counts.
    expect(w.row('a')).toMatchObject({ state: 'held', hold: { count: 1, ids: [w.store.one<{ id: string }>(`SELECT id FROM message WHERE native_id = 'm2'`)!.id] } });
    expect(w.calls.length).toBe(1);
  });

  test('no hold when only its own earlier sends came in', async () => {
    const w = fresh();
    w.auto = false;
    const seen = w.message('m1', 'bob', 'hi');
    await w.send({ body: 'one', clientId: 'x', ack: 'hub', seenUpTo: seen, device: 'dev1' });
    await w.send({ body: 'two', clientId: 'a', ack: 'hub', seenUpTo: seen, device: 'dev1' });
    await w.callCount(1);
    w.calls[0].answer();
    await w.callCount(2);
    w.calls[1].answer();
    await w.hub.queue.settled('a');
    expect(w.row('a').state).toBe('sent');
  });

  test('your own message from another device (or another app) counts', async () => {
    const w = fresh();
    w.auto = false;
    const seen = w.message('m1', 'bob', 'hi');
    await w.send({ body: 'one', clientId: 'x', ack: 'hub', seenUpTo: seen, device: 'dev1' });
    await w.send({ body: 'two', clientId: 'a', ack: 'hub', seenUpTo: seen, device: 'dev1' });
    await w.callCount(1);
    // Written on the phone's own Discord app meanwhile.
    w.message('m-phone', 'me', 'said it there already');
    w.calls[0].answer();
    await w.hub.queue.settled('a');
    expect(w.row('a')).toMatchObject({ state: 'held', hold: { count: 1 } });
  });

  test("another device's send through the hub counts too", async () => {
    const w = fresh();
    w.auto = false;
    const seen = w.message('m1', 'bob', 'hi');
    await w.send({ body: 'from the phone', clientId: 'p', ack: 'hub', seenUpTo: seen, device: 'phone' });
    await w.send({ body: 'from the laptop', clientId: 'l', ack: 'hub', seenUpTo: seen, device: 'laptop' });
    await w.callCount(1);
    w.calls[0].answer();
    await w.hub.queue.settled('l');
    expect(w.row('l')).toMatchObject({ state: 'held', hold: { count: 1 } });
  });

  test('a message the hub already had that only got a later time is not news', async () => {
    const w = fresh();
    w.message('old', 'bob', 'from before');
    const seen = w.message('m1', 'bob', 'hi');
    // The same message again, dated later (a demo world dated again at its start).
    w.message('old', 'bob', 'from before');
    const a = (await (await w.send({ body: 'fine', clientId: 'a', ack: 'hub', seenUpTo: seen })).json()) as P.SendAccepted;
    expect(a.row.state).not.toBe('held');
    await w.hub.queue.settled('a');
    expect(w.row('a').state).toBe('sent');
  });

  test('Edit cancels it and gives its text back; Send sends it as it is', async () => {
    const w = fresh();
    const seen = w.message('m1', 'bob', 'hi');
    w.message('m2', 'bob', 'more');
    await w.send({ body: 'to change', clientId: 'e', ack: 'hub', seenUpTo: seen });
    await w.send({ body: 'as it is', clientId: 's', ack: 'hub', seenUpTo: seen });
    const edited = (await (await w.act('e', 'edit')).json()) as P.SendRow;
    expect(edited).toMatchObject({ state: 'cancelled', body: 'to change' });
    // The one behind was held on its own account too: Send sends it, unchecked.
    expect(w.row('s').state).toBe('held');
    expect((await w.act('s', 'send')).status).toBe(200);
    await w.hub.queue.settled('s');
    expect(w.row('s').state).toBe('sent');
    expect(w.calls.map((c) => c.body)).toEqual(['as it is']);
    expect((await w.act('s', 'cancel')).status).toBe(409);
  });
});

describe('the countdown', () => {
  /** A chat where a send is held at once. */
  async function held(w: ReturnType<typeof world>, clientId: string) {
    const seen = w.message(`seen-${clientId}`, 'bob', 'hi');
    w.message(`new-${clientId}`, 'bob', 'more');
    await w.send({ body: `held ${clientId}`, clientId, ack: 'hub', seenUpTo: seen });
  }

  test('only while a device shows the chat; it goes at the end, by the hub clock', async () => {
    const w = fresh();
    await held(w, 'h');
    expect(w.row('h').holdUntil).toBeNull();
    const page = await w.socket();
    const started = page.frame((rows) => byId(rows, 'h')?.holdUntil != null);
    await page.watch([w.conv]);
    expect(byId(await started, 'h')!.holdUntil).toBe(w.clock.now() + 10_000);
    await w.clock.advance(9_999);
    expect(w.row('h').state).toBe('held');
    expect(w.calls.length).toBe(0);
    await w.clock.advance(1);
    await w.hub.queue.settled('h');
    expect(w.row('h').state).toBe('sent');
    expect(w.calls.length).toBe(1);
  });

  test('stops when no device shows the chat any more: nothing goes, and you are told', async () => {
    const w = fresh();
    const page = await w.socket();
    await page.watch([w.conv]);
    const started = page.frame((rows) => byId(rows, 'h')?.holdUntil != null);
    await held(w, 'h');
    await started;
    expect(w.told).toEqual([]);
    const stopped = page.frame((rows) => byId(rows, 'h')?.holdUntil === null);
    await page.watch([]);
    await stopped;
    await w.clock.advance(60_000);
    expect(w.row('h').state).toBe('held');
    expect(w.calls.length).toBe(0);
    expect(w.told.length).toBe(1);
  });

  test('survives a restart, and goes at the same time once a device shows the chat again', async () => {
    const w = fresh();
    const page = await w.socket();
    await page.watch([w.conv]);
    const started = page.frame((rows) => byId(rows, 'h')?.holdUntil != null);
    await held(w, 'h');
    const until = byId(await started, 'h')!.holdUntil!;
    await w.clock.advance(4_000);
    w.restart();
    expect(w.row('h')).toMatchObject({ state: 'held', holdUntil: until });
    const again = await w.socket();
    // The page says again what it shows; the countdown is the one from before, not a new one.
    await again.watch([w.conv]);
    expect(w.row('h').holdUntil).toBe(until);
    await w.clock.advance(until - w.clock.now() - 1);
    expect(w.row('h').state).toBe('held');
    await w.clock.advance(1);
    await w.hub.queue.settled('h');
    expect(w.row('h').state).toBe('sent');
  });

  test('one that ran out while the hub was down counts down again from the start, and nobody is told meanwhile', async () => {
    const w = fresh();
    const page = await w.socket();
    await page.watch([w.conv]);
    const started = page.frame((rows) => byId(rows, 'h')?.holdUntil != null);
    await held(w, 'h');
    await started;
    w.stop();
    await w.clock.advance(60_000);
    w.start();
    expect(w.row('h')).toMatchObject({ state: 'held', holdUntil: w.clock.now() + 10_000 });
    expect(w.told).toEqual([]);
    const again = await w.socket();
    await again.watch([w.conv]);
    await w.clock.advance(10_000);
    await w.hub.queue.settled('h');
    expect(w.row('h').state).toBe('sent');
    expect(w.told).toEqual([]);
  });

  test('Cancel and Send now stop it', async () => {
    const w = fresh();
    const page = await w.socket();
    await page.watch([w.conv]);
    const both = page.frame((rows) => byId(rows, 'c')?.holdUntil != null && byId(rows, 'n')?.holdUntil != null);
    await held(w, 'c');
    await held(w, 'n');
    await both;
    await w.act('c', 'cancel');
    expect(w.row('c')).toMatchObject({ state: 'cancelled', holdUntil: null });
    await w.act('n', 'send');
    await w.hub.queue.settled('n');
    expect(w.row('n').state).toBe('sent');
    await w.clock.advance(20_000);
    expect(w.calls.map((c) => c.body)).toEqual(['held n']);
  });

  test('0 seconds: no countdown, it waits for you even while watched', async () => {
    const w = fresh();
    const set = await fetch(`${w.url}/api/send-settings`, { method: 'PUT', body: JSON.stringify({ holdSeconds: 0 }) });
    expect(await set.json()).toEqual({ holdSeconds: 0 });
    const page = await w.socket();
    await page.watch([w.conv]);
    const shown = page.frame((rows) => byId(rows, 'z')?.state === 'held');
    await held(w, 'z');
    expect(byId(await shown, 'z')!.holdUntil).toBeNull();
    await w.clock.advance(60_000);
    expect(w.row('z').state).toBe('held');
    const bad = await fetch(`${w.url}/api/send-settings`, { method: 'PUT', body: JSON.stringify({ holdSeconds: 121 }) });
    expect(bad.status).toBe(400);
  });
});

describe('callers from before the queue', () => {
  test('no ack and no clientId: answered after the network, as before, with the message id', async () => {
    const w = fresh();
    const res = await w.send({ body: 'from a notification' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, messageId: expect.stringMatching(/^msg_/) });
  });

  test('a notification reply that names the message it answers is held when more came after it', async () => {
    const w = fresh();
    const notified = w.message('m1', 'bob', 'dinner?');
    w.message('m2', 'bob', 'never mind');
    // As sw.js sends it: no clientId, no time, only the notified message's id.
    const res = await w.send({ body: 'yes!', seenUpTo: { id: notified.id } });
    expect(res.status).toBe(202);
    expect(((await res.json()) as P.SendAccepted).row).toMatchObject({ state: 'held', hold: { count: 1 } });
    expect(w.calls.length).toBe(0);
    // The notification says so itself: the hub sends none of its own.
    expect(w.told).toEqual([]);
  });

  test('a notification reply to the newest message goes as before', async () => {
    const w = fresh();
    const notified = w.message('m1', 'bob', 'dinner?');
    const res = await w.send({ body: 'yes!', seenUpTo: { id: notified.id } });
    expect(res.status).toBe(200);
    expect(w.calls.map((c) => c.body)).toEqual(['yes!']);
  });

  test('a send with nothing in it, or files the hub no longer has, makes no row', async () => {
    const w = fresh();
    expect((await w.send({ body: '  ', clientId: 'empty', ack: 'hub' })).status).toBe(400);
    expect((await w.send({ body: 'x', attachments: ['gone'], clientId: 'files', ack: 'hub' })).status).toBe(410);
    expect(w.hub.queue.get('empty')).toBeNull();
    expect(w.hub.queue.get('files')).toBeNull();
  });

  test('every device gets the rows: in the bootstrap and on the socket', async () => {
    const w = fresh();
    w.auto = false;
    const page = await w.socket();
    const queued = page.frame((rows) => byId(rows, 'k')?.state === 'queued');
    await w.send({ body: 'shared', clientId: 'k', ack: 'hub' });
    await queued;
    const boot = (await (await fetch(`${w.url}/api/bootstrap`)).json()) as P.Bootstrap;
    expect(byId(boot.sends!.rows, 'k')).toMatchObject({ body: 'shared', conversationId: w.conv });
    await w.callCount(1);
    const sent = page.frame((rows) => byId(rows, 'k')?.state === 'sent');
    w.calls[0].answer();
    expect(byId(await sent, 'k')!.messageId).toMatch(/^msg_/);
  });
});
