/**
 * The people graph's circles and rings (src/graph/ties.ts, importance.ts, layout.ts): ties between people, the circles
 * they make and their slices, importance's parts and its fit to what came next, and a layout that keeps to the rings.
 */
import { describe as group, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_TUNING, fit, importance, thisMonth } from '../src/graph/importance.ts';
import { Layout } from '../src/graph/layout.ts';
import { index } from '../src/graph/model.ts';
import { circleOf, circles, describe, slices, ties } from '../src/graph/ties.ts';

// Ten people in two small groups of five (0–4 in "Climbing", 5–9 in "Choir"), and a big server of 80 with everyone in
// it and seventy strangers. Talk between people: within each group, and once across (4 and 5).
const N = 80;
const people: P.GraphPerson[] = Array.from({ length: N }, (_, i) => ({ id: `per_${i}`, name: `P${i}`, networks: ['discord'], dm: [] }));
const links: number[] = [];
for (let i = 0; i < 5; i++) links.push(i, 0, 4);
for (let i = 5; i < 10; i++) links.push(i, 1, 4);
for (let i = 0; i < N; i++) links.push(i, 2, 1);
const graph: P.PeopleGraph = {
  members: true,
  accounts: ['acc_a'],
  people,
  places: [
    { id: 'cnv_climb', kind: 'group', name: 'Climbing', network: 'discord', accounts: [0] },
    { id: 'cnv_choir', kind: 'group', name: 'Choir', network: 'discord', accounts: [0] },
    { id: 'spc_big', kind: 'space', name: 'Big', network: 'discord', accounts: [0] },
  ],
  links,
};
const ix = index(graph);
const now = thisMonth();
const ids = people.map((p) => p.id);
/** A tie's run: [a, b, n, month, weight × 10…]. */
const run = (a: number, b: number, w: number, mo = now) => [a, b, 1, mo, w * 10];
const tieLinks = [...run(0, 1, 20), ...run(1, 2, 20), ...run(2, 3, 20), ...run(3, 4, 20), ...run(0, 4, 20), ...run(5, 6, 20), ...run(6, 7, 20), ...run(7, 8, 20), ...run(8, 9, 20), ...run(5, 9, 20), ...run(4, 5, 2)];
const act: P.GraphActivity = { from: now - 24, to: now, people: { per_0: [now - 1, 300] }, mutual: {}, ties: { ids, links: tieLinks, friends: [2, 7] } };

group('ties', () => {
  const t = ties(ix, act, now, DEFAULT_TUNING.fade);
  const w = (a: number, b: number) => {
    for (let k = t.start[a]; k < t.start[a + 1]; k++) if (t.to[k] === b) return t.w[k];
    return 0;
  };
  test('both ways, 0 to 1, stronger between people who talk', () => {
    expect(w(0, 1)).toBeCloseTo(w(1, 0), 6);
    expect(w(0, 1)).toBeGreaterThan(w(4, 5));
    for (const x of t.w) expect(x).toBeGreaterThan(0), expect(x).toBeLessThanOrEqual(1);
  });
  test('a small place ties its people; a server of 80 ties no one; a profile’s friendship does', () => {
    expect(w(10, 11)).toBe(0);
    expect(w(0, 3)).toBeGreaterThan(0);
    expect(w(2, 7)).toBeGreaterThan(0);
  });
  test('time in voice together ties two people, times your voice weight, and says how much of the tie it is', () => {
    const vact: P.GraphActivity = { ...act, ties: { ...act.ties!, voice: run(10, 11, 30) } };
    const vw = (tt: ReturnType<typeof ties>, a: number, b: number) => {
      for (let k = tt.start[a]; k < tt.start[a + 1]; k++) if (tt.to[k] === b) return [tt.w[k], tt.voice[k]];
      return [0, 0];
    };
    const on = ties(ix, vact, now, DEFAULT_TUNING.fade);
    expect(vw(on, 10, 11)[0]).toBeGreaterThan(0);
    expect(vw(on, 10, 11)[1]).toBeCloseTo(1, 6);
    expect(vw(on, 0, 1)[1]).toBe(0);
    expect(vw(ties(ix, vact, now, DEFAULT_TUNING.fade, 3), 10, 11)[0]).toBeGreaterThan(vw(on, 10, 11)[0]);
    expect(vw(ties(ix, vact, now, DEFAULT_TUNING.fade, 0), 10, 11)[0]).toBe(0);
  });
  test('close to your people: tied to someone you talk with', () => {
    const base = new Float32Array(N);
    base[0] = 1;
    const c = circleOf(t, base);
    expect(c[1]).toBeGreaterThan(0);
    expect(c[6]).toBe(0);
  });
});

group('circles', () => {
  const t = ties(ix, act, now, DEFAULT_TUNING.fade);
  const shown = [...Array(N).keys()];
  const of = circles(t, shown);
  test('the two groups are two circles; strangers are in none', () => {
    expect(new Set(of.slice(0, 5)).size).toBe(1);
    expect(new Set(of.slice(5, 10)).size).toBe(1);
    expect(of[0]).not.toBe(of[5]);
    expect(of[0]).toBeGreaterThanOrEqual(0);
    expect([...of.slice(10)].every((c) => c === -1)).toBe(true);
  });
  test('named after the place they share, their slices side by side, the most important at the top', () => {
    const score = new Float32Array(N);
    score[0] = 1;
    const cs = describe(
      ix,
      of,
      score,
      (p) => people[p].name,
      (q) => graph.places[q].name!,
    );
    expect(cs[of[0]].name).toBe('Climbing');
    expect(cs[of[5]].name).toBe('Choir');
    const s = slices(t, of, cs, 70);
    expect(s.at[of[0]] - s.half[of[0]]).toBeCloseTo(-Math.PI / 2, 5);
    expect(s.half[of[0]] + s.half[of[5]]).toBeLessThan(Math.PI);
  });
});

group('importance', () => {
  test('its parts add up to the score, each signal times its weight', () => {
    const t = ties(ix, act, now, DEFAULT_TUNING.fade);
    const imp = importance(ix, act, null, DEFAULT_TUNING, t);
    const K = 6;
    for (const i of [0, 1, 6, 20]) {
      let s = 0;
      for (let k = 0; k < K; k++) s += imp.parts[i * K + k];
      expect(s / imp.top).toBeCloseTo(imp.score[i], 5);
    }
    // Tied to the one you talk with counts; the same tie to a stranger does not.
    expect(imp.parts[1 * K + 5]).toBeGreaterThan(0);
    expect(imp.parts[6 * K + 5]).toBe(0);
    const noTalk = importance(ix, act, null, { ...DEFAULT_TUNING, weights: { ...DEFAULT_TUNING.weights, talk: 0 } }, t);
    expect(noTalk.parts[0]).toBe(0);
  });

  test('fit: from six months ago, the weights that best found who you went on to talk with', () => {
    // You talked with 0 long ago; since, with the five people tied to 0 then (5–9), not the ones before them (1–4).
    const people: Record<string, number[]> = { per_0: [now - 10, 400] };
    for (const p of [5, 6, 7, 8, 9]) people[`per_${p}`] = [now - 2, 100];
    const past = (a: number, b: number) => run(a, b, 20, now - 9);
    const a2: P.GraphActivity = { ...act, people, ties: { ids, links: [5, 6, 7, 8, 9].flatMap((p) => past(0, p)), friends: [] } };
    const none = { ...DEFAULT_TUNING, weights: { ...DEFAULT_TUNING.weights, circle: 0, places: 0, friends: 0 } };
    const f = fit(ix, a2, none)!;
    expect(f.of).toBe(5);
    expect(f.after).toBeGreaterThan(f.before);
    expect(f.tuning.weights.circle).toBeGreaterThan(0);
    expect(f.tuning.weights.talk).toBe(1);
    expect(f.tuning.fitted?.after).toBeCloseTo(f.after / f.of, 5);
    // Too little talk since to fit to.
    expect(fit(ix, { ...a2, people: { per_0: [now - 10, 400] } })).toBeNull();
  });
});

test('a layout on rings settles each node at its distance and in its slice', () => {
  const n = 41;
  // You (0) and forty people, two circles of twenty: one in the slice at the top, one at the bottom.
  const edges: number[] = [];
  for (let i = 1; i < n; i++) edges.push(0, i);
  const pos = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) pos[i] = (Math.random() - 0.5) * 50;
  const radius = new Float32Array(n).fill(-1);
  const angle = new Float32Array(n).fill(NaN);
  const spread = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    radius[i] = 100 + 5 * i;
    angle[i] = i <= 20 ? -Math.PI / 2 : Math.PI / 2;
    spread[i] = Math.PI / 4;
  }
  const l = new Layout({ n, edges: Uint32Array.from(edges), pos, fixed: 0, rings: { radius, angle, spread, springs: new Uint32Array(0), pull: new Float32Array(0) } });
  for (let k = 0; k < 600 && !l.done; k++) l.tick();
  let off = 0;
  for (let i = 1; i < n; i++) {
    const x = l.pos[2 * i];
    const y = l.pos[2 * i + 1];
    off = Math.max(off, Math.abs(Math.hypot(x, y) - radius[i]) / radius[i]);
    let d = Math.atan2(y, x) - angle[i];
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    expect(Math.abs(d)).toBeLessThan(spread[i] * 1.3);
  }
  expect(off).toBeLessThan(0.25);
  expect(l.pos[0]).toBe(0);
});
