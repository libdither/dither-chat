/**
 * Making a draft fit a place: every block, style and thing in the text the place cannot carry is stepped down a fixed
 * ladder to something it can, ending in plain words. Nothing here knows a network: the ladders are the document's, the
 * profile says where each stops.
 *
 * What the writer is told does not rest on the ladders remembering to say it. After fitting, the draft and the result
 * are compared (check.ts): every word must still be there, and every word that was hidden must still be hidden. A
 * ladder that forgets to say so is caught there.
 */
import { hiddenLost, wordsLost } from './check.ts';
import { resolve } from './lens.ts';
import { contained, joinRuns, sameMark, sound, standIn, words, type Mark, type Node } from './doc.ts';
import { within, type Profile } from './profile.ts';

/**
 * How much a change matters. restyled: it looks different and says the same (a heading in bold). flattened: its
 * structure becomes characters (a list as lines starting with a dash). dropped: a style is gone. exposed: something the
 * writer hid can be read. blocked: it cannot go at all.
 */
export type Level = 'restyled' | 'flattened' | 'dropped' | 'exposed' | 'blocked';
export interface Change {
  level: Level;
  key: string;
  say: string;
  n: number;
  /** The words it is about, where naming them helps: the text that was hidden, who is not told. */
  words?: string[];
}
export const RANK: Record<Level, number> = { blocked: 0, exposed: 1, flattened: 2, dropped: 3, restyled: 4 };

class Notes {
  map = new Map<string, Change>();
  /** Pictures taken out of the text, to go with the message as files. */
  files: Node[] = [];
  add(level: Level, key: string, say: string, about?: string) {
    const c = this.map.get(key) ?? { level, key, say, n: 0 };
    c.n++;
    if (about?.trim() && !c.words?.includes(about.trim())) c.words = [...(c.words ?? []), about.trim()];
    this.map.set(key, c);
  }
  list() {
    return [...this.map.values()].sort((a, b) => RANK[a.level] - RANK[b.level]);
  }
}

const MARK_NAME: Record<string, string> = { bold: 'Bold', italic: 'Italic', underline: 'Underline', code: 'Code', color: 'Colour' };
/** Styles that carry meaning step down to characters; the rest are emphasis and are dropped. */
const AS_CHARS: Record<string, { pre: string; post: string; say: string }> = {
  strike: { pre: '~', post: '~', say: 'Struck-out text is marked with ~ ~ instead' },
  sup: { pre: '^', post: '', say: 'Superscript is written after a ^' },
  sub: { pre: '_', post: '', say: 'Subscript is written after a _' },
};
const SAFE_LINK = /^(https?:|mailto:)/i;
/** A link's address as it may be sent: a web or mail address that reads as one, with nothing in it that could end it early. */
function address(raw: string, pr: Profile, ok = SAFE_LINK): string | null {
  if (!ok.test(raw)) return null;
  try {
    const url = new URL(raw);
    const href = /[\s<>"\\`\x00-\x1f]/.test(raw) ? url.href : raw;
    // In a marker string an address sits between brackets, which nothing in it may close.
    return pr.wire.family === 'markers' ? within(href) : href;
  } catch {
    return null;
  }
}
const SAFE_PICTURE = /^(https?:|data:image\/|cid:|mxc:)/i;
const WORD = /[\p{L}\p{N}_]/u;
const t = (s: string, marks?: Mark[]): Node => ({ type: 'text', text: s, ...(marks?.length ? { marks } : {}) });
const p = (content: Node[]): Node => ({ type: 'paragraph', content: joinRuns(content) });
const isInline = (n: Node) => n.type === 'text' || n.type === 'mention' || n.type === 'time' || n.type === 'emoji';
const KNOWN = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'codeBlock', 'horizontalRule', 'table', 'fold', 'image', 'raw', 'listItem', 'tableRow', 'tableCell', 'tableHeader']);
/** Whether a node of a kind not known here is a block: it holds something, or is not text. */
const isBlock = (n: Node) => !!n.content || KNOWN.has(n.type);
const hasMark = (n: Node | undefined, m: Mark | string) => !!n?.marks?.some((x) => (typeof m === 'string' ? x.type === m : sameMark(x, m)));

/** Bold on every run that can take it. */
const bolded = (nodes: Node[], pr: Profile): Node[] => nodes.map((n) => (hasMark(n, 'bold') || hasMark(n, 'code') || (n.type === 'mention' && pr.rules?.apart === 'space') ? n : { ...n, marks: [...(n.marks ?? []), { type: 'bold' }] }));
/** Hidden on everything, code too: staying hidden matters more than looking like code. */
const hidden = (nodes: Node[], pr: Profile): Node[] =>
  nodes.map((n) => {
    if (hasMark(n, 'spoiler')) return n;
    const marks = (n.marks ?? []).filter((m) => pr.rules?.marksInCode || m.type !== 'code');
    return { ...n, marks: [...marks, { type: 'spoiler' }] };
  });

/** Characters put before every line of some paragraphs: a quote's "> ", a list's dash. */
const prefix = (blocks: Node[], first: string, rest = first): Node[] => blocks.map((b, i) => (i && !b.content?.length ? p([]) : p([t(i === 0 ? first : rest), ...(b.content ?? [])])));

/** A paragraph is a line: a break inside one, from an older draft, makes two. */
function unbroken(b: Node): Node[] {
  const broken = b.content?.some((n) => n.type === 'hardBreak');
  if (b.type === 'paragraph' && broken) {
    const out: Node[][] = [[]];
    for (const n of b.content!) n.type === 'hardBreak' ? out.push([]) : out[out.length - 1].push(n);
    return out.map((content) => ({ ...b, content }));
  }
  if (b.type === 'heading' && broken) return [{ ...b, content: b.content!.map((n) => (n.type === 'hardBreak' ? t(' ') : n)) }];
  return [b];
}

/** Empty lines at the start and the end are never shown; some places show one only between two lines of text. */
function gaps(list: Node[], pr: Profile): Node[] {
  const empty = (b?: Node) => b?.type === 'paragraph' && !b.content?.length;
  const text = (b?: Node) => b?.type === 'paragraph' && !empty(b);
  let out = [...list];
  while (empty(out[0])) out.shift();
  while (empty(out[out.length - 1])) out.pop();
  if (pr.rules?.gaps !== 'one') return out;
  out = out.filter((b, i) => !(empty(b) && empty(out[i - 1])));
  return out.filter((b, i) => !empty(b) || (text(out[i - 1]) && text(out[i + 1])));
}

function inline(nodes: Node[], pr: Profile, notes: Notes): Node[] {
  const out: Node[] = [];
  const carries = (k: string) => (pr.marks as readonly string[]).includes(k);
  for (let i = 0; i < nodes.length; i++) {
    let n = nodes[i];
    if (!isInline(n)) {
      // Something this version does not know: what is in it goes on with its styles (what it hid stays hidden), and it
      // is said.
      notes.add('flattened', 'unknown', 'Something this version does not know goes as its words');
      const own = n.marks ?? [];
      const kids = (n.content ?? []).map((c) => ({ ...c, marks: [...(c.marks ?? []), ...own.filter((m) => !hasMark(c, m.type))] }));
      if (kids.length) {
        nodes = [...nodes.slice(0, i), ...kids, ...nodes.slice(i + 1)];
        i--;
        continue;
      }
      n = t(words(n), own);
    }
    // What stands right after an address is taken for part of it, by every network that finds addresses by itself:
    // a mention, a time or the words of another link are kept apart from it by a space.
    const last = nodes[i - 1];
    const to = (x?: Node) => x?.marks?.find((m) => m.type === 'link')?.attrs?.href;
    if (last?.type === 'text' && /https?:\/\/\S*$/i.test(last.text ?? '') && !hasMark(last, 'code') && (n.type !== 'text' || (to(n) !== to(last) && !/^\s/.test(n.text ?? '')))) out.push(t(' '));
    // Styles first: they sit on words and on things in the text alike.
    let kept: Mark[] = [];
    let pre = '';
    let post = '';
    let link = n.marks?.find((m) => m.type === 'link');
    for (const m of n.marks ?? []) {
      if (m.type === 'link') continue;
      if (m.type === 'color' && !/^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(String(m.attrs?.color ?? ''))) continue;
      // A style is its name, and a colour its colour: nothing else an editor put on it is kept.
      if (carries(m.type)) kept.push(m.type === 'color' ? { type: 'color', attrs: { color: String(m.attrs!.color) } } : { type: m.type });
      else if (m.type === 'spoiler') continue; // said by the check below, which looks at what is left
      else if (AS_CHARS[m.type]) {
        notes.add('flattened', m.type, AS_CHARS[m.type].say);
        if (!hasMark(nodes[i - 1], m.type)) pre += AS_CHARS[m.type].pre;
        if (!hasMark(nodes[i + 1], m.type)) post = AS_CHARS[m.type].post + post;
      } else notes.add('dropped', m.type, `${MARK_NAME[m.type] ?? m.type} is not shown`);
    }
    if (link) {
      const to = address(String(link.attrs?.href ?? '').trim(), pr);
      if (!to) notes.add('dropped', 'linkKind', 'A link that is not a web or mail address is not sent');
      link = to ? { type: 'link', attrs: { href: to } } : undefined;
    }
    let linked = !!link && carries('link');
    if (kept.some((m) => m.type === 'code') && (kept.length > 1 || linked) && !pr.rules?.marksInCode) {
      if (kept.some((m) => m.type === 'spoiler')) {
        notes.add('dropped', 'codeHidden', 'Hidden code is not shown as code');
        kept = kept.filter((m) => m.type !== 'code');
      } else {
        notes.add('dropped', 'marksInCode', 'Other styles are not shown on code');
        kept = kept.filter((m) => m.type === 'code');
        linked = false;
      }
    }
    if (n.type !== 'text') kept = kept.filter((m) => m.type !== 'code'); // a mention or a time is never code
    if (link && linked) kept.push(link);
    const lead = pre ? [t(pre, kept.filter((m) => m.type !== 'code'))] : [];
    const tail = post ? [t(post, kept.filter((m) => m.type !== 'code'))] : [];

    if (n.type === 'mention') {
      // A mention is a person, and each place knows them by an id of its own. Where the place has no mentions, or no
      // id of theirs is known there, their name goes as words: without an @ where the network would look one up and
      // could find a stranger.
      const kind = String(n.attrs?.kind ?? 'user');
      // `ids` is the person's id in each place; a mention already made for this place has its `id` alone.
      const space = pr.space ?? pr.id;
      const there = kind === 'everyone' ? 'everyone' : ((n.attrs?.ids ? n.attrs.ids[space] : n.attrs?.space === space ? n.attrs?.id : undefined) as string | undefined);
      if (pr.entities.includes('mention') && there && ((pr.rules?.mentionKinds ?? ['user']) as readonly string[]).includes(kind)) {
        // A mention is its own link. Where it is one only after a space, a style's marker before it would undo it.
        const on = pr.rules?.apart === 'space' ? [] : kept.filter((m) => m.type !== 'link');
        if (pr.rules?.apart === 'space' && kept.some((m) => m.type !== 'link')) notes.add('dropped', 'mentionStyle', 'A mention is not styled there');
        out.push(...lead, { type: 'mention', attrs: { kind, id: there, space, label: n.attrs?.label ?? (kind === 'everyone' ? 'everyone' : '') }, ...(on.length ? { marks: on } : {}) }, ...tail);
      }
      else {
        notes.add('flattened', 'mention', 'A mention goes as a name and tells nobody', String(n.attrs?.label ?? ''));
        // The name is someone's own choice of words: an @ or a u/ in it must not tell a stranger either.
        const name = String(n.attrs?.label ?? '').replace(/@/g, '').replace(/\b([ur])\/(?=\w)/gi, '$1 /').trim();
        out.push(...lead, t((pr.rules?.findsMentions ? '' : '@') + name, kept), ...tail);
      }
    } else if (n.type === 'time' || n.type === 'emoji') {
      // A custom emoji, like a person, has an id of its own in each place that knows it by one.
      const space = pr.space ?? pr.id;
      const id = n.type === 'emoji' && pr.rules?.emojiById ? (n.attrs?.ids ? n.attrs.ids[space] : n.attrs?.space === space ? n.attrs?.id : undefined) : true;
      const thing = n.type === 'emoji' ? { type: 'emoji', attrs: { name: n.attrs?.name, ...(n.attrs?.alt ? { alt: n.attrs.alt } : {}), ...(typeof id === 'string' ? { id, space } : {}), ...(n.attrs?.animated ? { animated: true } : {}) } } : n;
      if ((pr.entities as readonly string[]).includes(n.type) && id) out.push(...lead, { ...thing, ...(kept.length ? { marks: kept } : { marks: undefined }) }, ...tail);
      else {
        if (n.type === 'time') notes.add('flattened', 'time', 'A time is written out in one time zone, not each reader’s own');
        else notes.add('flattened', 'emoji', 'A custom emoji goes as its name');
        out.push(...lead, t(standIn(n), kept), ...tail);
      }
    } else {
      const [, a, core, z] = /^(\s*)([\s\S]*?)(\s*)$/.exec(n.text ?? '')!;
      out.push(t(a, kept), ...(core ? lead : []), t(core, kept), ...(core ? tail : []), t(z, kept));
    }

    if (link && !linked && !hasMark(nodes[i + 1], link)) {
      // The address after the last run of the same link, unless the words are the address.
      let shown = '';
      for (let j = i; j >= 0 && hasMark(nodes[j], link); j--) shown = (nodes[j].type === 'text' ? nodes[j].text : standIn(nodes[j])) + shown;
      const href = String(link.attrs?.href ?? '');
      if (shown.trim() !== href) {
        notes.add('restyled', 'link', 'A link shows its address after its words');
        // A hidden link's address is hidden too, and what follows does not run into the address.
        const next = nodes[i + 1];
        const apart = next && !(next.type === 'text' && /^\s/.test(next.text ?? '')) ? ' ' : '';
        out.push(t(` (${href})${apart}`, kept.filter((m) => m.type === 'spoiler')));
      }
    }
  }
  const done = joinRuns(out.map((n) => (n.marks === undefined ? (({ marks: _m, ...rest }) => rest)(n as Node & { marks?: Mark[] }) : n)));
  const rule = pr.rules?.apart;
  if (!rule) return done;
  // Where a mention or a named emoji is found by its characters, what stands right beside it may make it another name,
  // or none: a space keeps them apart.
  const found = (n?: Node) => n?.type === 'mention' || (n?.type === 'emoji' && !pr.rules?.emojiById);
  const apart: Node[] = [];
  done.forEach((n, i) => {
    const prev = done[i - 1];
    const next = done[i + 1];
    // Code keeps its spaces inside its markers, so what stands before is the marker.
    const before = prev?.type === 'text' && !hasMark(prev, 'code') ? prev.text!.slice(-1) : prev ? 'x' : '';
    if (found(n) && before && (rule === 'space' ? !/\s/.test(before) : WORD.test(before))) apart.push(t(' '));
    apart.push(n);
    if (found(n) && next?.type === 'text' && WORD.test(next.text![0]) && (rule === 'word' || n.type === 'emoji')) apart.push(t(' '));
  });
  return joinRuns(apart);
}

interface Depth {
  quote: number;
  list: number;
  /** Inside something the writer hid: 'kept' where the place still hides it as a block, 'open' where it does not. */
  hidden?: 'kept' | 'open';
}

/**
 * Blocks side by side, as every place reads them: two lists of one kind are one list (no network can say otherwise);
 * where blocks follow each other with nothing between, two quotes are one quote and two tables need an empty line.
 */
function settle(list: Node[], pr: Profile): Node[] {
  const out: Node[] = [];
  for (const b of list) {
    const last = out[out.length - 1];
    const joins = b.type === 'bulletList' || b.type === 'orderedList' || (b.type === 'blockquote' && pr.rules?.tight);
    // A table there takes the lines right above and below it for its own: an empty line stands between.
    const blank = (x: Node) => x.type === 'paragraph' && !x.content?.length;
    if (pr.rules?.tight && last && (last.type === 'table' || b.type === 'table') && !blank(last) && !blank(b)) out.push(p([]));
    if (last && last.type === b.type && joins) {
      const content = [...(last.content ?? []), ...(b.content ?? [])];
      out[out.length - 1] = { ...last, content: b.type === 'blockquote' ? settle(content, pr) : content };
    } else out.push(b);
  }
  return out;
}

function blocks(list: Node[], pr: Profile, notes: Notes, d: Depth): Node[] {
  return gaps(
    settle(
      list.flatMap(unbroken).flatMap((x) => block(x, pr, notes, d)),
      pr,
    ),
    pr,
  );
}

/** Blocks as paragraphs only, their text as it is: the last step of every block's ladder. */
function flat(list: Node[]): Node[] {
  return list.flatMap((b): Node[] => {
    if (b.type === 'paragraph') return [b];
    if (b.type === 'heading') return [p(b.content ?? [])];
    if (b.type === 'blockquote') return prefix(flat(b.content ?? []), '> ');
    if (b.type === 'bulletList' || b.type === 'orderedList')
      return (b.content ?? []).flatMap((item, i) => prefix(flat(item.content ?? []), b.type === 'orderedList' ? `${(b.attrs?.start ?? 1) + i}. ` : '- ', '   '));
    if (b.type === 'codeBlock') return (b.content?.[0]?.text ?? '').split('\n').map((l) => p([t(l)]));
    if (b.type === 'horizontalRule') return [p([t('---')])];
    if (b.type === 'table') return (b.content ?? []).map((row) => p(rowInline(row)));
    if (b.type === 'fold') return [p([t(String(b.attrs?.title ?? ''))]), ...flat(b.content ?? [])];
    if (b.type === 'raw') return b.attrs?.fallback ? flat(b.attrs.fallback as Node[]) : String(b.attrs?.text ?? '').split('\n').filter((l) => l.trim()).map((l) => p([t(l)]));
    return b.content?.some(isBlock) ? flat(b.content) : b.content?.length ? [p(b.content)] : [];
  });
}
/** A table's row as one line: each cell's lines side by side, cells parted by a bar. */
const rowInline = (row: Node): Node[] => (row.content ?? []).flatMap((c, i) => [...(i ? [t(' | ')] : []), ...flat(c.content ?? []).flatMap((x, j) => [...(j ? [t(' ')] : []), ...(x.content ?? [])])]);

/** A container that holds only lines on this place has its inner blocks made lines. */
function linesOnly(kind: string, inner: Node[], pr: Profile, notes: Notes): Node[] {
  if (!(pr.rules?.lines as readonly string[] | undefined)?.includes(kind) || inner.every((x) => x.type === 'paragraph')) return inner;
  notes.add('flattened', 'inside', 'A block inside a quote, a list or a table becomes lines of text');
  return flat(inner);
}

const ALIGN = /^(left|right|center|justify)$/;

function block(b: Node, pr: Profile, notes: Notes, d: Depth): Node[] {
  const has = (k: string) => (pr.blocks as readonly string[]).includes(k);
  const mark = (k: string) => (pr.marks as readonly string[]).includes(k);
  if (!KNOWN.has(b.type)) {
    // A kind this version does not know: what is inside it goes on as it is, a line of text as a line.
    notes.add('flattened', 'unknown', 'Something this version does not know goes as its words');
    const kids = b.content ?? [];
    return kids.some(isBlock) ? blocks(kids, pr, notes, d) : kids.length ? [p(inline(kids, pr, notes))] : [];
  }
  switch (b.type) {
    case 'paragraph': {
      const align = ALIGN.test(String(b.attrs?.textAlign ?? '')) && b.attrs!.textAlign !== 'left' ? b.attrs!.textAlign : null;
      if (align && !pr.rules?.align) notes.add('dropped', 'align', 'Centred and right-aligned lines start at the left');
      return [{ type: 'paragraph', ...(align && pr.rules?.align ? { attrs: { textAlign: align } } : {}), content: inline(b.content ?? [], pr, notes) }];
    }
    case 'heading': {
      const content = inline(b.content ?? [], pr, notes);
      if (has('heading')) {
        const max = pr.rules?.headingLevels ?? 6;
        if ((b.attrs?.level ?? 1) > max) notes.add('restyled', 'headingLevel', `Smaller headings become level ${max}`);
        const align = ALIGN.test(String(b.attrs?.textAlign ?? '')) && b.attrs!.textAlign !== 'left' && pr.rules?.align ? { textAlign: b.attrs!.textAlign } : {};
        return [{ type: 'heading', attrs: { level: Math.min(b.attrs?.level ?? 1, max), ...align }, content }];
      }
      if (mark('bold')) {
        notes.add('restyled', 'heading', 'A heading becomes a bold line');
        return [p(bolded(content, pr))];
      }
      notes.add('flattened', 'heading', 'A heading becomes an ordinary line');
      return [p(content)];
    }
    case 'blockquote': {
      const inner = blocks(b.content ?? [], pr, notes, { ...d, quote: d.quote + 1 });
      // A quote of nothing is nothing: written out, it would be read as a quote of an empty line.
      if (!inner.length) return [];
      if (has('blockquote') && d.quote < (pr.rules?.quoteDepth ?? 99)) return [{ type: 'blockquote', content: linesOnly('blockquote', inner, pr, notes) }];
      notes.add('flattened', has('blockquote') ? 'quoteDepth' : 'quote', has('blockquote') ? 'A quote inside a quote becomes lines starting with >' : 'A quote becomes lines starting with >');
      return prefix(flat(inner), '> ');
    }
    case 'bulletList':
    case 'orderedList': {
      // A list of nothing, like a quote of nothing, is not written.
      if (!b.content?.length) return [];
      const items = (b.content ?? []).map((item) => blocks(item.content ?? [], pr, notes, { ...d, list: d.list + 1 }));
      if (has('list') && d.list < (pr.rules?.listDepth ?? 99)) {
        // A list inside an item is not a block inside it: it is the list going on, one step in.
        const kept = items.map((content) => (pr.rules?.lines?.includes('listItem') && content.some((x) => !/^(paragraph|bulletList|orderedList)$/.test(x.type)) ? (notes.add('flattened', 'inside', 'A block inside a quote, a list or a table becomes lines of text'), content.flatMap((x) => (/^(bulletList|orderedList)$/.test(x.type) ? [x] : flat([x])))) : content));
        return [{ type: b.type, ...(b.attrs?.start > 1 ? { attrs: { start: b.attrs!.start } } : {}), content: kept.map((content) => ({ type: 'listItem', content })) }];
      }
      notes.add('flattened', has('list') ? 'listDepth' : 'list', has('list') ? 'A list inside a list becomes indented lines' : 'A list becomes lines starting with a dash or a number');
      return items.flatMap((item, i) => prefix(flat(item), b.type === 'orderedList' ? `${(b.attrs?.start ?? 1) + i}. ` : '- ', '   '));
    }
    case 'codeBlock': {
      const code = b.content?.[0]?.text ?? '';
      if (has('codeBlock')) {
        const lang = b.attrs?.language;
        if (lang && !pr.rules?.codeLang) notes.add('dropped', 'codeLang', 'A code block’s language is not kept');
        return [{ type: 'codeBlock', ...(lang && pr.rules?.codeLang ? { attrs: { language: lang } } : {}), content: code ? [t(code)] : [] }];
      }
      notes.add(mark('code') ? 'restyled' : 'flattened', 'codeBlock', mark('code') ? 'A code block becomes lines of code' : 'A code block becomes ordinary lines');
      return code.split('\n').map((l) => p([t(l, mark('code') ? [{ type: 'code' }] : [])]));
    }
    case 'horizontalRule':
      if (has('horizontalRule')) return [{ type: 'horizontalRule' }];
      notes.add('flattened', 'rule', 'A rule becomes a line of dashes');
      return [p([t('---')])];
    case 'table': {
      if (!b.content?.length) return [];
      // Where a cell holds one line, its lines are put side by side; spaces at a cell's edges are never shown.
      const edges = (run: Node[]) => run.map((n, j) => (n.type !== 'text' ? n : { ...n, text: (n.text ?? '').replace(j === 0 ? /^\s+/ : /^$/, '').replace(j === run.length - 1 ? /\s+$/ : /^$/, '') }));
      const oneLine = (inner: Node[]) => (pr.rules?.lines?.includes('tableCell') ? [p(edges(joinRuns(inner.flatMap((x, j) => [...(j ? [t(' ')] : []), ...(x.content ?? [])]))))] : inner);
      // Every row as wide as the widest: a network drops what a row has past its header.
      const wide = Math.max(1, ...(b.content ?? []).map((row) => row.content?.length ?? 0));
      const padded = (row: Node, i: number) => [...(row.content ?? []), ...Array.from({ length: wide - (row.content?.length ?? 0) }, () => ({ type: i ? 'tableCell' : 'tableHeader', content: [p([])] }))];
      const rows = (b.content ?? []).map((row, i) => ({ type: 'tableRow', content: padded(row, i).map((cell) => ({ type: cell.type === 'tableHeader' ? 'tableHeader' : 'tableCell', content: oneLine(linesOnly('tableCell', blocks(cell.content ?? [], pr, notes, d), pr, notes)) })) }));
      if (has('table')) return [{ type: 'table', content: rows }];
      // Lined-up text in code is the next step, but code cannot hide, link or tell anyone: a table that holds anything
      // but plain words goes as lines that keep them.
      const lines = rows.map((row) => rowInline(row));
      const plain = lines.every((l) => l.every((n) => n.type === 'text' && !n.marks?.length));
      if (plain && (has('codeBlock') || mark('code'))) {
        notes.add('restyled', 'table', 'A table becomes lined-up text in code');
        const cells = rows.map((row) => (row.content ?? []).map((c) => flat(c.content ?? []).map((x) => words(x)).join(' ')));
        const width = (i: number) => Math.max(...cells.map((r) => (r[i] ?? '').length));
        const text = cells.map((r) => r.map((c, i) => (i < r.length - 1 ? c.padEnd(width(i)) : c)).join(' | ')).join('\n');
        return block({ type: 'codeBlock', content: [t(text)] }, pr, new Notes(), d);
      }
      notes.add('flattened', 'table', 'A table becomes lines of text');
      return lines.map((l) => p(l));
    }
    case 'fold': {
      const hides = b.attrs?.why !== 'long';
      const inner = blocks(b.content ?? [], pr, notes, hides ? { ...d, hidden: has('fold') ? 'kept' : 'open' } : d);
      if (has('fold')) return [{ type: 'fold', attrs: { title: String(b.attrs?.title ?? ''), ...(b.attrs?.why ? { why: b.attrs.why } : {}) }, content: linesOnly('fold', inner.length ? inner : [p([])], pr, notes) }];
      const title = p(mark('bold') ? [t(String(b.attrs?.title ?? ''), [{ type: 'bold' }])] : [t(String(b.attrs?.title ?? ''))]);
      // Folded only to save room: nothing is given away by showing it.
      if (b.attrs?.why === 'long') {
        notes.add('restyled', 'foldOpen', 'A block folded to save room is shown open');
        return [title, ...inner];
      }
      if (mark('spoiler')) {
        notes.add('restyled', 'fold', 'A folded block becomes hidden text under its title');
        return [title, ...flat(inner).map((x) => p(hidden(x.content ?? [], pr)))];
      }
      return [title, ...inner]; // shown open: said by the check below
    }
    case 'image': {
      const alt = String(b.attrs?.alt ?? '') || 'a picture';
      const src = address(String(b.attrs?.src ?? ''), pr, SAFE_PICTURE);
      if (!src) {
        notes.add('dropped', 'imageKind', 'A picture that is not at an address a reader can load is not sent', alt);
        return [];
      }
      const image: Node = { type: 'image', attrs: { src, alt: String(b.attrs?.alt ?? '') } };
      if (has('image')) {
        // In the text. Under a fold the place kept, it is hidden with the fold.
        if (d.hidden === 'open') notes.add('exposed', 'hiddenFile', 'A hidden picture is shown openly there', alt);
        return [image];
      }
      if (pr.rules?.files === false) {
        notes.add('dropped', 'noFiles', 'A picture cannot go there', alt);
        return [];
      }
      // Beside the text, as a file: hidden there where the place can hide a file.
      notes.files.push(d.hidden ? { ...image, attrs: { ...image.attrs, hidden: true } } : image);
      if (d.hidden && !pr.rules?.hidesFiles) notes.add('exposed', 'hiddenFile', 'A hidden picture is shown openly there', alt);
      else notes.add('restyled', 'image', 'A picture in the text goes with the message as a file');
      return [];
    }
    default: {
      // raw
      const takes = has('raw') && (pr.rules?.raw ?? []).includes(b.attrs?.format);
      // Its own HTML stands among the other text only if it keeps to itself.
      if (takes && (b.attrs?.format !== 'html' || contained(String(b.attrs?.source ?? '')))) return [b];
      if (takes) notes.add('flattened', 'rawOpen', 'A block of HTML that would change the text around it goes as its words only');
      else notes.add('flattened', 'raw', `A block kept as its own ${String(b.attrs?.format ?? '').toUpperCase()} goes as its words only`);
      return blocks(flat([b]), pr, new Notes(), d);
    }
  }
}

interface Fitted {
  doc: Node;
  changes: Change[];
  /** Pictures that were in the text and go beside it. */
  files: Node[];
}

export function fit(draft: Node, pr: Profile): Fitted {
  const notes = new Notes();
  // Nothing is assumed of the tree: it may come from another device.
  // A part written as Markdown or HTML is read as the tree it says first (lens.ts).
  const d: Node = sound(resolve(draft))[0] ?? { type: 'doc', content: [] };
  const content = blocks(d.content ?? [], pr, notes, { quote: 0, list: 0 });
  const fitted: Node = { type: 'doc', content };
  // The two things that must never happen unsaid are found on the result itself, not left to each step to say.
  for (const w of hiddenLost(d, fitted)) notes.add('exposed', 'hidden', 'Hidden text can be read there', w);
  for (const w of wordsLost(d, fitted)) notes.add('blocked', 'lost', 'Some words would not arrive', w);
  return { doc: fitted, changes: notes.list(), files: notes.files };
}

/** What a place can carry as itself, for a control: a block, a style, or a thing in the text. */
export function carries(pr: Profile, what: string): boolean {
  if (what === 'bulletList' || what === 'orderedList') return pr.blocks.includes('list');
  return (pr.blocks as readonly string[]).includes(what) || (pr.marks as readonly string[]).includes(what) || (pr.entities as readonly string[]).includes(what);
}
