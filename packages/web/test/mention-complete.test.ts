/**
 * The composer's @ picker without a DOM (docs/mentions.md): when an `@` opens it (mentionComplete.ts), and its rows
 * (mentionRows.ts): this device's at once, ordered by how the name matches then who spoke last, and the hub's answer
 * merged in.
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { findMentionTrigger } from '../src/mentionComplete.ts';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { cleanQuery, localRows, matchTier, mergeRows } = await import('../src/mentionRows.ts');
const { timelines } = (await import('../src/state.ts')) as unknown as { timelines: Map<string, { messages: Partial<P.MessageView>[] }> };

const at = (s: string) => findMentionTrigger(s, s.length);

test('an @ opens it at the start, after a space or an opening bracket, with nothing typed yet', () => {
  expect(at('@')).toEqual({ start: 0, end: 1, query: '' });
  expect(at('hi @al')).toEqual({ start: 3, end: 6, query: 'al' });
  expect(at('line\n@bo')?.query).toBe('bo');
  expect(at('(@bo')?.query).toBe('bo');
  expect(at('> @quinn.dev')?.query).toBe('quinn.dev');
  // A Matrix id as typed.
  expect(at('@alice:matrix.org')?.query).toBe('alice:matrix.org');
});

test('a mail address, a written mention, code, a URL and a finished name do not', () => {
  expect(at('me@host')).toBeNull();
  expect(at('write to me@example.com')).toBeNull();
  expect(at('<@123')).toBeNull();
  expect(at('`@x')).toBeNull();
  expect(at('```\n@x')).toBeNull();
  expect(at('see https://example.com/@user')).toBeNull();
  expect(at('@quinn ')).toBeNull();
  expect(at('@@x')).toBeNull();
  expect(at('@' + 'a'.repeat(33))).toBeNull();
  // The caret, not the end of the text, is where it looks.
  expect(findMentionTrigger('hi @al there', 6)).toEqual({ start: 3, end: 6, query: 'al' });
});

test('names match as the hub matches them', () => {
  expect(matchTier(['Quinn'], 'quinn')).toBe(4);
  expect(matchTier(['Quinn'], 'qu')).toBe(3);
  expect(matchTier(['Sam Rivera'], 'riv')).toBe(2);
  expect(matchTier(['pixelfox'], 'fox')).toBe(1);
  expect(matchTier(['Lev'], 'x')).toBe(0);
  expect(matchTier(['Lev'], '')).toBe(1);
  expect(cleanQuery('@Qu ')).toBe('qu');
});

const ident = (id: string, displayName: string, x: Partial<P.IdentityView> = {}): P.IdentityView => ({ id, network: 'discord', nativeId: `n-${id}`, handle: displayName.toLowerCase(), displayName, avatar: null, isBot: false, personId: null, ...x });

test("this device's rows: the people in it and who wrote in what is loaded, best match first, then who spoke last", () => {
  for (const i of [ident('a', 'Alice'), ident('l', 'Lev'), ident('q', 'Quinn'), ident('b', 'build-bot', { isBot: true })]) db.identities.set(i.id, i);
  db.persons.set('p', { id: 'p', name: 'Alice Chen', avatar: null, starred: false, isSelf: false, identityIds: ['a'], nameSource: 'account' } as unknown as P.PersonView);
  db.identities.set('a', ident('a', 'Alice', { personId: 'p' }));
  db.conversations.set('c', { id: 'c', network: 'discord', shape: 'group', participantIds: ['a', 'l'] } as unknown as P.ConversationView);
  timelines.set('c:c', {
    messages: [
      { authorId: 'q', ts: 300, kind: 'text', deleted: false },
      { authorId: 'l', ts: 200, kind: 'text', deleted: false },
      { authorId: 'b', ts: 100, kind: 'text', deleted: false },
      { authorId: 'b', ts: 400, kind: 'system', deleted: false },
    ],
  });
  const all = localRows('c', '');
  expect(all.map((r) => r.name)).toEqual(['Quinn', 'Lev', 'build-bot', 'Alice Chen']);
  expect(all[0]).toMatchObject({ kind: 'identity', insert: '<@n-q> ', pings: true, section: 'here', identityId: 'q', network: 'discord' });
  // The person's name stands for the account, and the account's own name still finds them.
  expect(localRows('c', 'ali').map((r) => r.name)).toEqual(['Alice Chen']);
  expect(localRows('c', 'chen').map((r) => r.name)).toEqual(['Alice Chen']);
  expect(localRows('c', 'bot')[0]).toMatchObject({ name: 'build-bot', isBot: true });
  expect(localRows('nowhere', '')).toEqual([]);
});

test("the hub's answer replaces this device's rows, unless the network did not answer: then the rows it left out stay", () => {
  const row = (name: string): P.MentionRow => ({ kind: 'identity', insert: `<@${name}> `, pings: true, section: 'here', name });
  const local = [row('Lev'), row('Quinn')];
  const hub: P.MentionablesView = { rows: [row('Quinn'), row('quin_dev')] };
  expect(mergeRows(hub, local).map((r) => r.name)).toEqual(['Quinn', 'quin_dev']);
  expect(mergeRows({ ...hub, partial: true }, local).map((r) => r.name)).toEqual(['Quinn', 'quin_dev', 'Lev']);
});
