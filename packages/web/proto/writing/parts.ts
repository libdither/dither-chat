/**
 * Ways of writing, in the editor. A part of the draft may be typed as Markdown, drawn as it will read while its
 * markers stay, or as HTML, with a look at it beneath. Reading and writing them is protocol/src/writing/lens.ts; here
 * is the node, what is drawn over its lines, what the keys and the buttons do inside one, and the change from one way
 * to another.
 */
import { Extension, Node, type Editor } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as DocNode } from '../../../protocol/src/writing/doc.ts';
import { fromSource, inline, pieces, rewrite, scan, shown, toSource, type Lang, type Way } from '../../../protocol/src/writing/lens.ts';
import { live } from './live.ts';

export const PICTURE = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22120%22 height=%2270%22%3E%3Crect width=%22120%22 height=%2270%22 fill=%22%237aa7d9%22/%3E%3Ccircle cx=%2290%22 cy=%2220%22 r=%2210%22 fill=%22%23ffe08a%22/%3E%3C/svg%3E';
const THING = '\uFFFC';
const lineText = (p: PMNode) => p.textBetween(0, p.content.size, '', THING);
const linesOf = (part: PMNode) => {
  const out: string[] = [];
  part.forEach((p) => void out.push(lineText(p)));
  return out;
};
const textLine = (t: string): DocNode => (t ? { type: 'paragraph', content: [{ type: 'text', text: t }] } : { type: 'paragraph' });
const partOf = (lang: Lang, content: DocNode[]): DocNode => ({ type: 'source', attrs: { lang }, content: content.length ? content : [{ type: 'paragraph' }] });
/** An empty draft, written the way asked. */
export const blank = (way: Way): DocNode => ({ type: 'doc', content: [way === 'rich' ? { type: 'paragraph' } : partOf(way, [])] });

/** A look at HTML that runs nothing and fetches nothing: no script, and no picture or style sheet from elsewhere. */
export function sandbox() {
  const el = document.createElement('iframe');
  el.setAttribute('sandbox', 'allow-same-origin');
  let html = '';
  let ready = false;
  const put = () => {
    const body = el.contentDocument?.body;
    if (!body) return;
    body.innerHTML = html;
    el.style.height = Math.min(420, Math.max(26, body.offsetHeight + 16)) + 'px';
  };
  el.addEventListener('load', () => ((ready = true), put()));
  el.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"><style>a{pointer-events:none}</style><body style="margin:8px;font:14px system-ui;color:#1d1c1a;overflow-wrap:anywhere"></body>`;
  return { el, show: (h: string) => ((html = h), ready && put()) };
}

/** A part of the draft kept as it was typed: lines of Markdown or of HTML. Only ever at the top of a draft. */
export const Source = Node.create({
  name: 'source',
  content: 'paragraph+',
  defining: true,
  isolating: true,
  addAttributes: () => ({ lang: { default: 'markdown' } }),
  parseHTML: () => [{ tag: 'div[data-source]', getAttrs: (el) => ({ lang: (el as HTMLElement).dataset.source === 'html' ? 'html' : 'markdown' }) }],
  renderHTML: ({ node }) => ['div', { 'data-source': node.attrs.lang }, 0],
  addNodeView() {
    return ({ node }) => {
      const lang: Lang = node.attrs.lang;
      const dom = document.createElement('div');
      dom.className = `w-src w-src-${lang}`;
      const lines = document.createElement('div');
      lines.className = 'w-src-lines';
      lines.spellcheck = lang !== 'html';
      dom.append(lines);
      const mine = (n: PMNode) => n.type.name === 'source' && n.attrs.lang === lang;
      if (lang !== 'html') return { dom, contentDOM: lines, update: mine };
      // HTML is typed above and looked at below.
      const look = document.createElement('div');
      look.className = 'w-src-look';
      look.contentEditable = 'false';
      const bar = document.createElement('div');
      bar.className = 'w-raw-bar';
      const frame = sandbox();
      look.append(bar, frame.el);
      dom.append(look);
      const draw = (n: PMNode) => {
        const blocks = fromSource(n.toJSON() as DocNode);
        const kept = blocks.filter((b) => b.type === 'raw').length;
        bar.textContent = 'How it looks' + (kept ? ` · ${kept === blocks.length ? 'kept' : `${kept} of ${blocks.length} pieces kept`} exactly as typed` : '');
        frame.show(shown(blocks));
      };
      draw(node);
      return { dom, contentDOM: lines, update: (n) => mine(n) && (draw(n), true), ignoreMutation: (m) => !lines.contains(m.target) };
    };
  },
});

/** The part the caret is in, if it is in one. */
export function partAt(state: EditorState) {
  const $f = state.selection.$from;
  if ($f.depth < 2 || $f.node(1).type.name !== 'source') return null;
  const node = $f.node(1);
  return { node, pos: $f.before(1), lang: node.attrs.lang as Lang, line: $f.index(1), $f };
}
/** The way of writing at a place in the text, where it is in a part. */
export const langAt = (state: EditorState, pos: number): Lang | null => {
  const $p = state.doc.resolve(pos);
  return $p.depth >= 1 && $p.node(1).type.name === 'source' ? $p.node(1).attrs.lang : null;
};

// ---------------------------------------------------------------------------------------------- drawn as it will read

const HTML_BITS = /<!--.*?(?:-->|$)|<\/?[a-zA-Z][^<>]*>?|&#?\w+;/g;
function drawn(doc: PMNode, exposes: string, hint: string): DecorationSet {
  const out: Decoration[] = [];
  const cls = (from: number, to: number, c: string, title?: string) => void (to > from && out.push(Decoration.inline(from, to, title ? { class: c, title } : { class: c })));
  doc.forEach((node, pos) => {
    if (node.type.name !== 'source') return;
    const starts: number[] = [];
    node.forEach((_, off) => void starts.push(pos + 1 + off + 1));
    const texts = linesOf(node);
    if (doc.childCount === 1 && texts.length === 1 && !texts[0]) out.push(Decoration.node(starts[0] - 1, starts[0] + 1, { class: 'is-editor-empty', 'data-placeholder': hint }));
    if (node.attrs.lang === 'html') {
      texts.forEach((t, i) => {
        for (const m of t.matchAll(HTML_BITS)) cls(starts[i] + m.index, starts[i] + m.index + m[0].length, m[0][0] === '&' ? 'html-ent' : m[0].startsWith('<!--') ? 'html-note' : 'html-tag');
      });
      return;
    }
    scan(texts).forEach((info, i) => {
      const at = starts[i];
      const t = texts[i];
      const names = ['md-line', `md-${info.leaf}`, info.leaf === 'heading' ? `md-h${info.level}` : '', info.boxes.some((b) => b.kind === 'quote') ? 'md-quote' : '', info.boxes.some((b) => b.kind === 'item') ? 'md-item' : '', info.head ? 'md-head' : ''];
      out.push(Decoration.node(at - 1, at + t.length + 1, { class: names.filter(Boolean).join(' ') }));
      for (const [a, b] of info.pre) cls(at + a, at + b, 'md-pre');
      const styled = (from: number, to: number, table = false) => {
        const { gone, spans } = inline(t, from, to, table);
        const g = [...gone].sort((x, y) => x - y);
        for (let k = 0; k < g.length; ) {
          let e = k;
          while (e + 1 < g.length && g[e + 1] === g[e] + 1) e++;
          cls(at + g[k], at + g[e] + 1, 'md-mark');
          k = e + 1;
        }
        for (const s of spans) {
          const open = s.kind === 'spoiler' && exposes;
          cls(at + s.from, at + s.to, `md-${s.kind}${open ? ' w-exposed' : ''}`, s.kind === 'link' ? s.href : open ? `Shown openly on ${exposes}` : undefined);
        }
      };
      if (info.leaf === 'para' || info.leaf === 'heading') styled(info.at, t.length);
      else if (info.leaf === 'row') {
        const cells = info.cells ?? [];
        for (const [a, b] of cells) styled(a, b, true);
        // The bars between the cells.
        for (let k = info.at; k < t.length; k++) if (t[k] === '|' && !cells.some(([a, b]) => k >= a && k < b)) cls(at + k, at + k + 1, 'md-pre');
      }
    });
  });
  return DecorationSet.create(doc, out);
}

// ------------------------------------------------------------------------------------ the buttons and keys, in a part

/** What a style is typed as. In Markdown, what has no marker is put on the words as the style itself. */
const WRAP: Record<Lang, Record<string, [string, string]>> = {
  markdown: { bold: ['**', '**'], italic: ['*', '*'], underline: ['__', '__'], strike: ['~~', '~~'], code: ['`', '`'], spoiler: ['||', '||'], link: ['[', '](https://)'] },
  html: { bold: ['<b>', '</b>'], italic: ['<i>', '</i>'], underline: ['<u>', '</u>'], strike: ['<del>', '</del>'], code: ['<code>', '</code>'], spoiler: ['<span data-spoiler>', '</span>'], link: ['<a href="https://">', '</a>'], color: ['<span style="color:#c2410c">', '</span>'], sup: ['<sup>', '</sup>'], sub: ['<sub>', '</sub>'] },
};
const LINEWISE = new Set(['heading', 'blockquote', 'bulletList', 'orderedList', 'codeBlock']);
const REAL = new Set(['color', 'sup', 'sub', 'time', 'mention']);
const cellOf = (type: string, t: string): DocNode => ({ type, content: [textLine(t)] });
/** A block a button puts in, as the lines a part would have for it. */
const SAMPLE: Record<string, DocNode> = {
  table: { type: 'table', content: [{ type: 'tableRow', content: [cellOf('tableHeader', 'Column'), cellOf('tableHeader', 'Column')] }, { type: 'tableRow', content: [cellOf('tableCell', ''), cellOf('tableCell', '')] }] },
  horizontalRule: { type: 'horizontalRule' },
  fold: { type: 'fold', attrs: { title: 'Spoiler' }, content: [textLine('Hidden until it is opened')] },
  image: { type: 'image', attrs: { src: PICTURE, alt: 'The view from the hut' } },
};
const made = new Map<string, DocNode[] | null>();
function sample(lang: Lang, what: string): DocNode[] | null {
  const key = lang + what;
  if (!made.has(key)) {
    const out = SAMPLE[what] ? toSource([SAMPLE[what]], lang) : [];
    made.set(key, out.length === 1 && out[0].type === 'source' ? (out[0].content ?? []) : null);
  }
  return made.get(key)!;
}
/** A button has something to do in a part written this way. */
export const offers = (lang: Lang, what: string) => !!WRAP[lang][what] || LINEWISE.has(what) || (lang === 'markdown' && REAL.has(what)) || sample(lang, what) !== null;

/** A style's button or keys in a part: its markers go around the words chosen, or come away. False where it is not this file's to do. */
export function style(editor: Editor, what: string): boolean {
  const part = partAt(editor.state);
  if (!part) return false;
  const pair = WRAP[part.lang][what];
  // In Markdown a colour is put on the words themselves; in HTML there is nothing but what is typed.
  if (!pair) return part.lang === 'html';
  const [open, close] = pair;
  const { state } = editor;
  const { from, to } = state.selection;
  const spans: [number, number][] = [];
  state.doc.nodesBetween(from, to, (n, pos, parent) => {
    if (n.type.name !== 'paragraph') return true;
    if (parent?.type.name === 'source') spans.push([Math.max(from, pos + 1), Math.min(to, pos + n.nodeSize - 1)]);
    return false;
  });
  const tr = state.tr;
  let sel: [number, number] | null = null;
  for (const [a, b] of spans.reverse()) {
    const $a = state.doc.resolve(a);
    const has = state.doc.textBetween(Math.max($a.start(), a - open.length), a, '', THING) === open && state.doc.textBetween(b, Math.min($a.end(), b + close.length), '', THING) === close;
    if (has) tr.delete(b, b + close.length).delete(a - open.length, a);
    else tr.insertText(close, b).insertText(open, a);
    sel = has ? [a - open.length, b - open.length] : [a + open.length, b + open.length];
  }
  if (sel && spans.length === 1) tr.setSelection(TextSelection.create(tr.doc, sel[0], sel[1]));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** A block's button in a part: the lines chosen get its marker, or the block's own lines are put in below. */
export function block(editor: Editor, what: string): boolean {
  const part = partAt(editor.state);
  if (!part) return false;
  const { state } = editor;
  const { schema, tr } = state;
  const { node, lang } = part;
  const $t = state.selection.$to;
  const first = part.line;
  const last = $t.depth >= 2 && $t.before(1) === part.pos ? $t.index(1) : node.childCount - 1;
  const starts: number[] = [];
  node.forEach((_, off) => void starts.push(part.pos + 1 + off));
  const texts = linesOf(node);
  const end = (i: number) => starts[i] + node.child(i).nodeSize;
  const para = (t: string) => schema.nodes.paragraph.create(null, t ? schema.text(t) : null);
  /** The first `n` characters of each line chosen made `s`, from the last line up so that places stay true. */
  const each = (fn: (t: string, k: number) => [number, string]) => {
    for (let i = last; i >= first; i--) {
      const [n, s] = fn(texts[i], i - first);
      tr.insertText(s, starts[i] + 1, starts[i] + 1 + n);
    }
  };
  const around = (open: string, close: string) => void tr.insert(tr.mapping.map(end(last)), para(close)).insert(starts[first], para(open));
  const below = sample(lang, what);
  if (lang === 'markdown') {
    if (what === 'heading') each((t) => [/^#{1,6} /.exec(t)?.[0].length ?? 0, t.startsWith('## ') ? '' : '## ']);
    else if (what === 'blockquote') each((t) => (t.startsWith('> ') ? [2, ''] : [0, '> ']));
    else if (what === 'bulletList') each((t) => (/^[-+*] /.test(t) ? [2, ''] : [0, '- ']));
    else if (what === 'orderedList') each((t, k) => [/^\d{1,9}[.)] /.exec(t)?.[0].length ?? 0, /^\d{1,9}[.)] /.test(t) ? '' : `${k + 1}. `]);
    else if (what === 'codeBlock') around('```', '```');
    else if (below) tr.insert(end(last), Fragment.fromJSON(schema, below));
    else return false;
  } else {
    const inner = (t: string) => /^\s*<(div|h[1-6]|li)>(.*)<\/\1>\s*$/.exec(t)?.[2] ?? t.trim();
    if (what === 'heading') each((t) => [t.length, /^\s*<h2>/.test(t) ? `<div>${inner(t)}</div>` : `<h2>${inner(t)}</h2>`]);
    else if (what === 'blockquote') around('<blockquote>', '</blockquote>');
    else if (what === 'bulletList' || what === 'orderedList') (each((t) => [t.length, `<li>${inner(t)}</li>`]), around(what === 'bulletList' ? '<ul>' : '<ol>', what === 'bulletList' ? '</ul>' : '</ol>'));
    else if (what === 'codeBlock') tr.insert(end(last), para('<pre><code>code</code></pre>'));
    else if (below) tr.insert(end(last), Fragment.fromJSON(schema, below));
    else return true;
  }
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** What the caret is in, in a part: the blocks its line's markers say and the styles around it. Nothing outside a part. */
export function activeIn(state: EditorState): Set<string> | null {
  const part = partAt(state);
  if (!part) return null;
  const on = new Set<string>(part.$f.marks().map((m) => m.type.name));
  if (part.lang === 'html') return on;
  const texts = linesOf(part.node);
  const info = scan(texts)[part.line];
  const t = texts[part.line];
  const o = part.$f.parentOffset;
  if (info.leaf === 'heading') on.add('heading');
  if (info.leaf === 'code' || info.leaf === 'fence' || info.leaf === 'close') on.add('codeBlock');
  if (info.leaf === 'row' || info.leaf === 'delim') on.add('table');
  for (const b of info.boxes) on.add(b.kind === 'quote' ? 'blockquote' : b.ordered ? 'orderedList' : 'bulletList');
  if (info.leaf === 'para' || info.leaf === 'heading') for (const s of inline(t, info.at, t.length).spans) if (s.from <= o && o <= s.to) on.add(s.kind);
  return on;
}

/** A new line in a part, starting with `lead`. */
function newLine(editor: Editor, lead: string) {
  const tr = editor.state.tr.deleteSelection();
  const pos = tr.selection.from;
  tr.split(pos, 1);
  if (lead) tr.insertText(lead, pos + 2);
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 2 + lead.length)).scrollIntoView());
  return true;
}
function enter(editor: Editor, shift: boolean): boolean {
  const { state } = editor;
  const part = partAt(state);
  if (!part) return false;
  const { node, $f } = part;
  const texts = linesOf(node);
  const t = texts[part.line];
  // In a draft written more than one way, an empty line at the end of a part ends the part.
  if (!shift && state.selection.empty && state.doc.childCount > 1 && !t && part.line === node.childCount - 1 && node.childCount > 1) {
    const tr = state.tr.delete($f.before(2), $f.after(2));
    const after = tr.mapping.map(part.pos + node.nodeSize);
    tr.insert(after, state.schema.nodes.paragraph.create());
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
    return true;
  }
  if (part.lang === 'html') return newLine(editor, /^\s*/.exec(t)![0].slice(0, $f.parentOffset));
  const info = scan(texts)[part.line];
  // In a chat, Enter sends from a line of words; in a list, a quote, a table or a code block it is the next line.
  const plain = !info.boxes.length && (info.leaf === 'para' || info.leaf === 'heading' || info.leaf === 'rule');
  if (!shift && live.enterSends() && plain) return live.send(), true;
  if (info.boxes.length && info.leaf === 'para' && state.selection.empty && $f.parentOffset >= info.at) {
    // A marker with nothing after it: Enter ends the list or the quote.
    if (t.length === info.at) return editor.view.dispatch(state.tr.delete($f.start(), $f.end())), true;
    // More of the same: the next item, or the next line of the quote.
    const lead = info.boxes.map((b, k) => {
      const typed = t.slice(...info.pre[k]);
      if (b.kind === 'quote') return '> ';
      if (k < info.boxes.length - 1) return ' '.repeat(b.width);
      const m = /^(\d+)([.)]) $/.exec(typed);
      return m ? `${Number(m[1]) + 1}${m[2]} ` : typed;
    });
    return newLine(editor, lead.join(''));
  }
  return newLine(editor, '');
}

const KEYS: Record<string, string> = { 'Mod-b': 'bold', 'Mod-B': 'bold', 'Mod-i': 'italic', 'Mod-I': 'italic', 'Mod-u': 'underline', 'Mod-U': 'underline', 'Mod-e': 'code', 'Mod-E': 'code', 'Mod-Shift-s': 'strike', 'Mod-Shift-S': 'strike' };
const key = new PluginKey('writing-parts');
/** The keys inside a part, what is drawn over its lines, and what is pasted into one. It goes before every other key. */
export const Parts = Extension.create({
  name: 'parts',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      ...Object.fromEntries(Object.entries(KEYS).map(([k, what]) => [k, () => style(this.editor, what)])),
      Enter: () => enter(this.editor, false),
      'Shift-Enter': () => enter(this.editor, true),
      // An empty part that is not the whole draft goes away.
      Backspace: () => {
        const { state } = this.editor;
        const part = partAt(state);
        if (!part || !state.selection.empty || part.node.content.size > 2 || state.doc.childCount === 1) return false;
        const tr = state.tr.replaceWith(part.pos, part.pos + part.node.nodeSize, state.schema.nodes.paragraph.create());
        this.editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, part.pos + 1)));
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    let cache: { doc: PMNode; exposes: string; hint: string; set: DecorationSet } | null = null;
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            const exposes = live.exposes();
            const hint = live.hint();
            if (cache?.doc !== state.doc || cache.exposes !== exposes || cache.hint !== hint) cache = { doc: state.doc, exposes, hint, set: drawn(state.doc, exposes, hint) };
            return cache.set;
          },
          // What is pasted into a part is its words, line by line: a part holds what was typed, not another editor's styles.
          handlePaste: (view, event) => {
            if (!partAt(view.state)) return false;
            const text = event.clipboardData?.getData('text/plain') ?? '';
            const { schema } = view.state;
            const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => schema.nodes.paragraph.create(null, l ? schema.text(l) : null));
            view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(lines), 1, 1)).scrollIntoView());
            return true;
          },
        },
        // A draft written one way and then emptied is still written that way.
        appendTransaction: (trs, old, state) => {
          // Not when the page puts another draft in the box.
          if (trs.some((tr) => tr.getMeta('preventUpdate'))) return null;
          const only = state.doc.childCount === 1 && state.doc.firstChild!.type.name === 'paragraph' && !state.doc.firstChild!.content.size;
          if (!only || old.doc.eq(state.doc)) return null;
          const ways = new Set<string>();
          old.doc.forEach((n) => void ways.add(n.type.name === 'source' ? n.attrs.lang : 'rich'));
          if (ways.size !== 1 || ways.has('rich')) return null;
          const tr = state.tr.replaceWith(0, state.doc.content.size, state.schema.nodeFromJSON(partOf([...ways][0] as Lang, [])));
          return tr.setSelection(TextSelection.create(tr.doc, 2));
        },
      }),
    ];
  },
});

// ------------------------------------------------------------------------------------- from one way to another

/** How each block at the top of a draft is written; a block kept whole in its own format is neither. */
export const wayOf = (b: DocNode): Way | 'kept' => (b.type === 'source' ? (b.attrs?.lang === 'html' ? 'html' : 'markdown') : b.type === 'raw' ? 'kept' : 'rich');
/**
 * How the draft is written, where it is written one way: as Markdown when writing it as Markdown would change nothing
 * (a picture stands in a Markdown draft as itself).
 */
export function wayOfAll(blocks: DocNode[]): Way | null {
  const langs = new Set(blocks.filter((b) => b.type === 'source').map(wayOf));
  if (!langs.size) return 'rich';
  if (langs.size > 1) return null;
  const lang = [...langs][0] as Lang;
  // An empty line the editor keeps at the end says nothing either way.
  return blocks.every((b) => b.type === 'source' || (b.type === 'paragraph' && !b.content?.length) || toSource([b], lang)[0]?.type !== 'source') ? lang : null;
}
/** The blocks at the top of the draft that the selection touches: from which, up to which. */
export function touched(state: EditorState): [number, number] {
  const { $from, $to } = state.selection;
  const a = Math.min($from.index(0), state.doc.childCount - 1);
  const b = $to.depth === 0 && $to.pos > $from.pos ? $to.index(0) : $to.index(0) + 1;
  return [a, Math.max(a + 1, Math.min(state.doc.childCount, b))];
}

/**
 * The draft, or the part of it the selection touches, written another way. One step, so one undo takes it back. Inside
 * a Markdown part, only the blocks the selection is in are changed and the lines around them stay as typed.
 */
export function setWay(editor: Editor, to: Way, scope: 'all' | 'here'): boolean {
  const { state } = editor;
  const { doc, schema } = state;
  const [a, b] = scope === 'all' ? [0, doc.childCount] : touched(state);
  let from = 0;
  for (let i = 0; i < a; i++) from += doc.child(i).nodeSize;
  let until = from;
  let blocks: DocNode[] = [];
  for (let i = a; i < b; i++) (until += doc.child(i).nodeSize), blocks.push(doc.child(i).toJSON() as DocNode);
  // The empty line the editor keeps under a last block is not the writer's: it is not typed out as one.
  const idle = (x: DocNode) => x.type === 'paragraph' && !x.content?.length;
  if (scope === 'all' && to !== 'rich') while (blocks.length > 1 && idle(blocks[blocks.length - 1])) blocks.pop();
  let out: DocNode[];
  const part = scope === 'here' && b - a === 1 ? partAt(state) : null;
  const all = part && part.lang !== to ? pieces(blocks[0]) : [];
  const $t = state.selection.$to;
  const [l1, l2] = part ? [part.line, $t.depth >= 2 && $t.before(1) === part.pos ? $t.index(1) : part.node.childCount - 1] : [0, 0];
  const mine = all.filter((p) => p.from <= l2 && p.to > l1);
  if (part && all.length > 1 && mine.length) {
    const lines = blocks[0].content ?? [];
    const typed = (x: number, y: number) => (y > x ? [partOf(part.lang, lines.slice(x, y))] : []);
    out = [...typed(0, mine[0].from), ...rewrite(mine.flatMap((p) => p.nodes), to), ...typed(mine[mine.length - 1].to, lines.length)];
  } else {
    // A block kept whole in its own HTML, asked for by itself: its HTML to type in, or what could be read of it.
    if (scope === 'here') blocks = blocks.flatMap((x) => (x.type !== 'raw' ? [x] : to === 'html' && x.attrs?.format === 'html' ? [partOf('html', String(x.attrs.source ?? '').split('\n').map(textLine))] : to === 'rich' ? (x.attrs?.fallback?.length ? (x.attrs.fallback as DocNode[]) : String(x.attrs?.text ?? '').split('\n').map(textLine)) : [x]));
    out = rewrite(blocks, to);
  }
  // Beside a part written the same way it becomes one with it, where together they say what they said apart.
  if (scope === 'here' && to !== 'rich') {
    const typed = (i: number) => (i >= 0 && i < doc.childCount && doc.child(i).type.name === 'source' && doc.child(i).attrs.lang === to ? doc.child(i) : null);
    const [lead, tail] = [typed(a - 1), typed(b)];
    if (lead || tail) out = rewrite([...(lead ? [lead.toJSON() as DocNode] : []), ...out, ...(tail ? [tail.toJSON() as DocNode] : [])], to);
    from -= lead?.nodeSize ?? 0;
    until += tail?.nodeSize ?? 0;
  }
  if (!out.length) out = [{ type: 'paragraph' }];
  let nodes: PMNode[];
  try {
    nodes = out.map((j) => schema.nodeFromJSON(j));
    nodes.forEach((n) => n.check());
  } catch {
    return false;
  }
  const tr = state.tr.replaceWith(from, until, nodes);
  const end = from + nodes.reduce((n, x) => n + x.nodeSize, 0);
  editor.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, end - 1)), -1)).setMeta('way', to).scrollIntoView());
  editor.view.focus();
  return true;
}

/** Hidden words made plain, in every part: the style comes off, and so do the markers that say it. */
export function unhide(editor: Editor) {
  const strip = (n: DocNode): DocNode => ({ ...n, ...(n.marks ? { marks: n.marks.filter((m) => m.type !== 'spoiler') } : {}), ...(n.content ? { content: n.content.map(strip) } : {}) });
  const blocks = (editor.getJSON().content ?? []) as DocNode[];
  const next = blocks.flatMap((b) => (b.type !== 'source' ? [strip(b)] : JSON.stringify(fromSource(b)).includes('"spoiler"') ? rewrite(fromSource(b).map(strip), wayOf(b) as Lang) : [b]));
  const { state } = editor;
  editor.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, next.map((j) => state.schema.nodeFromJSON(j))));
  editor.view.focus();
}
