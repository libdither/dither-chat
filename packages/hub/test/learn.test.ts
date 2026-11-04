/**
 * Learning from your votes (learn.ts, votes.ts, docs/notifications.md): rules that explain the votes, kept from
 * reaching past them by the decisions you let stand; the backtest; and the whole loop through a store.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyRules, backtest, describe as say, learn, predicates, ruleKey, STOOD, writePrompt, type Example, type Facts, type Level } from '../src/learn.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { TriageVotes } from '../src/votes.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 12);

const facts = (f: Partial<Facts>): Facts => ({
  network: 'discord',
  shape: 'channel',
  conversation: 'c1',
  spaces: ['s1'],
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
  ...f,
});
const vote = (f: Partial<Facts>, label: Level, ago = 0): Example => ({ facts: facts(f), label, weight: 1, vote: true, at: NOW - ago });
const stood = (f: Partial<Facts>): Example => ({ facts: facts(f), label: facts(f).base, weight: STOOD, vote: false, at: NOW - DAY });
const names = { conversation: (id: string) => `#${id}`, space: (id: string) => `Server ${id}`, person: (id: string) => `Person ${id}`, network: (id: string) => id };

describe('rules from votes', () => {
  test('one vote moves its conversation', () => {
    const rules = learn([vote({ conversation: 'c1' }, 'quiet')]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ when: ['conv:c1'], level: 'quiet', votes: 1, agree: 1 });
    expect(applyRules(rules, facts({ conversation: 'c1' })).level).toBe('quiet');
    expect(applyRules(rules, facts({ conversation: 'c2' })).level).toBe('push');
  });

  test('a server takes two votes that agree; a pattern across them is found', () => {
    expect(learn([vote({ conversation: 'c1' }, 'digest')]).some((r) => r.when.includes('space:s1'))).toBe(false);
    const ex = [
      vote({ conversation: 'c1' }, 'digest'),
      vote({ conversation: 'c2' }, 'digest'),
      // What you let stand: mentions in that server buzz, and other servers buzz.
      stood({ conversation: 'c1', mention: true }),
      stood({ conversation: 'c3', mention: true }),
      stood({ conversation: 'c9', spaces: ['s2'] }),
      stood({ conversation: 'c8', spaces: ['s3'] }),
    ];
    const rules = learn(ex);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ when: ['space:s1', '!mention'], level: 'digest', votes: 2 });
    expect(applyRules(rules, facts({ conversation: 'c4' })).level).toBe('digest');
    expect(applyRules(rules, facts({ conversation: 'c4', mention: true })).level).toBe('push');
    expect(say(rules[0].when, names)).toBe('In Server s1, that does not mention you');
  });

  test('decisions you let stand keep a rule from reaching past your votes, but never outvote one', () => {
    const many = Array.from({ length: 10 }, () => stood({ conversation: 'c1', question: true }));
    const rules = learn([vote({ conversation: 'c1' }, 'digest'), ...many]);
    expect(rules[0].when).toEqual(['conv:c1', '!question']);
    // The vote wins over what stood, newest votes first.
    expect(learn([vote({ conversation: 'c1', question: true }, 'digest'), ...many])[0].level).toBe('digest');
  });

  test('votes that disagree make no rule', () => {
    const rules = learn([vote({ conversation: 'c1' }, 'digest'), vote({ conversation: 'c1' }, 'push'), vote({ conversation: 'c1' }, 'quiet')]);
    expect(rules.find((r) => r.when.length === 1 && r.when[0] === 'conv:c1')).toBeUndefined();
  });

  test('the most specific rule wins; dropped rules stay dropped; kept ones survive', () => {
    const ex = [vote({ conversation: 'c1' }, 'digest'), vote({ conversation: 'c2' }, 'digest'), vote({ conversation: 'c3', author: 'p2' }, 'push'), vote({ conversation: 'c3', author: 'p2' }, 'push', 1)];
    const rules = learn(ex);
    expect(applyRules(rules, facts({ conversation: 'c3', author: 'p2' })).level).toBe('push');
    const dropped = rules.find((r) => r.level === 'digest')!;
    expect(learn(ex, [], new Set([ruleKey(dropped)])).some((r) => ruleKey(r) === ruleKey(dropped))).toBe(false);
    const kept = { when: ['network:discord'], level: 'quiet' as Level, votes: 0, agree: 0, pinned: true };
    const again = learn(ex, [kept]);
    expect(again.some((r) => r.pinned && r.when[0] === 'network:discord')).toBe(true);
    expect(again.at(-1)!.when).toEqual(['network:discord']);
  });

  test('backtest: votes wrong with the rules and without', () => {
    const ex = [vote({ conversation: 'c1' }, 'quiet'), vote({ conversation: 'c2' }, 'push'), stood({})];
    expect(backtest([], ex)).toMatchObject({ votes: 2, errors: 1, baseline: 1 });
    const rules = learn(ex);
    expect(backtest(rules, ex)).toMatchObject({ votes: 2, errors: 0, baseline: 1 });
  });

  test('the prompt says the rules in words and what they still get wrong', () => {
    const p = writePrompt([{ when: ['space:s1', '!mention'], level: 'digest', votes: 2, agree: 2 }], [vote({ conversation: 'c7', mention: true }, 'quiet')], names);
    expect(p).toContain('- In Server s1, that does not mention you: digest');
    expect(p).toContain('they said active');
    expect(p).not.toMatch(/conv:|space:/);
  });

  test('predicates name each scope and flag, and what is missing where that says something', () => {
    expect(predicates(facts({ mention: true }))).toEqual(expect.arrayContaining(['conv:c1', 'space:s1', 'author:p1', 'mention', '!reply', 'base:push']));
  });
});

describe('votes through the hub', () => {
  let dir: string;
  let store: Store;
  let triage: Triage;
  let votes: TriageVotes;
  let d: AccountRow;
  let n = 0;
  const post = async (conversation: string, body = 'hello', author = 'ann') => {
    const nativeId = `m${++n}`;
    store.ingest(d, { t: 'message', message: { nativeId, conversation, author, ts: NOW + n * 60_000, body }, live: true });
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
    store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    store.ingest(d, { t: 'identity', identity: { nativeId: 'bob', displayName: 'Bob', contact: true } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm2', shape: 'direct', participants: ['bob'] } });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a DM is Important; voting it down makes it, and the next one there, Active', async () => {
    const { id, dec } = await post('dm');
    expect(dec.decision).toBe('push');
    expect(dec.facts).toMatchObject({ shape: 'direct', base: 'push' });
    const r = votes.vote(id, 'down', NOW + DAY);
    expect(r.feedback).toBe('quiet');
    expect(r.policy).toMatchObject({ votes: 1, errors: 0, baseline: 1 });
    expect(r.policy.rules[0]).toMatchObject({ level: 'quiet', votes: 1 });
    expect(r.policy.rules[0].text).toBe('In your DM with Ann');
    expect(r.policy.prompt).toContain(': active');
    const next = await post('dm');
    expect(next.dec.decision).toBe('quiet');
    expect(next.dec.decidedBy).toBe('learned');
    expect(next.dec.reasons[0]).toBe('Active, learned from your votes (was Important)');
    expect(next.dec.facts!.base).toBe('push');
    // Elsewhere nothing changed.
    expect((await post('dm2', 'hi', 'bob')).dec.decision).toBe('push');
  });

  test('up again on Important says it was right; a vote can be taken back', async () => {
    const { id } = await post('dm2', 'yo', 'bob');
    expect(votes.vote(id, 'up', NOW + DAY).feedback).toBe('push');
    expect(store.one<{ feedback: string }>('SELECT feedback FROM triage WHERE message_id = ?', id)!.feedback).toBe('push');
    expect(votes.vote(id, null, NOW + DAY).feedback).toBeNull();
  });

  test('dropping a rule takes it away for good', async () => {
    const key = votes.view(NOW + DAY).rules[0].key;
    votes.setRule(key, { rejected: true }, NOW + DAY);
    const v = votes.view(NOW + DAY);
    expect(v.rules.some((r) => r.key === key)).toBe(false);
    expect(v.rejected.map((r) => r.key)).toContain(key);
    expect((await post('dm')).dec.decision).toBe('push');
  });
});

test('an older triage table comes across, its feedback as votes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-triage-v1-'));
  try {
    const path = join(dir, 'hub.sqlite');
    const s1 = new Store(path, (raw) => raw ?? null);
    const acc = s1.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
    s1.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: [] } });
    s1.ingest(acc, { t: 'message', message: { nativeId: 'x', conversation: 'dm', author: 'ann', ts: NOW, body: 'hi' }, live: true });
    const mid = s1.one<{ id: string }>('SELECT id FROM message')!.id;
    s1.db.exec(`DROP TABLE triage; CREATE TABLE triage (
      message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('push', 'digest', 'silent')), score REAL, reasons TEXT NOT NULL,
      decided_by TEXT NOT NULL, feedback TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX triage_created ON triage(created_at);`);
    s1.db.query(`INSERT INTO triage VALUES (?, 'push', NULL, '[]', 'rules', 'should_not_push', 5)`).run(mid);
    s1.db.close();
    const s2 = new Store(path, (raw) => raw ?? null);
    expect(s2.one<any>('SELECT decision, feedback, feedback_at FROM triage')).toEqual({ decision: 'push', feedback: 'digest', feedback_at: 5 });
    s2.setTriage(mid, { decision: 'quiet', score: null, reasons: [], decidedBy: 'rules' });
    expect(s2.one<any>('SELECT decision, feedback FROM triage')).toEqual({ decision: 'quiet', feedback: 'digest' });
    expect(new Database(path).query(`SELECT name FROM sqlite_master WHERE name = 'triage_v1'`).get()).toBeNull();
    s2.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
