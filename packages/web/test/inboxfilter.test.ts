/** The inbox narrowed by its box as you type (inboxfilter.ts; docs/search.md "In the inbox"). */
import { describe, expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import type { InboxRow } from '../src/model.ts';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { filterRows, hasOperators, namesMatch, rowNames, rowStandsFor, typedWords } = await import('../src/inboxfilter.ts');

describe('the inbox narrowed by its box', () => {
  test('every word typed starts a word of a name', () => {
    expect(namesMatch(['Sam Rivera'], ['sa', 'ri'])).toBe(true);
    expect(namesMatch(['Sam Rivera'], ['riv'])).toBe(true);
    expect(namesMatch(['Sam Rivera'], ['am'])).toBe(false);
    expect(namesMatch(['Sam Rivera'], ['sam', 'x'])).toBe(false);
    // Words may come from different names: a person's name and their handle.
    expect(namesMatch(['Sam Rivera', 'samr_99'], ['rivera', 'samr'])).toBe(true);
    // A channel's # and a community's dots are not part of its words.
    expect(namesMatch(['#speedruns', 'Rust · showcase'], ['speed'])).toBe(true);
    expect(namesMatch(['#speedruns', 'Rust · showcase'], ['show'])).toBe(true);
  });

  test('scripts without spaces are found anywhere in a name', () => {
    expect(namesMatch(['山田太郎'], ['太郎'])).toBe(true);
    expect(namesMatch(['山田太郎'], ['花子'])).toBe(false);
  });

  test('the words are the plain ones, operators left out, case ignored', () => {
    expect(typedWords('Sam  "Rivera Jr"')).toEqual(['rivera', 'jr', 'sam']);
    expect(typedWords('from:alice lunch')).toEqual(['lunch']);
    expect(hasOperators('from:alice lunch')).toBe(true);
    expect(hasOperators('lunch at 3:30')).toBe(false);
    expect(hasOperators('lunch')).toBe(false);
  });

  test('the rows keep the inbox order; no words keeps them all', () => {
    const rows = ['Sam Rivera', 'Family', 'Sofia', 'Alice Chen'].map((n) => ({ key: n }) as unknown as InboxRow);
    const names = (r: InboxRow) => [r.key];
    expect(filterRows(rows, 's', names).map((r) => r.key)).toEqual(['Sam Rivera', 'Sofia']);
    expect(filterRows(rows, 'c', names).map((r) => r.key)).toEqual(['Alice Chen']);
    expect(filterRows(rows, '  ', names)).toHaveLength(4);
    expect(filterRows(rows, 'from:sam', names)).toHaveLength(4);
  });

  test('a direct chat is found by its person’s other names and handles, and stands for them', () => {
    db.identities.set('i1', { id: 'i1', network: 'discord', handle: 'samr_99', displayName: 'samr', nickname: null, personId: 'p1' } as unknown as P.IdentityView);
    db.persons.set('p1', { id: 'p1', name: 'Sam Rivera', identityIds: ['i1'], isSelf: false } as unknown as P.PersonView);
    const conv = { id: 'c1', network: 'discord', shape: 'direct', peerPersonId: 'p1', participantIds: ['i1'], spaceIds: [] } as unknown as P.ConversationView;
    const row = { kind: 'conv', key: 'c1', conv } as unknown as InboxRow;
    expect(namesMatch(rowNames(row), typedWords('samr_'))).toBe(true);
    expect(namesMatch(rowNames(row), typedWords('rive'))).toBe(true);
    expect([...rowStandsFor([row])].sort()).toEqual(['c1', 'p1']);
  });
});
