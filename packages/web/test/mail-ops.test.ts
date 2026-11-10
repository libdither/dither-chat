/** Where filing puts a thread on the page before the hub answers (mail/filing.ts), and where Undo takes it back. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { archivedInAll, destinationIn, movedView, moveTargetsIn, undoTarget } from '../src/mail/filing.ts';

const box = (id: string, role: P.MailboxRole | null, accountId = 'acc_a', path = id): P.MailboxView => ({ id, accountId, name: path, path, parentId: null, role, unread: null, total: null, followed: false });
const imap = new Map(
  [box('in', 'inbox'), box('sent', 'sent'), box('arch', 'archive'), box('junk', 'junk'), box('trash', 'trash'), box('work', null, 'acc_a', 'Work'), box('other-in', 'inbox', 'acc_b')].map((b) => [b.id, b]),
);
const gmail = new Map([box('g-in', 'inbox', 'acc_g'), box('g-all', 'all', 'acc_g'), box('g-sent', 'sent', 'acc_g'), box('g-trash', 'trash', 'acc_g')].map((b) => [b.id, b]));
const t = (mailboxIds: string[], boxes: ReadonlyMap<string, P.MailboxView> = imap, accountId = 'acc_a'): P.MailThreadView => ({
  id: 'mth_1',
  accountId,
  subject: 'Dinner',
  firstAt: 1,
  lastAt: 2,
  count: 3,
  unread: 0,
  flagged: false,
  attachments: false,
  from: [],
  participants: 2,
  preview: null,
  mailboxIds,
  roles: mailboxIds.map((id) => boxes.get(id)!.role!).filter(Boolean),
  labels: [],
  class: null,
  unknown: false,
  personIds: [],
  lastFromMe: false,
  owedSince: null,
  muted: false,
});

test('archive leaves Inbox; trash and junk leave all but Sent; a folder leaves the folders', () => {
  expect(movedView(imap, t(['in', 'sent']), 'archive')).toMatchObject({ mailboxIds: ['sent', 'arch'], roles: ['sent', 'archive'] });
  expect(movedView(imap, t(['in', 'sent', 'work']), 'trash')).toMatchObject({ mailboxIds: ['sent', 'trash'], roles: ['sent', 'trash'] });
  expect(movedView(imap, t(['in']), 'junk')!.roles).toEqual(['junk']);
  expect(movedView(imap, t(['arch', 'sent']), 'inbox')!.roles).toEqual(['sent', 'inbox']);
  expect(movedView(imap, t(['in']), 'work')).toMatchObject({ mailboxIds: ['work'], roles: [] });
});

test('Gmail: archive is All mail, which stays', () => {
  expect(destinationIn(gmail, t(['g-in', 'g-all'], gmail, 'acc_g'), 'archive')!.id).toBe('g-all');
  expect(movedView(gmail, t(['g-in', 'g-all'], gmail, 'acc_g'), 'archive')!.roles).toEqual(['all']);
  expect(movedView(gmail, t(['g-in', 'g-all'], gmail, 'acc_g'), 'junk')).toBeNull();
});

test('a mailbox of another account, or none of that kind: nothing to show', () => {
  expect(destinationIn(imap, t(['in']), 'other-in')).toBeUndefined();
  expect(movedView(imap, t(['in']), 'nope')).toBeNull();
});

test('Move to… lists the account’s folders, Inbox first, not the one it is only in', () => {
  expect(moveTargetsIn(imap, t(['work'])).map((b) => b.id)).toEqual(['in', 'arch', 'junk', 'trash']);
  expect(moveTargetsIn(imap, t(['in', 'sent'])).map((b) => b.id)).toEqual(['in', 'arch', 'junk', 'trash', 'work']);
});

test('Undo: back to Inbox, else to the folder it was in', () => {
  expect(undoTarget(imap, t(['in', 'sent']), 'archive')).toBe('inbox');
  expect(undoTarget(imap, t(['work']), 'trash')).toBe('work');
  expect(undoTarget(imap, t(['arch']), 'inbox')).toBe('arch');
  expect(undoTarget(gmail, t(['g-all'], gmail, 'acc_g'), 'trash')).toBeNull();
});

test('Gmail: Move to Inbox from All Mail is a copy there, so its labels stay; its Undo archives; Important is no folder', () => {
  const g = new Map([...gmail, ...[box('g-work', null, 'acc_g', 'Work'), box('g-imp', 'important', 'acc_g', '[Gmail]/Important')].map((b) => [b.id, b] as const)]);
  const archived = t(['g-all', 'g-work', 'g-imp'], g, 'acc_g');
  expect(archivedInAll(g, archived)).toBe(true);
  expect(archivedInAll(g, t(['g-in', 'g-all'], g, 'acc_g'))).toBe(false);
  expect(archivedInAll(g, t(['g-trash'], g, 'acc_g'))).toBe(false);
  // An account with an Archive (Proton's All mail too): archived means in Archive.
  const withAll = new Map([...imap, ['all', box('all', 'all')] as const]);
  expect(archivedInAll(withAll, t(['all', 'work'], withAll))).toBe(false);
  expect(movedView(g, archived, 'inbox')).toMatchObject({ mailboxIds: ['g-all', 'g-work', 'g-imp', 'g-in'], roles: ['all', 'important', 'inbox'] });
  expect(undoTarget(g, archived, 'inbox')).toBe('archive');
  expect(moveTargetsIn(g, archived).map((b) => b.id)).toEqual(['g-in', 'g-trash', 'g-work']);
});
