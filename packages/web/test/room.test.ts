/**
 * The room's zones (room.ts): speakers, the audience in its order, hands oldest first, your role, the counts (a big
 * room's own listener count), the searchable audience list; a call with no stage is all speakers.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { audienceList, requestsOf, roomCounts, roomOf } from '../src/room.ts';

const p = (id: string, stage?: P.StageRole, extra: Partial<P.CallParticipant> = {}): P.CallParticipant => ({ id, muted: false, deafened: false, speaking: false, ...(stage ? { stage } : {}), ...extra });
const me = (id: string) => id === 'me';

describe('room zones', () => {
  test('a stage: speakers on top, you first in the audience, then hands, invited, the rest', () => {
    const people = [p('a', 'audience'), p('s1', 'speaker'), p('h1', 'hand'), p('me', 'audience'), p('i1', 'invited'), p('h2', 'hand'), p('s2', 'speaker')];
    const r = roomOf(people, me, { topic: 'T' });
    expect(r.staged).toBe(true);
    expect(r.speakers.map((x) => x.id)).toEqual(['s1', 's2']);
    expect(r.audience.map((x) => x.id)).toEqual(['me', 'h1', 'h2', 'i1', 'a']);
    expect(r.hands.map((x) => x.id)).toEqual(['h1', 'h2']);
    expect(r.me).toBe('audience');
    expect(roomCounts(r)).toBe('2 speakers · 5 listening');
  });

  test('hands go oldest first, where they say when they went up', () => {
    const people = [p('late', 'hand', { askedAt: 300 }), p('none', 'hand'), p('early', 'hand', { askedAt: 100 }), p('me', 'hand', { askedAt: 50 })];
    const r = roomOf(people, me, { topic: null });
    expect(r.hands.map((x) => x.id)).toEqual(['me', 'early', 'late', 'none']);
    expect(r.audience.map((x) => x.id)).toEqual(['me', 'early', 'late', 'none']);
    // The requests a moderator answers: never their own hand.
    expect(requestsOf(people, me).map((x) => x.id)).toEqual(['early', 'late', 'none']);
  });

  test("a big room's count is its own: a Space sends a sample of its listeners", () => {
    const r = roomOf([p('s', 'speaker'), p('a', 'audience'), p('b', 'audience')], me, { topic: null, listeners: 4210 });
    expect(r.listening).toBe(4210);
    expect(roomCounts(r)).toBe('1 speaker · 4,210 listening');
    // A count behind the people sent never shows fewer than are here.
    expect(roomOf([p('a', 'audience'), p('b', 'audience')], me, { topic: null, listeners: 1 }).listening).toBe(2);
  });

  test('your role follows the state; someone without one is in the audience', () => {
    expect(roomOf([p('me', 'hand')], me, { topic: null }).me).toBe('hand');
    expect(roomOf([p('x')], () => false, { topic: null }).audience.map((x) => x.id)).toEqual(['x']);
  });

  test('a stage still on its way is a stage: no flash of a plain call while it connects', () => {
    const r = roomOf([], me, undefined, true);
    expect(r).toMatchObject({ staged: true, me: 'audience', speakers: [], audience: [] });
    expect(roomCounts(r)).toBe('0 speakers · 0 listening');
  });

  test('a call without a stage is a room where everyone speaks', () => {
    const r = roomOf([p('a'), p('me')], me, undefined);
    expect(r).toMatchObject({ staged: false, me: 'speaker', audience: [], hands: [] });
    expect(r.speakers).toHaveLength(2);
    expect(roomCounts(r)).toBe('2 people');
  });
});

describe('the whole audience', () => {
  const names: Record<string, string> = { a: 'Amaru', b: 'Bex', c: 'Calla', d: 'Dov' };
  const nameOf = (id: string) => names[id]!;
  const audience = ['a', 'b', 'c', 'd'].map((id) => p(id, 'audience'));

  test('people you know first, then as the room has them', () => {
    const known = (id: string) => (id === 'c' ? 2 : id === 'd' ? 1 : 0);
    expect(audienceList(audience, '', nameOf, known).map((x) => x.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  test('a search finds a name in any case, anywhere in it', () => {
    expect(audienceList(audience, ' A ', nameOf, () => 0).map((x) => x.id)).toEqual(['a', 'c']);
    expect(audienceList(audience, 'zz', nameOf, () => 0)).toEqual([]);
  });
});
