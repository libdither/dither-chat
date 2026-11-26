/**
 * Typing in the inbox's box narrows the inbox in place (docs/search.md "In the inbox"): the rows whose names hold the
 * words, from what the app already holds, at every key. Messages come from the hub a moment later (ui/Search.tsx
 * `InboxFound`); this part never waits for it.
 */
import { parseSearch, SEARCH_OPS } from '@dither-chat/protocol';
import { communitiesOf, convLabel, convTitle, rowConvs, type InboxRow } from './model.ts';
import { db } from './state.ts';
import { threadName } from './mail/model.ts';

const SPLIT = /[^\p{L}\p{N}]+/u;
const pieces = (s: string) => s.toLowerCase().split(SPLIT).filter(Boolean);
/** Scripts written without spaces (Japanese, Chinese, Thai…): a piece is found anywhere in a name, not only at a word's start. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** The plain words of what was typed, its operators left out. */
export function typedWords(q: string): string[] {
  const s = parseSearch(q);
  return [...s.phrases, ...s.terms].flatMap(pieces);
}

/** Whether `q` asks for more than words (from:, in:, has: and the rest): a message search, not a name. */
export const hasOperators = (q: string) => [...q.matchAll(/(?:^|\s)-?([a-z]+):\S/gi)].some((m) => OPS.has(m[1].toLowerCase()));
const OPS = new Set([...SEARCH_OPS.map((o) => o.op), 'on', 'pinned']);

/** Every word typed starts a word of one of the names: "sa ri" finds Sam Rivera, "riv" too, "am" does not. */
export function namesMatch(names: readonly string[], words: readonly string[]): boolean {
  if (!words.length) return true;
  const all = names.flatMap(pieces);
  const whole = names.join(' ').toLowerCase();
  return words.every((w) => (UNSPACED.test(w) ? whole.includes(w) : all.some((n) => n.startsWith(w))));
}

const identityNames = (ids: readonly string[]) =>
  ids.flatMap((id) => ((i) => (i ? [i.displayName, i.handle, i.nickname] : []))(db.identities.get(id))).filter((n): n is string => !!n);

/** What a row is found by: its title, the person's other names and handles, and the place it is in. */
export function rowNames(r: InboxRow): string[] {
  if (r.kind === 'mail') {
    const t = r.thread;
    return [threadName(t), ...t.from.filter((f) => !f.self).flatMap((f) => [f.name, f.email]).filter((n): n is string => !!n)];
  }
  const out: string[] = [];
  if (r.chat) out.push(r.chat.person.name, ...identityNames(r.chat.person.identityIds));
  for (const c of rowConvs(r)) {
    out.push(convLabel(c));
    if (c.shape === 'direct' && c.peerPersonId) {
      const p = db.persons.get(c.peerPersonId);
      if (p && !r.chat) out.push(p.name, ...identityNames(p.identityIds));
    } else if (c.shape === 'direct') out.push(...identityNames(c.participantIds));
    if (c.shape === 'thread' && c.parentId) {
      const parent = db.conversations.get(c.parentId);
      if (parent) out.push(convTitle(parent));
    }
  }
  for (const s of communitiesOf(r.conv)) out.push(s.name);
  return out;
}

/** The rows that hold every word typed, in the order given (the inbox's). */
export function filterRows(rows: readonly InboxRow[], q: string, names: (r: InboxRow) => string[] = rowNames): InboxRow[] {
  const words = typedWords(q);
  if (!words.length) return [...rows];
  return rows.filter((r) => namesMatch(names(r), words));
}

/** What the shown rows already stand for, so the places found elsewhere leave them out: conversations and people. */
export function rowStandsFor(rows: readonly InboxRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    out.add(r.key);
    if (r.kind === 'mail') continue;
    if (r.chat) out.add(r.chat.person.id);
    for (const c of rowConvs(r)) {
      out.add(c.id);
      if (c.peerPersonId) out.add(c.peerPersonId);
    }
  }
  return out;
}
