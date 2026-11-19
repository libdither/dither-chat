/** src/callLayout.ts: where each video goes in the call window, the automatic choices, and keeping the window on screen. */
import { expect, test } from 'bun:test';
import { areaOf, autoChoices, bestGrid, clampDock, clampFloat, defaultFloat, focusOf, GAP, layoutTiles, nearestCorner, type LayoutInput, type LayoutTile } from '../src/callLayout.ts';

const four: LayoutTile[] = [{ id: 'ana' }, { id: 'bo' }, { id: 'cy' }, { id: 'me', self: true }];
const base = (o: Partial<LayoutInput> = {}): LayoutInput => ({ w: 800, h: 450, tiles: four, arrange: 'grid', me: 'tile', corner: 'br', ...o });
const inside = (r: { x: number; y: number; w: number; h: number }, W: number, H: number) => r.x >= -0.01 && r.y >= -0.01 && r.x + r.w <= W + 0.01 && r.y + r.h <= H + 0.01;
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('the grid picks the columns that make 16:9 tiles largest', () => {
  expect(bestGrid(1, 800, 450).cols).toBe(1);
  expect(bestGrid(2, 800, 450).cols).toBe(2);
  expect(bestGrid(4, 800, 450)).toMatchObject({ cols: 2, rows: 2 });
  // A tall window stacks them.
  expect(bestGrid(3, 300, 900).cols).toBe(1);
});

test('Grid: everyone equal, inside the area, none overlapping, a short last row centred', () => {
  const l = layoutTiles(base({ tiles: four.slice(0, 3) }));
  const rects = [...l.tiles.values()].map((p) => p.rect);
  expect(rects).toHaveLength(3);
  for (const r of rects) expect(inside(r, 800, 450)).toBe(true);
  expect(new Set(rects.map((r) => `${r.w}x${r.h}`)).size).toBe(1);
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBe(false);
  const last = rects[2];
  expect(last.x + last.w / 2).toBeCloseTo(400, 5);
  expect(l.focus).toBeNull();
});

test('Speaker: whoever talks fills the window, the rest in a strip below', () => {
  const tiles = four.map((t) => ({ ...t, speaking: t.id === 'bo' }));
  const l = layoutTiles(base({ tiles, arrange: 'speaker' }));
  expect(l.focus).toBe('bo');
  const big = l.tiles.get('bo')!.rect;
  expect(big).toMatchObject({ x: 0, y: 0, w: 800 });
  const strip = ['ana', 'cy', 'me'].map((id) => l.tiles.get(id)!.rect);
  for (const r of strip) {
    expect(r.y).toBeGreaterThan(big.h);
    expect(r.y + r.h).toBeCloseTo(450, 5);
    expect(inside(r, 800, 450)).toBe(true);
  }
  expect(big.h + GAP + strip[0].h).toBeCloseTo(450, 5);
});

test('Speaker keeps the last big tile while nobody talks; a pin wins over the voice; a share over the voice', () => {
  expect(focusOf(four, null, 'cy')).toBe('cy');
  expect(focusOf(four.map((t) => ({ ...t, speaking: t.id === 'bo' })), 'ana', 'cy')).toBe('ana');
  expect(focusOf([...four, { id: 'ana-screen', share: true }], null, null)).toBe('ana-screen');
  // A talker's camera over their stream.
  expect(focusOf([{ id: 's', share: true, speaking: true, self: true }, { id: 'c', speaking: true }], null, null)).toBe('c');
  // A pinned tile that has gone does not hold.
  expect(focusOf(four, 'gone', null)).toBe('ana');
});

test('your camera in a corner: a small inset, at the chosen corner, above Speaker\'s strip', () => {
  for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
    const l = layoutTiles(base({ me: 'corner', corner }));
    const me = l.tiles.get('me')!;
    expect(me.inset).toBe(true);
    expect(me.rect.w).toBeLessThan(200);
    expect(nearestCorner(me.rect, 800, 450)).toBe(corner);
    // The others share the grid without it.
    expect(l.tiles.get('ana')!.rect.w).toBeGreaterThan(300);
  }
  const s = layoutTiles(base({ me: 'corner', corner: 'br', arrange: 'speaker' }));
  const strip = s.tiles.get('bo')!.rect;
  const me = s.tiles.get('me')!.rect;
  expect(me.y + me.h).toBeLessThan(strip.y);
});

test('your camera hidden shrinks into its corner and is not in the grid; alone, it is shown anyway', () => {
  const l = layoutTiles(base({ me: 'off' }));
  expect(l.tiles.get('me')).toMatchObject({ hidden: true, rect: { w: 0, h: 0 } });
  expect(l.tiles.get('ana')!.rect).toEqual(layoutTiles(base({ tiles: four.slice(0, 3) })).tiles.get('ana')!.rect);
  const alone = layoutTiles(base({ tiles: [{ id: 'me', self: true }], me: 'off' }));
  expect(alone.tiles.get('me')).toMatchObject({ rect: { x: 0, y: 0, w: 800, h: 450 } });
  expect(alone.tiles.get('me')!.hidden).toBeUndefined();
});

test('a layout switch keeps every tile and moves it', () => {
  const tiles = four.map((t) => ({ ...t, speaking: t.id === 'cy' }));
  const g = layoutTiles(base({ tiles }));
  const s = layoutTiles(base({ tiles, arrange: 'speaker', me: 'corner' }));
  expect([...g.tiles.keys()].sort()).toEqual([...s.tiles.keys()].sort());
  for (const id of g.tiles.keys()) expect(g.tiles.get(id)!.rect).not.toEqual(s.tiles.get(id)!.rect);
});

test('automatic choices: two people, a share, a phone', () => {
  expect(autoChoices({ people: 2, share: false, phone: false })).toEqual({ arrange: 'grid', me: 'corner', place: 'float' });
  expect(autoChoices({ people: 5, share: false, phone: false })).toEqual({ arrange: 'grid', me: 'tile', place: 'float' });
  expect(autoChoices({ people: 5, share: true, phone: false }).arrange).toBe('speaker');
  expect(autoChoices({ people: 5, share: false, phone: true })).toEqual({ arrange: 'speaker', me: 'corner', place: 'dock' });
});

test('the floating window stays on screen and no smaller than its least; the dock keeps room for the chat', () => {
  expect(clampFloat({ x: -50, y: 900, w: 400, h: 200 }, 1200, 800)).toEqual({ x: 0, y: 600, w: 400, h: 200 });
  expect(clampFloat({ x: 0, y: 0, w: 10, h: 10 }, 1200, 800)).toMatchObject({ w: 240, h: 150 });
  expect(clampFloat({ x: 0, y: 0, w: 2000, h: 2000 }, 1200, 800)).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
  const d = defaultFloat(1400, 900);
  expect(d.x + d.w).toBe(1384);
  expect(d.y + d.h).toBe(884);
  expect(clampDock(50, 800)).toBe(120);
  expect(clampDock(900, 800)).toBe(680);
  expect(areaOf('float', 500, 300)).toEqual({ w: 480, h: 280 });
  expect(areaOf('dock', 500, 300)).toEqual({ w: 468, h: 276 });
});
