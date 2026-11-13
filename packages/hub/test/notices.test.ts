/**
 * Notices (notices/, docs/notices.md): triage's table (urgency, the local model's answer, your rules and marks →
 * tier), ingest on the fake source (a catch-up is quiet, live notices notify, reads go both ways, a gap and a
 * reconnection list again), marks teaching chat's model, Notifier.notice's push, the routes, and asking dither-accounts
 * for the grant once (RoutedSupervisor on a stand-in client). Nothing here sends a push or reaches the network.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { Delivery } from '../src/delivery.ts';
import { Devices } from '../src/devices.ts';
import { emptyModel, train, THRESHOLDS, type Example } from '../src/learn.ts';
import { Notifier } from '../src/notify.ts';
import { FakeNoticeSource, type FakeNotification } from '../src/notices/fake.ts';
import { groupId, noticeId, Notices, type NoticeDelivery } from '../src/notices/index.ts';
import { decideNotice, factsOf, startOf, type NoticeContext, type NoticeInput } from '../src/notices/triage.ts';
import { NOTICES_REQUEST, noticesAccessOf, noticesToAsk, RoutedSupervisor } from '../src/remote.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { TriageVotes } from '../src/votes.ts';
import { stub } from './fixtures/accounts-client-stub.ts';

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
    expect(startOf('normal')).toEqual({ alert: 0.02, important: 0.6 });
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
    expect(d.reasons).toEqual(['Alert: GitHub says it is urgent', 'GitHub says: security alert (high)']);
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
    expect(f).toMatchObject({ network: 'notice:github', shape: 'notice', conversation: 'ntg_repo', spaces: [GH], author: 'https://github.com/sam', mention: true, link: true, urgent: false, start: { alert: 0.02, important: 0.6 } });
    expect(factsOf(input({ reason: 'subscribed', urgency: 'high' }))).toMatchObject({ mention: false, urgent: true });
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

function world(o: { judge?: (t: string) => Promise<number | null>; level?: 'read' | 'write' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dither-notices-'));
  const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  store.db.exec('PRAGMA synchronous = OFF');
  const triage = new Triage(store);
  triage.judge = o.judge ?? null;
  const votes = new TriageVotes(store, triage);
  const fake = new FakeNoticeSource();
  const sent: NoticeDelivery[] = [];
  const clock = { now: T0 };
  const notices = new Notices({ store, triage, votes, link: fake, deliver: (n) => sent.push(n), now: () => clock.now });
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
    w.clock.now += MIN;
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
    expect(w.notices.markRead(noticeId(GH, 'b'))).toBe(true);
    expect(w.row('b')?.unread).toBe(0);
    expect(w.notices.readTs(group)).toBe(Number.MAX_SAFE_INTEGER);
    expect(w.fake.calls.filter((c) => c.op === 'notify.markRead').map((c) => c.input)).toEqual([{ ids: ['b'] }]);
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

  test('a gap and a reconnection list again, from the newest kept', async () => {
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
    Object.assign(stub, { self: all, registered: [], asked: [], client: null, calls: [] });
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

  test('granted: an account with notifications is caught up, and its events go to notices and to chat', async () => {
    const h = await hub(true, { grants: [{ interface: 'notifications', kinds: null }] });
    expect(h.notices.access()).toBe('granted');
    const c = stub.client!;
    c.opts.onConnection?.(true);
    c.opts.onAccounts?.([{ id: GH, kind: 'telegram', label: 'Telegram', interfaces: ['chat', 'notifications'], running: true, online: true, enabled: true, grants: { chat: 'manage', notifications: 'write' }, dryRun: false }]);
    await h.notices.idle();
    expect(stub.calls.map((x) => [x.account, x.op])).toEqual([[GH, 'notify.list']]);
    c.opts.onEvents?.(GH, [{ t: 'notify.new', notification: note({ id: 'tg-1', source: 'telegram', context: 'Family', urgency: 'low' }) }]);
    await h.notices.idle();
    expect(h.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM notice')?.n).toBe(1);
    // A gap on an account that is chat's too: notices list again, and chat restarts it for a snapshot as before.
    stub.calls.length = 0;
    c.opts.onGap?.(GH, 3);
    await h.notices.idle();
    expect(stub.calls.map((x) => x.op)).toEqual(['notify.list']);
  });
});
