import { expect, test } from 'bun:test';
import { directTarget, guessDirectNetwork } from '../src/direct.ts';

test('a typed address says which network it is for', () => {
  expect(guessDirectNetwork('@ann:matrix.org')).toBe('matrix');
  expect(guessDirectNetwork('@ann:localhost:8448')).toBe('matrix');
  expect(guessDirectNetwork('+1 (555) 123-4567')).toBe('signal');
  expect(guessDirectNetwork('A11CE000-2222-4CCC-9DDD-000000000002')).toBe('signal');
  expect(guessDirectNetwork('ann')).toBeNull();
  expect(guessDirectNetwork('5551234567')).toBeNull(); // no country code: could be anywhere
});

test('addresses are normalised, and what is wrong is said', () => {
  expect(directTarget('matrix', ' @ann:matrix.org ')).toEqual({ peer: '@ann:matrix.org' });
  expect(directTarget('signal', '+1 (555) 123-4567')).toEqual({ peer: '+15551234567' });
  expect(directTarget('signal', 'A11CE000-2222-4CCC-9DDD-000000000002')).toEqual({ peer: 'a11ce000-2222-4ccc-9ddd-000000000002' });
  expect(directTarget('discord', '400000000000000001')).toEqual({ peer: '400000000000000001' });
  expect(directTarget('matrix', 'ann')).toHaveProperty('error');
  expect(directTarget('signal', '5551234')).toHaveProperty('error');
  expect(directTarget('discord', 'ann#1234')).toHaveProperty('error');
});
