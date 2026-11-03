import { expect, test } from 'bun:test';
import type { EmojiItem } from '../src/emoji.ts';
import { closedCode, customMarkup, exactEmoji, findTrigger, insideCode, rankEmoji, type CustomEmoji } from '../src/emojiComplete.ts';

const at = (s: string) => findTrigger(s, s.length);

const item = (id: string, name: string, keywords: string[] = [], aliases: string[] = []): EmojiItem => ({
  id,
  codes: [id, ...aliases],
  name,
  words: [id, name, ...keywords].map((w) => w.toLowerCase()),
  skins: [`${id}!`],
});
const CATALOG = [
  item('joy', 'Face with Tears of Joy', ['cry', 'happy', 'haha']),
  item('joystick', 'Joystick', ['game']),
  item('heart', 'Red Heart', ['love']),
  item('broken_heart', 'Broken Heart', ['sad']),
  item('heart_eyes', 'Smiling Face with Heart-Eyes', ['love', 'crush']),
  item('+1', 'Thumbs Up', ['thumbsup', 'yes'], ['thumbsup']),
  item('sob', 'Loudly Crying Face', ['sad', 'cry']),
  item('smile', 'Grinning Face with Smiling Eyes', ['happy']),
  item('sweat_smile', 'Grinning Face with Sweat', ['hot']),
  item('100', 'Hundred Points', ['score']),
];
const CUSTOM: CustomEmoji[] = [
  { key: 'partyBlob:111', name: 'partyBlob', url: '/e/1', animated: true },
  { key: 'joyful:222', name: 'joyful', url: '/e/2', animated: false },
];
const codes = (q: string, usage?: Map<string, number>) => rankEmoji(q, CATALOG, CUSTOM, usage).map((c) => c.code);

test('opens after a colon and two characters, at the start or after a space', () => {
  expect(at(':j')).toBeNull();
  expect(at(':jo')).toEqual({ start: 0, end: 3, query: 'jo' });
  expect(at('hi :hea')?.query).toBe('hea');
  expect(at('line one\n:thu')?.query).toBe('thu');
  expect(at('(:smi')?.query).toBe('smi');
  expect(at(':+1')?.query).toBe('+1');
});

test('not for times, ratios, URLs, custom emoji markup or word:word', () => {
  expect(at('meet at 12:30')).toBeNull();
  expect(at('16:9')).toBeNull();
  expect(at('see http://ex')).toBeNull();
  expect(at('see https://example.com/:abc')).toBeNull();
  expect(at('<:blob')).toBeNull();
  expect(at('key:value')).toBeNull();
  expect(at('two colons ::ab')).toBeNull();
  expect(at('a smiley :-)')).toBeNull();
  expect(at('only marks :--')).toBeNull();
});

test('not inside inline code or a code block', () => {
  expect(at('try `let x = :jo')).toBeNull();
  expect(at('try `code` then :jo')?.query).toBe('jo');
  expect(at('```\nfoo :jo')).toBeNull();
  expect(at('```rust\nlet a = 1;\n```\nnice :jo')?.query).toBe('jo');
  expect(insideCode('a `b` c', 6)).toBe(false);
  expect(insideCode('a `b c', 5)).toBe(true);
  // Inline code ends with its line.
  expect(at('a `b\n:jo')?.query).toBe('jo');
});

test('only at the caret: a code earlier in the text does not open it', () => {
  const s = ':joy is funny';
  expect(findTrigger(s, s.length)).toBeNull();
  expect(findTrigger(s, 4)?.query).toBe('joy');
});

test('exact shortcode first, then codes that start with it, then words in codes, then names', () => {
  expect(codes('joy')[0]).toBe('joy');
  expect(codes('heart').slice(0, 3)).toEqual(['heart', 'heart_eyes', 'broken_heart']);
  expect(codes('smi')[0]).toBe('smile');
  expect(codes('smi')).toContain('sweat_smile');
  // :sob: by its name ("Loudly Crying Face") and keyword.
  expect(codes('crying')).toContain('sob');
});

test('aliases are shortcodes too, and the one that matched is shown', () => {
  expect(codes('thumbs')[0]).toBe('thumbsup');
  expect(exactEmoji('thumbsup', CATALOG, [])?.kind).toBe('unicode');
  expect(exactEmoji('+1', CATALOG, [])?.code).toBe('+1');
  expect(exactEmoji('100', CATALOG, [])?.code).toBe('100');
});

test("the network's custom emoji are matched by name, camelCase words included", () => {
  expect(codes('blob')).toEqual(['partyBlob']);
  expect(codes('party')).toEqual(['partyBlob']);
  // An exact Unicode code beats a custom one that only starts with the query.
  expect(codes('joy').slice(0, 2)).toEqual(['joy', 'joyful']);
  expect(exactEmoji('PARTYBLOB', CATALOG, CUSTOM)?.code).toBe('partyBlob');
  expect(customMarkup(CUSTOM[0])).toBe('<a:partyBlob:111>');
  expect(customMarkup(CUSTOM[1])).toBe('<:joyful:222>');
  expect(customMarkup({ key: 'mxc://server/abc', name: 'x', url: '', animated: false })).toBeNull();
});

test('ties go to what you use most', () => {
  // A server's own emoji edge out a Unicode one that matches just as well.
  expect(codes('jo').slice(0, 2)).toEqual(['joyful', 'joy']);
  expect(codes('jo', new Map([['joystick!', 9]]))[0]).toBe('joystick');
});

test('at most ten', () => {
  const many = Array.from({ length: 30 }, (_, i) => item(`cat${i}`, `Cat ${i}`));
  expect(rankEmoji('cat', many, []).length).toBe(10);
});

test('a closing colon finds the code it closes', () => {
  expect(closedCode('nice :joy:', 10)).toEqual({ start: 5, end: 10, code: 'joy' });
  expect(closedCode(':+1:', 4)?.code).toBe('+1');
  expect(closedCode('at 12:30:', 9)).toBeNull();
  expect(closedCode('`:joy:', 6)).toBeNull();
  expect(closedCode('<:blob:', 7)).toBeNull();
});
