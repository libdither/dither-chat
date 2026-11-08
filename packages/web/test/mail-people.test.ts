/** "All mail with Sam" (mail/model.ts, slice 6): a `w:` list's heading, and which changed threads belong in it. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { parseWithList, viewList, withList } from '@dither-chat/protocol';
import { emptyMail, inList, listTitle, mailNames } from '../src/mail/model.ts';

const t = (x: Partial<P.MailThreadView>): P.MailThreadView => ({
  id: 'mth_1',
  accountId: 'acc_a',
  subject: 'Dinner',
  firstAt: 1,
  lastAt: 1,
  count: 1,
  unread: 0,
  flagged: false,
  attachments: false,
  from: [],
  participants: 2,
  preview: null,
  mailboxIds: ['mbx_sent'],
  roles: ['sent'],
  labels: [],
  class: null,
  unknown: false,
  personIds: [],
  lastFromMe: false,
  owedSince: null,
  muted: false,
  ...x,
});

test('a with-list key names a person, an identity or an address; no other key does', () => {
  expect(parseWithList(withList('per_sam'))).toBe('per_sam');
  expect(parseWithList(withList('sam@lee.example'))).toBe('sam@lee.example');
  expect(parseWithList(viewList('inbox'))).toBeNull();
  expect(parseWithList('w:')).toBeNull();
});

test('a thread is in it by its people, wherever it is filed; your own messages do not count', () => {
  const sam = t({ from: [{ name: 'Sam', email: 'sam@lee.example', identityId: 'idn_sam', personId: 'per_sam' }] });
  expect(inList(withList('per_sam'), sam)).toBe(true);
  expect(inList(withList('idn_sam'), sam)).toBe(true);
  expect(inList(withList('Sam@Lee.example'), sam)).toBe(true);
  // Only a recipient of yours: the person on it says so.
  expect(inList(withList('per_jo'), t({ personIds: ['per_jo'], from: [{ name: 'me', email: 'me@x.org', self: true }] }))).toBe(true);
  expect(inList(withList('me@x.org'), t({ from: [{ name: 'me', email: 'me@x.org', self: true }] }))).toBe(false);
  expect(inList(withList('per_jo'), sam)).toBe(false);
});

test('its heading names who it is with, by the page’s people', () => {
  const s = emptyMail();
  expect(listTitle(s, withList('sam@lee.example'))).toBe('Mail with sam@lee.example');
  const was = mailNames.of;
  mailNames.of = (who) => (who === 'per_sam' ? 'Sam Lee' : null);
  try {
    expect(listTitle(s, withList('per_sam'))).toBe('Mail with Sam Lee');
  } finally {
    mailNames.of = was;
  }
  expect(listTitle(s, viewList('inbox'))).toBe('Inbox');
});
