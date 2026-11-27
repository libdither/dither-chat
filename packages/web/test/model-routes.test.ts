/**
 * src/model.ts: a person's email routes (mail/chats.ts) are among their directs, and a mail change moves only
 * `mailDataVersion`, not `placesDataVersion`. The memos that read the routes (directs, people, the inbox's rows) follow
 * a route that arrives or changes, and keep their value through a mail change that leaves the routes as they were.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { emptyDb } from '../src/syncmodel.ts';
import { db as store } from '../src/store.ts';
import { changed, flush, mailChanged } from '../src/versions.ts';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
// mail/chats.ts reads the store itself, not the mocked state.ts.
const mail = store.mail;
const M = await import('../src/model.ts');
afterAll(() => flush());

const dm = (id: string, person: string, at: number) =>
  ({ id, network: 'discord', nativeId: id, shape: 'direct', variant: 'text', name: null, topic: null, avatar: null, encrypted: false, archived: false, parentId: null, spaceIds: [], participantIds: [], peerPersonId: person, vantages: [{ accountId: 'acc1', unread: 0, mentions: 0, lastReadTs: null }], lastMessage: null, lastMessageAt: at, nativeMute: null }) as unknown as P.ConversationView;
const route = (person: string, at: number) =>
  ({ id: `email:mail1:${person}@x.example`, accountId: 'mail1', address: `${person}@x.example`, personId: person, identityId: `idn_${person}`, subject: 'Hello', unread: 1, preview: 'hi', lastFromMe: false, lastAt: at }) as unknown as P.MailChatView;

test("a route that arrives, changes or goes is in that person's directs, people and who has a chat at once", () => {
  Object.assign(db, emptyDb());
  db.accounts.set('acc1', { id: 'acc1', network: 'discord', label: 'acc1' } as unknown as P.AccountView);
  mail.accounts.set('mail1', { id: 'mail1' } as unknown as P.MailAccountView);
  db.persons.set('p1', { id: 'p1', name: 'Ann', isSelf: false } as unknown as P.PersonView);
  db.conversations.set('c1', dm('c1', 'p1', 100));
  changed('meta');

  expect(M.directsOf('p1').map((c) => c.id)).toEqual(['c1']);
  expect(M.people()[0]?.last).toBe(100);
  const ps = M.people();
  expect(M.chatPersonOf(db.conversations.get('c1'))).toBeNull();

  // Mail moved and the routes did not (a rung, a thread's flags): nothing is worked out again.
  mailChanged();
  expect(M.people()).toBe(ps);

  mail.chats.set(route('p1', 0).id, route('p1', 200));
  mailChanged();
  expect(M.directsOf('p1').map((c) => c.id)).toEqual([route('p1', 0).id, 'c1']);
  expect(M.people()[0]?.last).toBe(200);
  // Mail with them makes their DM a chat.
  expect(M.chatPersonOf(db.conversations.get('c1'))?.id).toBe('p1');

  mail.chats.set(route('p1', 0).id, route('p1', 50));
  mailChanged();
  expect(M.directsOf('p1').map((c) => c.id)).toEqual(['c1', route('p1', 0).id]);
  expect(M.people()[0]?.last).toBe(100);

  mail.chats.delete(route('p1', 0).id);
  mailChanged();
  expect(M.directsOf('p1').map((c) => c.id)).toEqual(['c1']);
  expect(M.chatPersonOf(db.conversations.get('c1'))).toBeNull();
});
