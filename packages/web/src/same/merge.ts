/** Merging several suggestions at once (Same person?, docs/same-person.md). */
import type * as P from '@dither-chat/protocol';

/** Ticked pairs joined by the sides they share: one merge each. */
export function components(pairs: P.MatchSuggestion[]): { sides: string[]; keys: string[] }[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const p of pairs) {
    for (const id of [p.a.id, p.b.id]) if (!parent.has(id)) parent.set(id, id);
    parent.set(find(p.a.id), find(p.b.id));
  }
  const out = new Map<string, { sides: string[]; keys: string[] }>();
  for (const p of pairs) {
    const r = find(p.a.id);
    const c = out.get(r) ?? { sides: [], keys: [] };
    for (const id of [p.a.id, p.b.id]) if (!c.sides.includes(id)) c.sides.push(id);
    c.keys.push(p.key);
    out.set(r, c);
  }
  return [...out.values()];
}
