import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

/**
 * /api/inbox reads a week of triage, which on a real hub is a few hundred thousand rows: each pick must walk an index
 * and stop at its limit, not sort the week (it took 1.5 s on the live hub, blocking every request behind it).
 */
describe('the inbox query', () => {
  let dir: string;
  let store: Store;
  const now = Date.now();
  const since = now - 7 * 86_400_000;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-inbox-plan-'));
    store = new Store(join(dir, 'hub.sqlite'), () => null);
    const acc = store.createAccount({ id: 'acc_t', network: 'discord', label: 't', color: '#888', adapter: 'test' });
    store.ingest(acc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann' } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'c1', shape: 'channel', name: 'general' } });
    const cid = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'c1'`)!.id;
    const author = store.one<{ id: string }>(`SELECT id FROM identity WHERE native_id = 'ann'`)!.id;
    // Many rows, fast: this store is thrown away, so full-text search can go without them.
    store.db.exec('DROP TRIGGER message_fts_insert');
    const msg = store.db.query(`INSERT INTO message (id, conversation_id, network, native_id, author_id, ts, body) VALUES (?, ?, 'discord', ?, ?, ?, 'hi')`);
    const tri = store.db.query(`INSERT INTO triage (message_id, decision, score, reasons, decided_by, created_at) VALUES (?, ?, ?, '[]', 'rules', ?)`);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    store.db.transaction(() => {
      // Ten days of 80k messages. The last day was scored (the model), mostly below the list, too few on it to fill
      // its share; before that, rules only (no score), mostly on the list: the live hub's week as of 2026-11, compressed.
      for (let i = 0; i < 80_000; i++) {
        const ts = now - Math.round((i / 80_000) * 10 * 86_400_000);
        const scored = ts > now - 86_400_000;
        const r = rnd();
        const decision = scored ? (r < 0.945 ? 'drop' : r < 0.95 ? 'digest' : r < 0.99 ? 'quiet' : 'push') : r < 0.95 ? 'digest' : r < 0.98 ? 'drop' : r < 0.99 ? 'push' : 'silent';
        msg.run(`msg_${i}`, cid, `n${i}`, author, ts);
        tri.run(`msg_${i}`, decision, scored ? Math.round(rnd() * 1000) / 1000 : null, ts + 1000);
      }
    })();
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('every pick walks an index', () => {
    for (const q of Store.inboxQueries(since, now)) {
      const plan = (store.db.query('EXPLAIN QUERY PLAN ' + q.sql).all(q.since, q.limit) as { detail: string }[]).map((r) => r.detail);
      expect(plan.some((d) => /^SCAN (m|t)\b/.test(d))).toBe(false);
      // Triage first by tier and importance, or messages first by time: never a sort of everything in the window.
      expect(plan[0]).toMatch(q.sql.includes('FROM triage t') ? /USING INDEX triage_tier_score/ : /USING INDEX message_ts/);
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

  test('only a few rows are ever sorted whole: the notified, never the week', () => {
    // Sorting the week took 1.5 s on the live hub. Counted, not timed: a pick whose plan sorts all it finds is the
    // notified one (alerts and Conversations), and what it finds is a small part of the window.
    const week = store.one<{ n: number }>('SELECT COUNT(*) AS n FROM message WHERE ts >= ?', since)!.n;
    let sorted = 0;
    for (const q of Store.inboxQueries(since, now)) {
      const plan = (store.db.query('EXPLAIN QUERY PLAN ' + q.sql).all(q.since, q.limit) as { detail: string }[]).map((r) => r.detail);
      if (!plan.includes('USE TEMP B-TREE FOR ORDER BY')) continue;
      expect(q.pick).toBe('notified');
      const n = store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM (${q.sql.replace(/ ORDER BY [^]*$/, '')})`, q.since)!.n;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(week / 20);
      sorted++;
    }
    expect(sorted).toBe(1);
  });
});
