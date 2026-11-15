/**
 * The chance a turn needs a reply (needsreply.ts, docs/inbox.md "Needs a reply"): message facts, the logistic model
 * and its calibration, the measures (calibration.ts), and the hub fitting it on its own turns, showing it on a row
 * and keeping a calibration record. Invented people and messages only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Attention, emptyTally, record, scoreConversation, type ConvState, type ScoreInput } from '../src/attention.ts';
import { auc, brier, logLoss, reliability } from '../src/calibration.ts';
import {
  applyPlatt,
  fitLogistic,
  fitShapeSteps,
  IDENTITY_PLATT,
  lateRate,
  messageFeatures,
  needsChance,
  needsExamplesSteps,
  NEEDS_FEATURES,
  needsFeatures,
  platt,
  predict,
  validNeedsModel,
  type NeedsModel,
  type TurnFacts,
} from '../src/needsreply.ts';
import { DEFAULT_OWED_TABLE, type OwedTurn } from '../src/owed.ts';
import { whole } from '../src/slices.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1, 9);

/** A small deterministic random source. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('message facts', () => {
  const f = (body: string, kind = 'text', atMe = false) => messageFeatures({ body, kind, atMe });

  test('a question, a link, media, and closers that seldom want an answer', () => {
    expect(f('are you around tonight?')).toMatchObject({ q: true, link: false, media: false, closer: false, atMe: false });
    expect(f('look https://example.com/a')).toMatchObject({ link: true, q: false });
    expect(f('', 'media').media).toBe(true);
    expect(f('', 'sticker').media).toBe(true);
    for (const c of ['ok', 'Thanks!', 'lol', 'haha', 'sounds good', '👍', '😂😂']) expect(f(c).closer).toBe(true);
    for (const c of ['ok so what time should we leave tomorrow', 'thanks, can you also send the notes?']) expect(f(c).closer).toBe(false);
    expect(f('hey', 'text', true).atMe).toBe(true);
    expect(f('four').len).toBe(4);
  });
});

describe('features', () => {
  const now = T0 + 100 * DAY;
  /** `answered` of `of` turns answered, each after `latency`. */
  const habit = (answered: number, of: number, latency: number) => {
    const t = emptyTally();
    for (let i = 0; i < of; i++) record(t, now - (i + 1) * DAY, i < answered ? latency : null);
    return t;
  };

  test('how often turns still open at an age were answered, from the latency histogram', () => {
    // Half answered within 10 minutes, half never: once an hour has gone by without one, none came.
    expect(lateRate(habit(5, 10, 10 * MIN), HOUR, 0.5, 0.0001)).toBeCloseTo(0, 2);
    // All answered within 10 minutes: none were still open at an hour, so nothing is known there but the prior.
    expect(lateRate(habit(10, 10, 10 * MIN), HOUR, 0.5)).toBeCloseTo(0.5, 5);
    // Every answer after 6 hours: at an hour, all still answered.
    expect(lateRate(habit(10, 10, 6 * HOUR), HOUR, 0.5, 0.0001)).toBeCloseTo(1, 2);
    // Nothing known: the prior.
    expect(lateRate(null, HOUR, 0.4)).toBe(0.4);
  });

  test('one per name, in order; nothing past the window, the table without a model', () => {
    const facts: TurnFacts = { shape: 'direct', kind: 'direct', age: HOUR, tableChance: 0.7, conv: null, person: null, messages: [messageFeatures({ body: 'free later?', kind: 'text', atMe: false })], authorKey: 'p' };
    const x = needsFeatures(facts);
    expect(x).toHaveLength(NEEDS_FEATURES.length);
    expect(x[NEEDS_FEATURES.indexOf('msg:question')]).toBe(1);
    expect(needsChance(null, facts)).toBe(0.7);
    expect(needsChance(null, { ...facts, tableChance: 0 })).toBe(0);
  });
});

describe('the logistic model and its calibration', () => {
  test('learns the direction of each input, and gives calibrated chances', () => {
    const r = rng(1);
    const xs: number[][] = [];
    const ys: boolean[] = [];
    for (let i = 0; i < 4000; i++) {
      const a = r() * 4 - 2;
      const b = r();
      xs.push([a, b]);
      ys.push(r() < 1 / (1 + Math.exp(-(1.5 * a - 2 * b + 0.3))));
    }
    const m = fitLogistic(xs, ys, { l2: 0.1 });
    expect(m.w[0]).toBeGreaterThan(0);
    expect(m.w[1]).toBeLessThan(0);
    const ps = xs.map((x, i) => ({ p: predict(m, x), y: ys[i] }));
    for (const b of reliability(ps, 5)) if (b.n > 200) expect(Math.abs(b.predicted - b.actual)).toBeLessThan(0.06);
  });

  test('Platt: leaves calibrated chances about as they are, pulls overconfident ones in, and stays put with too little', () => {
    const r = rng(2);
    const ps: number[] = [];
    const ys: boolean[] = [];
    for (let i = 0; i < 3000; i++) {
      const p = 0.05 + 0.9 * r();
      ps.push(p);
      ys.push(r() < p);
    }
    const same = platt(ps, ys);
    expect(Math.abs(same.a - 1)).toBeLessThan(0.15);
    expect(Math.abs(same.b)).toBeLessThan(0.15);
    // Chances pushed toward the ends: the step pulls them back in.
    const sharp = ps.map((p) => 1 / (1 + Math.exp(-3 * Math.log(p / (1 - p)))));
    const c = platt(sharp, ys);
    expect(c.a).toBeLessThan(0.6);
    expect(applyPlatt(c, 0.95)).toBeLessThan(0.9);
    expect(platt([0.5, 0.6], [true, false])).toEqual(IDENTITY_PLATT);
  });

  test('the measures: AUC, log loss, Brier and the bins', () => {
    const xs = [
      { p: 0.9, y: true },
      { p: 0.8, y: true },
      { p: 0.3, y: false },
      { p: 0.6, y: false },
    ];
    expect(auc(xs)).toBe(1);
    expect(auc([{ p: 0.2, y: true }, { p: 0.8, y: false }])).toBe(0);
    expect(brier([{ p: 1, y: true }])).toBe(0);
    expect(brier([{ p: 0.5, y: false }])).toBe(0.25);
    expect(logLoss([{ p: 0.5, y: true }])).toBeCloseTo(Math.log(2), 5);
    const bins = reliability(xs, 2);
    expect(bins.map((b) => b.n)).toEqual([1, 3]);
    expect(bins[1].actual).toBeCloseTo(2 / 3, 5);
  });
});

/** Invented turns from two people: one you answer when they ask something, one whose "ok"s you leave. */
function invented(n: number) {
  const r = rng(3);
  const turns: (OwedTurn & { question: boolean })[] = [];
  for (let i = 0; i < n; i++) {
    const addressed = T0 + i * 6 * HOUR;
    const question = r() < 0.5;
    const answered = question ? r() < 0.9 : r() < 0.15;
    turns.push({ conversationId: i % 2 ? 'c1' : 'c2', shape: 'direct', authorKey: i % 2 ? 'p1' : 'p2', addressed, answeredAt: answered ? addressed + (1 + r() * 8) * HOUR : null, timed: true, question });
  }
  return turns;
}

describe('fitting on turns', () => {
  test('learns that a question is answered and a closer is not, from the turns and their messages', () => {
    const turns = invented(800);
    const now = T0 + 800 * 6 * HOUR + 10 * DAY;
    const exs = whole(
      needsExamplesSteps(turns, {
        now,
        table: DEFAULT_OWED_TABLE,
        pick: () => true,
        messages: (t) => ({ kind: 'direct', messages: [{ ts: t.addressed, ...messageFeatures({ body: (t as any).question ? 'can you come?' : 'ok', kind: 'text', atMe: false, authorKey: t.authorKey }) }] }),
      }),
    );
    expect(exs.length).toBeGreaterThan(800);
    // Each example is a turn still open at its age.
    expect(exs.every((e) => e.turn.answeredAt === null || e.turn.answeredAt - e.turn.addressed > e.age)).toBe(true);
    const m = whole(fitShapeSteps(exs, now))!;
    expect(m.turns).toBe(800);
    const at = (question: boolean) =>
      applyPlatt(
        m.platt,
        predict(m.model, needsFeatures({ shape: 'direct', kind: 'direct', age: 2 * HOUR, tableChance: 0.6, conv: null, person: null, messages: [messageFeatures({ body: question ? 'can you come?' : 'ok', kind: 'text', atMe: false })], authorKey: 'p1' })),
      );
    expect(at(true)).toBeGreaterThan(0.6);
    expect(at(false)).toBeLessThan(0.3);
    // Too few turns: none, and the table stands.
    expect(whole(fitShapeSteps(exs.filter((e) => e.turn.addressed < T0 + 50 * 6 * HOUR), now))).toBeNull();
  });
});

describe('in the hub', () => {
  let dir: string;
  let store: Store;
  let att: Attention;
  let acc: AccountRow;
  let clock = T0;
  let n = 0;
  const say = (conversation: string, author: string, ts: number, body: string) => {
    store.ingest(acc, { t: 'message', message: { nativeId: `m${++n}`, conversation, author, ts, body }, live: true });
  };
  const cid = (native: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', native)!.id;
  const settle = () => {
    store.flush();
    while (att.pump(100_000, 10_000) > 0);
  };
  const quick = { clock: () => 0, budgetMs: 0, pause: async () => {} };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-needsreply-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    acc = store.createAccount({ network: 'matrix', label: 'a', color: '#000', adapter: 'matrix' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    acc = store.account(acc.id)!;
    for (const who of ['ari', 'bo', 'cy', 'di']) {
      store.ingest(acc, { t: 'identity', identity: { nativeId: who, displayName: who, contact: true } });
      store.ingest(acc, { t: 'conversation', conversation: { nativeId: `dm-${who}`, shape: 'direct', participants: ['me', who] } });
    }
    att = new Attention(store, new Triage(store), () => clock);
    // Two years of turns, each person every four days (so each message starts a turn of its own): Ari and Cy ask and
    // get an answer; Bo and Di sign off and do not.
    const r = rng(4);
    for (let i = 0; i < 720; i++) {
      const at = T0 + i * DAY;
      const who = ['ari', 'bo', 'cy', 'di'][i % 4];
      const asks = who === 'ari' || who === 'cy';
      say(`dm-${who}`, who, at, asks ? 'can you check this later?' : 'ok thanks');
      if (asks ? r() < 0.9 : r() < 0.1) say(`dm-${who}`, 'me', at + (1 + 6 * r()) * HOUR, 'sure');
    }
    clock = T0 + 725 * DAY;
    settle();
    att.rescoreAll(clock);
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('fits on its own turns in slices, keeps the model for the next start', async () => {
    att.fitOwed(clock);
    const m = await att.fitNeeds(clock, quick);
    expect(m?.shapes.direct?.turns).toBeGreaterThan(600);
    expect(att.needsModel).toBe(m);
    const again = new Attention(store, new Triage(store), () => clock);
    expect(validNeedsModel(again.needsModel)).toBe(true);
    expect(again.needsModel?.fittedAt).toBe(clock);
  });

  test('an open turn shows its chance on the row and in the reasons; a question more than a closer', () => {
    clock += 2 * DAY;
    say('dm-ari', 'ari', clock - 20 * MIN, 'are you coming on friday?');
    say('dm-bo', 'bo', clock - 20 * MIN, 'lol ok');
    settle();
    att.rescoreAll(clock);
    const ari = att.view(cid('dm-ari'))!;
    const bo = att.view(cid('dm-bo'))!;
    expect(ari.owedSince).toBe(clock - 20 * MIN);
    expect(ari.needsReply).toBeGreaterThan(bo.needsReply ?? 0);
    expect(ari.needsReply! * 20).toBeCloseTo(Math.round(ari.needsReply! * 20), 6);
    expect(ari.reasons.some((x) => x.includes(`Likely needs a reply: ${Math.round(ari.needsReply! * 100)}%`))).toBe(true);
    const e = att.explain(cid('dm-ari')) as any;
    expect(e.owed.needs.chance).toBeCloseTo(e.owed.chance, 6);
    expect(e.owed.table.chance).toBeGreaterThan(0);
  });

  test('keeps the chance shown at 15 minutes for the calibration record, once, and scores it once the window is over', () => {
    const rows = store.raw('SELECT conversation_id, age, p, table_p FROM needs_prediction') as { conversation_id: string; age: number; p: number }[];
    expect(rows.filter((x) => x.age === 15 * MIN && [cid('dm-ari'), cid('dm-bo')].includes(x.conversation_id)).map((x) => x.conversation_id).sort()).toEqual([cid('dm-ari'), cid('dm-bo')].sort());
    att.rescoreAll(clock + MIN);
    expect((store.raw('SELECT COUNT(*) AS n FROM needs_prediction') as { n: number }[])[0].n).toBe(rows.length);
    // Still inside the window: nothing to score yet.
    expect(att.needsCalibration(clock).n).toBe(0);
    // You answer Ari; Bo's runs out.
    say('dm-ari', 'me', clock + HOUR, 'yes');
    clock += 4 * DAY;
    say('dm-bo', 'bo', clock, 'hey');
    settle();
    const rep = att.needsCalibration(clock);
    expect(rep.n).toBe(2);
    expect(rep.days).toHaveLength(1);
    expect(rep.days[0].answered).toBe(1);
    expect(rep.brier).toBeGreaterThanOrEqual(0);
    expect(rep.bins.reduce((a, b) => a + b.n, 0)).toBe(2);
    expect(rep.model.turns.direct).toBeGreaterThan(600);
  });

  test('a mark overrides it: "Reply needed" holds the chance at 1 and shows no percentage', () => {
    const state: ConvState = JSON.parse(store.one<{ state: string }>('SELECT state FROM conv_feature WHERE conversation_id = ?', cid('dm-bo'))!.state);
    const x: ScoreInput = {
      now: clock + HOUR,
      shape: 'direct',
      members: 2,
      lastMessageAt: clock,
      state: { ...state, turn: { ...state.turn!, held: clock } },
      author: null,
      authorName: 'Bo',
      unread: 0,
      mentions: 0,
      pinged: null,
      muted: null,
      usage: null,
      needsModel: att.needsModel as NeedsModel,
      turnMessages: [],
    };
    const s = scoreConversation(x);
    expect(s.owed?.chance).toBe(1);
    expect(s.needsReply).toBeNull();
    expect(s.reasons[0].startsWith('You marked it Reply needed')).toBe(true);
  });
});
