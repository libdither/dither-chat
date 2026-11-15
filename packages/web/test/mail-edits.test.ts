/** The composer's edits (mail/edits.ts, mail/paste.ts): formatting as Markdown, lists, undo, chips back to text, paste. */
import { describe, expect, test } from 'bun:test';
import { applyFormat, caretAfter, chipText, continueList, EditHistory, keptName, mergeHits, pasteLink, type Format, type Sel } from '../src/mail/edits.ts';
import { pastedMarkdown, type PasteNode } from '../src/mail/paste.ts';

/** Text with its selection written in: [ and ] around it, or | for the caret. */
function sel(s: string): Sel {
  const c = s.indexOf('|');
  if (c >= 0) return { text: s.replace('|', ''), start: c, end: c };
  const a = s.indexOf('[');
  const b = s.indexOf(']') - 1;
  return { text: s.replace('[', '').replace(']', ''), start: a, end: b };
}
function show(x: Sel): string {
  return x.start === x.end ? `${x.text.slice(0, x.start)}|${x.text.slice(x.start)}` : `${x.text.slice(0, x.start)}[${x.text.slice(x.start, x.end)}]${x.text.slice(x.end)}`;
}
const fmt = (s: string, f: Format) => show(applyFormat(sel(s), f));

describe('formatting', () => {
  test.each([
    ['say [hello] there', 'bold', 'say **[hello]** there'],
    ['say **[hello]** there', 'bold', 'say [hello] there'],
    ['say [**hello**] there', 'bold', 'say [hello] there'],
    ['say[ hello ]there', 'bold', 'say **[hello]** there'],
    ['say [hello] there', 'italic', 'say _[hello]_ there'],
    ['say [hello] there', 'strike', 'say ~~[hello]~~ there'],
    ['run [ls -l] now', 'code', 'run `[ls -l]` now'],
    ['caret|here', 'bold', 'caret**|**here'],
    ['[one\n\ntwo]', 'bold', '[**one**\n\n**two**]'],
  ] as [string, Format, string][])('%s %s', (input, f, out) => expect(fmt(input, f)).toBe(out));

  test('links: text gets an address to fill in; an address gets its text', () => {
    expect(fmt('see [the menu] now', 'link')).toBe('see [the menu]([https://]) now');
    const a = applyFormat(sel('see [https://ramen.example/menu] now'), 'link');
    expect(show(a)).toBe('see [|](https://ramen.example/menu) now');
  });

  test.each([
    ['[milk\neggs]', 'bullets', '[- milk\n- eggs]'],
    ['[- milk\n- eggs]', 'bullets', '[milk\neggs]'],
    ['[milk\n\neggs]', 'numbers', '[1. milk\n\n2. eggs]'],
    ['[- milk\n- eggs]', 'numbers', '[1. milk\n2. eggs]'],
    ['he said|', 'quote', '> he said|'],
    ['[> a\n> b]', 'quote', '[a\nb]'],
  ] as [string, Format, string][])('lines: %s %s', (input, f, out) => expect(fmt(input, f)).toBe(out));

  test('a web address pasted over text links it; over nothing, or over an address, it pastes', () => {
    expect(show(pasteLink(sel('see [the menu] now'), ' https://ramen.example/menu ')!)).toBe('see [the menu](https://ramen.example/menu)| now');
    expect(pasteLink(sel('see | now'), 'https://ramen.example')).toBeNull();
    expect(pasteLink(sel('see [the menu] now'), 'not a link')).toBeNull();
    expect(pasteLink(sel('[https://a.example]'), 'https://b.example')).toBeNull();
  });

  test('Enter goes on with a list and ends it on an empty item', () => {
    expect(show(continueList(sel('- milk|'))!)).toBe('- milk\n- |');
    expect(show(continueList(sel('1. milk\n2. eggs|'))!)).toBe('1. milk\n2. eggs\n3. |');
    expect(show(continueList(sel('  * nested|'))!)).toBe('  * nested\n  * |');
    expect(show(continueList(sel('- [x] done|'))!)).toBe('- [x] done\n- [ ] |');
    expect(show(continueList(sel('- milk\n- |'))!)).toBe('- milk\n|');
    expect(continueList(sel('just text|'))).toBeNull();
    expect(continueList(sel('-| milk'))).toBeNull();
  });
});

describe('undo', () => {
  test('typing in a field is one step until a pause, a word ends, or another field', () => {
    const h = new EditHistory<string>(200, 1000);
    h.record('', { field: 'body' }, 0);
    h.record('H', { field: 'body' }, 100);
    h.record('Hi', { field: 'body', wordEnd: true }, 200);
    h.record('Hi ', { field: 'body' }, 300);
    h.record('Hi t', { field: 'body' }, 2000);
    expect(h.undo('Hi th')).toBe('Hi t');
    expect(h.undo('Hi t')).toBe('Hi ');
    expect(h.undo('Hi ')).toBe('');
    expect(h.undo('')).toBeNull();
    expect(h.redo('')).toBe('Hi ');
    expect(h.redo('Hi ')).toBe('Hi t');
  });

  test('a change that is not typing is a step of its own, and clears redo', () => {
    const h = new EditHistory<number>();
    h.record(1, { field: 'to' }, 0);
    h.record(2, undefined, 10);
    h.record(3, { field: 'to' }, 20);
    expect(h.undo(4)).toBe(3);
    expect(h.undo(3)).toBe(2);
    h.record(2, undefined, 30);
    expect(h.redo(5)).toBeNull();
    expect(h.undo(5)).toBe(2);
    expect(h.undo(2)).toBe(1);
  });

  test('the caret lands after what changed', () => {
    expect(caretAfter('Hi there', 'Hi')).toBe(2);
    expect(caretAfter('Hi', 'Hi there')).toBe(8);
    expect(caretAfter('say hello now', 'say **hello** now')).toBe(13);
  });
});

describe('chips', () => {
  const sam = { name: 'Sam Rivera', email: 'sam@rivera.example' };
  test('Backspace opens a chip into its address without the last letter; a click, whole', () => {
    expect(chipText(sam, true)).toBe('sam@rivera.exampl');
    expect(chipText(sam, false)).toBe('sam@rivera.example');
  });
  test('an edited chip keeps its name while it is the same person', () => {
    expect(keptName(sam, { name: null, email: 'sam@rivera.test' })).toEqual({ name: 'Sam Rivera', email: 'sam@rivera.test' });
    expect(keptName(sam, { name: null, email: 'kit@rivera.example' })).toEqual({ name: null, email: 'kit@rivera.example' });
    expect(keptName(sam, { name: 'S. Rivera', email: 'sam@rivera.test' }).name).toBe('S. Rivera');
  });
});

// ------------------------------------------------------------------ paste

/** A tiny DOM: el('b', {style}, ...children); strings are text. */
function el(tag: string, attrs: Record<string, string> | null, ...kids: (PasteNode | string)[]): PasteNode {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    nodeValue: null,
    childNodes: kids.map((k) => (typeof k === 'string' ? { nodeType: 3, nodeName: '#text', nodeValue: k, childNodes: [] } : k)),
    getAttribute: (n) => attrs?.[n] ?? null,
  };
}
const body = (...kids: (PasteNode | string)[]) => el('body', null, ...kids);

describe('pasting rich text', () => {
  test('marks, links, headings, lists, quotes and code become Markdown', () => {
    const md = pastedMarkdown(
      body(
        el('h2', null, 'Plan'),
        el('p', null, 'We ', el('b', null, 'must '), 'book ', el('em', null, 'early'), ', see ', el('a', { href: 'https://ramen.example/menu' }, 'the menu'), '.'),
        el('ul', null, el('li', null, 'milk'), el('li', null, 'eggs', el('ol', null, el('li', null, 'brown')))),
        el('blockquote', null, el('p', null, 'quoted')),
        el('p', null, 'run ', el('code', null, 'ls -l'), ' and ', el('s', null, 'not this')),
        el('pre', null, 'line 1\nline 2\n'),
      ),
    );
    expect(md).toBe('## Plan\n\nWe **must** book _early_, see [the menu](https://ramen.example/menu).\n\n- milk\n- eggs\n   1. brown\n\n> quoted\n\nrun `ls -l` and ~~not this~~\n\n```\nline 1\nline 2\n```');
  });

  test("a document's styles: bold by weight, Google Docs' outer <b> that is not bold", () => {
    const md = pastedMarkdown(el('b', { style: 'font-weight:normal;', id: 'docs-internal-guid-1' }, el('p', null, el('span', { style: 'font-weight:700' }, 'Heavy'), ' and ', el('span', { style: 'font-style:italic' }, 'slanted'))));
    expect(md).toBe('**Heavy** and _slanted_');
  });

  test('nothing Markdown would keep: null, so the clipboard text goes in', () => {
    expect(pastedMarkdown(body(el('div', null, el('span', { style: 'color:red' }, 'just text'))))).toBeNull();
    expect(pastedMarkdown(body())).toBeNull();
  });

  test('links only to the web and mail; script and style are left behind', () => {
    const md = pastedMarkdown(body(el('p', null, el('a', { href: 'javascript:alert(1)' }, 'click'), ' ', el('a', { href: 'https://a.example/x' }, 'https://a.example/x'), ' ', el('b', null, 'ok')), el('script', null, 'alert(1)'), el('style', null, 'p{}')));
    expect(md).toBe('click https://a.example/x **ok**');
  });
});

describe('suggestions', () => {
  const hit = (email: string, name: string | null, wroteTo = false) => ({ email, name, wroteTo, count: 1 });
  test('people you wrote to, then the server, then the rest; once each, names filled, none already on it', () => {
    const local = [hit('old@x.example', 'Old'), hit('sam@rivera.example', null, true), hit('kit@x.example', 'Kit')];
    const server = [hit('ana@y.example', 'Ana'), hit('Sam@Rivera.example', 'Sam Rivera'), hit('kit@x.example', 'Kit K')];
    expect(mergeHits(local, server, [{ name: null, email: 'kit@X.example' }]).map((h) => [h.email, h.name])).toEqual([
      ['sam@rivera.example', 'Sam Rivera'],
      ['ana@y.example', 'Ana'],
      ['old@x.example', 'Old'],
    ]);
    expect(mergeHits(local, null, []).length).toBe(3);
  });
});
