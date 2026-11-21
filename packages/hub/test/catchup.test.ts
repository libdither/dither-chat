/**
 * Catching up (catchup.ts, docs/catch-up.md): reports of missing messages become holes, a hole plans which chats to
 * fetch and in what order, a possible one checks its likeliest chats first, and the fetching pages back over the
 * stretch against a fake network, a page at a time.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { CatchUp, CLAIM_SETTLE_MS, OFFLINE_MIN_MS, PAGE, PLAN_DELAY_MS } from '../src/catchup.ts';
import { BRISK, ReadingPace } from '../src/readingpace.ts';
import { mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Supervisor } from '../src/supervisor.ts';
import { FakeClock } from './fixtures/clock.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PEER = 'peer';
/** The stretch the hub missed: six hours, ending an hour before "now". */
const NOW = Date.UTC(2026, 4, 15, 12);
const S1 = NOW - HOUR;
const S0 = S1 - 6 * HOUR;

type Net = Record<string, P.MessageFact[]>;

/**
 * A Discord account and its chats, each with a pace before the stretch, messages in it (on the network only, unless
 * `held`), and two after it the hub has.
 * - d1: a direct chat, a message every 2 h before, every 30 min in the stretch (12).
 * - g1: a group, every 4 h before, 3 in the stretch.
 * - cr: a channel you read, hourly before, 20 in the stretch.
 * - cu: the same channel, never read.
 * - cq: a channel you read, nearly silent.
 * - d2: a direct chat with a message every two days.
 */
function world(o: { caps?: P.Capability[]; held?: string[] } = {}) {
  const store = new Store(':memory:', mediaSigner('s'));
  let acc = store.createAccount({ id: 'acc_dc', network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
  store.ingest(acc, { t: 'hello', network: 'discord', version: 'test', capabilities: o.caps ?? ['history'] });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true } });
  acc = store.account('acc_dc')!;
  store.ingest(acc, { t: 'identity', identity: { nativeId: PEER, displayName: 'peer' } });
  store.ingest(acc, { t: 'space', space: { nativeId: 'g', kind: 'community', name: 'Guild' } });
  const shapes: Record<string, P.ConversationFact> = {
    d1: { nativeId: 'd1', shape: 'direct', participants: [PEER] },
    d2: { nativeId: 'd2', shape: 'direct', participants: [PEER] },
    g1: { nativeId: 'g1', shape: 'group', name: 'Group', participants: [PEER, 'me'] },
    cr: { nativeId: 'cr', shape: 'channel', name: 'read', spaces: [{ nativeId: 'g' }] },
    cu: { nativeId: 'cu', shape: 'channel', name: 'unread', spaces: [{ nativeId: 'g' }] },
    cq: { nativeId: 'cq', shape: 'channel', name: 'quiet', spaces: [{ nativeId: 'g' }] },
  };
  const pace: Record<string, { before: number; inside: number }> = {
    d1: { before: 2 * HOUR, inside: 12 },
    d2: { before: 2 * DAY, inside: 0 },
    g1: { before: 4 * HOUR, inside: 3 },
    cr: { before: HOUR, inside: 20 },
    cu: { before: HOUR, inside: 20 },
    cq: { before: 7 * DAY, inside: 0 },
  };
  const net: Net = {};
  for (const [c, f] of Object.entries(shapes)) {
    store.ingest(acc, { t: 'conversation', conversation: f });
    const all: P.MessageFact[] = [];
    const m = (ts: number, i: string): P.MessageFact => ({ nativeId: `${c}-${i}`, conversation: c, author: PEER, ts, body: `${c} ${i}` });
    for (let ts = S0 - 15 * DAY, i = 0; ts < S0; ts += pace[c].before, i++) all.push(m(ts, `b${i}`));
    for (let i = 0; i < pace[c].inside; i++) all.push(m(S0 + ((i + 1) * (S1 - S0)) / (pace[c].inside + 1), `s${i}`));
    all.push(m(S1 + 10 * MIN, 'a0'), m(S1 + 20 * MIN, 'a1'));
    net[c] = all;
    for (const x of all) if (x.ts < S0 || x.ts > S1 || o.held?.includes(c)) store.ingest(acc, { t: 'message', message: x, live: false });
  }
  const hub = (native: string) => (store.db.query(`SELECT id FROM conversation WHERE native_id = ?`).get(native) as any).id as string;
  // Read: you opened cr and cq here lately; cu, never.
  for (const c of ['cr', 'cq']) store.db.query(`INSERT INTO place_usage (kind, id, score_at, visits, last_visit) VALUES ('conversation', ?, ?, 1, ?)`).run(hub(c), NOW, NOW - DAY);
  return { store, acc, net, hub };
}

/** A catch-up over the world's network: each history page as Discord's extractor answers it. */
function catchUp(store: Store, acc: AccountRow, net: Net, o: { online?: () => boolean; start?: boolean } = {}) {
  const clock = new FakeClock(NOW);
  const asked: { conversation: string; beforeTs: number; cursor?: string }[] = [];
  const c = new CatchUp(store, {
    clock,
    online: o.online ?? (() => true),
    pace: new ReadingPace(store, BRISK, clock),
    command: async (_a, cmd) => {
      expect(cmd).toMatchObject({ t: 'history', limit: PAGE, pace: 'read' });
      asked.push({ conversation: cmd.conversation, beforeTs: cmd.beforeTs, cursor: cmd.cursor });
      const below = net[cmd.conversation].filter((m) => m.ts < cmd.beforeTs);
      const page = below.slice(-cmd.limit);
      for (const m of page) store.ingest(acc, { t: 'message', message: m, live: false });
      return { count: page.length, done: page.length === below.length, oldest: page[0]?.ts, next: page[0]?.nativeId };
    },
  });
  if (o.start !== false) c.start();
  return { c, clock, asked };
}

const count = (store: Store, cid: string, from = 0, to = Number.MAX_SAFE_INTEGER) => (store.db.query('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND ts >= ? AND ts <= ?').get(cid, from, to) as any).n as number;
const holes = (c: CatchUp) => c.list();

describe('an account hole', () => {
  test('the manager dropped events while the hub was away: the chats you read are fetched over the stretch, busiest first', async () => {
    const { store, acc, net, hub } = world();
    const { c, clock, asked } = catchUp(store, acc, net, { start: false });
    // The hub lost the manager at S0 and was back an hour ago; the manager says it dropped what it held.
    (clock as any).t = S0;
    c.connection(false);
    (clock as any).t = NOW;
    c.connection(true);
    c.dropped(acc.id, 2400);
    c.start();
    // Planned a minute later, so reports of the same trouble merge first.
    await clock.advance(PLAN_DELAY_MS - 10_000);
    expect(holes(c)[0]).toMatchObject({ scope: 'account', state: 'fetching', chats: 0 });
    await clock.until(() => c.list()[0].state === 'done', DAY, 'the hole');
    const h = c.get(c.list()[0].id)!;
    expect(h).toMatchObject({ scope: 'account', accountId: acc.id, strength: 'sure', causes: ['dropped'], chats: 4, chatsDone: 4, found: 35 });
    expect(h.from).toBe(S0 - MIN);
    expect(h.notes[0]).toBe('dither-accounts dropped 2,400 events it held for the hub');
    // The channel nobody reads and the silent one are left out, and said so.
    expect(h.left).toEqual(expect.arrayContaining([{ why: "you don't read them", count: 1 }, { why: 'quiet before then', count: 1 }]));
    // By how many messages each was likely to get, a direct chat or a group counting three times a channel's.
    expect(h.list!.map((t) => [t.conversationId, t.state, t.found])).toEqual([
      [hub('d1'), 'done', 12],
      [hub('cr'), 'done', 20],
      [hub('g1'), 'done', 3],
      [hub('d2'), 'done', 0],
    ]);
    for (const x of ['d1', 'g1', 'cr']) expect(count(store, hub(x))).toBe(net[x].length);
    expect(count(store, hub('cu'), S0, S1)).toBe(0);
    // Each chat starts from the end of the stretch and stops once a page reaches its start.
    expect(asked.filter((a) => a.conversation === 'd1').map((a) => a.beforeTs)).toEqual([NOW + 1]);
    // What it fetched is known whole: an index job or another hole skips it.
    const span = store.db.query('SELECT from_ts, to_ts FROM history_span WHERE conversation_id = ?').get(hub('cr')) as any;
    expect(span.to_ts).toBe(NOW + 1);
    expect(span.from_ts).toBeLessThanOrEqual(S0 - MIN);
  });

  test('a possible hole checks the likeliest chats first, and is clear when they are whole', async () => {
    const { store, acc, net, hub } = world({ held: ['d1', 'd2', 'g1', 'cr', 'cu', 'cq'] });
    const { c, clock, asked } = catchUp(store, acc, net);
    const id = c.report({ scope: 'account', accountId: acc.id, from: S0, to: S1, strength: 'possible', cause: 'offline', note: 'offline' })!;
    await clock.until(() => ['clear', 'done'].includes(c.get(id)!.state), DAY, 'the check');
    const h = c.get(id)!;
    expect(h.state).toBe('clear');
    expect(h.found).toBe(0);
    // The three likeliest, one page each; the quiet direct chat was never asked.
    expect(new Set(asked.map((a) => a.conversation))).toEqual(new Set(['d1', 'g1', 'cr']));
    expect(h.list!.find((t) => t.conversationId === hub('d2'))).toMatchObject({ state: 'skipped', why: 'the first chats checked were whole' });
    expect(h.notes.at(-1)).toContain('were whole');
  });

  test('a possible hole whose first chats miss messages fetches the rest', async () => {
    const { store, acc, net } = world({ held: ['g1', 'cr'] });
    const { c, clock } = catchUp(store, acc, net);
    const id = c.report({ scope: 'account', accountId: acc.id, from: S0, to: S1, strength: 'possible', cause: 'offline', note: 'offline' })!;
    await clock.until(() => c.get(id)!.state === 'done', DAY, 'the hole');
    const h = c.get(id)!;
    expect(h).toMatchObject({ strength: 'likely', found: 12, chatsDone: 4 });
    expect(h.notes.at(-1)).toBe('12 missing messages in the first chats checked: fetching the rest');
  });

  test('an account that cannot fetch history leaves its hole unfetchable, listing the chats likely to miss messages', async () => {
    const { store, acc, net, hub } = world({ caps: [] });
    const { c, clock, asked } = catchUp(store, acc, net);
    const id = c.report({ scope: 'account', accountId: acc.id, from: S0, to: S1, strength: 'sure', cause: 'lost', note: 'lost' })!;
    await clock.advance(PLAN_DELAY_MS + 10_000);
    const h = c.get(id)!;
    expect(h.state).toBe("unfetchable");
    expect(h.list!.map((t) => [t.conversationId, t.state])).toEqual([
      [hub('d1'), 'unfetchable'],
      [hub('cr'), 'unfetchable'],
      [hub('g1'), 'unfetchable'],
    ]);
    expect(h.notes.at(-1)).toContain('an import');
    expect(asked).toEqual([]);
  });

  test('Check every chat plans the left-out chats too, and fetches them', async () => {
    const { store, acc, net, hub } = world({ held: ['d1', 'd2', 'g1', 'cr', 'cq'] });
    const { c, clock } = catchUp(store, acc, net);
    const id = c.report({ scope: 'account', accountId: acc.id, from: S0, to: S1, strength: 'possible', cause: 'offline', note: 'offline' })!;
    await clock.until(() => c.get(id)!.state === 'clear', DAY, 'the check');
    c.allChats(id);
    await clock.until(() => c.get(id)!.state === 'done', DAY, 'every chat');
    const h = c.get(id)!;
    expect(h.left).toEqual([]);
    expect(h.list!.find((t) => t.conversationId === hub('cu'))).toMatchObject({ state: 'done', found: 20 });
    expect(count(store, hub('cu'))).toBe(net.cu.length);
  });
});

describe('reports', () => {
  test('reports close in time merge into one hole, wider and surer', () => {
    const { store, acc, net } = world({ held: ['d1', 'd2', 'g1', 'cr', 'cu', 'cq'] });
    const { c } = catchUp(store, acc, net, { start: false });
    const a = c.report({ scope: 'account', accountId: acc.id, from: S0, to: S0 + HOUR, strength: 'possible', cause: 'offline', note: 'one' });
    const b = c.report({ scope: 'account', accountId: acc.id, from: S0 + HOUR + 20 * MIN, to: S1, strength: 'sure', cause: 'dropped', note: 'two' });
    const far = c.report({ scope: 'account', accountId: acc.id, from: S0 - 5 * HOUR, to: S0 - 2 * HOUR, strength: 'possible', cause: 'offline', note: 'three' });
    expect(b).toBe(a);
    expect(far).not.toBe(a);
    expect(c.get(a!)).toMatchObject({ from: S0, to: S1, strength: 'sure', causes: ['offline', 'dropped'], notes: ['one', 'two'] });
  });

  test('POST /api/catch-up/report checks what it is given', () => {
    const { store, acc, net, hub } = world();
    const { c } = catchUp(store, acc, net, { start: false });
    expect(() => c.reportFrom({ from: S0 } as P.CatchUpReport)).toThrow('which account or chat?');
    expect(() => c.reportFrom({ accountId: acc.id, from: 'yesterday' as any })).toThrow('`from` is a time');
    expect(() => c.reportFrom({ accountId: 'acc_nope', from: S0 })).toThrow('no such account');
    expect(() => c.reportFrom({ conversationId: 'cnv_nope', from: S0 })).toThrow('no such chat');
    const v = c.reportFrom({ conversationId: hub('cu'), from: S0, to: S1, note: 'Sam says they wrote' });
    expect(v).toMatchObject({ scope: 'chat', accountId: acc.id, conversationId: hub('cu'), strength: 'likely', causes: ['report'], notes: ['Sam says they wrote'] });
  });

  test('a stretch longer than two weeks is cut to the last two', () => {
    const { store, acc, net } = world();
    const { c } = catchUp(store, acc, net, { start: false });
    const id = c.report({ scope: 'account', accountId: acc.id, from: NOW - 60 * DAY, strength: 'sure', cause: 'report', note: 'x' })!;
    expect(c.get(id)).toMatchObject({ from: NOW - 14 * DAY, to: NOW });
  });

  test('the network says a chat has newer messages: a chat hole, once per claim, and none for a chat never followed', async () => {
    const { store, acc, net, hub } = world();
    // d1's messages after the stretch never came either.
    store.db.query(`DELETE FROM message WHERE conversation_id = ? AND ts > ?`).run(hub('d1'), S0);
    const { c, clock } = catchUp(store, acc, net);
    const newest = net.d1.at(-1)!.ts;
    c.conversation(acc.id, { nativeId: 'd1', shape: 'direct', lastMessageAt: newest });
    // A chat with nothing held lately is one the hub never fetched, not a hole.
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'new', shape: 'channel', name: 'new', spaces: [{ nativeId: 'g' }] } });
    c.conversation(acc.id, { nativeId: 'new', shape: 'channel', lastMessageAt: NOW - MIN });
    await clock.advance(CLAIM_SETTLE_MS - 10_000);
    expect(holes(c)).toEqual([]);
    await clock.until(() => c.list()[0]?.state === 'done', DAY, 'the chat hole');
    expect(holes(c)).toHaveLength(1);
    expect(holes(c)[0]).toMatchObject({ scope: 'chat', conversationId: hub('d1'), causes: ['behind'], found: 14 });
    expect(count(store, hub('d1'))).toBe(net.d1.length);
    // The same claim again (the adapter reconnected): nothing new.
    c.conversation(acc.id, { nativeId: 'd1', shape: 'direct', lastMessageAt: newest });
    await clock.advance(CLAIM_SETTLE_MS + 10_000);
    expect(holes(c)).toHaveLength(1);
  });

  test("a chat whose newest message is one the hub does not keep stops being checked after two checks found nothing", async () => {
    const { store, acc, net, hub } = world({ held: ['d1'] });
    const { c, clock } = catchUp(store, acc, net);
    // A join or a pin: the network counts it, the hub never stores it.
    let at = net.d1.at(-1)!.ts;
    for (let i = 0; i < 3; i++) {
      at += 10 * MIN;
      c.conversation(acc.id, { nativeId: 'd1', shape: 'direct', lastMessageAt: at });
      await clock.until(() => c.list().length === Math.min(i + 1, 2) && c.list().every((h) => h.state === 'done'), DAY, `check ${i}`);
      await clock.advance(CLAIM_SETTLE_MS + 10_000);
    }
    expect(holes(c).map((h) => [h.conversationId, h.found])).toEqual([
      [hub('d1'), 0],
      [hub('d1'), 0],
    ]);
  });

  test('chat holes on one account missing messages at the same time: the rest of the account is checked then', async () => {
    const { store, acc, net, hub } = world();
    const { c, clock } = catchUp(store, acc, net);
    for (const x of ['d1', 'g1', 'cr']) c.report({ scope: 'chat', conversationId: hub(x), from: S0, to: S1, strength: 'likely', cause: 'report', note: x });
    await clock.until(() => c.list().some((h) => h.scope === 'account'), DAY, 'the account hole');
    const h = c.list().find((x) => x.scope === 'account')!;
    expect(h).toMatchObject({ causes: ['nearby'], strength: 'likely' });
    expect(h.notes[0]).toBe("3 chats were missing messages around the same time, so the account's other chats are checked for then");
  });

  test('an account offline for a while opens a possible hole when it is back; a blip does not', async () => {
    const { store, acc, net } = world({ held: ['d1', 'd2', 'g1', 'cr', 'cu', 'cq'] });
    let up = true;
    const { c, clock } = catchUp(store, acc, net, { online: () => up });
    await clock.advance(10_000);
    up = false;
    await clock.advance(MIN);
    up = true;
    await clock.advance(10_000);
    expect(holes(c)).toEqual([]);
    up = false;
    await clock.advance(OFFLINE_MIN_MS + MIN);
    up = true;
    await clock.advance(10_000);
    expect(holes(c)).toHaveLength(1);
    expect(holes(c)[0]).toMatchObject({ scope: 'account', strength: 'possible', causes: ['offline'] });
  });
});

describe('what the hub itself lost', () => {
  test('a start after a crash while events waited opens a sure hole back to the oldest waiting message', () => {
    const { store, acc, net } = world();
    const { c } = catchUp(store, acc, net, { start: false });
    c.queued(acc.id, [{ t: 'message', message: { nativeId: 'x', conversation: 'd1', author: PEER, ts: S0, body: '' } }]);
    // The hub died here: no stop. The next start says so.
    const next = catchUp(store, acc, net, { start: false }).c;
    next.start({ unclean: true });
    next.tick();
    next.stop();
    const h = next.list();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ scope: 'account', causes: ['lost'], strength: 'sure', from: S0 - MIN });
    expect(store.one(`SELECT 1 FROM meta WHERE key = 'catchup:backlog'`)).toBeNull();
  });

  test('a clean start forgets the marker; a stop that lost events reports them at the next start', () => {
    const { store, acc, net } = world();
    const first = catchUp(store, acc, net, { start: false }).c;
    first.queued(acc.id, [{ t: 'message', message: { nativeId: 'x', conversation: 'd1', author: PEER, ts: S0, body: '' } }]);
    const clean = catchUp(store, acc, net, { start: false }).c;
    clean.start();
    clean.tick();
    clean.stop();
    expect(clean.list()).toEqual([]);
    clean.queued(acc.id, [{ t: 'message', message: { nativeId: 'y', conversation: 'd1', author: PEER, ts: S0, body: '' } }]);
    clean.stopping(7);
    const after = catchUp(store, acc, net, { start: false }).c;
    after.start();
    after.tick();
    after.stop();
    expect(after.list()[0]).toMatchObject({ causes: ['lost'], notes: ['The hub stopped and could not save 7 events that waited to be applied'] });
  });

  test('a message that fails to be stored opens a chat hole, once a day however often it fails', () => {
    const { store, acc, net, hub } = world();
    const { c } = catchUp(store, acc, net, { start: false });
    const sup = new Supervisor(store, { hubAdapterUrl: '', dataDir: '/nonexistent', repoRoot: '/nonexistent', inproc: () => null, onFresh: () => {} });
    sup.watch = c;
    const real = store.ingest.bind(store);
    store.ingest = (a, ev) => {
      if (ev.t === 'message') throw new Error('boom');
      return real(a, ev);
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      const ev: P.AdapterEvent = { t: 'message', message: { nativeId: 'd1-lost', conversation: 'd1', author: PEER, ts: S1 - MIN, body: '' }, live: true };
      sup.apply(acc.id, [ev]);
      sup.apply(acc.id, [ev]);
    } finally {
      console.error = quiet;
      store.ingest = real;
    }
    c.tick();
    expect(c.list()).toHaveLength(1);
    expect(c.list()[0]).toMatchObject({ scope: 'chat', conversationId: hub('d1'), causes: ['lost'], from: S1 - MIN - 1, notes: ['A message could not be stored: boom'] });
  });

  test("the adapter's gap event: a hole for the account, or for the chats it names", () => {
    const { store, acc, net, hub } = world();
    const { c } = catchUp(store, acc, net, { start: false });
    const sup = new Supervisor(store, { hubAdapterUrl: '', dataDir: '/nonexistent', repoRoot: '/nonexistent', inproc: () => null, onFresh: () => {} });
    sup.watch = c;
    sup.apply(acc.id, [{ t: 'gap', from: S0, to: S1, note: 'the gateway session could not be resumed' }]);
    sup.apply(acc.id, [{ t: 'gap', from: S0, conversations: ['cr'] }]);
    c.tick();
    const h = c.list();
    expect(h.map((x) => [x.scope, x.conversationId, x.causes])).toEqual(
      expect.arrayContaining([
        ['account', null, ['adapter']],
        ['chat', hub('cr'), ['adapter']],
      ]),
    );
    expect(h.find((x) => x.scope === 'account')!.notes[0]).toBe('The account says it may have missed messages: the gateway session could not be resumed');
  });
});
