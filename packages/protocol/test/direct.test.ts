import { expect, test } from 'bun:test';
import { directTarget, guessDirectNetwork, guessDirectNetworks } from '../src/direct.ts';

test('a typed address says which network it is for', () => {
  expect(guessDirectNetwork('@ann:matrix.org')).toBe('matrix');
  expect(guessDirectNetwork('@ann:localhost:8448')).toBe('matrix');
  expect(guessDirectNetwork('+1 (555) 123-4567')).toBe('signal');
  expect(guessDirectNetwork('A11CE000-2222-4CCC-9DDD-000000000002')).toBe('signal');
  expect(guessDirectNetwork('ann')).toBeNull();
  expect(guessDirectNetwork('5551234567')).toBeNull(); // no country code: could be anywhere
  expect(guessDirectNetwork('15551234567@s.whatsapp.net')).toBe('whatsapp');
});

test('a phone number could be Signal or WhatsApp', () => {
  expect(guessDirectNetworks('+1 (555) 123-4567')).toEqual(['signal', 'whatsapp']);
  expect(guessDirectNetworks('200000000000002@lid')).toEqual(['whatsapp']);
  expect(guessDirectNetworks('ann')).toEqual([]);
});

test('addresses are normalised, and what is wrong is said', () => {
  expect(directTarget('matrix', ' @ann:matrix.org ')).toEqual({ peer: '@ann:matrix.org' });
  expect(directTarget('signal', '+1 (555) 123-4567')).toEqual({ peer: '+15551234567' });
  expect(directTarget('signal', 'A11CE000-2222-4CCC-9DDD-000000000002')).toEqual({ peer: 'a11ce000-2222-4ccc-9ddd-000000000002' });
  expect(directTarget('discord', '400000000000000001')).toEqual({ peer: '400000000000000001' });
  expect(directTarget('matrix', 'ann')).toHaveProperty('error');
  expect(directTarget('signal', '5551234')).toHaveProperty('error');
  expect(directTarget('discord', 'ann#1234')).toHaveProperty('error');
  expect(directTarget('whatsapp', '+44 20 7183 0042')).toEqual({ peer: '+442071830042' });
  expect(directTarget('whatsapp', '15551234567@s.whatsapp.net')).toEqual({ peer: '15551234567@s.whatsapp.net' });
  expect(directTarget('whatsapp', '07183 0042')).toHaveProperty('error');
});
