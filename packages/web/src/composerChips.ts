/**
 * Mentions in the message box drawn as chips, the box staying plain text (docs/mentions.md, "In the message box").
 *
 * A body carries a mention as its token (`<@123…>`, `<@person:per_…>`); the box shows the name instead, "@Alice", with
 * the token held right after its @ in invisible Unicode tag characters (U+E0020-E007E, one for each ASCII character)
 * and a cancel tag (U+E007F) after the name. So the box's text says everything by itself: undo, a draft, a paste and
 * the caret keep a chip whole, and nothing has to be kept beside it. What is sent is the box's text taken back to a
 * body (toBody): the tokens, and never a tag character. The tags go after the @, not before it: a browser counts them
 * as one character with the one before them, so a selection could not start between that and the chip.
 *
 * A name is a chip while it is whole, as a font draws a ligature only while all its letters are there: an edit that
 * cuts into one takes it out whole (cuts), and a token typed or pasted whole becomes one (toShown, typedToken) when
 * this device can name it. The chip drawn behind the name, which opens the profile, is ui/ChipLayer.ts.
 */
import type * as P from '@dither-chat/protocol';
import { insideCode } from './emojiComplete.ts';
import { authorName, identityName, netName } from './model.ts';
import { db, isSelfIdentity } from './state.ts';

const TAG = 0xe0000;
/** The cancel tag, which ends a chip. */
const END = '\u{E007F}';
/** A mention a chip can stand for: a role, a hub person or account by reference, or an account by its network's id. */
const TOKEN = /<@(?:&\d{1,32}|(?:person|identity):(?:per|idn)_[\w-]{1,64}|!?[!-;=?-~]{1,128})>/g;
/** A chip in the box: an @, the token's tags (`<@`, its id, `>`), the rest of the name, the cancel tag. */
const CHIP = /@(\u{E003C}\u{E0040}[\u{E0021}-\u{E003D}\u{E003F}-\u{E007E}]{1,140}\u{E003E})([^\n\u{E0000}-\u{E007F}]{0,80})\u{E007F}/gu;
const TAGS = /[\u{E0000}-\u{E007F}]/gu;

export interface Chip {
  /** Where it is in the box's text: from its @ to past its cancel tag. */
  start: number;
  end: number;
  token: string;
  /** What the box shows: "@Alice". */
  label: string;
}

const tagged = (s: string) => String.fromCodePoint(...[...s].map((c) => TAG + c.charCodeAt(0)));
const untagged = (s: string) => String.fromCodePoint(...[...s].map((c) => c.codePointAt(0)! - TAG));
/** What a name can hold after its @: one line, no backtick (code would start there), no tag characters. */
const cleanName = (s: string) => [...s.replace(/^@/, '').replace(/[\n\r`]/g, ' ').replace(TAGS, '')].slice(0, 64).join('');

/** The chip for a token, as the box holds it, its name always starting with @; a token not in plain ASCII stays itself. */
export function chipText(token: string, label: string): string {
  return /^[!-~]{1,140}$/.test(token) ? '@' + tagged(token) + cleanName(label) + END : token;
}

/** The chips in the box's text, first to last. */
export function chipsIn(shown: string): Chip[] {
  if (!shown.includes(END)) return [];
  return [...shown.matchAll(CHIP)].map((m) => ({ start: m.index, end: m.index + m[0].length, token: untagged(m[1]), label: '@' + m[2] }));
}

/** The body the box's text sends: each chip its token, and no tag character left anywhere. */
export function toBody(shown: string): string {
  if (!shown.includes('\uDB40')) return shown;
  return shown.replace(CHIP, (_, t: string) => untagged(t)).replace(TAGS, '');
}

/** What a copy of it reads elsewhere: the names as shown. */
export function toPlain(shown: string): string {
  return shown.includes('\uDB40') ? shown.replace(TAGS, '') : shown;
}

/** The box's text for a body: each token `name` knows becomes its chip; one inside code, or unknown, stays as written. */
export function toShown(body: string, name: (token: string) => string | null): string {
  if (!body.includes('<@')) return body;
  return body.replace(TOKEN, (t: string, at: number) => {
    const label = insideCode(body, at) ? null : name(t);
    return label ? chipText(t, label) : t;
  });
}

/** The token the caret has just closed with its `>`, outside code and outside any chip. */
export function typedToken(shown: string, caret: number): { start: number; end: number; token: string } | null {
  const m = shown.slice(0, caret).match(/<@[^<>\s]{1,140}>$/);
  if (!m) return null;
  const start = caret - m[0].length;
  const token = m[0].match(TOKEN)?.[0] === m[0] ? m[0] : null;
  if (!token || insideCode(shown, start) || chipsIn(shown).some((c) => c.start < caret && start < c.end)) return null;
  return { start, end: caret, token };
}

/**
 * After an edit the box made by itself (a word deleted, a keyboard's correction, a selection typed over): the parts
 * of each chip it cut into but did not take whole, as ranges of `next` to take out, last first. The edit is where
 * `prev` and `next` differ, ending at the caret: an @ typed right before a chip's own @ is not inside it.
 */
export function cuts(prev: string, next: string, caret = next.length): [number, number][] {
  const chips = chipsIn(prev);
  if (!chips.length) return [];
  let s = 0;
  const most = Math.min(prev.length, next.length, next.length - caret);
  while (s < most && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  let p = 0;
  const max = Math.min(prev.length, next.length) - s;
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  const end = prev.length - s;
  const shift = next.length - prev.length;
  const out: [number, number][] = [];
  for (const c of chips) {
    const hit = p === end ? c.start < p && p < c.end : p < c.end && end > c.start;
    if (!hit || (p <= c.start && end >= c.end)) continue;
    if (c.end > end) out.push([end + shift, c.end + shift]);
    if (c.start < p) out.push([c.start, p]);
  }
  return out.sort((a, b) => b[0] - a[0]);
}

/** Names the @ list gave, for tokens this device cannot name from what it holds: a server member the hub never stored, a role. */
const given = new Map<string, string>();

/** The chip for a row of the @ list: what ui/MentionPicker.tsx puts in the box. */
export function chipFor(network: P.Network | undefined, token: string, label: string): string {
  given.set(`${network}|${token}`, label);
  if (given.size > 500) given.delete(given.keys().next().value!);
  return chipText(token, label);
}

/** What a chip of this network's says, as a message names the same token (Timeline.tsx useMdContext); null: not known here. */
export const nameOf =
  (network: P.Network | undefined) =>
  (token: string): string | null => {
    const kept = given.get(`${network}|${token}`);
    if (kept) return kept;
    const ref = token.match(/^<@(person|identity):(\w+)>$/);
    if (ref) {
      if (ref[1] === 'person') {
        const p = db.persons.get(ref[2]);
        return p ? `@${p.name}` : null;
      }
      const i = db.identities.get(ref[2]);
      return i ? `@${authorName(i.id)} · ${netName(i.network)}` : null;
    }
    const id = network && !token.startsWith('<@&') ? db.identityByNative.get(`${network}:${token.slice(2, -1).replace(/^!/, '')}`) : undefined;
    return id ? `@${isSelfIdentity(id) ? identityName(id) : authorName(id)}` : null;
  };

/** Where a chip opens: the person's page, or the account's. */
export function chipTarget(network: P.Network | undefined, token: string): { person: string } | { identity: string } | null {
  const ref = token.match(/^<@(person|identity):(\w+)>$/);
  if (ref) return ref[1] === 'person' ? { person: ref[2] } : { identity: ref[2] };
  if (!network || token.startsWith('<@&')) return null;
  const id = db.identityByNative.get(`${network}:${token.slice(2, -1).replace(/^!/, '')}`);
  return id ? { identity: id } : null;
}
