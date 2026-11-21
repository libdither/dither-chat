/** The page's copy of mail (mail/model.ts): bootstrap, events, lists kept in order, sender lines. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { mailPlatform, parseMailList, platformScope, viewList } from '@dither-chat/protocol';
import { accountTrouble, applyMailBootstrap, PROBLEM_GRACE_MS, scopeAccounts, listTitle, applyMailEvent, emptyMail, inList, listThreads, mergePage, rankable, rankedThreads, senderLine, unreadInbox, updatesFold } from '../src/mail/model.ts';

const ACC = 'acc_a';
const t = (id: string, lastAt: number, x: Partial<P.MailThreadView> = {}): P.MailThreadView => ({
  id,
  accountId: ACC,
  subject: id,
  firstAt: lastAt,
  lastAt,
  count: 1,
  unread: 0,
  flagged: false,
  attachments: false,
  from: [{ name: 'Sam Lee', email: 'sam@x.org' }],
  participants: 2,
  preview: null,
  mailboxIds: ['mbx_in'],
  roles: ['inbox'],
  labels: [],
  class: null,
  unknown: false,
  personIds: [],
  lastFromMe: false,
  owedSince: null,
  muted: false,
  ...x,
});
const account = { id: ACC, kind: 'imap', label: 'a', address: 'me@x.org', name: null, color: '#fff', level: 'write', dryRun: false, online: true, problem: null, send: { ok: null, why: null }, sync: { phase: 'idle', synced: 0, oldest: null }, managedUrl: null, deleteAt: null } satisfies P.MailAccountView;

const boot = (threads: P.MailThreadView[]) => {
  const s = emptyMail();
  applyMailBootstrap(s, { access: { state: 'granted', managerUrl: null }, accounts: [account], mailboxes: [], threads });
  return s;
};
const ids = (xs: P.MailThreadView[]) => xs.map((x) => x.id);

test('before a list loads, it shows what the bootstrap window has of it, newest first', () => {
  const s = boot([t('a', 1), t('b', 3), t('c', 2, { roles: ['sent'], mailboxIds: ['mbx_sent'] })]);
  expect(ids(listThreads(s, 'v:inbox:*'))).toEqual(['b', 'a']);
  expect(ids(listThreads(s, 'v:sent:*'))).toEqual(['c']);
  expect(ids(listThreads(s, 'mb:mbx_sent'))).toEqual(['c']);
  expect(ids(listThreads(s, `v:inbox:${ACC}`))).toEqual(['b', 'a']);
  expect(ids(listThreads(s, 'v:inbox:acc_other'))).toEqual([]);
});

test('membership: unread leaves out junk and trash, starred is flagged, later views hold nothing yet', () => {
  expect(inList('v:unread:*', t('x', 1, { unread: 1 }))).toBe(true);
  expect(inList('v:unread:*', t('x', 1, { unread: 1, roles: ['junk'] }))).toBe(false);
  expect(inList('v:starred:*', t('x', 1, { flagged: true, roles: ['archive'] }))).toBe(true);
  expect(inList('v:people:*', t('x', 1))).toBe(false);
  expect(inList('nonsense', t('x', 1))).toBe(false);
});

test('a loaded list: new threads go in where they sort, ones that leave it come out, removed ones go', () => {
  const s = boot([]);
  mergePage(s, 'v:inbox:*', { threads: [t('c', 30), t('b', 20), t('a', 10)], next: null, complete: true, pending: false }, false);
  applyMailEvent(s, { t: 'mail.threads', threads: [t('d', 25), t('a', 40)], removed: [] });
  expect(ids(listThreads(s, 'v:inbox:*'))).toEqual(['a', 'c', 'd', 'b']);
  // Archived elsewhere: no longer in Inbox.
  applyMailEvent(s, { t: 'mail.threads', threads: [t('c', 30, { roles: ['archive'], mailboxIds: ['mbx_arch'] })], removed: ['b'] });
  expect(ids(listThreads(s, 'v:inbox:*'))).toEqual(['a', 'd']);
  expect(s.threads.has('b')).toBe(false);
});

test('a thread older than everything loaded waits for its page when more is to come', () => {
  const s = boot([]);
  mergePage(s, 'v:inbox:*', { threads: [t('c', 30), t('b', 20)], next: '20:b', complete: false, pending: false }, false);
  applyMailEvent(s, { t: 'mail.threads', threads: [t('old', 5)], removed: [] });
  expect(ids(listThreads(s, 'v:inbox:*'))).toEqual(['c', 'b']);
  mergePage(s, 'v:inbox:*', { threads: [t('a', 10), t('old', 5)], next: null, complete: true, pending: false }, true);
  expect(ids(listThreads(s, 'v:inbox:*'))).toEqual(['c', 'b', 'a', 'old']);
});

test('accounts, mailboxes and an account that goes with its threads', () => {
  const s = boot([t('a', 1)]);
  applyMailEvent(s, { t: 'mail.mailboxes', accountId: ACC, mailboxes: [{ id: 'mbx_in', accountId: ACC, name: 'Inbox', path: 'INBOX', parentId: null, role: 'inbox', unread: 0, total: 1, followed: true }] });
  expect(s.mailboxes.size).toBe(1);
  expect(applyMailEvent(s, { t: 'mail.access', access: { state: 'denied', managerUrl: null } })).toBe(true);
  expect(s.access.state).toBe('denied');
  applyMailEvent(s, { t: 'mail.account.removed', id: ACC });
  expect([s.accounts.size, s.mailboxes.size, s.threads.size]).toEqual([0, 0, 0]);
  // Not mail's.
  expect(applyMailEvent(s, { t: 'resync' })).toBe(false);
});

test('a bootstrap again forgets loaded lists, so each loads again when shown', () => {
  const s = boot([]);
  mergePage(s, 'v:inbox:*', { threads: [t('a', 1)], next: null, complete: true, pending: false }, false);
  applyMailBootstrap(s, undefined);
  expect(s.lists.size).toBe(0);
  expect(s.access.state).toBe('off');
});

test('the unread count for the rail, and sender lines', () => {
  const s = boot([t('a', 1, { unread: 2 }), t('b', 2, { unread: 1, roles: ['sent'] }), t('c', 3)]);
  expect(unreadInbox(s)).toBe(1);
  expect(senderLine(t('x', 1))).toBe('Sam Lee');
  expect(senderLine(t('x', 1, { from: [{ name: 'Alex Kim', email: 'a@x' }, { name: 'Jo Park', email: 'j@x' }, { name: null, email: 'me@x.org', self: true }] }))).toBe('Alex, Jo, me');
  expect(senderLine(t('x', 1, { from: [{ name: null, email: 'news@list.example' }] }))).toBe('news@list.example');
  expect(senderLine(t('x', 1, { from: ['A', 'B', 'C', 'D'].map((n) => ({ name: `${n} X`, email: `${n}@x` })) }))).toBe('A, …, C, D');
});

test('the outbox (slice 5): from the bootstrap, then the whole list in each event', () => {
  const s = emptyMail();
  const item = (id: string, state: P.MailOutboxView['state']): P.MailOutboxView => ({ id, clientId: `c-${id}`, accountId: ACC, subject: 'Hi', state, holdUntil: null, error: null });
  applyMailBootstrap(s, { access: { state: 'granted', managerUrl: null }, accounts: [account], mailboxes: [], threads: [], outbox: [item('mob_a', 'held')] });
  expect([...s.outbox.keys()]).toEqual(['mob_a']);
  expect(applyMailEvent(s, { t: 'mail.outbox', items: [item('mob_a', 'sent'), item('mob_b', 'failed')] })).toBe(true);
  expect([...s.outbox.values()].map((o) => `${o.id}:${o.state}`)).toEqual(['mob_a:sent', 'mob_b:failed']);
  applyMailEvent(s, { t: 'mail.outbox', items: [] });
  expect(s.outbox.size).toBe(0);
  // A hub from before slice 5 sends no outbox.
  applyMailBootstrap(s, { access: { state: 'granted', managerUrl: null }, accounts: [account], mailboxes: [], threads: [] });
  expect(s.outbox.size).toBe(0);
});

test('classification (slice 8): Inbox leaves bulk to its Updates row; People is Inbox from people; the dot counts people', () => {
  const news = (id: string, at: number, unread = 0, name = 'Rust Weekly') => t(id, at, { class: 'bulk', unread, from: [{ name, email: `${id}@news.example` }] });
  const s = boot([t('sam', 50, { class: 'personal', unread: 1 }), t('new', 45), news('n1', 40, 1), news('n2', 30, 0, 'GitHub'), news('n3', 20, 1, 'GitHub'), t('sent', 60, { class: 'personal', roles: ['sent'] })]);
  expect(ids(listThreads(s, 'v:inbox:*'))).toEqual(['sam', 'new']);
  expect(ids(listThreads(s, 'v:people:*'))).toEqual(['sam']);
  expect(ids(listThreads(s, 'v:updates:*'))).toEqual(['n1', 'n2', 'n3']);
  expect(updatesFold(s, 'v:inbox:*')).toEqual({ key: 'v:updates:*', count: 3, unread: 2, names: ['Rust Weekly', 'GitHub'], lastAt: 40 });
  expect(updatesFold(s, `v:inbox:${ACC}`)!.key).toBe(`v:updates:${ACC}`);
  expect(updatesFold(s, 'v:people:*')).toBeNull();
  expect(updatesFold(boot([t('sam', 1, { class: 'personal' })]), 'v:inbox:*')).toBeNull();
  // Unread from a person, or not classified yet; not the newsletters.
  expect(unreadInbox(s)).toBe(1);
  // A thread that changes class moves between them as events come.
  mergePage(s, 'v:inbox:*', { threads: listThreads(s, 'v:inbox:*'), next: null, complete: true, pending: false }, false);
  applyMailEvent(s, { t: 'mail.threads', threads: [t('sam', 50, { class: 'bulk', unread: 1 })], removed: [] });
  expect(ids(listThreads(s, 'v:inbox:*'))).toEqual(['new']);
  expect(updatesFold(s, 'v:inbox:*')!.count).toBe(4);
});

test('accountTrouble: any problem is left unsaid for its first seconds; lost access is said at once', () => {
  const now = 10_000_000;
  const acc = (x: Partial<P.MailAccountView>) => ({ level: 'read', problem: null, ...x }) as P.MailAccountView;
  const waiting = (since: number) => acc({ problem: { layer: 'browser', message: 'browser: starting', state: 'waiting', since } });
  expect(accountTrouble(acc({}), now)).toEqual({ message: null, at: null });
  expect(accountTrouble(waiting(now - 2_000), now)).toEqual({ message: null, at: now - 2_000 + PROBLEM_GRACE_MS });
  expect(accountTrouble(waiting(now - PROBLEM_GRACE_MS - 1), now).message).toBe('browser: starting');
  expect(accountTrouble(acc({ problem: { layer: 'x', message: 'x failed', state: 'failed', since: now } }), now).message).toBeNull();
  expect(accountTrouble(acc({ problem: { layer: 'x', message: 'x failed', state: 'failed', since: now - PROBLEM_GRACE_MS } }), now).message).toBe('x failed');
  expect(accountTrouble(acc({ problem: { layer: null, message: 'Sign in' } }), now).message).toBe('Sign in');
  expect(accountTrouble(acc({ level: null }), now).message).toContain('no longer has access');
});

test('a platform list: the threads of its accounts, by kind and address', () => {
  const s = emptyMail();
  const acc = (id: string, kind: string, address: string) => ({ id, kind, address, label: id, level: 'read', problem: null }) as unknown as P.MailAccountView;
  for (const a of [acc('acc_g1', 'imap', 'a@gmail.com'), acc('acc_g2', 'google', 'b@example.org'), acc('acc_p', 'proton', 'c@proton.me'), acc('acc_i', 'imap', 'd@example.org')]) s.accounts.set(a.id, a);
  scopeAccounts.of = (id) => s.accounts.get(id) ?? null;
  expect([...s.accounts.values()].map(mailPlatform)).toEqual(['gmail', 'gmail', 'proton', 'email']);
  const key = viewList('inbox', platformScope('gmail'));
  expect(parseMailList(key)).toEqual({ view: 'inbox', accountId: null, platform: 'gmail' });
  expect(parseMailList(viewList('inbox', 'acc_g1'))).toEqual({ view: 'inbox', accountId: 'acc_g1', platform: null });
  expect(['acc_g1', 'acc_g2', 'acc_p', 'acc_i'].filter((id) => inList(key, t(id, 1, { accountId: id })))).toEqual(['acc_g1', 'acc_g2']);
  expect(listTitle(s, key)).toBe('Inbox · Gmail');
});

test('Ranked: the scored threads first, by score, then the rest by date; Everything is all of Inbox', () => {
  const s = boot([
    t('new', 50),
    t('owed', 40, { class: 'personal' }),
    t('recent', 30, { class: 'personal' }),
    t('news', 45, { class: 'bulk' }),
    t('old', 10),
    t('sentonly', 60, { roles: ['sent'], mailboxIds: ['mbx_sent'], class: 'personal' }),
  ]);
  const view = (id: string, score: number): P.AttentionView => ({ id, kind: 'mail', score, needs: false, reasons: [], owedSince: null, at: 0 });
  // A chat's view and a thread not in Inbox (Sent only) are left out.
  const attention = [view('recent', 20), view('owed', 60), { ...view('conv_x', 99), kind: undefined }, view('sentonly', 90)];
  const r = rankedThreads(s, 'v:inbox:*', attention, null);
  expect(ids(r.threads)).toEqual(['owed', 'recent', 'new', 'old']);
  expect(r.head).toBe(2);
  // The inbox's snapshot holds the order until it is taken again: a new score moves nothing yet; a newly scored one goes after.
  const snap = { keys: ['conv_y', 'owed', 'recent'] };
  expect(ids(rankedThreads(s, 'v:inbox:*', [view('recent', 80), view('owed', 60), view('new', 70)], snap).threads)).toEqual(['owed', 'recent', 'new', 'old']);
  // Paged by date underneath: a loaded list's tail is its pages, whatever is ranked.
  mergePage(s, 'v:inbox:*', { threads: [t('new', 50), t('owed', 40, { class: 'personal' })], next: '40:owed', complete: false, pending: false }, false);
  expect(ids(rankedThreads(s, 'v:inbox:*', attention, null).threads)).toEqual(['owed', 'recent', 'new']);
  // One account's: only its threads.
  expect(rankedThreads(s, 'v:inbox:acc_other', attention, null).head).toBe(0);
  // Only Inbox ranks; Everything holds the bulk too, newest first.
  expect([rankable('v:inbox:*'), rankable(`v:inbox:${ACC}`), rankable('v:all:*'), rankable('v:updates:*'), rankable('mb:mbx_in')]).toEqual([true, true, false, false, false]);
  expect(ids(listThreads(s, 'v:all:*'))).toEqual(['new', 'news', 'owed', 'recent', 'old']);
  expect(listTitle(s, 'v:all:*')).toBe('Everything');
});
