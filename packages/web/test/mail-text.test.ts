/** Plain-text mail in the reader (mail/text.ts): the quote folded where the hub says, links made clickable. */
import { expect, test } from 'bun:test';
import { mailPreview, quoteStart } from '@dither-chat/protocol';
import { linkify, splitQuote } from '../src/mail/text.ts';

const reply = 'Booked for 7:30.\n\nSee you!\n\nOn Thu, 5 Nov 2026 at 18:02, Sam Rivera <sam@rivera.example> wrote:\n> Are you free after 7?\n>\n> Sam\n';

test('the quote starts at the attribution line before the trailing > block', () => {
  expect(quoteStart(reply)).toBe(reply.indexOf('On Thu'));
  expect(splitQuote(reply)).toEqual({ shown: 'Booked for 7:30.\n\nSee you!', quoted: reply.slice(reply.indexOf('On Thu')).trimEnd() });
});

test('an attribution a client wrapped over two lines is part of the quote', () => {
  const t = 'Yes.\n\nOn Thu, 5 Nov 2026 at 18:02, Sam Rivera\n<sam@rivera.example> wrote:\n> hi\n';
  expect(quoteStart(t)).toBe(t.indexOf('On Thu'));
});

test('quoting inline (answers between the quoted lines) folds only the last block', () => {
  const t = '> first question\nfirst answer\n\n> second question\nsecond answer\n\n> the rest\n> of it\n';
  expect(splitQuote(t).shown).toBe('> first question\nfirst answer\n\n> second question\nsecond answer');
});

test('Outlook-style originals fold from their header', () => {
  const t = 'Sounds good.\n\n-----Original Message-----\nFrom: Alice\nSent: Monday\nSubject: Plans\n\nShall we?';
  expect(quoteStart(t)).toBe(t.indexOf('-----Original'));
});

test('nothing folds when there is no quote, or the whole mail is one', () => {
  expect(splitQuote('Just text.\n> not at the end\nmore text').quoted).toBeNull();
  expect(splitQuote('> all of it\n> quoted').quoted).toBeNull();
  // The hub's quoteAt wins over the text's own.
  expect(splitQuote('abc\ndef', 4)).toEqual({ shown: 'abc', quoted: 'def' });
  expect(splitQuote('abc', null).quoted).toBeNull();
});

test('a preview leaves out the quote and the signature', () => {
  expect(mailPreview('Booked.\n\n-- \nSam\n\nOn Thu, Sam <s@x> wrote:\n> hi')).toBe('Booked.');
  expect(mailPreview('   ')).toBeNull();
  expect(mailPreview('x'.repeat(300))!.length).toBe(200);
});

test('links: http, www and mailto; trailing punctuation stays text; brackets the link opened stay in it', () => {
  expect(linkify('See https://ramen.example/menu, then www.example.org. Or mailto:sam@x.org!')).toEqual([
    { text: 'See ' },
    { url: 'https://ramen.example/menu', text: 'https://ramen.example/menu' },
    { text: ', then ' },
    { url: 'https://www.example.org', text: 'www.example.org' },
    { text: '. Or ' },
    { url: 'mailto:sam@x.org', text: 'mailto:sam@x.org' },
    { text: '!' },
  ]);
  expect(linkify('(https://en.example/wiki/Foo_(bar))')).toEqual([{ text: '(' }, { url: 'https://en.example/wiki/Foo_(bar)', text: 'https://en.example/wiki/Foo_(bar)' }, { text: ')' }]);
  expect(linkify('no links here')).toEqual([{ text: 'no links here' }]);
});
