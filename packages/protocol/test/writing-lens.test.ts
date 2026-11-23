/**
 * Ways of writing (src/writing/lens.ts): a part of a draft typed as Markdown or as HTML. What is checked here is what
 * the file promises: changing the way a part is written never changes what is sent, reading is total, and typed HTML
 * that says more than the tree is kept as typed.
 */
import { expect, test } from 'bun:test';
import { doc, para, sound, text, type Node } from '../src/writing/doc.ts';
import { draft, outcome } from '../src/writing/draft.ts';
import { send } from '../src/writing/encode.ts';
import { fromSource, inline, pieces, resolve, rewrite, same, scan, shown, toSource, type Lang, type Way } from '../src/writing/lens.ts';
import { PROFILES } from '../src/writing/profile.ts';
import { drafts } from './writing-drafts.ts';

const line = (s: string): Node => (s ? para(s) : { type: 'paragraph' });
const part = (lang: Lang, ...lines: (string | Node)[]): Node => ({ type: 'source', attrs: { lang }, content: lines.map((l) => (typeof l === 'string' ? line(l) : l)) });
const md = (...lines: (string | Node)[]) => fromSource(part('markdown', ...lines));
const html = (...lines: string[]) => fromSource(part('html', ...lines));
const typed = (n: Node) => (n.content ?? []).map((l) => (l.content ?? []).map((c) => c.text ?? '@').join(''));
const link = (href: string) => ({ type: 'link', attrs: { href } });
const item = (...content: Node[]): Node => ({ type: 'listItem', content });
const KIT: Node = { type: 'mention', attrs: { kind: 'user', label: 'Kit', ids: { discord: '8001' } } };

test('Markdown: a pair of markers styles what is between, and two styles may cross', () => {
  expect(md('**bold** and *it* and _it_ and __under__ and ~~gone~~ and ||hid|| and `code`')).toEqual([
    para(text('bold', 'bold'), ' and ', text('it', 'italic'), ' and ', text('it', 'italic'), ' and ', text('under', 'underline'), ' and ', text('gone', 'strike'), ' and ', text('hid', 'spoiler'), ' and ', text('code', 'code')),
  ]);
  expect(md('**a *b** c*')).toEqual([para(text('a ', 'bold'), text('b', 'bold', 'italic'), text(' c', 'italic'))]);
  expect(md('***both***')).toEqual([para(text('both', 'bold', 'italic'))]);
  expect(md('see [the *guide*](https://example.org/g) now')).toEqual([para('see ', text('the ', link('https://example.org/g')), text('guide', link('https://example.org/g'), 'italic'), ' now')]);
});

test('Markdown: what is not a pair stays as typed', () => {
  for (const s of ['2 * 3 * 4', 'snake_case_name', 'a **bold', '5 > 3', 'a | b', 'https://example.org/a_b_c*d and *', '#tag', '-', '1.5 litres', 'C:\\dir', '[x] done', 'a ](b)']) expect(md(s)).toEqual([para(s)]);
  expect(md('\\*not\\* \\# \\\\')).toEqual([para('*not* # \\')]);
  expect(md('`a*b` and ``a`b``')).toEqual([para(text('a*b', 'code'), ' and ', text('a`b', 'code'))]);
});

test('Markdown: a line is a block, and a marker with a space after it says which', () => {
  expect(md('# Title', 'first', '', 'second')).toEqual([{ type: 'heading', attrs: { level: 1 }, content: [text('Title')] }, para('first'), { type: 'paragraph' }, para('second')]);
  expect(md('> quoted', '> more', 'out')).toEqual([{ type: 'blockquote', content: [para('quoted'), para('more')] }, para('out')]);
  expect(md('- Bread', '  1. rye', '  2. sourdough', '- Cheese', '* other list')).toEqual([
    { type: 'bulletList', content: [item(para('Bread'), { type: 'orderedList', content: [item(para('rye')), item(para('sourdough'))] }), item(para('Cheese'))] },
    { type: 'bulletList', content: [item(para('other list'))] },
  ]);
  expect(md('3. three', '4. four')).toEqual([{ type: 'orderedList', attrs: { start: 3 }, content: [item(para('three')), item(para('four'))] }]);
  expect(md('```js', 'let a = **1**', '', '```', '---')).toEqual([{ type: 'codeBlock', attrs: { language: 'js' }, content: [text('let a = **1**\n')] }, { type: 'horizontalRule' }]);
  // A code block never closed runs to the end of the part.
  expect(md('```', 'still code')).toEqual([{ type: 'codeBlock', content: [text('still code')] }]);
  expect(md('| Dish | Cost |', '| --- | --- |', '| Soup | **4** |', 'after')).toEqual([
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [para('Dish')] }, { type: 'tableHeader', content: [para('Cost')] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [para('Soup')] }, { type: 'tableCell', content: [para(text('4', 'bold'))] }] },
      ],
    },
    para('after'),
  ]);
});

test('Markdown: what no marker says stays in the line as the thing it is', () => {
  const coloured = { type: 'color', attrs: { color: '#c00' } };
  const blocks = [para('Hi ', KIT, ', ', text('red ', coloured), text('and bold', coloured, 'bold'), '.')];
  const [p] = toSource(blocks, 'markdown');
  expect(p.type).toBe('source');
  // The mention is still a mention in the line, the colour is still on its words, and only bold got markers.
  expect(typed(p)).toEqual(['Hi @, red **and bold**.']);
  expect(p.content![0].content!.some((n) => n.type === 'mention')).toBe(true);
  expect(same(fromSource(p), blocks)).toBe(true);
});

test('Markdown: a backslash stands only where the words would be read as markers', () => {
  const lines = (...b: Node[]) => toSource(b, 'markdown').flatMap(typed);
  expect(lines(para('snake_case, 2 * 3, a_b and a lone *'))).toEqual(['snake_case, 2 * 3, a_b and a lone *']);
  expect(lines(para('*stars* and # hash'))).toEqual(['\\*stars\\* and # hash']);
  expect(lines(para('# not a heading'), para('- not a list'), para('1. not a list'), para('> not a quote'), para('---'))).toEqual(['\\# not a heading', '\\- not a list', '1\\. not a list', '\\> not a quote', '\\---']);
  expect(lines(para(text('a`b', 'code'), text(' x ', 'code', 'bold')))).toEqual(['``a`b``**`  x  `**']);
  // Two lists side by side are still two.
  expect(lines({ type: 'bulletList', content: [item(para('a'))] }, { type: 'bulletList', content: [item(para('b'))] })).toEqual(['- a', '* b']);
});

test('Markdown: a block it has no words for stands between the parts as itself', () => {
  const picture: Node = { type: 'image', attrs: { src: 'https://example.org/p.png', alt: 'a hut' } };
  const out = toSource([para('above'), picture, para('below')], 'markdown');
  expect(out.map((b) => b.type)).toEqual(['source', 'image', 'source']);
  expect(out[1]).toEqual(picture);
});

test('HTML: what the tree says the same is the tree', () => {
  expect(html('<div>Hi <b>there</b> and <a href="https://example.org/">a <i>link</i></a></div>', '<h2>Menu</h2>')).toEqual([
    para('Hi ', text('there', 'bold'), ' and ', text('a ', link('https://example.org/')), text('link', link('https://example.org/'), 'italic')),
    { type: 'heading', attrs: { level: 2 }, content: [text('Menu')] },
  ]);
  expect(html('<ul>', '  <li>Bread</li>', '  <li>', '    <div>Cheese</div>', '    <div>and wine</div>', '  </li>', '</ul>')).toEqual([{ type: 'bulletList', content: [item(para('Bread')), item(para('Cheese'), para('and wine'))] }]);
  // Spaces as a browser shows them, a break as a new line, and words outside any tag as a line.
  expect(html('<div>  a   b  <br>c&amp;d&nbsp;&nbsp;e</div>', 'bare <u>words</u>')).toEqual([para('a b'), para('c&d  e'), para('bare ', text('words', 'underline'))]);
  expect(html('<div>10&nbsp;km</div>')).toEqual([para('10\u00a0km')]);
  expect(html('<pre><code class="language-js">a &lt; b', '  c</code></pre>')).toEqual([{ type: 'codeBlock', attrs: { language: 'js' }, content: [text('a < b\n  c')] }]);
});

test('HTML: a piece that says more than the tree is kept as typed', () => {
  const kept = (...lines: string[]) => html(...lines).map((b) => (b.type === 'raw' ? `raw:${b.attrs!.source}` : b.type));
  expect(kept('<div>plain</div>', '<p style="margin:0">Hi <b>Kit</b></p>', '<div>after</div>')).toEqual(['paragraph', 'raw:<p style="margin:0">Hi <b>Kit</b></p>', 'paragraph']);
  for (const s of ['<p>a paragraph has room around it</p>', '<div class="x">a class</div>', '<div>never closed', '<div>a <!-- note --> comment</div>', '<div>&notaname;</div>', '<table width="100%"><tr><td>x</td></tr></table>', '<font color="red">old</font>', '<div><div>a wrapper</div></div>', '<img src="https://example.org/p.png" alt="a" width="40">'])
    expect(kept(s)).toEqual([`raw:${s}`]);
  // What could be read of it is its fallback, for a place that takes no HTML; a style sheet's text is not words.
  const [raw] = html('<p style="margin:0">Hi <b>Kit</b></p><style>p { color: red }</style>');
  expect(raw.attrs!.fallback).toEqual([para('Hi ', text('Kit', 'bold'))]);
  expect(html('<style>p { color: red }</style>')[0].attrs!.text).toBe('');
  // On Signal the kept piece goes as what could be read of it; in a mail it goes as typed.
  const d = doc(part('html', '<p style="margin:0">Hi <b>Kit</b></p>'));
  expect((send(d, PROFILES.signal).wire as any).message).toBe('Hi Kit');
  expect(JSON.stringify(send(d, PROFILES.mail).wire)).toContain('<p style=\\"margin:0\\">Hi <b>Kit</b></p>');
});

test('the reviewers’ cases: what a person types is read as they meant it', () => {
  // Stars and underscores open before a word and close after one.
  for (const s of ['*.ts and *.js', 'rated 5* by me, 4* by Kit', '** not bold **', 'use handlers[name](event) here', '[docs](./readme.md)']) expect(md(s)).toEqual([para(s)]);
  expect(md('a *b* c **d e** f')).toEqual([para('a ', text('b', 'italic'), ' c ', text('d e', 'bold'), ' f')]);
  // A line that starts with hidden words is not a table.
  expect(md('||secret|| then')).toEqual([para(text('secret', 'spoiler'), ' then')]);
  expect(toSource([para(text('secret', 'spoiler'), ' then')], 'markdown').flatMap(typed)).toEqual(['||secret|| then']);
  // The named characters of HTML.
  expect(html('<div>caf&eacute; &mdash; ok &Eacute;&hellip;</div>')).toEqual([para('café — ok É…')]);
  // A piece kept whole does not carry what stands for a person, ids and all, to the mail.
  const [kept] = html('<p>Hi <span data-mention="{&quot;kind&quot;:&quot;user&quot;,&quot;label&quot;:&quot;Kit&quot;,&quot;ids&quot;:{&quot;signal&quot;:&quot;uuid-kit&quot;}}">@Kit</span></p>');
  expect(kept.attrs!.source).toBe('<p>Hi @Kit</p>');
  // A control character in a word does not become a marker when the draft is written out.
  const odd = [para('~\u0001~x~\u0001~')];
  expect(wires({ type: 'doc', content: toSource(odd, 'markdown') }, PLACES)).toEqual(wires(doc(...odd), PLACES));
});

test('HTML: a mention and a hidden word are still themselves', () => {
  const blocks = [para('Hi ', KIT, ', the ', text('ending', 'spoiler'), ' at ', { type: 'time', attrs: { at: 1700000000 } })];
  const [p] = toSource(blocks, 'html');
  expect(p.type).toBe('source');
  expect(typed(p)[0]).toContain('<span data-spoiler>ending</span>');
  expect(same(fromSource(p), blocks)).toBe(true);
});

/** The wire of a draft at a place, as text: two drafts that give the same one are sent the same. */
const wires = (d: Node, ids: string[]) => ids.map((id) => JSON.stringify(send(d, PROFILES[id]).wire));
const PLACES = ['signal', 'discord', 'mail', 'matrix', 'github', 'sms'];
for (const lang of ['markdown', 'html'] as const)
  for (const marks of [false, true])
    test(`written as ${lang} and read back, a draft is sent as it was${marks ? ' (markers typed in the words)' : ''}`, () => {
      const next = drafts(lang === 'html' ? 41 : 17, marks);
      let parts = 0;
      for (let i = 0; i < 120; i++) {
        const d = sound(next())[0];
        const written = { type: 'doc', content: toSource(d.content ?? [], lang) };
        parts += written.content.filter((b) => b.type === 'source').length;
        // Not this file's own word for it: what each place would be handed.
        expect(wires(written, PLACES)).toEqual(wires(d, PLACES));
        expect(same(resolve(written).content!, d.content ?? [])).toBe(true);
        // And once more: what was read is written and read the same again.
        for (const p of written.content.filter((b) => b.type === 'source')) expect(same(toSource(fromSource(p), lang).flatMap((x) => (x.type === 'source' ? fromSource(x) : [x])), fromSource(p))).toBe(true);
      }
      // Most of a draft can be written either way: a way of writing that left everything as it was would pass the lines above.
      expect(parts).toBeGreaterThan(100);
    });

test('a draft changed from one way of writing to another, and another, is sent as it was', () => {
  const next = drafts(23, true);
  const ways: Way[] = ['markdown', 'html', 'rich', 'html', 'markdown', 'rich'];
  for (let i = 0; i < 60; i++) {
    const d = sound(next())[0];
    const first = wires(d, PLACES);
    let blocks = d.content ?? [];
    for (const [k, way] of ways.entries()) {
      // One part of it only, then the rest: a draft may be written three ways at once.
      const cut = (i + k) % (blocks.length + 1);
      const some = [...blocks.slice(0, cut), ...rewrite(blocks.slice(cut), way)];
      expect(wires({ type: 'doc', content: some }, PLACES)).toEqual(first);
      blocks = rewrite(some, way);
      expect(wires({ type: 'doc', content: blocks }, PLACES)).toEqual(first);
      if (way === 'rich') expect(blocks.some((b) => b.type === 'source')).toBe(false);
    }
  }
  // What was typed in a part stays as typed when the rest is written the same way, and two parts become one.
  const typed2 = [part('markdown', 'a  **b**'), para('c ', text('d', 'bold')), part('html', '<div>e</div>')];
  expect(rewrite(typed2, 'markdown')).toEqual([part('markdown', 'a  **b**', 'c **d**', 'e')]);
  // Two lists side by side stay two parts: as one they would be one list.
  const lists = [part('markdown', '- a'), part('markdown', '- b')];
  expect(rewrite(lists, 'markdown')).toEqual(lists);
});

test('any lines are some tree, and nothing typed makes it throw or take seconds', () => {
  const next = drafts(5, true);
  const bits = ['*', '**', '_', '__', '~~', '||', '`', '``', '```', '[', '](', ')', '\\', '> ', '- ', '1. ', '# ', '|', '---', ' ', '<b>', '</b>', '<div>', '</div>', '<!--', '&nbsp;', '&', '<', '>', '"', "'", '=', 'https://example.org/a_b', 'W'];
  let seed = 9;
  // Whole numbers kept whole: a product past 2^53 would lose its low bits and the sequence would repeat early.
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => Array.from({ length: Math.floor(rnd() * 9) }, () => bits[Math.floor(rnd() * bits.length)]).join(''));
    seen.add(lines.join('\n'));
    for (const lang of ['markdown', 'html'] as const) {
      const blocks = fromSource(part(lang, ...lines));
      // What comes out is a tree the rest of the model takes as it is.
      expect(same(sound({ type: 'doc', content: blocks })[0].content ?? [], blocks)).toBe(true);
      expect(() => send(doc(part(lang, ...lines)), PROFILES.discord)).not.toThrow();
    }
  }
  // Short ones may come twice; the rest are new.
  expect(seen.size).toBeGreaterThan(350);
  // A value that is no part at all.
  for (const v of [null, 7, 'x', [], {}, { type: 'doc', content: [{ type: 'source' }, { type: 'source', attrs: { lang: 7 }, content: [null, 3, { type: 'paragraph', content: [{ type: 'text', text: 7 }] }] }] }, sound(next())[0]]) expect(() => resolve(v)).not.toThrow();
  const t0 = performance.now();
  for (const s of ['*a '.repeat(4000), '`a '.repeat(4000), '[a]('.repeat(3000), '**__~~||'.repeat(2000), '\\*'.repeat(5000), '<b>'.repeat(3000), '<div>x'.repeat(3000), '&nbsp; '.repeat(4000), '> '.repeat(3000) + 'x', '- '.repeat(1500) + 'x', '<ul><li>'.repeat(9000), '<a '.repeat(20000), '<a "'.repeat(20000), '<b>'.repeat(20000) + 'x'])
    for (const lang of ['markdown', 'html'] as const) fromSource(part(lang, s, s));
  fromSource(part('markdown', ...Array.from({ length: 4000 }, (_, i) => (i % 3 ? '- item **' + i + '**' : '> quote'))));
  toSource([para(text('*_`|[]()\\~# '.repeat(600)))], 'markdown');
  expect(performance.now() - t0).toBeLessThan(4000);
});

test('a part by its pieces: one can be taken out and the rest left as typed', () => {
  const p = part('markdown', '# Title', '- a', '  more', '- b', '', '```', 'code', '```', '| x |', '| --- |', '| y |', 'last _line_');
  const got = pieces(p);
  expect(got.map((x) => [x.from, x.to, x.nodes[0].type])).toEqual([[0, 1, 'heading'], [1, 4, 'bulletList'], [4, 5, 'paragraph'], [5, 8, 'codeBlock'], [8, 11, 'table'], [11, 12, 'paragraph']]);
  expect(same(got.flatMap((x) => x.nodes), fromSource(p))).toBe(true);
});

test('what an editor draws over the lines is what the reader reads: which characters are markers, and what the words are', () => {
  const lines = ['> - **Bread** and `rye`', '>   more', '## Menu', '```js', 'a **b**', '```', '| Dish | Cost |', '| --- | --- |', '| *Soup* | 4 |', '---'];
  const infos = scan(lines);
  expect(infos.map((i) => i.leaf)).toEqual(['para', 'para', 'heading', 'fence', 'code', 'close', 'row', 'delim', 'row', 'rule']);
  expect(infos[0].boxes.map((b) => b.kind)).toEqual(['quote', 'item']);
  // The second line is more of the same item: its markers are the quote's and the room the item's words are set in by.
  expect(infos[1].boxes).toEqual(infos[0].boxes);
  expect(infos[1].pre).toEqual([[0, 2], [2, 4]]);
  expect([infos[2].level, infos[2].at, infos[3].lang, infos[6].head]).toEqual([2, 3, 'js', true]);
  const words = (s: string, from: number, to: number, table = false) => {
    const { gone, spans } = inline(s, from, to, table);
    return { left: [...s].filter((_, i) => i >= from && i < to && !gone.has(i)).join(''), spans: spans.map((x) => `${x.kind}:${s.slice(x.from, x.to)}`) };
  };
  expect(words(lines[0], infos[0].at, lines[0].length)).toEqual({ left: 'Bread and rye', spans: ['code:rye', 'bold:Bread'] });
  expect(infos[8].cells!.map(([a, b]) => words(lines[8], a, b, true))).toEqual([{ left: 'Soup', spans: ['italic:Soup'] }, { left: '4', spans: [] }]);
  const odd = 'a \\*b* [c](https://example.org/x_y) https://example.org/a_b_';
  expect(words(odd, 0, odd.length)).toEqual({ left: 'a *b* c https://example.org/a_b_', spans: ['link:c'] });
  // And the same for every draft: the words left when the markers are taken out are the words the tree has.
  const next = drafts(31, true);
  for (let i = 0; i < 60; i++)
    for (const p of toSource(sound(next())[0].content ?? [], 'markdown').filter((b) => b.type === 'source')) {
      const texts = typed(p).map((t) => t.replace(/@/g, '\uFFFC'));
      const infos = scan(texts);
      texts.forEach((t, k) => {
        if (infos[k].leaf !== 'para' && infos[k].leaf !== 'heading') return;
        const { gone, spans } = inline(t, infos[k].at, t.length);
        for (const s of spans) expect(s.from <= s.to && s.from >= infos[k].at && s.to <= t.length).toBe(true);
        for (const g of gone) expect(g >= infos[k].at && g < t.length).toBe(true);
      });
    }
});

test('a look at a part shows a kept piece as it was typed', () => {
  const blocks = html('<div>Hi <b>Kit</b></div>', '<p style="margin:0">kept</p>');
  expect(shown(blocks)).toBe('<div>Hi <strong>Kit</strong></div>\n<p style="margin:0">kept</p>');
});

test('a draft with a part in it sends what the part says, and says when it is empty', () => {
  const tree = [para('Dinner is ', text('on', 'bold'), ' at ', text('eight', 'spoiler'))];
  const places = ['signal', 'discord', 'sms'];
  const a = outcome(draft('kit', places, doc(...tree)), (k) => PROFILES[k]);
  const b = outcome(draft('kit', places, doc(part('markdown', 'Dinner is **on** at ||eight||'))), (k) => PROFILES[k]);
  for (const k of places) expect(b.sent[k].wire).toEqual(a.sent[k].wire);
  // The same things are said about it: a text message shows the hidden word.
  expect(b.exposing).toEqual(a.exposing);
  expect(b.exposing).toContain('sms');
  expect(outcome(draft('kit', ['signal'], doc(part('markdown', ''))), (k) => PROFILES[k]).empty).toBe(true);
  expect(outcome(draft('kit', ['signal'], doc(part('html', '<div> </div>', '<!-- nothing -->'))), (k) => PROFILES[k]).empty).toBe(true);
});
