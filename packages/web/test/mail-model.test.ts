/** The page's copy of mail (mail/model.ts): bootstrap, events, lists kept in order, sender lines. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { applyMailBootstrap, applyMailEvent, emptyMail, inList, listThreads, mergePage, senderLine, unreadInbox, updatesFold } from '../src/mail/model.ts';

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
