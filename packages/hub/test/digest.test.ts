import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { Store, type AccountRow } from '../src/store.ts';
import { digestSlot, Triage, validDailyDigest } from '../src/triage.ts';

// 2026-11-02 is a Monday. All in UTC, to keep the arithmetic in plain sight.
const at = (day: number, hh: number, mm = 0) => Date.UTC(2026, 10, day, hh, mm);
const six: P.DailyDigest = { enabled: true, time: '18:00', timezone: 'UTC' };
const night: P.QuietHours = { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC', allowStarred: true };

describe('the slot', () => {
  test('is today from the time on, yesterday before it', () => {
    expect(digestSlot(six, at(2, 17, 59))).toBe('2026-11-01');
    expect(digestSlot(six, at(2, 18))).toBe('2026-11-02');
    expect(digestSlot(six, at(3, 0, 1))).toBe('2026-11-02');
  });
  test('uses the configured zone, across a month end', () => {
    expect(digestSlot({ time: '08:00', timezone: 'Asia/Tokyo' }, at(1, 0))).toBe('2026-11-01'); // 09:00 there
    expect(digestSlot({ time: '10:00', timezone: 'Asia/Tokyo' }, at(1, 0))).toBe('2026-10-31');
  });
  test('daylight saving neither skips nor doubles a day', () => {
    const ny = { time: '01:30', timezone: 'America/New_York' };
    // Fall back on 2026-11-01: 01:30 happens twice, in the same slot.
    expect(digestSlot(ny, Date.UTC(2026, 10, 1, 5, 30))).toBe('2026-11-01');
    expect(digestSlot(ny, Date.UTC(2026, 10, 1, 6, 30))).toBe('2026-11-01');
    expect(digestSlot(ny, Date.UTC(2026, 10, 1, 5, 0))).toBe('2026-10-31');
    // Spring forward on 2026-03-08: 02:30 never happens, and it is due at 03:00.
    const gap = { time: '02:30', timezone: 'America/New_York' };
    expect(digestSlot(gap, Date.UTC(2026, 2, 8, 6, 59))).toBe('2026-03-07');
    expect(digestSlot(gap, Date.UTC(2026, 2, 8, 7, 0))).toBe('2026-03-08');
  });
  test('validation', () => {
    expect(validDailyDigest(six)).toBe(true);
    expect(validDailyDigest({ ...six, time: '24:00' })).toBe(false);
    expect(validDailyDigest({ ...six, timezone: 'Mars/Olympus' })).toBe(false);
    expect(validDailyDigest({ enabled: true })).toBe(false);
  });
});

describe('sending it', () => {
  let dir: string;
  let store: Store;
  let triage: Triage;
  let d: AccountRow;
  let n = 0;
  /** A message the rules put in the digest, decided at this moment. */
  const gather = (conversation: string, when: number, decision: P.TriageDecision = 'digest') => {
    const nativeId = `m${++n}`;
    store.ingest(d, { t: 'message', message: { nativeId, conversation, author: 'ann', ts: when, body: 'hello' }, live: true });
    const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
    store.setTriage(id, { decision, score: null, reasons: [], decidedBy: 'rules' });
    store.db.query('UPDATE triage SET created_at = ? WHERE message_id = ?').run(when, id);
    return id;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-digest-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    triage = new Triage(store);
    d = store.createAccount({ network: 'matrix', label: 'd', color: '#000', adapter: 'matrix' });
    store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
    for (const g of ['Climbing', 'Kitchen', 'Books', 'Movies', 'Runs']) store.ingest(d, { t: 'conversation', conversation: { nativeId: g, shape: 'group', name: g } });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    store.db.query('DELETE FROM triage').run();
    store.db.query(`DELETE FROM meta WHERE key IN ('daily_digest', 'daily_digest_state', 'quiet_hours', 'quiet_held')`).run();
  });

  test('off by default', () => {
    gather('Climbing', at(2, 10));
    expect(triage.takeDailyDigest(at(9, 18))).toBeNull();
  });
  test('turning it on sends nothing at once, even past the time, and what came before does not count', () => {
    gather('Climbing', at(2, 10));
    triage.setDailyDigest(six, at(2, 19));
    expect(triage.takeDailyDigest(at(2, 19, 1))).toBeNull();
    expect(triage.takeDailyDigest(at(3, 18))).toBeNull(); // nothing since
    gather('Kitchen', at(3, 19));
    expect(triage.takeDailyDigest(at(4, 18))).toMatchObject({ title: 'Daily digest: 1 message', body: 'Kitchen (1).' });
  });
  test('counts, busiest places first, and only digest entries', () => {
    triage.setDailyDigest(six, at(1, 19));
    for (const [g, k] of [['Climbing', 1], ['Kitchen', 4], ['Books', 2], ['Movies', 2], ['Runs', 1]] as const) for (let i = 0; i < k; i++) gather(g, at(2, 10 + i));
    gather('dm', at(2, 11), 'push');
    gather('dm', at(2, 11), 'silent');
    const deleted = gather('Runs', at(2, 12));
    store.db.query('UPDATE message SET deleted = 1 WHERE id = ?').run(deleted);
    const r = triage.takeDailyDigest(at(2, 18))!;
    expect(r.title).toBe('Daily digest: 10 messages');
    expect(r.body).toMatch(/^Kitchen \(4\), (Books|Movies) \(2\), (Books|Movies) \(2\), and 2 more places\.$/);
  });
  test('once a slot, each digest starting where the last one stopped', () => {
    triage.setDailyDigest(six, at(1, 19));
    gather('Climbing', at(2, 10));
    expect(triage.takeDailyDigest(at(2, 18))?.body).toBe('Climbing (1).');
    gather('Climbing', at(2, 18, 30));
    expect(triage.takeDailyDigest(at(2, 19))).toBeNull();
    expect(triage.takeDailyDigest(at(3, 17, 59))).toBeNull();
    expect(triage.takeDailyDigest(at(3, 18))).toMatchObject({ title: 'Daily digest: 1 message' });
  });
  test('after downtime it catches up once, and a restart changes nothing', () => {
    triage.setDailyDigest(six, at(1, 19));
    gather('Climbing', at(2, 10));
    gather('Kitchen', at(5, 10));
    const restarted = new Triage(new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null));
    expect(restarted.takeDailyDigest(at(7, 9))).toMatchObject({ title: 'Daily digest: 2 messages' });
    expect(restarted.takeDailyDigest(at(7, 9, 1))).toBeNull();
    expect(new Triage(new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null)).takeDailyDigest(at(7, 12))).toBeNull();
  });
  test('moving the time does not send a second one that day', () => {
    triage.setDailyDigest({ ...six, time: '08:00' }, at(1, 19));
    gather('Climbing', at(2, 7));
    expect(triage.takeDailyDigest(at(2, 8))).not.toBeNull();
    triage.setDailyDigest({ ...six, time: '20:00' }, at(2, 12));
    gather('Climbing', at(2, 13));
    expect(triage.takeDailyDigest(at(2, 20))).toBeNull();
    expect(triage.takeDailyDigest(at(3, 20))).toMatchObject({ title: 'Daily digest: 1 message' });
  });
  test('turning it off and on forgets what piled up meanwhile', () => {
    triage.setDailyDigest(six, at(1, 19));
    triage.setDailyDigest({ ...six, enabled: false }, at(2, 1));
    gather('Climbing', at(2, 10));
    expect(triage.takeDailyDigest(at(2, 18))).toBeNull();
    triage.setDailyDigest(six, at(2, 19));
    expect(triage.takeDailyDigest(at(3, 18))).toBeNull();
  });
  test('quiet hours hold it until they end, and it replaces their summary', () => {
    store.setQuietHours(night);
    triage.setDailyDigest({ ...six, time: '23:00' }, at(2, 12));
    gather('Climbing', at(2, 15));
    gather('Kitchen', at(2, 22, 30));
    store.setQuietHeld({ count: 1, conversationId: 'x', messageId: 'y' });
    expect(triage.takeDailyDigest(at(2, 23))).toBeNull();
    expect(triage.takeDailyDigest(at(3, 6, 59))).toBeNull();
    expect(triage.takeHeldSummary(at(3, 6, 59))).toBeNull();
    const r = triage.takeDailyDigest(at(3, 7))!;
    expect(r.title).toBe('Daily digest: 2 messages');
    expect(r.body).toContain('Includes 1 held by quiet hours.');
    expect(triage.takeHeldSummary(at(3, 7))).toBeNull();
    expect(triage.takeDailyDigest(at(3, 7, 1))).toBeNull();
  });
  test('when there is nothing to report, the quiet hours summary still goes', () => {
    store.setQuietHours(night);
    triage.setDailyDigest({ ...six, time: '23:00' }, at(2, 12));
    store.setQuietHeld({ count: 2, conversationId: 'x', messageId: 'y' });
    expect(triage.takeDailyDigest(at(3, 7))).toBeNull();
    expect(triage.takeHeldSummary(at(3, 7))).toMatchObject({ body: '2 messages held for you' });
  });
});
