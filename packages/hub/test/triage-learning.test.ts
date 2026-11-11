/**
 * The learning side of triage (docs/notifications.md, docs/triage-replay.md): per-chance label masks and numeric
 * features in the model, labels from what you did (they speak of importance only), and interaction features as of a
 * moment.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { describe as say, emptyModel, features, lambda, predict, train, type Example, type Facts } from '../src/learn.ts';
import { ANSWER_WINDOW, Interactions, rateLogit, sinceScale } from '../src/interact.ts';
import { gatherOutcomes, IGNORED_AFTER, implicitLabel, LABEL_WEIGHTS, LATE, OPEN_DWELL, type LabelWeights, type Outcome } from '../src/labels.ts';
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
  base: 'drop',
  native: 'all',
  notify: true,
  score: 0.15,
  known: true,
  ...f,
});

// ------------------------------------------------------------------ the model

describe('label masks and numeric features', () => {
  test('an example teaches only the chances it labels', () => {
    const ex: Example[] = Array.from({ length: 5 }, () => ({ facts: facts(), words: [], y: { important: 0 }, weight: 1, vote: false, at: T0 }));
    const m = train(ex);
    const p = predict(m, facts()).probs;
    expect(p.important).toBeLessThan(0.5);
    expect(m.w.alert).toEqual({});
    // What you did never says a message could not wait; a mark can.
    const marked = train([{ facts: facts({ judge: 0.1 }), words: [], y: { alert: 1 }, weight: 1, vote: true, at: T0 }]);
    expect(Object.keys(marked.w.alert).length).toBeGreaterThan(0);
    expect(marked.w.important).toEqual({});
    // A vote from before the tiers labels importance, from its level, and nothing else.
    const v = train([{ facts: facts(), words: [], label: 'digest', weight: 1, vote: true, at: T0 }]);
    expect(Object.keys(v.w.important).length).toBeGreaterThan(0);
    expect(v.w.alert).toEqual({});
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
      ex.push({ facts: facts({ conversation: `c${i}` }), words: [], y: { important: answers ? 1 : 0 }, x: { 'rr:conv': answers ? 2 : -3 }, weight: 1, vote: false, at: T0 });
    }
    const m = train(ex);
    expect(m.w.important['#rr:conv']).toBeGreaterThan(0.3);
    expect(m.w.alert['#rr:conv']).toBeUndefined();
    const hi = predict(m, facts({ conversation: 'new' }), [], undefined, { 'rr:conv': 2 }).probs.important;
    const lo = predict(m, facts({ conversation: 'new' }), [], undefined, { 'rr:conv': -3 }).probs.important;
    expect(hi).toBeGreaterThan(0.8);
    expect(lo).toBeLessThan(0.5);
    // Without what it learned the feature moves nothing: the start is the start.
    expect(predict(emptyModel(), facts(), [], undefined, { 'rr:conv': 5 }).probs.important).toBeCloseTo(0.8);
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
  decision: 'digest',
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
  /** With the two "you did not" labels on, as the replay tried them. */
  const both: LabelWeights = { ...LABEL_WEIGHTS, dismissed: 0.3, nothing: 0.2 };

  test('only what you did counts by default, and it says importance, never alert', () => {
    expect(LABEL_WEIGHTS).toEqual({ answered: 0.5, opened: 0.5, dismissed: 0, nothing: 0 });
    const said = [
      outcome({ answered: true, nextOwn: 5 * MIN }),
      outcome({ reacted: true }),
      outcome({ notified: true, tapped: 2 * MIN, tapDwell: 40, opened: 2 * MIN }),
      outcome({ opened: 20 * MIN, openDwell: 30 }),
      outcome({ notified: true, dismissed: true }),
      outcome({ burstFirst: true }),
    ].map((o) => implicitLabel(o, both)!);
    expect(said.map((l) => Object.keys(l.y))).toEqual(Array(6).fill(['important']));
    expect(said.map((l) => l.y.important)).toEqual([1, 1, 1, 1, 0, 0]);
  });

  test('you answered it within three hours, or reacted to it: important, there already or not', () => {
    expect(implicitLabel(outcome({ answered: true, nextOwn: 5 * MIN }))).toEqual({ y: { important: 1 }, weight: LABEL_WEIGHTS.answered, why: ['answered'], knownAt: T0 + 5 * MIN });
    expect(implicitLabel(outcome({ answered: true, nextOwn: LATE }))!.y).toEqual({ important: 1 });
    // While you were talking there, or watching it arrive: an answer is still an answer.
    expect(implicitLabel(outcome({ answered: true, nextOwn: 5 * MIN, engaged: true }))!.y).toEqual({ important: 1 });
    expect(implicitLabel(outcome({ answered: true, nextOwn: 5 * MIN, seenLive: true }))!.why).toEqual(['answered']);
    // A reaction carries no time: it is known once an answer could have come.
    expect(implicitLabel(outcome({ reacted: true }))).toEqual({ y: { important: 1 }, weight: LABEL_WEIGHTS.answered, why: ['reacted'], knownAt: T0 + LATE });
    // Later than three hours is no answer to it; nor is your next message when it answers another one.
    expect(implicitLabel(outcome({ answered: true, nextOwn: LATE + MIN }))).toBeNull();
    expect(implicitLabel(outcome({ answered: false, nextOwn: 5 * MIN }))).toBeNull();
    // Turned off, it says nothing.
    expect(implicitLabel(outcome({ answered: true, nextOwn: 5 * MIN }), { ...LABEL_WEIGHTS, answered: 0 })).toBeNull();
  });

  test('you tapped its notification, or opened its chat within a day, and stayed: important', () => {
    expect(implicitLabel(outcome({ notified: true, tapped: 2 * MIN, tapDwell: 40, opened: 2 * MIN }))).toEqual({ y: { important: 1 }, weight: LABEL_WEIGHTS.opened, why: ['tapped'], knownAt: T0 + 2 * MIN });
    expect(implicitLabel(outcome({ opened: 20 * MIN, openDwell: OPEN_DWELL }))).toEqual({ y: { important: 1 }, weight: LABEL_WEIGHTS.opened, why: ['opened'], knownAt: T0 + 20 * MIN });
    expect(implicitLabel(outcome({ opened: IGNORED_AFTER, openDwell: 60 }))!.why).toEqual(['opened']);
    // How long you stayed is not always known: an open still counts.
    expect(implicitLabel(outcome({ opened: 20 * MIN }))!.y).toEqual({ important: 1 });
    // A bounce (in and out in under five seconds), and an open more than a day later, say nothing.
    expect(implicitLabel(outcome({ notified: true, tapped: 2 * MIN, tapDwell: 2, opened: 2 * MIN, openDwell: 2 }))).toBeNull();
    expect(implicitLabel(outcome({ opened: 20 * MIN, openDwell: OPEN_DWELL - 1 }))).toBeNull();
    expect(implicitLabel(outcome({ opened: IGNORED_AFTER + MIN, openDwell: 60 }))).toBeNull();
    // You were already there (talking, watching, or a page kept the notification to itself): nothing to learn.
    for (const there of [{ engaged: true }, { seenLive: true }, { suppressed: true }]) expect(implicitLabel(outcome({ ...there, opened: MIN, openDwell: 60 }), both)).toBeNull();
    expect(implicitLabel(outcome({ opened: 20 * MIN, openDwell: 30 }), { ...LABEL_WEIGHTS, opened: 0 })).toBeNull();
  });

  test('a swipe is no label by default; with a weight, only a list row swiped away and left for a day says "not this"', () => {
    const swiped = outcome({ notified: true, shown: true, dismissed: true });
    expect(implicitLabel(swiped)).toBeNull();
    expect(implicitLabel(swiped, both)).toEqual({ y: { important: 0 }, weight: 0.3, why: ['dismissed'], knownAt: T0 + IGNORED_AFTER });
    // A Conversation row or an alert swiped away says you saw it, not that it did not matter.
    expect(implicitLabel(outcome({ ...swiped, decision: 'quiet' }), both)).toBeNull();
    expect(implicitLabel(outcome({ ...swiped, decision: 'push' }), both)).toBeNull();
    // Not yet a day: you may still open it. And if you did, that wins.
    expect(implicitLabel(outcome({ ...swiped, observed: HOUR }), both)).toBeNull();
    expect(implicitLabel(outcome({ ...swiped, opened: 2 * HOUR, openDwell: 20 }), both)!.y).toEqual({ important: 1 });
  });

  test('"nothing happened" is no label by default; with a weight, the first of a burst nobody touched is a weak no, unless it was about you', () => {
    expect(implicitLabel(outcome({ burstFirst: true }))).toBeNull();
    expect(implicitLabel(outcome({ burstFirst: true }), both)).toEqual({ y: { important: 0 }, weight: 0.2, why: ['nothing happened'], knownAt: T0 + IGNORED_AFTER });
    expect(implicitLabel(outcome({ burstFirst: true, addressed: true }), both)).toBeNull();
    expect(implicitLabel(outcome({ burstFirst: false }), both)).toBeNull();
    expect(implicitLabel(outcome({ burstFirst: true, observed: HOUR }), both)).toBeNull();
    // You wrote there later, or opened it after the day: something did happen.
    expect(implicitLabel(outcome({ burstFirst: true, nextOwn: 5 * HOUR }), both)).toBeNull();
    expect(implicitLabel(outcome({ burstFirst: true, opened: 2 * DAY }), both)).toBeNull();
    // A swipe counts before it.
    expect(implicitLabel(outcome({ burstFirst: true, dismissed: true }), both)!.why).toEqual(['dismissed']);
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
    if (decision && author !== 'me') store.setTriage(id, { decision, score: 0.8, reasons: [], decidedBy: 'rules', probs: { alert: 0.02, important: 0.8 } }, facts({ conversation: conv(conversation) }));
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
    triage = new Triage(store, activity);
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
    // What each says: the one you answered, the one you answered while there, the one you reacted to, the one you tapped.
    expect(implicitLabel(o.get(a2)!)).toMatchObject({ y: { important: 1 }, why: ['answered'], knownAt: T0 + 3 * MIN });
    expect(implicitLabel(o.get(b1)!)).toMatchObject({ y: { important: 1 }, why: ['answered'] });
    expect(implicitLabel(o.get(b2)!)).toMatchObject({ y: { important: 1 }, why: ['reacted'] });
    expect(implicitLabel(o.get(c1)!)).toMatchObject({ y: { important: 1 }, why: ['tapped'], weight: LABEL_WEIGHTS.opened });
    // The first of the burst, which your message did not answer: nothing, with or without the "you did not" labels.
    expect(implicitLabel(o.get(a1)!)).toBeNull();
    expect(implicitLabel(o.get(a1)!, { ...LABEL_WEIGHTS, nothing: 0.2 })).toBeNull();
  });

  test('outcomes: a list row swiped away and never opened, and a burst nobody touched', () => {
    const base = T0 + 10 * DAY;
    const swiped = post('g', 'bo', base, {}, 'digest');
    const nid = activity.notification({ kind: 'message', messageId: swiped, conversationId: conv('g') }, base)!;
    activity.events([{ id: nid, device: 'phone', event: 'dismissed', at: base + MIN }], base + MIN);
    const quiet = post('g', 'cy', base + 2 * HOUR, {}, 'drop');
    const o = gatherOutcomes(store.db, base - HOUR, base + DAY, { now: base + 3 * DAY });
    expect(o.get(swiped)).toMatchObject({ decision: 'digest', notified: true, dismissed: true, opened: null, nextOwn: null, burstFirst: true });
    expect(o.get(quiet)).toMatchObject({ decision: 'drop', notified: false, dismissed: false, burstFirst: true });
    // Neither is a label as the hub learns; with their weights given, both are a no.
    expect(implicitLabel(o.get(swiped)!)).toBeNull();
    expect(implicitLabel(o.get(quiet)!)).toBeNull();
    const w = { ...LABEL_WEIGHTS, dismissed: 0.3, nothing: 0.2 };
    expect(implicitLabel(o.get(swiped)!, w)).toMatchObject({ y: { important: 0 }, why: ['dismissed'], weight: 0.3 });
    expect(implicitLabel(o.get(quiet)!, w)).toMatchObject({ y: { important: 0 }, why: ['nothing happened'], weight: 0.2 });
    // Before the day is over nothing is known of either.
    const early = gatherOutcomes(store.db, base - HOUR, base + DAY, { now: base + 3 * HOUR });
    expect(implicitLabel(early.get(swiped)!, w)).toBeNull();
    expect(implicitLabel(early.get(quiet)!, w)).toBeNull();
  });

  test('the features triage keeps with a decision include the interaction features', async () => {
    const id = post('dm', 'ann', T0 + 2 * DAY, {}, null);
    const d = (await triage.decide(id, T0 + 2 * DAY))!;
    expect(d.features?.x).toMatchObject({ engaged: 0 });
    expect(Object.keys(d.features!.x!)).toEqual(expect.arrayContaining(['rr:conv', 'rr:author', 'alt', 'since:seen', 'device:active', 'open:rate']));
    // The live decision does not use them: a DM nobody read for urgency is a Conversation.
    expect(d.decision).toBe('quiet');
    expect(d.facts).toMatchObject({ conv: true, shape: 'direct' });
    expect(d.probs).toEqual({ alert: 0.02, important: 0.8 });
  });
});
