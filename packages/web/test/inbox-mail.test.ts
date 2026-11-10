/**
 * The one-list inbox with mail in it (docs/mail.md, slice 8): the mail rows the page makes of the hub's attention
 * (mail/model.ts mailInboxRows), ranked with the chats as one (ordering.ts), the filter on both kinds (filterKeeps),
 * and the open thread keeping its place. model.ts and inbox.ts put these together; scripts/verify-inbox.ts checks that
 * in a browser.
 */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { emptyMail, mailInboxRows } from '../src/mail/model.ts';
import { filterKeeps, inboxSections, inboxSnapshot, inboxView, rank, type Ranked } from '../src/ordering.ts';

type Chipped = { direct: boolean; unread: boolean; mail: boolean };

const NOW = 1_800_000_000_000;
const thread = (id: string, at: number, o: Partial<P.MailThreadView> = {}): P.MailThreadView => ({
  id,
  accountId: 'acc_mail',
  subject: id,
  firstAt: at,
  lastAt: at,
  count: 1,
  unread: 0,
  flagged: false,
  attachments: false,
  from: [{ name: 'Sam', email: 'sam@x.example' }],
  participants: 2,
  preview: null,
  mailboxIds: ['mbx_in'],
  roles: ['inbox'],
  labels: [],
  class: 'personal',
  unknown: false,
  personIds: [],
  lastFromMe: false,
  owedSince: null,
  muted: false,
  ...o,
});
const score = (id: string, s: number, kind?: 'mail'): P.AttentionView => ({ id, ...(kind ? { kind } : {}), score: s, needs: s >= 20, reasons: [`${s} points`], owedSince: null, at: NOW });

/** A world: two chats (a DM with something unread, a quiet group) and the hub's scores, with mail or without. */
function world(mail: boolean) {
  const s = emptyMail();
  if (mail) {
    s.accounts.set('acc_mail', { id: 'acc_mail' } as P.MailAccountView);
    s.threads.set('mth_sam', thread('mth_sam', NOW - 30_000, { unread: 1 }));
    s.threads.set('mth_lease', thread('mth_lease', NOW - 90_000, { participants: 3 }));
    s.threads.set('mth_other', thread('mth_other', NOW, { accountId: 'acc_gone' }));
  }
  const attention = [score('cnv_dm', 50), score('cnv_group', 10), score('mth_sam', 70, 'mail'), score('mth_lease', 30, 'mail'), score('mth_other', 90, 'mail'), score('mth_later', 95, 'mail')];
  const chats: (Ranked & Chipped)[] = [
    { key: 'cnv_dm', score: 50, last: NOW - 60_000, direct: true, unread: true, mail: false },
    { key: 'cnv_group', score: 10, last: NOW - 120_000, direct: false, unread: false, mail: false },
  ];
  const mailRows = mailInboxRows(attention, s);
  const rows: (Ranked & Chipped)[] = [...chats, ...mailRows.map((r) => ({ key: r.key, score: r.score, last: r.thread.lastAt, muted: r.thread.muted, direct: r.thread.participants <= 2, unread: r.thread.unread > 0, mail: true }))];
  return { s, attention, mailRows, rows };
}

test('with no mail account there are no mail rows, whatever the hub scored: the chats alone, as before', () => {
  const w = world(false);
  expect(w.mailRows).toEqual([]);
  expect(rank(w.rows)).toEqual(['cnv_dm', 'cnv_group']);
});

test('a mail row is a mail score with its thread at hand, of an account the page shows', () => {
  const w = world(true);
  expect(w.mailRows.map((r) => r.key)).toEqual(['mth_sam', 'mth_lease']);
  expect(w.mailRows[0]).toMatchObject({ key: 'mth_sam', score: 70, needs: true, reasons: ['70 points'], thread: { subject: 'mth_sam' } });
  // Its view came later (the next mail event): in.
  w.s.threads.set('mth_later', thread('mth_later', NOW));
  expect(mailInboxRows(w.attention, w.s).map((r) => r.key)).toEqual(['mth_sam', 'mth_lease', 'mth_later']);
});

test('chats and mail rank as one by the hub’s score; muted mail sinks with muted chats', () => {
  const w = world(true);
  expect(rank(w.rows)).toEqual(['mth_sam', 'cnv_dm', 'mth_lease', 'cnv_group']);
  const muted = w.rows.map((r) => (r.key === 'mth_sam' ? { ...r, muted: true } : r));
  expect(rank(muted)).toEqual(['cnv_dm', 'mth_lease', 'cnv_group', 'mth_sam']);
});

test('the filter: Direct messages and Groups are chats, Mail is mail; New holds what is unread of both kinds', () => {
  const w = world(true);
  const shown = (f: 'all' | 'direct' | 'groups' | 'mail') => inboxView(null, w.rows, (k) => filterKeeps(f, w.rows.find((r) => r.key === k)!));
  expect(shown('all')).toEqual(['mth_sam', 'cnv_dm', 'mth_lease', 'cnv_group']);
  expect(shown('direct')).toEqual(['cnv_dm']);
  expect(shown('groups')).toEqual(['cnv_group']);
  expect(shown('mail')).toEqual(['mth_sam', 'mth_lease']);
  const snap = inboxSnapshot(w.rows);
  expect(inboxSections(inboxView(snap, w.rows), snap, () => ({ unread: false, waiting: false })).new).toEqual(['mth_sam', 'cnv_dm']);
});

test('a mail thread open in the inbox keeps its place while it is open; new rows go after the order taken', () => {
  const w = world(true);
  const snap = inboxSnapshot(w.rows.map((r) => ({ ...r })));
  expect(snap.keys[0]).toBe('mth_sam');
  expect(snap.unread).toEqual(['cnv_dm', 'mth_sam']);
  // Read: its score falls under the DM's, but it stays first while it is open.
  const read = w.rows.map((r) => (r.key === 'mth_sam' ? { ...r, score: 20, unread: false } : r));
  expect(inboxSnapshot(read, { key: 'mth_sam', prev: snap }).keys).toEqual(['mth_sam', 'cnv_dm', 'mth_lease', 'cnv_group']);
  expect(inboxSnapshot(read).keys).toEqual(['cnv_dm', 'mth_lease', 'mth_sam', 'cnv_group']);
  // A new mail row between snapshots shows after what the snapshot holds.
  const more = [...read, { key: 'mth_new', score: 99, last: NOW, direct: true, unread: true }];
  expect(inboxView(snap, more)).toEqual(['mth_sam', 'cnv_dm', 'mth_lease', 'cnv_group', 'mth_new']);
});
