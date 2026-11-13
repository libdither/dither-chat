import { expect, test } from 'bun:test';
import { createGroupNotBuilt, createGroupProblem, GROUP_RULES } from '../src/about.ts';

test('each network with a rule: the fewest and the most people', () => {
  expect(createGroupProblem('discord', undefined, 1)).toBe('A Discord group DM starts with at least 2 friends');
  expect(createGroupProblem('discord', undefined, 2)).toBeNull();
  expect(createGroupProblem('discord', undefined, 9)).toBeNull();
  expect(createGroupProblem('discord', undefined, 10)).toBe('A Discord group DM starts with at most 9 friends');
  expect(createGroupProblem('signal', 'Climbing', 0)).toBe('A Signal group starts with at least 1 person');
  expect(createGroupProblem('signal', 'Climbing', 1)).toBeNull();
  expect(createGroupProblem('signal', 'Climbing', 11)).toBe('A Signal group starts with at most 10 people');
  expect(createGroupProblem('matrix', 'House', 10)).toBeNull();
  expect(createGroupProblem('telegram', 'Film', 11)).toBe('A Telegram group starts with at most 10 people');
  // XChat: a name is optional (X names the group after its people), up to 32 characters as its edit screen allows.
  expect(createGroupProblem('x', undefined, 0)).toBe('An X group starts with at least 1 person');
  expect(createGroupProblem('x', undefined, 1)).toBeNull();
  expect(createGroupProblem('x', '  ', 10)).toBeNull();
  expect(createGroupProblem('x', 'x'.repeat(33), 3)).toBe("An X group's name is at most 32 characters");
});

test('a name: required or optional, trimmed, at most so long', () => {
  expect(createGroupProblem('signal', undefined, 2)).toBe('Give the group a name');
  expect(createGroupProblem('signal', '   ', 2)).toBe('Give the group a name');
  expect(createGroupProblem('matrix', '', 2)).toBe('Give the room a name');
  // Optional on Discord: an empty name is no name, and the client names it after its people.
  expect(createGroupProblem('discord', '  ', 3)).toBeNull();
  expect(createGroupProblem('signal', 'x'.repeat(32), 2)).toBeNull();
  expect(createGroupProblem('signal', ` ${'x'.repeat(32)} `, 2)).toBeNull();
  expect(createGroupProblem('signal', 'x'.repeat(33), 2)).toBe("A Signal group's name is at most 32 characters");
  // Characters, not UTF-16 units.
  expect(createGroupProblem('signal', '🧗'.repeat(32), 2)).toBeNull();
  expect(createGroupProblem('discord', 'x'.repeat(101), 2)).toBe("A Discord group DM's name is at most 100 characters");
  expect(createGroupProblem('telegram', 'x'.repeat(129), 2)).toContain('at most 128');
  expect(createGroupProblem('matrix', 'x'.repeat(256), 2)).toContain('at most 255');
});

test('without a rule: the line instead', () => {
  expect(GROUP_RULES.whatsapp).toBeUndefined();
  expect(createGroupProblem('whatsapp', 'Book club', 2)).toBe(createGroupNotBuilt('whatsapp'));
  expect(createGroupNotBuilt('whatsapp')).toBe('Making groups from here is left out on WhatsApp, which watches for it: make it on your phone and it shows up here.');
  expect(createGroupNotBuilt('instagram')).toBe("Making groups on Instagram isn't built for this account yet.");
  expect(createGroupProblem('messenger', 'x', 2)).toBe(createGroupNotBuilt('messenger'));
});
