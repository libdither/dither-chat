import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { memTempDir } from './fixtures/memdir.ts';

/**
 * /api/inbox reads a week of triage, which on a real hub is a few hundred thousand rows: each pick must walk an index
 * and stop at its limit, not sort the week (it took 1.5 s on the live hub, blocking every request behind it).
 */
describe('the inbox query', () => {
  let store: Store;
  const now = Date.now();
  const since = now - 7 * 86_400_000;

  beforeAll(() => {
    // In memory: no file, no log, no checkpoint or fsync, so a busy disk can't slow the setup. The plans don't depend on
    // where the rows live, nor (without ANALYZE) on how many there are.
    store = new Store(':memory:', () => null);
    const acc = store.createAccount({ id: 'acc_t', network: 'discord', label: 't', color: '#888', adapter: 'test' });
    store.ingest(acc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann' } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'c1', shape: 'channel', name: 'general' } });
    const cid = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'c1'`)!.id;
    const author = store.one<{ id: string }>(`SELECT id FROM identity WHERE native_id = 'ann'`)!.id;
    // Many rows, fast: this store is thrown away, so full-text search can go without them.
    store.db.exec('DROP TRIGGER message_fts_insert; DROP TRIGGER search_time_insert');
    const msg = store.db.query(`INSERT INTO message (id, conversation_id, network, native_id, author_id, ts, body) VALUES (?, ?, 'discord', ?, ?, ?, 'hi')`);
    // With the message's time, as setTriage keeps it.
    const tri = store.db.query(`INSERT INTO triage (message_id, decision, score, reasons, decided_by, created_at, message_ts) VALUES (?, ?, ?, '[]', 'rules', ?, ?)`);
    // Enough for every pick to fill (210 alerted or Conversation for 150) and no more: building the rows is the setup.
    const N = 20_000;
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    store.db.transaction(() => {
      // Ten days of N messages. The last day was scored (the model), mostly below the list, too few on it to fill
      // its share; before that, rules only (no score), mostly on the list: the live hub's week as of 2026-11, compressed.
      for (let i = 0; i < N; i++) {
        const ts = now - Math.round((i / N) * 10 * 86_400_000);
        const scored = ts > now - 86_400_000;
        const r = rnd();
        const decision = scored ? (r < 0.945 ? 'drop' : r < 0.95 ? 'digest' : r < 0.99 ? 'quiet' : 'push') : r < 0.95 ? 'digest' : r < 0.98 ? 'drop' : r < 0.99 ? 'push' : 'silent';
        msg.run(`msg_${i}`, cid, `n${i}`, author, ts);
        tri.run(`msg_${i}`, decision, scored ? Math.round(rnd() * 1000) / 1000 : null, ts + 1000, ts);
      }
    })();
  });
  afterAll(() => {
    store.db.close();
  });

  test('every pick walks an index', () => {
    for (const q of Store.inboxQueries(since, now)) {
      const plan = (store.db.query('EXPLAIN QUERY PLAN ' + q.sql).all(q.since, q.limit) as { detail: string }[]).map((r) => r.detail);
      expect(plan.some((d) => /^SCAN (m|t)\b/.test(d))).toBe(false);
      // Triage first by tier and importance (alerts and Conversations by their messages' time), or messages first by
      // time: never a sort of everything in the window.
      expect(plan[0]).toMatch(q.pick === 'notified' ? /^SEARCH t USING INDEX triage_notified \(message_ts>\?\)/ : q.sql.includes('FROM triage t') ? /USING INDEX triage_tier_score/ : /USING INDEX message_ts/);
      if (q.sql.includes('ORDER BY m.ts DESC') && q.sql.includes('FROM message m')) expect(plan.some((d) => d.includes('TEMP B-TREE'))).toBe(false);
    }
  });

  test('the same answer as one query per pick, ordered by importance then time', () => {
    // The tier as decided: a vote from before the tiers no longer moves a row between the picks.
    const at = `t.decision`;
    const pick = (where: string, limit: number, order: string, s = since) =>
      store.db.query(`SELECT m.id, m.ts FROM triage t JOIN message m ON m.id = t.message_id WHERE m.ts >= ? AND m.deleted = 0 AND t.decision != 'silent' AND ${where} ORDER BY ${order} LIMIT ${limit}`).all(s) as { id: string; ts: number }[];
    const ids = (rows: { id: string; ts: number }[]) => rows.map((r) => r.id).sort();
    const want = [...pick(`${at} IN ('push', 'quiet')`, 150, 'm.ts DESC'), ...pick(`${at} = 'digest'`, 300, 't.score DESC, m.ts DESC'), ...pick(`${at} = 'drop'`, 40, 't.score DESC, m.ts DESC', Math.max(since, now - 2 * 86_400_000))];
    const got = store.inbox(since, now).items.map((i) => ({ id: i.message.id, ts: i.message.ts }));
    expect(got.length).toBe(490);
    expect(ids(got)).toEqual(ids(want));
    expect(got.every((x, i) => i === 0 || got[i - 1].ts >= x.ts)).toBe(true);
    // Fewer scored than the list's share: the rest are the newest without a score.
    expect(pick(`${at} = 'digest' AND t.score IS NOT NULL`, 300, 'm.ts DESC').length).toBeLessThan(300);
    // A row below the list from four days ago, voted up to Important before the tiers: still not picked.
    const old = store.one<{ id: string }>(`SELECT m.id FROM triage t JOIN message m ON m.id = t.message_id WHERE t.decision = 'drop' AND m.ts < ? AND m.ts >= ? ORDER BY m.ts DESC LIMIT 1`, now - 4 * 86_400_000, since)!.id;
    store.db.query(`UPDATE triage SET feedback = 'push', feedback_at = ? WHERE message_id = ?`).run(now, old);
    expect(store.inbox(since, now).items.some((i) => i.message.id === old)).toBe(false);
    store.db.query(`UPDATE triage SET feedback = NULL, feedback_at = NULL WHERE message_id = ?`).run(old);
  });

  test('no pick sorts what it finds: alerts and Conversations neither, though they are kept for good', () => {
    // Sorting the week took 1.5 s on the live hub; sorting every alert and Conversation ever (pruneTriage keeps them)
    // took 0.3 s there by 2026-11 and grew without end. Counted, not timed: no plan sorts all it finds (ties of the
    // same importance are put in time order, a few at a time, as they come).
    for (const q of Store.inboxQueries(since, now)) {
      const plan = (store.db.query('EXPLAIN QUERY PLAN ' + q.sql).all(q.since, q.limit) as { detail: string }[]).map((r) => r.detail);
      expect([q.pick, plan.filter((d) => d === 'USE TEMP B-TREE FOR ORDER BY')]).toEqual([q.pick, []]);
    }
  });
});

describe("alerts and Conversations keep their message's time", () => {
  test('when decided, decided again, and (for those decided before) when the hub opens', () => {
    // Opened again from its file, so a file: in memory, where closing it does not wait on a busy disk (memdir.ts).
    const dir = memTempDir('inbox-plan-');
    try {
      const path = join(dir, 'hub.sqlite');
      let store = new Store(path, () => null);
      const acc = store.createAccount({ id: 'acc_t', network: 'discord', label: 't', color: '#888', adapter: 'test' });
      store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'c1', shape: 'channel', name: 'general' } });
      const now = Date.now();
      // A day ahead of the hub's clock: a sender's clock wrong, or a test's. The pick goes by the message's time.
      const ts = { a: now + 86_400_000, b: now - 3_600_000, c: now - 7_200_000 };
      for (const [id, t] of Object.entries(ts)) store.ingest(acc, { t: 'message', message: { nativeId: id, conversation: 'c1', author: 'ann', ts: t, body: 'hi' }, live: true });
      const mid = (n: string) => store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', n)!.id;
      const kept = (n: string) => store.one<{ message_ts: number | null }>('SELECT message_ts FROM triage WHERE message_id = ?', mid(n))!.message_ts;
      const decide = (n: string, decision: 'push' | 'quiet' | 'digest') => store.setTriage(mid(n), { decision, score: null, reasons: [], decidedBy: 'rules', probs: null });
      decide('a', 'push');
      decide('b', 'digest');
      expect([kept('a'), kept('b')]).toEqual([ts.a, ts.b]);
      decide('b', 'quiet');
      expect(kept('b')).toBe(ts.b);
      // Decided before triage kept the time: the next start fills it in.
      decide('c', 'quiet');
      store.db.query('UPDATE triage SET message_ts = NULL').run();
      store.db.close();
      store = new Store(path, () => null);
      expect([kept('a'), kept('b'), kept('c')]).toEqual([ts.a, ts.b, ts.c]);
      expect(store.inbox(now - 7 * 86_400_000, now).items.map((i) => i.message.id)).toEqual([mid('a'), mid('b'), mid('c')]);
      store.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
