import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { Store, type AccountRow } from '../src/store.ts';
import { inQuietHours, Triage, validQuietHours } from '../src/triage.ts';

// 2026-11-02 is a Monday. All in UTC, to keep the arithmetic in plain sight.
const at = (day: number, hh: number, mm = 0) => Date.UTC(2026, 10, day, hh, mm);
const night: P.QuietHours = { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC', allowStarred: true };

describe('the schedule', () => {
  test('a window across midnight', () => {
    expect(inQuietHours(night, at(2, 23))).toBe(true);
    expect(inQuietHours(night, at(3, 6, 59))).toBe(true);
    expect(inQuietHours(night, at(3, 7))).toBe(false);
    expect(inQuietHours(night, at(3, 12))).toBe(false);
  });
  test('a window within a day', () => {
    const q = { ...night, start: '09:00', end: '17:00' };
    expect(inQuietHours(q, at(2, 8, 59))).toBe(false);
    expect(inQuietHours(q, at(2, 9))).toBe(true);
    expect(inQuietHours(q, at(2, 17))).toBe(false);
  });
  test('off, or no window at all', () => {
    expect(inQuietHours(null, at(2, 23))).toBe(false);
    expect(inQuietHours({ ...night, enabled: false }, at(2, 23))).toBe(false);
    expect(inQuietHours({ ...night, end: '22:00' }, at(2, 23))).toBe(false);
  });
  test('a morning belongs to the day the window started on', () => {
    const friday = { ...night, days: [5] };
    expect(inQuietHours(friday, at(6, 23))).toBe(true); // Friday night
    expect(inQuietHours(friday, at(7, 3))).toBe(true); //  Saturday morning
    expect(inQuietHours(friday, at(6, 3))).toBe(false); // Friday morning began on Thursday
    expect(inQuietHours(friday, at(7, 23))).toBe(false);
  });
  test('uses the configured zone, not the machine', () => {
    const tokyo = { ...night, timezone: 'Asia/Tokyo' }; // UTC+9
    expect(inQuietHours(tokyo, at(2, 14))).toBe(true); // 23:00 there
    expect(inQuietHours(tokyo, at(2, 23))).toBe(false); // 08:00 there
  });
  test('validation', () => {
    expect(validQuietHours(night)).toBe(true);
    expect(validQuietHours({ ...night, start: '25:00' })).toBe(false);
    expect(validQuietHours({ ...night, timezone: 'Mars/Olympus' })).toBe(false);
  });
});

describe('triage', () => {
  let dir: string;
  let store: Store;
  let triage: Triage;
  let d: AccountRow;
  let n = 0;
  const say = (author: string, body = 'hello') => {
    const nativeId = `m${++n}`;
    store.ingest(d, { t: 'message', message: { nativeId, conversation: 'dm', author, ts: at(2, 12) + n, body }, live: true });
    return store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
  };
  const NIGHT = at(2, 23);
  const DAY = at(3, 12);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-quiet-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    triage = new Triage(store);
    d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
    store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    store.setQuietHours(night);
    store.setQuietHeld(null);
  });

  test('a push during quiet hours becomes a digest entry that says why', async () => {
    const r = await triage.decide(say('ann'), NIGHT);
    expect(r?.decision).toBe('digest');
    expect(r?.reasons[0]).toBe('Held by quiet hours until 07:00');
  });
  test('outside them, and with them off, it pushes', async () => {
    expect((await triage.decide(say('ann'), DAY))?.decision).toBe('push');
    store.setQuietHours({ ...night, enabled: false });
    expect((await triage.decide(say('ann'), NIGHT))?.decision).toBe('push');
  });
  test('people set to always notify break through only when allowed', async () => {
    const person = store.one<{ person_id: string }>(`SELECT person_id FROM identity WHERE native_id = 'ann'`)!.person_id;
    store.setRule('person', person, 'all');
    expect((await triage.decide(say('ann'), NIGHT))?.decision).toBe('push');
    store.setQuietHours({ ...night, allowStarred: false });
    expect((await triage.decide(say('ann'), NIGHT))?.decision).toBe('digest');
    store.setRule('person', person, null);
  });
  test('what was held is summed up once, after the hours end', async () => {
    await triage.decide(say('ann'), NIGHT);
    const last = say('ann');
    await triage.decide(last, NIGHT);
    expect(triage.takeHeldSummary(NIGHT)).toBeNull();
    expect(triage.takeHeldSummary(DAY)).toMatchObject({ body: '2 messages held for you', messageId: last });
    expect(triage.takeHeldSummary(DAY)).toBeNull();
  });
});
