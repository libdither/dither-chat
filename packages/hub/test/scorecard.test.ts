import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCORE_CHARTS, SCORE_METRICS, scoreTrend } from '@dither-chat/protocol/scorecard';
import { auc, averagePrecision, dayBounds, dayOf, MATURE_AFTER, OpenIndex, Scorecard, scoreAll, SCORE_VERSION, seedDemoScores, viewOf } from '../src/scorecard.ts';
import { whole } from '../src/slices.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { HubServer } from '../src/server.ts';
import { Triage } from '../src/triage.ts';
import type * as P from '@dither-chat/protocol/scorecard';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('the pieces', () => {
  test('AUC: the chance a positive outscores a negative, ties half', () => {
    expect(auc([0.9, 0.8], [0.1, 0.2])).toBe(1);
    expect(auc([0.1], [0.9])).toBe(0);
    expect(auc([0.5], [0.5])).toBe(0.5);
    expect(auc([0.9, 0.3], [0.5, 0.1])).toBe(0.75);
    expect(auc([], [0.1])).toBeNull();
    expect(auc([0.1], [])).toBeNull();
  });

  test('average precision: how near the top the positives are', () => {
    expect(averagePrecision([0.9, 0.8], [0.1])).toBe(1);
    // Ranks 1 and 3: (1/1 + 2/3) / 2.
    expect(averagePrecision([0.9, 0.5], [0.7, 0.1])).toBeCloseTo(5 / 6, 9);
    // A tie of one positive and one negative at the top: precision 1/2 there.
    expect(averagePrecision([0.5], [0.5])).toBe(0.5);
    expect(averagePrecision([], [0.1])).toBeNull();
  });

  test('opens between two times', () => {
    const o = new OpenIndex();
    o.add('a', 300);
    o.add('a', 100);
    o.seal();
    expect(o.between('a', 50, 99)).toBe(false);
    expect(o.between('a', 50, 100)).toBe(true);
    expect(o.between('a', 101, 299)).toBe(false);
    expect(o.between('a', 200, 400)).toBe(true);
    expect(o.between('b', 0, 1000)).toBe(false);
  });

  test('a day is local midnight to local midnight', () => {
    const [from, to] = dayBounds('2026-03-04');
    expect(dayOf(from)).toBe('2026-03-04');
    expect(dayOf(to - 1)).toBe('2026-03-04');
    expect(dayOf(to)).toBe('2026-03-05');
  });

  test('every chart keeps to one kind, so it has one y-axis; every key is once', () => {
    for (const c of SCORE_CHARTS) expect(new Set(c.metrics.map((m) => m.kind)).size).toBe(1);
    expect(new Set(SCORE_METRICS.map((m) => m.key)).size).toBe(SCORE_METRICS.length);
  });
});

describe('scoring a day', () => {
  let dir: string;
  let store: Store;
  let sg: AccountRow;
  // A day three days back: matured. The day before yesterday's end plus a day and an hour may not have passed.
  const now = Date.now();
  const day = dayOf(now - 3 * DAY);
  const [from] = dayBounds(day);
  const at = (h: number) => from + h * HOUR;
  const conv = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', nativeId)!.id;
  const msg = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
  let n = 0;
  /** A message from someone else, and triage's decision on it with what it logged. */
  const say = (c: string, ts: number, decision: string, o: { live?: number; start?: number; cand?: number; alert?: number; startAlert?: number; judged?: boolean; conv?: boolean; mark?: number; author?: string } = {}) => {
    const id = `m${++n}`;
    store.ingest(sg, { t: 'message', message: { nativeId: id, conversation: c, author: o.author ?? 'ann', ts, body: 'invented' }, live: true });
    const facts = { network: 'signal', shape: 'group', conversation: conv(c), spaces: [], author: null, bot: false, urgent: false, media: false, base: 'drop', conv: o.conv, judge: o.judged ? 0.1 : undefined, start: { alert: o.startAlert ?? 0.1, important: o.start ?? 0.5 } };
    const probs = { alert: o.alert ?? 0.1, important: o.live ?? 0.5 };
    const shadow = { alert: o.alert ?? 0.1, important: o.cand ?? o.live ?? 0.5 };
    store.db
      .query(`INSERT OR REPLACE INTO triage (message_id, decision, reasons, decided_by, created_at, facts, probs, shadow, alert_mark, marked_at) VALUES (?, ?, '[]', 'model', ?, ?, ?, ?, ?, ?)`)
      .run(msg(id), decision, ts, JSON.stringify(facts), JSON.stringify(probs), JSON.stringify(shadow), o.mark ?? null, o.mark === undefined ? null : ts + HOUR);
    return msg(id);
  };
  const notify = (c: string, messageId: string, ts: number, accepted = 1) =>
    store.db.query(`INSERT INTO notification (id, kind, message_id, conversation_id, sent_at, devices, accepted) VALUES (?, 'message', ?, ?, ?, 1, ?)`).run(`n${++n}`, messageId, conv(c), ts, accepted);
  const visit = (c: string | null, ts: number, active: number, source = 'rail', rank: number | null = null) =>
    store.db
      .query(`INSERT INTO visit (id, device, view, conversation_id, start_at, end_at, active, source, rank, updated_at) VALUES (?, 'd1', 'conversation', ?, ?, ?, ?, ?, ?, ?)`)
      .run(`v${++n}`, c ? conv(c) : null, ts, ts + active * 1000, active, source, rank, ts);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-scorecard-'));
    store = new Store(join(dir, 'hub.sqlite'), () => null);
    sg = store.createAccount({ network: 'signal', label: 'phone', color: '#000', adapter: 'signal' });
    store.ingest(sg, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    sg = store.accounts().find((a) => a.id === sg.id)!;
    store.ingest(sg, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    for (const g of ['alerts', 'talk', 'list', 'x', 'y', 'z', 'w', 'q1', 'q2']) store.ingest(sg, { t: 'conversation', conversation: { nativeId: g, shape: 'group', name: g, participants: ['ann'] } });

    // Alerts: two reached the phone, one opened within the hour; one never reached a phone (not counted). One was
    // marked wrong.
    const a1 = say('alerts', at(9), 'push', { mark: 0, conv: true });
    const a2 = say('alerts', at(15), 'push', { conv: true });
    const a3 = say('alerts', at(16), 'push', { conv: true });
    notify('alerts', a1, at(9));
    notify('alerts', a2, at(15));
    notify('alerts', a3, at(16), 0);
    visit('alerts', at(10), 30);
    // A Conversation notification whose chat you glanced at for 3 s: not followed.
    const t1 = say('talk', at(11), 'quiet', { conv: true, mark: 1 });
    notify('talk', t1, at(11));
    visit('talk', at(11.5), 3);
    // A list notification opened four hours later: not within three.
    const l1 = say('list', at(12), 'digest', { live: 0.7 });
    notify('list', l1, at(12));
    visit('list', at(16), 20);

    // Importance, outside the Conversation tier: x opened the next morning (within a day), y and z not. What was
    // learned ranks x first; the start ranks it last.
    say('x', at(20), 'digest', { live: 0.9, start: 0.2, cand: 0.4 });
    say('y', at(13), 'drop', { live: 0.3, start: 0.6, cand: 0.5 });
    say('z', at(14), 'drop', { live: 0.2, start: 0.5, cand: 0.3 });
    visit('x', at(30), 12);

    // The alert chance, on Conversation messages the local model read: you answered q1 within the hour, not q2.
    say('q1', at(8), 'quiet', { conv: true, judged: true, alert: 0.8, startAlert: 0.3 });
    say('q2', at(8.5), 'quiet', { conv: true, judged: true, alert: 0.2, startAlert: 0.4 });
    store.ingest(sg, { t: 'message', message: { nativeId: 'mine', conversation: 'q1', author: 'me', ts: at(8.75), body: 'invented' }, live: true });

    // Unprompted: w opened with no notification about it; a message there was on the list two hours before.
    say('w', at(17), 'digest', { live: 0.65 });
    visit('w', at(19), 40);

    // Inbox rows opened: the top row, the tenth, the 26th.
    visit('y', at(21), 2, 'inbox', 0);
    visit('z', at(21.5), 2, 'inbox', 9);
    visit('z', at(22), 2, 'inbox', 25);

    // For you: four items served and shown that day (two from exploration slots), one of each kind opened; a fifth
    // served and never shown; a sixth shown the next day.
    const item = store.db.query(`INSERT INTO foryou_item (id, epoch, message_id, conversation_id, position, slot, propensity, created_at) VALUES (?, 'ep', ?, 'cnv_x', ?, ?, ?, ?)`);
    const ev = store.db.query(`INSERT INTO foryou_event (item_id, device, kind, at, ms) VALUES (?, 'dev-a', ?, ?, ?)`);
    ['rank', 'rank', 'explore', 'explore', 'rank', 'rank'].forEach((slot, i) => item.run(`ep.${i}`, `msg_f${i}`, i, slot, slot === 'rank' ? 1 : 0.2, at(9)));
    for (const i of [0, 1, 2, 3]) ev.run(`ep.${i}`, 'shown', at(9) + i * MIN, 1500);
    ev.run('ep.5', 'shown', at(30), 1500);
    for (const i of [0, 2]) ev.run(`ep.${i}`, 'clicked', at(9.5), null);
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const score = () => {
    const rows = whole(scoreAll(store.db, now)).filter((r) => r.day === day);
    return Object.fromEntries(rows.map((r) => [r.metric, r]));
  };

  test('notifications that reached a phone, by tier, and whether you opened the chat within 3 hours', () => {
    const s = score();
    expect(s['alert.opened']).toMatchObject({ value: 0.5, n: 2 });
    expect(s['conversation.opened']).toMatchObject({ value: 0, n: 1 });
    expect(s['list.opened']).toMatchObject({ value: 0, n: 1 });
  });

  test('importance against what you opened: as learned, as the start, as the candidate', () => {
    const s = score();
    // Chats outside the Conversation tier: x, y, z, list and w (both opened). Learned: 0.9 and 0.65 and 0.7 against
    // 0.3 and 0.2.
    expect(s['importance.auc'].n).toBe(5);
    expect(s['importance.auc'].extra).toEqual({ opened: 3 });
    expect(s['importance.auc'].value).toBe(1);
    expect(s['importance.auc_start'].value).toBeLessThan(0.5);
    expect(s['importance.auc_candidate'].value).toBeGreaterThan(0.5);
    expect(s['importance.ap'].value).toBe(1);
    expect(s['importance.ap_start'].value!).toBeLessThan(1);
  });

  test('the alert chance against a quick answer', () => {
    const s = score();
    expect(s['alert.auc']).toMatchObject({ value: 1, n: 2, extra: { answered: 1 } });
    expect(s['alert.auc_start']).toMatchObject({ value: 0, n: 2 });
  });

  test('marks on the day’s decisions', () => {
    const s = score();
    expect(s['marks.alert_wrong']).toMatchObject({ value: 1, n: 3 });
    expect(s['marks.should_alert'].value).toBe(1);
  });

  test('chats opened unprompted, and the share the list held', () => {
    const s = score();
    // w, and x the next morning is the next day's. alerts, talk and list had notifications.
    expect(s['unprompted.list']).toMatchObject({ value: 1, n: 1 });
  });

  test('the inbox: mean 1 ÷ row, the first 8 rows, below row 20', () => {
    const s = score();
    expect(s['inbox.mrr'].n).toBe(3);
    expect(s['inbox.mrr'].value).toBeCloseTo((1 + 1 / 10 + 1 / 26) / 3, 6);
    expect(s['inbox.top8'].value).toBeCloseTo(1 / 3, 6);
    expect(s['inbox.deep'].value).toBeCloseTo(1 / 3, 6);
  });

  test('For you: the share of shown items opened, and of exploration slots alone', () => {
    const s = score();
    expect(s['foryou.clicked']).toMatchObject({ value: 0.5, n: 4 });
    expect(s['foryou.clicked_explore']).toMatchObject({ value: 0.5, n: 2 });
  });

  test('the hub keeps each matured day once, waits for the rest, and scores again when the metrics change', () => {
    const sc = new Scorecard(store.db);
    const scored = whole(sc.steps(now));
    expect(scored).toBeGreaterThan(0);
    const days = store.db.query('SELECT DISTINCT day FROM model_score ORDER BY day').all() as { day: string }[];
    expect(days.map((d) => d.day)).toContain(day);
    // Nothing past maturity: the newest scored day ended at least MATURE_AFTER ago.
    expect(dayBounds(days.at(-1)!.day)[1] + MATURE_AFTER).toBeLessThanOrEqual(now);
    expect(days.map((d) => d.day)).not.toContain(dayOf(now));
    // Again: nothing new.
    expect(whole(sc.steps(now))).toBe(0);
    // A day later, one more day has matured.
    expect(whole(sc.steps(now + DAY))).toBe(1);
    // Another version of the metrics: everything again.
    store.db.query(`UPDATE meta SET value = '0' WHERE key = 'model_score_version'`).run();
    expect(whole(sc.steps(now))).toBe(scored);
    expect((store.db.query(`SELECT value FROM meta WHERE key = 'model_score_version'`).get() as { value: string }).value).toBe(String(SCORE_VERSION));

    const v = sc.view(60, now);
    const i = v.days.indexOf(day);
    expect(v.metrics['alert.opened'].v[i]).toBe(0.5);
    expect(v.metrics['alert.opened'].n[i]).toBe(2);
    expect(v.metrics['inbox.mrr'].v.length).toBe(v.days.length);
    // Yesterday ended, but its outcomes are not all in.
    expect(v.pending === null || v.pending === dayOf(now - DAY)).toBe(true);
  });

  test('the demo world gets three invented weeks, only into an empty table', () => {
    const d = new Store(join(dir, 'demo.sqlite'), () => null);
    seedDemoScores(d.db, now);
    const v = new Scorecard(d.db).view(60, now);
    expect(v.days.length).toBe(21);
    const mrr = SCORE_METRICS.find((m) => m.key === 'inbox.mrr')!;
    const t = scoreTrend(v, mrr);
    expect(t.recent.value!).toBeGreaterThan(t.before.value!);
    // Already seeded: left as it is. And the job finds those days scored.
    seedDemoScores(d.db, now);
    expect((d.db.query('SELECT COUNT(*) AS n FROM model_score').get() as { n: number }).n).toBe(21 * SCORE_METRICS.length);
    d.db.close();
  });

  test('the endpoint: the scored days, each metric aligned with them; a hub without a scorecard says so', async () => {
    const sc = new Scorecard(store.db);
    whole(sc.steps(now));
    const hub = new HubServer(store, { authorize: () => null, online: () => false } as any, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's', scorecard: sc });
    const bare = new HubServer(store, { authorize: () => null, online: () => false } as any, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    const port = hub.start().port!;
    const barePort = bare.start().port!;
    try {
      const get = (p: number, q: string) => fetch(`http://127.0.0.1:${p}${q}`, { headers: { origin: `http://127.0.0.1:${p}` } });
      const r = await get(port, '/api/model/scores?days=30');
      expect(r.status).toBe(200);
      const v = (await r.json()) as P.ModelScoresView;
      expect(v.days).toContain(day);
      for (const m of SCORE_METRICS) expect(v.metrics[m.key].v.length).toBe(v.days.length);
      expect(v.metrics['inbox.mrr'].n[v.days.indexOf(day)]).toBe(3);
      // A nonsense count of days is the default.
      expect((await get(port, '/api/model/scores?days=abc')).status).toBe(200);
      expect((await get(barePort, '/api/model/scores')).status).toBe(404);
    } finally {
      hub.stop();
      bare.stop();
    }
  });

  test('a view with no rows is empty, and each metric lines up with the days', () => {
    const v = viewOf([], null);
    expect(v.days).toEqual([]);
    for (const m of SCORE_METRICS) expect(v.metrics[m.key]).toEqual({ v: [], n: [] });
  });
});
