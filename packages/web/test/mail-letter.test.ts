/** A mail's letter furniture in a chat (mail/letter.ts): what folds behind ···, what is drawn faint, the gaps. */
import { expect, test } from 'bun:test';
import { letter, shortLink, type Letter } from '../src/mail/letter.ts';

/** The letter as lines: paragraphs apart by "¶", a faint line marked "~". */
const shape = (l: Letter) => l.paras.map((p) => p.map((x) => (x.faint ? `~${x.text}` : x.text)).join('\n')).join('\n¶\n');

// The demo world's mails (hub demo.ts), the words above their quotes.
const SAM = ['Sam Rivera'];

test("Sam's dinner question: the lone name folds", () => {
  const l = letter('Hey! Are you free after 7 on Friday? There is a new ramen place on Maple Street I want to try.\n\nSam', SAM);
  expect(shape(l)).toBe('Hey! Are you free after 7 on Friday? There is a new ramen place on Maple Street I want to try.');
  expect(l.rest).toBe('Sam');
});

test("Sam's booking: the signature folds, the last line stays full size", () => {
  const words = 'Booked for 7:30, under Rivera. Their menu is here: https://ramen.example/menu/friday\n\nSee you there!\n\n-- \nSam Rivera';
  const l = letter(words, SAM);
  expect(shape(l)).toBe('Booked for 7:30, under Rivera. Their menu is here: https://ramen.example/menu/friday\n¶\nSee you there!');
  expect(l.rest).toBe('--\nSam Rivera');
});

test("your answer to Sam keeps everything (nothing is furniture)", () => {
  const l = letter('Yes, 7:30 works. Should I book a table?', ['Zyan']);
  expect(shape(l)).toBe('Yes, 7:30 works. Should I book a table?');
  expect(l.rest).toBeNull();
});

test("Alice's lease mail: the greeting joins the text, her name folds", () => {
  const l = letter('Hi both,\n\nThe landlord sent the renewal. I signed page 2; could you sign pages 3 and 4 and send it back by the 15th?\n\nAlice', ['Alice Chen']);
  expect(shape(l)).toBe('Hi both,\nThe landlord sent the renewal. I signed page 2; could you sign pages 3 and 4 and send it back by the 15th?');
  expect(l.paras).toHaveLength(1);
  expect(l.rest).toBe('Alice');
});

test("Jo's line in the group thread: Jo folds", () => {
  const l = letter('Done on my side too. Do we want to ask about the parking spot while we are at it?\n\nJo', ['Jo Park']);
  expect(shape(l)).toBe('Done on my side too. Do we want to ask about the parking spot while we are at it?');
  expect(l.rest).toBe('Jo');
});

test("your lease answer: a thanks inside a sentence is not a tail", () => {
  const l = letter('Signed and scanned, it is attached. Thanks for sorting this out!', ['Zyan']);
  expect(shape(l)).toBe('Signed and scanned, it is attached. Thanks for sorting this out!');
});

test('"Love, Mom" is unsure: drawn faint in place, not folded', () => {
  const l = letter('Lovely! Can you print the dog one for me?\n\nLove, Mom', ['Mom']);
  expect(shape(l)).toBe('Lovely! Can you print the dog one for me?\n¶\n~Love, Mom');
  expect(l.rest).toBeNull();
  expect(shape(letter('The roses came out at last. More photos when your uncle sends his.\n\nLove, Mom', ['Mom']))).toEndWith('¶\n~Love, Mom');
});

// Invented cases.

test('"Best,\\nSam" is unsure: both lines faint, nothing folded', () => {
  const l = letter('The keys are under the mat.\n\nBest,\nSam', SAM);
  expect(shape(l)).toBe('The keys are under the mat.\n¶\n~Best,\n~Sam');
  expect(l.rest).toBeNull();
});

test('"Thanks!" and "Sent from my phone" are faint; a signature under them still folds', () => {
  const l = letter('Running ten minutes late.\n\nThanks!\n\nSent from my phone\n-- \nRobin Lane\nLane & Co', ['Robin Lane']);
  expect(shape(l)).toBe('Running ten minutes late.\n¶\n~Thanks!\n¶\n~Sent from my phone');
  expect(l.rest).toBe('--\nRobin Lane\nLane & Co');
});

test('the full name, a dash before it, or the account name all fold', () => {
  expect(letter('See you then.\n\nSam Rivera', SAM).rest).toBe('Sam Rivera');
  expect(letter('See you then.\n- Sam', SAM).rest).toBe('- Sam');
  expect(letter('See you then.\n\nRiv', ['Sam Rivera', 'Riv']).rest).toBe('Riv');
  // Someone else's name is not the sender's.
  expect(letter('Ask him.\n\nTheo', SAM).rest).toBeNull();
});

test('a mail that is only a name or only a sign-off keeps it, full size', () => {
  expect(shape(letter('Sam', SAM))).toBe('Sam');
  expect(shape(letter('Thanks!', SAM))).toBe('Thanks!');
  expect(letter('-- \nSam Rivera', SAM).rest).toBeNull();
});

test('blank-line runs are one break; leading and trailing blanks go', () => {
  const l = letter('\n\nFirst.\n\n\n\nSecond line one\nSecond line two\n\n\n', SAM);
  expect(l.paras.map((p) => p.map((x) => x.text))).toEqual([['First.'], ['Second line one', 'Second line two']]);
});

test('a greeting needs a line of its own; a question is not one', () => {
  expect(letter('Hey! Are you free?\n\nSam', SAM).paras).toHaveLength(1);
  expect(shape(letter('Dear Ms. Park,\n\nYour order shipped.\n\nIt arrives Monday.', SAM))).toBe('Dear Ms. Park,\nYour order shipped.\n¶\nIt arrives Monday.');
  expect(shape(letter('Hello and welcome to the club, we are glad to have you.\n\nSee you.', SAM))).toBe('Hello and welcome to the club, we are glad to have you.\n¶\nSee you.');
});

test('Windows line ends', () => {
  const l = letter('Hi Sam,\r\n\r\nDone.\r\n\r\nJo', ['Jo Park']);
  expect(shape(l)).toBe('Hi Sam,\nDone.');
  expect(l.rest).toBe('Jo');
});

test('links: host and path, the middle cut, the query left out when long', () => {
  const ramen = 'https://ramen.example/menu/friday-specials-and-the-whole-very-long-list-of-noodles-and-broths-for-this-week?ref=newsletter&utm_source=mail';
  const s = shortLink(ramen);
  expect(s.length).toBeLessThanOrEqual(48);
  expect(s.startsWith('ramen.example/menu/friday')).toBe(true);
  expect(s.endsWith('this-week')).toBe(true);
  expect(s).toContain('…');
  // Cut where words end, never inside one.
  expect(s).toBe('ramen.example/menu/friday-…-broths-for-this-week');
  expect(shortLink('https://www.example.org/a?b=1')).toBe('example.org/a?b=1');
  expect(shortLink('https://example.org/')).toBe('example.org');
  expect(shortLink('www.example.org/docs')).toBe('example.org/docs');
  expect(shortLink('https://example.org/a/long/path/that/goes/on?with=a&query=that-is-long-enough')).toBe('example.org/a/long/path/that/goes/on');
  expect(shortLink('mailto:sam@rivera.example')).toBe('sam@rivera.example');
  expect(shortLink('not a url')).toBe('not a url');
});
