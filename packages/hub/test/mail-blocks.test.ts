/**
 * A mail's words as a tree (mail/blocks.ts, docs/mail.md "A mail as a chat message"): the structure it keeps, the cut at
 * the quote, when it gives up (a designed mail, the size caps), and hostile input: only text and http(s)/mailto links
 * come out. Invented text only.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { messageHtml } from '../src/mail/compose.ts';
import { carriesMore, MAX_BYTES, MAX_NODES, mailBlocks } from '../src/mail/blocks.ts';
import { sanitizeMail } from '../src/mail/sanitize.ts';

/** The tree of a mail as the hub makes it: from the sanitiser's output. */
const tree = (html: string) => mailBlocks(sanitizeMail(html, { images: 'block' }).html);
const blocks = (html: string) => {
  const t = tree(html);
  if (!('blocks' in t)) throw new Error(`no blocks: ${t.none}`);
  return t.blocks;
};

/** Every string and href in a tree, and every key its nodes have. */
function walk(bs: P.MailBlock[], out = { text: [] as string[], hrefs: [] as string[], kinds: new Set<string>(), keys: new Set<string>() }) {
  const inl = (xs: P.MailInline[]) => {
    for (const x of xs) {
      if (typeof x === 'string') out.text.push(x);
      else {
        out.kinds.add(x.t);
        for (const k of Object.keys(x)) out.keys.add(k);
        if (x.t === 'a') out.hrefs.push(x.href);
        if (x.t !== 'br') inl(x.c);
      }
    }
  };
  for (const b of bs) {
    out.kinds.add(b.t);
    for (const k of Object.keys(b)) out.keys.add(k);
    if (b.t === 'p' || b.t === 'h') inl(b.c);
    else if (b.t === 'quote') walk(b.c, out);
    else if (b.t === 'list') for (const i of b.items) walk(i, out);
    else if (b.t === 'pre') out.text.push(b.text);
  }
  return out;
}

describe('structure', () => {
  test('paragraphs, headings, lists, quotes, code, rules, marks and links', () => {
    expect(
      blocks(
        '<h1>Plan</h1><p>We <b>meet</b> at <i>noon</i>, <u>sharp</u>, <s>not</s> <code>10</code>.</p><ul><li>bread</li><li>cheese</li></ul>' +
          '<ol start="3"><li>three</li><li>four</li></ol><blockquote><p>a quote</p></blockquote><pre><code>let x = 1;\n  x += 1;</code></pre><hr>' +
          '<p><a href="https://maps.example/park">the park</a> or <a href="mailto:jo@park.example">write</a></p>',
      ),
    ).toEqual([
      { t: 'h', level: 1, c: ['Plan'] },
      { t: 'p', c: ['We ', { t: 'b', c: ['meet'] }, ' at ', { t: 'i', c: ['noon'] }, ', ', { t: 'u', c: ['sharp'] }, ', ', { t: 's', c: ['not'] }, ' ', { t: 'code', c: ['10'] }, '.'] },
      { t: 'list', ordered: false, items: [[{ t: 'p', c: ['bread'] }], [{ t: 'p', c: ['cheese'] }]] },
      { t: 'list', ordered: true, start: 3, items: [[{ t: 'p', c: ['three'] }], [{ t: 'p', c: ['four'] }]] },
      { t: 'quote', c: [{ t: 'p', c: ['a quote'] }] },
      { t: 'pre', text: 'let x = 1;\n  x += 1;' },
      { t: 'hr' },
      { t: 'p', c: [{ t: 'a', href: 'https://maps.example/park', c: ['the park'] }, ' or ', { t: 'a', href: 'mailto:jo@park.example', c: ['write'] }] },
    ]);
  });

  test('whitespace collapses as HTML does; a <div> is a line, an empty line ends a paragraph', () => {
    expect(blocks('<div dir="ltr">Hi  Sam,\n<div><br></div><div>Line <b> one </b></div><div>Line two</div><div><br></div><div>Best,</div><div>Alice</div></div>')).toEqual([
      { t: 'p', c: ['Hi Sam,'] },
      { t: 'p', c: ['Line ', { t: 'b', c: ['one'] }, { t: 'br' }, 'Line two'] },
      { t: 'p', c: ['Best,', { t: 'br' }, 'Alice'] },
    ]);
    expect(blocks('one<br><br><br>two')).toEqual([{ t: 'p', c: ['one'] }, { t: 'p', c: ['two'] }]);
  });

  test('tags left open close as HTML closes them; marks open across paragraphs carry on', () => {
    expect(blocks('<p>a<p>b<ul><li>x<li>y</ul>')).toEqual([
      { t: 'p', c: ['a'] },
      { t: 'p', c: ['b'] },
      { t: 'list', ordered: false, items: [[{ t: 'p', c: ['x'] }], [{ t: 'p', c: ['y'] }]] },
    ]);
    expect(blocks('<b><p>one</p><p>two</p></b>')).toEqual([
      { t: 'p', c: [{ t: 'b', c: ['one'] }] },
      { t: 'p', c: [{ t: 'b', c: ['two'] }] },
    ]);
    // Bold in bold is bold.
    expect(blocks('<b>a <strong>b</strong></b>')).toEqual([{ t: 'p', c: [{ t: 'b', c: ['a b'] }] }]);
  });

  test('Markdown sent from here comes back as its tree', () => {
    const html = messageHtml('new', 'See you at **7:30**!\n\n- bring the map\n- and `cash`', null, false);
    expect(blocks(html)).toEqual([
      { t: 'p', c: ['See you at ', { t: 'b', c: ['7:30'] }, '!'] },
      { t: 'list', ordered: false, items: [[{ t: 'p', c: ['bring the map'] }], [{ t: 'p', c: ['and ', { t: 'code', c: ['cash'] }] }]] },
    ]);
  });
});

describe('the quote', () => {
  test('the quoted mail goes, with its "On … wrote:" line', () => {
    expect(blocks('<p>Yes, Friday.</p><div class="gmail_quote"><div class="gmail_attr">On Mon, Sam wrote:</div><blockquote class="gmail_quote">old</blockquote></div>')).toEqual([{ t: 'p', c: ['Yes, Friday.'] }]);
    expect(blocks('<p>Yes.</p><p>On Mon, Sam &lt;sam@rivera.example&gt; wrote:</p><blockquote type="cite"><p>old</p></blockquote>')).toEqual([{ t: 'p', c: ['Yes.'] }]);
    expect(blocks('<div>Yes.</div><div id="appendonsend"></div><hr><div>From: Sam</div><div>old</div>')).toEqual([{ t: 'p', c: ['Yes.'] }]);
  });

  test('an answer between the lines keeps its quotes, as quotes', () => {
    expect(blocks('<blockquote type="cite">Friday?</blockquote><p>Yes.</p><blockquote type="cite">Noon?</blockquote><p>Better at one.</p>')).toEqual([
      { t: 'quote', c: [{ t: 'p', c: ['Friday?'] }] },
      { t: 'p', c: ['Yes.'] },
      { t: 'quote', c: [{ t: 'p', c: ['Noon?'] }] },
      { t: 'p', c: ['Better at one.'] },
    ]);
  });

  test('nothing above the quote: no tree', () => {
    expect(tree('<blockquote type="cite"><p>only old words</p></blockquote>')).toEqual({ none: 'empty' });
  });
});

describe('giving up and caps', () => {
  test('a designed mail has no tree: a table, a big picture, many small ones, backgrounds', () => {
    expect(tree('<table width="600"><tr><td><p>Sale</p></td></tr></table>')).toEqual({ none: 'designed' });
    expect(tree('<p>Look:</p><img src="https://pics.example/a.png" width="600" height="300">')).toEqual({ none: 'designed' });
    expect(tree('<p>Look:</p><img src="https://pics.example/a.png">')).toEqual({ none: 'designed' });
    expect(tree(`<p>Hi</p>${'<img src="https://pics.example/i.png" width="40" height="40">'.repeat(4)}`)).toEqual({ none: 'designed' });
    expect(tree('<div style="background:#fe0"><p>a</p></div><div bgcolor="#0ef"><p>b</p></div>')).toEqual({ none: 'designed' });
  });

  test('a small picture (a logo in a signature) is left out of the words, and their formatting stays', () => {
    expect(blocks('<p>Sounds <b>good</b>.</p><p>Alice <img src="https://logo.example/l.png" width="80" height="24" alt="logo"></p>')).toEqual([
      { t: 'p', c: ['Sounds ', { t: 'b', c: ['good'] }, '.'] },
      { t: 'p', c: ['Alice'] },
    ]);
  });

  test('a style sheet shows nothing and gives nothing', () => {
    expect(blocks('<style>p { color: red }</style><p>Hi <b>there</b></p>')).toEqual([{ t: 'p', c: ['Hi ', { t: 'b', c: ['there'] }] }]);
  });

  test(`past ${MAX_NODES} nodes or ${MAX_BYTES} bytes above the quote: no tree; a long quote under short words is fine`, () => {
    expect(tree('<p>' + 'word '.repeat(2000) + '</p>')).toEqual({ none: 'size' });
    expect(tree('<p>' + '<b>a</b> '.repeat(MAX_NODES) + '</p>')).toEqual({ none: 'size' });
    const t = tree('<p>Yes.</p><blockquote type="cite">' + '<p>old <b>words</b></p>'.repeat(3000) + '</blockquote>');
    expect(t).toEqual({ blocks: [{ t: 'p', c: ['Yes.'] }] });
  });

  test('a huge mail is not walked past its cap', () => {
    const big = '<p>' + '<i>x</i>'.repeat(200_000) + '</p>';
    const at = performance.now();
    expect(tree(big)).toEqual({ none: 'size' });
    expect(performance.now() - at).toBeLessThan(5000);
  });
});

describe('hostile input', () => {
  const hostile =
    '<script>alert("s")</script><p onclick="alert(1)" style="x:expression(alert(1))">Hi <a href="javascript:alert(1)">j1</a> <a href="jav&#x61;script:alert(2)">j2</a> ' +
    '<a href=" JaVaScRiPt:alert(3)">j3</a> <a href="data:text/html,<script>alert(4)</script>">d</a> <a href="vbscript:x">v</a> <a href="#top">here</a> ' +
    '<a href="https://ok.example/&quot;onmouseover=&quot;x">ok</a></p><iframe src="https://evil.example"></iframe><svg><script>alert(5)</script></svg>' +
    '<math><mi xlink:href="javascript:alert(6)">m</mi></math><form><input value="pw"></form><textarea><b>raw</b></textarea>' +
    '<p>&lt;b&gt;not bold&lt;/b&gt; &amp;amp; <img src=x onerror=alert(7)></p><b>left open';

  test('through the sanitiser: only text and http(s)/mailto links come out', () => {
    const w = walk(blocks(hostile));
    expect(w.hrefs).toEqual(['https://ok.example/%22onmouseover=%22x']);
    expect(w.text.join(' ')).not.toMatch(/alert|script|pw|raw/i);
    // Markup written as text stays text.
    expect(w.text.join(' ')).toContain('<b>not bold</b> &amp;');
    expect([...w.keys].every((k) => ['t', 'c', 'href', 'level', 'ordered', 'start', 'items', 'text'].includes(k))).toBe(true);
  });

  test('walked straight, unsanitised, it still gives only text and safe links', () => {
    const t = mailBlocks(hostile);
    const w = walk('blocks' in t ? t.blocks : []);
    expect(w.hrefs.every((h) => /^(https?:\/\/|mailto:)/.test(h))).toBe(true);
    expect(w.text.join(' ')).not.toMatch(/alert\(|pw|raw/);
  });

  test('deep nesting is flattened, never followed', () => {
    let deep = '';
    for (let i = 0; i < 300; i++) deep += '<blockquote><ul><li><b><i>';
    const t = tree(deep + 'bottom');
    const depth = (bs: P.MailBlock[]): number => Math.max(0, ...bs.map((b) => (b.t === 'quote' ? 1 + depth(b.c) : b.t === 'list' ? 1 + Math.max(0, ...b.items.map(depth)) : 0)));
    expect('blocks' in t && depth(t.blocks)).toBeLessThanOrEqual(6);
    expect('blocks' in t && walk(t.blocks).text.join('')).toBe('bottom');
  });
});

describe('carriesMore', () => {
  test('formatting, or a link with words of its own; not plain lines or a link that shows its address', () => {
    expect(carriesMore([{ t: 'p', c: ['plain', { t: 'br' }, 'lines'] }])).toBe(false);
    expect(carriesMore([{ t: 'p', c: [{ t: 'a', href: 'https://x.example/a', c: ['x.example/a'] }] }])).toBe(false);
    expect(carriesMore([{ t: 'p', c: [{ t: 'a', href: 'https://x.example/a', c: ['the plan'] }] }])).toBe(true);
    expect(carriesMore([{ t: 'p', c: [{ t: 'i', c: ['so'] }] }])).toBe(true);
    expect(carriesMore([{ t: 'hr' }])).toBe(true);
  });
});
