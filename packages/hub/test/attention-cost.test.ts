import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attentionReport, drifting, weekStart } from '../src/attnreport.ts';
import { dayBounds, dayOf, quantile, Scorecard, scoreAll, selfIds } from '../src/scorecard.ts';
import { sounded } from '../src/notify.ts';
import { whole } from '../src/slices.ts';
import { Store, type AccountRow } from '../src/store.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

test('a push sounds when it is an alert the hub did not quiet', () => {
  expect(sounded('push', { tier: 'push', alert: true })).toBe(true);
  expect(sounded('push', { tier: 'push', alert: false })).toBe(false);
  // Quiet hours' summary and a ring carry no `alert`: an alert's row sounds.
  expect(sounded('push', {})).toBe(true);
  expect(sounded('quiet', { tier: 'quiet' })).toBe(false);
  // A Conversation message in a row an alert raised: the row's tier is an alert's, this update is silent.
  expect(sounded('quiet', { tier: 'push', alert: false })).toBe(false);
});

test('quantiles by nearest rank', () => {
  expect(quantile([], 0.5)).toBeNull();
  expect(quantile([2, 10], 0.5)).toBe(2);
  expect(quantile([2, 10], 0.9)).toBe(10);
  expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
});

test('the week starts on Monday, local midnight', () => {
  const t = new Date(2026, 10, 26, 15).getTime(); // a Thursday
  expect(new Date(weekStart(t)).getDay()).toBe(1);
  expect(weekStart(t)).toBe(new Date(2026, 10, 23).getTime());
  expect(weekStart(new Date(2026, 10, 23, 0, 0, 1).getTime())).toBe(new Date(2026, 10, 23).getTime());
});

describe('the cost side of a day, and the weekly report', () => {
  let dir: string;
  let store: Store;
  let sg: AccountRow;
  const now = Date.now();
  const day = dayOf(now - 3 * DAY);
  const [from, to] = dayBounds(day);
  const at = (h: number) => from + h * HOUR;
  const conv = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', nativeId)!.id;
  const msg = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
  let n = 0;
  const say = (c: string, ts: number, author = 'ann', decision: string | null = null, mentions = false) => {
    const id = `m${++n}`;
    store.ingest(sg, { t: 'message', message: { nativeId: id, conversation: c, author, ts, body: 'invented', ...(mentions ? { mentionsSelf: true } : {}) }, live: true });
    if (decision) store.db.query(`INSERT OR REPLACE INTO triage (message_id, decision, reasons, decided_by, created_at) VALUES (?, ?, '[]', 'model', ?)`).run(msg(id), decision, ts);
    return msg(id);
  };
  const notify = (c: string, messageId: string | null, ts: number, o: { alert?: number | null; accepted?: number; kind?: string; dismissed?: number } = {}) =>
    store.db
      .query(`INSERT INTO notification (id, kind, message_id, conversation_id, sent_at, devices, accepted, alert, dismissed_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(`n${++n}`, o.kind ?? 'message', messageId, conv(c), ts, o.accepted ?? 1, o.alert === undefined ? null : o.alert, o.dismissed ?? null);
  const visit = (c: string | null, a: number, b: number, label: string, readTo: number | null = null) =>
    store.db
      .query(`INSERT INTO visit (id, device, device_label, view, conversation_id, start_at, end_at, active, source, read_to_ts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rail', ?, ?)`)
      .run(`v${++n}`, label, label, c ? 'conversation' : 'inbox', c ? conv(c) : null, a, b, Math.max(1, (b - a) / 1000), readTo, b);
  const turn = (c: string, addressed: number, answered: number | null, o: { dismissed?: number; shape?: string } = {}) =>
    store.db.query('INSERT INTO owed_turn (conversation_id, addressed, shape, author_key, answered_at, timed, dismissed) VALUES (?, ?, ?, ?, ?, 1, ?)').run(conv(c), addressed, o.shape ?? 'direct', 'k', answered, o.dismissed ?? 0);
  const COMPUTER = 'Chrome on Linux';
  const PHONE = 'Android app';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-attn-cost-'));
    store = new Store(join(dir, 'hub.sqlite'), () => null);
    sg = store.createAccount({ network: 'signal', label: 'phone', color: '#000', adapter: 'signal' });
    store.ingest(sg, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    sg = store.accounts().find((a) => a.id === sg.id)!;
    for (const who of ['ann', 'bob', 'cat']) store.ingest(sg, { t: 'identity', identity: { nativeId: who, displayName: who, contact: true } });
    store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', name: 'ann', participants: ['ann'] } });
    store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'bobdm', shape: 'direct', name: 'bob', participants: ['bob'] } });
    store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'small', shape: 'group', name: 'small', participants: ['ann', 'cat'] } });
    store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'dm2', shape: 'direct', name: 'cat', participants: ['cat'] } });
    store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'chan', shape: 'channel', name: 'chan', participants: ['ann'] } });

    // Sounds. Kept by the hub: one sounded at 9:12 while a computer was in use (it was kept, so it counts), one did not,
    // one sounded but no push server took it. Played back from before that was kept: an alert at 14:00 sounds, one
    // three minutes later in the same burst does not, one to you in it does; an alert while a computer was in use
    // does not; a ring does.
    const a = say('dm', at(9.2), 'ann', 'push');
    notify('dm', a, at(9.2), { alert: 1 });
    notify('dm', say('dm', at(9.3), 'ann', 'push'), at(9.3), { alert: 0 });
    notify('dm', say('dm', at(9.4), 'ann', 'push'), at(9.4), { alert: 1, accepted: 0 });
    const b = say('small', at(14), 'ann', 'push');
    notify('small', b, at(14), { dismissed: at(16) });
    notify('small', say('small', at(14.05), 'ann', 'push'), at(14.05));
    notify('small', say('small', at(14.06), 'ann', 'push', true), at(14.06));
    notify('chan', say('chan', at(9.25), 'ann', 'push'), at(9.25));
    notify('dm', null, at(20), { kind: 'ring' });

    // Stays: a computer reading the DM from 9:00 to 9:30 past the 9:12 message; a phone glance at noon with nothing new
    // since; the computer reading the small group at 15:00, past the 14:00 message whose notification was swiped at 16.
    visit('dm', at(9), at(9.5), COMPUTER, at(9.2));
    visit(null, at(12), at(12.1), PHONE);
    visit('small', at(15), at(15.2), COMPUTER, at(14.06));

    // Waits for your reply, people only: a DM answered in 2 hours, the small group in 10; a channel and a dismissed turn
    // are left out.
    turn('dm', at(6), at(8));
    turn('small', at(1), at(11), { shape: 'group' });
    turn('chan', at(2), at(3), { shape: 'channel' });
    turn('bobdm', at(3), at(4), { dismissed: 1 });
    // Owed at the day's end: a DM since four days before (long owed); the small group since yesterday (not yet); a
    // channel long ago (not people); and the first DM's turn four days before, which a later turn answered.
    turn('dm2', to - 4 * DAY, null);
    turn('dm', to - 4 * DAY, null);
    turn('small', to - DAY, null, { shape: 'group' });
    turn('chan', to - 5 * DAY, null, { shape: 'channel' });

    // Who you talk with: you wrote in the DM that day and in the small group 20 days before (ann and cat); in the 30
    // days before that to ann, and to bob (below).
    say('dm', at(10), 'me');
    say('small', to - 20 * DAY, 'me');
    say('dm', to - 40 * DAY, 'me');

    // Drifting: you wrote to bob in six of the twelve weeks before the last four, and nobody has written there since.
    const anchor = weekStart(now);
    for (const w of [5, 6, 8, 9, 11, 13]) say('bobdm', anchor - w * WEEK + DAY, 'me');
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const score = () => Object.fromEntries(whole(scoreAll(store.db, now)).filter((r) => r.day === day).map((r) => [r.metric, r]));

  test('sounds a day: kept where kept, played back where not, and per hour at a computer', () => {
    const s = score();
    // 9:12 (kept), 14:00 and 14:04 (to you) played back, the ring. Not 9:18 (kept silent), 9:24 (no server took it),
    // 14:03 (same burst), 9:15 (a computer in use).
    expect(s['attn.sounds']).toMatchObject({ value: 4, extra: { estimated: 3, rings: 1 } });
    // Of the 7 a push server took.
    expect(s['attn.sounds'].n).toBe(7);
    // Computer hours 9 and 15: one sound in them.
    expect(s['attn.sounds_computer_hour']).toMatchObject({ value: 0.5, n: 2 });
  });

  test('stale pushes: sent while read on a computer, and still up after it', () => {
    const s = score();
    // 9:12 and 9:18 went while the computer was reading the DM past them (9:18 not: read to 9:12 only).
    expect(s['attn.stale'].extra).toEqual({ stale: 1 });
    expect(s['attn.stale'].n).toBe(6);
    // The 14:00 one, swiped at 16:00 after the computer read the group at 15:00.
    expect(s['attn.stale_shown']).toMatchObject({ value: 1, n: 1 });
  });

  test('checks with nothing new since the last look', () => {
    const s = score();
    // The noon glance (nothing since 9:30) and the 15:00 stay (the 14:00 alerts were new): one of two found nothing.
    expect(s['attn.checks']).toMatchObject({ value: 1, n: 2 });
  });

  test('how long people waited for your reply', () => {
    const s = score();
    expect(s['people.wait']).toMatchObject({ value: 2, n: 2 });
    expect(s['people.wait_p90']).toMatchObject({ value: 10, n: 2 });
  });

  test('replies owed to people for over 3 days', () => {
    const s = score();
    expect(s['people.owed_3d'].value).toBe(1);
  });

  test('who you talk with: people written to in 30 days, against the 30 before', () => {
    const s = score();
    expect(s['people.breadth']).toMatchObject({ value: 2, extra: { kept: 1 } });
    expect(s['people.breadth_before'].value).toBe(2);
  });

  test('drifting: someone written to most weeks, quiet for four', () => {
    const self = selfIds(store.db);
    const d = drifting(store.db, self, weekStart(now));
    expect(d).toMatchObject({ conversationId: conv('bobdm'), weeks: 6 });
    // Someone who wrote this week is not drifting.
    say('bobdm', now - HOUR, 'bob');
    expect(drifting(store.db, self, weekStart(now))).toBeNull();
  });

  test('the report: the scored days, the week against the one before, who waits on you', () => {
    whole(new Scorecard(store.db).steps(now));
    const r = attentionReport(store.db, { owed: () => [{ id: conv('dm'), owedSince: now - 2 * DAY, needsReply: 0.7 }, { id: conv('chan'), owedSince: now - DAY }, { id: 'mth_x', kind: 'mail', owedSince: now - DAY }], self: () => selfIds(store.db) }, now);
    const i = r.days.indexOf(day);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r.sounds[i]).toBe(4);
    expect(r.sounds.length).toBe(r.days.length);
    expect(r.days.length).toBeLessThanOrEqual(14);
    // The channel and the mail thread are not people waiting.
    expect(r.waiting).toEqual([{ conversationId: conv('dm'), since: now - 2 * DAY, needs: 0.7 }]);
    expect(r.waitingTotal).toBe(1);
    expect(r.week.checks.recent).toBe(1);
    expect(r.week.breadth.recent).not.toBeNull();
    // No budget anywhere in it.
    expect(JSON.stringify(r)).not.toContain('budget');
  });
});
