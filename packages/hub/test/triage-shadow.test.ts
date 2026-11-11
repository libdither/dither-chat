/**
 * The shadow model (docs/notifications.md, shadow.ts, votes.ts): a candidate trained next to the live model and kept
 * with it, its two chances stored with every decision while the live model decides, and what it would have put on the
 * list against what was put there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { emptyModel, validModel, type Facts, type Model } from '../src/learn.ts';
import { shadowSummary } from '../src/shadow.ts';
import { ActivityStore } from '../src/activity.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { TriageVotes } from '../src/votes.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
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

describe('through the hub', () => {
  let dir: string;
  let store: Store;
  let acc: AccountRow;
  let activity: ActivityStore;
  let triage: Triage;
  let votes: TriageVotes;
  let n = 0;
  const conv = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', nativeId)!.id;
  const post = (conversation: string, author: string, ts: number, decision: P.TriageDecision | null = 'quiet') => {
    const nativeId = `m${++n}`;
    store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts, body: 'words here' }, live: true });
    const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
    if (decision && author !== 'me') store.setTriage(id, { decision, score: 0.8, reasons: [], decidedBy: 'rules', probs: { alert: 0.02, important: 0.8 } }, facts({ conversation: conv(conversation) }));
    return id;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-shadow-'));
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

  test('the candidate is trained from what you did, and kept with what was learned', () => {
    // Something you answered, for it to learn from.
    post('dm', 'ann', T0);
    post('dm', 'me', T0 + 2 * MIN);
    expect(triage.candidate).toBeNull();
    votes = new TriageVotes(store, triage);
    votes.learn('daily', T0 + 2 * DAY);
    expect(validModel(triage.candidate)).toBe(true);
    // It learned importance from the answer, and nothing about alerts: what you did never says one was due.
    expect(Object.keys(triage.candidate!.w.important).length).toBeGreaterThan(0);
    expect(triage.candidate!.w.alert).toEqual({});
    const kept = store.triagePolicy<{ candidate: Model; candidateFrom: { votes: number; implicit: number } }>()!;
    expect(kept.candidate).toEqual(triage.candidate!);
    expect(kept.candidateFrom).toEqual({ votes: 0, implicit: 1 });
    // A restart starts from the one that was kept.
    const again = new Triage(store, activity);
    new TriageVotes(store, again);
    expect(again.candidate).toEqual(triage.candidate);
  });

  test('its two chances go with every decision; it never decides', async () => {
    const id = post('dm', 'ann', T0 + 2 * DAY, null);
    const d = (await triage.decide(id, T0 + 2 * DAY))!;
    expect(Object.keys(d.shadow!).sort()).toEqual(['alert', 'important']);
    // It learned you answer Ann, as the live model did: more important than where importance starts.
    expect(d.shadow!.important).toBeGreaterThan(0.8);
    expect(d.probs!.important).toBeGreaterThan(0.8);
    store.setTriage(id, d, d.facts);
    const row = store.one<{ shadow: string; decision: string; explore: string | null; propensity: number | null }>('SELECT shadow, decision, explore, propensity FROM triage WHERE message_id = ?', id)!;
    expect(JSON.parse(row.shadow)).toEqual(d.shadow!);
    // Nothing is tried out on you any more: no exploration is drawn or kept.
    expect(row).toMatchObject({ decision: 'quiet', explore: null, propensity: null });
    expect(d).not.toHaveProperty('explore');

    // A shadow that would alert about everything and list nothing changes nothing about the decision.
    const keep = triage.candidate;
    triage.candidate = { w: { alert: { all: 10 }, important: { all: -10 } } };
    const id2 = post('dm', 'ann', T0 + 2 * DAY + MIN, null);
    const d2 = (await triage.decide(id2, T0 + 2 * DAY + MIN))!;
    expect(d2.decision).toBe(d.decision);
    expect(d2.probs).toEqual(d.probs);
    expect(d2.shadow!.alert).toBeGreaterThan(0.99);
    expect(d2.shadow!.important).toBeLessThan(0.01);
    // Without a candidate there is no shadow to keep.
    triage.candidate = null;
    expect((await triage.decide(id2, T0 + 2 * DAY + MIN))!.shadow).toBeUndefined();
    triage.candidate = keep;
  });

  test('it weighs what the live model does not: the interaction features kept with the decision', async () => {
    const keep = triage.candidate;
    // You are in the middle of talking there: the candidate was taught that such messages matter less.
    triage.candidate = { w: { alert: {}, important: { '#engaged': -3 } } };
    triage.learned = emptyModel();
    post('g', 'me', T0 + 3 * DAY);
    const id = post('g', 'bo', T0 + 3 * DAY + MIN, null);
    const d = (await triage.decide(id, T0 + 3 * DAY + MIN))!;
    expect(d.features?.x).toMatchObject({ engaged: 1 });
    expect(d.probs!.important).toBe(0.8);
    expect(d.shadow!.important).toBeLessThan(0.3);
    // Not there: the same message is to the candidate what it is to the live model.
    const later = post('g', 'bo', T0 + 5 * DAY, null);
    const d2 = (await triage.decide(later, T0 + 5 * DAY))!;
    expect(d2.features?.x).toMatchObject({ engaged: 0 });
    expect(d2.shadow!.important).toBe(d2.probs!.important);
    triage.candidate = keep;
  });
});

describe('what the shadow would have put on the list', () => {
  let store: Store;
  let acc: AccountRow;
  let n = 0;
  /** A decision as it was kept, with the candidate's chances beside it. */
  const decided = (decision: P.TriageDecision, shadow?: Record<string, number>) => {
    const nativeId = `s${++n}`;
    store.ingest(acc, { t: 'message', message: { nativeId, conversation: 'g', author: 'bo', ts: T0 + n, body: 'hi' }, live: true });
    const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
    store.setTriage(id, { decision, score: 0.5, reasons: [], decidedBy: 'rules', probs: { alert: 0.02, important: 0.5 }, ...(shadow ? { shadow: shadow as unknown as P.TriageProbs } : {}) });
    return id;
  };

  beforeAll(() => {
    store = new Store(':memory:', (raw) => raw ?? null);
    acc = store.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'g', shape: 'group', name: 'Club' } });
  });
  afterAll(() => store.db.close());

  test('nothing decided yet: all zero', () => {
    expect(shadowSummary(store.db, 0.6)).toEqual({ days: 7, since: null, decided: 0, live: 0, shadow: 0, both: 0 });
  });

  test('decisions at the list or below it count: as decided, as the shadow would have, and by both', () => {
    const before = Date.now();
    decided('digest', { alert: 0.01, important: 0.9 });
    decided('digest', { alert: 0.01, important: 0.1 });
    decided('drop', { alert: 0.01, important: 0.7 });
    decided('drop', { alert: 0.01, important: 0.2 });
    // Left out: alerts and Conversations (the shadow has no say in them), silenced places, a decision without a
    // shadow, and one whose shadow is from before the tiers.
    decided('push', { alert: 0.9, important: 0.9 });
    decided('quiet', { alert: 0.1, important: 0.9 });
    decided('silent', { alert: 0.1, important: 0.9 });
    decided('digest');
    decided('digest', { ping: 0.1, active: 0.9, interesting: 0.9 });
    const now = Date.now();
    const s = shadowSummary(store.db, 0.6, now);
    expect(s).toMatchObject({ days: 7, decided: 4, live: 2, shadow: 2, both: 1 });
    expect(s.since).toBeGreaterThanOrEqual(before);
    expect(s.since).toBeLessThanOrEqual(now);
    // At another level for the list the shadow's side moves; what was decided is what it was.
    expect(shadowSummary(store.db, 0.15, now)).toMatchObject({ decided: 4, live: 2, shadow: 3, both: 1 });
    expect(shadowSummary(store.db, 0.05, now)).toMatchObject({ decided: 4, live: 2, shadow: 4, both: 2 });
    expect(shadowSummary(store.db, 0.95, now)).toMatchObject({ decided: 4, live: 2, shadow: 0, both: 0 });
    // Only the last days: a week on, they are out of a week's window and inside a month's.
    expect(shadowSummary(store.db, 0.6, now + 8 * DAY)).toEqual({ days: 7, since: null, decided: 0, live: 0, shadow: 0, both: 0 });
    expect(shadowSummary(store.db, 0.6, now + 8 * DAY, 30)).toMatchObject({ days: 30, decided: 4, live: 2, shadow: 2, both: 1 });
  });

  test('the app’s view of it is at your level for the list, and worked out again when you move it', () => {
    const triage = new Triage(store);
    const votes = new TriageVotes(store, triage);
    const now = Date.now();
    const at06 = votes.shadow(now);
    expect(at06).toMatchObject({ days: 7, decided: 4, live: 2, shadow: 2, both: 1 });
    // Kept for a few minutes: the same answer, not worked out again.
    decided('drop', { alert: 0.01, important: 0.99 });
    expect(votes.shadow(now + MIN)).toBe(at06);
    votes.setLevel(0.15);
    expect(votes.shadow(now + MIN)).toMatchObject({ decided: 5, live: 2, shadow: 4, both: 1 });
    expect(votes.shadow(now + 10 * MIN)).toMatchObject({ decided: 5, shadow: 4 });
  });
});

test('an older triage table gets the shadow columns, the marks, and the ones exploration left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-triage-cols-'));
  const path = join(dir, 'hub.sqlite');
  try {
    new Store(path, (raw) => raw ?? null).db.close();
    const db = new Database(path);
    db.exec('DROP INDEX triage_marked;');
    for (const c of ['shadow', 'explore', 'propensity', 'was', 'alert_mark', 'less_mark', 'marked_at']) db.exec(`ALTER TABLE triage DROP COLUMN ${c}`);
    db.close();
    const s = new Store(path, (raw) => raw ?? null);
    const cols = (s.db.query('PRAGMA table_info(triage)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['shadow', 'explore', 'propensity', 'was', 'alert_mark', 'less_mark', 'marked_at']));
    expect(s.db.query(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'triage_marked'`).get()).not.toBeNull();
    s.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
