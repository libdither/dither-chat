/**
 * The phone's list (phonelist.ts, docs/notifications.md "The phone's list"): the gate, the day's coins and their
 * chances, the cap, swipes and clear-alls, expiry, the modes, a restart; and that alerts and Conversations go out
 * exactly as they did (notify.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityStore } from '../src/activity.ts';
import { LABEL_WEIGHTS } from '../src/labels.ts';
import { Notifier, type Tier } from '../src/notify.ts';
import { BULK_MS, dayOf, EXPIRE_MS, LIST_CAP, listByPrior, PhoneList, phoneListMode, SNOOZE_MS, TRIALS_PER_DAY, type PhoneListMode } from '../src/phonelist.ts';
import { Store } from '../src/store.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Mid-morning, local time: a day's coins stay on one day. */
const T0 = new Date(2026, 10, 12, 9, 0, 0).getTime();

let dir: string;
let store: Store;
let activity: ActivityStore;
const kept = new Set<string>();
const reads = new Map<string, number>();

function phoneList(mode: PhoneListMode, random: () => number = () => 0.99): PhoneList {
  return new PhoneList(store.db, { mode, kept: () => kept, readTs: (cid) => reads.get(cid) ?? 0, random });
}
const episodes = () => store.db.query('SELECT * FROM phone_episode ORDER BY id').all() as Record<string, any>[];
/** A push that went to the phone about a chat, and the phone's word on it, as the activity log hears it. */
function word(phone: PhoneList, cid: string, event: 'tapped' | 'dismissed', device: string, at: number) {
  const nid = activity.notification({ kind: 'message', conversationId: cid }, at - MIN)!;
  activity.noted = (w) => phone.noted(w);
  activity.events([{ id: nid, event, device, at }], at);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-phonelist-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw);
  activity = new ActivityStore(store);
  for (const c of ['device', 'clears']) if (!(store.db.query('PRAGMA table_info(push_subscription)').all() as { name: string }[]).some((x) => x.name === c)) store.db.exec(`ALTER TABLE push_subscription ADD COLUMN ${c} TEXT`);
  const sub = store.db.query('INSERT INTO push_subscription (id, endpoint, p256dh, auth, label, created_at, device, clears) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  sub.run('reg-phone', 'https://push.example/phone', 'k', 'a', 'Android app', T0, 'dev-phone', 1);
  sub.run('reg-desk', 'https://push.example/desk', 'k', 'a', 'Firefox on Linux', T0, 'dev-desk', 0);
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  store.db.exec('DELETE FROM phone_episode; DELETE FROM phone_snooze; DELETE FROM notification; DELETE FROM notification_event;');
  kept.clear();
  reads.clear();
});

describe('the gate', () => {
  test('the start alone: the network would notify, or it is to you; learning alone is not enough', () => {
    expect(listByPrior({ notify: true, shape: 'channel' })).toBe(true);
    expect(listByPrior({ notify: false, mention: true, shape: 'channel' })).toBe(true);
    expect(listByPrior({ notify: false, reply: true, shape: 'channel' })).toBe(true);
    expect(listByPrior({ notify: false, shape: 'direct' })).toBe(true);
    expect(listByPrior({ notify: false, shape: 'channel' })).toBe(false);
    expect(listByPrior({ notify: false, shape: 'group' })).toBe(false);
    // Facts from before `notify` was kept: their base says it.
    expect(listByPrior({ base: 'quiet', shape: 'channel' })).toBe(true);
    expect(listByPrior({ base: 'digest', shape: 'channel' })).toBe(false);
    expect(listByPrior(null)).toBe(true);
    expect(phoneListMode(undefined)).toBe('on');
    expect(phoneListMode('shadow')).toBe('shadow');
    expect(phoneListMode('off')).toBe('off');
    expect(phoneListMode('nonsense')).toBe('on');
  });

  test('what the start puts on the list goes; what only learning put there is held, one coin a chat a day; a keep mark lets it through', () => {
    const p = phoneList('on');
    expect(p.list('c-notify', true, T0, T0)).toEqual({ send: true, arm: 'prior', held: null });
    // No history yet: the day's whole budget over at least one chat, so the first held chat is a trial.
    expect(p.list('c-learned', false, T0, T0)).toEqual({ send: true, arm: 'trial', held: null, propensity: 1 });
    store.db.exec('DELETE FROM phone_episode');
    // Ten chats held a day lately: a chance of 3 in 10, and this coin loses.
    seedHistory(10);
    const q = phoneList('on', () => 0.99);
    const h2 = q.list('c-learned', false, T0, T0);
    expect(h2).toMatchObject({ send: false, arm: 'gated', held: 'gated', propensity: TRIALS_PER_DAY / 10 });
    // The rest of the day: held, no second coin.
    expect(q.list('c-learned', false, T0 + MIN, T0 + 20 * MIN)).toMatchObject({ send: false, held: 'gated' });
    expect(episodes().filter((e) => e.conversation_id === 'c-learned')).toHaveLength(1);
    kept.add('c-kept');
    expect(q.list('c-kept', false, T0, T0 + 30 * MIN)).toEqual({ send: true, arm: 'keep', held: null });
    // An open row is brought up to date, the episode counting its pushes.
    q.list('c-kept', false, T0, T0 + 50 * MIN);
    expect(episodes().find((e) => e.conversation_id === 'c-kept')).toMatchObject({ posts: 2, sent: 1, arm: 'keep' });
  });

  test('trials: a won coin sends the row; three a day at most, the chance logged exactly and 0 once they are spent', () => {
    seedHistory(4);
    const draws = [0.1, 0.9, 0.2, 0.3, 0.05];
    const p = phoneList('on', () => draws.shift()!);
    const chance = TRIALS_PER_DAY / 4;
    const verdicts = ['a', 'b', 'c', 'd', 'e'].map((c, i) => p.list(`c-${c}`, false, T0, T0 + i * MIN));
    expect(verdicts.map((v) => [v.send, v.arm, v.propensity])).toEqual([
      [true, 'trial', chance],
      [false, 'gated', chance],
      [true, 'trial', chance],
      [true, 'trial', chance],
      [false, 'gated', 0],
    ]);
    const today = episodes().filter((e) => e.day === dayOf(T0) && ['trial', 'gated'].includes(e.arm));
    expect(today.map((e) => [e.arm, e.propensity, e.sent])).toEqual([
      ['trial', chance, 1],
      ['gated', chance, 0],
      ['trial', chance, 1],
      ['trial', chance, 1],
      ['gated', 0, 0],
    ]);
    // Tomorrow the budget is whole again.
    expect(p.propensity(dayOf(T0 + DAY), T0 + DAY)).toBeGreaterThan(0);
  });

  test('eight rows at most: a ninth chat waits, an open one is still brought up to date', () => {
    const p = phoneList('on');
    for (let i = 0; i < LIST_CAP; i++) expect(p.list(`c-${i}`, true, T0, T0 + i).send).toBe(true);
    expect(p.openRows()).toBe(LIST_CAP);
    expect(p.list('c-ninth', true, T0, T0 + MIN)).toEqual({ send: false, arm: 'prior', held: 'cap' });
    expect(p.list('c-3', true, T0, T0 + MIN).send).toBe(true);
    // One read: room again.
    p.read('c-0', T0 + 2 * MIN);
    expect(p.list('c-ninth', true, T0, T0 + 3 * MIN).send).toBe(true);
  });
});

describe('swipes, clear-alls and expiry', () => {
  test('a swipe on the phone ends the episode and holds the chat six hours, or until something above the list comes', () => {
    const p = phoneList('on');
    p.list('c-a', true, T0, T0);
    word(p, 'c-a', 'dismissed', 'reg-phone', T0 + 10 * MIN);
    expect(episodes()[0]).toMatchObject({ outcome: 'dismissed', outcome_at: T0 + 10 * MIN });
    expect(p.list('c-a', true, T0, T0 + HOUR)).toEqual({ send: false, arm: 'prior', held: 'snoozed' });
    expect(p.list('c-a', true, T0, T0 + 10 * MIN + SNOOZE_MS).send).toBe(true);
    // Swiped again; then a Conversation message there lifts it at once.
    word(p, 'c-a', 'dismissed', 'reg-phone', T0 + 7 * HOUR);
    expect(p.list('c-a', true, T0, T0 + 7 * HOUR + MIN).held).toBe('snoozed');
    p.higher('c-a', T0 + 7 * HOUR + 2 * MIN);
    expect(p.list('c-a', true, T0, T0 + 7 * HOUR + 3 * MIN).send).toBe(true);
  });

  test("a computer's swipe or tap says nothing about the phone's list; the phone app's page tapping does", () => {
    const p = phoneList('on');
    p.list('c-a', true, T0, T0);
    word(p, 'c-a', 'dismissed', 'reg-desk', T0 + MIN);
    word(p, 'c-a', 'tapped', 'dev-desk', T0 + 2 * MIN);
    expect(episodes()[0].ended_at).toBeNull();
    // The tap is recorded by the page under its own device id, which the registration names.
    word(p, 'c-a', 'tapped', 'dev-phone', T0 + 3 * MIN);
    expect(episodes()[0]).toMatchObject({ outcome: 'tapped', outcome_at: T0 + 3 * MIN });
    expect(p.list('c-a', true, T0, T0 + 4 * MIN).send).toBe(true);
  });

  test('a clear-all ends every episode as cleared, never as a swipe of one chat, and learning takes no "no" from it', () => {
    const p = phoneList('on');
    for (const c of ['c-a', 'c-b', 'c-c']) p.list(c, true, T0, T0);
    word(p, 'c-a', 'dismissed', 'reg-phone', T0 + HOUR);
    word(p, 'c-b', 'dismissed', 'reg-phone', T0 + HOUR + 300);
    word(p, 'c-c', 'dismissed', 'reg-phone', T0 + HOUR + 900);
    expect(episodes().map((e) => e.outcome)).toEqual(['cleared', 'cleared', 'cleared']);
    // A single swipe well apart from it stays one.
    p.list('c-d', true, T0, T0 + HOUR);
    word(p, 'c-d', 'dismissed', 'reg-phone', T0 + HOUR + 900 + 2 * BULK_MS);
    expect(episodes().at(-1)!.outcome).toBe('dismissed');
    expect(LABEL_WEIGHTS.dismissed).toBe(0);
  });

  test('twelve hours on, a row leaves the phones; a held episode ends when its chat is read anywhere', () => {
    seedHistory(10);
    const p = phoneList('on');
    p.list('c-sent', true, T0, T0);
    p.list('c-held', false, T0 + 5, T0);
    expect(p.sweep(T0 + HOUR)).toEqual([]);
    reads.set('c-held', T0 + 5);
    expect(p.sweep(T0 + 2 * HOUR)).toEqual([]);
    expect(episodes().find((e) => e.conversation_id === 'c-held')).toMatchObject({ outcome: 'read' });
    expect(p.sweep(T0 + EXPIRE_MS)).toEqual(['c-sent']);
    expect(episodes().find((e) => e.conversation_id === 'c-sent')).toMatchObject({ outcome: 'expired' });
    expect(p.openRows()).toBe(0);
  });

  test('what it knows outlasts a restart: the open rows, the snoozes and the day’s coins', () => {
    seedHistory(10);
    const p = phoneList('on');
    expect(p.list('c-held', false, T0, T0).held).toBe('gated');
    for (let i = 0; i < LIST_CAP; i++) p.list(`c-${i}`, true, T0, T0);
    word(p, 'c-0', 'dismissed', 'reg-phone', T0 + MIN);
    const again = phoneList('on', () => 0);
    expect(again.openRows()).toBe(LIST_CAP - 1);
    expect(again.list('c-0', true, T0, T0 + 2 * MIN).held).toBe('snoozed');
    // The held chat tossed its coin today: no second one after the restart.
    expect(again.list('c-held', false, T0, T0 + 3 * MIN).held).toBe('gated');
  });
});

describe('the modes', () => {
  test('shadow sends every row and logs what the gate would have done; off keeps nothing', () => {
    seedHistory(10);
    const s = phoneList('shadow');
    expect(s.list('c-held', false, T0, T0)).toMatchObject({ send: true, arm: 'gated', held: 'gated' });
    expect(s.list('c-prior', true, T0, T0)).toMatchObject({ send: true, arm: 'prior', held: null });
    expect(episodes().filter((e) => e.mode === 'shadow').map((e) => [e.mode, e.arm, e.sent])).toEqual([
      ['shadow', 'gated', 0],
      ['shadow', 'prior', 1],
    ]);
    // Rows go out as before, so nothing is cleared at twelve hours.
    expect(s.sweep(T0 + EXPIRE_MS)).toEqual([]);
    store.db.exec('DELETE FROM phone_episode');
    const off = phoneList('off');
    expect(off.list('c-held', false, T0, T0)).toEqual({ send: true, arm: null, held: null });
    off.higher('c-held');
    off.noted({ event: 'dismissed', conversationId: 'c-held', device: 'reg-phone', at: T0 });
    expect(off.sweep(T0 + EXPIRE_MS)).toEqual([]);
    expect(episodes()).toHaveLength(0);
  });
});

/** Earlier days' coins: `n` chats held on each of the three days before T0. */
function seedHistory(n: number, base = T0) {
  const ins = store.db.query(`INSERT INTO phone_episode (conversation_id, day, mode, arm, propensity, sent, first_ts, started_at, last_at, posts, ended_at, outcome) VALUES (?, ?, 'on', 'gated', 0.5, 0, ?, ?, ?, 0, ?, 'expired')`);
  for (let d = 1; d <= 3; d++) for (let i = 0; i < n; i++) ins.run(`old-${i}`, dayOf(base - d * DAY), base - d * DAY, base - d * DAY, base - d * DAY, base - d * DAY + EXPIRE_MS);
}

describe('alerts and Conversations go out as before', () => {
  type Sent = { messageId: string; payload: unknown };
  const script: [string, string, Tier, boolean][] = [
    ['m1', 'c-chan', 'digest', false],
    ['m2', 'c-dm', 'quiet', true],
    ['m3', 'c-group', 'push', true],
    ['m4', 'c-news', 'digest', true],
    ['m5', 'c-chan', 'quiet', true],
    ['m6', 'c-other', 'digest', false],
    ['m7', 'c-group', 'digest', false],
    ['m8', 'c-dm', 'push', true],
    ['m9', 'c-other', 'quiet', true],
  ];

  async function run(mode: PhoneListMode): Promise<{ pushes: Sent[]; pages: Sent[] }> {
    store.db.exec('DELETE FROM phone_episode; DELETE FROM phone_snooze;');
    const pushes: Sent[] = [];
    const pages: Sent[] = [];
    let current = '';
    const phone = phoneList(mode, () => 0.99);
    // Seeded so the coins lose: held chats stay held.
    seedHistory(30, Date.now());
    const notifier = new Notifier({
      store,
      phone,
      activity: { notification: (n) => `n-${n.messageId}`, sent: () => {} },
      devices: { addressed: () => false, quietOn: () => [] },
      push: {
        desktops: () => ['reg-desk'],
        notify: async (title, body, conversationId, extra, skip, level) => {
          pushes.push({ messageId: current, payload: { title, body, conversationId, extra, skip, level } });
          return { devices: 1, accepted: 1 };
        },
      },
      delivery: {
        listDue: () => true,
        plan: (cid, mid, tier) => ({ alert: tier === 'push', tier, count: 1, conv: { title: cid, shape: 'channel' }, sender: { name: 'Ann', key: 'ann' }, lines: [{ author: 'Ann', key: 'ann', body: mid, ts: 1 }], icons: {} }),
      },
      server: { notify: (ev) => void pages.push({ messageId: current, payload: ev }), warm: async () => {} },
    });
    for (const [mid, cid, tier, prior] of script) {
      current = mid;
      notifier.message(`title ${mid}`, `body ${mid}`, cid, mid, ['why'], {}, 'message', tier, 0.7, prior);
      await notifier.last;
    }
    return { pushes, pages };
  }

  test('byte for byte with the gate on, off or in shadow; only list rows the gate holds stay off the phones', async () => {
    const off = await run('off');
    const on = await run('on');
    const shadow = await run('shadow');
    const above = new Set(script.filter(([, , t]) => t !== 'digest').map(([m]) => m));
    const only = (xs: Sent[]) => JSON.stringify(xs.filter((x) => above.has(x.messageId)));
    expect(only(on.pushes)).toBe(only(off.pushes));
    expect(only(on.pages)).toBe(only(off.pages));
    expect(only(shadow.pushes)).toBe(only(off.pushes));
    expect(off.pushes.map((p) => p.messageId)).toEqual(script.map(([m]) => m));
    // On: the held chats' list rows go nowhere, as within the list's ten minutes; the start's own list row goes.
    expect(on.pushes.map((p) => p.messageId)).toEqual(['m2', 'm3', 'm4', 'm5', 'm8', 'm9']);
    expect(on.pages.map((p) => p.messageId)).toEqual(['m2', 'm3', 'm4', 'm5', 'm8', 'm9']);
    expect(JSON.stringify(shadow.pushes)).toBe(JSON.stringify(off.pushes));
  });
});
