/**
 * One document for everything a person writes here: a chat message, a post, a comment, a mail. It is the editor's own
 * tree (ProseMirror's JSON shape), so what is edited, what is kept as a draft and what is handed to a network's code
 * are the same value.
 *
 * - Blocks: paragraph, heading, blockquote, bulletList and orderedList (of listItem), codeBlock, horizontalRule, table
 *   (tableRow of tableCell and tableHeader), fold (a titled block the reader opens; `why` says whether it hides its
 *   inside or only saves room), image (a picture in the text, by the file it shows) and raw (a block kept exactly in a
 *   format of its own, e.g. a newsletter's HTML, with its words as `text` or as a tree in `fallback`).
 * - Text is runs: a `text` node with a set of marks. Marks never nest, so two styles may overlap freely (as Signal's
 *   and RCS's ranges do), and a network that needs nesting gets it made when the text is written out.
 * - Things in the text that are not words: mention (kind, ids by place, label), time (unix seconds), emoji (a custom
 *   one). They take styles as words do.
 * - A paragraph is one line. There is no line break inside one: a new line is a new paragraph, and an empty paragraph
 *   is an empty line. (A hardBreak from an older draft is read as that.)
 *
 * A kind this version does not know is never dropped unsaid: it goes as its words (fit.ts). A tree may come from
 * another device or a newer client, so nothing is assumed of its shape: `sound` makes any value a tree that the rest of
 * this code can walk.
 */
/** The version of this shape, for a draft that is stored. Nothing stores one yet. */
export const VERSION = 1;
export type MarkKind = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'spoiler' | 'link' | 'color' | 'sub' | 'sup';
export type BlockKind = 'heading' | 'blockquote' | 'list' | 'codeBlock' | 'horizontalRule' | 'table' | 'fold' | 'image' | 'raw';
export type EntityKind = 'mention' | 'time' | 'emoji';

export interface Mark {
  type: string;
  attrs?: Record<string, any>;
}
export interface Node {
  type: string;
  attrs?: Record<string, any>;
  content?: Node[];
  marks?: Mark[];
  text?: string;
}

export const text = (t: string, ...marks: (MarkKind | Mark)[]): Node => ({ type: 'text', text: t, ...(marks.length ? { marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)) } : {}) });
export const para = (...content: (Node | string)[]): Node => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? text(c) : c)) });
export const doc = (...content: Node[]): Node => ({ type: 'doc', content });

export const sameMark = (a: Mark, b: Mark) => a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});
const sameMarks = (a: Mark[] = [], b: Mark[] = []) => a.length === b.length && a.every((m) => b.some((n) => sameMark(m, n)));

/** Runs side by side with the same marks made one, and empty runs dropped. */
export function joinRuns(nodes: Node[]): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    if (n.type === 'text' && !n.text) continue;
    const last = out[out.length - 1];
    if (n.type === 'text' && last?.type === 'text' && sameMarks(last.marks, n.marks)) out[out.length - 1] = { ...last, text: last.text! + n.text! };
    else out.push(n.type === 'text' && n.marks && !n.marks.length ? { type: 'text', text: n.text } : n);
  }
  return out;
}

/** A time as words, for a network that has no moving times. */
const timeWords = (at: number) => new Date(at * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** What stands in the text for a thing that is not words, when a network has no such thing. */
export function standIn(n: Node): string {
  if (n.type === 'mention') return '@' + (n.attrs?.label ?? n.attrs?.id ?? '');
  if (n.type === 'time') return timeWords(n.attrs?.at ?? 0);
  if (n.type === 'emoji') return `:${n.attrs?.name ?? ''}:`;
  if (n.type === 'hardBreak') return ' ';
  return '';
}

/** The words of a node, blocks a line each. A kind not known here is read by its shape. */
export function words(n: Node): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'raw') return n.attrs?.text ?? '';
  if (n.type === 'codeBlock') return (n.content ?? []).map((c) => c.text ?? '').join('');
  if (!n.content) return standIn(n);
  if (n.type === 'tableRow') return n.content.map(words).join(' | ');
  const inline = n.content.every((c) => c.type === 'text' || (!c.content && !/^(codeBlock|raw|horizontalRule|image)$/.test(c.type)));
  return n.content.map(words).join(inline ? '' : '\n');
}

const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Characters that are not text: control characters (IRC's styles are some of them), but not a tab. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const MENTIONS = new Set(['user', 'role', 'channel', 'everyone']);
/** An id, on any network: nothing in it can end what a writer puts around it. */
const ID = /^[\w@:.+-]{1,256}$/;
const SPACE = /^[\w.:-]{1,64}$/;
const strings = (v: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(obj(v) ? v : {})
      .filter(([, x]) => typeof x === 'string' || typeof x === 'number')
      .map(([k, x]) => [k, String(x).replace(/\s/g, '')] as const)
      .filter(([, x]) => ID.test(x)),
  );
const INLINE = new Set(['text', 'mention', 'time', 'emoji', 'hardBreak']);
const HOLDS_BLOCKS = new Set(['doc', 'blockquote', 'listItem', 'fold', 'tableCell', 'tableHeader']);
/** Deeper than this nobody writes: what is below goes as its words. */
const DEEP = 40;
/** Words standing where blocks stand are a paragraph. */
const lines = (list: Node[]): Node[] => {
  const out: Node[] = [];
  let run: Node[] = [];
  const flush = () => (run.length && out.push({ type: 'paragraph', content: run }), (run = []));
  for (const c of list) INLINE.has(c.type) ? run.push(c) : (flush(), out.push(c));
  flush();
  return out;
};
/** The words under a value, by a loop: what is nested ten thousand deep must not be walked by a function calling itself. */
const wordsUnder = (v: unknown): Node[] => {
  const out: Node[] = [];
  const todo: unknown[] = [v];
  while (todo.length) {
    const x = todo.pop();
    if (!obj(x)) continue;
    if (x.type === 'text' && typeof x.text === 'string') out.push({ type: 'text', text: x.text.replace(CONTROL, '').replace(/\s+/g, ' ') });
    else if (Array.isArray(x.content)) for (let i = x.content.length - 1; i >= 0; i--) todo.push(x.content[i]);
  }
  return out;
};

/**
 * Any value as a tree of this shape, or nothing. What cannot be read is left out; what would mean something else to a
 * network's writer (a line end inside a line, a name that is not a name, a level that is not one) is made safe here,
 * once, and not in each writer.
 */
export function sound(v: unknown, inCode = false, depth = 0): Node[] {
  if (!obj(v) || typeof v.type !== 'string') return [];
  if (depth > DEEP) return wordsUnder(v);
  // An attribute is a word, a number or a yes: anything else (but the two that hold more, read below) is left out.
  const plain = (a: Record<string, any>) => Object.fromEntries(Object.entries(a).filter(([k, x]) => x === null || typeof x !== 'object' || k === 'ids' || k === 'fallback'));
  const attrs: Record<string, any> = obj(v.attrs) ? plain(v.attrs) : {};
  const marks = (Array.isArray(v.marks) ? v.marks : []).filter((m): m is Mark => obj(m) && typeof m.type === 'string').map((m) => ({ type: m.type, ...(obj(m.attrs) ? { attrs: plain(m.attrs) } : {}) }));
  const styled = marks.length ? { marks } : {};
  if (v.type === 'text') {
    const text = typeof v.text === 'string' ? v.text.replace(CONTROL, '') : '';
    if (inCode) return [{ type: 'text', text: text.replace(/\r\n?/g, '\n') }];
    // A line end inside a line is a break: fitting makes it a new line.
    return text.split(/\r\n?|\n/).flatMap((line, i): Node[] => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line, ...styled }] : [])]);
  }
  const line = (x: unknown) => String(typeof x === 'string' || typeof x === 'number' ? x : '').replace(/\s+/g, ' ').replace(CONTROL, '').trim();
  if (v.type === 'time') {
    const at = Number(attrs.at);
    if (!/^[tTdDfFR]$/.test(String(attrs.style ?? ''))) delete attrs.style;
    return Number.isFinite(at) && Math.abs(at) < 8.64e12 ? [{ type: 'time', attrs: { at, ...(attrs.style ? { style: attrs.style } : {}) }, ...styled }] : [{ type: 'text', text: '(a time)', ...styled }];
  }
  if (v.type === 'emoji') {
    const name = line(attrs.name);
    // What stands in for it where it is not known is an emoji of everyone's, never words: words would be the writer's.
    const alt = line(attrs.alt);
    const own = typeof attrs.id === 'string' && ID.test(attrs.id) && SPACE.test(String(attrs.space ?? '')) ? { id: attrs.id, space: attrs.space } : {};
    const kept = { name, ...(attrs.ids ? { ids: strings(attrs.ids) } : {}), ...(alt && !/[\p{L}\p{N}\s]/u.test(alt) && [...alt].length <= 12 ? { alt } : {}), ...own, ...(attrs.animated === true ? { animated: true } : {}) };
    return /^[\w+-]{1,64}$/.test(name) ? [{ type: 'emoji', attrs: kept, ...styled }] : name ? [{ type: 'text', text: name, ...styled }] : [];
  }
  if (v.type === 'mention') {
    const kind = MENTIONS.has(attrs.kind) ? attrs.kind : 'user';
    // An id alone is an id in one space: it is kept only with the space it is of.
    const own = ID.test(line(attrs.id)) && SPACE.test(String(attrs.space ?? '')) ? { id: line(attrs.id), space: attrs.space } : {};
    return [{ type: 'mention', attrs: { kind, label: line(attrs.label), ...(attrs.ids !== undefined ? { ids: strings(attrs.ids) } : {}), ...own }, ...styled }];
  }
  const code = v.type === 'codeBlock';
  let content = Array.isArray(v.content) ? v.content.flatMap((c) => sound(c, code, depth + 1)) : undefined;
  if (v.type === 'heading') attrs.level = Math.min(6, Math.max(1, Math.round(Number(attrs.level)) || 1));
  if (v.type === 'orderedList' && !(Number.isInteger(attrs.start) && attrs.start >= 0 && attrs.start < 1e9)) delete attrs.start;
  if (code) {
    if (!/^[\w+#.-]{1,32}$/.test(String(attrs.language ?? ''))) delete attrs.language;
    // Code is one run of text.
    return [{ type: 'codeBlock', ...(Object.keys(attrs).length ? { attrs } : {}), content: content?.length ? [{ type: 'text', text: content.map((c) => c.text ?? '').join('') }] : [] }];
  }
  if (v.type === 'fold') attrs.title = line(attrs.title);
  if (v.type === 'image') Object.assign(attrs, { src: line(attrs.src), alt: line(attrs.alt) });
  if (v.type === 'raw') {
    Object.assign(attrs, { format: line(attrs.format), source: typeof attrs.source === 'string' ? attrs.source : '', text: typeof attrs.text === 'string' ? attrs.text.replace(CONTROL, '') : '' });
    if (attrs.fallback !== undefined) attrs.fallback = Array.isArray(attrs.fallback) ? attrs.fallback.flatMap((c: unknown) => sound(c)) : [];
  }
  // Everything stands where its kind can stand, so no step after this one can drop a word for being in the wrong place.
  if (content && HOLDS_BLOCKS.has(v.type)) content = lines(content);
  if (content && (v.type === 'bulletList' || v.type === 'orderedList')) content = lines(content).map((c) => (c.type === 'listItem' ? c : { type: 'listItem', content: [c] }));
  if (content && v.type === 'table') content = content.map((c) => (c.type === 'tableRow' ? c : { type: 'tableRow', content: [{ type: 'tableCell', content: lines([c]) }] }));
  if (content && v.type === 'tableRow') content = content.map((c) => (c.type === 'tableCell' || c.type === 'tableHeader' ? c : { type: 'tableCell', content: lines([c]) }));
  return [{ type: v.type, ...(Object.keys(attrs).length ? { attrs } : {}), ...(content ? { content } : {}), ...styled }];
}

const VOID = new Set(['area', 'br', 'col', 'hr', 'img', 'source', 'track', 'wbr']);
const REACHES = /^(style|script|title|base|link|meta|plaintext|xmp|textarea|noscript|iframe|object|embed|form|input|select|frameset|frame|head|html|body|template|svg|math)$/;
/**
 * A piece of HTML keeps to itself: every element it opens it closes, in order, no comment is left open, and nothing in
 * it reaches outside (a style sheet, a title, something marked hidden). Only such a piece can stand among other text
 * as it is; anything else would swallow, restyle or uncover the text around it. A strict reading, on purpose: HTML
 * that leans on the parser to close its tags is not kept as itself.
 */
export function contained(html: string): boolean {
  const s = html.replace(/<!--[\s\S]*?-->/g, '');
  if (/<!--|<!\[CDATA\[|<\?/i.test(s)) return false;
  const open: string[] = [];
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|</g)) {
    if (m[2] === undefined) return false; // a "<" that is no tag: an attribute left open, or text never escaped
    const name = m[2].toLowerCase();
    if (REACHES.test(name) || /(^|\s)hidden(\s|=|$)/i.test(m[3])) return false;
    if (VOID.has(name) || /\/\s*$/.test(m[3])) continue;
    if (!m[1]) open.push(name);
    else if (open.pop() !== name) return false;
  }
  return open.length === 0;
}
