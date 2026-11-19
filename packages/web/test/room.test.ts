/** The room's zones (room.ts): speakers, the audience in its order, hands, your role; a call with no stage is all speakers. */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { roomCounts, roomOf } from '../src/room.ts';

const p = (id: string, stage?: P.StageRole): P.CallParticipant => ({ id, muted: false, deafened: false, speaking: false, ...(stage ? { stage } : {}) });

describe('room zones', () => {
  test('a stage: speakers on top, you first in the audience, then hands, invited, the rest', () => {
    const people = [p('a', 'audience'), p('s1', 'speaker'), p('h1', 'hand'), p('me', 'audience'), p('i1', 'invited'), p('h2', 'hand'), p('s2', 'speaker')];
    const r = roomOf(people, (id) => id === 'me', { topic: 'T', moderator: true });
    expect(r.staged).toBe(true);
    expect(r.speakers.map((x) => x.id)).toEqual(['s1', 's2']);
    expect(r.audience.map((x) => x.id)).toEqual(['me', 'h1', 'h2', 'i1', 'a']);
    expect(r.hands.map((x) => x.id)).toEqual(['h1', 'h2']);
    expect(r.me).toBe('audience');
    expect(r.moderator).toBe(true);
    expect(roomCounts(r)).toBe('2 speaking · 5 listening');
  });

  test('your role follows the state; someone without one is in the audience', () => {
    expect(roomOf([p('me', 'hand')], (id) => id === 'me', { topic: null, moderator: false }).me).toBe('hand');
    expect(roomOf([p('x')], () => false, { topic: null, moderator: false }).audience.map((x) => x.id)).toEqual(['x']);
  });

  test('a call without a stage is a room where everyone speaks', () => {
    const r = roomOf([p('a'), p('me')], (id) => id === 'me');
    expect(r).toMatchObject({ staged: false, me: 'speaker', audience: [], hands: [] });
    expect(r.speakers).toHaveLength(2);
    expect(roomCounts(r)).toBe('2 people');
  });
});
