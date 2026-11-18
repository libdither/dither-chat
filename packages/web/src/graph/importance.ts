/**
 * How much each person matters to you, 0 to 1 (docs/people-graph.md "Who matters"): how much you have talked (from the
 * hub's closeness, by month, fading with time), how many places you share, and how many friends you share (as their
 * profile said, and the people you talk with who are in a small group with them). The graph sizes people by it, and
 * gives the most important ones the room it has: pictures, then names.
 *
 * `asOf` replays it at a month in the past: talk up to then, fading from then; what you share counts for less, since
 * the hub does not know when you came to share it.
 */
import type * as P from '@dither-chat/protocol';
import type { Index } from './model.ts';

/** Talk fades by e every this many months. */
const FADE_MONTHS = 18;
const W = { talk: 1, places: 0.5, friends: 0.45, networks: 0.3 };
/** Groups this big or smaller count as friends in common. */
const FRIENDS_GROUP_MAX = 30;

export interface Importance {
  /** Per person (graph index), 0 to 1. */
  score: Float32Array;
  /** Per person, the talk counted (weighted messages, faded). */
  talk: Float32Array;
  /** Per person, friends in common. */
  friends: Uint16Array;
}

export const thisMonth = () => {
  const d = new Date();
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/** Everyone you have had any talk with, ever: they show linked to you. */
export function talkedWith(graph: P.PeopleGraph, act: P.GraphActivity | null): Uint8Array {
  const out = new Uint8Array(graph.people.length);
  if (act) graph.people.forEach((p, i) => (out[i] = +!!act.people[p.id]));
  return out;
}

export function importance(ix: Index, act: P.GraphActivity | null, asOf: number | null): Importance {
  const g = ix.graph;
  const np = g.people.length;
  const at = asOf ?? thisMonth();
  const talk = new Float32Array(np);
  if (act)
    g.people.forEach((p, i) => {
      const flat = act.people[p.id];
      if (!flat) return;
      let t = 0;
      for (let k = 0; k < flat.length; k += 2) {
        const mo = flat[k];
        if (mo > at) break;
        t += (flat[k + 1] / 10) * Math.exp(-(at - mo) / FADE_MONTHS);
      }
      talk[i] = t;
    });
  // Friends in common: the profile's count, and the people you talk with who share a small group with them.
  const friends = new Uint16Array(np);
  const close = new Set<number>();
  for (let i = 0; i < np; i++) if (talk[i] > 1) close.add(i);
  const seen = new Map<number, Set<number>>();
  g.places.forEach((pl, q) => {
    if (pl.kind !== 'group') return;
    const members = ix.peopleOf.subarray(ix.qStart[q], ix.qStart[q + 1]);
    if (members.length > FRIENDS_GROUP_MAX) return;
    const mine = [...members].filter((p) => close.has(p));
    if (!mine.length) return;
    for (const p of members) {
      let s = seen.get(p);
      for (const o of mine) if (o !== p) (s ??= new Set()).add(o);
      if (s) seen.set(p, s);
    }
  });
  for (let i = 0; i < np; i++) friends[i] = Math.min(65535, Math.max(act?.mutual[g.people[i].id] ?? 0, seen.get(i)?.size ?? 0));
  const shared = asOf === null ? 1 : 0.4;
  const score = new Float32Array(np);
  let max = 0;
  for (let i = 0; i < np; i++) {
    const places = ix.pStart[i + 1] - ix.pStart[i];
    const s =
      W.talk * Math.log1p(talk[i]) +
      shared * (W.places * Math.log1p(Math.max(0, places - 1)) + W.friends * Math.log1p(friends[i]) + W.networks * (g.people[i].networks.length > 1 ? 1 : 0)) +
      // A direct chat with no talk counted yet (closeness still on its way) still counts for something.
      (!act && g.people[i].dm.length ? 1.5 : 0);
    score[i] = s;
    if (s > max) max = s;
  }
  if (max > 0) for (let i = 0; i < np; i++) score[i] /= max;
  return { score, talk, friends };
}

/** A month number as "Mar 2021". */
export function monthName(mo: number): string {
  return new Date(Date.UTC(Math.floor(mo / 12), mo % 12, 1)).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Every person's talk added up by month, from..to: the slider's backdrop. */
export function totals(act: P.GraphActivity): Float32Array {
  const out = new Float32Array(act.to - act.from + 1);
  for (const flat of Object.values(act.people)) for (let k = 0; k < flat.length; k += 2) if (flat[k] >= act.from && flat[k] <= act.to) out[flat[k] - act.from] += flat[k + 1] / 10;
  return out;
}
