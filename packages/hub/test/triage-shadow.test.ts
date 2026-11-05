/**
 * The shadow model and silent exploration (docs/notifications.md, shadow.ts): the candidate's chances kept with every
 * decision while the live model decides, what it would have done, and exploration's draw and its exclusions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { emptyModel, type Facts } from '../src/learn.ts';
import { EXPLORE, EXPLORE_UP_REASON, explore, shadowSummary, type ExploreContext } from '../src/shadow.ts';
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
  base: 'push',
  native: 'all',
  notify: true,
  score: 0.15,
  known: true,
  ...f,
});

// ------------------------------------------------------------------ the model

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

  test('the shadow model: trained from votes and what you did, its chances kept with each decision; it never decides', async () => {
    // Something you answered, for it to learn from.
    post('dm', 'ann', T0);
    post('dm', 'me', T0 + 2 * MIN);
    const votes = new TriageVotes(store, triage);
    votes.learn('daily', T0 + 2 * DAY);
    expect(triage.candidate).not.toBeNull();
    expect(store.triagePolicy<{ candidateFrom: { implicit: number } }>()!.candidateFrom.implicit).toBeGreaterThan(0);
    const id = post('dm', 'ann', T0 + 2 * DAY, {}, null);
    const d = (await triage.decide(id, T0 + 2 * DAY))!;
    expect(d.shadow).toBeDefined();
    store.setTriage(id, d, d.facts);
    const row = store.one<{ shadow: string; decision: string }>('SELECT shadow, decision FROM triage WHERE message_id = ?', id)!;
    expect(JSON.parse(row.shadow)).toEqual(d.shadow!);
    // A shadow wildly louder than the live model changes nothing about the decision.
    triage.candidate = { w: { ping: { all: -10 }, active: { all: -10 }, interesting: { all: -10 } } };
    const id2 = post('dm', 'ann', T0 + 2 * DAY + MIN, {}, null);
    const d2 = (await triage.decide(id2, T0 + 2 * DAY + MIN))!;
    expect(d2.decision).toBe('push');
    expect(d2.shadow!.ping).toBeLessThan(0.01);
    store.setTriage(id2, d2, d2.facts);
    const s = shadowSummary(store.db, Date.now() + DAY);
    expect(s.decided).toBe(2);
    expect(s.live.ping).toBe(2);
    expect(s.shadow.ping).toBeLessThan(2);
  });

  test('exploration: off unless asked; with it, a message just under Active is tried as Active, and logged', async () => {
    triage.candidate = null;
    // Important by the prior, moved to just under Active.
    triage.learned = { w: { ping: { all: -6 }, active: { all: -4.1 }, interesting: {} } };
    const id = post('g', 'bo', T0 + 3 * DAY, {}, null);
    const plain = (await triage.decide(id, T0 + 3 * DAY))!;
    expect(plain.explore).toBeUndefined();
    triage.exploring = true;
    triage.rng = () => 0;
    const d = (await triage.decide(id, T0 + 3 * DAY))!;
    if (plain.probs!.active >= EXPLORE.upBand && plain.probs!.active < 0.5 && (plain.decision === 'digest' || plain.decision === 'drop')) {
      expect(d).toMatchObject({ decision: 'quiet', explore: 'up', propensity: EXPLORE.up });
      expect(d.reasons[0]).toBe(EXPLORE_UP_REASON);
      store.setTriage(id, d, d.facts);
      expect(store.one<{ explore: string; propensity: number }>('SELECT explore, propensity FROM triage WHERE message_id = ?', id)).toEqual({ explore: 'up', propensity: EXPLORE.up });
    } else throw new Error(`the test message is not in the band: ${JSON.stringify(plain.probs)} ${plain.decision}`);
    triage.exploring = false;
    triage.learned = emptyModel();
  });
});

describe('the exploration draw', () => {
  const ctx = (c: Partial<ExploreContext> = {}): ExploreContext => ({
    level: 'digest',
    probs: { ping: 0.05, active: 0.3, interesting: 0.6 },
    facts: facts({ base: 'digest' }),
    starred: false,
    keyword: false,
    quietHours: false,
    dmAfterLull: false,
    upToday: 0,
    pingsHere: 0,
    heldHere: false,
    ...c,
  });
  const yes = () => 0;
  const no = () => 0.99;

  test('up: just under Active, at 2%, at most three a day; the chance of what was done is logged', () => {
    expect(explore(ctx(), yes)).toEqual({ level: 'quiet', explore: 'up', propensity: EXPLORE.up });
    expect(explore(ctx(), no)).toEqual({ level: 'digest', explore: null, propensity: 1 - EXPLORE.up });
    expect(explore(ctx({ probs: { ping: 0.01, active: 0.1, interesting: 0.4 } }), yes).explore).toBeNull();
    // The shadow model thinking it close is enough.
    expect(explore(ctx({ probs: { ping: 0.01, active: 0.1, interesting: 0.4 }, shadow: { ping: 0.05, active: 0.4, interesting: 0.7 } }), yes).explore).toBe('up');
    expect(explore(ctx({ upToday: 3 }), yes)).toEqual({ level: 'digest', explore: null, propensity: null });
  });

  test('down: only in a busy conversation, once a day there', () => {
    const push = { level: 'push' as const, probs: { ping: 0.9, active: 0.97, interesting: 0.99 } };
    expect(explore(ctx({ ...push, pingsHere: 12 }), yes)).toEqual({ level: 'quiet', explore: 'down', propensity: EXPLORE.down });
    expect(explore(ctx({ ...push, pingsHere: 3 }), yes).explore).toBeNull();
    expect(explore(ctx({ ...push, pingsHere: 12, heldHere: true }), yes).explore).toBeNull();
    // DITHER_TRIAGE_EXPLORE=up: nothing is held.
    expect(explore(ctx({ ...push, pingsHere: 12, upOnly: true }), yes)).toEqual({ level: 'push', explore: null, propensity: null });
  });

  test('never: quiet hours, starred, keywords, mentions and replies to you, a DM after a lull', () => {
    const push = { level: 'push' as const, probs: { ping: 0.9, active: 0.97, interesting: 0.99 }, pingsHere: 20 };
    for (const c of [{ quietHours: true }, { starred: true }, { keyword: true }, { dmAfterLull: true }, { facts: facts({ mention: true }) }, { facts: facts({ reply: true }) }]) {
      expect(explore(ctx(c), yes)).toEqual({ level: 'digest', explore: null, propensity: null });
      expect(explore(ctx({ ...push, ...c }), yes).explore).toBeNull();
    }
  });
});

test('an older triage table gets the shadow and exploration columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-triage-cols-'));
  const path = join(dir, 'hub.sqlite');
  try {
    new Store(path, (raw) => raw ?? null).db.close();
    const db = new Database(path);
    db.exec('ALTER TABLE triage DROP COLUMN shadow; ALTER TABLE triage DROP COLUMN explore; ALTER TABLE triage DROP COLUMN propensity;');
    db.close();
    const s = new Store(path, (raw) => raw ?? null);
    const cols = (s.db.query('PRAGMA table_info(triage)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['shadow', 'explore', 'propensity']));
    s.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
