/**
 * Big mailboxes on the page (mail/model.ts, slice 2): a page the hub is still fetching, threads that arrive meanwhile,
 * lists made stale by a backfill, the end of what can be fetched, and the progress line.
 */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { applyMailBootstrap, applyMailEvent, cursorOf, emptyMail, hasMore, listThreads, mergePage, syncLine } from '../src/mail/model.ts';

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
  mailboxIds: ['mbx_arc'],
  roles: ['archive'],
  labels: [],
  class: null,
  unknown: false,
  personIds: [],
  lastFromMe: false,
  owedSince: null,
  muted: false,
  ...x,
});
const acc = (sync: P.MailAccountView['sync'], id = ACC): P.MailAccountView => ({ id, kind: 'imap', label: 'a', address: 'me@x.org', name: null, color: '#fff', level: 'write', dryRun: false, online: true, problem: null, send: { ok: null, why: null }, sync, managedUrl: null, deleteAt: null });
const boot = () => {
  const s = emptyMail();
  applyMailBootstrap(s, { access: { state: 'granted', managerUrl: null }, accounts: [acc({ phase: 'idle', synced: 0, oldest: null })], mailboxes: [], threads: [] });
  return s;
};
const page = (threads: P.MailThreadView[], x: Partial<P.MailThreadPage> = {}): P.MailThreadPage => ({ threads, next: null, complete: false, pending: false, ...x });
const KEY = 'mb:mbx_arc';
const ids = (s: ReturnType<typeof boot>) => listThreads(s, KEY).map((x) => x.id);

test('a page the hub is still fetching: the threads it sends meanwhile go in where they sort, and the next answer joins them', () => {
  const s = boot();
  mergePage(s, KEY, page([t('c', 30), t('b', 20)], { next: '20:b' }), false);
  expect(hasMore(s.lists.get(KEY))).toBe(true);
  // Scrolled to the end: the hub had no more, asked the server, and answered before it came.
  mergePage(s, KEY, page([], { pending: true }), true);
  expect(s.lists.get(KEY)).toMatchObject({ pending: true, next: null });
  expect(hasMore(s.lists.get(KEY))).toBe(false);
  // The server's page arrives as mail.threads: older than everything loaded, and still placed.
  applyMailEvent(s, { t: 'mail.threads', threads: [t('a', 10), t('old', 5)], removed: [] });
  expect(ids(s)).toEqual(['c', 'b', 'a', 'old']);
  // The page asked again: what it brings joins in order, once.
  mergePage(s, KEY, page([t('old', 5), t('older', 2)], { next: '2:older' }), true);
  expect(ids(s)).toEqual(['c', 'b', 'a', 'old', 'older']);
  expect(s.lists.get(KEY)).toMatchObject({ pending: false, next: '2:older' });
});

test('past what the hub holds, the next page starts after the last thread; one that brings nothing stops the scroll', () => {
  const s = boot();
  mergePage(s, KEY, page([t('b', 20), t('a', 10)]), false);
  // No cursor from the hub, not complete: the server may have more.
  expect(hasMore(s.lists.get(KEY))).toBe(true);
  expect(cursorOf(listThreads(s, KEY).at(-1)!)).toBe('10:a');
  mergePage(s, KEY, page([]), true);
  expect(s.lists.get(KEY)!.dry).toBe(true);
  expect(hasMore(s.lists.get(KEY))).toBe(false);
  // Loading it again starts afresh.
  mergePage(s, KEY, page([t('b', 20), t('a', 10)]), false);
  expect(hasMore(s.lists.get(KEY))).toBe(true);
  // All of it is here: nothing to ask for.
  mergePage(s, KEY, page([t('b', 20)], { complete: true }), false);
  expect(hasMore(s.lists.get(KEY))).toBe(false);
});

test('mail.lists marks loaded lists stale; they keep showing what they have until they load again', () => {
  const s = boot();
  mergePage(s, KEY, page([t('b', 20), t('a', 10)], { next: '10:a' }), false);
  applyMailEvent(s, { t: 'mail.lists', stale: [KEY, 'v:inbox:*'] });
  expect(s.lists.get(KEY)).toMatchObject({ stale: true, loaded: true });
  expect(ids(s)).toEqual(['b', 'a']);
  // A list never loaded has nothing to mark.
  expect(s.lists.has('v:inbox:*')).toBe(false);
  mergePage(s, KEY, page([t('c', 30), t('b', 20)], { next: '20:b' }), false);
  expect(s.lists.get(KEY)!.stale).toBe(false);
});

test('the progress line: the first sync, the backfill going back, a refresh, then nothing', () => {
  const now = Date.UTC(2026, 10, 8);
  expect(syncLine([acc({ phase: 'idle', synced: 9, oldest: 1 })], now)).toBeNull();
  expect(syncLine([acc({ phase: 'first', synced: 50, oldest: null })], now)).toBe('Syncing · 50');
  const line = syncLine([acc({ phase: 'backfill', synced: 12_400, oldest: Date.UTC(2026, 2, 3) }), acc({ phase: 'idle', synced: 100, oldest: Date.UTC(2020, 0, 1) }, 'acc_b')], now)!;
  expect(line).toStartWith(`Syncing older mail · ${(12_400).toLocaleString()}, back to `);
  expect(line).not.toContain('2026');
  expect(syncLine([acc({ phase: 'backfill', synced: 1, oldest: Date.UTC(2025, 2, 3) })], now)).toContain('2025');
  expect(syncLine([acc({ phase: 'relist', synced: 1, oldest: null })], now)).toBe('Refreshing…');
});
