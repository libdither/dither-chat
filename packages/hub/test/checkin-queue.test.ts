/**
 * The Notification calibration page's hub side (checkin.ts, seen.ts, checkinstats.ts, docs/notifications.md): the
 * questions wait in a queue with a cap and an age limit, keep the chance each was picked with, and only an explicit
 * Skip counts toward the pause; each notification keeps what the devices drew and said, so the page can draw it again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ActivityStore, WORDS_KEPT } from '../src/activity.ts';
import { EXPIRE_AFTER, LATE_FLOOR, lateWeight, PAUSE, QUEUE_CAP, SKIPS_TO_PAUSE } from '../src/checkin.ts';
import { calibrationStats } from '../src/checkinstats.ts';
import { LoudLearner } from '../src/loudlearn.ts';
import { Notifier } from '../src/notify.ts';
import { seenContext } from '../src/seen.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { memTempDir } from './fixtures/memdir.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let dir: string;
let store: Store;
let acc: AccountRow;
let triage: Triage;
let loud: LoudLearner;
let n = 0;

const post = (conversation: string, author: string, ts: number, body = 'are you still coming? we leave soon') => {
  const nativeId = `m${++n}`;
  store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts, body }, live: true });
  return store.one<{ id: string; conversation_id: string }>('SELECT id, conversation_id FROM message WHERE native_id = ?', nativeId)!;
};

/** A message from Ann, decided `at`, and (when `sounded`) a notification of it that sounded. */
async function delivered(at: number, sounded: boolean) {
  const m = post(n % 2 ? 'dm' : 'g', 'ann', at - MIN);
  const d = (await triage.decide(m.id, at))!;
  store.setTriage(m.id, d, d.facts);
  store.db.query('UPDATE triage SET created_at = ? WHERE message_id = ?').run(at, m.id);
  if (sounded) store.db.query(`INSERT INTO notification (id, kind, message_id, conversation_id, sent_at, alert) VALUES (?, 'message', ?, ?, ?, 1)`).run(`n_${m.id}`, m.id, m.conversation_id, at);
  return m;
}

beforeAll(() => {
  dir = memTempDir('dither-checkin-queue-');
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  acc = store.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true, displayName: 'Me' } });
  acc = store.accounts().find((x) => x.id === acc.id)!;
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann', 'me'] } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'g', shape: 'group', name: 'Club', participants: ['ann', 'bo', 'me'] } });
  triage = new Triage(store);
  triage.judge = async (text) => (/coming|leave/.test(text) ? 0.6 : 0.01);
  loud = new LoudLearner(store, 'shadow');
  triage.loud = loud;
  triage.momentOf = () => ({ desk: false, sinceSound: null });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the queue', () => {
  test('questions build up day after day; the oldest go past the cap; none outlive the age limit; leaving one is no skip', async () => {
    store.db.exec('DELETE FROM checkin');
    store.setMetaValue('checkin_state', null);
    loud.setPrefs({ ask: 'often' });
    loud.checkins.random = () => 0.1;
    // A fixed local noon each day, the day's deliveries an hour before it.
    const day0 = new Date(2030, 2, 1, 12).getTime();
    const days = 10;
    for (let i = 0; i < days; i++) {
      const T = day0 + i * DAY;
      await delivered(T - HOUR, true);
      await delivered(T - HOUR, false);
      await delivered(T - HOUR + MIN, false);
      // Three fills across the day, each past the pace: up to three questions a day.
      for (const h of [0, 2, 4]) loud.checkins.fill(loud.prefs(), T + h * HOUR + MIN);
    }
    const all = store.raw<{ created_at: number; expired_at: number | null; skipped: number; arm: string; propensity: number; pool: number }>('SELECT * FROM checkin');
    // More than a day's worth waits, so nothing was shown and lost: they accumulate.
    expect(all.length).toBeGreaterThan(QUEUE_CAP);
    expect(loud.checkins.pendingCount()).toBe(QUEUE_CAP);
    // The ones dropped are the oldest, dropped not skipped; nothing paused.
    const dropped = all.filter((r) => r.expired_at !== null);
    const kept = all.filter((r) => r.expired_at === null);
    expect(dropped.length).toBe(all.length - QUEUE_CAP);
    expect(Math.max(...dropped.map((r) => r.created_at))).toBeLessThanOrEqual(Math.min(...kept.map((r) => r.created_at)));
    expect(all.every((r) => r.skipped === 0)).toBe(true);
    expect(loud.checkins.state().pausedUntil).toBeNull();
    // The chance each was picked with is kept, as before.
    for (const r of all) expect(r.propensity).toBeCloseTo(r.arm === 'random' ? 0.5 / r.pool : 0.5, 6);
    // The page lists them newest first, each with when it was asked.
    const last = day0 + (days - 1) * DAY + 5 * HOUR;
    const list = loud.checkins.pending(last);
    expect(list.length).toBe(QUEUE_CAP);
    expect(list.map((q) => q.askedAt)).toEqual([...list.map((q) => q.askedAt)].sort((a, b) => b - a));
    // Two weeks on, with asking set to never (so none come in), every one left has aged out.
    loud.setPrefs({ ask: 'never' });
    loud.checkins.fill(loud.prefs(), last + EXPIRE_AFTER + DAY);
    expect(loud.checkins.pendingCount()).toBe(0);
    expect(loud.checkins.state().pausedUntil).toBeNull();
    loud.setPrefs({ ask: 'often' });
  });

  test('only an explicit Skip counts toward the pause; an answer keeps when it came', () => {
    store.db.exec('DELETE FROM checkin');
    store.setMetaValue('checkin_state', null);
    const T = new Date(2030, 4, 1, 12).getTime();
    const m = post('dm', 'ann', T - 3 * DAY);
    const put = (id: string, at: number) => store.db.query(`INSERT INTO checkin (id, side, message_id, arm, propensity, pool, created_at) VALUES (?, 'quiet', ?, 'random', 0.25, 2, ?)`).run(id, m.id, at);
    for (let i = 0; i < SKIPS_TO_PAUSE - 1; i++) put(`chk_s${i}`, T), loud.checkin(`chk_s${i}`, null, T);
    // Waiting days unanswered changes nothing.
    put('chk_wait', T - 5 * DAY);
    loud.checkins.fill(loud.prefs(), T + DAY);
    expect(loud.checkins.state().pausedUntil).toBeNull();
    // An answer in between resets the run; it keeps when it was answered, days after it was asked.
    loud.checkin('chk_wait', 'fine', T + DAY);
    const r = store.one<{ answered_at: number; created_at: number }>(`SELECT answered_at, created_at FROM checkin WHERE id = 'chk_wait'`)!;
    expect(r.answered_at - r.created_at).toBe(6 * DAY);
    for (let i = 0; i < SKIPS_TO_PAUSE; i++) put(`chk_t${i}`, T), loud.checkin(`chk_t${i}`, null, T + DAY);
    expect(loud.checkins.state().pausedUntil).toBe(T + DAY + PAUSE);
    store.setMetaValue('checkin_state', null);
  });

  test('a late answer counts less in what is learned, down to a floor', () => {
    expect(lateWeight(HOUR)).toBe(1);
    expect(lateWeight(DAY)).toBe(1);
    expect(lateWeight(EXPIRE_AFTER)).toBeCloseTo(LATE_FLOOR, 6);
    expect(lateWeight(10 * EXPIRE_AFTER)).toBe(LATE_FLOOR);
    const mid = lateWeight((DAY + EXPIRE_AFTER) / 2);
    expect(mid).toBeGreaterThan(LATE_FLOOR);
    expect(mid).toBeLessThan(1);
  });
});

describe('where you saw it', () => {
  test('the words, the devices, what each said, and what showed beside it come back for the page', async () => {
    const activity = new ActivityStore(store);
    // A moment just past, so the devices' words (kept no later than now, no earlier than the send) land as given.
    const T = Date.now() + 2000;
    const other = post('g', 'ann', T - 10 * MIN, 'lunch at noon?');
    const m = post('dm', 'ann', T - MIN, 'are you still coming?');
    const make = () =>
      new Notifier({
        store: { notifyLook: () => ({ network: 'signal' }), one: () => null },
        phone: { list: () => ({ send: true }), higher: () => {} } as any,
        activity,
        devices: { addressed: () => false, quietOn: () => [] },
        push: {
          desktops: () => [],
          notify: async () => ({ devices: 2, accepted: 2, to: [{ id: 'sub_phone', label: 'Android app', android: true, ok: true }, { id: 'sub_desk', label: 'Firefox on Linux', android: false, ok: true }] }),
        },
        delivery: {
          listDue: () => true,
          conversationDue: () => true,
          inUse: () => true,
          plan: (conv: string) => ({ alert: true, count: 1, conv: { title: conv === other.conversation_id ? 'Club' : 'Ann', shape: conv === other.conversation_id ? 'group' : 'direct' }, sender: { name: 'Ann', key: 'ann' }, lines: [{ author: 'Ann', key: 'ann', body: 'are you still coming?', ts: T - MIN }], icons: {} }),
        },
        server: { notify: () => {}, warm: async () => {}, watched: () => false },
      });
    const notifier = make();
    notifier.message('Club', 'Ann: lunch at noon?', other.conversation_id, other.id, [], {}, 'message', 'push');
    await notifier.last;
    notifier.message('Ann', 'are you still coming?', m.conversation_id, m.id, [], {}, 'message', 'push');
    await notifier.last;
    const nid = store.one<{ id: string }>('SELECT id FROM notification WHERE message_id = ?', m.id)!.id;
    // The phone showed it on the lock screen, vibrating, beside the club's; the computer said nothing more than shown.
    activity.events([
      { id: nid, device: 'sub_phone', event: 'delivered', at: T },
      { id: nid, device: 'sub_phone', event: 'shown', at: T + 1000, seen: { surface: 'lock', sound: 'vibrate', locked: true, screenOn: false, beside: [other.conversation_id, 'nope'] } },
      { id: nid, device: 'sub_desk', event: 'shown', at: T + 2000 },
      // Junk in the device's word is dropped, not kept.
      { id: nid, device: 'sub_desk', event: 'dismissed', at: T + 3000, seen: { surface: 'everywhere', sound: 42 } as any },
    ], T + HOUR);
    const ctx = seenContext(store.db, m.id, { title: 'Ann', preview: 'are you still coming?', at: T - MIN, network: 'signal', shape: 'direct', conversationId: m.conversation_id });
    expect(ctx.sent).toMatchObject({ title: 'Ann', body: 'are you still coming?', network: 'signal', computerInUse: true, tier: 'push', sounded: true });
    expect(ctx.sent!.lines).toEqual([{ author: 'Ann', body: 'are you still coming?', ts: T - MIN }]);
    const phone = ctx.sent!.devices.find((d) => d.label === 'Android app')!;
    expect(phone).toMatchObject({ kind: 'android', phone: true, meantToSound: true, surface: 'lock', sound: 'vibrate', locked: true, screenOn: false, delivered: T, shown: T + 1000 });
    expect(phone.beside).toEqual([{ title: 'Club', body: 'Ann: lunch at noon?', at: expect.any(Number) }]);
    const desk = ctx.sent!.devices.find((d) => d.label === 'Firefox on Linux')!;
    expect(desk).toMatchObject({ kind: 'browser', phone: false, surface: null, sound: null, dismissed: T + 3000, beside: null });
    expect(store.one<{ seen: string | null }>(`SELECT seen FROM notification_event WHERE notification_id = ? AND event = 'dismissed'`, nid)!.seen).toBeNull();
    // Said honestly: the computer showed it without saying where.
    expect(ctx.unknown.some((u) => /didn't say where/.test(u))).toBe(true);
    // A push it skipped, and the first visit after it.
    const q = post('dm', 'ann', T, 'quiet one');
    store.db.query(`INSERT INTO push_skip (message_id, conversation_id, why, at) VALUES (?, ?, 'watched', ?)`).run(q.id, q.conversation_id, T);
    activity.visits([{ id: 'v_1', device: 'dev_1', deviceLabel: 'Firefox on Linux', view: 'conversation', conversationId: q.conversation_id, start: T + 5 * MIN, end: T + 6 * MIN, active: 30, source: 'inbox' } as any], T + 7 * MIN);
    const qc = seenContext(store.db, q.id, { title: 'Ann', preview: 'quiet one', at: T, network: 'signal', shape: 'direct', conversationId: q.conversation_id });
    expect(qc.sent).toBeNull();
    expect(qc.notSent).toBe('watched');
    expect(qc.opened).toMatchObject({ source: 'inbox', device: 'Firefox on Linux', phone: false });
    // The words are kept only a while; the row and its times stay.
    activity.prune(T + WORDS_KEPT + DAY, true);
    const later = seenContext(store.db, m.id, { title: 'Ann', preview: 'are you still coming?', at: T - MIN, network: 'signal', shape: 'direct', conversationId: m.conversation_id });
    expect(later.sent).toMatchObject({ title: null, body: null, lines: [] });
    expect(later.sent!.devices.length).toBe(2);
  });

  test('the numbers: answers, delays and the model against what you said', () => {
    store.db.exec('DELETE FROM checkin');
    const T = Date.now();
    const ms = store.raw<{ message_id: string }>(`SELECT message_id FROM triage WHERE loud_view IS NOT NULL LIMIT 4`);
    expect(ms.length).toBe(4);
    const put = (i: number, side: string, answer: string | null, asked: number, answered: number | null) =>
      store.db.query(`INSERT INTO checkin (id, side, message_id, arm, propensity, pool, created_at, answer, answered_at) VALUES (?, ?, ?, 'random', 0.5, 1, ?, ?, ?)`).run(`chk_n${i}`, side, ms[i].message_id, asked, answer, answered);
    put(0, 'sounded', 'worth', T - 2 * DAY, T - DAY);
    put(1, 'sounded', 'could_wait', T - 2 * DAY, T - 2 * DAY + HOUR);
    put(2, 'quiet', 'sooner', T - DAY, T - DAY + 3 * HOUR);
    put(3, 'quiet', null, T - HOUR, null);
    const s = calibrationStats(store.db, T);
    expect(s).toMatchObject({ pending: 1, answered: 3, answers: { worth: 1, couldWait: 1, sooner: 1 } });
    expect(s.delay.median).toBe(3 * HOUR);
    expect(s.delay.mean).toBeCloseTo((DAY + HOUR + 3 * HOUR) / 3, 0);
    expect(s.calibration.n).toBe(3);
    expect(s.calibration.bins.reduce((a, b) => a + b.n, 0)).toBe(3);
    expect(s.calibration.brier).not.toBeNull();
  });
});
