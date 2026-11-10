/**
 * Budgets for what the hub sends the web app (docs/perf.md "Budgets"): bytes and rows of a cold start, a conversation's
 * first and an older page, the inbox, and what the live socket and a relaunch's sync carry for one arriving message.
 *
 * A small world from scripts/perf-world.ts (a fixed seed, at a fixed time with the clock stopped), a hub wired like
 * main.ts's for what it sends, and the same HTTP and socket paths the web app uses, in the order it uses them on a cold
 * start (state.ts connect and bootstrap, devices.ts, activity.ts, history.ts, usage.ts, App.tsx). Sizes and counts only:
 * the same on every run. Over a budget fails; `bun scripts/budgets.ts --update` writes new ones
 * (scripts/budgets.ts).
 *
 * Left out: mail's rows in the inbox and its people (their folding runs on timers), and the demo adapters' own world.
 */
import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { checkBudgets, type Measure } from '../../../scripts/budgets.ts';
import { seedWorld, type World } from '../../../scripts/perf-world.ts';
import { ActivityStore } from '../src/activity.ts';
import { Attention } from '../src/attention.ts';
import { DEMO_MAIL_ACCOUNT, seedDemoMail } from '../src/demo.ts';
import { Devices } from '../src/devices.ts';
import { demoMailImages } from '../src/mail/demo-html.ts';
import { FakeMailBackend, MailHub } from '../src/mail/index.ts';
import { InboxRanker } from '../src/ranker.ts';
import { ReadQueue } from '../src/readqueue.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

/** 2026-11-10 12:00 UTC, with the clock stopped there: day lines, "the last week" and scores fall the same way every run. */
const NOW = Date.UTC(2026, 10, 10, 12);
/** A tenth of the live hub: 574 conversations (150 with messages), 22k messages, a week of triage. Under a second to seed. */
const SCALE = 0.1;

const dir = mkdtempSync(join(tmpdir(), 'dither-budgets-'));
const measures: Measure[] = [];
const bytes = (key: string, value: number) => measures.push({ key, value, kind: 'bytes' });
const count = (key: string, value: number) => measures.push({ key, value, kind: 'count' });
/** Every field of every object in it: a field added to each conversation or message moves this, however few bytes. */
const fields = (x: unknown): number => (Array.isArray(x) ? x.reduce((n: number, v) => n + fields(v), 0) : x && typeof x === 'object' ? Object.values(x).reduce((n: number, v) => n + 1 + fields(v), 0) : 0);
/** A response's bytes, compressed bytes and fields. */
const payload = (key: string, r: { json: unknown; bytes: number; wire: number }) => {
  bytes(`${key}.bytes`, r.bytes);
  if (r.wire !== r.bytes) bytes(`${key}.zstd`, r.wire);
  count(`${key}.fields`, fields(r.json));
};

let world: World;
let store: Store;
let triage: Triage;
let attention: Attention;
let mail: MailHub;
let hub: HubServer;
let base = '';
let ws: WebSocket;
const frames: string[] = [];
let pong: (() => void) | null = null;

/** Every frame the hub sent before this is in `frames`: the socket keeps order, and the hub answers a ping in turn. */
const barrier = () =>
  new Promise<void>((r) => {
    pong = r;
    ws.send('ping');
  });

/** A response as the web app gets it: its JSON, its bytes, and its bytes on the wire (zstd, as Chromium is sent). */
async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const req = (encoding: string) =>
    fetch(base + path, {
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: { 'accept-encoding': encoding, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      decompress: false,
    } as RequestInit);
  const res = await req('identity');
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`);
  // Once more for the compressed size; a POST is not sent twice.
  const wire = init.method && init.method !== 'GET' ? Buffer.byteLength(text) : (await (await req('zstd')).arrayBuffer()).byteLength;
  return { json: JSON.parse(text), bytes: Buffer.byteLength(text), wire };
}

beforeAll(async () => {
  setSystemTime(new Date(NOW));
  world = seedWorld(dir, { scale: SCALE, anchor: NOW - 10 * 60_000 });
  // The sync journal's epoch is random (journal.ts): a fixed one of the same length keeps the compressed sizes the same.
  const db = new Database(join(dir, 'hub.sqlite'));
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_epoch', 'budgetsEpoch'), ('sync_open', '0')`);
  db.close();
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('budgets'));
  triage = new Triage(store);
  attention = new Attention(store, triage);
  // The learned order with its prior and no sampling: the same order every run.
  attention.judge = new InboxRanker(store, triage, 'model', undefined, Date.now, false);
  const activity = new ActivityStore(store);
  const devices = new Devices(store, triage);
  const fake = new FakeMailBackend();
  mail = new MailHub({ db: store.db, backend: fake, dataDir: dir, log: () => {}, media: { dir: join(dir, 'media-cache'), key: 'budgets', ...demoMailImages } });
  seedDemoMail(fake, NOW);
  mail.start();
  await mail.sync(DEMO_MAIL_ACCOUNT)!.whenSynced();
  // What attention.start folds in the background, all of it, now.
  while (attention.pump() > 0);
  attention.rescoreAll();
  const sup = { authorize: () => null, online: () => false, command: async () => ({}) } as any;
  hub = new HubServer(store, sup, triage, { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 'budgets', attention, activity, devices, mail, readQueue: new ReadQueue(store, sup) });
  hub.start();
  base = `http://127.0.0.1:${hub.server.port}`;
}, 60_000);

afterAll(() => {
  ws?.close();
  hub?.stop();
  mail?.stop();
  store?.db.close();
  setSystemTime();
  rmSync(dir, { recursive: true, force: true });
});

test('a cold start', async () => {
  // state.ts connect: the socket, and /api/health beside it.
  ws = new WebSocket(`${base.replace('http', 'ws')}/api/live`);
  ws.onmessage = (e) => {
    if (e.data === 'pong') pong?.();
    else frames.push(String(e.data));
  };
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const got = [
    await call('/api/health'),
    await call('/api/activity'),
    await call('/api/devices/hello', { method: 'POST', body: { id: 'dev_budgets0001', label: 'Chromium on Linux', endpoint: null } }),
  ];
  // With no snapshot: the bootstrap, then the inbox and mail's triage (state.ts loadInbox), and the rest of the first screen.
  const boot = await call('/api/bootstrap');
  const b = boot.json as P.Bootstrap;
  got.push(boot);
  const inbox = await call('/api/inbox');
  got.push(await call('/api/read-all'), inbox, await call('/api/mail/triage'), await call('/api/usage'), await call('/api/retention'));

  payload('bootstrap', boot);
  count('bootstrap.conversations', b.conversations.length);
  count('bootstrap.identities', b.identities.length);
  count('bootstrap.persons', b.persons.length);
  count('bootstrap.spaces', b.spaces.length);
  count('bootstrap.edges', b.edges.length);
  count('bootstrap.attention', b.attention?.length ?? 0);
  count('bootstrap.mail.threads', b.mail?.threads.length ?? 0);
  payload('inbox', inbox);
  count('inbox.items', (inbox.json as P.InboxPage).items.length);
  // The rest are small: they count in the total.
  bytes('coldStart.bytes', got.reduce((n, r) => n + r.bytes, 0));
  bytes('coldStart.zstd', got.reduce((n, r) => n + r.wire, 0));
  expect(b.conversations.length).toBeGreaterThan(100);
});

test('the biggest conversation: its first page and an older one', async () => {
  const id = world.open[0].id;
  const first = await call(`/api/conversations/${id}/messages?limit=60`);
  const p1 = first.json as P.MessagePage;
  const older = await call(`/api/conversations/${id}/messages?limit=60&before=${p1.messages[0].ts}`);
  const p2 = older.json as P.MessagePage;
  payload('page.first', first);
  count('page.first.messages', p1.messages.length);
  payload('page.older', older);
  count('page.older.messages', p2.messages.length);
  expect(p2.hasMore).toBe(true);
});

test('one message arriving: the live frames, and a relaunch that missed it', async () => {
  const conv = world.open[0];
  const acc = store.account(conv.accountId)!;
  hub.flush();
  await barrier();
  frames.length = 0;
  const from = store.journal.position();

  // As an adapter's message comes in (supervisor -> store.ingest), and the hub's flush sends it.
  store.ingest(acc, { t: 'message', live: true, message: { nativeId: 'budget-arrival', conversation: conv.nativeId, author: conv.member, ts: NOW - 1000, body: 'is the bundle chunk in the build yet' } });
  hub.flush();
  await barrier();
  expect(frames.length).toBe(1);
  const frame = (f: string) => ({ json: JSON.parse(f), bytes: Buffer.byteLength(f), wire: Buffer.byteLength(f) });
  payload('live.message', frame(frames[0]));
  count('live.message.events', JSON.parse(frames[0]).length);

  // Then its triage, as main.ts triageNow records it.
  const id = hubId('msg', acc.network, 'budget-arrival');
  const d = (await triage.decide(id))!;
  store.setTriage(id, d, d.facts);
  store.dirty.messages.set(id, true);
  attention.triaged(id, d);
  hub.flush();
  await barrier();
  expect(frames.length).toBe(2);
  payload('live.triaged', frame(frames[1]));
  count('live.triaged.events', JSON.parse(frames[1]).length);

  // A device that was away for it: state.ts resync from its snapshot's position.
  const sync = await call('/api/sync', { method: 'POST', body: { v: from.v, epoch: from.epoch, since: from.seq, timelines: [] } satisfies P.SyncRequest });
  const r = sync.json as P.SyncResponse;
  if (r.full) throw new Error(`the hub wanted a full bootstrap: ${r.reason}`);
  payload('sync.missed', sync);
  count('sync.missed.events', r.events.length);
});

test('within budget', () => {
  console.log(measures.map((m) => `${m.key.padEnd(26)} ${m.value.toLocaleString('en-US').padStart(10)}`).join('\n'));
  const r = checkBudgets('hub', measures, { title: 'Budgets: what the hub sends' });
  expect([...r.over, ...r.raisedWithoutReason, ...r.missing]).toEqual([]);
});
