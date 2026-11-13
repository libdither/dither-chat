/**
 * Notices (notices/, docs/notices.md): triage's table (urgency, the local model's answer, your rules and marks →
 * tier, and chat's own flags left out), ingest on the fake source and a fake clock (a catch-up is quiet, pages, keeps
 * to 30 days and finds what was read there; live notices notify, a slow local model holds up nothing else, a catch-up
 * that came first does not swallow a live one, reads go both ways and a local read stays read; quiet hours count what
 * they hold), marks teaching chat's model, Notifier.notice's push, the routes, and asking dither-accounts for the grant
 * once (RoutedSupervisor on a stand-in client), with a chat account's events left to chat. Nothing here sends a push
 * or reaches the network.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { Delivery } from '../src/delivery.ts';
import { Devices } from '../src/devices.ts';
import { emptyModel, features, train, THRESHOLDS, type Example, type Model } from '../src/learn.ts';
import { Notifier } from '../src/notify.ts';
import { FakeNoticeSource, type FakeNotification } from '../src/notices/fake.ts';
import { groupId, noticeId, Notices, type NoticeDelivery } from '../src/notices/index.ts';
import { decideNotice, factsOf, startOf, type NoticeContext, type NoticeInput } from '../src/notices/triage.ts';
import { NOTICES_REQUEST, noticesAccessOf, noticesToAsk, RoutedSupervisor } from '../src/remote.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { TriageVotes } from '../src/votes.ts';
import { stub } from './fixtures/accounts-client-stub.ts';
import { FakeClock } from './fixtures/clock.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 15, 0);
const GH = 'acc_noticeGithub';

// ------------------------------------------------------------------ triage's table

const input = (o: Partial<NoticeInput> = {}): NoticeInput => ({ group: 'ntg_repo', account: GH, source: 'github', title: 'Something happened', body: null, url: 'https://github.com/o/r/pull/1', reason: 'review_requested', urgency: 'normal', actors: [{ name: 'sam', url: 'https://github.com/sam' }], at: T0, unread: true, ...o });
const ctx = (o: Partial<NoticeContext> = {}): NoticeContext => ({ model: emptyModel(), thresholds: THRESHOLDS, now: T0, ...o });

describe('triage of a notice', () => {
  test('urgency sets where the chances start', () => {
    expect(startOf('high')).toEqual({ alert: 0.7, important: 0.9 });
    expect(startOf('low')).toEqual({ alert: 0.01, important: 0.15 });
    expect(startOf('normal')).toEqual({ alert: 0.02, important: 0.72 });
    // At the bar (0.2) it is even odds; well over it, an alert.
    expect(startOf('normal', 0.2).alert).toBeCloseTo(0.5, 2);
    expect(startOf('normal', 0.6).alert).toBeGreaterThan(0.8);
  });

  const table: [string, Partial<NoticeInput>, Partial<NoticeContext>, P.TriageDecision][] = [
    ['high: an alert', { urgency: 'high' }, {}, 'push'],
    ['normal, read as urgent: an alert', {}, { judge: 0.6 }, 'push'],
    ['normal, not urgent: on the list', {}, { judge: 0.05 }, 'digest'],
    ['normal, the local model too slow: on the list', {}, { unjudged: true }, 'digest'],
    ['low: below the list', { urgency: 'low' }, {}, 'drop'],
    ['low, your level lowered to 10%: on the list', { urgency: 'low' }, { thresholds: { alert: 0.5, important: 0.1 } }, 'digest'],
    ['muted: silent', { urgency: 'high' }, { rule: { level: 'none', source: 'account GitHub' } }, 'silent'],
    ['List only keeps a high one from alerting', { urgency: 'high' }, { rule: { level: 'digest', source: 'this group' } }, 'digest'],
    ['Always alert lifts a low one', { urgency: 'low' }, { rule: { level: 'all', source: 'this group' } }, 'push'],
    ['a keyword lifts a low one', { urgency: 'low' }, { keyword: 'deploy' }, 'push'],
    ['quiet hours hold an alert as a list row', { urgency: 'high' }, { quietHours: { enabled: true, start: '00:00', end: '23:59', timezone: 'UTC' } }, 'digest'],
  ];
  for (const [what, n, c, want] of table) test(what, () => expect(decideNotice(input(n), ctx(c)).decision).toBe(want));

  test('reasons say the deciding one first, then what the source said', () => {
    const d = decideNotice(input({ urgency: 'high', reason: 'security_alert' }), ctx());
    expect(d.reasons).toEqual(['GitHub says it is urgent', 'GitHub says: security alert (high)']);
    expect(decideNotice(input(), ctx({ judge: 0.6 })).reasons[0]).toBe("Reads as urgent: the local model's answer is 0.6 against a bar of 0.2");
    expect(decideNotice(input({ urgency: 'low' }), ctx()).reasons[0]).toBe('Below the list: importance 15%, under your level of 60%');
    expect(decideNotice(input({ urgency: 'high' }), ctx({ quietHours: { enabled: true, start: '00:00', end: '23:59', timezone: 'UTC' } })).reasons[0]).toBe('Held by quiet hours until 23:59');
  });

  test('what came by a catch-up, was read or came late is rated but notifies nobody', () => {
    expect(decideNotice(input({ urgency: 'high' }), ctx({ catchUp: true })).hold).toBe('Came by a catch-up: no notification');
    expect(decideNotice(input({ urgency: 'high', unread: false }), ctx()).hold).toBe('Already read: no notification');
    expect(decideNotice(input({ urgency: 'high', at: T0 - 2 * 60 * MIN }), ctx()).hold).toBe('Came in late: no notification');
    expect(decideNotice(input({ urgency: 'high' }), ctx()).hold).toBeNull();
  });

  test('the facts are chat’s, with their start kept', () => {
    const f = factsOf(input({ reason: 'mention' }));
    expect(f).toMatchObject({ network: 'notice:github', shape: 'notice', conversation: 'ntg_repo', spaces: [GH], author: 'https://github.com/sam', mention: true, link: true, urgent: false, start: { alert: 0.02, important: 0.72 } });
    const g = factsOf(input({ reason: 'subscribed', urgency: 'high' }));
    expect(g.urgent).toBe(true);
    // Chat's own flags are left out, not false.
    for (const k of ['mention', 'reply', 'question', 'active', 'everyone', 'conv'] as const) expect(k in g).toBe(false);
  });

  test('what chat learned about its own flags does not move a notice', () => {
    const neg = Object.fromEntries(['!mention', '!reply', '!question', '!active', '!everyone', '!known', 'everyone'].map((k) => [k, -3]));
    const model: Model = { w: { alert: { ...neg }, important: { ...neg } } };
    const n = input({ reason: 'subscribed' });
    expect(features(factsOf(n)).map(([k]) => k).filter((k) => k in neg)).toEqual([]);
    const plain = decideNotice(n, ctx({ judge: 0.05 }));
    const learned = decideNotice(n, ctx({ judge: 0.05, model }));
    expect(plain.decision).toBe('digest');
    expect(learned.decision).toBe('digest');
    expect(learned.importance).toBe(plain.importance);
    expect(learned.alert).toBe(plain.alert);
  });

  test('marks move it: "Alert was wrong" on a repository’s high ones, "Less like this" on another’s normal ones', () => {
    const ex = (n: NoticeInput, y: Example['y']): Example => ({ facts: factsOf(n), words: [], y, weight: 1, vote: true, at: T0 });
    const wrong = [1, 2, 3].map(() => ex(input({ urgency: 'high' }), { alert: 0 }));
    const less = [1, 2, 3].map(() => ex(input({ group: 'ntg_noisy' }), { important: 0 }));
    const model = train([...wrong, ...less]);
    const high = decideNotice(input({ urgency: 'high' }), ctx({ model }));
    expect(high.decision).toBe('digest');
    expect(high.decidedBy).toBe('learned');
    expect(high.reasons[0]).toBe('List, learned from your marks (was Alert)');
    expect(decideNotice(input({ group: 'ntg_noisy' }), ctx({ model, judge: 0.05 })).decision).toBe('drop');
    // Another repository, from someone else, is not moved that far by one repository's marks.
    expect(decideNotice(input({ urgency: 'high', group: 'ntg_other', actors: [] }), ctx({ model })).decision).toBe('push');
  });
});

// ------------------------------------------------------------------ on the fake source

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const note = (o: Partial<FakeNotification> & Pick<FakeNotification, 'id'>): FakeNotification => ({ source: 'github', title: `Notice ${o.id}`, body: null, url: null, reason: 'subscribed', context: 'o/r', subject: null, actors: [], at: T0, unread: true, ...o });

function world(o: { judge?: (t: string) => Promise<number | null>; level?: 'read' | 'write'; sends?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dither-notices-'));
  const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  store.db.exec('PRAGMA synchronous = OFF');
  const triage = new Triage(store);
  triage.judge = o.judge ?? null;
  const votes = new TriageVotes(store, triage);
  const fake = new FakeNoticeSource();
  const sent: NoticeDelivery[] = [];
  const clock = new FakeClock(T0);
  const notices = new Notices({ store, triage, votes, link: fake, deliver: (n) => (sent.push(n), o.sends?.() ?? true), clock });
  fake.addAccount(GH, 'github', 'GitHub', o.level ?? 'write');
  cleanup = () => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const row = (id: string) => store.one<Record<string, any>>('SELECT * FROM notice WHERE id = ?', noticeId(GH, id));
  return { store, triage, votes, fake, notices, sent, clock, row };
}

describe('notices on the fake source', () => {
  test('a catch-up is quiet; a live one notifies; a repeat does not', async () => {
    const w = world();
    w.fake.put(GH, note({ id: 'old-high', urgency: 'high', at: T0 - 10 * MIN }));
    w.fake.put(GH, note({ id: 'old-read', unread: false, at: T0 - 5 * MIN }));
    w.fake.attach(w.notices);
    await w.notices.idle();
    // Unread only, as the interface allows.
    expect(w.fake.calls.find((c) => c.op === 'notify.list')?.input).toMatchObject({ unreadOnly: true });
    expect(w.row('old-high')).toMatchObject({ decision: 'push', delivered: 0 });
    expect(JSON.parse(w.row('old-high')!.reasons)).toContain('Came by a catch-up: no notification');
    expect(w.row('old-read')).toBeNull();
    expect(w.sent).toEqual([]);

    w.fake.emit(GH, note({ id: 'new-high', urgency: 'high', title: 'Secret leaked', context: 'o/r', reason: 'security_alert' }));
    await w.notices.idle();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ id: noticeId(GH, 'new-high'), group: groupId(GH, 'o/r'), title: 'GitHub · o/r', body: 'Secret leaked', level: 'push', importance: 0.9, look: { network: 'notice' } });
    w.fake.emit(GH, note({ id: 'new-high', urgency: 'high', title: 'Secret leaked', context: 'o/r', reason: 'security_alert' }));
    await w.notices.idle();
    expect(w.sent).toHaveLength(1);
    // Back with something new (a newer time): triaged again.
    await w.clock.advance(MIN);
    w.fake.emit(GH, note({ id: 'new-high', urgency: 'high', title: 'Secret leaked', context: 'o/r', at: T0 + MIN }));
    await w.notices.idle();
    expect(w.sent).toHaveLength(2);
  });

  test('a normal one asks the local model; a low one does not', async () => {
    const asked: string[] = [];
    const w = world({ judge: async (t) => (asked.push(t), t.includes('prod is down') ? 0.9 : 0.01) });
    w.fake.attach(w.notices);
    await w.notices.idle();
    w.fake.emit(GH, note({ id: 'n1', urgency: 'normal', reason: 'mention', title: 'prod is down', body: '@you look now' }));
    w.fake.emit(GH, note({ id: 'n2', urgency: 'normal', reason: 'mention', title: 'Typo in README' }));
    w.fake.emit(GH, note({ id: 'n3', urgency: 'low', reason: 'ci_activity', title: 'CI passed' }));
    // Absent urgency is normal.
    w.fake.emit(GH, { ...note({ id: 'n4', reason: 'comment', title: 'A comment' }), urgency: undefined });
    await w.notices.idle();
    expect(asked).toEqual(['prod is down\n@you look now', 'Typo in README', 'A comment']);
    expect(w.sent.map((s) => [s.id, s.level])).toEqual([
      [noticeId(GH, 'n1'), 'push'],
      [noticeId(GH, 'n2'), 'digest'],
      [noticeId(GH, 'n4'), 'digest'],
    ]);
    expect(w.row('n3')?.decision).toBe('drop');
    expect(w.sent[0].addressed).toBe(true);
    expect(w.sent[2].addressed).toBe(false);
  });

  test('read there: read here, never notified; read here: read there, best effort', async () => {
    const w = world();
    w.fake.attach(w.notices);
    await w.notices.idle();
    w.fake.emit(GH, note({ id: 'a', urgency: 'high' }));
    w.fake.emit(GH, note({ id: 'b', urgency: 'high', at: T0 + 1 }));
    await w.notices.idle();
    const group = groupId(GH, 'o/r');
    expect(w.notices.readTs(group)).toBe(T0 - 1);
    w.fake.readThere(GH, ['a']);
    await w.notices.idle();
    expect(w.row('a')?.unread).toBe(0);
    expect(w.notices.readTs(group)).toBe(T0);
    expect(w.sent).toHaveLength(2);
    await w.clock.advance(MIN);
    expect(w.notices.markRead(noticeId(GH, 'b'))).toBe(true);
    expect(w.row('b')?.unread).toBe(0);
    const readAt = w.row('b')?.read_at;
    expect(w.notices.readTs(group)).toBe(Number.MAX_SAFE_INTEGER);
    expect(w.fake.calls.filter((c) => c.op === 'notify.markRead').map((c) => c.input)).toEqual([{ ids: ['b'] }]);
    // The service's echo (notify.read for b) changes nothing, and notifies nobody.
    await w.clock.advance(MIN);
    await w.notices.idle();
    expect(w.row('b')).toMatchObject({ unread: 0, read_at: readAt });
    expect(w.sent).toHaveLength(2);
    expect(w.notices.markRead('ntc_nope')).toBe(false);
  });

  test('with a read grant, reading here stays here', async () => {
    const w = world({ level: 'read' });
    w.fake.attach(w.notices);
    w.fake.emit(GH, note({ id: 'a', urgency: 'high' }));
    await w.notices.idle();
    w.notices.markRead(noticeId(GH, 'a'));
    expect(w.fake.calls.some((c) => c.op === 'notify.markRead')).toBe(false);
  });

  test('a gap and a reconnection list again, from the oldest unread kept', async () => {
    const w = world();
    w.fake.attach(w.notices);
    w.fake.emit(GH, note({ id: 'a', urgency: 'low', at: T0 - MIN }));
    await w.notices.idle();
    w.fake.put(GH, note({ id: 'missed', urgency: 'high', at: T0 }));
    w.fake.calls.length = 0;
    expect(w.notices.gap(GH)).toBe(true);
    expect(w.notices.gap('acc_notMine')).toBe(false);
    await w.notices.idle();
    expect(w.fake.calls.map((c) => c.input)).toEqual([{ unreadOnly: true, limit: 50, since: T0 - MIN }]);
    expect(w.row('missed')).toMatchObject({ decision: 'push', delivered: 0 });
    w.fake.calls.length = 0;
    w.notices.connection(false);
    w.notices.connection(true);
    await w.notices.idle();
    expect(w.fake.calls.map((c) => c.op)).toEqual(['notify.list']);
    expect(w.sent).toEqual([]);
  });

  test('a muted account is silent; one notification per group, its lines oldest first', async () => {
    const w = world();
    w.fake.attach(w.notices);
    w.fake.emit(GH, note({ id: 'a', urgency: 'high', title: 'First', actors: [{ name: 'ana', url: null, avatar: null }] }));
    w.fake.emit(GH, note({ id: 'b', urgency: 'high', title: 'Second', at: T0 + 1 }));
    await w.notices.idle();
    const g = w.notices.gather(groupId(GH, 'o/r'), noticeId(GH, 'b'))!;
    expect(g.lines.map((l) => [l.author, l.body])).toEqual([
      ['ana', 'First'],
      ['GitHub', 'Second'],
    ]);
    expect(g.conv).toEqual({ title: 'GitHub · o/r', shape: 'group' });
    expect(w.notices.chain(groupId(GH, 'o/r'))).toEqual([`conversation:${groupId(GH, 'o/r')}`, `account:${GH}`, 'network:notice']);
    w.store.setRule('account', GH, 'none');
    w.fake.emit(GH, note({ id: 'c', urgency: 'high', at: T0 + 2 }));
    await w.notices.idle();
    expect(w.row('c')?.decision).toBe('silent');
    expect(w.sent).toHaveLength(2);
  });

  test('marks join chat’s: "Alert was wrong" twice and the group’s next high one is a row on the list', async () => {
    const w = world();
    w.fake.attach(w.notices);
    for (const id of ['a', 'b']) w.fake.emit(GH, note({ id, urgency: 'high' }));
    await w.notices.idle();
    for (const id of ['a', 'b']) expect(w.votes.mark(noticeId(GH, id), { alert: false }).marks).toEqual({ alert: false });
    expect(w.votes.examples().filter((e) => e.id?.startsWith('ntc_'))).toHaveLength(2);
    w.fake.emit(GH, note({ id: 'c', urgency: 'high', at: T0 + 1 }));
    await w.notices.idle();
    expect(w.row('c')?.decision).toBe('digest');
    expect(JSON.parse(w.row('c')!.reasons)[0]).toBe('List, learned from your marks (was Alert)');
    // Its group is named in what was learned.
    expect(w.votes.namer().conversation(groupId(GH, 'o/r'))).toBe('notices from GitHub · o/r');
    // Taken back.
    expect(w.votes.mark(noticeId(GH, 'a'), { alert: null }).marks).toEqual({});
    expect(() => w.votes.mark('ntc_nope', { less: true })).toThrow('never decided');
  });

  test('a notification that went nowhere does not count; what notified nobody does not keep the group showing', async () => {
    let sends = true;
    const w = world({ sends: () => sends });
    // Caught up, unread, never notified, in the same group.
    w.fake.put(GH, note({ id: 'old', urgency: 'high', at: T0 - 10 * MIN }));
    w.fake.attach(w.notices);
    await w.notices.idle();
    const group = groupId(GH, 'o/r');
    expect(w.notices.readTs(group)).toBe(Number.MAX_SAFE_INTEGER);
    w.fake.emit(GH, note({ id: 'live', urgency: 'high' }));
    await w.notices.idle();
    expect(w.row('live')?.delivered).toBe(1);
    expect(w.notices.readTs(group)).toBe(T0 - 1);
    // Read: the group's notification may go, though the caught-up one is still unread.
    w.notices.markRead(noticeId(GH, 'live'));
    expect(w.row('old')?.unread).toBe(1);
    expect(w.notices.readTs(group)).toBe(Number.MAX_SAFE_INTEGER);
    // The notifier held one (the phone's list, its ten minutes): not delivered.
    sends = false;
    w.fake.emit(GH, note({ id: 'held', urgency: 'normal', context: 'o/held' }));
    await w.notices.idle();
    expect(w.row('held')).toMatchObject({ decision: 'digest', delivered: 0 });
  });

  test('a catch-up finds what was read there meanwhile, quietly; what it did not reach stays as it was', async () => {
    const w = world();
    for (const [id, m] of [['a', 30], ['b', 20], ['c', 10]] as const) w.fake.put(GH, note({ id, urgency: 'high', at: T0 - m * MIN }));
    w.fake.attach(w.notices);
    await w.notices.idle();
    expect(['a', 'b', 'c'].map((id) => w.row(id)?.unread)).toEqual([1, 1, 1]);
    // b read on GitHub while the manager was away: no notify.read came.
    w.fake.put(GH, note({ id: 'b', urgency: 'high', at: T0 - 20 * MIN, unread: false }));
    await w.clock.advance(MIN);
    w.fake.calls.length = 0;
    w.notices.gap(GH);
    await w.notices.idle();
    expect(w.fake.calls.map((c) => c.input)).toEqual([{ unreadOnly: true, limit: 50, since: T0 - 30 * MIN }]);
    expect(['a', 'b', 'c'].map((id) => w.row(id)?.unread)).toEqual([1, 0, 1]);
    // Quietly: nothing sent, nothing told to GitHub.
    expect(w.sent).toEqual([]);
    expect(w.fake.calls.some((c) => c.op === 'notify.markRead')).toBe(false);
  });

  test('catch-up pages, keeps to the last 30 days, and old notices go', async () => {
    const w = world();
    for (let i = 0; i < 120; i++) w.fake.put(GH, note({ id: `p${i}`, urgency: 'low', at: T0 - (i + 1) * MIN }));
    w.fake.put(GH, note({ id: 'ancient', urgency: 'high', at: T0 - 31 * 24 * 60 * MIN }));
    w.fake.attach(w.notices);
    await w.notices.idle();
    const lists = w.fake.calls.filter((c) => c.op === 'notify.list').map((c) => c.input.pageToken ?? null);
    expect(lists).toEqual([null, '50', '100']);
    expect(w.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM notice')?.n).toBe(120);
    expect(w.row('ancient')).toBeNull();
    // A month on, they go, except one you marked (it is learned from).
    w.votes.mark(noticeId(GH, 'p0'), { alert: true });
    await w.clock.advance(31 * 24 * 60 * MIN);
    w.notices.prune();
    expect(w.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM notice')?.n).toBe(1);
    expect(w.row('p0')).not.toBeNull();
  });

  test('a slow local model holds up nothing else, and each notice’s own steps keep their order', async () => {
    let answer!: (x: number) => void;
    const w = world({ judge: (t) => (t.startsWith('slow') ? new Promise<number>((r) => (answer = r)) : Promise.resolve(0.01)) });
    w.fake.attach(w.notices);
    await w.notices.idle();
    w.fake.emit(GH, note({ id: 'slow', urgency: 'normal', title: 'slow: prod is down', context: 'o/a' }));
    w.fake.emit(GH, note({ id: 'quick', urgency: 'low', title: 'CI passed', context: 'o/b' }));
    w.fake.emit(GH, note({ id: 'other', urgency: 'normal', title: 'A review', context: 'o/c' }));
    await w.clock.settle();
    expect(w.row('slow')?.decision).toBeNull();
    expect(w.row('quick')?.decision).toBe('drop');
    expect(w.row('other')?.decision).toBe('digest');
    // Read there while its answer is awaited: decided after, as read, and so notifying nobody.
    w.fake.readThere(GH, ['slow']);
    await w.clock.settle();
    expect(w.row('slow')).toMatchObject({ unread: 0, decision: null });
    answer(0.9);
    await w.notices.idle();
    expect(w.row('slow')).toMatchObject({ decision: 'push', delivered: 0 });
    expect(JSON.parse(w.row('slow')!.reasons)).toContain('Already read: no notification');
    expect(w.sent.map((s) => s.id)).toEqual([noticeId(GH, 'other')]);
  });

  test('a local model that never answers is given up on at its time', async () => {
    const w = world({ judge: () => new Promise<number>(() => {}) });
    w.triage.judgeTimeoutMs = 3_000;
    w.fake.attach(w.notices);
    await w.notices.idle();
    w.fake.emit(GH, note({ id: 'n', urgency: 'normal', title: 'A review' }));
    await w.clock.advance(2_999);
    expect(w.row('n')?.decision).toBeNull();
    await w.clock.advance(1);
    await w.notices.idle();
    expect(w.row('n')?.decision).toBe('digest');
    expect(JSON.parse(w.row('n')!.reasons)).toContain('The local model did not answer in time: not read for urgency');
  });

  test('quiet hours hold a high one as a list row, counted for their summary', async () => {
    const w = world();
    w.store.setQuietHours({ enabled: true, start: '00:00', end: '23:59', timezone: 'UTC', allowStarred: false });
    w.fake.attach(w.notices);
    w.fake.emit(GH, note({ id: 'h', urgency: 'high' }));
    await w.notices.idle();
    expect(w.row('h')?.decision).toBe('digest');
    expect(w.store.quietHeld()).toMatchObject({ count: 1, conversationId: groupId(GH, 'o/r'), messageId: noticeId(GH, 'h') });
    w.store.setQuietHours({ enabled: false, start: '00:00', end: '23:59', timezone: 'UTC', allowStarred: false });
    expect(w.triage.takeHeldSummary(T0)).toMatchObject({ title: 'Quiet hours are over', body: '1 message held for you' });
  });

  test('a catch-up that came first does not swallow the live notification, while it is unread and fresh', async () => {
    const w = world();
    // GitHub's list reads the API at once; its notify.new waits for the poll.
    w.fake.put(GH, note({ id: 'race', urgency: 'high', at: T0 - MIN }));
    w.fake.put(GH, note({ id: 'stale', urgency: 'high', at: T0 - 2 * 60 * MIN }));
    w.fake.put(GH, note({ id: 'read', urgency: 'high', at: T0 - MIN, context: 'o/x' }));
    w.fake.attach(w.notices);
    await w.notices.idle();
    expect(w.row('race')).toMatchObject({ decision: 'push', delivered: 0, caught: 1 });
    w.notices.markRead(noticeId(GH, 'read'));
    for (const id of ['race', 'stale']) w.fake.emit(GH, note({ id, urgency: 'high', at: id === 'race' ? T0 - MIN : T0 - 2 * 60 * MIN }));
    w.fake.emit(GH, note({ id: 'read', urgency: 'high', at: T0 - MIN, context: 'o/x' }));
    await w.notices.idle();
    expect(w.sent.map((s) => s.id)).toEqual([noticeId(GH, 'race')]);
    expect(w.row('race')).toMatchObject({ delivered: 1, caught: 0 });
    // And once only.
    w.fake.emit(GH, note({ id: 'race', urgency: 'high', at: T0 - MIN }));
    await w.notices.idle();
    expect(w.sent).toHaveLength(1);
  });

  test('read here stays read when a catch-up still lists it unread, until it is raised again', async () => {
    const w = world({ level: 'read' });
    w.fake.attach(w.notices);
    w.fake.emit(GH, note({ id: 'a', urgency: 'high', at: T0 - MIN }));
    await w.notices.idle();
    await w.clock.advance(MIN);
    w.notices.markRead(noticeId(GH, 'a'));
    // A read grant: GitHub still has it unread, and lists it so.
    w.notices.gap(GH);
    await w.notices.idle();
    expect(w.row('a')?.unread).toBe(0);
    expect(w.sent).toHaveLength(1);
    // Raised again (a new comment): unread, and decided again.
    w.fake.put(GH, note({ id: 'a', urgency: 'high', at: T0 + MIN }));
    await w.clock.advance(MIN);
    w.notices.gap(GH);
    await w.notices.idle();
    expect(w.row('a')).toMatchObject({ unread: 1, at: T0 + MIN });
  });

  test('an account the hub reads as chat too is left to chat', async () => {
    const w = world();
    w.fake.attach(w.notices);
    w.notices.accounts([{ id: 'acc_tg', kind: 'telegram', label: 'Telegram', interfaces: ['chat', 'notifications'], grants: { chat: 'manage', notifications: 'write' } }]);
    expect(w.notices.events('acc_tg', [{ t: 'notify.new', notification: note({ id: 'm1', source: 'telegram' }) }])).toBe(false);
    expect(w.notices.gap('acc_tg')).toBe(false);
    // Without the chat grant (another app's chat account), its notices are ours.
    w.notices.accounts([{ id: 'acc_tg', kind: 'telegram', label: 'Telegram', interfaces: ['chat', 'notifications'], grants: { notifications: 'write' } }]);
    expect(w.notices.events('acc_tg', [])).toBe(true);
  });

  test('the routes: the page, one notice, Mark read', async () => {
    const w = world();
    w.fake.attach(w.notices);
    w.fake.emit(GH, note({ id: 'a', urgency: 'high', url: 'https://github.com/o/r/issues/1', title: 'Hi' }));
    await w.notices.idle();
    const get = (path: string, method = 'GET') => w.notices.route(new Request(`http://hub${path}`, { method }), new URL(`http://hub${path}`));
    const page = (await (await get('/api/notices'))!.json()) as P.NoticesPage;
    expect(page.access).toBe('granted');
    expect(page.accounts).toEqual([{ id: GH, kind: 'github', label: 'GitHub' }]);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: noticeId(GH, 'a'), title: 'Hi', url: 'https://github.com/o/r/issues/1', urgency: 'high', unread: true, triage: { decision: 'push', score: 0.9 } });
    const id = noticeId(GH, 'a');
    expect(((await (await get(`/api/notices/${id}/read`, 'POST'))!.json()) as P.NoticeView).unread).toBe(false);
    expect((await get('/api/notices/ntc_nope'))!.status).toBe(404);
    expect(await get('/api/notices/elsewhere/x')).toBeNull();
  });

  test('anything not a notification is skipped; a link that is not the web is dropped', async () => {
    const w = world();
    w.fake.attach(w.notices);
    w.notices.events(GH, [{ t: 'notify.new', notification: { id: 'x' } }, { t: 'notify.new', notification: null }]);
    w.fake.emit(GH, note({ id: 'js', url: 'javascript:alert(1)' }));
    await w.notices.idle();
    expect(w.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM notice')?.n).toBe(1);
    expect(w.row('js')?.url).toBeNull();
  });
});

// ------------------------------------------------------------------ the push

describe('Notifier.notice', () => {
  test('one notification per group, carrying noticeId; a list row skips the computers', async () => {
    const w = world();
    const devices = new Devices(w.store, w.triage);
    const delivery = new Delivery(w.store, w.triage);
    delivery.other = w.notices;
    devices.otherChain = (id) => w.notices.chain(id);
    const pushes: { title: string; body: string; conv: string | undefined; extra: Record<string, unknown>; skip: string[]; level: string }[] = [];
    const pages: Extract<P.ClientEvent, { t: 'notify' }>[] = [];
    const notifier = new Notifier({
      store: w.store,
      activity: { notification: (n) => `nid-${n.messageId}`, sent: () => {} },
      devices,
      push: { desktops: () => ['reg-desk'], notify: async (title, body, conv, extra, skip = [], level = 'push') => (pushes.push({ title, body, conv, extra, skip, level }), { devices: 1, accepted: 1 }) },
      delivery,
      server: { notify: (ev) => void pages.push(ev), warm: async () => {} },
      phone: { list: () => ({ send: true }) as any, higher: () => {} },
    });
    const sent: NoticeDelivery[] = [];
    w.fake.attach(w.notices);
    (w.notices as any).o.deliver = (n: NoticeDelivery) => (sent.push(n), notifier.notice(n));
    w.fake.emit(GH, note({ id: 'a', urgency: 'high', title: 'Secret leaked', reason: 'security_alert' }));
    await w.notices.idle();
    await notifier.last;
    const group = groupId(GH, 'o/r');
    const id = noticeId(GH, 'a');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ title: 'GitHub · o/r', body: 'Secret leaked', conv: group, skip: [], level: 'push' });
    expect(pushes[0].extra).toMatchObject({ network: 'notice', noticeId: id, messageId: id, tier: 'push', importance: 0.9, alert: true, nid: `nid-${id}`, conv: { title: 'GitHub · o/r', shape: 'group' } });
    expect(pages[0]).toMatchObject({ t: 'notify', noticeId: id, messageId: id, conversationId: group, title: 'GitHub · o/r' });
    expect(pages[0].level).toBeUndefined();

    // A list row, in another group: silent, phones only.
    w.fake.emit(GH, note({ id: 'b', urgency: 'normal', reason: 'review_requested', context: 'o/other', title: 'Review this' }));
    await w.notices.idle();
    await notifier.last;
    expect(pushes[1]).toMatchObject({ conv: groupId(GH, 'o/other'), skip: ['reg-desk'], level: 'quiet' });
    expect(pushes[1].extra).toMatchObject({ tier: 'digest', noticeId: noticeId(GH, 'b') });
    expect(pages[1].level).toBe('digest');

    // A device with Notices off gets neither.
    w.store.db.query(`INSERT INTO device (id, label, last_seen_at) VALUES ('dev-phone', 'Android app', 0)`).run();
    devices.setRule('dev-phone', 'network', 'notice', 'none');
    w.fake.emit(GH, note({ id: 'c', urgency: 'high', context: 'o/third' }));
    await w.notices.idle();
    await notifier.last;
    expect(pushes[2].skip).toEqual(['dev-phone']);
    expect(pages[2].quiet).toEqual(['dev-phone']);
  });
});

// ------------------------------------------------------------------ asking for the grant

describe('asking dither-accounts for notices', () => {
  test('asked once: not with a grant, nor while a request waits, nor after a no', () => {
    expect(noticesAccessOf({ grants: [{ interface: 'notifications', kinds: null }] })).toBe('granted');
    expect(noticesAccessOf({ requests: [{ interface: 'notifications', state: 'pending' }] })).toBe('pending');
    expect(noticesAccessOf({ requests: [{ interface: 'notifications', state: 'denied' }] })).toBe('denied');
    expect(noticesAccessOf({ grants: [{ interface: 'mail', kinds: null }] })).toBeNull();
    expect(noticesToAsk(null)).toBe(true);
    expect(noticesToAsk({ requests: [{ interface: 'notifications', state: 'denied' }] })).toBe(false);
    expect(NOTICES_REQUEST).toMatchObject({ interface: 'notifications', level: 'write', accounts: '*' });
  });

  const before = process.env.DITHER_ACCOUNTS_CLIENT;
  process.env.DITHER_ACCOUNTS_CLIENT = resolve(import.meta.dir, 'fixtures/accounts-client-stub.ts');
  afterAll(() => {
    if (before === undefined) delete process.env.DITHER_ACCOUNTS_CLIENT;
    else process.env.DITHER_ACCOUNTS_CLIENT = before;
  });

  async function hub(saved: boolean, self: typeof stub.self) {
    const dir = mkdtempSync(join(tmpdir(), 'dither-notices-remote-'));
    const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    if (saved) writeFileSync(join(dir, 'accounts-app.json'), JSON.stringify({ app: 'app_stub', token: 'token_stub', url: 'http://manager.test' }));
    // It manages every chat kind already: only notices are in question here.
    const all = self && { ...self, grants: [...(self.grants ?? []), { interface: 'accounts', kinds: null }] };
    Object.assign(stub, { self: all, registered: [], asked: [], client: null, calls: [], admin: [] });
    const repoRoot = resolve(import.meta.dir, '../../..');
    const sup = new RoutedSupervisor(store, { hubAdapterUrl: 'ws://127.0.0.1:1/adapter', dataDir: dir, repoRoot, inproc: () => null, onFresh: () => {} }, { url: 'http://manager.test', dataDir: dir, repoRoot });
    const triage = new Triage(store);
    const notices = new Notices({ store, triage, link: { call: (a, op, i, t) => sup.callNotices(a, op, i, t), askAgain: () => sup.askNoticesAgain() } });
    sup.notices = notices;
    await sup.connect();
    cleanup = () => {
      void sup.stopAll();
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { sup, notices, store };
  }

  test('a new hub asks for it as it registers', async () => {
    const h = await hub(false, null);
    expect(stub.registered[0].requests.map((r) => r.interface)).toContain('notifications');
    expect(stub.asked).toEqual([]);
    expect(h.notices.access()).toBe('pending');
  });

  test('a hub registered before notices asks once', async () => {
    const h = await hub(true, { grants: [{ interface: 'chat', kinds: null }], requests: [] });
    expect(stub.asked).toEqual([[NOTICES_REQUEST]]);
    expect(h.notices.access()).toBe('pending');
  });

  test('waiting or declined: not asked again; declined says so, and Ask again asks', async () => {
    let h = await hub(true, { requests: [{ interface: 'notifications', state: 'pending' }] });
    expect(stub.asked).toEqual([]);
    expect(h.notices.access()).toBe('pending');
    cleanup?.();
    h = await hub(true, { requests: [{ interface: 'notifications', state: 'denied' }] });
    expect(stub.asked).toEqual([]);
    expect(h.notices.access()).toBe('denied');
    await h.notices.askAgain();
    expect(stub.asked).toEqual([[NOTICES_REQUEST]]);
    expect(h.notices.access()).toBe('pending');
  });

  test('granted: a notifications account is caught up and its events are notices; a chat account’s go to chat, which restarts it after a gap', async () => {
    const h = await hub(true, { grants: [{ interface: 'notifications', kinds: null }] });
    expect(h.notices.access()).toBe('granted');
    const applied: number[] = [];
    h.sup.onApplied = (n) => applied.push(n);
    const TG = 'acc_noticeTelegram';
    const c = stub.client!;
    c.opts.onConnection?.(true);
    c.opts.onAccounts?.([
      { id: GH, kind: 'github', label: 'GitHub', interfaces: ['notifications'], running: true, online: true, enabled: true, grants: { notifications: 'write' }, dryRun: false },
      { id: TG, kind: 'telegram', label: 'Telegram', interfaces: ['chat', 'notifications'], running: true, online: true, enabled: true, grants: { chat: 'manage', notifications: 'write' }, dryRun: false },
    ]);
    await h.notices.idle();
    expect(stub.calls.map((x) => [x.account, x.op])).toEqual([[GH, 'notify.list']]);
    // GitHub's: a notice, and nothing for chat.
    c.opts.onEvents?.(GH, [{ t: 'notify.new', notification: note({ id: 'gh-1', urgency: 'low' }) }]);
    await h.notices.idle();
    expect(h.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM notice')?.n).toBe(1);
    expect(applied).toEqual([]);
    // Telegram's (chat and Desktop's popups): applied as chat, no notice.
    c.opts.onEvents?.(TG, [{ t: 'status', status: 'online' }, { t: 'notify.new', notification: note({ id: 'tg-1', source: 'telegram', context: 'Family' }) }]);
    await h.sup.drained();
    await h.notices.idle();
    expect(applied).toEqual([2]);
    expect(h.store.account(TG)?.status).toBe('online');
    expect(h.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM notice')?.n).toBe(1);
    // A gap: GitHub's notices list again and nothing restarts; Telegram's restarts for a snapshot, as before.
    stub.calls.length = 0;
    // (Newly the manager's and online, it was restarted once already, for its first snapshot.)
    stub.admin.length = 0;
    c.opts.onGap?.(GH, 3);
    c.opts.onGap?.(TG, 3);
    await h.notices.idle();
    expect(stub.calls.map((x) => [x.account, x.op])).toEqual([[GH, 'notify.list']]);
    expect(stub.admin.filter((a) => a.do === 'restart')).toEqual([{ do: 'restart', account: TG }]);
  });
});
