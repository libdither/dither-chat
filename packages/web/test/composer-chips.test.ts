/**
 * Mentions in the message box as chips, without a DOM (composerChips.ts, docs/mentions.md "In the message box"): the
 * box's text holds each chip's token in invisible tag characters before its name; the body sent holds only tokens; an
 * edit that cuts into a chip takes it out whole; a token typed or pasted whole becomes a chip when it can be named.
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { chipFor, chipText, chipsIn, chipTarget, cuts, nameOf, toBody, toPlain, toShown, typedToken } = await import('../src/composerChips.ts');

const alice = chipText('<@123456789012345678>', '@Alice');
const name = (t: string) => ({ '<@123456789012345678>': '@Alice', '<@person:per_theo>': '@Theo' })[t] ?? null;

test('a chip reads as its name and sends as its token', () => {
  const shown = `hi ${alice} and you`;
  expect(toPlain(shown)).toBe('hi @Alice and you');
  expect(toBody(shown)).toBe('hi <@123456789012345678> and you');
  expect(chipsIn(shown)).toEqual([{ start: 3, end: 3 + alice.length, token: '<@123456789012345678>', label: '@Alice' }]);
  // Two in a row, and one at the very start.
  const two = `${alice}${chipText('<@person:per_theo>', '@Theo')}`;
  expect(toBody(two)).toBe('<@123456789012345678><@person:per_theo>');
  expect(chipsIn(two).map((c) => c.label)).toEqual(['@Alice', '@Theo']);
});

test('no tag character is ever sent: what is left of a broken chip goes', () => {
  const broken = alice.slice(0, -2); // its cancel tag deleted
  expect(chipsIn(broken)).toEqual([]);
  expect(toBody(`x ${broken} y`)).toBe('x @Alice y');
  expect(toBody('plain text, no chips')).toBe('plain text, no chips');
});

test('a name cannot open code or a new line, and a token not in ASCII stays as written', () => {
  const odd = chipText('<@1>', '@A`b\nc');
  expect(toPlain(odd)).toBe("@A b c");
  expect(toBody(odd)).toBe('<@1>');
  expect(chipText('<@ü>', '@U')).toBe('<@ü>');
});

test('a body becomes the box: tokens this device names are chips, unknown ones and those in code stay', () => {
  const body = 'ask <@123456789012345678> and <@999> about `<@123456789012345678>`, and <@person:per_theo>';
  const shown = toShown(body, name);
  expect(toPlain(shown)).toBe('ask @Alice and <@999> about `<@123456789012345678>`, and @Theo');
  expect(toBody(shown)).toBe(body);
  expect(toShown('```\n<@123456789012345678>\n```', name)).toBe('```\n<@123456789012345678>\n```');
});

test('a token typed whole, closed by its >, is found at the caret', () => {
  const s = 'hey <@123456789012345678>';
  expect(typedToken(s, s.length)).toEqual({ start: 4, end: s.length, token: '<@123456789012345678>' });
  expect(typedToken('hey <@12 3>', 11)).toBeNull();
  expect(typedToken('`<@123>', 7)).toBeNull();
  expect(typedToken('hey <@123', 9)).toBeNull();
});

test('backspace into a chip takes the rest of it', () => {
  const prev = `hi ${alice} there`;
  const end = 3 + alice.length;
  // The box deleted only the cancel tag (two UTF-16 units).
  const next = prev.slice(0, end - 2) + prev.slice(end);
  expect(cuts(prev, next, end - 2)).toEqual([[3, end - 2]]);
  // A word deleted from inside: the name's last letters and the cancel tag.
  const word = prev.slice(0, end - 5) + prev.slice(end);
  expect(cuts(prev, word, end - 5)).toEqual([[3, end - 5]]);
});

test('typing over a selection that cuts through a chip takes both its parts', () => {
  const prev = `${alice} there`;
  // "lice" + cancel tag + " th" replaced by "x".
  const at = alice.length - 6;
  const next = prev.slice(0, at) + 'x' + prev.slice(alice.length + 3);
  expect(cuts(prev, next, at + 1)).toEqual([[0, at]]);
  // A letter put inside its name (a keyboard's correction).
  const mid = alice.length - 4;
  const inside = prev.slice(0, mid) + 'Z' + prev.slice(mid);
  expect(cuts(prev, inside, mid + 1)).toEqual([
    [mid + 1, alice.length + 1],
    [0, mid],
  ]);
});

test('edits beside a chip, or that take it whole, leave it alone', () => {
  const prev = `a ${alice} b`;
  const after = 2 + alice.length;
  expect(cuts(prev, `a ${alice}x b`, after + 1)).toEqual([]);
  expect(cuts(prev, `ax ${alice} b`, 2)).toEqual([]);
  expect(cuts(prev, `a ${alice}b`, after)).toEqual([]);
  expect(cuts(prev, 'a  b', 2)).toEqual([]);
  expect(cuts(prev, '', 0)).toEqual([]);
  expect(cuts('no chips', 'no chip')).toEqual([]);
  // An @ typed right before the chip's own @: the same text as one typed just inside it, told apart by the caret.
  expect(cuts(prev, `a @${alice} b`, 3)).toEqual([]);
  expect(cuts(`${alice}`, `@${alice}`, 1)).toEqual([]);
});

test("a chip's name and page come from the db, or from the @ list for one the hub does not hold", () => {
  db.persons.set('per_ann', { id: 'per_ann', name: 'Ann Lee' } as P.PersonView);
  db.identities.set('idn_ann', { id: 'idn_ann', network: 'signal', nativeId: 'aci-1', personId: 'per_ann', displayName: 'Ann' } as P.IdentityView);
  db.identities.set('idn_ann_d', { id: 'idn_ann_d', network: 'discord', nativeId: '42', personId: 'per_ann', displayName: 'ann' } as P.IdentityView);
  db.identityByNative.set('discord:42', 'idn_ann_d');
  const discord = nameOf('discord');
  expect(discord('<@42>')).toBe('@Ann Lee');
  expect(discord('<@!42>')).toBe('@Ann Lee');
  expect(discord('<@person:per_ann>')).toBe('@Ann Lee');
  expect(discord('<@identity:idn_ann>')).toBe('@Ann Lee · Signal');
  expect(discord('<@77>')).toBeNull();
  expect(discord('<@&5>')).toBeNull();
  expect(chipTarget('discord', '<@42>')).toEqual({ identity: 'idn_ann_d' });
  expect(chipTarget('discord', '<@person:per_ann>')).toEqual({ person: 'per_ann' });
  expect(chipTarget('discord', '<@&5>')).toBeNull();
  // A server member or a role the @ list named: kept for this network.
  expect(toPlain(chipFor('discord', '<@77>', '@Mo'))).toBe('@Mo');
  expect(chipFor('discord', '<@&5>', '@mods')).toBe(chipText('<@&5>', '@mods'));
  expect(discord('<@77>')).toBe('@Mo');
  expect(discord('<@&5>')).toBe('@mods');
  expect(nameOf('telegram')('<@77>')).toBeNull();
});
