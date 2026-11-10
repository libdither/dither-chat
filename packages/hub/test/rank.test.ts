/**
 * The inbox's learned order (rank.ts, rankhistory.ts, ranker.ts, docs/inbox.md): the prior orders as the formula,
 * the fit learns what you open, opens from far down count more, and the hub rebuilds your opens and refits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { ActivityStore } from '../src/activity.ts';
import { Attention, freshState, scoreConversation, type ScoreInput } from '../src/attention.ts';
import { examination, FEATURES, fitLogistic, fitRank, MAX_IPW, openWeight, predict, PRIOR, rankFeatures, type Moment, type RankRow } from '../src/rank.ts';
import { InboxRanker } from '../src/ranker.ts';
import { KEEP_RECENT, KEEP_SAMPLE, sample, type Seen } from '../src/rankhistory.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 9);

const input = (o: Partial<ScoreInput> = {}): ScoreInput => ({
  now: T0,
  shape: 'group',
  members: 8,
  lastMessageAt: T0 - HOUR,
  state: freshState(),
  author: null,
  authorName: null,
  unread: 0,
  mentions: 0,
  pinged: null,
  muted: null,
  usage: null,
  ...o,
});
const feats = (o: Partial<ScoreInput> = {}) => {
  const x = input(o);
  return rankFeatures(x, scoreConversation(x));
};

describe('the prior', () => {
  test('gives back the formula’s own score, so a fresh hub orders as today', () => {
    for (const o of [{}, { unread: 3 }, { shape: 'direct' as const, unread: 1 }, { lastMessageAt: T0 - 9 * DAY }, { usage: { score: 900, visitScore: 2, at: T0 - MIN, lastVisit: T0 - 20 * MIN } }]) {
      const x = input(o);
      const s = scoreConversation(x);
      expect(predict(PRIOR, rankFeatures(x, s)).points).toBeCloseTo(s.score, 0);
    }
  });

  test('about one open in six leads to a message', () => {
    expect(predict(PRIOR, feats()).send).toBeCloseTo(1 / 6, 1);
  });
});

describe('fitting', () => {
  const rows = (n: number, f: (i: number) => [Partial<ScoreInput>, 0 | 1]): RankRow[] =>
    Array.from({ length: n }, (_, i) => {
      const [o, y] = f(i);
      return { x: feats(o), y, w: 1 };
    });

  test('learns what you open on top of the formula, and stays at the prior without data', () => {
    // You open groups with a fresh message, whatever the formula says, and not the ones gone quiet.
    const fresh = { lastMessageAt: T0 - 5 * MIN };
    const quiet = { lastMessageAt: T0 - 3 * DAY };
    const data = rows(400, (i) => (i % 2 ? [fresh, i % 4 === 1 ? 1 : 0] : [quiet, 0]));
    const m = { ...PRIOR, open: fitLogistic(data, PRIOR.open) };
    const gap = (model: typeof PRIOR) => predict(model, feats(fresh)).open - predict(model, feats(quiet)).open;
    expect(gap(m)).toBeGreaterThan(gap(PRIOR) + 0.2);
    expect(predict(m, feats(fresh)).open).toBeGreaterThan(0.3);
    expect(fitLogistic([], PRIOR.open)).toEqual(PRIOR.open);
  });

  test('a few examples move it a little; many, more', () => {
    // You open DMs and not groups, all else alike.
    const one = (n: number) => fitLogistic(rows(n, (i) => (i % 2 ? [{ shape: 'direct' }, 1] : [{ shape: 'group' }, 0])), PRIOR.open).direct ?? 0;
    expect(one(4)).toBeGreaterThan(0);
    expect(one(4)).toBeLessThan(one(400) / 2);
  });
});

describe('seeing a row because it is listed', () => {
  test('rows further down are looked at less: an open from there counts more, up to a cap', () => {
    expect(examination(0)).toBe(1);
    expect(examination(3)).toBeCloseTo(0.5);
    expect(openWeight({ source: 'inbox', rank: 3 })).toBeCloseTo(2);
    expect(openWeight({ source: 'inbox', rank: 10_000 })).toBe(MAX_IPW);
    // Not from the inbox's list: where it was there does not matter.
    expect(openWeight({ source: 'notification', rank: null })).toBe(1);
    expect(openWeight(null)).toBe(1);
    // The replay tries other caps.
    expect(openWeight({ source: 'inbox', rank: 10_000 }, 0.5, 3)).toBe(3);
  });
});

describe('the horizon', () => {
  test('an open later than the horizon counts as not opened, so moments built wide can try shorter ones', () => {
    const fresh = feats({ lastMessageAt: T0 - 5 * MIN });
    const quiet = feats({ lastMessageAt: T0 - 3 * DAY });
    // Fresh ones are opened at once; quiet ones too, but only five hours later.
    const moments: Moment[] = Array.from({ length: 40 }, (_, i) => ({
      at: T0 + i * HOUR,
      rows: [
        { x: fresh, weight: 1, open: { source: 'notification', rank: null, after: 10 * MIN }, chosen: true, sent: false },
        { x: quiet, weight: 1, open: i % 2 ? { source: 'notification', rank: null, after: 5 * HOUR } : null, chosen: false },
      ],
    }));
    const gap = (h: number) => {
      const m = fitRank(moments, T0, { horizon: h });
      return predict(m, fresh).open - predict(m, quiet).open;
    };
    expect(gap(HOUR)).toBeGreaterThan(gap(6 * HOUR));
    // Within six hours both kinds were opened; within one, only the fresh ones.
    expect(fitRank(moments, T0, { horizon: 6 * HOUR }).rows).toBe(80);
  });
});

describe('sampling a moment', () => {
  test('keeps what was opened, the most recent, and a sample of the rest that stands for all of it', () => {
    const seen = Array.from({ length: 200 }, (_, i) => ({ conv: { id: `c${i}` }, input: input({ lastMessageAt: T0 - i * MIN }), lastThere: null }) as unknown as Seen);
    const opened = new Map([['c150', {}]]);
    const s = sample(seen, opened, T0);
    expect(s.find((x) => x.seen.conv.id === 'c150')?.weight).toBe(1);
    expect(s.filter((x) => x.weight === 1).length).toBe(1 + KEEP_RECENT);
    expect(s.length).toBe(1 + KEEP_RECENT + KEEP_SAMPLE);
    // The sample counts for the whole rest.
    expect(s.filter((x) => x.weight > 1).reduce((a, x) => a + x.weight, 0)).toBeCloseTo(200 - 1 - KEEP_RECENT);
    expect(sample(seen, opened, T0).map((x) => x.seen.conv.id)).toEqual(s.map((x) => x.seen.conv.id));
  });
});

// ------------------------------------------------------------------ in the hub

describe('the hub learns from your opens', () => {
  let dir: string;
  let store: Store;
  let acc: AccountRow;
  let activity: ActivityStore;
  let n = 0;
  const NOW = T0 + 10 * DAY;
  const cid = (native: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', native)!.id;
  const say = (conversation: string, author: string, ts: number) =>
    store.ingest(acc, { t: 'message', message: { nativeId: `m${++n}`, conversation, author, ts, body: '' }, live: true });
  const open = (conversation: string, start: number, extra: Partial<P.VisitRecord> = {}) =>
    activity.visits([{ id: `v${++n}`, device: 'd1', view: 'conversation', conversationId: cid(conversation), start, end: start + 2 * MIN, active: 60, source: 'inbox', rank: 12, closed: true, ...extra }], NOW);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-rank-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    acc = store.createAccount({ network: 'matrix', label: 'a', color: '#000', adapter: 'matrix' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    acc = store.account(acc.id)!;
    for (const who of ['sam', 'kim', 'lee']) store.ingest(acc, { t: 'identity', identity: { nativeId: who, displayName: who, contact: true } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['me', 'sam'] } });
    for (const g of ['climb', 'work', 'news', 'band', 'film']) store.ingest(acc, { t: 'conversation', conversation: { nativeId: g, shape: 'group', name: g, participants: ['me', 'kim', 'lee'] } });
    activity = new ActivityStore(store);
    // Eight days: everyone talks; you answer Sam, and every day you open "climb" an hour after it speaks, from far down.
    for (let d = 0; d < 8; d++) {
      const day = T0 + d * DAY;
      say('dm', 'sam', day + HOUR);
      say('dm', 'me', day + HOUR + 5 * MIN);
      for (const [i, g] of ['work', 'news', 'band', 'film'].entries()) say(g, 'kim', day + (2 + i) * HOUR);
      say('climb', 'lee', day + 7 * HOUR);
      open('climb', day + 8 * HOUR);
      open('dm', day + HOUR + 2 * MIN, { source: 'notification', rank: null, sent: 1 });
    }
    store.flush();
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a fresh ranker is the prior, and wants to learn once opens have had their horizon', () => {
    const r = new InboxRanker(store, new Triage(store), 'model', undefined, () => NOW);
    expect(r.model).toEqual(PRIOR);
    expect(r.due()).toBe(true);
  });

  test('it refits from the log, a little at a time, and the place you keep opening moves up', async () => {
    let now = NOW;
    const triage = new Triage(store);
    const r = new InboxRanker(store, triage, 'model', join(dir, 'hub.sqlite'), () => now);
    const att = new Attention(store, triage, () => now);
    att.judge = r;
    // The next day, an hour after "climb" spoke, as on every other day.
    now = T0 + 8 * DAY + 8 * HOUR;
    say('climb', 'lee', now - HOUR);
    for (const [i, g] of ['work', 'news', 'band', 'film'].entries()) say(g, 'kim', now - (6 - i) * HOUR);
    store.flush();
    while (att.pump() > 0);
    const before = att.explain(cid('climb'))!;
    let fits = 0;
    r.onFit = () => fits++;
    const m = await r.refit({ stepMs: 1, pauseMs: 0 });
    expect(fits).toBe(1);
    expect(m.moments).toBeGreaterThan(10);
    expect(r.due()).toBe(false);
    att.rescoreAll(now);
    const rankOf = (score: (id: string) => number) => ['climb', 'work', 'news', 'band', 'film'].sort((a, b) => score(cid(b)) - score(cid(a))).indexOf('climb');
    const formula = rankOf((id) => att.explain(id)!.score);
    const learned = rankOf((id) => att.view(id)!.score);
    expect(learned).toBeLessThanOrEqual(formula);
    expect((att.explain(cid('climb'))!.learned as any).open).toBeGreaterThan((before.learned as any).open);
    // Saved: a new ranker starts from what was learned.
    expect(new InboxRanker(store, triage, 'model', undefined, () => now).model).toEqual(m);
  });

  test('shadow works it out and shows it, but the inbox keeps the formula; off does neither', () => {
    const triage = new Triage(store);
    for (const mode of ['shadow', 'off'] as const) {
      const att = new Attention(store, triage, () => NOW);
      att.judge = new InboxRanker(store, triage, mode, undefined, () => NOW);
      att.rescoreAll(NOW);
      const id = cid('climb');
      expect(att.view(id)!.score).toBeCloseTo(att.explain(id)!.score, 1);
      expect(att.explain(id)!.learned).toEqual(mode === 'shadow' ? expect.objectContaining({ mode: 'shadow' }) : null);
    }
  });

  test('the model as weights on named features, and back to the prior when the log is cleared', async () => {
    const triage = new Triage(store);
    const r = new InboxRanker(store, triage, 'model', undefined, () => NOW);
    const v = r.view();
    expect(Object.keys(v.learned.open).every((k) => (FEATURES as readonly string[]).includes(k))).toBe(true);
    activity.clear();
    expect(r.due()).toBe(true);
    expect((await r.refit({ stepMs: 5, pauseMs: 0 })).moments).toBe(0);
    expect(r.model.open).toEqual(PRIOR.open);
    expect(r.due()).toBe(false);
  });
});

