/**
 * How much each person matters to you, 0 to 1 (docs/people-graph.md "Who matters"): how much you have talked (from the
 * hub's closeness, by month, fading with time), how many places you share, how many friends you share (as their
 * profile said, and the people you talk with who are in a small group with them), whether one of your accounts lists
 * them as a friend or contact, whether you know them on several networks, and how tied they are to the people you talk
 * with (ties.ts). Each signal has a weight you can tune (GraphTuning, kept by the hub), or fit to what came next: the
 * weights that best pick out, from six months ago, who you went on to talk with most. The graph sizes people by it, and
 * gives the most important ones the room it has: pictures, then names; on rings, the nearer you.
 *
 * And how much each place matters, 0 to 1: your own messages and time there (fading the same way), and how much the
 * people in it matter to you.
 *
 * `asOf` replays it at a month in the past: talk up to then, fading from then; what you share counts for less, since
 * the hub does not know when you came to share it.
 */
import type * as P from '@dither-chat/protocol';
import { GRAPH_WEIGHT_KEYS } from '@dither-chat/protocol';
import type { Index } from './model.ts';
import { circleOf, ties, type Ties } from './ties.ts';

/** The weights before any tuning; talk fades by e every 18 months. */
export const DEFAULT_TUNING: P.GraphTuning = { weights: { talk: 1, places: 0.5, friends: 0.45, listed: 0.6, networks: 0.3, circle: 0.8 }, fade: 18 };
/** Each signal in words, for the card and the tuning panel. */
export const SIGNALS: Record<P.GraphWeightKey, { label: string; about: string }> = {
  talk: { label: 'Talk with you', about: 'Messages between you, either way, in direct chats, small groups and replies in servers; minutes spent in your direct chat, and in a voice channel with them. Older talk counts for less.' },
  places: { label: 'Places you share', about: 'Servers and group chats you are both in, past the first.' },
  friends: { label: 'Friends in common', about: 'As their profile says, and the people you talk with who are in a small group with them.' },
  listed: { label: 'On your friend list', about: 'One of your accounts lists them as a friend or contact.' },
  networks: { label: 'On several networks', about: 'You know them on more than one network.' },
  circle: { label: 'Close to your people', about: 'Tied (replies, reactions, turns, time in voice together, friendships, small places) to the people you talk with most.' },
};
/** A place's: your time and messages there, and the people in it who matter to you. */
const WP = { mine: 1, people: 0.7 };
/** Groups this big or smaller count as friends in common. */
const FRIENDS_GROUP_MAX = 30;

export interface Importance {
  /** Per person, what each signal added (weight × its amount), in GRAPH_WEIGHT_KEYS order, before scaling to 0..1. */
  parts: Float32Array;
  /** What the scores were divided by: the most anyone had. */
  top: number;
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

/** A flat [month, weight × 10] list summed up to a month, fading from it (by e every `fade` months). */
function faded(flat: number[] | undefined, at: number, fade = DEFAULT_TUNING.fade): number {
  let t = 0;
  for (let k = 0; flat && k < flat.length; k += 2) {
    const mo = flat[k];
    if (mo > at) break;
    t += (flat[k + 1] / 10) * Math.exp(-(at - mo) / fade);
  }
  return t;
}

const K = GRAPH_WEIGHT_KEYS.length;

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

/** Each signal's amount per person, before weights: what importance() adds up, and what fit() tries weights on. */
interface Signals {
  /** Per person, K amounts in GRAPH_WEIGHT_KEYS order. */
  x: Float32Array;
  talk: Float32Array;
  friends: Uint16Array;
}

function signals(ix: Index, act: P.GraphActivity | null, at: number, fade: number, t: Ties | null, shared = 1): Signals {
  const g = ix.graph;
  const np = g.people.length;
  const talk = new Float32Array(np);
  if (act) g.people.forEach((p, i) => (talk[i] = faded(act.people[p.id], at, fade)));
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
  // Close to your people: ties to whoever you talk with, each counted by how much you talk with them (0 to 1).
  let tmax = 0;
  for (let i = 0; i < np; i++) tmax = Math.max(tmax, Math.log1p(talk[i]));
  const base = new Float32Array(np);
  if (tmax > 0) for (let i = 0; i < np; i++) base[i] = Math.log1p(talk[i]) / tmax;
  const circ = t ? circleOf(t, base) : new Float32Array(np);
  const x = new Float32Array(np * K);
  for (let i = 0; i < np; i++) {
    const places = ix.pStart[i + 1] - ix.pStart[i];
    const o = i * K;
    x[o] = Math.log1p(talk[i]);
    x[o + 1] = shared * Math.log1p(Math.max(0, places - 1));
    x[o + 2] = shared * Math.log1p(friends[i]);
    x[o + 3] = shared * (g.people[i].friend?.length ? 1 : 0);
    x[o + 4] = shared * (g.people[i].networks.length > 1 ? 1 : 0);
    x[o + 5] = Math.log1p(4 * circ[i]);
  }
  return { x, talk, friends };
}

/** Each person's score from their signals and the weights, unscaled; parts filled in when given. */
function weigh(sg: Signals, w: Float32Array, parts?: Float32Array): Float32Array {
  const np = sg.talk.length;
  const out = new Float32Array(np);
  for (let i = 0; i < np; i++) {
    let s = 0;
    for (let k = 0; k < K; k++) {
      const v = w[k] * sg.x[i * K + k];
      if (parts) parts[i * K + k] = v;
      s += v;
    }
    out[i] = s;
  }
  return out;
}

const weightsOf = (t: P.GraphTuning) => Float32Array.from(GRAPH_WEIGHT_KEYS.map((k) => t.weights[k] ?? 0));

/** Ties for a tuning at a month: what importance() takes, worked out apart since the circles use them too. */
export const tiesAt = (ix: Index, act: P.GraphActivity | null, asOf: number | null, tuning: P.GraphTuning = DEFAULT_TUNING) => ties(ix, act, asOf ?? thisMonth(), tuning.fade, tuning.voice ?? 1);

export function importance(ix: Index, act: P.GraphActivity | null, asOf: number | null, tuning: P.GraphTuning = DEFAULT_TUNING, t: Ties | null = null): Importance {
  const g = ix.graph;
  const np = g.people.length;
  const at = asOf ?? thisMonth();
  const sg = signals(ix, act, at, tuning.fade, t, asOf === null ? 1 : 0.4);
  const parts = new Float32Array(np * K);
  const score = weigh(sg, weightsOf(tuning), parts);
  const { talk, friends } = sg;
  let max = 0;
  for (let i = 0; i < np; i++) {
    // A direct chat with no talk counted yet (closeness still on its way) still counts for something.
    if (!act && g.people[i].dm.length) score[i] += 1.5;
    if (score[i] > max) max = score[i];
  }
  if (max > 0) for (let i = 0; i < np; i++) score[i] /= max;

  // Places: your time and messages there, and the people in it who matter most (cubed, so a crowd of strangers adds
  // up to less than a few friends).
  const nq = g.places.length;
  const spent = new Float32Array(nq);
  const place = new Float32Array(nq);
  let pmax = 0;
  for (let q = 0; q < nq; q++) {
    spent[q] = faded(act?.places?.[g.places[q].id], at, tuning.fade);
    let near = 0;
    for (let k = ix.qStart[q]; k < ix.qStart[q + 1]; k++) near += score[ix.peopleOf[k]] ** 3;
    const s = WP.mine * Math.log1p(spent[q]) + WP.people * Math.log1p(4 * near);
    place[q] = s;
    if (s > pmax) pmax = s;
  }
  if (pmax > 0) for (let q = 0; q < nq; q++) place[q] /= pmax;
  return { score, talk, friends, place, spent, parts, top: max };
}

/**
 * How many of the people you talked with most after the split (k of them) were in the top k by these scores. Only
 * people with a score count as picked: equal zeros pick no one.
 */
function hits(score: Float32Array, future: Float32Array, k: number): number {
  const top = [...score.keys()]
    .filter((i) => score[i] > 0)
    .sort((a, b) => score[b] - score[a] || a - b)
    .slice(0, k);
  const want = new Set([...future.keys()].sort((a, b) => future[b] - future[a] || a - b).slice(0, k));
  let n = 0;
  for (const i of top) if (want.has(i)) n++;
  return n;
}

/**
 * Average precision of the scores at finding everyone you talked with after the split (a little or more). Someone
 * with no score is put halfway down everyone else with none, as no order among them is better than another.
 */
function ap(score: Float32Array, future: Float32Array): number {
  const scored = [...score.keys()].filter((i) => score[i] > 0).sort((a, b) => score[b] - score[a] || a - b);
  let total = 0;
  for (const v of future) if (v >= 3) total++;
  if (!total) return 0;
  let found = 0;
  let sum = 0;
  scored.forEach((i, r) => {
    if (future[i] >= 3) {
      found++;
      sum += found / (r + 1);
    }
  });
  const zeros = score.length - scored.length;
  const at = scored.length + (zeros + 1) / 2;
  for (let i = 0; i < score.length; i++)
    if (!(score[i] > 0) && future[i] >= 3) {
      found++;
      sum += found / at;
    }
  return sum / total;
}

export interface Fit {
  tuning: P.GraphTuning;
  /** The last months fitted on: signals up to `split`, talk in the six months after it. */
  split: number;
  /** How many to find (the people you talked with most after the split, up to 50), found before and after. */
  of: number;
  before: number;
  after: number;
}

/**
 * The weights that best pick out who you would talk with: the signals as of six months ago, scored on the talk since
 * (average precision), and the same a year ago on the six months after it, averaged so the weights do not chase one
 * stretch of time. Weights tried one at a time over a few values, talk's held at 1, for each of a few fades. Null when
 * there is too little talk in the last six months to go by. Before and after are counted on the last six months.
 */
export function fit(ix: Index, act: P.GraphActivity, from: P.GraphTuning = DEFAULT_TUNING, months = 6): Fit | null {
  const g = ix.graph;
  const np = g.people.length;
  const now = Math.min(act.to, thisMonth());
  const futureOf = (split: number) => {
    const out = new Float32Array(np);
    g.people.forEach((p, i) => {
      const flat = act.people[p.id];
      for (let k = 0; flat && k < flat.length; k += 2) if (flat[k] > split && flat[k] <= split + months) out[i] += flat[k + 1] / 10;
    });
    return out;
  };
  const splits = [now - months, now - 2 * months].filter((s) => s >= act.from);
  const futures = splits.map(futureOf);
  const future = futures[0];
  const of = Math.min(50, future.filter((v) => v >= 3).length);
  if (of < 5) return null;
  const cache = new Map<string, Signals>();
  const sig = (split: number, fade: number) => {
    const key = `${split}:${fade}`;
    return cache.get(key) ?? (cache.set(key, signals(ix, act, split, fade, ties(ix, act, split, fade, from.voice ?? 1))), cache.get(key)!);
  };
  const score = (w: Float32Array, fade: number) => {
    let sum = 0;
    let n = 0;
    splits.forEach((split, j) => {
      if (futures[j].some((v) => v >= 3)) {
        sum += ap(weigh(sig(split, fade), w), futures[j]);
        n++;
      }
    });
    return n ? sum / n : 0;
  };
  const w0 = weightsOf(from);
  const before = hits(weigh(sig(splits[0], from.fade), w0), future, of);
  let best = { w: w0, fade: from.fade, ap: score(w0, from.fade) };
  const VALUES = [0, 0.15, 0.3, 0.6, 1, 1.5, 2.2, 3];
  for (const fade of [6, 12, 18, 30, from.fade]) {
    const w = best.w.slice();
    w[0] = 1;
    let cur = score(w, fade);
    for (let round = 0; round < 3; round++)
      for (let k = 1; k < K; k++) {
        let pick = w[k];
        for (const v of VALUES) {
          w[k] = v;
          const a = score(w, fade);
          if (a > cur + 1e-9) {
            cur = a;
            pick = v;
          }
        }
        w[k] = pick;
      }
    if (cur > best.ap + 1e-9) best = { w, fade, ap: cur };
  }
  const after = hits(weigh(sig(splits[0], best.fade), best.w), future, of);
  const weights = Object.fromEntries(GRAPH_WEIGHT_KEYS.map((k, i) => [k, Math.round(best.w[i] * 100) / 100])) as P.GraphTuning['weights'];
  return { tuning: { weights, fade: best.fade, ...(from.voice !== undefined ? { voice: from.voice } : {}), fitted: { at: Date.now(), before: before / of, after: after / of } }, split: splits[0], of, before, after };
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
