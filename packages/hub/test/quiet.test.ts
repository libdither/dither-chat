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
  const say = (author: string, body = 'hello', conversation = 'dm') => {
    const nativeId = `m${++n}`;
    store.ingest(d, { t: 'message', message: { nativeId, conversation, author, ts: at(2, 12) + n, body }, live: true });
    return store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
  };
  const NIGHT = at(2, 23);
  const DAY = at(3, 12);
  const HELD = 'Held by quiet hours until 07:00';
  /** Something the local model reads as urgent. */
  const URGENT = 'the door is locked, come now';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-quiet-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    triage = new Triage(store);
    // The local model, stood in for: "now" cannot wait, the rest can.
    triage.judge = async (text) => (/\bnow\b/.test(text) ? 0.9 : 0.01);
    d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
    store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
    // A channel Discord notifies every message of, which you never wrote in: its messages are on the list.
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'alerts', shape: 'channel', name: 'alerts', mute: { level: 'all' } } });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    store.setQuietHours(night);
    store.setQuietHeld(null);
  });

  test('an alert during quiet hours is held: it stays a Conversation, silent, and says why', async () => {
    const id = say('ann', URGENT);
    const r = await triage.decide(id, NIGHT);
    expect(r?.decision).toBe('quiet');
    expect(r?.reasons[0]).toBe(HELD);
    // What it would have been is still said, after that.
    expect(r?.reasons[1]).toMatch(/^Reads as urgent/);
    expect(r?.probs!.alert).toBeGreaterThanOrEqual(0.5);
    expect(store.quietHeld()).toEqual({ count: 1, conversationId: store.one<{ conversation_id: string }>('SELECT conversation_id FROM message WHERE id = ?', id)!.conversation_id, messageId: id });
  });
  test('an alert that is not a Conversation is held as a row on the list', async () => {
    store.setRule('keyword', 'deploy', 'all');
    const r = await triage.decide(say('ann', 'the deploy failed', 'alerts'), NIGHT);
    expect(r?.facts?.conv).toBe(false);
    expect(r?.decision).toBe('digest');
    expect(r?.reasons.slice(0, 2)).toEqual([HELD, 'Matches keyword “deploy”']);
    expect(store.quietHeld()?.count).toBe(1);
    // A keyword is not a person: it does not get through, allowed or not.
    expect(store.quietHours()!.allowStarred).toBe(true);
    store.setRule('keyword', 'deploy', null);
  });
  test('outside them, and with them off, it alerts', async () => {
    expect((await triage.decide(say('ann', URGENT), DAY))?.decision).toBe('push');
    store.setQuietHours({ ...night, enabled: false });
    const r = await triage.decide(say('ann', URGENT), NIGHT);
    expect(r?.decision).toBe('push');
    expect(r?.reasons).not.toContain(HELD);
    expect(store.quietHeld()).toBeNull();
  });
  test('Conversations and list rows are silent already: nothing is held, by day or by night', async () => {
    for (const now of [NIGHT, DAY]) {
      const conv = await triage.decide(say('ann', 'see you tomorrow'), now);
      expect(conv?.decision).toBe('quiet');
      expect(conv?.reasons).not.toContain(HELD);
      const listed = await triage.decide(say('ann', 'build 41 finished', 'alerts'), now);
      expect(listed?.decision).toBe('digest');
      expect(listed?.reasons).not.toContain(HELD);
    }
    expect(store.quietHeld()).toBeNull();
    expect(triage.takeHeldSummary(DAY)).toBeNull();
  });
  test('people set to always alert break through only when allowed', async () => {
    const person = store.one<{ person_id: string }>(`SELECT person_id FROM identity WHERE native_id = 'ann'`)!.person_id;
    store.setRule('person', person, 'all');
    const through = await triage.decide(say('ann'), NIGHT);
    expect(through).toMatchObject({ decision: 'push', alwaysNotify: true });
    expect(through?.reasons).not.toContain(HELD);
    expect(store.quietHeld()).toBeNull();
    store.setQuietHours({ ...night, allowStarred: false });
    const held = await triage.decide(say('ann'), NIGHT);
    expect(held?.decision).toBe('quiet');
    expect(held?.reasons.slice(0, 2)).toEqual([HELD, 'From Ann, who is set to always alert']);
    expect(store.quietHeld()?.count).toBe(1);
    store.setRule('person', person, null);
  });
  test('what was held is summed up once, after the hours end', async () => {
    await triage.decide(say('ann', URGENT), NIGHT);
    // Not an alert: not counted.
    await triage.decide(say('ann', 'good night'), NIGHT);
    const last = say('ann', URGENT);
    await triage.decide(last, NIGHT);
    expect(triage.takeHeldSummary(NIGHT)).toBeNull();
    expect(triage.takeHeldSummary(DAY)).toMatchObject({ title: 'Quiet hours are over', body: '2 messages held for you', messageId: last });
    expect(triage.takeHeldSummary(DAY)).toBeNull();
  });
});
