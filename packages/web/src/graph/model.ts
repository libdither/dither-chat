/**
 * Which part of the people graph to draw (docs/people-graph.md): filters by network, account and server, and a cap so
 * the view stays quick, keeping the busiest. Nodes are numbered people first, then places.
 */
import type * as P from '@dither-chat/protocol';

export interface Filters {
  /** Only these networks; empty is all. */
  networks: P.Network[];
  /** Only places this account sees (an index into graph.accounts), and who is in them. */
  account: number | null;
  /** One place (an index into graph.places): who is in it, and the other places they are in. */
  place: number | null;
  groups: boolean;
  bots: boolean;
  /** Only people in two places or more: the ones who connect places. */
  shared: boolean;
  /** At most this many nodes. */
  cap: number;
}

export const DEFAULT_FILTERS: Filters = { networks: [], account: null, place: null, groups: true, bots: false, shared: false, cap: 6000 };

/** Who is in what, both ways, as compressed rows. */
export interface Index {
  graph: P.PeopleGraph;
  /** person → places: placesOf.slice(pStart[i], pStart[i + 1]) */
  pStart: Uint32Array;
  placesOf: Uint32Array;
  qStart: Uint32Array;
  peopleOf: Uint32Array;
}

export function index(graph: P.PeopleGraph): Index {
  const np = graph.people.length;
  const nq = graph.places.length;
  const m = graph.links.length / 3;
  const pStart = new Uint32Array(np + 1);
  const qStart = new Uint32Array(nq + 1);
  for (let k = 0; k < m; k++) {
    pStart[graph.links[3 * k] + 1]++;
    qStart[graph.links[3 * k + 1] + 1]++;
  }
  for (let i = 0; i < np; i++) pStart[i + 1] += pStart[i];
  for (let i = 0; i < nq; i++) qStart[i + 1] += qStart[i];
  const placesOf = new Uint32Array(m);
  const peopleOf = new Uint32Array(m);
  const pf = pStart.slice(0, np);
  const qf = qStart.slice(0, nq);
  for (let k = 0; k < m; k++) {
    const p = graph.links[3 * k];
    const q = graph.links[3 * k + 1];
    placesOf[pf[p]++] = q;
    peopleOf[qf[q]++] = p;
  }
  return { graph, pStart, placesOf, qStart, peopleOf };
}

export interface Visible {
  /** Node ids: a person i is i, a place q is people.length + q. */
  nodes: Uint32Array;
  /** Pairs of positions in `nodes`. */
  edges: Uint32Array;
  /** Links each shown node has among those shown. */
  degree: Uint32Array;
  /** How many people and places pass the filters, before the cap. */
  matching: { people: number; places: number };
  shown: { people: number; places: number };
}

export function visible(ix: Index, f: Filters): Visible {
  const g = ix.graph;
  const np = g.people.length;
  const nq = g.places.length;
  const nets = f.networks.length ? new Set(f.networks) : null;
  const placeOk = new Uint8Array(nq);
  for (let q = 0; q < nq; q++) {
    const pl = g.places[q];
    placeOk[q] = +((f.groups || pl.kind !== 'group') && (!nets || nets.has(pl.network)) && (f.account === null || pl.accounts.includes(f.account)));
  }
  const personOk = new Uint8Array(np);
  for (let p = 0; p < np; p++) {
    const pe = g.people[p];
    personOk[p] = +((f.bots || !pe.bot) && (!nets || pe.networks.some((n) => nets.has(n))));
  }
  // One place: its people, and the other places they are in.
  if (f.place !== null && f.place < nq) {
    const focus = f.place;
    const inFocus = new Uint8Array(np);
    for (let k = ix.qStart[focus]; k < ix.qStart[focus + 1]; k++) {
      const p = ix.peopleOf[k];
      if (personOk[p]) inFocus[p] = 1;
    }
    personOk.set(inFocus);
    placeOk[focus] = 1;
  }
  // Each person's links to places that pass.
  const deg = new Uint32Array(np);
  for (let p = 0; p < np; p++) {
    if (!personOk[p]) continue;
    for (let k = ix.pStart[p]; k < ix.pStart[p + 1]; k++) if (placeOk[ix.placesOf[k]]) deg[p]++;
  }
  const min = f.shared ? 2 : 1;
  let people: number[] = [];
  for (let p = 0; p < np; p++) if (personOk[p] && deg[p] >= min) people.push(p);
  // A place shows when someone shown is in it.
  const placeDeg = new Uint32Array(nq);
  const countPlaces = (list: number[]) => {
    placeDeg.fill(0);
    for (const p of list) for (let k = ix.pStart[p]; k < ix.pStart[p + 1]; k++) if (placeOk[ix.placesOf[k]]) placeDeg[ix.placesOf[k]]++;
  };
  countPlaces(people);
  const matchingPlaces = placeDeg.reduce((a, d) => a + (d ? 1 : 0), 0);
  const matching = { people: people.length, places: matchingPlaces };
  // Over the cap: the busiest places, then the people most connected to what is left.
  if (people.length + matchingPlaces > f.cap) {
    let places = [...Array(nq).keys()].filter((q) => placeDeg[q]).sort((a, b) => placeDeg[b] - placeDeg[a]);
    places = places.slice(0, Math.max(1, Math.min(places.length, Math.floor(f.cap / 4))));
    const keep = new Uint8Array(nq);
    for (const q of places) keep[q] = 1;
    if (f.place !== null) keep[f.place] = 1;
    for (let q = 0; q < nq; q++) placeOk[q] &&= keep[q];
    const d2 = (p: number) => {
      let n = 0;
      for (let k = ix.pStart[p]; k < ix.pStart[p + 1]; k++) if (placeOk[ix.placesOf[k]]) n++;
      return n;
    };
    const score = new Map(people.map((p) => [p, d2(p)]));
    people = people.filter((p) => score.get(p)! >= min).sort((a, b) => score.get(b)! - score.get(a)! || a - b);
    people = people.slice(0, Math.max(0, f.cap - places.length));
    countPlaces(people);
  }
  const nodes: number[] = [...people];
  const at = new Int32Array(np + nq).fill(-1);
  people.forEach((p, i) => (at[p] = i));
  for (let q = 0; q < nq; q++)
    if (placeDeg[q]) {
      at[np + q] = nodes.length;
      nodes.push(np + q);
    }
  const edges: number[] = [];
  const degree = new Uint32Array(nodes.length);
  for (const p of people)
    for (let k = ix.pStart[p]; k < ix.pStart[p + 1]; k++) {
      const q = ix.placesOf[k];
      const b = at[np + q];
      if (b < 0 || !placeOk[q]) continue;
      edges.push(at[p], b);
      degree[at[p]]++;
      degree[b]++;
    }
  return { nodes: Uint32Array.from(nodes), edges: Uint32Array.from(edges), degree, matching, shown: { people: people.length, places: nodes.length - people.length } };
}

/**
 * The people someone shares places with, most shared first: how many, and whether they are on another of your
 * accounts (each has a direct chat with you, through accounts with none in common).
 */
export function sharesWith(ix: Index, p: number, limit = 30): { person: number; shared: number; otherAccount: boolean }[] {
  const g = ix.graph;
  const count = new Map<number, number>();
  for (let k = ix.pStart[p]; k < ix.pStart[p + 1]; k++) {
    const q = ix.placesOf[k];
    for (let j = ix.qStart[q]; j < ix.qStart[q + 1]; j++) {
      const o = ix.peopleOf[j];
      if (o !== p) count.set(o, (count.get(o) ?? 0) + 1);
    }
  }
  const mine = g.people[p].dm;
  return [...count]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([o, n]) => {
      const theirs = g.people[o].dm;
      return { person: o, shared: n, otherAccount: mine.length > 0 && theirs.length > 0 && !theirs.some((a) => mine.includes(a)) };
    });
}

/** The places a person is in, or the people in a place. */
export function neighbours(ix: Index, node: number): number[] {
  const np = ix.graph.people.length;
  if (node < np) return [...ix.placesOf.subarray(ix.pStart[node], ix.pStart[node + 1])].map((q) => np + q);
  const q = node - np;
  return [...ix.peopleOf.subarray(ix.qStart[q], ix.qStart[q + 1])];
}
