/**
 * Plain-text mail as the reader shows it (docs/mail.md): never Markdown, links made clickable, and the quoted part
 * (the hub's `quoteAt`, protocol mail.ts quoteStart) folded behind a button. Pure, for web/test/mail-text.test.ts.
 */
import { quoteStart } from '@dither-chat/protocol';

/** The part to show and the quoted part, at `quoteAt` (or where the text's own quote starts when the hub gave none). */
export function splitQuote(text: string, quoteAt?: number | null): { shown: string; quoted: string | null } {
  const at = quoteAt === undefined ? quoteStart(text) : quoteAt;
  if (at === null || at <= 0 || at >= text.length) return { shown: text.replace(/\s+$/, ''), quoted: null };
  return { shown: text.slice(0, at).replace(/\s+$/, ''), quoted: text.slice(at).replace(/\s+$/, '') };
}

export type TextPiece = { text: string } | { url: string; text: string };

const URL = /\b(?:https?:\/\/|www\.)[^\s<>"]+|\bmailto:[^\s<>"]+/gi;

/** Text and links, in order. Trailing punctuation stays text; a bare www. link gets https. */
export function linkify(text: string): TextPiece[] {
  const out: TextPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(URL)) {
    let raw = m[0];
    // A closing bracket or punctuation at the end belongs to the sentence, unless the link opened it.
    while (/[.,;:!?'")\]>]$/.test(raw)) {
      const ch = raw[raw.length - 1];
      if ((ch === ')' && raw.split('(').length > raw.split(')').length - 1) || (ch === ']' && raw.includes('['))) break;
      raw = raw.slice(0, -1);
    }
    const at = m.index!;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ url: /^www\./i.test(raw) ? `https://${raw}` : raw, text: raw });
    last = at + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
