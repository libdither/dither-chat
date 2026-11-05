/**
 * The decision model (learn.ts, votes.ts, triage.ts, docs/notifications.md): three chances from a prior the
 * networks' own settings set, moved by your votes as far as the hierarchy allows; the backtest; the networks' own
 * settings as the default; and the whole loop through a store.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { backtest, describe as say, emptyModel, features, levelFrom, predict, prior, STOOD, train, words, writePrompt, type Example, type Facts, type Level } from '../src/learn.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { TriageVotes } from '../src/votes.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 12);

const facts = (f: Partial<Facts>): Facts => ({
  network: 'signal',
  shape: 'direct',
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
const vote = (f: Partial<Facts>, label: Level, ws: string[] = []): Example => ({ facts: facts(f), words: ws, label, weight: 1, vote: true, at: NOW });
const stood = (f: Partial<Facts>): Example => ({ facts: facts(f), words: [], label: facts(f).base, weight: STOOD, vote: false, at: NOW - DAY });
const level = (m: ReturnType<typeof train>, f: Partial<Facts>, ws: string[] = []) => predict(m, facts(f), ws).level;
const names = { conversation: (id: string) => `#${id}`, space: (id: string) => `Server ${id}`, person: (id: string) => `Person ${id}`, network: (id: string) => id };
// Other Signal DMs that pinged and were left alone.
const otherDMs = Array.from({ length: 20 }, (_, i) => stood({ conversation: `dm${i}`, author: `q${i}` }));

describe('the model', () => {
  test('before any vote, the prior: what the network would notify is Important; the rest by how interesting', () => {
    const m = emptyModel();
    expect(level(m, {})).toBe('push');
    expect(level(m, { base: 'quiet' })).toBe('quiet');
    expect(level(m, { base: 'digest', score: 0.15 })).toBe('drop');
    expect(level(m, { base: 'digest', score: 0.4 })).toBe('digest');
    expect(level(m, { base: 'digest', score: 0.15, explicit: true })).toBe('digest');
    expect(predict(m, facts({})).probs.ping).toBeCloseTo(0.9);
    expect(levelFrom({ ping: 0.79, active: 0.6, interesting: 0.9 })).toBe('quiet');
  });

  test('one vote down moves its conversation; two in one Signal chat do not quieten the rest of Signal', () => {
    const m1 = train([vote({}, 'quiet'), ...otherDMs]);
    expect(level(m1, {})).toBe('quiet');
    const m2 = train([vote({}, 'digest'), vote({}, 'digest'), ...otherDMs]);
    expect(level(m2, {})).toBe('digest');
    expect(level(m2, { conversation: 'dm-new', author: 'p9' })).toBe('push');
    // Even without decisions standing elsewhere.
    expect(level(train([vote({}, 'digest'), vote({}, 'digest')]), { conversation: 'dm-new', author: 'p9' })).toBe('push');
  });

  test('votes across a server, not about you, teach the server; a mention there still pings', () => {
    const ch = (c: string, f: Partial<Facts> = {}) => ({ network: 'discord', shape: 'channel', conversation: c, spaces: ['hub'], author: `a-${c}`, native: 'all' as const, ...f });
    const m = train(['a', 'b', 'c', 'd'].flatMap((c) => [vote(ch(c), 'digest'), vote(ch(c), 'digest')]));
    expect(level(m, ch('e'))).not.toBe('push');
    expect(level(m, ch('e', { mention: true }))).toBe('push');
    expect(level(m, { ...ch('x'), spaces: ['other'] })).toBe('push');
  });

  test('words: what you voted down for what it says moves other messages that say it', () => {
    const m = train(['a', 'b', 'c', 'd', 'e'].map((c) => vote({ conversation: c, author: `p-${c}` }, 'digest', ['standup', 'notes', c + 'x'])));
    const with_ = predict(m, facts({ conversation: 'z', author: 'pz' }), ['standup', 'notes']).probs.ping;
    const without = predict(m, facts({ conversation: 'z', author: 'pz' }), ['lunch', 'today']).probs.ping;
    expect(with_).toBeLessThan(without - 0.05);
  });

  test('down from the digest is not interesting: below it', () => {
    const f = { base: 'digest' as const, score: 0.4, conversation: 'g', native: 'mentions' as const, notify: false };
    expect(level(emptyModel(), f)).toBe('digest');
    expect(level(train([vote(f, 'drop')]), f)).toBe('drop');
    expect(level(train([vote({ ...f, score: 0.15 }, 'digest')]), { ...f, score: 0.15 })).toBe('digest');
  });

  test('backtest: votes wrong with what it learned and without', () => {
    const ex = [vote({}, 'quiet'), vote({ conversation: 'c2' }, 'push')];
    expect(backtest(emptyModel(), ex)).toMatchObject({ votes: 2, errors: 1, baseline: 1 });
    expect(backtest(train(ex), ex)).toMatchObject({ votes: 2, errors: 0, baseline: 1 });
  });

  test('features and words in words; the prompt asks three questions and says what it learned', () => {
    expect(say('conv:c1&!you', names)).toBe('In #c1, not about you');
    expect(say('w:standup', names)).toBe('Says “standup”');
    expect(say('space:hub', names)).toBe('In Server hub');
    const fs = features(facts({ mention: true, spaces: ['s'] })).map(([k]) => k);
    expect(fs).toContain('conv:c1&you');
    expect(fs).toContain('space:s&you');
    expect(fs).toContain('notify');
    expect(words('Hey <@123> the STANDUP notes: https://x.y/z `code` standup 2026')).toEqual(['hey', 'standup', 'notes']);
    const p = writePrompt(train([vote({}, 'quiet')]), [], names);
    expect(p).toContain('- ping:');
    expect(p).toContain('Less likely to ping: In #c1');
  });

  test('fits twenty thousand examples quickly', () => {
    const ex = Array.from({ length: 20_000 }, (_, i) =>
      i % 50 ? stood({ conversation: `c${i % 2000}`, author: `p${i % 700}`, spaces: [`s${i % 40}`] }) : vote({ conversation: `c${i % 2000}` }, 'quiet', ['alpha', 'beta']),
    );
    const t = performance.now();
    train(ex);
    expect(performance.now() - t).toBeLessThan(3000);
  });
});

describe('through the hub', () => {
  let dir: string;
  let store: Store;
  let triage: Triage;
  let votes: TriageVotes;
  let d: AccountRow;
  let sig: AccountRow;
  let n = 0;
  const post = async (acc: AccountRow, conversation: string, body = 'hello', author = 'ann', x: { mentionsSelf?: boolean } = {}) => {
    const nativeId = `m${++n}`;
    store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts: NOW + n * 60_000, body, ...x }, live: true });
    const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
    const dec = (await triage.decide(id, NOW + n * 60_000))!;
    store.setTriage(id, dec, dec.facts);
    return { id, dec };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-votes-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    triage = new Triage(store);
    votes = new TriageVotes(store, triage);
    d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
    sig = store.createAccount({ network: 'signal', label: 's', color: '#111', adapter: 'signal' });
    store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    store.ingest(d, { t: 'identity', identity: { nativeId: 'bob', displayName: 'Bob', contact: true } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm2', shape: 'direct', participants: ['bob'] } });
    // A server notifying only mentions, with one channel set to every message and one muted for a while that is over.
    store.ingest(d, { t: 'space', space: { nativeId: 'guild', kind: 'community', name: 'Hub', mute: { level: 'mentions' } } });
    for (const [c, mute] of [['general', undefined], ['alerts', { level: 'all' as const }], ['was-muted', { level: 'none' as const, until: NOW - DAY }], ['muted', { level: 'none' as const }]] as const)
      store.ingest(d, { t: 'conversation', conversation: { nativeId: c, shape: 'channel', name: c, spaces: [{ nativeId: 'guild' }], ...(mute ? { mute } : {}) } });
    store.ingest(sig, { t: 'conversation', conversation: { nativeId: 'group:g', shape: 'group', name: 'Friends', participants: ['x', 'y', 'z', 'w', 'v', 'u', 't'] } });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('what the network would notify is Important; the rest goes by how interesting it is', async () => {
    expect((await post(d, 'general', 'just chatting')).dec.decision).toBe('drop');
    expect((await post(d, 'general', 'are you around? need help asap')).dec.decision).toBe('digest');
    const m = await post(d, 'general', 'hey <@dme>', 'ann', { mentionsSelf: true });
    expect(m.dec.decision).toBe('push');
    expect(m.dec.facts).toMatchObject({ native: 'mentions', notify: true, base: 'push' });
    expect((await post(d, 'alerts', 'deploy finished')).dec).toMatchObject({ decision: 'push', reasons: ['Discord notifies every message here'] });
    expect((await post(d, 'was-muted', 'back')).dec.facts).toMatchObject({ native: 'mentions' });
    expect((await post(d, 'muted', 'shh', 'ann', { mentionsSelf: true })).dec.facts).toMatchObject({ native: 'none', notify: false });
    expect((await post(sig, 'group:g', 'dinner at 7')).dec.decision).toBe('push');
    const dec = (await post(d, 'general', 'nothing much')).dec;
    expect(dec.probs!.interesting).toBeLessThan(0.5);
    expect(dec.score).toBeGreaterThan(0);
  });

  test('a DM is Important; voting it down makes it, and the next one there, Active', async () => {
    const { id, dec } = await post(d, 'dm');
    expect(dec.decision).toBe('push');
    expect(dec.facts).toMatchObject({ shape: 'direct', base: 'push' });
    const r = votes.vote(id, 'down', NOW + DAY);
    expect(r.feedback).toBe('quiet');
    expect(r.policy).toMatchObject({ votes: 1, errors: 0, baseline: 1 });
    expect(r.policy.factors.find((f) => f.head === 'ping')).toMatchObject({ text: 'In your DM with Ann, not about you', votes: 1 });
    expect(r.policy.prompt).toContain('Less likely to ping');
    const next = await post(d, 'dm');
    expect(next.dec.decision).toBe('quiet');
    expect(next.dec.decidedBy).toBe('learned');
    expect(next.dec.reasons[0]).toBe('Active, learned from your votes (was Important)');
    expect(next.dec.reasons[1]).toMatch(/^Less likely to ping: In your DM with Ann/);
    expect(next.dec.facts!.base).toBe('push');
    // Elsewhere nothing changed.
    expect((await post(d, 'dm2', 'hi', 'bob')).dec.decision).toBe('push');
  });

  test('up again on Important says it was right; down from the digest is below it; a vote can be taken back', async () => {
    const { id } = await post(d, 'dm2', 'yo', 'bob');
    expect(votes.vote(id, 'up', NOW + DAY).feedback).toBe('push');
    expect(votes.vote(id, null, NOW + DAY).feedback).toBeNull();
    const dg = await post(d, 'general', 'anyone up for a game? asap');
    expect(votes.vote(dg.id, 'down', NOW + DAY).feedback).toBe('drop');
    expect(votes.vote(dg.id, 'down', NOW + DAY).feedback).toBe('drop');
  });

  test('forgetting what it learned about a conversation, for good', async () => {
    const key = votes.view(NOW + DAY).factors.find((f) => f.text === 'In your DM with Ann, not about you')!.key;
    votes.forget(key, true, NOW + DAY);
    const v = votes.view(NOW + DAY);
    expect(v.factors.some((f) => f.key === key)).toBe(false);
    expect(v.rejected.map((r) => r.key)).toContain(key);
  });

  test('the inbox: the digest by how much it matters, and the best of what fell below it', () => {
    const page = store.inbox(NOW - DAY, NOW + DAY);
    const dec = (id: string) => store.one<{ decision: string; score: number }>('SELECT decision, score FROM triage WHERE message_id = ?', id)!;
    const levels = new Set(page.items.map((i) => i.message.triage!.feedback ?? i.message.triage!.decision));
    expect(levels.has('drop')).toBe(true);
    expect(page.items.every((i) => dec(i.message.id).decision !== 'silent')).toBe(true);
  });
});

test('older triage tables come across: v1 feedback as votes, v2 as it was', () => {
  for (const v of ['v1', 'v2'] as const) {
    const dir = mkdtempSync(join(tmpdir(), `dither-triage-${v}-`));
    try {
      const path = join(dir, 'hub.sqlite');
      const s1 = new Store(path, (raw) => raw ?? null);
      const acc = s1.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
      s1.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: [] } });
      s1.ingest(acc, { t: 'message', message: { nativeId: 'x', conversation: 'dm', author: 'ann', ts: NOW, body: 'hi' }, live: true });
      const mid = s1.one<{ id: string }>('SELECT id FROM message')!.id;
      if (v === 'v1') {
        s1.db.exec(`DROP TABLE triage; CREATE TABLE triage (
          message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
          decision TEXT NOT NULL CHECK (decision IN ('push', 'digest', 'silent')), score REAL, reasons TEXT NOT NULL,
          decided_by TEXT NOT NULL, feedback TEXT, created_at INTEGER NOT NULL);
          CREATE INDEX triage_created ON triage(created_at);`);
        s1.db.query(`INSERT INTO triage VALUES (?, 'push', NULL, '[]', 'rules', 'should_not_push', 5)`).run(mid);
      } else {
        s1.db.exec(`DROP TABLE triage; CREATE TABLE triage (
          message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
          decision TEXT NOT NULL CHECK (decision IN ('push', 'quiet', 'digest', 'silent')), score REAL, reasons TEXT NOT NULL,
          decided_by TEXT NOT NULL, feedback TEXT CHECK (feedback IN ('push', 'quiet', 'digest')), feedback_at INTEGER, facts TEXT, created_at INTEGER NOT NULL);
          CREATE INDEX triage_created ON triage(created_at); CREATE INDEX triage_feedback ON triage(feedback_at) WHERE feedback IS NOT NULL;`);
        s1.db.query(`INSERT INTO triage VALUES (?, 'quiet', 0.4, '[]', 'rules', 'digest', 5, '{"x":1}', 4)`).run(mid);
      }
      s1.db.close();
      const s2 = new Store(path, (raw) => raw ?? null);
      expect(s2.one<any>('SELECT decision, feedback, feedback_at FROM triage')).toEqual(v === 'v1' ? { decision: 'push', feedback: 'digest', feedback_at: 5 } : { decision: 'quiet', feedback: 'digest', feedback_at: 5 });
      if (v === 'v2') expect(s2.one<any>('SELECT facts FROM triage').facts).toBe('{"x":1}');
      s2.setTriage(mid, { decision: 'drop', score: 0.1, reasons: [], decidedBy: 'rules', probs: { ping: 0, active: 0, interesting: 0.1 } });
      expect(s2.one<any>('SELECT decision, feedback, probs FROM triage')).toEqual({ decision: 'drop', feedback: 'digest', probs: '{"ping":0,"active":0,"interesting":0.1}' });
      const db = new Database(path);
      expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'triage_v1'`).get()).toBeNull();
      expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'triage_feedback'`).get()).not.toBeNull();
      db.close();
      s2.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
