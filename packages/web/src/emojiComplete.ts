/**
 * `:` emoji autocomplete in the composer, the part without a DOM: when a `:shortcode` is being typed, which
 * emoji match it and in what order, and when a closing `:` turns it into the emoji. ui/EmojiComplete.tsx
 * draws the list and handles the keys.
 *
 * It only starts after a space, the start of a line or an opening bracket or quote, so `12:30`, `http://`,
 * `<:name:id>` and `key:value` never open it, and never inside `code` or a ``` block.
 */
import type { EmojiItem } from './emoji.ts';

/** What may stand right before the `:`. */
const LEAD = String.raw`(?:^|[\s([{"'>*_~|])`;
const CODE = String.raw`[a-z0-9_+\-]`;
const OPEN = new RegExp(`${LEAD}:(${CODE}{2,32})$`, 'i');
const CLOSED = new RegExp(`${LEAD}:(${CODE}{2,32}):$`, 'i');

export interface Trigger {
  /** Index of the `:`. */
  start: number;
  /** The caret: the query runs from start + 1 to here. */
  end: number;
  query: string;
}

/** True if `pos` sits inside a ``` block or an inline `code` span (as markdown.ts reads them). */
export function insideCode(text: string, pos: number): boolean {
  const before = text.slice(0, pos);
  const fences = before.split('```');
  if (fences.length % 2 === 0) return true;
  // Inline code is one line, after the last fence.
  const line = fences[fences.length - 1].split('\n').pop() ?? '';
  return (line.match(/`/g)?.length ?? 0) % 2 === 1;
}

/** The `:query` the caret is at the end of, if it should open the list. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const m = text.slice(0, caret).match(OPEN);
  if (!m) return null;
  const query = m[1];
  const start = caret - query.length - 1;
  if (!/[a-z0-9]/i.test(query)) return null;
  if (insideCode(text, start)) return null;
  // A URL or a path in the same word (belt and braces: the lead character already rules most out).
  const word = text.slice(0, caret).split(/\s/).pop() ?? '';
  if (/:\/\/|^www\./i.test(word.slice(0, word.length - query.length - 1))) return null;
  return { start, end: caret, query };
}

/** A `:shortcode:` the caret has just closed, to be turned into its emoji if one has that exact code. */
export function closedCode(text: string, caret: number): { start: number; end: number; code: string } | null {
  const m = text.slice(0, caret).match(CLOSED);
  if (!m) return null;
  const start = caret - m[1].length - 2;
  if (insideCode(text, start)) return null;
  return { start, end: caret, code: m[1] };
}

export interface CustomEmoji {
  key: string;
  name: string;
  url: string;
  animated: boolean;
}

export type Candidate = { kind: 'unicode'; code: string; item: EmojiItem } | { kind: 'custom'; code: string; emoji: CustomEmoji };

/** How well one word matches: the whole word, its start, the start of one of its parts, anywhere in it. */
function wordScore(word: string, q: string): number {
  if (word === q) return 100;
  if (word.startsWith(q)) return 80;
  if (word.split(/[_\-\s]+/).some((p) => p.startsWith(q))) return 60;
  if (word.includes(q)) return 25;
  return 0;
}

/** Splits camelCase custom names, so "partyBlob" is found by "blob". */
const customWords = (name: string) => [name.toLowerCase(), name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()];

/**
 * Best matches first, the way Discord orders them: an exact shortcode, then shortcodes that start with the
 * query, then ones with a word that does, then names and keywords. Ties go to what you use most, then to the
 * server's own emoji, then to the shorter code.
 */
export function rankEmoji(query: string, unicode: EmojiItem[], custom: CustomEmoji[], usage: Map<string, number> = new Map(), limit = 10): Candidate[] {
  const q = query.toLowerCase();
  if (q.length < 2) return [];
  const scored: { c: Candidate; score: number; uses: number }[] = [];
  for (const e of custom) {
    const score = Math.max(...customWords(e.name).map((w) => wordScore(w, q)));
    if (score) scored.push({ c: { kind: 'custom', code: e.name, emoji: e }, score, uses: usage.get(e.key) ?? 0 });
  }
  for (const item of unicode) {
    let best = 0;
    let code = item.id;
    for (const c of item.codes) {
      const s = wordScore(c, q);
      if (s > best) [best, code] = [s, c];
    }
    // The name and keywords count for less than the code: "sad" should not rank above :sob: by keyword alone.
    const name = wordScore(item.name.toLowerCase(), q) * 0.6;
    // Keywords only from three letters on: at two, "jo" would bring every face tagged "joy".
    const kw = q.length < 3 ? 0 : Math.max(0, ...item.words.slice(2).map((w) => (w.startsWith(q) ? 30 : 0)));
    const score = Math.max(best, name, kw);
    if (score) scored.push({ c: { kind: 'unicode', code, item }, score, uses: usage.get(item.skins[0]) ?? 0 });
  }
  return scored
    // On a tie, a server's own emoji come before Unicode ones: someone went to the trouble of adding them.
    .sort((a, b) => b.score - a.score || b.uses - a.uses || +(b.c.kind === 'custom') - +(a.c.kind === 'custom') || a.c.code.length - b.c.code.length)
    .slice(0, limit)
    .map((s) => s.c);
}

/** The emoji with exactly this shortcode, for a closing `:`. */
export function exactEmoji(code: string, unicode: EmojiItem[], custom: CustomEmoji[]): Candidate | null {
  const q = code.toLowerCase();
  const c = custom.find((e) => e.name.toLowerCase() === q);
  if (c) return { kind: 'custom', code: c.name, emoji: c };
  const u = unicode.find((e) => e.codes.includes(q));
  return u ? { kind: 'unicode', code: q, item: u } : null;
}

/** What goes into the message for a custom emoji: Discord's own markup, which the hub sends as it is. */
export function customMarkup(e: CustomEmoji): string | null {
  const m = e.key.match(/^(.+):(\d+)$/);
  return m ? `<${e.animated ? 'a' : ''}:${m[1]}:${m[2]}>` : null;
}
