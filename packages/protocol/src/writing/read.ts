/**
 * A marker string read back the way its place reads it, as a tree. It is the other half of the writer in encode.ts,
 * from the same table, and it is why a marker string can be trusted: what was written is read again and compared with
 * what was meant (check.ts), so a character of the writer's own that the place would take for a style, a list or a
 * heading is found before sending, not after.
 *
 * It models each grammar by a few rules (where a marker counts, what a backslash does, how lines make paragraphs). It
 * is not the network's own parser: where a network offers one (a preview call, a published grammar), a test should hold
 * this reader to it.
 */
import type { Mark, Node } from './doc.ts';
import type { Markers, Profile } from './profile.ts';

/** The line under a table's first: dashes, with bars between. */
export const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** An address typed bare: the writer leaves it as it is, and the reader takes no markers from inside it. */
export const URL_AT = /(?<![\p{L}\p{N}])https?:\/\/[^\s<>\x00-\x1f]*[^\s<>\x00-\x1f.,;:!?'")\]*_~|]/u;
const URL_Y = new RegExp(URL_AT.source, 'uy');
const urlAt = (s: string, i: number) => {
  URL_Y.lastIndex = i;
  return URL_Y.exec(s)?.[0].length ?? 0;
};
const PUNCT = /[!-\/:-@\[-`{-~\p{P}\p{S}]/u;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;

interface Ctx {
  w: Markers;
  /** What the writer put for each mention, time and emoji: found again as that. The same string twice is two things, in order. */
  things: [string, Node[]][];
  seen: Map<string, number>;
  pairs: [string, string, string][];
  raw: boolean;
  /** A code block's first line names its language; otherwise what follows the fence there is code. */
  lang: boolean;
  /** The place's rule for where a name in the text is found (profile.ts, `apart`). */
  apart?: 'word' | 'space';
  /** Where each pair closes, once found: by the line and the place in it. */
  memo: Map<string, Map<string, number>>;
}

/**
 * The thing the writer put at `i`, if it stands there as one: a name found by its characters is another name, or none,
 * with a letter right before or after it.
 */
function thingAt(s: string, i: number, c: Ctx): [string, Node[]] | undefined {
  if (!c.apart) return c.things.find(([k]) => s.startsWith(k, i));
  const before = i > 0 ? s[i - 1] : '';
  return c.things.find(([k]) => {
    if (!s.startsWith(k, i)) return false;
    if (/^</.test(k)) return true; // between its own brackets
    if (before && (c.apart === 'space' ? !/\s/.test(before) : WORD.test(before))) return false;
    return !(NAME.test(k[k.length - 1]) || k.endsWith(':')) || !NAME.test(s[i + k.length] ?? '');
  });
}
const NAME = /[\p{L}\p{N}_]/u;

/**
 * Whether a marker at `i` may open, and one at `j` close. For * _ and ~ what counts is the whole row of that character
 * it sits in: what comes before the row and after it.
 */
function around(s: string, i: number, len: number): [string | undefined, string | undefined] {
  const ch = s[i];
  if (!/[*_~]/.test(ch)) return [s[i - 1], s[i + len]];
  let a = i;
  while (s[a - 1] === ch) a--;
  let z = i + len;
  while (s[z] === ch) z++;
  return [s[a - 1], s[z]];
}
function canOpen(s: string, i: number, op: string, c: Ctx): boolean {
  const [prev, next] = around(s, i, op.length);
  if (next === undefined || SPACE.test(next)) return false;
  if (!/^[*_~]/.test(op)) return true;
  if (c.w.reads === 'words') return prev === undefined || !WORD.test(prev);
  if (c.w.reads === 'flanking') {
    if (PUNCT.test(next) && !(prev === undefined || SPACE.test(prev) || PUNCT.test(prev))) return false;
    return op[0] !== '_' || prev === undefined || !WORD.test(prev);
  }
  return true;
}
function canClose(s: string, j: number, cl: string, c: Ctx): boolean {
  const [prev, next] = around(s, j, cl.length);
  if (prev === undefined || SPACE.test(prev)) return false;
  if (!/^[*_~]/.test(cl)) return true;
  if (c.w.reads === 'words') return next === undefined || !WORD.test(next);
  if (c.w.reads === 'flanking') {
    if (PUNCT.test(prev) && !(next === undefined || SPACE.test(next) || PUNCT.test(next))) return false;
    return cl[0] !== '_' || next === undefined || !WORD.test(next);
  }
  return true;
}

function codeSpan(s: string, i: number, c: Ctx): { text: string; end: number } | null {
  const code = c.w.marks.code;
  if (!code || !s.startsWith(code[0], i)) return null;
  if (code[0] !== '`') {
    const e = s.indexOf(code[1], i + code[0].length);
    return e < 0 ? null : { text: s.slice(i + code[0].length, e), end: e + code[1].length };
  }
  let n = 1;
  if (c.w.code2) while (s[i + n] === '`') n++;
  let j = i + n;
  while (j < s.length) {
    if (s[j] !== '`') {
      j++;
      continue;
    }
    let k = 1;
    if (c.w.code2) while (s[j + k] === '`') k++;
    if (k === n) {
      let text = s.slice(i + n, j);
      if (c.w.code2 && text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim()) text = text.slice(1, -1);
      return text ? { text, end: j + n } : null;
    }
    j += k;
  }
  return null;
}

/** Where the close of a pair is, from `from`: other pairs, code, links' addresses and escapes on the way are stepped over. */
function findClose(s: string, from: number, cl: string, c: Ctx): number {
  let known = c.memo.get(s);
  if (!known) c.memo.set(s, (known = new Map()));
  const key = `${from} ${cl}`;
  // Where a search found no close, none later in the line will: a line of a thousand lone stars is read once.
  const none = known.get(`none ${cl}`);
  if (none !== undefined && from >= none) return -1;
  if (!known.has(key)) known.set(key, closeFrom(s, from, cl, c));
  if (known.get(key)! < 0) known.set(`none ${cl}`, Math.min(none ?? Infinity, from));
  return known.get(key)!;
}
function closeFrom(s: string, from: number, cl: string, c: Ctx): number {
  let j = from;
  while (j < s.length) {
    if (s[j] === '\\' && c.w.escape && j + 1 < s.length) {
      j += 2;
      continue;
    }
    const code = codeSpan(s, j, c);
    if (code) {
      j = code.end;
      continue;
    }
    const thing = thingAt(s, j, c);
    if (thing) {
      j += thing[0].length;
      continue;
    }
    // A link is stepped over whole: its address is not text.
    if (c.w.link && s[j] === '[') {
      const close = matching(s, j, '[', ']', !!c.w.escape);
      const end = close > 0 && s[close + 1] === '(' ? matching(s, close + 1, '(', ')', false) : -1;
      if (end > 0) {
        j = end + 1;
        continue;
      }
    }
    const url = urlAt(s, j);
    if (url) {
      j += url;
      continue;
    }
    const closes = j > from && s.startsWith(cl, j) && canClose(s, j, cl, c);
    const over = (longer: boolean) => {
      for (const [, op, cl2] of c.pairs) {
        if (!s.startsWith(op, j) || op === cl || longer !== op.length > cl.length || !canOpen(s, j, op, c)) continue;
        const e = findClose(s, j + op.length, cl2, c);
        if (e >= 0) return e + cl2.length;
      }
      return -1;
    };
    // A longer marker that opens here is that marker; then the close we look for; then any other pair.
    let next = over(true);
    if (next < 0 && closes) return j;
    if (next < 0) next = over(false);
    j = next < 0 ? j + 1 : next;
  }
  return -1;
}

function matching(s: string, i: number, open: string, close: string, escapes: boolean): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (escapes && s[j] === '\\') j++;
    else if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j;
  }
  return -1;
}

function inlineOf(s: string, c: Ctx, marks: Mark[]): Node[] {
  const out: Node[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf, ...(marks.length ? { marks: [...marks] } : {}) });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && c.w.escape && i + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    const thing = thingAt(s, i, c);
    if (thing) {
      flush();
      const nth = c.seen.get(thing[0]) ?? 0;
      c.seen.set(thing[0], nth + 1);
      out.push({ ...thing[1][Math.min(nth, thing[1].length - 1)], ...(marks.length ? { marks: [...marks] } : {}) });
      i += thing[0].length;
      continue;
    }
    const code = codeSpan(s, i, c);
    if (code) {
      flush();
      out.push({ type: 'text', text: code.text, marks: [...marks, { type: 'code' }] });
      i = code.end;
      continue;
    }
    const url = urlAt(s, i);
    if (url) {
      buf += s.slice(i, i + url);
      i += url;
      continue;
    }
    if (c.w.link && ch === '[') {
      const close = matching(s, i, '[', ']', !!c.w.escape);
      const end = close > 0 && s[close + 1] === '(' ? matching(s, close + 1, '(', ')', false) : -1;
      if (end > 0) {
        flush();
        out.push(...inlineOf(s.slice(i + 1, close), c, [...marks.filter((m) => m.type !== 'link'), { type: 'link', attrs: { href: s.slice(close + 2, end) } }]));
        i = end + 1;
        continue;
      }
    }
    if (c.w.entities && ch === '&') {
      const m = /^&(amp|lt|gt|quot|nbsp|copy|#\d+);/.exec(s.slice(i));
      if (m) {
        buf += m[1] === 'amp' ? '&' : m[1] === 'lt' ? '<' : m[1] === 'gt' ? '>' : m[1] === 'quot' ? '"' : m[1] === 'nbsp' ? ' ' : m[1] === 'copy' ? '©' : String.fromCodePoint(Number(m[1].slice(1)));
        i += m[0].length;
        continue;
      }
    }
    let hit = false;
    for (const [type, op, cl] of c.pairs) {
      if (!s.startsWith(op, i) || !canOpen(s, i, op, c)) continue;
      const end = findClose(s, i + op.length, cl, c);
      if (end < 0) continue;
      flush();
      out.push(...inlineOf(s.slice(i + op.length, end), c, marks.some((m) => m.type === type) ? marks : [...marks, { type }]));
      i = end + cl.length;
      hit = true;
      break;
    }
    if (hit) continue;
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const para = (content: Node[]): Node => ({ type: 'paragraph', content });

function blocksOf(lines: string[], c: Ctx): Node[] {
  const w = c.w;
  const loose = w.para === '\n\n';
  const out: Node[] = [];
  let gap = false;
  const push = (b: Node) => {
    out.push(b);
    gap = false;
  };
  // Where spaces in a row show as one, they do across styles too, and none shows at the start or the end of a line.
  // Code keeps its own.
  const squash = (nodes: Node[]) => {
    let space = true;
    const out = nodes.map((n) => {
      if (n.type !== 'text' || n.marks?.some((m) => m.type === 'code')) {
        space = false;
        return n;
      }
      let t = '';
      for (const ch of n.text ?? '') {
        if (ch !== ' ' || !space) t += ch;
        space = ch === ' ';
      }
      return { ...n, text: t };
    });
    for (let k = out.length - 1; k >= 0 && out[k].type === 'text' && !out[k].marks?.some((m) => m.type === 'code'); k--) {
      out[k] = { ...out[k], text: out[k].text!.replace(/ +$/, '') };
      if (out[k].text) break;
    }
    return out.filter((n) => n.type !== 'text' || n.text);
  };
  const text = (l: string) => (w.collapses ? squash(inlineOf(l, c, [])) : inlineOf(l, c, []));
  const bullet = (l: string) => (w.bullet && l.startsWith(w.bullet) ? ['-', w.bullet.length] : w.bullet && /^\d+\. /.test(l) ? [/^\d+/.exec(l)![0], /^\d+\. /.exec(l)![0].length] : null) as [string, number] | null;
  const starts = (l: string) => (w.fence && /^`{3,}/.test(l)) || (w.heading && /^#{1,6} /.test(l)) || (w.quote && l.startsWith('>')) || !!bullet(l) || (w.table && l.startsWith('|')) || (c.raw && /^<(?!ins>|sub>|sup>)[a-zA-Z!]/.test(l)) || (w.rule && /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l));
  // CommonMark's own: a line four spaces or a tab in is code, a line of = or - under text makes it a heading, and a
  // line after a quote or a list item with nothing before it is drawn into it.
  const common = w.reads === 'flanking';
  const cells = (l: string) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/);
  const tableAt = (k: number) => !!w.table && /(?<!\\)\|/.test(lines[k] ?? '') && DELIMITER.test(lines[k + 1] ?? '') && (lines[k + 1] ?? '').includes('|') && cells(lines[k]).length === cells(lines[k + 1]).length;
  const lazy = (k: number) => common && loose && k < lines.length && !/^[ \t]*$/.test(lines[k]) && !starts(lines[k]) && !tableAt(k);
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^[ \t]*$/.test(l)) {
      if (loose) gap = true;
      else out.push(para([]));
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if (common && /^( {4}|\t)/.test(l)) {
      let j = i;
      while (j < lines.length && /^( {4}|\t)/.test(lines[j])) j++;
      push({ type: 'codeBlock', content: [{ type: 'text', text: lines.slice(i, j).map((x) => x.replace(/^( {4}|\t)/, '')).join('\n') }] });
      i = j;
      continue;
    }
    if (w.fence && (m = /^(`{3,})(.*)$/.exec(l))) {
      let j = i + 1;
      while (j < lines.length && !(/^`+$/.test(lines[j]) && lines[j].length >= m[1].length)) j++;
      if (j < lines.length) {
        const inner = lines.slice(i + 1, j);
        if (!c.lang && m[2]) inner.unshift(m[2]);
        if (w.fold && /^spoiler( |$)/.test(m[2])) push({ type: 'fold', attrs: { title: m[2].slice(8) }, content: blocksOf(inner, c) });
        else push({ type: 'codeBlock', ...(m[2] && c.lang ? { attrs: { language: m[2] } } : {}), content: inner.join('\n') ? [{ type: 'text', text: inner.join('\n') }] : [] });
        i = j + 1;
        continue;
      }
    }
    if (w.fold && (m = /^<details><summary>(.*)<\/summary>$/.exec(l))) {
      let depth = 1;
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].startsWith('<details>')) depth++;
        else if (lines[j] === '</details>' && --depth === 0) break;
      }
      if (j < lines.length) {
        push({ type: 'fold', attrs: { title: m[1].replace(/&lt;/g, '<').replace(/&amp;/g, '&') }, content: blocksOf(lines.slice(i + 1, j), c) });
        i = j + 1;
        continue;
      }
    }
    if (c.raw && /^<(?!ins>|sub>|sup>)[a-zA-Z!]/.test(l)) {
      let j = i;
      while (j < lines.length && !/^[ \t]*$/.test(lines[j])) j++;
      const source = lines.slice(i, j).join('\n');
      push({ type: 'raw', attrs: { format: 'html', source, text: source.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() } });
      i = j;
      continue;
    }
    if (w.image && (m = /^!\[(.*)\]\((.*)\)$/.exec(l))) {
      push({ type: 'image', attrs: { alt: m[1], src: m[2] } });
      i++;
      continue;
    }
    if (w.heading && (m = /^(#{1,6}) (.*)$/.exec(l))) {
      push({ type: 'heading', attrs: { level: m[1].length }, content: text(m[2]) });
      i++;
      continue;
    }
    if (w.rule && /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
      push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    if (w.quote && l.startsWith('>') && !(w.marks.spoiler?.[0] === '>!' && l.startsWith('>!'))) {
      let j = i;
      while (j < lines.length && (lines[j].startsWith('>') || (j > i && lazy(j) && !/^>\s*$/.test(lines[j - 1])))) j++;
      push({ type: 'blockquote', content: blocksOf(lines.slice(i, j).map((x) => x.replace(/^> ?/, '')), c) });
      i = j;
      continue;
    }
    const b = bullet(l);
    if (b) {
      const ordered = b[0] !== '-';
      const items: Node[] = [];
      while (i < lines.length) {
        const here = bullet(lines[i]);
        if (!here || (here[0] !== '-') !== ordered) break;
        const ind = w.indent === 'marker' ? ' '.repeat(here[1]) : (w.indent ?? '  ');
        const inner = [lines[i].slice(here[1])];
        i++;
        while (i < lines.length && (lines[i].startsWith(ind) || (/^[ \t]*$/.test(lines[i]) && (lines[i + 1] ?? '').startsWith(ind)) || (lazy(i) && !/^[ \t]*$/.test(lines[i - 1])))) inner.push(lines[i].startsWith(ind) ? lines[i++].slice(ind.length) : lines[i++]);
        items.push({ type: 'listItem', content: blocksOf(inner, c) });
      }
      push({ type: ordered ? 'orderedList' : 'bulletList', ...(ordered && Number(b[0]) > 1 ? { attrs: { start: Number(b[0]) } } : {}), content: items });
      continue;
    }
    if (tableAt(i)) {
      // A row is as wide as the first: what it has more is dropped, what it has less is empty.
      const wide = cells(l).length;
      const rows: Node[] = [];
      let j = i;
      for (; j < lines.length && !/^[ \t]*$/.test(lines[j]) && (j <= i + 1 || lines[j].includes('|') || !starts(lines[j])); j++) {
        if (j === i + 1) continue;
        const row = cells(lines[j]).slice(0, wide);
        while (row.length < wide) row.push('');
        rows.push({ type: 'tableRow', content: row.map((x) => ({ type: 'tableCell', content: [para(text(x.replace(/^ +| +$/g, '').replace(/\\\|/g, '|')))] })) });
      }
      push({ type: 'table', content: rows });
      i = j;
      continue;
    }
    if (!loose) {
      push(para(text(l)));
      i++;
      continue;
    }
    // Its paragraphs stand apart: lines that follow each other are one, parted by its line break, and without one two
    // lines are read as one.
    if (gap && out[out.length - 1]?.type === 'paragraph') out.push(para([]));
    let cur = '';
    let first = true;
    let level = 0;
    while (i < lines.length && !/^[ \t]*$/.test(lines[i]) && (first || (!starts(lines[i]) && !tableAt(i)) || (common && /^ {0,3}(=+|-+)\s*$/.test(lines[i])))) {
      if (!first && common && /^ {0,3}(=+|-+)\s*$/.test(lines[i])) {
        level = lines[i++].trim()[0] === '=' ? 1 : 2;
        break;
      }
      first = false;
      const line = lines[i++];
      const slashes = /\\*$/.exec(line)![0].length;
      const broke = line.endsWith('  ') ? line.replace(/ +$/, '') : slashes % 2 ? line.slice(0, -1) : null;
      if (broke === null) cur += line + ' ';
      else {
        out.push(para(text(cur + broke)));
        cur = '';
      }
    }
    if (cur) out.push(para(text(cur.slice(0, -1))));
    // The lines above a line of = or - are one heading.
    if (level) out[out.length - 1] = { type: 'heading', attrs: { level }, content: out[out.length - 1].content };
    gap = false;
  }
  return out;
}

/** The marker string `s`, written for `fitted`, as its place will read it. */
export function read(s: string, pr: Profile, fitted: Node): Node {
  const w = pr.wire as Markers;
  const by = new Map<string, Node[]>();
  const find = (n: Node) => {
    const as = n.type === 'mention' ? w.mention : n.type === 'time' ? w.time : n.type === 'emoji' ? w.emoji : undefined;
    if (as) by.set(as(n), [...(by.get(as(n)) ?? []), { type: n.type, attrs: n.attrs }]);
    for (const x of n.content ?? []) find(x);
  };
  find(fitted);
  const things = [...by.entries()].sort((a, b) => b[0].length - a[0].length);
  const pairs = Object.entries(w.marks)
    .filter(([type]) => type !== 'code')
    .map(([type, [a, b]]): [string, string, string] => [type, a, b])
    .sort((x, y) => y[1].length - x[1].length);
  const content = blocksOf(s.split('\n'), { w, things, seen: new Map(), pairs, raw: !!pr.rules?.raw?.includes('html'), lang: !!pr.rules?.codeLang, memo: new Map(), apart: pr.rules?.apart });
  // Empty lines at the start and the end are not shown.
  const empty = (b?: Node) => b?.type === 'paragraph' && !b.content?.length;
  while (empty(content[0])) content.shift();
  while (empty(content[content.length - 1])) content.pop();
  return { type: 'doc', content };
}
