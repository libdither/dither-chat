/** The people graph's model and layout (src/graph): filters, the cap, who shares what, and a layout that settles. */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { Layout, seed } from '../src/graph/layout.ts';
import { importance } from '../src/graph/importance.ts';
import { DEFAULT_FILTERS, index, meNode, neighbours, otherAccounts, sharesWith, visible } from '../src/graph/model.ts';

// Accounts: 0 Discord main, 1 Discord alt, 2 Signal. Places: 0 server A (main and alt), 1 server B (alt), 2 a
// Signal group. Ann is in A and the group; Bob in A and B; Cy in B; Dee in the group; a bot in A.
const graph: P.PeopleGraph = {
  members: true,
  accounts: ['acc_a', 'acc_b', 'acc_c'],
  people: [
    { id: 'per_ann', name: 'Ann', networks: ['discord', 'signal'], dm: [0] },
    { id: 'per_bob', name: 'Bob', networks: ['discord'], dm: [1] },
    { id: 'idn_cy', identity: true, name: 'Cy', networks: ['discord'], dm: [] },
    { id: 'per_dee', name: 'Dee', networks: ['signal'], dm: [2] },
    { id: 'idn_bot', identity: true, name: 'Bot', networks: ['discord'], dm: [], bot: true },
  ],
  places: [
    { id: 'spc_a', kind: 'space', name: 'A', network: 'discord', accounts: [0, 1] },
    { id: 'spc_b', kind: 'space', name: 'B', network: 'discord', accounts: [1] },
    { id: 'cnv_g', kind: 'group', name: null, network: 'signal', accounts: [2] },
  ],
  links: [0, 0, 1, 0, 2, 4, 1, 0, 1, 1, 1, 1, 2, 1, 2, 3, 2, 4, 4, 0, 1],
};
const ix = index(graph);
const NP = graph.people.length;
const names = (v: ReturnType<typeof visible>) => [...v.nodes].map((g) => (g < NP ? graph.people[g].name : graph.places[g - NP].id)).sort();

describe('visible', () => {
  test('everyone with a link, bots left out by default', () => {
    const v = visible(ix, DEFAULT_FILTERS);
    expect(names(v)).toEqual(['Ann', 'Bob', 'Cy', 'Dee', 'cnv_g', 'spc_a', 'spc_b']);
    expect(v.edges.length / 2).toBe(6);
    expect(visible(ix, { ...DEFAULT_FILTERS, bots: true }).nodes).toContain(4);
  });

  test('edges join shown nodes, each once', () => {
    const v = visible(ix, { ...DEFAULT_FILTERS, bots: true });
    const seen = new Set<string>();
    for (let k = 0; k < v.edges.length; k += 2) {
      expect(v.edges[k]).toBeLessThan(v.nodes.length);
      expect(v.edges[k + 1]).toBeLessThan(v.nodes.length);
      seen.add(`${v.edges[k]}:${v.edges[k + 1]}`);
    }
    expect(seen.size).toBe(v.edges.length / 2);
    expect(v.edges.length / 2).toBe(graph.links.length / 3);
  });

  test('by network', () => {
    expect(names(visible(ix, { ...DEFAULT_FILTERS, networks: ['signal'] }))).toEqual(['Ann', 'Dee', 'cnv_g']);
  });

  test('by account: the places it sees, and who is in them', () => {
    expect(names(visible(ix, { ...DEFAULT_FILTERS, account: 0 }))).toEqual(['Ann', 'Bob', 'spc_a']);
    expect(names(visible(ix, { ...DEFAULT_FILTERS, account: 1 }))).toEqual(['Ann', 'Bob', 'Cy', 'spc_a', 'spc_b']);
  });

  test('by server: its people, and the other places they are in', () => {
    expect(names(visible(ix, { ...DEFAULT_FILTERS, place: 1 }))).toEqual(['Bob', 'Cy', 'spc_a', 'spc_b']);
  });

  test('without groups, and only people in two places or more', () => {
    expect(names(visible(ix, { ...DEFAULT_FILTERS, groups: false }))).toEqual(['Ann', 'Bob', 'Cy', 'spc_a', 'spc_b']);
    expect(names(visible(ix, { ...DEFAULT_FILTERS, shared: true }))).toEqual(['Ann', 'Bob', 'cnv_g', 'spc_a', 'spc_b']);
  });

  test('the cap keeps the busiest, and says how many matched', () => {
    const v = visible(ix, { ...DEFAULT_FILTERS, cap: 4 });
    expect(v.nodes.length).toBeLessThanOrEqual(4);
    expect(v.matching).toEqual({ people: 4, places: 3 });
    expect(names(v)).toContain('spc_a');
  });
});

describe('who shares what', () => {
  test('people sharing places, most first, marking someone on another account', () => {
    expect(sharesWith(ix, 0)).toEqual([
      { person: 1, shared: 1, otherAccount: true },
      { person: 3, shared: 1, otherAccount: true },
      { person: 4, shared: 1, otherAccount: false },
    ]);
    expect(sharesWith(ix, 1).map((s) => s.person)).toEqual([0, 2, 4]);
  });

  test('neighbours both ways', () => {
    expect(neighbours(ix, 1).sort()).toEqual([NP, NP + 1]);
    expect(neighbours(ix, NP + 2).sort()).toEqual([0, 3]);
  });
});

describe('layout', () => {
  test('settles, with every position a number, linked nodes nearer than the rest', () => {
    const P = 600;
    const Q = 40;
    const e: number[] = [];
    for (let i = 0; i < P; i++) e.push(i, P + (i % Q), i, P + ((i * 7) % Q));
    const edges = new Uint32Array(e);
    const deg = new Uint32Array(P + Q);
    for (const x of edges) deg[x]++;
    const L = new Layout({ n: P + Q, edges, pos: seed(P + Q, (i) => i >= P, deg, edges) });
    let ticks = 0;
    while (!L.done && ticks < 2000) {
      L.tick();
      ticks++;
    }
    expect(L.done).toBe(true);
    expect([...L.pos].every(Number.isFinite)).toBe(true);
    const d = (a: number, b: number) => Math.hypot(L.pos[2 * a] - L.pos[2 * b], L.pos[2 * a + 1] - L.pos[2 * b + 1]);
    let linked = 0;
    let other = 0;
    for (let i = 0; i < P; i++) {
      linked += d(i, P + (i % Q));
      other += d(i, P + ((i % Q) + Q / 2) % Q);
    }
    expect(linked).toBeLessThan(other);
  });

  test('keeps where nodes were', () => {
    const pos = seed(2, () => false, new Uint32Array(2), new Uint32Array(0), new Map([['a', [5, 6] as [number, number]]]), (i) => (i ? 'b' : 'a'));
    expect([pos[0], pos[1]]).toEqual([5, 6]);
    expect(Number.isFinite(pos[2])).toBe(true);
  });
});

describe('you and who matters', () => {
  // Eli: a direct chat, no place shared. Cy: talked with in a server, no direct chat.
  const g2: P.PeopleGraph = { ...graph, me: { name: 'Me' }, people: [...graph.people, { id: 'per_eli', name: 'Eli', networks: ['signal'], dm: [2] }] };
  const ix2 = index(g2);
  const talked = new Uint8Array(g2.people.length);
  talked[2] = 1;

  test('you, last, linked to everyone shown you talk with; someone you only talk with still shows', () => {
    const v = visible(ix2, DEFAULT_FILTERS, talked);
    expect(v.me).toBe(v.nodes.length - 1);
    expect(v.nodes[v.me]).toBe(meNode(g2));
    const mine: string[] = [];
    for (let k = 0; k < v.edges.length; k += 2)
      if (v.edges[k] === v.me || v.edges[k + 1] === v.me) mine.push(g2.people[v.nodes[v.edges[k] === v.me ? v.edges[k + 1] : v.edges[k]]].name);
    expect(mine.sort()).toEqual(['Ann', 'Bob', 'Cy', 'Dee', 'Eli']);
    expect(v.shown.places).toBe(3);
  });

  test('filters that ask for places leave you out, and who shares none', () => {
    for (const f of [{ account: 0 }, { shared: true }, { place: 0 }]) {
      const v = visible(ix2, { ...DEFAULT_FILTERS, ...f }, talked);
      expect(v.me).toBe(-1);
      expect([...v.nodes]).not.toContain(5);
    }
  });

  test('importance: talk most, fading with time; replayed at a month', () => {
    const M = 2024 * 12;
    const act: P.GraphActivity = { from: M - 48, to: M, people: { per_bob: [M - 48, 1000], per_dee: [M, 200] }, mutual: { idn_cy: 3 } };
    const now = importance(ix, act, M);
    expect(now.score[3]).toBe(1);
    expect(now.score[1]).toBeLessThan(1);
    expect(now.friends[2]).toBe(3);
    const then = importance(ix, act, M - 48);
    expect(then.score[1]).toBe(1);
    expect(then.talk[3]).toBe(0);
    for (const s of now.score) expect(s >= 0 && s <= 1).toBe(true);
  });

  test('a fixed node stays in the middle while the rest settle round it, nearer the shorter its link', () => {
    const l = new Layout({ n: 3, edges: Uint32Array.from([0, 1, 0, 2]), pos: Float32Array.from([5, 5, 10, 0, 0, 10]), fixed: 0, len: Float32Array.from([1, 4]) });
    for (let i = 0; i < 400 && !l.done; i++) l.tick();
    expect([l.pos[0], l.pos[1]]).toEqual([0, 0]);
    expect(Math.hypot(l.pos[2], l.pos[3])).toBeLessThan(Math.hypot(l.pos[4], l.pos[5]));
  });

  test('places: your time and messages there most, then the people in it who matter to you', () => {
    const M = 2024 * 12;
    const act: P.GraphActivity = { from: M - 12, to: M, people: { per_dee: [M, 500] }, mutual: {}, places: { spc_b: [M, 3000] } };
    const now = importance(ix, act, M);
    expect(now.place[1]).toBe(1);
    // The group holds Dee, who matters most; server A no one you talk with.
    expect(now.place[2]).toBeGreaterThan(now.place[0]);
    // A year before you were in B, it is down to its people.
    expect(importance(ix, act, M - 12).spent[1]).toBe(0);
    for (const s of now.place) expect(s >= 0 && s <= 1).toBe(true);
  });

  test('a friend on one account seen in a server only another account of that network sees', () => {
    const g3: P.PeopleGraph = { ...graph, people: graph.people.map((p, i) => (i === 0 || i === 1 ? { ...p, friend: [0] } : p)) };
    const ix3 = index(g3);
    const netOf = (a: number) => (['discord', 'discord', 'signal'] as const)[a];
    // Bob: a friend on Discord main, in B, which only Discord alt sees.
    expect(otherAccounts(ix3, 1, netOf)).toEqual([[1, 1]]);
    // Ann: A is seen by main; the Signal group is on another network.
    expect(otherAccounts(ix3, 0, netOf)).toEqual([]);
    expect(otherAccounts(ix3, 2, netOf)).toEqual([]);
  });

  test('tied nodes (who may be one person) end up side by side', () => {
    const pos = Float32Array.from([-200, 0, 200, 0, 0, 200]);
    const l = new Layout({ n: 3, edges: new Uint32Array(0), pos, ties: Uint32Array.from([0, 1]) });
    for (let i = 0; i < 400 && !l.done; i++) l.tick();
    const tied = Math.hypot(l.pos[0] - l.pos[2], l.pos[1] - l.pos[3]);
    expect(tied).toBeLessThan(Math.hypot(l.pos[0] - l.pos[4], l.pos[1] - l.pos[5]));
    expect(tied).toBeLessThan(60);
  });
});
