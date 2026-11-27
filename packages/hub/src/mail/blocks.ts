/**
 * A mail's words with their formatting, as the chat draws them (docs/mail.md "A mail as a chat message"): a small tree
 * (`MailBlock`, protocol mail.ts) made from the sanitiser's output (sanitize.ts), never from the raw mail, with Bun's
 * HTMLRewriter. The tree holds text and http(s)/mailto links only; the web draws it as elements.
 *
 * - What it keeps: paragraphs and their lines, headings, lists (ordered, with a start), quotes, code blocks, rules;
 *   bold, italic, underline, struck-through text, inline code, links, line breaks. Everything else gives its words
 *   and no looks (span, font, colours).
 * - Whitespace collapses as HTML does, except in a code block. A `<div>` is a line, as mail editors use it, and an
 *   empty line (two breaks in a row) ends a paragraph.
 * - The quoted mail goes, as the chat's words cut the text part at its quote: a quote the sanitiser marked (`dc-quote`)
 *   that only more quotes follow, with an "On … wrote:" line right above it. A quote with words after it (an answer
 *   between the lines) stays, as a quote.
 * - It gives up (no tree: the chat shows the mail as sent) on a designed mail: a table, a style sheet, a picture that
 *   is not small (more than 200 × 120 px, or of no known size), more than three small ones, or more than one element
 *   with a background. Small pictures (a logo in a signature) are left out of the words.
 * - And on size: more than MAX_NODES nodes or MAX_BYTES of JSON above the quote, or nothing left above it.
 */
import type * as P from '@dither-chat/protocol';
import { linkIsAddress, quoteStart } from '@dither-chat/protocol';
import { decodeEntities, safeHref } from './sanitize.ts';

/** At most this many nodes above the quote. */
export const MAX_NODES = 400;
/** At most this many bytes of JSON above the quote. */
export const MAX_BYTES = 8192;
/** What the walk reads before it stops, quote included: past it a mail is not walked further. */
const WALK_NODES = 4000;
/** Lists and quotes nest this deep; deeper ones are read as lines of the one around them. */
const MAX_NEST = 6;
/** Marks (bold in italic in …) nest this deep; deeper ones give their words only. */
const MAX_MARKS = 6;
/** Open elements tracked; deeper ones are read for their words only. */
const MAX_OPEN = 64;

export type BlocksOf = { blocks: P.MailBlock[] } | { none: 'designed' | 'size' | 'empty' };

const MARKS: Record<string, 'b' | 'i' | 'u' | 's' | 'code'> = {
  b: 'b', strong: 'b',
  i: 'i', em: 'i', cite: 'i', var: 'i', dfn: 'i',
  u: 'u', ins: 'u',
  s: 's', del: 's', strike: 's',
  code: 'code', kbd: 'code', samp: 'code', tt: 'code',
};
/** Elements that are a line of their own, as mail editors write lines. */
const LINES = new Set('div section article header footer main aside nav center address figure figcaption details summary dl dt dd'.split(' '));
const DESIGNED = new Set('table thead tbody tfoot tr td th caption col colgroup style'.split(' '));
/** Never in the sanitiser's output; should one come, its text is not words. */
const SKIP = new Set('script template textarea title noscript noembed noframes xmp iframe object svg math select option head'.split(' '));

class GiveUp extends Error {
  constructor(readonly why: 'designed' | 'size') {
    super(why);
  }
}
/** The rest of the mail is its quote: stop reading. */
class Stop extends Error {}

type Inl = Exclude<P.MailInline, string | { t: 'br' }>;
type Para = { block: { c: P.MailInline[] }; stack: P.MailInline[][] };
/** An element being read: how it closes, and what it is to the elements inside it. */
type Entry = {
  tag: string;
  close: () => void;
  /** A paragraph or heading, closed by the next block as HTML closes it. */
  para?: true;
  /** A list's item. */
  item?: true;
  /** A list. */
  list?: Extract<P.MailBlock, { t: 'list' }>;
  /** A quote. */
  quote?: true;
  /** A mark or link: how to make its node, and the node made in the current paragraph. */
  inline?: { make: () => Inl; node?: Inl; para?: Para };
};

/** A px size an attribute or a style gives, or null. */
const px = (v: string | null | undefined) => (v && /^\s*\d{1,5}(\.\d+)?\s*(px)?\s*$/i.test(v) ? parseFloat(v) : null);

/** The tree of a sanitised mail's words, or why there is none. */
export function mailBlocks(html: string): BlocksOf {
  const root: P.MailBlock[] = [];
  let containers: P.MailBlock[][] = [root];
  let para: Para | null = null;
  let pre: { text: string } | null = null;
  const open: Entry[] = [];
  let nodes = 0;
  let nest = 0;
  let marks = 0;
  let pictures = 0;
  let backgrounds = 0;
  let inCite = 0;
  let skip = 0;
  let pending = '';

  const count = (n = 1) => {
    nodes += n;
    if (nodes > WALK_NODES) throw inCite ? new Stop() : new GiveUp('size');
  };
  const container = () => containers[containers.length - 1];
  const closePara = () => {
    para = null;
  };
  /** A paragraph (or heading) starts, with the marks and links still open made again inside it. */
  const startPara = (block: Extract<P.MailBlock, { c: P.MailInline[] }>): Para => {
    count();
    container().push(block);
    const p: Para = { block, stack: [block.c] };
    para = p;
    for (const e of open) if (e.inline) openInline(e, p);
    return p;
  };
  const openInline = (e: Entry, p: Para) => {
    const n = e.inline!.make();
    p.stack[p.stack.length - 1].push(n);
    p.stack.push(n.c);
    e.inline!.node = n;
    e.inline!.para = p;
  };
  /** A mark or link closed: the paragraph's open nodes are those of the marks and links still open. */
  const closeInline = () => {
    marks--;
    const p = para;
    if (!p) return;
    p.stack = [p.block.c, ...open.flatMap((x) => (x.inline?.para === p ? [x.inline.node!.c] : []))];
  };
  const top = () => {
    const p = para ?? startPara({ t: 'p', c: [] });
    return p.stack[p.stack.length - 1];
  };
  const lastIn = (xs: P.MailInline[]) => xs[xs.length - 1];
  /** A line ends here (a `<div>`'s edge), unless the paragraph is empty or just broke. */
  const softBreak = () => {
    if (!para || pre) return;
    const xs = para.stack[para.stack.length - 1];
    if (!hasWords(para.block.c) && !para.block.c.some(isBr)) return;
    const l = lastIn(xs);
    if (l && typeof l === 'object' && l.t === 'br') return;
    xs.push({ t: 'br' });
  };
  const text = (raw: string) => {
    const t = decodeEntities(raw);
    if (!t || skip) return;
    if (pre) {
      pre.text += t;
      return;
    }
    const s = t.replace(/[ \t\n\r\f]+/g, ' ');
    if (!para && !s.trim()) return;
    const xs = top();
    const l = lastIn(xs);
    if (typeof l === 'string') xs[xs.length - 1] = l + s;
    else {
      count();
      xs.push(s);
    }
  };
  const flush = () => {
    if (!pending) return;
    const t = pending;
    pending = '';
    text(t);
  };
  /** Closes the open elements down to and with `e`, inner ones first. */
  const closeTo = (e: Entry) => {
    const at = open.lastIndexOf(e);
    if (at < 0) return;
    for (let i = open.length - 1; i >= at; i--) open.pop()!.close();
  };
  /** A block starts: a paragraph left open (`<p>` with no end) closes, as HTML closes it. */
  const blockStart = () => {
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].para) return closeTo(open[i]);
      if (!open[i].inline) break;
    }
    closePara();
  };
  /** Opens a container block (a quote, a list's item): what follows goes into `into` until `e` closes. */
  const enter = (into: P.MailBlock[]) => {
    const saved = containers;
    containers = [...containers, into];
    closePara();
    return () => {
      containers = saved;
      closePara();
    };
  };

  const rw = new HTMLRewriter().on('*', {
    element(el) {
      flush();
      const tag = el.tagName.toLowerCase();
      if (DESIGNED.has(tag)) throw new GiveUp('designed');
      const style = el.getAttribute('style') ?? '';
      if (el.hasAttribute('bgcolor') || el.hasAttribute('background') || /(^|;)\s*background(-color|-image)?\s*:/i.test(style)) if (++backgrounds > 1) throw new GiveUp('designed');
      const cls = ` ${(el.getAttribute('class') ?? '').toLowerCase()} `;
      // A picture: a small one (a logo) is left out of the words; any other makes the mail one to show as sent.
      if (tag === 'img' || cls.includes(' dc-img-blocked ')) {
        if (pre) return;
        const w = px(el.getAttribute('width')) ?? px(style.match(/(?:^|;)\s*width\s*:\s*([\d.]+px)/i)?.[1]);
        const ratio = style.match(/aspect-ratio\s*:\s*([\d.]+)\s*\/\s*([\d.]+)/i);
        const h = px(el.getAttribute('height')) ?? px(style.match(/(?:^|;)\s*height\s*:\s*([\d.]+px)/i)?.[1]) ?? (w !== null && ratio ? (w * Number(ratio[2])) / Number(ratio[1]) : null);
        if (w === null || h === null || w > 200 || h > 120 || ++pictures > 3) throw new GiveUp('designed');
        return;
      }
      if (!el.canHaveContent) {
        if (tag === 'br') {
          if (pre) pre.text += '\n';
          else {
            count();
            top().push({ t: 'br' });
          }
        } else if (tag === 'hr' && !pre) {
          blockStart();
          count();
          container().push({ t: 'hr' });
        }
        return;
      }
      if (open.length >= MAX_OPEN) return;
      if (SKIP.has(tag)) {
        skip++;
        const e: Entry = { tag, close: () => void skip-- };
        open.push(e);
        el.onEndTag(() => {
          flush();
          closeTo(e);
        });
        return;
      }
      // The quoted mail: the rest of the mail from here, or a quote the cut decides on once all is read (cutQuote).
      const isCite = cls.includes(' dc-quote ') && !pre;
      if (isCite && el.getAttribute('data-dc-quote') === 'rest' && !inCite) throw new Stop();
      let e: Entry | null = null;
      if (pre) {
        // Inside a code block only its text counts.
      } else if (tag === 'blockquote' || isCite) {
        if (nest >= MAX_NEST) {
          softBreak();
          e = { tag, close: softBreak };
        } else {
          blockStart();
          const q: P.MailBlock = { t: 'quote', c: [] };
          count();
          container().push(q);
          if (isCite && containers.length === 1) citeOf.add(q);
          const out = enter(q.c);
          nest++;
          if (isCite) inCite++;
          e = {
            tag,
            quote: true,
            close: () => {
              nest--;
              if (isCite) inCite--;
              out();
            },
          };
        }
      } else if (tag === 'ul' || tag === 'ol') {
        if (nest >= MAX_NEST) {
          softBreak();
          e = { tag, close: softBreak };
        } else {
          blockStart();
          const start = tag === 'ol' ? Number(el.getAttribute('start') ?? 1) : 1;
          const list: P.MailBlock = { t: 'list', ordered: tag === 'ol', items: [], ...(tag === 'ol' && Number.isInteger(start) && start !== 1 && start >= 0 && start < 1e6 ? { start } : {}) };
          count();
          container().push(list);
          const out = enter([]);
          nest++;
          e = {
            tag,
            list,
            close: () => {
              nest--;
              out();
            },
          };
        }
      } else if (tag === 'li') {
        // An item of the list it is in; an item left open closes at the next one.
        for (let i = open.length - 1; i >= 0; i--) {
          if (open[i].item) {
            closeTo(open[i]);
            break;
          }
          if (open[i].list || open[i].quote) break;
        }
        const list = [...open].reverse().find((x) => x.list || x.quote)?.list;
        if (!list) {
          softBreak();
          e = { tag, close: softBreak };
        } else {
          const item: P.MailBlock[] = [];
          list.items.push(item);
          count();
          e = { tag, item: true, close: enter(item) };
        }
      } else if (tag === 'pre') {
        blockStart();
        const b = { t: 'pre' as const, text: '' };
        count();
        container().push(b);
        pre = b;
        e = {
          tag,
          close: () => {
            pre = null;
            closePara();
          },
        };
      } else if (/^h[1-6]$/.test(tag)) {
        blockStart();
        startPara({ t: 'h', level: Number(tag[1]) as 1, c: [] });
        e = { tag, para: true, close: closePara };
      } else if (tag === 'p') {
        blockStart();
        e = { tag, para: true, close: closePara };
      } else if (LINES.has(tag)) {
        softBreak();
        e = { tag, close: softBreak };
      } else if (MARKS[tag] && marks < MAX_MARKS) {
        const t = MARKS[tag];
        e = { tag, close: closeInline, inline: { make: () => (count(), { t, c: [] }) } };
      } else if (tag === 'a') {
        const raw = el.getAttribute('href');
        const href = raw ? safeHref(raw) : null;
        if (href && /^(https?|mailto):/i.test(href) && marks < MAX_MARKS) e = { tag, close: closeInline, inline: { make: () => (count(), { t: 'a', href, c: [] }) } };
      }
      if (!e) {
        // Its words only: an end tag still closes nothing of ours.
        return;
      }
      open.push(e);
      if (e.inline) {
        marks++;
        if (para) openInline(e, para);
      }
      const entry = e;
      el.onEndTag(() => {
        flush();
        closeTo(entry);
      });
    },
    text(t) {
      pending += t.text;
      if (t.lastInTextNode) flush();
    },
  });

  try {
    rw.transform(html);
    flush();
  } catch (err) {
    if (err instanceof GiveUp) return { none: err.why };
    if (!(err instanceof Stop)) throw err;
  }
  const blocks = cutQuote(tidy(root));
  if (!blocks.length) return { none: 'empty' };
  if (size(blocks) > MAX_NODES || JSON.stringify(blocks).length > MAX_BYTES) return { none: 'size' };
  return { blocks };
}

// ------------------------------------------------------------------ after the walk

const isBr = (x: P.MailInline | undefined) => typeof x === 'object' && x.t === 'br';

/** Text with words in it, a link or a break among them aside. */
function hasWords(xs: P.MailInline[]): boolean {
  return xs.some((x) => (typeof x === 'string' ? !!x.trim() : x.t !== 'br' && hasWords(x.c)));
}

/** Inline nodes with HTML's whitespace rules applied: no space at a line's ends, none twice, empty marks gone. */
function tidyInline(xs: P.MailInline[]): P.MailInline[] {
  // Flattened into a run of text and markers, so spaces across mark edges are seen.
  const out: P.MailInline[] = [];
  let lastSpace = true;
  const walk = (ys: P.MailInline[], into: P.MailInline[], marks = '') => {
    for (const y of ys) {
      if (typeof y === 'string') {
        let s = y.replace(/ {2,}/g, ' ');
        if (lastSpace) s = s.replace(/^ +/, '');
        if (!s) continue;
        lastSpace = s.endsWith(' ');
        const l = into[into.length - 1];
        if (typeof l === 'string') into[into.length - 1] = l + s;
        else into.push(s);
      } else if (y.t === 'br') {
        // A space before a break is not drawn.
        trimEnd(into);
        into.push(y);
        lastSpace = true;
      } else if (y.t !== 'a' && marks.includes(y.t + ' ')) {
        // Bold in bold is bold.
        walk(y.c, into, marks);
      } else {
        const c: P.MailInline[] = [];
        walk(y.c, c, y.t === 'a' ? marks : marks + y.t + ' ');
        if (c.length) into.push({ ...y, c });
      }
    }
  };
  walk(xs, out);
  while (isBr(out[0])) out.shift();
  trimEnd(out);
  while (isBr(out[out.length - 1])) {
    out.pop();
    trimEnd(out);
  }
  return out;
}
/** The space at the end of a run, in the last text however deep. */
function trimEnd(xs: P.MailInline[]) {
  for (;;) {
    const l = xs[xs.length - 1];
    if (l === undefined) return;
    if (typeof l === 'string') {
      const s = l.replace(/ +$/, '');
      if (s) xs[xs.length - 1] = s;
      else {
        xs.pop();
        continue;
      }
      return;
    }
    if (l.t === 'br') return;
    trimEnd(l.c);
    if (!l.c.length) {
      xs.pop();
      continue;
    }
    return;
  }
}

/** A paragraph split where it has an empty line (two breaks in a row). */
function splitPara(c: P.MailInline[]): P.MailInline[][] {
  const out: P.MailInline[][] = [[]];
  for (let i = 0; i < c.length; i++) {
    if (isBr(c[i]) && isBr(c[i + 1])) {
      while (isBr(c[i + 1])) i++;
      out.push([]);
      continue;
    }
    out[out.length - 1].push(c[i]);
  }
  return out;
}

function tidy(bs: P.MailBlock[]): P.MailBlock[] {
  const out: P.MailBlock[] = [];
  for (const b of bs) {
    if (b.t === 'p') {
      for (const c of splitPara(tidyInline(b.c))) {
        const t = tidyInline(c);
        if (hasWords(t)) out.push({ t: 'p', c: t });
      }
    } else if (b.t === 'h') {
      const c = tidyInline(b.c);
      if (hasWords(c)) out.push({ ...b, c });
    } else if (b.t === 'list') {
      const items = b.items.map(tidy).filter((i) => i.length);
      if (items.length) out.push({ ...b, items });
    } else if (b.t === 'quote') {
      const c = tidy(b.c);
      if (c.length) {
        const q: P.MailBlock = { t: 'quote', c };
        out.push(q);
        if (citeOf.has(b)) citeOf.add(q);
      }
    } else if (b.t === 'pre') {
      const text = b.text.replace(/^\n/, '').replace(/\s+$/, '');
      if (text.trim()) out.push({ t: 'pre', text });
    } else out.push(b);
  }
  return out;
}
/** The top-level quotes the sanitiser marked, carried through tidy. */
const citeOf = new WeakSet<object>();

/** The words above the quote: the marked quotes at the end go, with an "On … wrote:" line right above them. */
function cutQuote(bs: P.MailBlock[]): P.MailBlock[] {
  let end = bs.length;
  let cut = false;
  while (end > 0 && citeOf.has(bs[end - 1])) {
    end--;
    cut = true;
  }
  const out = bs.slice(0, end);
  if (!cut) return out;
  const last = out[out.length - 1];
  if (last?.t === 'p') {
    const lines = splitLines(last.c);
    const line = plain(lines[lines.length - 1]);
    // quoteStart reads it as an attribution when it stands right above a quoted line.
    if (quoteStart(`x\n${line}\n> q`) === 2) {
      const keep = lines.slice(0, -1);
      if (keep.length) out[out.length - 1] = { t: 'p', c: keep.flatMap((l, i) => (i ? [{ t: 'br' as const }, ...l] : l)) };
      else out.pop();
    }
  }
  return out;
}

/** A paragraph's lines. */
export function splitLines(c: P.MailInline[]): P.MailInline[][] {
  const out: P.MailInline[][] = [[]];
  for (const x of c) {
    if (isBr(x)) out.push([]);
    else out[out.length - 1].push(x);
  }
  return out;
}

/** Inline nodes as plain text. */
export function plain(xs: P.MailInline[]): string {
  return xs.map((x) => (typeof x === 'string' ? x : x.t === 'br' ? '\n' : plain(x.c))).join('');
}

function size(bs: P.MailBlock[]): number {
  const inl = (xs: P.MailInline[]): number => xs.reduce((n, x) => n + 1 + (typeof x === 'object' && 'c' in x ? inl(x.c) : 0), 0);
  return bs.reduce((n, b) => n + 1 + (b.t === 'p' || b.t === 'h' ? inl(b.c) : b.t === 'quote' ? size(b.c) : b.t === 'list' ? b.items.reduce((m, i) => m + 1 + size(i), 0) : 0), 0);
}

/** The tree says more than the text would: a heading, list, quote, code, rule, a mark, or a link with words of its own. */
export function carriesMore(bs: P.MailBlock[]): boolean {
  const inl = (xs: P.MailInline[]): boolean => xs.some((x) => typeof x === 'object' && x.t !== 'br' && (x.t !== 'a' || !linkIsAddress(x.href, plain(x.c)) || inl(x.c)));
  return bs.some((b) => (b.t === 'p' ? inl(b.c) : true));
}
