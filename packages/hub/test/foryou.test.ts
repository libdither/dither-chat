/**
 * For you (foryou.ts, docs/foryou.md): what may be an item, bursts and the folds, the order and its caps, exploration
 * slots and their exact chances, snapshots that stay put, logging only while the activity log is on, and the label a
 * later ranker learns from (labels.ts foryouLabel). Invented data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityStore } from '../src/activity.ts';
import { BURST_GAP, BURST_SPAN, bursts, EXPLORE_AT, EXPLORE_OUTSIDE, fold, ForYou, freshness, HALF_LIFE, place, type Candidate, type Scored } from '../src/foryou.ts';
import { foryouLabel, type ForYouOutcome } from '../src/labels.ts';
import { Store } from '../src/store.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

const cand = (id: string, o: Partial<Candidate> = {}): Candidate => ({ id, conv: 'c1', author: 'a1', ts: NOW - HOUR, prior: 0.5, decided: NOW - HOUR, replyTo: null, chars: 40, text: id, ...o });

describe('bursts and folds', () => {
  test('a gap of half an hour, or a burst over two hours long, starts another burst', () => {
    const b = bursts([cand('m1', { ts: 0 }), cand('m2', { ts: 10 * MIN }), cand('m3', { ts: 10 * MIN + BURST_GAP + 1 }), ...Array.from({ length: 10 }, (_, i) => cand(`r${i}`, { ts: 3 * HOUR + i * 20 * MIN }))]);
    expect(b.map((x) => x.map((c) => c.id))).toEqual([['m1', 'm2'], ['m3'], ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6'], ['r7', 'r8', 'r9']]);
    expect(b[2][b[2].length - 1].ts - b[2][0].ts).toBeLessThanOrEqual(BURST_SPAN);
  });

  test('one item per burst, its best, with the burst counted', () => {
    const items = fold([cand('m1', { ts: NOW - 30 * MIN, prior: 0.4 }), cand('m2', { ts: NOW - 25 * MIN, prior: 0.9 }), cand('m3', { ts: NOW - 20 * MIN, prior: 0.6 })], NOW);
    expect(items.map((i) => i.c.id)).toEqual(['m2']);
    expect(items[0].burst).toEqual({ from: NOW - 30 * MIN, to: NOW - 20 * MIN, n: 3 });
  });

  test('a reply is kept with what it answers dropped; the same post in two chats is one item naming the other', () => {
    const items = fold(
      [
        cand('q', { conv: 'c1', ts: NOW - 5 * HOUR, prior: 0.9 }),
        cand('r', { conv: 'c1', ts: NOW - 2 * HOUR, prior: 0.5, replyTo: 'q', author: 'a2' }),
        cand('x1', { conv: 'c2', author: 'a3', text: 'same', prior: 0.7 }),
        cand('x2', { conv: 'c3', author: 'a3', text: 'same', prior: 0.6, ts: NOW - HOUR + 5 * MIN }),
      ],
      NOW,
    );
    expect(items.map((i) => i.c.id).sort()).toEqual(['r', 'x1']);
    expect(items.find((i) => i.c.id === 'x1')!.also).toEqual(['c3']);
  });

  test('freshness halves every eight hours', () => {
    expect(freshness(0)).toBe(1);
    expect(freshness(HALF_LIFE)).toBeCloseTo(0.5);
    const items = fold([cand('old', { conv: 'c1', prior: 0.9, ts: NOW - 2 * HALF_LIFE }), cand('new', { conv: 'c2', prior: 0.5, ts: NOW })], NOW);
    expect(items.map((i) => i.c.id)).toEqual(['new', 'old']);
  });
});

describe('the order', () => {
  const scored = (n: number, chats = n, authors = n): Scored[] =>
    Array.from({ length: n }, (_, i) => ({ c: cand(`m${i}`, { conv: `c${i % chats}`, author: `a${i % authors}` }), score: 1 - i / (n + 1), burst: { from: 0, to: 0, n: 1 }, also: [] }));

  test('ranked slots are the best that fits, with a chance of 1; at most two per chat and one per author in any ten', () => {
    const out = place(scored(60, 3, 60), { random: () => 0.5, novelty: () => 1 });
    for (let i = 0; i < out.length; i++) {
      const ten = out.slice(Math.max(0, i - 9), i + 1);
      const perChat = new Map<string, number>();
      for (const p of ten) perChat.set(p.c.conv, (perChat.get(p.c.conv) ?? 0) + 1);
      // Three chats cannot fill ten under the cap: the best goes in anyway rather than nothing.
      if (out.length >= 10 && i < 2) expect(Math.max(...perChat.values())).toBeLessThanOrEqual(2);
    }
    const ranked = place(scored(40), { random: () => 0.5, novelty: () => 1 }).filter((p) => p.slot === 'rank');
    expect(ranked.every((p) => p.propensity === 1)).toBe(true);
    const authors = place(scored(30, 30, 5), { random: () => 0.5, novelty: () => 1 });
    for (let i = 0; i + 5 <= authors.length && i < 5; i++) expect(new Set(authors.slice(i, i + 5).map((p) => p.c.author)).size).toBe(5);
  });

  test('slots 4 and 9 of each ten explore outside the top 30, and log the exact chance of what they drew', () => {
    const s = scored(100);
    const novelty = (conv: string) => (conv === 'c77' ? 5 : 1);
    const out = place(s, { random: () => 0.999999, novelty });
    const explored = out.filter((p) => p.slot === 'explore');
    expect(explored.map((p) => p.position % 10).every((x) => EXPLORE_AT.includes(x))).toBe(true);
    expect(explored.length).toBe(2 * 10);
    const top = new Set(s.slice(0, EXPLORE_OUTSIDE).map((x) => x.c.id));
    expect(explored.every((p) => !top.has(p.c.id))).toBe(true);
    // The first draw: from all 70 outside the top 30, weight exp(score / 0.25) × novelty; random near 1 takes the last.
    const pool = s.slice(EXPLORE_OUTSIDE);
    const w = pool.map((x) => Math.exp(x.score / 0.25) * novelty(x.c.conv));
    const total = w.reduce((a, b) => a + b, 0);
    expect(explored[0].c.id).toBe(pool[pool.length - 1].c.id);
    expect(explored[0].propensity).toBeCloseTo(w[w.length - 1] / total, 12);
    // A low draw takes the first of the pool.
    const low = place(s, { random: () => 0, novelty }).find((p) => p.slot === 'explore')!;
    expect(low.c.id).toBe(pool[0].c.id);
    expect(low.propensity).toBeCloseTo(w[0] / total, 12);
  });

  test('with nothing outside the top 30, an exploration slot is ranked', () => {
    expect(place(scored(20), { random: () => 0.5, novelty: () => 1 }).every((p) => p.slot === 'rank')).toBe(true);
  });
});

describe('the hub', () => {
  let dir: string;
  let store: Store;
  let activity: ActivityStore;
  let muted = new Set<string>();
  const ids: Record<string, string> = {};
  let clock = NOW;
  const make = (o: { logging?: boolean } = {}) =>
    new ForYou(store, { whole: true, now: () => clock, random: () => 0.5, logging: () => o.logging ?? activity.enabled, levelOf: (id) => (muted.has(id) ? 'none' : 'mentions') });
  let n = 0;
  const msg = (conv: string, author: string, o: { ts?: number; score?: number; decision?: string; mentions?: boolean; replyTo?: string; body?: string } = {}) => {
    const id = `msg_t${n++}`;
    const ts = o.ts ?? clock - HOUR;
    store.db
      .query(`INSERT INTO message (id, conversation_id, network, native_id, author_id, ts, body, mentions_self, reply_to_id) VALUES (?, ?, 'discord', ?, ?, ?, ?, ?, ?)`)
      .run(id, ids[conv], id, ids[author], ts, o.body ?? `text ${id}`, o.mentions ? 1 : 0, o.replyTo ?? null);
    store.db.query(`INSERT INTO triage (message_id, decision, score, reasons, decided_by, created_at) VALUES (?, ?, ?, '[]', 'model', ?)`).run(id, o.decision ?? 'drop', o.score ?? 0.6, ts + 1000);
    return id;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-foryou-'));
    store = new Store(join(dir, 'hub.sqlite'), () => null);
    activity = new ActivityStore(store);
    const acc = store.createAccount({ id: 'acc_t', network: 'discord', label: 't', color: '#888', adapter: 'test' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true, displayName: 'Me' } });
    const people = ['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus'];
    for (const p of people) store.ingest(acc, { t: 'identity', identity: { nativeId: p, displayName: p } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'general', shape: 'channel', name: 'general' } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'random', shape: 'channel', name: 'random' } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['me', 'ann'] } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'small', shape: 'group', name: 'small', participants: ['me', 'ann', 'bob'] } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'big', shape: 'group', name: 'big', participants: ['me', ...people] } });
    for (const c of ['general', 'random', 'dm', 'small', 'big']) ids[c] = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = ?`, c)!.id;
    for (const p of [...people, 'me']) ids[p] = store.one<{ id: string }>(`SELECT id FROM identity WHERE native_id = ?`, p)!.id;
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    store.db.exec('DELETE FROM triage; DELETE FROM message; DELETE FROM foryou_item; DELETE FROM foryou_event; UPDATE vantage SET last_read_ts = NULL;');
    activity.setSettings({ enabled: true });
    muted = new Set();
    clock = NOW;
  });

  test('channels and groups of seven or more, from others, not to you, unread, not muted, on the list or below', async () => {
    const keep = [msg('general', 'ann'), msg('big', 'bob', { ts: clock - 3 * HOUR })];
    msg('dm', 'ann');
    msg('small', 'bob');
    msg('random', 'me');
    msg('random', 'cat', { mentions: true, ts: clock - 5 * HOUR });
    msg('random', 'dan', { decision: 'quiet', ts: clock - 7 * HOUR });
    msg('random', 'eve', { ts: clock - 3 * 86_400_000 });
    const mine = msg('general', 'me', { ts: clock - 9 * HOUR });
    msg('general', 'fay', { replyTo: mine, ts: clock - 9 * HOUR + MIN });
    const p = await make().page(null);
    expect(p.items.map((i) => i.message.id).sort()).toEqual(keep.sort());
    expect(p.items.every((i) => i.propensity === 1 && i.slot === 'rank')).toBe(true);
    expect(p.identities.some((i) => i.id === ids.ann)).toBe(true);
  });

  test('a muted chat, and what you read up to, stay out', async () => {
    const a = msg('general', 'ann', { ts: clock - 2 * HOUR });
    msg('random', 'bob');
    muted.add(ids.random);
    store.db.query(`UPDATE vantage SET last_read_ts = ? WHERE target_id = ?`).run(clock - 3 * HOUR, ids.general);
    expect((await make().page(null)).items.map((i) => i.message.id)).toEqual([a]);
    store.db.query(`UPDATE vantage SET last_read_ts = ? WHERE target_id = ?`).run(clock, ids.general);
    expect((await make().page(null)).items).toEqual([]);
  });

  test('a snapshot stays put: its next page, and the same page again, whatever came since; an unknown epoch is a fresh one', async () => {
    for (let i = 0; i < 30; i++) msg(i % 2 ? 'general' : 'big', ['ann', 'bob', 'cat', 'dan', 'eve', 'fay'][i % 6], { ts: clock - MIN - i * 40 * MIN, score: 0.3 + (i % 7) / 10 });
    const f = make();
    const p1 = await f.page(null, 0, 5);
    expect(p1.items.map((i) => i.position)).toEqual([0, 1, 2, 3, 4]);
    expect(p1.next).toBe(5);
    clock += 5 * MIN;
    msg('general', 'gus', { ts: clock - 2 * MIN, score: 0.99 });
    const again = await f.page(p1.epoch, 0, 5);
    expect(again.items.map((i) => i.id)).toEqual(p1.items.map((i) => i.id));
    const p2 = await f.page(p1.epoch, 5, 5);
    expect(p2.items[0].position).toBe(5);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.message.id)).size).toBe(10);
    expect(await f.fresh(p1.epoch)).toEqual({ fresh: 1, known: true });
    const gone = await f.page('nope', 0, 5);
    expect(gone.reset).toBe(true);
    expect(gone.epoch).not.toBe(p1.epoch);
    expect(gone.items[0].message.body).toContain('text');
  });

  test('a reply carries what it answers; a burst says how many came in it', async () => {
    const q = msg('general', 'ann', { ts: clock - 4 * HOUR, score: 0.2 });
    const r = msg('general', 'bob', { ts: clock - 4 * HOUR + 5 * MIN, replyTo: q, score: 0.9 });
    msg('general', 'cat', { ts: clock - 4 * HOUR + 10 * MIN, score: 0.3 });
    const p = await make().page(null);
    expect(p.items.map((i) => i.message.id)).toEqual([r]);
    expect(p.quoted.map((m) => m.id)).toEqual([q]);
    expect(p.items[0].burst.count).toBe(3);
  });

  test('served items and events are logged while the activity log is on, ids and numbers only; never when off', async () => {
    msg('general', 'ann');
    activity.setSettings({ enabled: false });
    await make().page(null);
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM foryou_item')!.n).toBe(0);
    activity.setSettings({ enabled: true });
    const f = make();
    const p = await f.page(null);
    const it = p.items[0];
    const row = store.one<Record<string, unknown>>('SELECT * FROM foryou_item WHERE id = ?', it.id)!;
    expect(row).toMatchObject({ epoch: p.epoch, message_id: it.message.id, conversation_id: ids.general, position: 0, slot: 'rank', propensity: 1, burst_n: 1, reply: 0 });
    expect(Object.values(row).every((v) => v === null || typeof v === 'number' || /^[\w.-]+$/.test(String(v)))).toBe(true);
    const at = clock + 1000;
    expect(f.events([{ itemId: it.id, device: 'dev-a', kind: 'shown', at, ms: 900 }, { itemId: 'made-up', device: 'dev-a', kind: 'shown', at }, { itemId: it.id, device: 'dev-a', kind: 'bogus' as never, at }])).toBe(1);
    f.events([{ itemId: it.id, device: 'dev-a', kind: 'shown', at: at + 5000, ms: 2400 }, { itemId: it.id, device: 'dev-a', kind: 'clicked', at: at + 6000 }]);
    expect(store.one('SELECT at, ms FROM foryou_event WHERE kind = ?', 'shown')).toEqual({ at, ms: 2400 });
    expect(f.stats(NOW - HOUR)).toMatchObject({ served: 1, shown: 1, clicked: 1, clickRate: 1, exploreShare: 0 });
    activity.clear();
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM foryou_event')!.n).toBe(0);
  });

  test('reading triage walks its index by time, a page at a time', () => {
    const plan = store.db.query(`EXPLAIN QUERY PLAN SELECT rowid, message_id, decision, score, created_at FROM triage WHERE (created_at, rowid) > (?, ?) AND created_at <= ? ORDER BY created_at, rowid LIMIT 2048`).all(0, 0, 1) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('triage_created');
    expect(plan.map((p) => p.detail).join(' ')).not.toContain('TEMP B-TREE');
  });
});

describe('the label a ranker will learn from', () => {
  const o = (x: Partial<ForYouOutcome>): ForYouOutcome => ({ slot: 'rank', propensity: 1, chars: 40, shownAt: NOW, shownMs: 0, passed: false, clicked: false, more: false, less: false, hidden: false, ...x });
  test('what you did wins; a quick pass is a no; the rest says nothing', () => {
    expect(foryouLabel(o({ clicked: true }))).toEqual({ y: 1, weight: 1, why: 'opened' });
    expect(foryouLabel(o({ more: true }))).toEqual({ y: 1, weight: 2, why: 'more like this' });
    expect(foryouLabel(o({ hidden: true }))).toEqual({ y: 0, weight: 2, why: 'hidden' });
    expect(foryouLabel(o({ shownMs: 1200, passed: true }))).toEqual({ y: 0, weight: 1, why: 'passed' });
    // Read in place (longer than reading takes), a fling, the last on screen, and already in the chat: censored.
    expect(foryouLabel(o({ shownMs: 5000, passed: true }))).toBeNull();
    expect(foryouLabel(o({ shownMs: 500, passed: true }))).toBeNull();
    expect(foryouLabel(o({ shownMs: 1200, passed: false }))).toBeNull();
    expect(foryouLabel(o({ shownMs: 1200, passed: true, wasThere: true }))).toBeNull();
  });
  test('an exploration slot weighs 1/propensity, at most 10', () => {
    expect(foryouLabel(o({ slot: 'explore', propensity: 0.25, clicked: true }))!.weight).toBe(4);
    expect(foryouLabel(o({ slot: 'explore', propensity: 0.01, clicked: true }))!.weight).toBe(10);
  });
});
