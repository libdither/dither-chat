/**
 * Ties between people, and the circles they make (docs/people-graph.md "Ties and circles"). A tie between two people, neither of
 * them you, adds up:
 *  - their talk with each other, from the hub (replies, reactions, turns in a small group), fading as talk with you does;
 *  - friends, as a fetched profile says (its friends in common with you are its person's friends too);
 *  - the small places they share (groups and servers of 60 people or fewer here), more the smaller the place.
 * Each is divided by how much both have of it all, so someone who answers everyone in a busy server is not tied to all of
 * them (association strength, with a little added so two people with one reply between them are not tied fully).
 *
 * Circles: groups of people tied more to each other than to the rest (Louvain's modularity, on the people shown), each
 * named after the place most of it shares, or its most important person.
 */
import type * as P from '@dither-chat/protocol';
import type { Index } from './model.ts';

/** What each kind of tie counts for, in messages: a friendship, and a small place shared (split over its people). */
const FRIEND = 6;
const PLACE = 4;
const PLACE_MAX = 60;
/** Added to each side's total before dividing: ties of a few messages count for less. */
const SHRINK = 6;

export interface Ties {
  /** Per person (graph index): its neighbours (to[start[i]..start[i + 1]]) and each tie's strength, 0 to 1. */
  start: Uint32Array;
  to: Uint32Array;
  w: Float32Array;
}

/** A flat [month, weight × 10] list summed up to a month, fading from it. */
function fadedRun(links: number[], k: number, n: number, at: number, fade: number): number {
  let t = 0;
  for (let j = 0; j < n; j++) {
    const mo = links[k + 2 * j];
    if (mo > at) break;
    t += (links[k + 2 * j + 1] / 10) * Math.exp(-(at - mo) / fade);
  }
  return t;
}

export function ties(ix: Index, act: P.GraphActivity | null, at: number, fade: number): Ties {
  const g = ix.graph;
  const np = g.people.length;
  const raw = new Map<number, number>();
  const add = (a: number, b: number, w: number) => {
    if (a === b || a < 0 || b < 0 || !(w > 0)) return;
    const k = a < b ? a * np + b : b * np + a;
    raw.set(k, (raw.get(k) ?? 0) + w);
  };
  const t = act?.ties;
  if (t) {
    const byId = new Map(g.people.map((p, i) => [p.id, i]));
    const at2 = t.ids.map((id) => byId.get(id) ?? -1);
    for (let k = 0; k < t.links.length; ) {
      const n = t.links[k + 2];
      add(at2[t.links[k]], at2[t.links[k + 1]], fadedRun(t.links, k + 3, n, at, fade));
      k += 3 + 2 * n;
    }
    for (let k = 0; k < t.friends.length; k += 2) add(at2[t.friends[k]], at2[t.friends[k + 1]], FRIEND);
  }
  for (let q = 0; q < g.places.length; q++) {
    const n = ix.qStart[q + 1] - ix.qStart[q];
    if (n < 2 || n > PLACE_MAX) continue;
    const w = PLACE / (n - 1);
    for (let x = ix.qStart[q]; x < ix.qStart[q + 1]; x++) for (let y = x + 1; y < ix.qStart[q + 1]; y++) add(ix.peopleOf[x], ix.peopleOf[y], w);
  }
  // Each side's total, then the strengths, as rows both ways.
  const total = new Float32Array(np);
  const deg = new Uint32Array(np + 1);
  for (const [k, w] of raw) {
    const a = Math.floor(k / np);
    const b = k % np;
    total[a] += w;
    total[b] += w;
    deg[a + 1]++;
    deg[b + 1]++;
  }
  for (let i = 0; i < np; i++) deg[i + 1] += deg[i];
  const start = deg;
  const fill = start.slice(0, np);
  const to = new Uint32Array(start[np]);
  const w = new Float32Array(start[np]);
  for (const [k, v] of raw) {
    const a = Math.floor(k / np);
    const b = k % np;
    const s = v / Math.sqrt((total[a] + SHRINK) * (total[b] + SHRINK));
    to[fill[a]] = b;
    w[fill[a]++] = s;
    to[fill[b]] = a;
    w[fill[b]++] = s;
  }
  return { start, to, w };
}

/**
 * Per person, how tied they are to the people who matter to you: the strength of each tie times how much the other
 * matters (0 to 1), added up. Someone close to your close friends.
 */
export function circleOf(t: Ties, base: Float32Array): Float32Array {
  const out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    let s = 0;
    for (let k = t.start[i]; k < t.start[i + 1]; k++) s += t.w[k] * base[t.to[k]];
    out[i] = s;
  }
  return out;
}

/**
 * Circles among `people` (graph indexes): Louvain, moving each person to the neighbouring circle that most raises
 * modularity, then folding circles into one node each and going again, until nothing moves. Returns each person's
 * circle (-1: none, or a circle smaller than `min`), circles numbered biggest first.
 */
export function circles(t: Ties, people: number[], min = 3): Int32Array {
  const np = t.start.length - 1;
  const out = new Int32Array(np).fill(-1);
  const n = people.length;
  if (!n) return out;
  const local = new Int32Array(np).fill(-1);
  people.forEach((p, i) => (local[p] = i));
  // The graph among them, as weighted adjacency rows.
  let adj: Map<number, number>[] = people.map((p) => {
    const m = new Map<number, number>();
    for (let k = t.start[p]; k < t.start[p + 1]; k++) {
      const j = local[t.to[k]];
      if (j >= 0) m.set(j, (m.get(j) ?? 0) + t.w[k]);
    }
    return m;
  });
  let self = new Float64Array(n);
  // Each person's circle, through the levels.
  let member = Int32Array.from({ length: n }, (_, i) => i);
  for (let level = 0; level < 8; level++) {
    const m = adj.length;
    const k = new Float64Array(m);
    let m2 = 0;
    for (let i = 0; i < m; i++) {
      let s = self[i];
      for (const w of adj[i].values()) s += w;
      k[i] = s;
      m2 += s;
    }
    if (m2 <= 0) break;
    const com = Int32Array.from({ length: m }, (_, i) => i);
    const tot = Float64Array.from(k);
    let moved = false;
    for (let pass = 0; pass < 12; pass++) {
      let any = false;
      for (let i = 0; i < m; i++) {
        const ci = com[i];
        const into = new Map<number, number>();
        for (const [j, w] of adj[i]) if (j !== i) into.set(com[j], (into.get(com[j]) ?? 0) + w);
        tot[ci] -= k[i];
        let best = ci;
        let gain = (into.get(ci) ?? 0) - (tot[ci] * k[i]) / m2;
        for (const [c, w] of into) {
          const d = w - (tot[c] * k[i]) / m2;
          if (d > gain + 1e-12) {
            gain = d;
            best = c;
          }
        }
        tot[best] += k[i];
        if (best !== ci) {
          com[i] = best;
          any = true;
          moved = true;
        }
      }
      if (!any) break;
    }
    if (!moved) break;
    // Fold: one node per circle.
    const id = new Map<number, number>();
    for (let i = 0; i < m; i++) if (!id.has(com[i])) id.set(com[i], id.size);
    const next: Map<number, number>[] = Array.from({ length: id.size }, () => new Map());
    const nextSelf = new Float64Array(id.size);
    for (let i = 0; i < m; i++) {
      const a = id.get(com[i])!;
      nextSelf[a] += self[i];
      for (const [j, w] of adj[i]) {
        const b = id.get(com[j])!;
        if (a === b) nextSelf[a] += w;
        else next[a].set(b, (next[a].get(b) ?? 0) + w);
      }
    }
    for (let i = 0; i < n; i++) member[i] = id.get(com[member[i]])!;
    adj = next;
    self = nextSelf;
  }
  // Number circles biggest first; small ones are none.
  const size = new Map<number, number>();
  for (let i = 0; i < n; i++) size.set(member[i], (size.get(member[i]) ?? 0) + 1);
  const order = [...size].filter(([, s]) => s >= min).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const num = new Map(order.map(([c], i) => [c, i]));
  for (let i = 0; i < n; i++) out[people[i]] = num.get(member[i]) ?? -1;
  return out;
}

export interface Circle {
  /** Graph person indexes, most important first. */
  members: number[];
  /** Its name: the place most of it shares, else its most important person. */
  name: string;
  /** The place it is named after (graph place index), if any. */
  place: number | null;
  /** How much it matters: its members' importance added up. */
  weight: number;
}

/** Each circle's members, name and weight. */
export function describe(ix: Index, of: Int32Array, score: Float32Array, nameOf: (person: number) => string, placeName: (q: number) => string): Circle[] {
  const out: Circle[] = [];
  for (let p = 0; p < of.length; p++) {
    const c = of[p];
    if (c < 0) continue;
    while (out.length <= c) out.push({ members: [], name: '', place: null, weight: 0 });
    out[c].members.push(p);
    out[c].weight += score[p];
  }
  for (const c of out) {
    c.members.sort((a, b) => score[b] - score[a] || a - b);
    // The place most of it is in, counting a big place for less: a server everyone is in names nothing.
    const count = new Map<number, number>();
    for (const p of c.members) for (let k = ix.pStart[p]; k < ix.pStart[p + 1]; k++) count.set(ix.placesOf[k], (count.get(ix.placesOf[k]) ?? 0) + 1);
    let best = -1;
    let bs = 0;
    for (const [q, n] of count) {
      const size = ix.qStart[q + 1] - ix.qStart[q];
      const s = n >= Math.max(2, c.members.length * 0.4) ? n / Math.sqrt(size) : 0;
      if (s > bs) {
        bs = s;
        best = q;
      }
    }
    c.place = best >= 0 ? best : null;
    c.name = best >= 0 ? placeName(best) : `${nameOf(c.members[0])}'s circle`;
  }
  return out;
}

/**
 * Each circle's slice of the rings, as [middle angle, half-width] in radians: wider for a bigger and more important
 * circle, circles tied to each other side by side (each next the one most tied to the last), and the people in no
 * circle sharing what is left. The most important circle starts at the top.
 */
export function slices(t: Ties, of: Int32Array, cs: Circle[], loose: number): { at: Float32Array; half: Float32Array } {
  const n = cs.length;
  const at = new Float32Array(n);
  const half = new Float32Array(n);
  if (!n) return { at, half };
  // How tied each two circles are.
  const between = new Map<number, number>();
  for (let p = 0; p < of.length; p++) {
    const a = of[p];
    if (a < 0) continue;
    for (let k = t.start[p]; k < t.start[p + 1]; k++) {
      const b = of[t.to[k]];
      if (b >= 0 && b !== a) between.set(a * n + b, (between.get(a * n + b) ?? 0) + t.w[k]);
    }
  }
  const byWeight = [...cs.keys()].sort((a, b) => cs[b].weight - cs[a].weight || a - b);
  const order = [byWeight[0]];
  const left = new Set(byWeight.slice(1));
  while (left.size) {
    const last = order[order.length - 1];
    let best = -1;
    let bw = -1;
    for (const c of byWeight) {
      if (!left.has(c)) continue;
      const w = between.get(last * n + c) ?? 0;
      if (w > bw) {
        bw = w;
        best = c;
      }
    }
    order.push(best);
    left.delete(best);
  }
  const share = cs.map((c) => Math.sqrt(c.members.length) + 2 * c.weight);
  const rest = loose > 0 ? Math.sqrt(loose) * 0.6 : 0;
  const sum = share.reduce((a, b) => a + b, 0) + rest;
  let a0 = -Math.PI / 2;
  for (const c of order) {
    const w = (2 * Math.PI * share[c]) / sum;
    at[c] = a0 + w / 2;
    half[c] = w / 2;
    a0 += w;
  }
  return { at, half };
}
