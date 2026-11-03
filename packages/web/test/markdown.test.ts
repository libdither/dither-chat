import { expect, test } from 'bun:test';
import { renderMarkdown } from '../src/markdown.ts';

const md = (s: string) => renderMarkdown(s, { network: 'discord', user: () => null, room: () => null });

test('lines of text are joined with <br>', () => {
  expect(md('a\nb')).toBe('a<br>b');
});

test('consecutive "- " or "* " lines are a list, as in Discord', () => {
  expect(md('- one\n* two')).toBe('<ul><li>one</li><li>two</li></ul>');
  expect(md('intro\n- one\n- two\nafter')).toBe('intro<ul><li>one</li><li>two</li></ul>after');
});

test('a quote and a list stay apart, and a blank line between blocks shows', () => {
  expect(md('> a\n> b\n\n- x')).toBe('<blockquote>a<br>b</blockquote><br><ul><li>x</li></ul>');
  expect(md('> a\n- x')).toBe('<blockquote>a</blockquote><ul><li>x</li></ul>');
});

test('emphasis is not mistaken for a list, and a list item can be emphasised', () => {
  expect(md('*soft*')).toBe('<em>soft</em>');
  expect(md('- **bold** item')).toBe('<ul><li><strong>bold</strong> item</li></ul>');
});
