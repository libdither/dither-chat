/**
 * The learning side of triage (docs/notifications.md, docs/triage-replay.md): per-chance label masks and numeric
 * features in the model, labels from what you did, and interaction features as of a moment.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { describe as say, emptyModel, features, lambda, predict, train, type Example, type Facts } from '../src/learn.ts';
import { ANSWER_WINDOW, Interactions, rateLogit, sinceScale } from '../src/interact.ts';
import { gatherOutcomes, implicitLabel, LABEL_WEIGHTS, type Outcome } from '../src/labels.ts';
import { ActivityStore } from '../src/activity.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 1, 9);

const facts = (f: Partial<Facts> = {}): Facts => ({
  network: 'signal',
  shape: 'group',
  conversation: 'c1',
  spaces: [],
  author: 'p1',
  bot: false,
  mention: false,
  everyone: false,
  reply: false,
  question: false,
  urgent: false,
  active: false,
  media: false,
  base: 'push',
  native: 'all',
  notify: true,
  score: 0.15,
  known: true,
  ...f,
});

// ------------------------------------------------------------------ the model

describe('label masks and numeric features', () => {
  test('an example teaches only the chances it labels', () => {
    const ex: Example[] = Array.from({ length: 5 }, () => ({ facts: facts(), words: [], y: { ping: 0 }, weight: 1, vote: false, at: T0 }));
    const m = train(ex);
    const p = predict(m, facts()).probs;
    expect(p.ping).toBeLessThan(0.5);
    expect(m.w.active).toEqual({});
    expect(m.w.interesting).toEqual({});
    // A vote still labels all three, from its level.
    const v = train([{ facts: facts(), words: [], label: 'digest', weight: 1, vote: true, at: T0 }]);
    expect(Object.keys(v.w.active).length).toBeGreaterThan(0);
  });

  test('numeric features: named apart, held by their own lambda, learned as one slope across places', () => {
    expect(features(facts(), [], { 'rr:conv': 2, engaged: 0 }).filter(([k]) => k.startsWith('#'))).toEqual([['#rr:conv', 2]]);
    expect(lambda('#rr:conv')).toBe(10);
    expect(lambda('#emb')).toBe(5);
    expect(lambda('#other')).toBe(10);
    expect(say('#rr:conv', { conversation: String, space: String, person: String, network: String })).toBe('How often you answer');
    // Places where you answer (rate +2) get answered; places where you do not (-3) do not.
    const ex: Example[] = [];
    for (let i = 0; i < 200; i++) {
      const answers = i % 2 === 0;
      ex.push({ facts: facts({ conversation: `c${i}` }), words: [], y: { ping: answers ? 1 : 0 }, x: { 'rr:conv': answers ? 2 : -3 }, weight: 1, vote: false, at: T0 });
    }
    const m = train(ex);
    expect(m.w.ping['#rr:conv']).toBeGreaterThan(0.3);
    const hi = predict(m, facts({ conversation: 'new' }), [], undefined, { 'rr:conv': 2 }).probs.ping;
    const lo = predict(m, facts({ conversation: 'new' }), [], undefined, { 'rr:conv': -3 }).probs.ping;
    expect(hi).toBeGreaterThan(0.8);
    expect(lo).toBeLessThan(0.5);
    // Without x the model is as before.
    expect(predict(emptyModel(), facts(), [], undefined, { 'rr:conv': 5 }).probs.ping).toBeCloseTo(0.9);
  });
});

// ------------------------------------------------------------------ labels from what you did

const outcome = (o: Partial<Outcome> = {}): Outcome => ({
  id: 'm',
  conv: 'c',
  ts: T0,
  engaged: false,
  seenLive: false,
  nextOwn: null,
  answered: false,
  reacted: false,
  decision: 'push',
  notified: false,
  shown: false,
  suppressed: false,
  dismissed: false,
  tapped: null,
  tapDwell: null,
  opened: null,
  openDwell: null,
  burstFirst: false,
  lullFirst: false,
  unprompted: false,
  addressed: false,
  observed: 2 * DAY,
  ...o,
});

describe('labels from what you did', () => {
  test('a quick answer when you were not there: worth a ping; while there, or later: worth seeing, ping unknown', () => {
    expect(implicitLabel(outcome({ answered: true, nextOwn: 5 * MIN }))).toMatchObject({ y: { ping: 1, active: 1, interesting: 1 }, weight: LABEL_WEIGHTS.quickAnswer });
    expect(implicitLabel(outcome({ answered: true, nextOwn: 5 * MIN, engaged: true }))!.y).toEqual({ active: 1, interesting: 1 });
    expect(implicitLabel(outcome({ answered: true, nextOwn: HOUR }))).toMatchObject({ y: { active: 1, interesting: 1 }, weight: LABEL_WEIGHTS.lateAnswer });
    expect(implicitLabel(outcome({ reacted: true }))!.y).toEqual({ active: 1, interesting: 1 });
    // Your next message answers another one: this one says nothing by that.
    expect(implicitLabel(outcome({ answered: false, nextOwn: 5 * MIN }))).toBeNull();
  });

  test('taps, bounces, dismissals and pushes nobody opened', () => {
    expect(implicitLabel(outcome({ notified: true, tapped: 2 * MIN, tapDwell: 40, opened: 2 * MIN }))!.y).toEqual({ ping: 1, active: 1, interesting: 1 });
    expect(implicitLabel(outcome({ notified: true, tapped: 2 * MIN, tapDwell: 2, opened: 2 * MIN }))!.y).toEqual({ ping: 0 });
    expect(implicitLabel(outcome({ notified: true, dismissed: true }))).toMatchObject({ y: { ping: 0 }, weight: LABEL_WEIGHTS.dismissed });
    const ignored = implicitLabel(outcome({ notified: true, shown: true }))!;
    expect(ignored).toMatchObject({ y: { ping: 0, active: 0 }, weight: LABEL_WEIGHTS.ignored });
    expect(ignored.knownAt).toBe(T0 + DAY);
    // Not yet a day: nothing to say about it being ignored.
    expect(implicitLabel(outcome({ notified: true, shown: true, observed: HOUR }))).toBeNull();
    // A page that was open kept it to itself: not ignored.
    expect(implicitLabel(outcome({ notified: true, shown: true, suppressed: true }))).toBeNull();
  });

  test('opens: unprompted ones say Active; an open alone, only interesting', () => {
    expect(implicitLabel(outcome({ unprompted: true, burstFirst: true, opened: 20 * MIN }))!.y).toEqual({ active: 1, interesting: 1 });
    expect(implicitLabel(outcome({ opened: 20 * MIN }))).toMatchObject({ y: { interesting: 1 }, weight: LABEL_WEIGHTS.openOnly });
  });

  test('nothing at all after the first of a burst: a weak no, unless it was about you', () => {
    expect(implicitLabel(outcome({ burstFirst: true }))).toMatchObject({ y: { ping: 0, active: 0 }, weight: LABEL_WEIGHTS.nothing });
    expect(implicitLabel(outcome({ burstFirst: true, addressed: true }))).toBeNull();
    expect(implicitLabel(outcome({ burstFirst: false }))).toBeNull();
    expect(implicitLabel(outcome({ burstFirst: true }), { ...LABEL_WEIGHTS, nothing: 0 })).toBeNull();
  });
});

// ------------------------------------------------------------------ interaction features

describe('interaction features, as of a moment', () => {
  const msg = (conv: string, ts: number, author: string | null, mine = false) => ({ conv, ts, author, mine });

  test('a message counts only once its window is over: answered if you wrote there in it', () => {
    const f = new Interactions();
    f.message(msg('dm', T0, 'ann'));
    // Before you answer, and before the window is over, nothing is known.
    expect(f.features('dm', 'ann', T0 + MIN)['rr:conv']).toBe(0);
    f.message(msg('dm', T0 + 2 * MIN, 'me', true));
    const after = f.features('dm', 'ann', T0 + 3 * MIN);
    expect(after['rr:conv']).toBeGreaterThan(0);
    expect(after['rr:author']).toBeGreaterThan(0);
    expect(after.engaged).toBe(1);
    expect(after.alt).toBeCloseTo(Math.log1p(1), 2);
    expect(f.features('dm', 'ann', T0 + 3 * HOUR).engaged).toBe(0);
  });

  test('a busy channel nobody answers sinks; unanswered counts once the window passes', () => {
    const f = new Interactions();
    for (let i = 0; i < 100; i++) f.message(msg('ch', T0 + i * MIN, `p${i % 7}`));
    const mid = f.features('ch', 'p1', T0 + 100 * MIN)['rr:conv'];
    expect(mid).toBeLessThan(-2);
    // The last half hour is still pending: a later look sees more of it.
    expect(f.features('ch', 'p1', T0 + 100 * MIN + ANSWER_WINDOW + MIN)['rr:conv']).toBeLessThan(mid);
    expect(rateLogit(0, 0, 0.05)).toBe(0);
    expect(sinceScale(null)).toBeGreaterThan(sinceScale(HOUR));
  });

  test('history arriving late does not count', () => {
    const f = new Interactions();
    f.message(msg('dm', T0 + DAY, 'ann'));
    f.message(msg('dm', T0, 'ann'));
    f.message(msg('dm', T0 + 2 * MIN, 'me', true));
    expect(f.features('dm', 'ann', T0 + 2 * DAY)['rr:conv']).toBeLessThan(0);
  });
});

// ------------------------------------------------------------------ through a store

describe('through the hub', () => {
  let dir: string;
  let store: Store;
  let acc: AccountRow;
  let activity: ActivityStore;
  let triage: Triage;
  let n = 0;
  const conv = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', nativeId)!.id;
  const post = (conversation: string, author: string, ts: number, x: { replyTo?: string; mentionsSelf?: boolean } = {}, decision: P.TriageDecision | null = 'push') => {
    const nativeId = `m${++n}`;
    store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts, body: 'words here', ...x }, live: true });
    const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
    if (decision && author !== 'me') store.setTriage(id, { decision, score: null, reasons: [], decidedBy: 'rules', probs: { ping: 0.9, active: 0.95, interesting: 0.99 } }, facts({ conversation: conv(conversation) }));
    return id;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-learning-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    acc = store.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true, displayName: 'Me' } });
    acc = store.accounts().find((x) => x.id === acc.id)!;
    store.ingest(acc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann', 'me'] } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'g', shape: 'group', name: 'Club', participants: ['ann', 'bo', 'cy', 'me'] } });
    activity = new ActivityStore(store, { featuresInTriage: true });
    activity.setSettings({ enabled: true, retentionDays: 365 });
    triage = new Triage(store, undefined, activity);
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('outcomes: which message your answer answers, being there already, reactions, bursts, taps', () => {
    const a1 = post('g', 'ann', T0);
    const a2 = post('g', 'bo', T0 + MIN);
    post('g', 'me', T0 + 3 * MIN);
    // Written while you were talking there; and you answer the earlier one by replying to it.
    const b1 = post('g', 'cy', T0 + 5 * MIN);
    const b2 = post('g', 'ann', T0 + 6 * MIN);
    post('g', 'me', T0 + 8 * MIN, { replyTo: store.one<{ native_id: string }>('SELECT native_id FROM message WHERE id = ?', b1)!.native_id });
    store.ingest(acc, { t: 'reaction', conversation: 'g', message: store.one<{ native_id: string }>('SELECT native_id FROM message WHERE id = ?', b2)!.native_id, author: 'me', key: '👍' });
    // Later, a push you tapped and read for a while.
    const c1 = post('dm', 'ann', T0 + 3 * HOUR);
    const nid = activity.notification({ kind: 'message', messageId: c1, conversationId: conv('dm') }, T0 + 3 * HOUR)!;
    activity.visits([{ id: 'v1', device: 'phone', view: 'conversation', conversationId: conv('dm'), start: T0 + 3 * HOUR + 2 * MIN, end: T0 + 3 * HOUR + 4 * MIN, active: 60, source: 'notification', pushId: nid }], T0 + 4 * HOUR);
    const o = gatherOutcomes(store.db, T0 - HOUR, T0 + DAY, { now: T0 + 2 * DAY });
    expect(o.get(a1)).toMatchObject({ answered: false, nextOwn: 3 * MIN, burstFirst: true, lullFirst: true, engaged: false });
    expect(o.get(a2)).toMatchObject({ answered: true, nextOwn: 2 * MIN, burstFirst: false });
    expect(o.get(b1)).toMatchObject({ answered: true, engaged: true });
    expect(o.get(b2)).toMatchObject({ answered: false, reacted: true });
    expect(o.get(c1)).toMatchObject({ notified: true, tapped: 2 * MIN, tapDwell: 60, opened: 2 * MIN });
    expect(implicitLabel(o.get(a2)!)!.y).toEqual({ ping: 1, active: 1, interesting: 1 });
    expect(implicitLabel(o.get(b1)!)!.y).toEqual({ active: 1, interesting: 1 });
    expect(implicitLabel(o.get(c1)!)!.why).toContain('tapped');
  });

  test('the features triage keeps with a decision include the interaction features', async () => {
    const id = post('dm', 'ann', T0 + 2 * DAY, {}, null);
    const d = (await triage.decide(id, T0 + 2 * DAY))!;
    expect(d.features?.x).toMatchObject({ engaged: 0 });
    expect(Object.keys(d.features!.x!)).toEqual(expect.arrayContaining(['rr:conv', 'rr:author', 'alt', 'since:seen', 'device:active', 'open:rate']));
    // The live decision does not use them.
    expect(d.decision).toBe('push');
  });
});
