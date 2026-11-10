/**
 * The activity log (docs/activity.md): visits, notification outcomes and how they link, the derived features,
 * idempotent batches, pruning, the exports, and triage's flag.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { ActivityStore, bursts, cleanVisit, describeActivity, OPEN_WINDOW, placeFeatures, pushOutcome, weakLabel, type FeatureInput } from '../src/activity.ts';
import { HubServer } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 9);

// ------------------------------------------------------------------ derivation

describe('what a push led to', () => {
  const visit = (id: string, start: number, mins: number, active = 30) => ({ id, start, end: start + mins * MIN, active });

  test('a tap opens it; time to open, dwell from the visit it led to, and a reply soon after', () => {
    const p = { id: 'n1', sentAt: T0, tappedAt: T0 + 2 * MIN, visitId: 'v1' };
    const o = pushOutcome(p, { visits: [visit('v1', T0 + 2 * MIN + 500, 3, 45)], own: [T0 + 5 * MIN] })!;
    expect(o).toEqual({ opened: true, tapped: true, timeToOpen: 2 * MIN, dwell: 45, replied: true });
  });

  test('opened by another route within the window counts as opened, not tapped', () => {
    const p = { id: 'n1', sentAt: T0, tappedAt: null, visitId: null };
    expect(pushOutcome(p, { visits: [visit('v', T0 + 20 * MIN, 1)], own: [] })).toMatchObject({ opened: true, tapped: false, timeToOpen: 20 * MIN, replied: false });
    expect(pushOutcome(p, { visits: [visit('v', T0 + OPEN_WINDOW + MIN, 1)], own: [] })).toMatchObject({ opened: false });
  });

  test('a push while you were already there is not an example', () => {
    const p = { id: 'n1', sentAt: T0, tappedAt: null, visitId: null };
    expect(pushOutcome(p, { visits: [visit('v', T0 - MIN, 5)], own: [] })).toBeNull();
  });
});

describe('features of a place', () => {
  const base = (): FeatureInput => ({ pushes: [], incoming: [], visits: [], own: [] });

  test('open rate, tap rate, median time to open and dwell, reply after open', () => {
    const x = base();
    // Four pushes: two tapped (1 and 3 minutes), one opened from the inbox after 10 minutes, one ignored.
    x.pushes = [
      { id: 'a', sentAt: T0, tappedAt: T0 + MIN, visitId: 'va' },
      { id: 'b', sentAt: T0 + DAY, tappedAt: T0 + DAY + 3 * MIN, visitId: 'vb' },
      { id: 'c', sentAt: T0 + 2 * DAY, tappedAt: null, visitId: null },
      { id: 'd', sentAt: T0 + 3 * DAY, tappedAt: null, visitId: null },
    ];
    x.visits = [
      { id: 'va', start: T0 + MIN, end: T0 + 2 * MIN, active: 40 },
      { id: 'vb', start: T0 + DAY + 3 * MIN, end: T0 + DAY + 4 * MIN, active: 10 },
      { id: 'vc', start: T0 + 2 * DAY + 10 * MIN, end: T0 + 2 * DAY + 12 * MIN, active: 100 },
    ];
    x.own = [T0 + 90 * SEC];
    const f = placeFeatures('conversation', 'c1', x);
    expect(f).toMatchObject({ pushes: 4, tapped: 2, opened: 3, tapRate: 0.5, openRate: 0.75, medianTimeToOpen: 3 * MIN, medianDwell: 40, repliedAfterOpen: 1, visits: 3, activeSeconds: 150 });
    expect(f.replyAfterOpenRate).toBeCloseTo(1 / 3);
    expect(describeActivity(f)).toBe('Activity: you opened 3 of 4 pushes, usually within 3 min; replied after 33% of them');
  });

  test('nothing to count gives null rates, and no sentence', () => {
    const f = placeFeatures('person', 'p1', base());
    expect(f.openRate).toBeNull();
    expect(f.openedWithoutPushRate).toBeNull();
    expect(describeActivity(f)).toBeNull();
  });

  test('unpushed messages come in bursts; opening one soon anyway is the missed-importance signal', () => {
    const msgs = [0, 5, 10, 120, 125, 300].map((m) => ({ ts: T0 + m * MIN, pushed: false }));
    expect(bursts(msgs)).toEqual([
      { first: T0, last: T0 + 10 * MIN },
      { first: T0 + 120 * MIN, last: T0 + 125 * MIN },
      { first: T0 + 300 * MIN, last: T0 + 300 * MIN },
    ]);
    // A pushed message splits a burst.
    expect(bursts([{ ts: T0, pushed: false }, { ts: T0 + MIN, pushed: true }, { ts: T0 + 2 * MIN, pushed: false }])).toHaveLength(2);

    const x = base();
    x.incoming = msgs;
    x.visits = [
      // Opened 20 minutes after the first burst ended.
      { id: 'v1', start: T0 + 30 * MIN, end: T0 + 31 * MIN, active: 20 },
      // Already there when the third began: not counted either way.
      { id: 'v2', start: T0 + 299 * MIN, end: T0 + 310 * MIN, active: 300 },
    ];
    const f = placeFeatures('conversation', 'c1', x);
    expect(f.unpushedBursts).toBe(2);
    expect(f.openedWithoutPush).toBe(1);
    expect(f.openedWithoutPushRate).toBe(0.5);
  });

  test('an open that followed a push is not "opened without a push"', () => {
    const x = base();
    x.incoming = [{ ts: T0, pushed: false }];
    x.pushes = [{ id: 'n', sentAt: T0 + 5 * MIN, tappedAt: T0 + 6 * MIN, visitId: null }];
    x.visits = [{ id: 'v', start: T0 + 6 * MIN, end: T0 + 7 * MIN, active: 10 }];
    expect(placeFeatures('conversation', 'c', x)).toMatchObject({ unpushedBursts: 0, openedWithoutPush: 0, opened: 1 });
  });
});

describe('labels', () => {
  const o = { seenLive: false, openedAfter: null as number | null, dwell: null as number | null, repliedAfter: null as number | null, observedFor: 2 * DAY, tapped: false };
  test('your feedback wins; then what you did', () => {
    expect(weakLabel('should_not_push', { ...o, openedAfter: MIN, dwell: 100 })).toBe('should_not_push');
    expect(weakLabel(null, { ...o, openedAfter: MIN, dwell: 30 })).toBe('should_push');
    expect(weakLabel(null, { ...o, openedAfter: MIN, dwell: 2, repliedAfter: 3 * MIN })).toBe('should_push');
    expect(weakLabel(null, { ...o, openedAfter: MIN, dwell: 2, tapped: true })).toBe('should_not_push');
    expect(weakLabel(null, o)).toBe('should_not_push');
    expect(weakLabel(null, { ...o, observedFor: HOUR })).toBeNull();
    expect(weakLabel(null, { ...o, seenLive: true })).toBeNull();
  });
});

describe('cleaning what devices send', () => {
  const v = (x: Partial<P.VisitRecord> = {}): Partial<P.VisitRecord> => ({ id: 'v1', device: 'd1', view: 'conversation', start: T0, end: T0 + MIN, active: 50, source: 'inbox', sent: 0, reactions: 0, history: 0, threads: 0, attachments: 0, closed: false, ...x });
  test('drops the unknown, clamps the rest', () => {
    expect(cleanVisit(v({ view: 'bogus' as any }), T0 + HOUR)).toBeNull();
    expect(cleanVisit(v({ id: '' }), T0 + HOUR)).toBeNull();
    expect(cleanVisit(v({ source: 'telepathy' as any }), T0 + HOUR)!.source).toBe('other');
    // Never more in use than the stay lasted (plus a tick).
    expect(cleanVisit(v({ active: 99_999 }), T0 + HOUR)!.active).toBe(120);
    // A clock far in the future is pulled back.
    expect(cleanVisit(v({ start: T0 + 10 * DAY, end: T0 + 10 * DAY }), T0 + HOUR)!.start).toBe(T0 + HOUR + MIN);
    expect(cleanVisit(v({ sent: -3, rank: 2.7 }), T0 + HOUR)).toMatchObject({ sent: 0, rank: 2 });
    // How far down the inbox was on screen: a row number or nothing.
    expect(cleanVisit(v({ depth: 12.4 }), T0 + HOUR)!.depth).toBe(12);
    expect(cleanVisit(v({ depth: -5 }), T0 + HOUR)!.depth).toBe(0);
    expect(cleanVisit(v(), T0 + HOUR)!.depth).toBeNull();
  });
});

// ------------------------------------------------------------------ the store

describe('the log on the hub', () => {
  let dir: string;
  let store: Store;
  let a: ActivityStore;
  let acc: AccountRow;
  let dm: string;
  let group: string;
  let n = 0;
  const NOW = T0 + 10 * DAY;

  const message = (cid: string, author: string, ts: number, decision: P.TriageDecision | null = 'digest') => {
    const nativeId = `m${++n}`;
    const conversation = store.one<{ native_id: string }>('SELECT native_id FROM conversation WHERE id = ?', cid)!.native_id;
    store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts, body: 'secret words', mentions: [] } as any, live: true });
    const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
    if (decision) {
      store.setTriage(id, { decision, score: null, reasons: ['Smart: asks a question', 'Model: about the secret words'], decidedBy: 'rules' });
      store.db.query('UPDATE triage SET created_at = ? WHERE message_id = ?').run(ts, id);
    }
    return id;
  };
  const visit = (x: Partial<P.VisitRecord>): Partial<P.VisitRecord> => ({
    id: `v${++n}`,
    device: 'phone',
    deviceLabel: 'Android app',
    view: 'conversation',
    start: T0,
    end: T0 + MIN,
    active: 30,
    source: 'inbox',
    sent: 0,
    reactions: 0,
    history: 0,
    threads: 0,
    attachments: 0,
    closed: true,
    ...x,
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-activity-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    acc = store.createAccount({ network: 'matrix', label: 'm', color: '#000', adapter: 'matrix' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true, displayName: 'Me' } });
    acc = store.accounts().find((x) => x.id === acc.id)!;
    store.ingest(acc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann', 'me'] } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'g', shape: 'group', name: 'Climbing', participants: ['ann', 'me'] } });
    dm = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'dm'`)!.id;
    group = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'g'`)!.id;
    a = new ActivityStore(store, { featuresInTriage: true });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    a.clear();
    a.setSettings({ enabled: true, retentionDays: 365 });
    store.db.exec('DELETE FROM triage; DELETE FROM message;');
  });

  test('a resent batch changes nothing; a later snapshot of the same visit only grows it', () => {
    const v = visit({ id: 'same', closed: false, active: 20, end: T0 + 30 * SEC, conversationId: group, sent: 1 });
    expect(a.visits([v], NOW)).toBe(1);
    const once = store.db.query('SELECT * FROM visit').all();
    a.visits([v], NOW);
    expect(store.db.query('SELECT * FROM visit').all()).toEqual(once);
    // The stay goes on: more time, a reaction, it ends and names where the user went.
    a.visits([{ ...v, active: 50, end: T0 + 2 * MIN, reactions: 1, next: 'inbox', closed: true, readToId: 'm9', readToTs: T0 + MIN, depth: 14 }], NOW);
    // An older snapshot arriving late takes nothing back.
    a.visits([{ ...v, depth: 6 }], NOW);
    const r = store.db.query('SELECT * FROM visit').get() as any;
    expect(r).toMatchObject({ active: 50, end_at: T0 + 2 * MIN, sent: 1, reactions: 1, next_view: 'inbox', closed: 1, read_to_id: 'm9', read_to_ts: T0 + MIN, source: 'inbox', depth: 14 });
    expect(a.info().visits).toBe(1);
  });

  test('a notification, what devices say about it, and the visit its tap led to', () => {
    const mid = message(dm, 'ann', T0, 'push');
    const nid = a.notification({ kind: 'message', messageId: mid, conversationId: dm }, T0)!;
    a.sent(nid, { devices: 2, accepted: 2 });
    // The phone got it and showed it; the laptop was looking at the app, so it showed nothing.
    expect(
      a.events(
        [
          { id: nid, device: 'sub-phone', event: 'delivered', at: T0 + 1 * SEC },
          { id: nid, device: 'sub-phone', event: 'shown', at: T0 + 1 * SEC },
          { id: nid, device: 'sub-laptop', event: 'suppressed', at: T0 + 2 * SEC },
          { id: 'nope', event: 'shown' },
          { id: nid, event: 'exploded' as any },
        ],
        T0 + 5 * SEC,
      ),
    ).toBe(3);
    // Said twice: counted once.
    expect(a.events([{ id: nid, device: 'sub-phone', event: 'shown', at: T0 + 9 * SEC }], T0 + 10 * SEC)).toBe(0);
    // Tapped 90 s later; the visit names the push.
    a.visits([visit({ id: 'tapvisit', conversationId: dm, source: 'notification', pushId: nid, start: T0 + 90 * SEC, end: T0 + 3 * MIN, active: 80 })], T0 + 4 * MIN);
    const row = store.db.query('SELECT * FROM notification WHERE id = ?').get(nid) as any;
    expect(row).toMatchObject({ devices: 2, accepted: 2, delivered_at: T0 + SEC, shown_at: T0 + SEC, suppressed_at: T0 + 2 * SEC, tapped_at: T0 + 90 * SEC, visit_id: 'tapvisit', dismissed_at: null });
    // The service worker's own word on the tap, a little earlier, wins as the first.
    a.events([{ id: nid, device: 'sub-phone', event: 'tapped', at: T0 + 88 * SEC }], T0 + 5 * MIN);
    expect((store.db.query('SELECT tapped_at FROM notification WHERE id = ?').get(nid) as any).tapped_at).toBe(T0 + 88 * SEC);
    // And a reply from you two minutes after opening.
    message(dm, 'me', T0 + 3 * MIN, null);
    const f = a.features(dm, T0 + HOUR)!;
    expect(f.conversation).toMatchObject({ pushes: 1, tapped: 1, opened: 1, repliedAfterOpen: 1, medianDwell: 80 });
    expect(f.conversation.medianTimeToOpen).toBe(88 * SEC);
    // A DM is also about the person, across their DMs.
    expect(f.person).toMatchObject({ kind: 'person', pushes: 1, opened: 1 });
    expect(a.features(group, T0 + HOUR)!.person).toBeNull();
  });

  test('off: nothing is recorded, and pushes carry no id', () => {
    a.setSettings({ enabled: false });
    expect(a.notification({ kind: 'digest' })).toBeNull();
    expect(a.visits([visit({})], NOW)).toBe(0);
    expect(a.info()).toMatchObject({ visits: 0, notifications: 0, settings: { enabled: false } });
  });

  test('pruning: retention, then the row caps, oldest first', () => {
    // Each sent when it happened: a device's times are only trusted back 30 days.
    for (const [id, d] of [['old', 40], ['mid', 20], ['new', 1]] as const) a.visits([visit({ id, start: NOW - d * DAY, end: NOW - d * DAY + MIN })], NOW - d * DAY + MIN);
    const old = a.notification({ kind: 'digest' }, NOW - 40 * DAY)!;
    a.events([{ id: old, event: 'shown', at: NOW - 40 * DAY }], NOW);
    a.notification({ kind: 'digest' }, NOW - DAY);
    // Shorter retention prunes at once.
    a.setSettings({ retentionDays: 30 }, NOW);
    expect((store.db.query('SELECT id FROM visit ORDER BY start_at').all() as any[]).map((r) => r.id)).toEqual(['mid', 'new']);
    expect(a.info().notifications).toBe(1);
    expect(store.db.query('SELECT COUNT(*) AS n FROM notification_event').get()).toEqual({ n: 0 });
    a.prune(NOW, true, { visits: 1, notifications: 10 });
    expect((store.db.query('SELECT id FROM visit').all() as any[]).map((r) => r.id)).toEqual(['new']);
    // Unknown retention values are refused.
    expect(a.setSettings({ retentionDays: 3 }).retentionDays).toBe(30);
  });

  test('delete everything', () => {
    a.visits([visit({})], NOW);
    a.notification({ kind: 'digest' }, NOW);
    a.clear();
    expect(a.info()).toMatchObject({ visits: 0, notifications: 0, oldest: null });
  });

  test('exports: the raw log, and labelled examples without any message text', () => {
    const pushed = message(dm, 'ann', NOW - 3 * DAY, 'push');
    const nid = a.notification({ kind: 'message', messageId: pushed, conversationId: dm }, NOW - 3 * DAY)!;
    a.events([{ id: nid, device: 'sub', event: 'shown', at: NOW - 3 * DAY + SEC }], NOW);
    a.visits([visit({ id: 'tv', conversationId: dm, source: 'notification', pushId: nid, start: NOW - 3 * DAY + MIN, end: NOW - 3 * DAY + 2 * MIN, active: 45 })], NOW);
    // A digest-only message the user opened 10 minutes later anyway.
    const quiet = message(group, 'ann', NOW - 2 * DAY, 'digest');
    a.visits([visit({ id: 'gv', conversationId: group, source: 'rail', start: NOW - 2 * DAY + 10 * MIN, end: NOW - 2 * DAY + 11 * MIN, active: 25 })], NOW);
    // And one nobody looked at.
    const ignored = message(group, 'ann', NOW - 1.5 * DAY, 'digest');

    const log = [...a.exportLog()].map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({ type: 'activity-log', settings: { enabled: true } });
    expect(log.filter((l) => l.type === 'visit')).toHaveLength(2);
    expect(log.find((l) => l.type === 'notification')).toMatchObject({ id: nid, visitId: 'tv', events: [{ device: 'sub', event: 'shown' }, { device: 'phone', event: 'tapped' }] });

    const lines = [...a.examples(NOW)];
    expect(lines.join('\n')).not.toContain('secret');
    const ex = new Map(lines.map((l) => JSON.parse(l)).map((e) => [e.messageId, e]));
    expect(ex.get(pushed)).toMatchObject({ shape: 'direct', triage: { decision: 'push', reasons: ['Smart: asks a question', 'Model'] }, outcome: { notified: true, shown: true, tapped: true, timeToTap: MIN, dwell: 45 }, label: 'should_push' });
    expect(ex.get(quiet)).toMatchObject({ shape: 'group', members: 2, outcome: { notified: false, openedAfter: 10 * MIN, dwell: 25 }, label: 'should_push' });
    expect(ex.get(ignored)).toMatchObject({ outcome: { notified: false, openedAfter: null }, label: 'should_not_push' });
  });

  test('triage: behind the flag the log adds a reason and is kept with the decision; the decision stays', async () => {
    // A history: three pushes from the group, all opened within a few minutes.
    for (let i = 0; i < 3; i++) {
      const t = Date.now() - (i + 1) * DAY;
      const nid = a.notification({ kind: 'message', conversationId: group }, t)!;
      a.visits([visit({ conversationId: group, source: 'notification', pushId: nid, start: t + 2 * MIN, end: t + 3 * MIN })]);
    }
    const id = message(group, 'ann', Date.now(), null);
    const off = await new Triage(store).decide(id);
    const on = await new Triage(store, undefined, a).decide(id);
    expect(on!.decision).toBe(off!.decision);
    expect(on!.reasons.slice(0, -1)).toEqual(off!.reasons);
    expect(on!.reasons.at(-1)).toBe('Activity: you opened 3 of 3 pushes, usually within 2 min; replied after 0% of them');
    expect(on!.features!.conversation).toMatchObject({ pushes: 3, opened: 3 });
    a.keepInputs(id, on!.features!);
    expect(JSON.parse((store.db.query('SELECT features FROM triage_input WHERE message_id = ?').get(id) as any).features).conversation.pushes).toBe(3);
    // Without the flag, nothing.
    a.featuresInTriage = false;
    expect((await new Triage(store, undefined, a).decide(id))!.features).toBeUndefined();
    a.featuresInTriage = true;
  });
});

describe('the API', () => {
  let dir: string;
  let store: Store;
  let server: HubServer;
  let a: ActivityStore;
  let port = 0;
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const post = (p: string, body: unknown, method = 'POST') => fetch(url(p), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-activity-api-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    a = new ActivityStore(store);
    const sup = { authorize: () => null, online: () => false } as any;
    server = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's', activity: a });
    port = server.start().port!;
  });
  afterAll(() => {
    server.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('visits and outcomes in, a resend changes nothing, the log out as JSON lines, then deleted', async () => {
    const now = Date.now();
    const nid = a.notification({ kind: 'digest' }, now - MIN)!;
    const v = { id: 'v1', device: 'd', view: 'inbox', start: now - 30 * SEC, end: now, active: 25, source: 'notification', pushId: nid, sent: 0, reactions: 0, history: 0, threads: 0, attachments: 0, closed: true };
    expect(await post('/api/activity/visits', { visits: [v, { id: 'bad' }] })).toEqual({ applied: 1, enabled: true });
    await post('/api/activity/visits', { visits: [v] });
    expect(await post('/api/activity/notifications', { events: [{ id: nid, device: 'sub', event: 'shown' }] })).toEqual({ applied: 1, enabled: true });
    const info = (await fetch(url('/api/activity')).then((r) => r.json())) as P.ActivityInfo;
    expect(info).toMatchObject({ visits: 1, notifications: 1, settings: { enabled: true, retentionDays: 365 }, featuresInTriage: false });

    const res = await fetch(url('/api/activity/export'));
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['activity-log', 'visit', 'notification']);
    expect(lines[2]).toMatchObject({ id: nid, visitId: 'v1', tappedAt: now - 30 * SEC });

    expect(await post('/api/activity/settings', { enabled: false, retentionDays: 90 }, 'PUT')).toEqual({ settings: { enabled: false, retentionDays: 90 } });
    expect(await post('/api/activity/visits', { visits: [{ ...v, id: 'v2' }] })).toEqual({ applied: 0, enabled: false });
    expect(await post('/api/activity', {}, 'DELETE')).toMatchObject({ visits: 0, notifications: 0 });
  });
});
