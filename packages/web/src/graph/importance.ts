/**
 * How much each person matters to you, 0 to 1 (docs/people-graph.md "Who matters"): how much you have talked (from the
 * hub's closeness, by month, fading with time), how many places you share, how many friends you share (as their
 * profile said, and the people you talk with who are in a small group with them), and whether one of your accounts
 * lists them as a friend or contact. The graph sizes people by it, and gives the most important ones the room it has:
 * pictures, then names.
 *
 * And how much each place matters, 0 to 1: your own messages and time there (fading the same way), and how much the
 * people in it matter to you.
 *
 * `asOf` replays it at a month in the past: talk up to then, fading from then; what you share counts for less, since
 * the hub does not know when you came to share it.
 */
import type * as P from '@dither-chat/protocol';
import type { Index } from './model.ts';

/** Talk fades by e every this many months. */
const FADE_MONTHS = 18;
const W = { talk: 1, places: 0.5, friends: 0.45, networks: 0.3, listed: 0.6 };
/** A place's: your time and messages there, and the people in it who matter to you. */
const WP = { mine: 1, people: 0.7 };
/** Groups this big or smaller count as friends in common. */
const FRIENDS_GROUP_MAX = 30;

export interface Importance {
  /** Per person (graph index), 0 to 1. */
  score: Float32Array;
  /** Per person, the talk counted (weighted messages, faded). */
  talk: Float32Array;
  /** Per person, friends in common. */
  friends: Uint16Array;
  /** Per place (graph place index), 0 to 1. */
  place: Float32Array;
  /** Per place, your messages and minutes there, faded. */
  spent: Float32Array;
}

/** A flat [month, weight × 10] list summed up to a month, fading from it. */
function faded(flat: number[] | undefined, at: number): number {
  let t = 0;
  for (let k = 0; flat && k < flat.length; k += 2) {
    const mo = flat[k];
    if (mo > at) break;
    t += (flat[k + 1] / 10) * Math.exp(-(at - mo) / FADE_MONTHS);
  }
  return t;
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
  if (act) g.people.forEach((p, i) => (talk[i] = faded(act.people[p.id], at)));
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
      shared * (W.places * Math.log1p(Math.max(0, places - 1)) + W.friends * Math.log1p(friends[i]) + W.networks * (g.people[i].networks.length > 1 ? 1 : 0) + W.listed * (g.people[i].friend?.length ? 1 : 0)) +
      // A direct chat with no talk counted yet (closeness still on its way) still counts for something.
      (!act && g.people[i].dm.length ? 1.5 : 0);
    score[i] = s;
    if (s > max) max = s;
  }
  if (max > 0) for (let i = 0; i < np; i++) score[i] /= max;

  // Places: your time and messages there, and the people in it who matter most (cubed, so a crowd of strangers adds
  // up to less than a few friends).
  const nq = g.places.length;
  const spent = new Float32Array(nq);
  const place = new Float32Array(nq);
  let pmax = 0;
  for (let q = 0; q < nq; q++) {
    spent[q] = faded(act?.places?.[g.places[q].id], at);
    let near = 0;
    for (let k = ix.qStart[q]; k < ix.qStart[q + 1]; k++) near += score[ix.peopleOf[k]] ** 3;
    const s = WP.mine * Math.log1p(spent[q]) + WP.people * Math.log1p(4 * near);
    place[q] = s;
    if (s > pmax) pmax = s;
  }
  if (pmax > 0) for (let q = 0; q < nq; q++) place[q] /= pmax;
  return { score, talk, friends, place, spent };
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
