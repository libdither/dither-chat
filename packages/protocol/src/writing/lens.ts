/**
 * Ways of writing. The document is one tree, and a person may write a part of it another way: as Markdown, with the
 * markers left standing while they type, or as HTML. Such a part is kept in the draft as it was typed: a `source`
 * block, of lines (each a paragraph). It is read as the tree whenever the draft is fitted (fit.ts), so nothing after
 * this file knows there are ways of writing.
 *
 * - Changing the way a part is written never changes what is sent. `toSource` writes blocks out, reads its own lines
 *   back, and leaves as it is whatever does not come back the same: a block the way of writing has no words for (a
 *   picture, in Markdown) stands between the parts as itself.
 * - Reading is total: any lines are some tree, and it is the tree a draft with them in it sends.
 * - The Markdown is ours, the same wherever the draft goes: it is a way of typing, not what a network gets. A pair of
 *   markers styles what is between them, and each kind is paired by itself, so two styles may cross as they may in
 *   the tree. What no marker says (a colour, a mention) stays in the line as the thing it is.
 * - HTML is read into the tree where the tree says the same thing. A piece that says more (a style, a tag with no
 *   kind here) is kept whole, as a `raw` block with what could be read of it as its fallback.
 */
import { joinRuns, sameMark, sound, standIn, words, type Mark, type Node } from './doc.ts';

export type Lang = 'markdown' | 'html';

const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// --------------------------------------------------------------------------------------------------- the same tree

const RANK = ['link', 'color', 'bold', 'italic', 'underline', 'strike', 'sub', 'sup', 'code', 'spoiler'];
/** What an editor fills in that says nothing. */
const DEFAULT: Record<string, Record<string, unknown>> = { orderedList: { start: 1 }, tableCell: { colspan: 1, rowspan: 1 }, tableHeader: { colspan: 1, rowspan: 1 }, time: { style: 'f' } };
/** What an editor adds to a link that is not the link. */
const EDITORS = new Set(['target', 'rel', 'class']);
const tidy = (type: string, attrs: Record<string, any> | undefined, mark = false) =>
  Object.fromEntries(
    Object.entries(attrs ?? {})
      .filter(([k, v]) => v !== null && v !== undefined && DEFAULT[type]?.[k] !== v && !(mark && type === 'link' && EDITORS.has(k)))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
function norm(n: Node): Node {
  const attrs = tidy(n.type, n.attrs);
  const marks = (n.marks ?? [])
    .map((m) => {
      const a = tidy(m.type, m.attrs, true);
      return { type: m.type, ...(Object.keys(a).length ? { attrs: a } : {}) };
    })
    .sort((a, b) => RANK.indexOf(a.type) - RANK.indexOf(b.type) || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  const content = joinRuns((n.content ?? []).map(norm));
  return { type: n.type, ...(Object.keys(attrs).length ? { attrs } : {}), ...(content.length ? { content } : {}), ...(marks.length ? { marks } : {}), ...(n.type === 'text' ? { text: n.text } : {}) };
}
/** Two lists of blocks say the same thing: what an editor fills in by itself, and the order of styles, aside. */
export const same = (a: Node[], b: Node[]) => JSON.stringify(a.map(norm)) === JSON.stringify(b.map(norm));

// -------------------------------------------------------------------------------------------------------- Markdown

/** One place in a line: a character, or a thing that is not words (a mention). It keeps the styles no marker says. */
interface Cell {
  ch: string;
  node?: Node;
  marks: Mark[];
}
/** What stands in a line's characters for a thing that is not words. */
const THING = '\uFFFC';
const BY_MARKER: Record<string, string> = { bold: '**', italic: '*', underline: '__', strike: '~~', spoiler: '||' };
const TOGGLES: [string, string][] = [['**', 'bold'], ['__', 'underline'], ['~~', 'strike'], ['||', 'spoiler'], ['*', 'italic'], ['_', 'italic']];
/** What a backslash makes plain. */
const ESC = /[!-\/:-@\[-`{-~ ]/;
/** An address typed bare is words from end to end: a star in it styles nothing. */
const BARE = /(?<![\p{L}\p{N}])https?:\/\/[^\s<>\\()\uFFFC]*[^\s<>\\()\uFFFC.,;:!?'"\]*_~|`]/gu;
const LINK = /\]\(([^()\s\uFFFC]+)\)/y;
const BULLET = /([-+*]) /y;
const NUMBER = /(\d{1,9})([.)]) /y;
const DELIM = /^\|( *:?-+:? *\|)+ *$/;
const LANGUAGE = /^[\w+#.-]{1,32}$/;

function cellsOf(line: Node): Cell[] {
  const out: Cell[] = [];
  for (const n of line.content ?? []) {
    const marks = n.marks ?? [];
    if (n.type === 'text') for (let i = 0, t = n.text ?? ''; i < t.length; i++) out.push({ ch: t[i], marks });
    else out.push({ ch: THING, node: n, marks });
  }
  return out;
}
const str = (cells: Cell[]) => cells.map((c) => c.ch).join('');
const lit = (t: string): Cell[] => Array.from({ length: t.length }, (_, i) => ({ ch: t[i], marks: [] }));
const marked = (n: Node, marks: Mark[]): Node => {
  const { marks: _old, ...rest } = n;
  return marks.length ? { ...rest, marks } : rest;
};
const lineOf = (cells: Cell[]): Node => {
  const content = joinRuns(cells.map((c) => (c.node ? marked(c.node, c.marks) : marked({ type: 'text', text: c.ch }, c.marks))));
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

type Box = { kind: 'quote'; id: number } | { kind: 'item'; id: number; list: number; ordered: boolean; mark: string; width: number; start: number };
/** What one line is, read with the lines before it. */
interface LineInfo {
  /** What it sits in, outermost first. */
  boxes: Box[];
  leaf: 'para' | 'heading' | 'rule' | 'fence' | 'code' | 'close' | 'row' | 'delim';
  level?: number;
  lang?: string;
  /** Where its words start. */
  at: number;
  /** The stretches that are markers of blocks, not words. */
  pre: [number, number][];
  /** A table row's cells, and whether it is the heading row. */
  cells?: [number, number][];
  head?: boolean;
}

function marker(s: string, pos: number) {
  BULLET.lastIndex = NUMBER.lastIndex = pos;
  let m = BULLET.exec(s);
  if (m) return { ordered: false, mark: m[1], width: 2, start: 1 };
  m = NUMBER.exec(s);
  return m ? { ordered: true, mark: m[2], width: m[0].length, start: Number(m[1]) } : null;
}
const spaces = (s: string, pos: number, n: number) => {
  if (s.length - pos < n) return false;
  for (let i = pos; i < pos + n; i++) if (s[i] !== ' ') return false;
  return true;
};
/** A row's cells: between the bars no backslash stands before, less one space on each side. */
function cut(s: string, at: number): [number, number][] {
  const bars: number[] = [];
  for (let i = at; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '|') bars.push(i);
  }
  const out: [number, number][] = [];
  const cell = (from: number, to: number) => {
    if (to > from && s[from] === ' ') from++;
    if (to > from && s[to - 1] === ' ') to--;
    out.push([from, to]);
  };
  for (let k = 0; k + 1 < bars.length; k++) cell(bars[k] + 1, bars[k + 1]);
  const last = bars[bars.length - 1];
  if (last !== undefined && s.slice(last + 1).trim()) cell(last + 1, s.length);
  return out;
}

/**
 * Lines as blocks: what each line sits in (a quote, an item of a list) and what it is. A line is always one thing: a
 * new line is a new paragraph, as in the tree, so nothing is joined to the line above and no empty line is needed
 * between two blocks. A marker ends with a space ("- ", "> ", "# "), so a "-" or a "#tag" being typed is not a list or
 * a heading for a moment.
 */
export function scan(lines: string[]): LineInfo[] {
  const out: LineInfo[] = [];
  let open: Box[] = [];
  /** Inside a code block: how many backticks close it. */
  let fence = 0;
  let id = 0;
  for (const s of lines) {
    const boxes: Box[] = [];
    const pre: [number, number][] = [];
    let pos = 0;
    let kept = true;
    for (const b of open) {
      if (b.kind === 'quote') {
        if (s[pos] !== '>' || (pos + 1 < s.length && s[pos + 1] !== ' ')) {
          kept = false;
          break;
        }
        const to = Math.min(s.length, pos + 2);
        pre.push([pos, to]);
        pos = to;
        boxes.push(b);
        continue;
      }
      // More of the same item: set in as far as its words are.
      if (spaces(s, pos, b.width)) {
        pre.push([pos, pos + b.width]);
        pos += b.width;
        boxes.push(b);
        continue;
      }
      kept = false;
      // The next item of the same list.
      const m = marker(s, pos);
      if (m && m.ordered === b.ordered && m.mark === b.mark) {
        boxes.push({ kind: 'item', id: ++id, list: b.list, ...m });
        pre.push([pos, pos + m.width]);
        pos += m.width;
      }
      break;
    }
    if (fence && kept) {
      const close = /^(`{3,}) *$/.exec(s.slice(pos));
      if (close && close[1].length >= fence) {
        fence = 0;
        out.push({ boxes, leaf: 'close', at: s.length, pre: [...pre, [pos, s.length]] });
      } else out.push({ boxes, leaf: 'code', at: pos, pre });
      open = boxes;
      continue;
    }
    fence = 0;
    for (;;) {
      if (s[pos] === '>' && s[pos + 1] === ' ') {
        boxes.push({ kind: 'quote', id: ++id });
        pre.push([pos, pos + 2]);
        pos += 2;
        continue;
      }
      const m = marker(s, pos);
      if (!m) break;
      boxes.push({ kind: 'item', id: ++id, list: ++id, ...m });
      pre.push([pos, pos + m.width]);
      pos += m.width;
    }
    const rest = s.slice(pos);
    let m: RegExpExecArray | null;
    if ((m = /^(`{3,})([\w+#.-]{0,32}) *$/.exec(rest))) {
      fence = m[1].length;
      out.push({ boxes, leaf: 'fence', lang: m[2], at: s.length, pre: [...pre, [pos, s.length]] });
    } else if ((m = /^(#{1,6}) /.exec(rest))) out.push({ boxes, leaf: 'heading', level: m[1].length, at: pos + m[0].length, pre: [...pre, [pos, pos + m[0].length]] });
    else if (/^-{3,} *$/.test(rest)) out.push({ boxes, leaf: 'rule', at: s.length, pre: [...pre, [pos, s.length]] });
    else out.push({ boxes, leaf: rest[0] === '|' ? 'row' : 'para', at: pos, pre });
    open = boxes;
  }
  // A table is a row, a line of dashes between bars, and the rows after it.
  const key = (i: LineInfo) => i.boxes.map((b) => b.id).join();
  for (let i = 0; i < out.length; i++) {
    if (out[i].leaf !== 'row') continue;
    const k = key(out[i]);
    const next = out[i + 1];
    const head = cut(lines[i], out[i].at);
    if (head.length && next?.leaf === 'row' && key(next) === k && DELIM.test(lines[i + 1].slice(next.at))) {
      Object.assign(out[i], { head: true, cells: head });
      Object.assign(next, { leaf: 'delim', pre: [...next.pre, [next.at, lines[i + 1].length]], at: lines[i + 1].length });
      let j = i + 2;
      for (; out[j]?.leaf === 'row' && key(out[j]) === k; j++) out[j].cells = cut(lines[j], out[j].at);
      i = j - 1;
    } else out[i].leaf = 'para';
  }
  return out;
}

interface Span {
  from: number;
  to: number;
  kind: string;
  href?: string;
}
/**
 * The styles in a stretch of a line: which characters are markers (`gone`: they are not words) and what the words
 * between them are. Read from left to right, once: code first (nothing in it is a marker), then links, then pairs.
 */
export function inline(s: string, from: number, to: number, table = false): { gone: Set<number>; spans: Span[] } {
  const gone = new Set<number>();
  const spans: Span[] = [];
  const bare = new Uint8Array(Math.max(0, to - from));
  BARE.lastIndex = from;
  for (let m: RegExpExecArray | null; (m = BARE.exec(s)) && m.index < to; ) for (let i = m.index; i < Math.min(to, m.index + m[0].length); i++) bare[i - from] = 1;
  const ticks: [number, number][] = [];
  for (let i = from; i < to; i++) {
    if (s[i] !== '`') continue;
    let j = i;
    while (j < to && s[j] === '`') j++;
    ticks.push([i, j - i]);
    i = j - 1;
  }
  let tick = 0;
  const never = new Set<number>();
  const pairs: { at: number; mk: string; kind: string }[] = [];
  let bracket = -1;
  for (let i = from; i < to; ) {
    if (bare[i - from]) {
      i++;
      continue;
    }
    const c = s[i];
    if (c === '\\' && i + 1 < to && ESC.test(s[i + 1])) {
      gone.add(i);
      i += 2;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (i + n < to && s[i + n] === '`') n++;
      let close = -1;
      if (!never.has(n)) {
        while (tick < ticks.length && ticks[tick][0] < i + n) tick++;
        for (let k = tick; k < ticks.length && close < 0; k++) if (ticks[k][1] === n) close = ticks[k][0];
        // No end for a run this long from here: none from further on either.
        if (close < 0) never.add(n);
      }
      if (close < 0) {
        i += n;
        continue;
      }
      let a = i + n;
      let b = close;
      for (let k = i; k < a; k++) gone.add(k);
      for (let k = b; k < b + n; k++) gone.add(k);
      // One space on each side is room for a backtick at the edge, not code.
      if (b - a >= 2 && s[a] === ' ' && s[b - 1] === ' ' && /[^ ]/.test(s.slice(a, b))) {
        gone.add(a++);
        gone.add(--b);
      }
      spans.push({ from: a, to: b, kind: 'code' });
      i = close + n;
      continue;
    }
    if (table && c === '|') {
      gone.add(i++);
      continue;
    }
    if (c === '[') {
      bracket = i++;
      continue;
    }
    if (c === ']' && bracket >= 0) {
      LINK.lastIndex = i;
      const m = LINK.exec(s);
      if (m && i + m[0].length <= to) {
        gone.add(bracket);
        for (let k = i; k < i + m[0].length; k++) gone.add(k);
        spans.push({ from: bracket + 1, to: i, kind: 'link', href: m[1] });
        bracket = -1;
        i += m[0].length;
        continue;
      }
    }
    const t = TOGGLES.find(([mk]) => s.startsWith(mk, i) && i + mk.length <= to && !(table && mk === '||'));
    if (t) {
      pairs.push({ at: i, mk: t[0], kind: t[1] });
      i += t[0].length;
    } else i++;
  }
  const gap = (i: number) => i < from || i >= to || s[i] === ' ' || s[i] === '\t';
  const letter = (i: number) => i >= from && i < to && /[\p{L}\p{N}]/u.test(s[i]);
  // A star or an underscore alone between spaces is itself, and so is an underscore inside a word.
  const can = (p: { at: number; mk: string }) => (p.mk !== '*' && p.mk !== '_') || (!(gap(p.at - 1) && gap(p.at + 1)) && !(p.mk === '_' && letter(p.at - 1) && letter(p.at + 1)));
  const by = new Map<string, typeof pairs>();
  for (const p of pairs) if (can(p)) by.set(p.mk, [...(by.get(p.mk) ?? []), p]);
  for (const list of by.values())
    for (let k = 0; k + 1 < list.length; k += 2) {
      const [a, b] = [list[k], list[k + 1]];
      for (let j = 0; j < a.mk.length; j++) gone.add(a.at + j), gone.add(b.at + j);
      spans.push({ from: a.at + a.mk.length, to: b.at, kind: a.kind });
    }
  return { gone, spans };
}

/** The runs of a stretch of a line: its words with the styles their markers say, and the ones they had. */
function runs(cells: Cell[], s: string, from: number, to: number, table = false): Node[] {
  const { gone, spans } = inline(s, from, to, table);
  const said: Mark[][] = Array.from({ length: Math.max(0, to - from) }, () => []);
  for (const sp of spans)
    for (let i = sp.from; i < sp.to; i++) {
      const list = said[i - from];
      if (!list.some((m) => m.type === sp.kind)) list.push(sp.kind === 'link' ? { type: 'link', attrs: { href: sp.href } } : { type: sp.kind });
    }
  const out: Node[] = [];
  for (let i = from; i < to; i++) {
    if (gone.has(i)) continue;
    const c = cells[i];
    const all = [...c.marks, ...said[i - from].filter((m) => !c.marks.some((x) => x.type === m.type))];
    out.push(c.node ? marked(c.node, all) : marked({ type: 'text', text: c.ch }, all));
  }
  return joinRuns(out);
}
const block = (type: string, content: Node[], attrs?: Record<string, any>): Node => ({ type, ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) });

/** Lines of Markdown as blocks. */
function fromMarkdown(lines: Node[]): Node[] {
  const cells = lines.map(cellsOf);
  const strs = cells.map(str);
  const infos = scan(strs);
  const root: Node[] = [];
  const stack: { id: number; into: Node[] }[] = [];
  const lists = new Map<number, Node>();
  let code: { node: Node; rows: string[] } | null = null;
  let table: Node | null = null;
  infos.forEach((info, i) => {
    let d = 0;
    while (d < stack.length && d < info.boxes.length && stack[d].id === info.boxes[d].id) d++;
    stack.length = d;
    for (; d < info.boxes.length; d++) {
      const b = info.boxes[d];
      const into = d ? stack[d - 1].into : root;
      if (b.kind === 'quote') {
        const q: Node = { type: 'blockquote', content: [] };
        into.push(q);
        stack.push({ id: b.id, into: q.content! });
        continue;
      }
      let list = lists.get(b.list);
      if (!list || into[into.length - 1] !== list) {
        list = b.ordered ? { type: 'orderedList', ...(b.start !== 1 ? { attrs: { start: b.start } } : {}), content: [] } : { type: 'bulletList', content: [] };
        lists.set(b.list, list);
        into.push(list);
      }
      const item: Node = { type: 'listItem', content: [] };
      list.content!.push(item);
      stack.push({ id: b.id, into: item.content! });
    }
    const into = stack.length ? stack[stack.length - 1].into : root;
    const s = strs[i];
    if (info.leaf !== 'code' && info.leaf !== 'close') code = null;
    if (info.leaf !== 'row' && info.leaf !== 'delim') table = null;
    switch (info.leaf) {
      case 'fence':
        code = { node: block('codeBlock', [], info.lang ? { language: info.lang } : undefined), rows: [] };
        into.push(code.node);
        break;
      case 'code': {
        if (!code) break;
        // Code is words only: a thing that is not words stands in it as its words.
        code.rows.push(cells[i].slice(info.at).map((c) => (c.node ? standIn(c.node) : c.ch)).join(''));
        const text = code.rows.join('\n');
        if (text) code.node.content = [{ type: 'text', text }];
        break;
      }
      case 'close':
      case 'delim':
        break;
      case 'heading':
        into.push(block('heading', runs(cells[i], s, info.at, s.length), { level: info.level }));
        break;
      case 'rule':
        into.push({ type: 'horizontalRule' });
        break;
      case 'row': {
        if (info.head || !table) {
          table = { type: 'table', content: [] };
          into.push(table);
        }
        const kind = info.head ? 'tableHeader' : 'tableCell';
        const row = (info.cells?.length ? info.cells : [[s.length, s.length] as [number, number]]).map(([a, b]) => block(kind, [block('paragraph', runs(cells[i], s, a, b, true))]));
        table.content!.push({ type: 'tableRow', content: row });
        break;
      }
      default:
        into.push(block('paragraph', runs(cells[i], s, info.at, s.length)));
    }
  });
  return root;
}

interface Piece extends Cell {
  role: 'word' | 'mark' | 'esc';
  /** Which character of the words it is, or goes before. */
  k?: number;
  /** The style a marker is of. */
  kind?: string;
  /** Inside code written between backticks: nothing there can be made plain by a backslash. */
  code?: boolean;
}
const has = (n: Node, type: string) => !!n.marks?.some((m) => m.type === type);
const tickRun = (s: string) => Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));

/** The cells of a line for these runs: markers where a style starts and ends, the words between. */
function build(nodes: Node[], real: Set<string>, escaped: Set<number>, table: boolean): Piece[] {
  const out: Piece[] = [];
  const mark = (t: string, kind: string) => {
    for (let i = 0; i < t.length; i++) out.push({ ch: t[i], marks: [], role: 'mark', kind });
  };
  const kinds = Object.keys(BY_MARKER).filter((x) => !real.has(x));
  // A link is written with brackets when its address can stand between the round ones, and it is only an address.
  const linkOf = (n: Node) => (real.has('link') ? undefined : n.marks?.find((m) => m.type === 'link' && typeof m.attrs?.href === 'string' && /^[^()\s\uFFFC]+$/.test(m.attrs.href) && Object.keys(tidy('link', m.attrs, true)).join() === 'href'));
  const shape = (n: Node) => kinds.filter((t) => has(n, t)).join() + '|' + (linkOf(n)?.attrs?.href ?? '');
  const on = new Set<string>();
  let link: Mark | undefined;
  let k = 0;
  const toggle = (n: Node | null) => {
    const l = n ? linkOf(n) : undefined;
    if (link && !(l && sameMark(l, link))) {
      mark(`](${link.attrs!.href})`, 'link');
      link = undefined;
    }
    for (const t of kinds)
      if ((n ? has(n, t) : false) !== on.has(t)) {
        mark(BY_MARKER[t], t);
        on.has(t) ? on.delete(t) : on.add(t);
      }
    if (l && !link) {
      mark('[', 'link');
      link = l;
    }
  };
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const text = n.type === 'text';
    const keep = (x: Node, code = false) => (x.marks ?? []).filter((m) => !kinds.includes(m.type) && m !== linkOf(x) && !(code && m.type === 'code'));
    if (text && has(n, 'code') && !real.has('code')) {
      // Code between backticks: a run of it with nothing else starting or ending inside.
      let j = i;
      while (j + 1 < nodes.length && nodes[j + 1].type === 'text' && has(nodes[j + 1], 'code') && shape(nodes[j + 1]) === shape(n)) j++;
      const body = nodes
        .slice(i, j + 1)
        .map((x) => x.text ?? '')
        .join('');
      if (!(table && body.includes('|'))) {
        toggle(n);
        const ticks = '`'.repeat(tickRun(body) + 1);
        const room = body[0] === '`' || body.endsWith('`') || (body[0] === ' ' && body.endsWith(' ') && /[^ ]/.test(body));
        mark(ticks + (room ? ' ' : ''), 'code');
        for (let x = i; x <= j; x++) for (const ch of lit(nodes[x].text ?? '')) out.push({ ch: ch.ch, marks: keep(nodes[x], true), role: 'word', k: k++, code: true });
        mark((room ? ' ' : '') + ticks, 'code');
        i = j;
        continue;
      }
    }
    toggle(n);
    if (!text) {
      out.push({ ch: THING, node: n, marks: keep(n), role: 'word', k: k++ });
      continue;
    }
    for (const c of lit(n.text ?? '')) {
      if (escaped.has(k)) out.push({ ch: '\\', marks: keep(n), role: 'esc', k });
      out.push({ ch: c.ch, marks: keep(n), role: 'word', k: k++ });
    }
  }
  toggle(null);
  return out;
}

/** What at the start of a line would be read as the start of a block. */
const BLOCKISH = /^(?:>|[-+*] |\d{1,9}[.)] |#{1,6} |`{3,}[\w+#.-]{0,32} *$|-{3,} *$|\|)/;

/**
 * A line for these runs. It is written, read back, and what was read another way is put right: a character taken for
 * a marker gets a backslash, a marker not taken for one means that style stays in the line as itself. So a backslash
 * stands only where one is needed, and the line always reads back as the runs, or there is no line.
 */
function writeLine(nodes: Node[], o: { table?: boolean; start?: boolean } = {}): Cell[] | null {
  const want = [block('paragraph', nodes)];
  const attempt = (real: Set<string>): Cell[] | null => {
    const escaped = new Set<number>();
    const stuck = new Set<number>();
    for (let round = 0; round < 24; round++) {
      const cells = build(nodes, real, escaped, !!o.table);
      const s = str(cells);
      let again = false;
      const escape = (c: Piece | undefined) => {
        if (!c || c.role !== 'word' || c.code || c.node || !ESC.test(c.ch) || escaped.has(c.k!) || stuck.has(c.k!)) return false;
        escaped.add(c.k!);
        return (again = true);
      };
      if (o.start && BLOCKISH.test(s)) {
        const digits = /^\d+/.exec(s)?.[0].length ?? 0;
        const first = cells[digits];
        if (first?.role === 'mark' && !real.has(first.kind!)) (real.add(first.kind!), (again = true));
        else if (!escape(first)) return null;
        continue;
      }
      const { gone } = inline(s, 0, s.length, o.table);
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (c.role === 'word' && gone.has(i)) {
          if (c.code && !real.has('code')) (real.add('code'), (again = true));
          else escape(c);
        } else if (c.role === 'mark' && !gone.has(i) && !real.has(c.kind!)) (real.add(c.kind!), (again = true));
        else if (c.role === 'esc' && !gone.has(i)) (escaped.delete(c.k!), stuck.add(c.k!), (again = true));
      }
      if (!again) return same([block('paragraph', runs(cells, s, 0, s.length, o.table))], want) ? cells : null;
    }
    return null;
  };
  // With every style left in the line as itself, only the characters need care.
  return attempt(new Set(o.table ? ['spoiler'] : [])) ?? attempt(new Set([...Object.keys(BY_MARKER), 'code', 'link']));
}

/** The lines of one block, or nothing where Markdown has no words for it. `mark` is the list marker last used beside it. */
function mdBlock(b: Node, beside: { type: string; mark: string }): { lines: Cell[][]; mark: string } | null {
  const pad = (lines: Cell[][], first: string, rest: string) => lines.map((l, i) => [...lit(i ? rest : first), ...l]);
  switch (b.type) {
    case 'paragraph': {
      const l = writeLine(b.content ?? [], { start: true });
      return l && { lines: [l], mark: '' };
    }
    case 'heading': {
      const l = writeLine(b.content ?? []);
      const level = b.attrs?.level;
      return l && Number.isInteger(level) && level >= 1 && level <= 6 ? { lines: [[...lit('#'.repeat(level) + ' '), ...l]], mark: '' } : null;
    }
    case 'blockquote': {
      const inner = mdBlocks(b.content ?? []);
      return inner?.length ? { lines: pad(inner, '> ', '> '), mark: '' } : null;
    }
    case 'bulletList':
    case 'orderedList': {
      const ordered = b.type === 'orderedList';
      // Two lists side by side are two: the second is written with the other marker.
      const mark = ordered ? (beside.type === b.type && beside.mark === '.' ? ')' : '.') : beside.type === b.type && beside.mark === '-' ? '*' : '-';
      let n = ordered && Number.isInteger(b.attrs?.start) ? (b.attrs!.start as number) : 1;
      const lines: Cell[][] = [];
      for (const item of b.content ?? []) {
        const inner = item.type === 'listItem' ? mdBlocks(item.content ?? []) : null;
        if (!inner?.length) return null;
        const head = ordered ? `${n++}${mark} ` : `${mark} `;
        lines.push(...pad(inner, head, ' '.repeat(head.length)));
      }
      return lines.length ? { lines, mark } : null;
    }
    case 'codeBlock': {
      const text = String(b.content?.[0]?.text ?? '');
      const rows = text === '' ? [] : text.split('\n');
      const ticks = '`'.repeat(Math.max(3, ...rows.map((r) => /^`*/.exec(r)![0].length + 1)));
      const language = b.attrs?.language;
      return { lines: [lit(ticks + (typeof language === 'string' && LANGUAGE.test(language) ? language : '')), ...rows.map(lit), lit(ticks)], mark: '' };
    }
    case 'horizontalRule':
      return { lines: [lit('---')], mark: '' };
    case 'table': {
      const rows = b.content ?? [];
      const lines: Cell[][] = [];
      for (const [i, row] of rows.entries()) {
        if (row.type !== 'tableRow') return null;
        const line = lit('|');
        for (const c of row.content ?? []) {
          const only = c.content?.length === 1 && c.content[0].type === 'paragraph' ? c.content[0] : null;
          const l = only && c.type === (i ? 'tableCell' : 'tableHeader') ? writeLine(only.content ?? [], { table: true }) : null;
          if (!l) return null;
          line.push(...lit(' '), ...l, ...lit(' |'));
        }
        lines.push(line);
        if (!i) lines.push(lit('|' + ' --- |'.repeat(row.content?.length ?? 0)));
      }
      return lines.length ? { lines, mark: '' } : null;
    }
    default:
      return null;
  }
}
function mdBlocks(list: Node[]): Cell[][] | null {
  const out: Cell[][] = [];
  let beside = { type: '', mark: '' };
  for (const b of list) {
    const w = mdBlock(b, beside);
    if (!w) return null;
    out.push(...w.lines);
    beside = { type: b.type, mark: w.mark };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ HTML

const TAGS: Record<string, string> = { bold: 'strong', italic: 'em', underline: 'u', strike: 'del', code: 'code', sub: 'sub', sup: 'sup' };
const MARK_OF: Record<string, string> = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', u: 'underline', del: 'strike', s: 'strike', strike: 'strike', code: 'code', sub: 'sub', sup: 'sup' };
/** Outermost first, as the mail's writer nests them (encode.ts). */
const NEST = ['spoiler', 'link', 'color', 'bold', 'italic', 'underline', 'strike', 'sub', 'sup', 'code'];
const COLOR = /^[#\w(),.% -]{1,64}$/;
const THINGS = new Set(['mention', 'time', 'emoji']);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');

function pair(m: Mark): [string, string] | null {
  const only = (...keys: string[]) => Object.keys(tidy(m.type, m.attrs, true)).every((k) => keys.includes(k));
  if (m.type === 'link') return typeof m.attrs?.href === 'string' && only('href') ? [`<a href="${attr(m.attrs.href)}">`, '</a>'] : null;
  if (m.type === 'color') return typeof m.attrs?.color === 'string' && COLOR.test(m.attrs.color) && only('color') ? [`<span style="color:${attr(m.attrs.color)}">`, '</span>'] : null;
  if (m.type === 'spoiler') return only() ? ['<span data-spoiler>', '</span>'] : null;
  return TAGS[m.type] && only() ? [`<${TAGS[m.type]}>`, `</${TAGS[m.type]}>`] : null;
}
/** A line's runs as HTML. Spaces in a row are shown as one, so every other one is written as a space that stays. */
function htmlInline(nodes: Node[]): string | null {
  let out = '';
  const open: Mark[] = [];
  const total = nodes.reduce((n, x) => n + (x.type === 'text' ? (x.text ?? '').length : 1), 0);
  let at = 0;
  let spaced = false;
  for (const n of nodes) {
    const want = [...(n.marks ?? [])].sort((a, b) => NEST.indexOf(a.type) - NEST.indexOf(b.type));
    if (want.some((m) => !pair(m))) return null;
    let k = 0;
    while (k < open.length && k < want.length && sameMark(open[k], want[k])) k++;
    while (open.length > k) out += pair(open.pop()!)![1];
    for (const m of want.slice(k)) (out += pair(m)![0]), open.push(m);
    if (n.type === 'text') {
      for (const ch of n.text ?? '') {
        const stays: boolean = ch === ' ' && (at === 0 || at === total - 1 || spaced);
        out += stays ? '&nbsp;' : ch === '\u00a0' ? '&#160;' : esc(ch);
        spaced = ch === ' ' && !stays;
        at += ch.length;
      }
    } else if (THINGS.has(n.type)) {
      out += `<span data-${n.type}="${attr(JSON.stringify(n.attrs ?? {}))}">${esc(standIn(n))}</span>`;
      spaced = false;
      at++;
    } else return null;
  }
  while (open.length) out += pair(open.pop()!)![1];
  return out;
}
/** The lines of one block as HTML, set in as it is nested, or nothing where a kind is not known here. */
function htmlBlock(b: Node, pad = ''): string[] | null {
  const inside = (list: Node[]) => {
    const out: string[] = [];
    for (const c of list) {
      const l = htmlBlock(c, pad + '  ');
      if (!l) return null;
      out.push(...l);
    }
    return out;
  };
  const wrap = (open: string, close: string, list: Node[], lead: string[] = []) => {
    const inner = inside(list);
    return inner && [pad + open, ...lead, ...inner, pad + close];
  };
  /** A cell or an item of one line is written on one line. */
  const slot = (tag: string, c: Node) => {
    const only = c.content?.length === 1 && c.content[0].type === 'paragraph' ? htmlInline(c.content[0].content ?? []) : null;
    return only !== null ? [`${pad}  <${tag}>${only}</${tag}>`] : (htmlBlock({ ...c, type: 'slot' }, pad + '  ')?.map((l, i, all) => (i === 0 ? `${pad}  <${tag}>` : i === all.length - 1 ? `${pad}  </${tag}>` : l)) ?? null);
  };
  const slots = (open: string, close: string, list: Node[], tag: (c: Node) => string | null) => {
    const out = [pad + open];
    for (const c of list) {
      const t = tag(c);
      const l = t && slot(t, c);
      if (!l) return null;
      out.push(...l);
    }
    return [...out, pad + close];
  };
  switch (b.type) {
    case 'slot':
      return wrap('', '', b.content ?? []);
    case 'paragraph': {
      const s = htmlInline(b.content ?? []);
      return s === null ? null : [`${pad}<div>${s || '<br>'}</div>`];
    }
    case 'heading': {
      const s = htmlInline(b.content ?? []);
      const level = b.attrs?.level;
      return s === null || !(Number.isInteger(level) && level >= 1 && level <= 6) ? null : [`${pad}<h${level}>${s}</h${level}>`];
    }
    case 'blockquote':
      return b.content?.length ? wrap('<blockquote>', '</blockquote>', b.content) : null;
    case 'bulletList':
      return b.content?.length ? slots('<ul>', '</ul>', b.content, (c) => (c.type === 'listItem' && c.content?.length ? 'li' : null)) : null;
    case 'orderedList':
      return b.content?.length ? slots(Number.isInteger(b.attrs?.start) && b.attrs!.start !== 1 ? `<ol start="${b.attrs!.start}">` : '<ol>', '</ol>', b.content, (c) => (c.type === 'listItem' && c.content?.length ? 'li' : null)) : null;
    case 'codeBlock': {
      const language = b.attrs?.language;
      const rows = esc(String(b.content?.[0]?.text ?? '')).split('\n');
      rows[0] = `${pad}<pre><code${typeof language === 'string' && LANGUAGE.test(language) ? ` class="language-${language}"` : ''}>${rows[0]}`;
      rows[rows.length - 1] += '</code></pre>';
      return rows;
    }
    case 'horizontalRule':
      return [pad + '<hr>'];
    case 'table': {
      const out = [pad + '<table>'];
      for (const row of b.content ?? []) {
        const l = row.type === 'tableRow' && row.content?.length ? htmlBlock({ ...row, type: 'row' }, pad + '  ') : null;
        if (!l) return null;
        out.push(...l);
      }
      return out.length > 1 ? [...out, pad + '</table>'] : null;
    }
    case 'row':
      return slots('<tr>', '</tr>', b.content ?? [], (c) => (c.content?.length ? (c.type === 'tableHeader' ? 'th' : c.type === 'tableCell' ? 'td' : null) : null));
    case 'fold':
      return b.content?.length ? wrap(b.attrs?.why === 'long' ? '<details data-why="long">' : '<details>', '</details>', b.content, [`${pad}  <summary>${esc(String(b.attrs?.title ?? ''))}</summary>`]) : null;
    case 'image':
      return typeof b.attrs?.src === 'string' ? [`${pad}<img src="${attr(b.attrs.src)}" alt="${attr(String(b.attrs.alt ?? ''))}">`] : null;
    case 'raw':
      return b.attrs?.format === 'html' && typeof b.attrs.source === 'string' ? b.attrs.source.split('\n') : null;
    default:
      return null;
  }
}

/** A piece of read HTML: an element, or words. Where it stood is kept, so what is kept whole is kept as typed. */
interface El {
  tag: string;
  attrs: Record<string, string>;
  kids: El[];
  text?: string;
  from: number;
  to: number;
  /** It was not written out in full: never closed, or closed out of turn. */
  torn?: boolean;
}
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const VERBATIM = /^(script|style|textarea|title|xmp)$/;
const BLOCK = /^(div|p|h[1-6]|blockquote|ul|ol|li|pre|hr|table|thead|tbody|tfoot|tr|td|th|details|summary|img|section|article|header|footer|main|nav|aside|center|figure|figcaption|address|form|fieldset|dl|dt|dd|script|style|template|head|title|meta|link|body|html)$/;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** A space written to stay, until it is known whether it stood for a space in a row or for one that does not break. */
const STAYS = '\uE000';

function parseHtml(html: string): El[] {
  const root: El = { tag: '', attrs: {}, kids: [], from: 0, to: html.length };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const TOKEN = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/([a-zA-Z][\w:-]*)[^>]*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  for (let m: RegExpExecArray | null; (m = TOKEN.exec(html)); ) {
    const [all, close, open, rest] = m;
    const from = m.index;
    const to = from + all.length;
    if (close !== undefined) {
      const name = close.toLowerCase();
      const at = stack.map((e) => e.tag).lastIndexOf(name);
      if (at <= 0) {
        top().kids.push({ tag: '#stray', attrs: {}, kids: [], from, to });
        continue;
      }
      while (stack.length > at + 1) Object.assign(stack.pop()!, { to: from, torn: true });
      stack.pop()!.to = to;
    } else if (open !== undefined) {
      const tag = open.toLowerCase();
      const attrs: Record<string, string> = {};
      for (const a of rest.matchAll(/([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '').split(STAYS).join('\u00a0');
      const el: El = { tag, attrs, kids: [], from, to };
      top().kids.push(el);
      if (VOID.has(tag)) continue;
      if (VERBATIM.test(tag)) {
        // What is in a style sheet or a script is not HTML: it runs to the tag that closes it.
        const end = new RegExp(`</${tag}[^>]*>`, 'gi');
        end.lastIndex = to;
        const e = end.exec(html);
        el.kids.push({ tag: '#text', attrs: {}, kids: [], text: html.slice(to, e ? e.index : html.length), from: to, to: e ? e.index : html.length });
        el.to = TOKEN.lastIndex = e ? e.index + e[0].length : html.length;
        el.torn = !e;
        continue;
      }
      stack.push(el);
    } else if (all.startsWith('<!')) top().kids.push({ tag: '#comment', attrs: {}, kids: [], from, to });
    else top().kids.push({ tag: '#text', attrs: {}, kids: [], text: all, from, to });
  }
  while (stack.length > 1) Object.assign(stack.pop()!, { to: html.length, torn: true });
  return root.kids;
}
/** Text as its characters: the references a writer here uses, and numbers. A name not known here is left as typed. */
function decode(s: string, flaw?: () => void): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|\w{1,32});/gi, (all, name: string) => {
    const k = name.toLowerCase();
    if (k === 'nbsp') return STAYS;
    if (NAMED[k]) return NAMED[k];
    const n = k[0] === '#' ? (k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)) : NaN;
    if (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n);
    flaw?.();
    return all;
  });
}

const BR: Node = { type: '#br' };
/**
 * Read HTML as blocks. `flaw` is called for all that the tree does not say as the HTML does: the piece it is in is then
 * kept whole, and what is made here is only its fallback.
 */
function blocksOf(kids: El[], flaw: () => void): Node[] {
  const out: Node[] = [];
  let run: Node[] = [];
  const flush = () => {
    // Lines: the runs between breaks, with spaces as HTML shows them. A break at the very end makes no line.
    const lines: Node[][] = [[]];
    for (const n of run) n === BR ? lines.push([]) : lines[lines.length - 1].push(n);
    run = [];
    if (lines.length > 1 && !lines[lines.length - 1].some((n) => n.type !== 'text' || n.text!.trim())) lines.pop();
    else if (lines.length === 1 && !lines[0].some((n) => n.type !== 'text' || /[^ \t\n\r\f]/.test(n.text!))) return;
    for (const line of lines) out.push(block('paragraph', settle(line)));
  };
  const walk = (el: El, marks: Mark[]) => {
    if (el.torn) flaw();
    if (el.tag === '#text') return void (el.text && run.push(marked({ type: 'text', text: decode(el.text, flaw) }, marks)));
    if (el.tag === '#comment' || el.tag === '#stray') return flaw();
    if (el.tag === 'br') {
      if (Object.keys(el.attrs).length) flaw();
      return void run.push(BR);
    }
    const names = Object.keys(el.attrs);
    const thing = [...THINGS].find((t) => el.tag === 'span' && names.length === 1 && names[0] === `data-${t}`);
    if (thing) {
      try {
        const attrs = JSON.parse(el.attrs[`data-${thing}`]);
        const made = obj(attrs) ? sound({ type: thing, attrs })[0] : undefined;
        if (made?.type === thing) return void run.push(marked(made, marks));
      } catch {}
      flaw();
    }
    let add: Mark | null = null;
    if (MARK_OF[el.tag]) add = { type: MARK_OF[el.tag] };
    else if (el.tag === 'a' && typeof el.attrs.href === 'string') add = { type: 'link', attrs: { href: el.attrs.href } };
    else if (el.tag === 'span' && 'data-spoiler' in el.attrs) add = { type: 'spoiler' };
    else if (el.tag === 'span' && /^color:\s*[^;]+;?$/.test(el.attrs.style ?? '') && COLOR.test(el.attrs.style.replace(/^color:\s*|;$/g, '').trim())) add = { type: 'color', attrs: { color: el.attrs.style.replace(/^color:\s*|;$/g, '').trim() } };
    const takes = add?.type === 'link' ? ['href'] : add?.type === 'spoiler' ? ['data-spoiler'] : add?.type === 'color' ? ['style'] : [];
    if (!add || names.some((k) => !takes.includes(k)) || (add.type === 'spoiler' && el.attrs['data-spoiler'])) flaw();
    const inner = add && !marks.some((m) => m.type === add!.type) ? [...marks, add] : marks;
    if (add && inner === marks) flaw();
    for (const k of el.kids) {
      if (BLOCK.test(k.tag)) {
        // A block inside a style: not HTML the tree can say. Its words are still read, on lines of their own.
        flaw();
        run.push(BR);
        for (const x of k.kids) walk(x, inner);
        run.push(BR);
      } else walk(k, inner);
    }
  };
  for (const el of kids) {
    if (!BLOCK.test(el.tag)) {
      walk(el, []);
      continue;
    }
    flush();
    out.push(...blockOf(el, flaw));
  }
  flush();
  return out;
}
/** Spaces as HTML shows them: a row of them is one, none at either end of a line; and what a space written to stay was. */
function settle(line: Node[]): Node[] {
  let before = ' ';
  const texts = line.map((n) => {
    if (n.type !== 'text') {
      before = 'x';
      return '';
    }
    let t = '';
    for (const ch of n.text!.replace(/[ \t\n\r\f]+/g, ' ')) {
      if (ch === ' ' && before === ' ') continue;
      t += ch;
      before = ch;
    }
    return t;
  });
  for (let i = texts.length - 1; i >= 0; i--) {
    if (line[i].type !== 'text') break;
    if (!texts[i]) continue;
    if (texts[i].endsWith(' ')) texts[i] = texts[i].slice(0, -1);
    break;
  }
  const flat = texts.map((t, i) => (line[i].type === 'text' ? t : THING)).join('');
  let at = 0;
  return joinRuns(
    line.map((n, i) => {
      if (n.type !== 'text') return (at++, n);
      let t = '';
      const edge = (c: string | undefined) => c === undefined || c === ' ' || c === STAYS;
      for (let j = 0; j < texts[i].length; j++, at++) t += texts[i][j] !== STAYS ? texts[i][j] : edge(flat[at - 1]) || edge(flat[at + 1]) ? ' ' : '\u00a0';
      return { ...n, text: t };
    }),
  );
}
const textOf = (el: El): string => (el.tag === '#text' ? decode(el.text ?? '').split(STAYS).join('\u00a0') : el.kids.map(textOf).join(''));
function blockOf(el: El, flaw: () => void): Node[] {
  if (el.torn) flaw();
  const names = Object.keys(el.attrs);
  const bare = (...ok: string[]) => {
    if (names.some((k) => !ok.includes(k))) flaw();
  };
  const inner = () => blocksOf(el.kids, flaw);
  const some = (list: Node[]) => (list.length ? list : [{ type: 'paragraph' }]);
  const blocky = el.kids.some((k) => BLOCK.test(k.tag));
  switch (el.tag) {
    case 'div':
      bare();
      // A line; or only a wrapper around other blocks, which says nothing by itself but is not ours.
      if (blocky) flaw();
      return inner();
    case 'p':
      // A <p> has room above and below that a line here does not.
      flaw();
      return inner();
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      bare();
      const lines = inner();
      if (lines.length > 1 || (lines[0] && lines[0].type !== 'paragraph')) flaw();
      return [block('heading', lines.flatMap((l) => (l.type === 'paragraph' ? (l.content ?? []) : [{ type: 'text', text: words(l) }])).filter((n) => n.type !== 'text' || n.text), { level: Number(el.tag[1]) })];
    }
    case 'blockquote': {
      bare('type');
      if (names.length && el.attrs.type !== 'cite') flaw();
      return [block('blockquote', some(inner()))];
    }
    case 'ul':
    case 'ol': {
      const start = Number(el.attrs.start ?? 1);
      el.tag === 'ol' ? bare('start') : bare();
      if (!(Number.isInteger(start) && start >= 0 && start < 1e9)) flaw();
      const items: Node[] = [];
      for (const k of el.kids) {
        if (k.tag === 'li') {
          if (Object.keys(k.attrs).length || k.torn) flaw();
          items.push(block('listItem', some(blocksOf(k.kids, flaw))));
        } else if (k.tag !== '#text' || k.text!.trim()) {
          flaw();
          items.push(block('listItem', some(blocksOf([k], flaw))));
        }
      }
      if (!items.length) return (flaw(), []);
      return [block(el.tag === 'ul' ? 'bulletList' : 'orderedList', items, el.tag === 'ol' && Number.isInteger(start) && start !== 1 && start >= 0 && start < 1e9 ? { start } : undefined)];
    }
    case 'li':
      flaw();
      return inner();
    case 'pre': {
      bare();
      const code = el.kids.length === 1 && el.kids[0].tag === 'code' ? el.kids[0] : null;
      const language = /^language-(.+)$/.exec(code?.attrs.class ?? '')?.[1];
      if (!code || code.torn || Object.keys(code.attrs).some((k) => k !== 'class') || (code.attrs.class !== undefined && !(language && LANGUAGE.test(language))) || code.kids.some((k) => k.tag !== '#text')) flaw();
      let known = true;
      for (const k of (code ?? el).kids) if (k.tag === '#text') decode(k.text ?? '', () => (known = false));
      if (!known) flaw();
      const text = textOf(el).replace(/\r\n?/g, '\n');
      return [block('codeBlock', text ? [{ type: 'text', text }] : [], language && LANGUAGE.test(language) ? { language } : undefined)];
    }
    case 'hr':
      bare();
      return [{ type: 'horizontalRule' }];
    case 'table': {
      bare();
      const rows: Node[] = [];
      const row = (tr: El) => {
        if (Object.keys(tr.attrs).length || tr.torn) flaw();
        const cells: Node[] = [];
        for (const c of tr.kids) {
          if (c.tag === 'td' || c.tag === 'th') {
            if (Object.keys(c.attrs).length || c.torn) flaw();
            cells.push(block(c.tag === 'th' ? 'tableHeader' : 'tableCell', some(blocksOf(c.kids, flaw))));
          } else if (c.tag !== '#text' || c.text!.trim()) flaw();
        }
        if (cells.length) rows.push({ type: 'tableRow', content: cells });
        else flaw();
      };
      for (const k of el.kids) {
        if (k.tag === 'tr') row(k);
        else if (/^(thead|tbody|tfoot)$/.test(k.tag)) {
          // A browser puts a body around the rows itself: it says nothing. Attributes on it do.
          if (Object.keys(k.attrs).length || k.torn) flaw();
          for (const r of k.kids) r.tag === 'tr' ? row(r) : (r.tag !== '#text' || r.text!.trim()) && flaw();
        } else if (k.tag !== '#text' || k.text!.trim()) flaw();
      }
      // Rows of unequal length are a table a browser draws, and not one the tree holds.
      if (new Set(rows.map((r) => r.content!.length)).size > 1) flaw();
      if (!rows.length) return (flaw(), []);
      return [{ type: 'table', content: rows }];
    }
    case 'details': {
      bare('data-why');
      if (names.length && el.attrs['data-why'] !== 'long') flaw();
      const kids = el.kids.filter((k) => k.tag !== '#text' || k.text!.trim());
      const summary = kids[0]?.tag === 'summary' ? kids[0] : null;
      if (!summary || Object.keys(summary.attrs).length || summary.torn || summary.kids.some((k) => k.tag !== '#text')) flaw();
      let known = true;
      for (const k of summary?.kids ?? []) if (k.tag === '#text') decode(k.text ?? '', () => (known = false));
      if (!known) flaw();
      const title = summary ? textOf(summary).replace(/\s+/g, ' ').trim() : '';
      if (summary && title !== textOf(summary)) flaw();
      return [block('fold', some(blocksOf(summary ? el.kids.filter((k) => k !== summary) : el.kids, flaw)), { title, ...(el.attrs['data-why'] === 'long' ? { why: 'long' } : {}) })];
    }
    case 'img':
      bare('src', 'alt');
      if (typeof el.attrs.src !== 'string') return (flaw(), []);
      {
        const [src, alt] = [el.attrs.src, el.attrs.alt ?? ''].map((v) => v.replace(/\s+/g, ' ').trim());
        if (src !== el.attrs.src || alt !== (el.attrs.alt ?? '')) flaw();
        return [{ type: 'image', attrs: { src, alt } }];
      }
    case 'script': case 'style': case 'template': case 'head': case 'title': case 'meta': case 'link':
      // Nothing of it is words.
      flaw();
      return [];
    default:
      // A wrapper with no kind here, or a part of a table or a list standing alone.
      flaw();
      return inner();
  }
}

/** HTML as blocks: each piece at the top is the tree where the tree says the same, or kept whole. */
function fromHtml(html: string): Node[] {
  const out: Node[] = [];
  const kids = parseHtml(html);
  for (let i = 0; i < kids.length; ) {
    // A block is a piece; so is a row of words and styles between blocks.
    let j = i + 1;
    if (!BLOCK.test(kids[i].tag)) while (j < kids.length && !BLOCK.test(kids[j].tag)) j++;
    const piece = kids.slice(i, j);
    i = j;
    let flawed = false;
    const nodes = blocksOf(piece, () => (flawed = true));
    const source = html.slice(piece[0].from, piece[piece.length - 1].to).trim();
    if (!flawed) out.push(...nodes);
    else if (source) out.push({ type: 'raw', attrs: { format: 'html', source, text: nodes.map(words).join('\n'), fallback: nodes } });
  }
  return out;
}

// --------------------------------------------------------------------------------------------------- parts of a draft

const lineText = (l: Node) => (l.content ?? []).map((n) => (n.type === 'text' ? (n.text ?? '') : standIn(n))).join('');
const part = (lang: Lang, lines: Node[]): Node => ({ type: 'source', attrs: { lang }, content: lines.length ? lines : [{ type: 'paragraph' }] });
const textLine = (t: string): Node => (t ? { type: 'paragraph', content: [{ type: 'text', text: t }] } : { type: 'paragraph' });
const langOf = (n: Node): Lang => (n.attrs?.lang === 'html' ? 'html' : 'markdown');
const linesOf = (n: Node) => (n.content ?? []).filter((l) => l.type === 'paragraph');

/** A part as the blocks it says. */
export function fromSource(n: Node): Node[] {
  const lines = linesOf(n);
  return langOf(n) === 'html' ? fromHtml(lines.map(lineText).join('\n')) : fromMarkdown(lines);
}

/**
 * Blocks written another way: parts, with between them the blocks that way of writing has no words for. Every part
 * reads back as the blocks it was made from, or it is not made.
 */
export function toSource(blocks: Node[], lang: Lang): Node[] {
  const flat = blocks.flatMap((b) => (b.type === 'source' ? fromSource(b) : [b]));
  const out: Node[] = [];
  let run: { blocks: Node[]; each: Node[][] } | null = null;
  let beside = { type: '', mark: '' };
  const flush = () => {
    if (run) {
      const all = run.each.flat();
      // Each block reads back as itself; so must they all, side by side. If not, each is a part of its own.
      if (same(fromSource(part(lang, all)), run.blocks)) out.push(part(lang, all));
      else for (const lines of run.each) out.push(part(lang, lines));
    }
    run = null;
    beside = { type: '', mark: '' };
  };
  const write = (b: Node): { lines: Node[]; mark: string } | null => {
    if (lang === 'html') {
      const l = htmlBlock(b);
      return l && { lines: l.map(textLine), mark: '' };
    }
    const w = mdBlock(b, beside);
    return w && { lines: w.lines.map(lineOf), mark: w.mark };
  };
  for (const b of flat) {
    let w = write(b);
    if (w && run && lang === 'markdown' && !same(fromMarkdown([...run.each[run.each.length - 1], ...w.lines]), [run.blocks[run.blocks.length - 1], b])) {
      // Beside the block before it, it would be read as part of that one: it starts a part of its own.
      flush();
      w = write(b);
    }
    if (!w || !same(fromSource(part(lang, w.lines)), [b])) {
      flush();
      out.push(b);
      continue;
    }
    run ??= { blocks: [], each: [] };
    run.blocks.push(b);
    run.each.push(w.lines);
    beside = { type: b.type, mark: w.mark };
  }
  flush();
  return out;
}

/** How a part of a draft is written: as the tree itself (with the editor's buttons), or typed. */
export type Way = Lang | 'rich';
/**
 * Blocks written the way asked. A part already written that way is left as it was typed, the rest is written out, and
 * two parts side by side become one where together they say what they said apart.
 */
export function rewrite(blocks: Node[], way: Way): Node[] {
  if (way === 'rich') return blocks.flatMap((b) => (b.type === 'source' ? fromSource(b) : [b]));
  const out: Node[] = [];
  let rest: Node[] = [];
  const flush = () => {
    if (rest.length) out.push(...toSource(rest, way));
    rest = [];
  };
  for (const b of blocks) {
    if (b.type === 'source' && langOf(b) === way) flush(), out.push(b);
    else rest.push(b);
  }
  flush();
  const joined: Node[] = [];
  for (const b of out) {
    const last = joined[joined.length - 1];
    if (last?.type === 'source' && b.type === 'source') {
      const one = part(way, [...linesOf(last), ...linesOf(b)]);
      if (same(fromSource(one), [...fromSource(last), ...fromSource(b)])) {
        joined[joined.length - 1] = one;
        continue;
      }
    }
    joined.push(b);
  }
  return joined;
}

/** A part by its pieces: which of its lines say which blocks. A piece can be taken out and the rest left as typed. */
export function pieces(n: Node): { from: number; to: number; nodes: Node[] }[] {
  const lines = linesOf(n);
  const all = fromSource(n);
  const out: { from: number; to: number; nodes: Node[] }[] = [];
  if (langOf(n) === 'markdown') {
    const infos = scan(lines.map((l) => str(cellsOf(l))));
    // A block at the top starts where a line sits in nothing the line above sat in, and is no further line of a code
    // block or a table.
    let top = -1;
    let prev: LineInfo | null = null;
    infos.forEach((info, i) => {
      const goesOn = info.boxes.length
        ? prev?.boxes[0]?.id === info.boxes[0].id || (info.boxes[0].kind === 'item' && prev?.boxes[0]?.kind === 'item' && prev.boxes[0].list === info.boxes[0].list)
        : !prev?.boxes.length && (info.leaf === 'code' || info.leaf === 'close' || info.leaf === 'delim' || (info.leaf === 'row' && !info.head && (prev?.leaf === 'row' || prev?.leaf === 'delim')));
      if (!goesOn || top < 0) out.push({ from: i, to: i + 1, nodes: [] }), top++;
      else out[top].to = i + 1;
      prev = info;
    });
    if (out.length !== all.length) return [{ from: 0, to: lines.length, nodes: all }];
    out.forEach((p, i) => (p.nodes = [all[i]]));
    // Each piece must say by itself what it says among the others.
    return out.every((p) => same(fromMarkdown(lines.slice(p.from, p.to)), p.nodes)) ? out : [{ from: 0, to: lines.length, nodes: all }];
  }
  return [{ from: 0, to: lines.length, nodes: all }];
}

/** A draft's blocks with every part read: what is fitted and sent. Nothing is assumed of the value. */
export function resolve(d: unknown): Node {
  const content = obj(d) && Array.isArray(d.content) ? d.content : [];
  return { type: 'doc', content: content.flatMap((b: unknown) => (obj(b) && b.type === 'source' ? fromSource(sound(b)[0] ?? { type: 'source' }) : [b as Node])) };
}

/** The HTML a part's blocks are shown as, for a look at what was typed: what is kept whole as it is. */
export function shown(blocks: Node[]): string {
  return blocks.map((b) => (b.type === 'raw' ? String(b.attrs?.source ?? '') : (htmlBlock(b)?.join('\n') ?? `<div>${esc(words(b))}</div>`))).join('\n');
}
