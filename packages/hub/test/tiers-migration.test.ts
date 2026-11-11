/**
 * A database from before the tiers, opened by this hub (store.ts `toTiers`, docs/notifications.md): the four levels
 * become three tiers once, in place. What was Important or Active becomes a Conversation in a DM or a group chat and
 * a list row elsewhere, Digest and below go below the list, each row keeps what it was and takes the old Active chance
 * as its importance; rules set to Smart go, the daily digest's settings go, and a second start changes nothing. And
 * the older triage tables still come across on the way.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const NOW = Date.UTC(2026, 10, 3, 12);
const open = (path: string) => new Store(path, (raw) => raw ?? null);

/** A temp dir for one test's database, removed after. */
async function inDir(name: string, fn: (path: string, dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), `dither-${name}-`));
  try {
    await fn(join(dir, 'hub.sqlite'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the four levels become three tiers, once', () => {
  /** Old decisions: [message, conversation, decision, the chances the old model kept or null, its score, a vote]. */
  const OLD: [string, string, string, { ping: number; active: number; interesting: number } | null, number | null, string | null][] = [
    ['dm-push', 'dm', 'push', { ping: 0.9, active: 0.95, interesting: 0.99 }, 0.947, null],
    ['dm-quiet', 'dm', 'quiet', { ping: 0.2, active: 0.7, interesting: 0.9 }, 0.6, 'push'],
    ['dm-digest', 'dm', 'digest', { ping: 0.05, active: 0.3, interesting: 0.6 }, 0.317, null],
    ['dm-rules', 'dm', 'push', null, null, null],
    ['grp-push', 'grp', 'push', { ping: 0.85, active: 0.9, interesting: 0.95 }, 0.9, null],
    ['grp-quiet', 'grp', 'quiet', { ping: 0.1, active: 0.6, interesting: 0.8 }, 0.5, null],
    ['grp-drop', 'grp', 'drop', { ping: 0.01, active: 0.05, interesting: 0.2 }, 0.087, 'digest'],
    ['ch-push', 'ch', 'push', { ping: 0.9, active: 0.92, interesting: 0.97 }, 0.93, null],
    ['ch-quiet', 'ch', 'quiet', { ping: 0.3, active: 0.55, interesting: 0.8 }, 0.55, null],
    ['ch-digest', 'ch', 'digest', null, 0.4, null],
    ['ch-drop', 'ch', 'drop', { ping: 0.01, active: 0.02, interesting: 0.1 }, 0.043, null],
    ['ch-silent', 'ch', 'silent', null, null, null],
    ['th-push', 'th', 'push', { ping: 0.8, active: 0.85, interesting: 0.9 }, 0.85, null],
    ['th-quiet', 'th', 'quiet', { ping: 0.3, active: 0.5, interesting: 0.7 }, 0.5, null],
  ];
  /** What each becomes: the tier, what it was, its importance. */
  const NEW: Record<string, [string, string | null, number | null]> = {
    'dm-push': ['quiet', 'push', 0.95],
    'dm-quiet': ['quiet', 'quiet', 0.7],
    'dm-digest': ['drop', 'digest', 0.3],
    // Decided by the rules alone, with no chances kept: the score it had.
    'dm-rules': ['quiet', 'push', null],
    'grp-push': ['quiet', 'push', 0.9],
    'grp-quiet': ['quiet', 'quiet', 0.6],
    'grp-drop': ['drop', 'drop', 0.05],
    'ch-push': ['digest', 'push', 0.92],
    'ch-quiet': ['digest', 'quiet', 0.55],
    'ch-digest': ['drop', 'digest', 0.4],
    'ch-drop': ['drop', 'drop', 0.02],
    'ch-silent': ['silent', null, null],
    'th-push': ['digest', 'push', 0.85],
    'th-quiet': ['digest', 'quiet', 0.5],
  };

  /** A database as the hub before the tiers left it. Returns its ids. */
  function before(path: string) {
    const s = open(path);
    const acc = s.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
    s.ingest(acc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    s.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
    s.ingest(acc, { t: 'conversation', conversation: { nativeId: 'grp', shape: 'group', name: 'Club', participants: ['ann', 'bo'] } });
    s.ingest(acc, { t: 'space', space: { nativeId: 'guild', kind: 'community', name: 'Hub' } });
    s.ingest(acc, { t: 'conversation', conversation: { nativeId: 'ch', shape: 'channel', name: 'general', spaces: [{ nativeId: 'guild' }] } });
    s.ingest(acc, { t: 'conversation', conversation: { nativeId: 'th', shape: 'thread', name: 'A thread', parentConversation: 'ch', spaces: [{ nativeId: 'guild' }] } });
    const conv = (n: string) => s.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', n)!.id;
    const ids: Record<string, string> = {};
    OLD.forEach(([name, c, decision, probs, score, feedback], i) => {
      s.ingest(acc, { t: 'message', message: { nativeId: name, conversation: c, author: 'ann', ts: NOW + i * 1000, body: `about ${name}` }, live: true });
      ids[name] = s.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', name)!.id;
      s.db
        .query(`INSERT INTO triage (message_id, decision, score, reasons, decided_by, feedback, feedback_at, probs, shadow, created_at) VALUES (?, ?, ?, '["Signal notifies every message here"]', 'rules', ?, ?, ?, ?, ?)`)
        .run(ids[name], decision, score, feedback, feedback ? NOW : null, probs ? JSON.stringify(probs) : null, probs ? JSON.stringify(probs) : null, NOW + i * 1000);
    });
    // Its rules: Smart everywhere and on one chat; the ones that stay.
    const person = s.one<{ person_id: string }>(`SELECT person_id FROM identity WHERE native_id = 'ann'`)!.person_id;
    const space = s.one<{ id: string }>('SELECT id FROM space')!.id;
    s.setRule('global', null, 'smart');
    s.setRule('conversation', conv('grp'), 'smart');
    s.setRule('conversation', conv('ch'), 'mentions');
    s.setRule('conversation', conv('dm'), 'all');
    s.setRule('space', space, 'digest');
    s.setRule('conversation', conv('th'), 'none');
    s.setRule('person', person, 'all');
    s.setRule('keyword', 'deploy', 'all');
    // Its daily digest, the index its inbox walked, and no word of the tiers.
    s.db.exec(`
      INSERT INTO meta (key, value) VALUES ('daily_digest', '{"enabled":true,"time":"18:00","timezone":"UTC"}'), ('daily_digest_state', '{"slot":"2026-11-02","since":1}');
      CREATE INDEX triage_level_score ON triage(COALESCE(feedback, decision), score);
      DELETE FROM meta WHERE key = 'tiers_at';
      UPDATE meta SET value = 'before-the-tiers' WHERE key = 'schema_sig';`);
    const made = { ids, conv: { dm: conv('dm'), grp: conv('grp'), ch: conv('ch'), th: conv('th') }, person, space };
    s.db.close();
    return made;
  }
  const rows = (s: Store, ids: Record<string, string>) =>
    Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, Object.values(s.one<Record<string, unknown>>('SELECT decision, was, score FROM triage WHERE message_id = ?', id)!)]));
  const rules = (s: Store) => s.rules().map((r) => `${r.scope}:${r.level}`).sort();

  test('each decision moves to its tier, keeping what it was and taking the old Active chance as its importance', () =>
    inDir('to-tiers', (path, dir) => {
      const { ids } = before(path);
      const t0 = Date.now();
      const s = open(path);
      expect(rows(s, ids)).toEqual(NEW);
      // No message from before the tiers is an alert now.
      expect(s.one<{ n: number }>(`SELECT COUNT(*) AS n FROM triage WHERE decision = 'push'`)!.n).toBe(0);
      // The votes stay as they were, as history; what the old models predicted stays too, unread.
      expect(s.one<{ feedback: string }>('SELECT feedback FROM triage WHERE message_id = ?', ids['dm-quiet'])!.feedback).toBe('push');
      expect(s.one<{ feedback: string }>('SELECT feedback FROM triage WHERE message_id = ?', ids['grp-drop'])!.feedback).toBe('digest');
      expect(JSON.parse(s.one<{ probs: string }>('SELECT probs FROM triage WHERE message_id = ?', ids['dm-push'])!.probs)).toEqual({ ping: 0.9, active: 0.95, interesting: 0.99 });
      // The app is not handed three chances as if they were the two; the tier, the importance and the old vote, it is.
      const view = (name: string) => s.messageViews([s.one('SELECT * FROM message WHERE id = ?', ids[name])!])[0].triage!;
      expect(view('dm-quiet')).toEqual({ decision: 'quiet', score: 0.7, reasons: ['Signal notifies every message here'], decidedBy: 'rules', feedback: 'push', probs: null });
      expect(view('ch-push')).toMatchObject({ decision: 'digest', score: 0.92, feedback: null, probs: null });
      // When it happened is kept: what stood before then says nothing about alerts.
      expect(s.tiersAt()).toBeGreaterThanOrEqual(t0);
      expect(s.tiersAt()).toBeLessThanOrEqual(Date.now());
      // The inbox walks the new index; the old one is gone.
      const indexes = (s.db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'triage'`).all() as { name: string }[]).map((r) => r.name);
      expect(indexes).toContain('triage_tier_score');
      expect(indexes).not.toContain('triage_level_score');
      // A schema it had not met: copied aside before any of it.
      expect(readdirSync(join(dir, 'backups')).filter((f) => /^pre-migrate-.*\.sqlite$/.test(f))).toHaveLength(1);
      const copy = new Database(join(dir, 'backups', readdirSync(join(dir, 'backups'))[0]), { readonly: true });
      expect((copy.query('SELECT decision FROM triage WHERE message_id = ?').get(ids['dm-push']) as { decision: string }).decision).toBe('push');
      copy.close();
      s.db.close();
    }));

  test('rules set to Smart become Automatic; the others stay; the daily digest’s settings go', () =>
    inDir('to-tiers-rules', (path) => {
      const made = before(path);
      const s = open(path);
      expect(rules(s)).toEqual(['conversation:all', 'conversation:mentions', 'conversation:none', 'keyword:all', 'person:all', 'space:digest']);
      expect(s.rules().find((r) => r.scope === 'global')).toBeUndefined();
      expect(s.rules().find((r) => r.target === made.conv.grp)).toBeUndefined();
      expect(s.rules().find((r) => r.scope === 'person')).toMatchObject({ target: made.person, level: 'all' });
      expect(s.one(`SELECT 1 FROM meta WHERE key IN ('daily_digest', 'daily_digest_state')`)).toBeNull();
      // What the rules that stayed mean now: Always alert, Mute, and the group back to what Signal does with it.
      const triage = new Triage(s);
      expect(triage.effectiveLevel(made.conv.dm)).toMatchObject({ level: 'all', explicit: true });
      expect(triage.effectiveLevel(made.conv.th)).toMatchObject({ level: 'none', explicit: true });
      expect(triage.effectiveLevel(made.conv.ch)).toMatchObject({ level: 'mentions', explicit: true });
      expect(triage.effectiveLevel(made.conv.grp)).toMatchObject({ level: 'all', explicit: false, native: true });
      s.db.close();
    }));

  test('a second start changes nothing, and never touches what was decided since', () =>
    inDir('to-tiers-once', async (path, dir) => {
      const { ids } = before(path);
      const first = open(path);
      const at = first.tiersAt();
      // Since the tiers: an alert in the channel, a row below the list in the DM, a rule, and a level for the list.
      const acc = first.accounts()[0];
      const fresh: [string, string, P.TriageDecision][] = [['new-alert', 'ch', 'push'], ['new-below', 'dm', 'drop'], ['new-list', 'dm', 'digest']];
      for (const [name, c, decision] of fresh) {
        first.ingest(acc, { t: 'message', message: { nativeId: name, conversation: c, author: 'ann', ts: NOW + 60_000, body: name }, live: true });
        ids[name] = first.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', name)!.id;
        first.setTriage(ids[name], { decision, score: 0.42, reasons: [], decidedBy: 'rules', probs: { alert: 0.7, important: 0.42 } });
      }
      first.setListLevel(0.4);
      const want = { ...NEW, 'new-alert': ['push', null, 0.42], 'new-below': ['drop', null, 0.42], 'new-list': ['digest', null, 0.42] };
      expect(rows(first, ids)).toEqual(want);
      const ruled = rules(first);
      first.db.close();

      const second = open(path);
      expect(rows(second, ids)).toEqual(want);
      expect(second.tiersAt()).toBe(at);
      expect(rules(second)).toEqual(ruled);
      expect(second.listLevel()).toBe(0.4);
      // The same schema as last time: no second copy.
      expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
      // Even a rule set to Smart by hand since, or a schema that changes again, moves nothing a second time.
      second.setRule('conversation', 'cnv_x', 'smart');
      second.db.exec(`UPDATE meta SET value = 'another-schema' WHERE key = 'schema_sig'`);
      second.db.close();
      const third = open(path);
      expect(rows(third, ids)).toEqual(want);
      expect(third.tiersAt()).toBe(at);
      expect(rules(third)).toContain('conversation:smart');
      third.db.close();
    }));

  test('a new database starts with the tiers: nothing to move, then or later', () =>
    inDir('to-tiers-new', (path) => {
      const s = open(path);
      const at = s.tiersAt();
      expect(at).toBeGreaterThan(0);
      const acc = s.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
      s.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
      s.ingest(acc, { t: 'message', message: { nativeId: 'x', conversation: 'dm', author: 'ann', ts: NOW, body: 'hi' }, live: true });
      const id = s.one<{ id: string }>('SELECT id FROM message')!.id;
      s.setTriage(id, { decision: 'push', score: 0.8, reasons: [], decidedBy: 'rules', probs: { alert: 0.9, important: 0.8 } });
      s.db.close();
      const again = open(path);
      expect(again.one('SELECT decision, was, score FROM triage WHERE message_id = ?', id)).toEqual({ decision: 'push', was: null, score: 0.8 });
      expect(again.tiersAt()).toBe(at);
      again.db.close();
    }));
});

describe('older triage tables come across', () => {
  /** A database whose triage table is from before Active (v1) or before "below the digest" (v2), with one decision in a DM. */
  function older(path: string, v: 'v1' | 'v2', beforeTiers: boolean): string {
    const s1 = open(path);
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
      s1.db.query(`INSERT INTO triage VALUES (?, 'digest', 0.4, '[]', 'rules', 'quiet', 5, '{"x":1}', 4)`).run(mid);
    }
    if (beforeTiers) s1.db.exec(`DELETE FROM meta WHERE key = 'tiers_at'`);
    s1.db.close();
    return mid;
  }

  test('v1 feedback as votes, v2 as it was; a decision made since is kept in the table as it is now', () => {
    for (const v of ['v1', 'v2'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `dither-triage-${v}-`));
      try {
        const path = join(dir, 'hub.sqlite');
        const mid = older(path, v, false);
        const s2 = open(path);
        expect(s2.one<any>('SELECT decision, feedback, feedback_at FROM triage')).toEqual(v === 'v1' ? { decision: 'push', feedback: 'digest', feedback_at: 5 } : { decision: 'digest', feedback: 'quiet', feedback_at: 5 });
        if (v === 'v2') expect(s2.one<any>('SELECT facts FROM triage').facts).toBe('{"x":1}');
        s2.setTriage(mid, { decision: 'drop', score: 0.1, reasons: [], decidedBy: 'rules', probs: { alert: 0.02, important: 0.1 } });
        expect(s2.one<any>('SELECT decision, feedback, probs FROM triage')).toEqual({ decision: 'drop', feedback: v === 'v1' ? 'digest' : 'quiet', probs: '{"alert":0.02,"important":0.1}' });
        // Marks fit the adopted table as they fit a new one.
        s2.triageMark(mid, { less: true }, 9);
        expect(s2.one<any>('SELECT less_mark, marked_at FROM triage')).toEqual({ less_mark: 1, marked_at: 9 });
        const db = new Database(path);
        expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'triage_v1'`).get()).toBeNull();
        expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'triage_feedback'`).get()).not.toBeNull();
        expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'triage_tier_score'`).get()).not.toBeNull();
        db.close();
        s2.db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('from a database that never met the tiers, they come across and move to their tier in the same start', () =>
    inDir('triage-older', (path) => {
      // v1: Important in a DM, voted "should not push": a Conversation now, the vote kept as one for Digest.
      const mid = older(path, 'v1', true);
      const s = open(path);
      expect(s.one<any>('SELECT decision, was, feedback FROM triage WHERE message_id = ?', mid)).toEqual({ decision: 'quiet', was: 'push', feedback: 'digest' });
      expect(s.tiersAt()).toBeGreaterThan(0);
      s.db.close();
    }));

  test('the same for the table from before "below the digest"', () =>
    inDir('triage-older-v2', (path) => {
      // v2: Digest in a DM, voted up to Active: below the list now, its score and facts kept, the vote kept.
      const mid = older(path, 'v2', true);
      const s = open(path);
      expect(s.one<any>('SELECT decision, was, score, feedback, facts FROM triage WHERE message_id = ?', mid)).toEqual({ decision: 'drop', was: 'digest', score: 0.4, feedback: 'quiet', facts: '{"x":1}' });
      s.db.close();
    }));
});
