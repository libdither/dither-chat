/**
 * What Ctrl+K jumps to, and what search lists above its results as "Jump to" (docs/palette.md, docs/search.md):
 * people, communities, folders and places, from what the client already holds, so it answers at once with no hub
 * round trip. Ranked as Ctrl+K ranks them (palette.ts rootKeys): how well the name matches, then the inbox's score.
 */
import type * as P from '@dither-chat/protocol';
import { allCommunities, communitiesOf, convLabel, convTitle, directsOf, netName, people, visibleConv } from './model.ts';
import { db, type Route } from './state.ts';
import { homeRoute } from './opening.ts';
import { fuzzyScore, rootKeys } from './palette.ts';

export interface JumpTarget {
  key: string;
  kind: 'person' | 'community' | 'folder' | 'place';
  label: string;
  sub: string;
  to: Route;
  last: number;
  /** The inbox's score (docs/inbox.md): a person's is their best DM's. */
  score: number | null;
  /** Other words it is found by. */
  also?: string[];
  person?: P.PersonView;
  space?: P.SpaceView;
  conv?: P.ConversationView;
}

const scoreOf = (ids: string[]) => {
  const s = ids.map((id) => db.attention.get(id)?.score).filter((x): x is number => x !== undefined);
  return s.length ? Math.max(...s) : null;
};

export function jumpTargets(): JumpTarget[] {
  const out: JumpTarget[] = [];
  for (const { person, last } of people()) {
    // Found by any of their accounts' names and handles too, not only the name the person goes by.
    const also = person.identityIds.flatMap((id) => ((i) => (i ? [i.displayName, i.handle, i.nickname] : []))(db.identities.get(id))).filter((n): n is string => !!n && n !== person.name);
    out.push({ key: person.id, kind: 'person', label: person.name, sub: 'Person', to: { view: 'people', person: person.id }, last, score: scoreOf(directsOf(person.id).map((d) => d.id)), also, person });
  }
  for (const s of allCommunities()) out.push({ key: s.id, kind: 'community', label: s.name, sub: `${netName(s.network)} community`, to: { view: 'space', space: s.id }, last: 0, score: null, space: s });
  for (const f of db.folders) out.push({ key: f.id, kind: 'folder', label: f.name, sub: 'Folder', to: { view: 'folder', folder: f.id }, last: 0, score: null });
  for (const c of db.conversations.values()) {
    if (!visibleConv(c) || c.shape === 'direct') continue;
    const com = communitiesOf(c)[0];
    out.push({ key: c.id, kind: 'place', label: c.shape === 'channel' ? convLabel(c) : convTitle(c), sub: com ? com.name : netName(c.network), to: homeRoute(c), last: c.lastMessageAt ?? 0, score: scoreOf([c.id]), conv: c });
  }
  return out;
}

/**
 * The best `n` of `all` for what was typed, in Ctrl+K's order. Only names that hold the words as written: Ctrl+K's
 * scattered letters ("lib" in "cLImBing") are a shortcut for a box you type names into, noise beside search results.
 */
export function jumpMatches(all: readonly JumpTarget[], needle: string, n = 5): JumpTarget[] {
  if (!needle.trim()) return [];
  const whole = (t: JumpTarget) => [t.label, ...(t.also ?? [])].some((w) => (fuzzyScore(w, needle.trim()) ?? 0) > 300);
  const byKey = new Map(all.filter(whole).map((t) => [t.key, t]));
  return rootKeys([...byKey.values()], needle.trim(), [])
    .filter((k) => byKey.has(k))
    .slice(0, n)
    .map((k) => byKey.get(k)!);
}
