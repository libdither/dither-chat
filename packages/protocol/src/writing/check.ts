/**
 * What the writer is told before sending is not taken from the code that changes the draft: it is found by comparing
 * the draft with what will be read. Three questions, asked of any two trees (the draft and its fitted form, the fitted
 * form and the wire read back):
 *
 * - wordsLost: is every word still there?
 * - hiddenLost: is every word that was hidden still hidden?
 * - differs: does it look the same (the same blocks, the same styles on the same characters)?
 *
 * and one of a fitted tree alone: conforms, that it holds only what its place carries, where the place carries it.
 */
import { joinRuns, standIn, type Mark, type Node } from './doc.ts';
import type { Profile } from './profile.ts';

interface Leaf {
  said: string;
  hidden: boolean;
}
const END: Leaf = { said: '\n', hidden: false };

/** Everything that is read, in order, with whether it is hidden. A block ends in a line end. */
function leaves(n: Node, hidden = false, out: Leaf[] = [], numbers = false): Leaf[] {
  const hid = hidden || !!n.marks?.some((m) => m.type === 'spoiler');
  if (n.type === 'text') out.push({ said: n.text ?? '', hidden: hid });
  else if (n.type === 'mention') out.push({ said: String(n.attrs?.label ?? ''), hidden: hid });
  else if (n.type === 'time' || n.type === 'emoji') out.push({ said: standIn(n), hidden: hid });
  else if (n.type === 'codeBlock') out.push({ said: (n.content ?? []).map((c) => c.text ?? '').join(''), hidden: hid }, END);
  else if (n.type === 'raw') {
    if (n.attrs?.fallback) for (const c of n.attrs.fallback as Node[]) leaves(c, hid, out, numbers);
    else out.push({ said: String(n.attrs?.text ?? ''), hidden: hid }, END);
  } else if (n.type === 'fold') {
    out.push({ said: String(n.attrs?.title ?? ''), hidden: hid }, END);
    for (const c of n.content ?? []) leaves(c, hid || n.attrs?.why !== 'long', out, numbers);
  } else {
    // With `numbers`, a numbered list's numbers are read too: a line typed "1. tea" and a list's first item say the same.
    (n.content ?? []).forEach((c, i) => {
      if (numbers && n.type === 'orderedList') out.push({ said: `${(n.attrs?.start ?? 1) + i}. `, hidden: hid });
      leaves(c, hid, out, numbers);
    });
    if (n.type !== 'doc' && n.content) out.push(END);
  }
  return out;
}

/** The characters of some text that are seen: no spaces, none of no width. */
const ink = (s: string) => s.replace(/[\s\p{Cf}]/gu, '');
/** Those of them no network takes for a marker. They must arrive whatever the markers around them come to mean. */
const strong = (s: string) => ink(s).replace(/[!-\/:-@\[-`{-~]/g, '');

const MARKERISH = /[!-\/:-@\[-`{-~]/;

/**
 * `a` laid over `b`, run of text by run of text and in order: `b` may have more than `a` (a list's dash, a link's
 * address), never less, and what `a` hides `b` must hide.
 *
 * - lost: words of `a` that are not in `b`.
 * - shown: stretches hidden in `a` that can be read in `b`.
 *
 * A run is found by its own characters, whole and in a row, after the run before it. So a word of `a` is never taken
 * for found because its letters happen to be scattered through `b`. `wire`: `b` is a wire read back, where a marker
 * character the writer typed may have been taken for a marker; that is a line read another way (differs), not a loss.
 */
function missing(a: Node, b: Node, wire: boolean): { lost: string[]; shown: string[] } {
  // What is seen of `b`, with whether each character is hidden; and the same without what may be a marker, with where
  // each of those sits in the first. One place is kept in both.
  let all = '';
  const hid: boolean[] = [];
  for (const l of leaves(b, false, [], wire)) {
    const x = ink(l.said);
    all += x;
    for (let i = 0; i < x.length; i++) hid.push(l.hidden);
  }
  let letters = '';
  const at: number[] = [];
  const before: number[] = [];
  for (let i = 0; i < all.length; i++) {
    before.push(letters.length);
    if (!MARKERISH.test(all[i])) {
      letters += all[i];
      at.push(i);
    }
  }
  before.push(letters.length);
  let p = 0; // in `all`

  const lost: string[] = [];
  const shown: string[] = [];
  let open = '';
  const flush = () => {
    if (open.trim()) shown.push(open.trim());
    open = '';
  };
  /** 1 found and as hidden as it was, 0 found and readable though it was hidden, -1 not found. */
  // Letters one run was found in are taken: "no" is not found in the "know" of the line before it.
  const taken: [number, number][] = [];
  const seek = (want: string, start: number) => {
    let k = letters.indexOf(want, start);
    while (k >= 0 && taken.some(([a, b]) => k < b && k + want.length > a)) k = letters.indexOf(want, k + 1);
    return k;
  };
  const find = (said: string, hidden: boolean, symbols: boolean): number => {
    const want = strong(said);
    let from: number;
    let to: number;
    if (want) {
      let k = seek(want, before[p]);
      const moved = k < 0;
      if (moved) k = seek(want, 0); // somewhere else: moved, not lost
      if (k < 0) return -1;
      taken.push([k, k + want.length]);
      from = at[k];
      to = at[k + want.length - 1] + 1;
      if (!moved) p = to;
    } else {
      const sym = ink(said);
      if (!sym || !symbols) return 1;
      let k = all.indexOf(sym, p);
      const moved = k < 0;
      if (moved) k = all.indexOf(sym);
      if (k < 0) return -1;
      from = k;
      to = k + sym.length;
      if (!moved) p = to;
    }
    if (!hidden) return 1;
    for (let i = from; i < to; i++) if (!hid[i] && (want ? !MARKERISH.test(all[i]) : true)) return 0;
    return 1;
  };
  for (const l of leaves(a, false, [], wire)) {
    if (l === END || !l.hidden) flush();
    if (l === END) continue;
    const whole = find(l.said, l.hidden, !wire || l.hidden);
    if (whole === 0) open += l.said;
    if (whole >= 0) continue;
    // Not there whole: word by word, to name the ones that are missing.
    const tokens = l.said.split(/\s+/).filter(Boolean);
    const gone: string[] = [];
    for (const w of tokens) {
      const one = find(w, l.hidden, false);
      if (one < 0) gone.push(w);
      if (one === 0) open += w + ' ';
    }
    // Nothing of it is there: the run itself is named, not each of its words.
    if (gone.length === tokens.length && tokens.length > 3) lost.push(l.said.trim());
    else lost.push(...gone);
  }
  flush();
  return { lost: [...new Set(lost)], shown: [...new Set(shown)] };
}

/** Words of `a` that `b` does not have. `wire`: `b` is a wire read back. */
export const wordsLost = (a: Node, b: Node, wire = false): string[] => missing(a, b, wire).lost;
/** Stretches of `a` that were hidden and can be read in `b`. */
export const hiddenLost = (a: Node, b: Node, wire = false): string[] => missing(a, b, wire).shown;

const ZW = /[​⁠]/g;
const markKey = (m: Mark) => (m.attrs && Object.keys(m.attrs).length ? `${m.type}:${JSON.stringify(m.attrs)}` : m.type);

/** A tree in one spelling, for comparing two: what cannot be seen is left out. */
function norm(n: Node): unknown {
  if (n.type === 'paragraph' || n.type === 'heading') {
    // A style on the spaces at the edge of a run is not seen.
    const runs = (n.content ?? []).flatMap((c): Node[] => {
      if (c.type !== 'text') return [c];
      const s = (c.text ?? '').replace(ZW, '').replace(/ /g, ' ');
      if (!c.marks?.length) return [{ ...c, text: s }];
      const [, a, core, z] = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
      return [{ type: 'text', text: a }, { ...c, text: core }, { type: 'text', text: z }];
    });
    const content = joinRuns(runs).map((c) => [c.type === 'text' ? c.text : c.type === 'mention' ? `@${c.attrs?.kind ?? 'user'}:${c.attrs?.id ?? ''}` : standIn(c), (c.marks ?? []).map(markKey).sort().join(' ')]);
    return [n.type === 'heading' ? `h${n.attrs?.level ?? 1}` : 'p', n.attrs?.textAlign ?? '', content.filter((c, i) => i || content.length > 1 || String(c[0]).trim() || c[1])];
  }
  if (n.type === 'codeBlock') return ['code', n.attrs?.language || '', (n.content ?? []).map((c) => c.text ?? '').join('')];
  if (n.type === 'raw') return ['raw', n.attrs?.format ?? '', String(n.attrs?.source ?? '').replace(/\s+/g, ' ').trim()];
  if (n.type === 'image') return ['image', n.attrs?.src ?? ''];
  if (n.type === 'fold') return ['fold', n.attrs?.title ?? '', (n.content ?? []).map(norm)];
  if (n.type === 'orderedList') return ['ol', n.attrs?.start > 1 ? n.attrs!.start : 1, (n.content ?? []).map(norm)];
  const name = n.type === 'tableHeader' ? 'tableCell' : n.type;
  return [name, (n.content ?? []).map(norm)];
}

/** The first line of `a` that `b` shows another way, as its words; null when they look the same. */
export function differs(a: Node, b: Node): string | null {
  const x = a.content ?? [];
  const y = b.content ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] && y[i] && JSON.stringify(norm(x[i])) === JSON.stringify(norm(y[i]))) continue;
    // Inside a quote, a list or a table, the line itself is named.
    const inside = x[i] && y[i] && x[i].type === y[i].type && !/^(paragraph|heading|codeBlock|raw|image)$/.test(x[i].type) ? differs(x[i], y[i]) : null;
    if (inside !== null) return inside;
    const said = leaves(x[i] ?? y[i])
      .map((l) => l.said)
      .join('')
      .trim();
    return said.split('\n')[0].slice(0, 80) || '(an empty line)';
  }
  return null;
}

/** What in a fitted tree its place does not carry, or not there. Empty when it fits. */
export function conforms(d: Node, pr: Profile): string[] {
  const bad = new Set<string>();
  const blocks = pr.blocks as readonly string[];
  const lines = (pr.rules?.lines ?? []) as readonly string[];
  const walk = (n: Node, quote: number, list: number, inside: string) => {
    const kind = n.type === 'bulletList' || n.type === 'orderedList' ? 'list' : n.type;
    if (/^(doc|paragraph|listItem|tableRow|tableCell|tableHeader)$/.test(kind)) {
      // always allowed where their parent is
    } else if (/^(text|mention|time|emoji)$/.test(kind)) {
      if (kind !== 'text' && !(pr.entities as readonly string[]).includes(kind)) bad.add(kind);
      for (const m of n.marks ?? []) if (!(pr.marks as readonly string[]).includes(m.type)) bad.add(m.type);
      if (!pr.rules?.marksInCode && n.marks?.some((m) => m.type === 'code') && n.marks.length > 1) bad.add('a style on code');
      return;
    } else if (!blocks.includes(kind)) bad.add(kind);
    if (!/^(doc|paragraph|listItem|tableRow|tableCell|tableHeader)$/.test(kind) && lines.includes(inside) && !(inside === 'listItem' && kind === 'list')) bad.add(`${kind} in ${inside}`);
    if (kind === 'blockquote' && quote >= (pr.rules?.quoteDepth ?? 99)) bad.add('a quote too deep');
    if (kind === 'list' && list >= (pr.rules?.listDepth ?? 99)) bad.add('a list too deep');
    if (kind === 'heading' && (n.attrs?.level ?? 1) > (pr.rules?.headingLevels ?? 6)) bad.add('a heading too small');
    if (kind === 'paragraph' && n.attrs?.textAlign && !pr.rules?.align) bad.add('alignment');
    const within = /^(blockquote|listItem|tableCell|tableHeader|fold)$/.test(kind) ? (kind === 'tableHeader' ? 'tableCell' : kind) : kind === 'list' || kind === 'tableRow' || kind === 'table' ? inside : '';
    for (const c of n.content ?? []) walk(c, quote + (kind === 'blockquote' ? 1 : 0), list + (kind === 'list' ? 1 : 0), kind === 'doc' ? '' : within || (kind === 'paragraph' || kind === 'heading' ? inside : ''));
  };
  walk(d, 0, 0, '');
  return [...bad];
}
