/** src/callLayout.ts: where each tile goes in the call window, the automatic choices, where the window is, and keeping it on screen. */
import { expect, test } from 'bun:test';
import { areaOf, autoChoices, bestGrid, clampDock, clampFloat, defaultFloat, fitHeight, focusOf, GAP, layoutTiles, nearestCorner, placeFor, tileIn, type LayoutInput, type LayoutTile } from '../src/callLayout.ts';

/** Three people and you: tiles are people (with their camera on or off), not video streams. */
const four: LayoutTile[] = [
  { id: 'p:ana', who: 'ana' },
  { id: 'p:bo', who: 'bo' },
  { id: 'p:cy', who: 'cy' },
  { id: 'p:me', who: 'me', self: true, mine: true },
];
const base = (o: Partial<LayoutInput> = {}): LayoutInput => ({ w: 800, h: 450, tiles: four, arrange: 'grid', me: 'tile', corner: 'br', ...o });
const inside = (r: { x: number; y: number; w: number; h: number }, W: number, H: number) => r.x >= -0.01 && r.y >= -0.01 && r.x + r.w <= W + 0.01 && r.y + r.h <= H + 0.01;
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const screen = { x: 0, y: 0, w: 1200, h: 800 };

test('the grid picks the columns that make its tiles largest', () => {
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

test('a tile is between 4:3 and 16:9, so a camera is never cut to a letterbox or a sliver', () => {
  expect(tileIn(1600, 400)).toEqual({ w: 400 * (16 / 9), h: 400 });
  expect(tileIn(400, 1600)).toEqual({ w: 400, h: 300 });
  expect(tileIn(800, 500)).toEqual({ w: 800, h: 500 });
  // Full screen, two people: side by side (4:3 each) beats one over the other (16:9 each, more black around them).
  const g = bestGrid(2, 1376, 830);
  expect(g.cols).toBe(2);
  // A wide strip of a page: every tile the same size, the row in the middle, none wider than 16:9.
  const l = layoutTiles(base({ w: 1400, h: 300, tiles: four.slice(0, 2) }));
  const rects = [...l.tiles.values()].map((p) => p.rect);
  for (const r of rects) expect(r.w / r.h).toBeLessThanOrEqual(16 / 9 + 1e-9);
  const left = Math.min(...rects.map((r) => r.x));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  expect(left).toBeCloseTo(1400 - right, 5);
});

test('Speaker: whom the call features fills the window, the rest in a strip below', () => {
  const l = layoutTiles(base({ arrange: 'speaker', featured: 'bo' }));
  expect(l.focus).toBe('p:bo');
  const big = l.tiles.get('p:bo')!.rect;
  expect(big).toMatchObject({ x: 0, y: 0, w: 800 });
  const strip = ['p:ana', 'p:cy', 'p:me'].map((id) => l.tiles.get(id)!.rect);
  for (const r of strip) {
    expect(r.y).toBeGreaterThan(big.h);
    expect(r.y + r.h).toBeCloseTo(450, 5);
    expect(inside(r, 800, 450)).toBe(true);
  }
  expect(big.h + GAP + strip[0].h).toBeCloseTo(450, 5);
});

test("Speaker's big tile: a click wins, then someone else's screen, then the featured one, then the last, never yours by itself", () => {
  expect(focusOf(four, { lastFocus: 'p:cy' })).toBe('p:cy');
  expect(focusOf(four, { focused: 'p:ana', featured: 'bo', lastFocus: 'p:cy' })).toBe('p:ana');
  expect(focusOf([...four, { id: 's:ana', who: 'ana', share: true }], { featured: 'bo' })).toBe('s:ana');
  // The featured one's camera over their screen.
  expect(focusOf([{ id: 's:bo', who: 'bo', share: true }, { id: 'p:bo', who: 'bo' }, { id: 'p:me', who: 'me', self: true, mine: true }], { featured: 'bo' })).toBe('s:bo');
  expect(focusOf([{ id: 'p:bo', who: 'bo' }, { id: 's:bo', who: 'bo', share: true, mine: true }], { featured: 'bo' })).toBe('p:bo');
  // A clicked tile that has gone does not hold.
  expect(focusOf(four, { focused: 'gone' })).toBe('p:ana');
  // Your own tile, first in the list and the last shown, is not big: someone else is.
  expect(focusOf([{ id: 'p:me', who: 'me', self: true, mine: true }, ...four.slice(0, 3)], { lastFocus: 'p:me' })).toBe('p:ana');
  // Your own screen is yours (`mine` without `self`): never the big tile over someone else.
  expect(focusOf([{ id: 'my-screen', who: 'me', share: true, mine: true }, ...four.slice(0, 3)], {})).toBe('p:ana');
  // You featured (a stale pick) is not taken: the featured one is never you.
  expect(focusOf(four, { featured: 'me' })).toBe('p:ana');
  // Unless there is nothing else.
  expect(focusOf([{ id: 'p:me', who: 'me', self: true, mine: true }], {})).toBe('p:me');
  // You may click your own big.
  expect(focusOf(four, { focused: 'p:me' })).toBe('p:me');
});

test('a clicked tile is big in Grid too, without changing the arrangement chosen', () => {
  const l = layoutTiles(base({ focused: 'p:cy' }));
  expect(l.focus).toBe('p:cy');
  expect(l.tiles.get('p:cy')!.rect).toMatchObject({ x: 0, y: 0, w: 800 });
  // Unclicked: the grid again.
  expect(layoutTiles(base({ focused: null })).focus).toBeNull();
});

test('your tile in a corner: a small inset, at the chosen corner, above Speaker\'s strip', () => {
  for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
    const l = layoutTiles(base({ me: 'corner', corner }));
    const me = l.tiles.get('p:me')!;
    expect(me.inset).toBe(true);
    expect(me.rect.w).toBeLessThan(200);
    expect(nearestCorner(me.rect, 800, 450)).toBe(corner);
    // The others share the grid without it.
    expect(l.tiles.get('p:ana')!.rect.w).toBeGreaterThan(300);
  }
  const s = layoutTiles(base({ me: 'corner', corner: 'br', arrange: 'speaker' }));
  const strip = s.tiles.get('p:bo')!.rect;
  const me = s.tiles.get('p:me')!.rect;
  expect(me.y + me.h).toBeLessThan(strip.y);
});

test("a screen shown big in a phone's narrow window: your tile joins the strip instead of covering the screen", () => {
  const tiles: LayoutTile[] = [{ id: 's:ana', who: 'ana', share: true }, ...four];
  const narrow = layoutTiles(base({ w: 358, h: 260, tiles, arrange: 'speaker', me: 'corner' }));
  expect(narrow.focus).toBe('s:ana');
  const big = narrow.tiles.get('s:ana')!.rect;
  const me = narrow.tiles.get('p:me')!;
  expect(me.inset).toBeUndefined();
  expect(me.rect.y).toBeGreaterThanOrEqual(big.y + big.h);
  // Wider (a computer's window), it stays an inset in its corner.
  expect(layoutTiles(base({ w: 800, h: 450, tiles, arrange: 'speaker', me: 'corner' })).tiles.get('p:me')!.inset).toBe(true);
});

test('your tile hidden shrinks into its corner and is not in the grid; alone, it is shown anyway', () => {
  const l = layoutTiles(base({ me: 'off' }));
  expect(l.tiles.get('p:me')).toMatchObject({ hidden: true, rect: { w: 0, h: 0 } });
  expect(l.tiles.get('p:ana')!.rect).toEqual(layoutTiles(base({ tiles: four.slice(0, 3) })).tiles.get('p:ana')!.rect);
  const alone = layoutTiles(base({ tiles: [{ id: 'p:me', self: true, mine: true }], me: 'off' }));
  expect(alone.tiles.get('p:me')).toMatchObject({ rect: { x: 0, y: 0, w: 800, h: 450 } });
  expect(alone.tiles.get('p:me')!.hidden).toBeUndefined();
});

test('a layout switch keeps every tile and moves it', () => {
  const g = layoutTiles(base());
  const s = layoutTiles(base({ arrange: 'speaker', me: 'corner', featured: 'cy' }));
  expect([...g.tiles.keys()].sort()).toEqual([...s.tiles.keys()].sort());
  for (const id of g.tiles.keys()) expect(g.tiles.get(id)!.rect).not.toEqual(s.tiles.get(id)!.rect);
});

test('a resize ends with the height that fits the tiles: no bars around them', () => {
  // Two people side by side at 800 wide: one row of 16:9.
  const two = four.slice(0, 2);
  const h = fitHeight({ w: 800, h: 300, tiles: two, arrange: 'grid', me: 'tile' });
  const tw = (800 - GAP) / 2;
  expect(h).toBe(Math.round((tw * 9) / 16));
  // Laid out at that height, each tile is 16:9.
  const r = layoutTiles(base({ tiles: two, h })).tiles.get('p:ana')!.rect;
  expect(r.w / r.h).toBeCloseTo(16 / 9, 1);
  // Speaker: the big tile 16:9 across the width, and the strip under it.
  const s = fitHeight({ w: 640, h: 400, tiles: four, arrange: 'speaker', me: 'tile' });
  const big = layoutTiles(base({ w: 640, h: s, arrange: 'speaker' })).tiles.get('p:ana')!.rect;
  expect(big.w / big.h).toBeCloseTo(16 / 9, 1);
  // A clicked tile counts as Speaker.
  expect(fitHeight({ w: 640, h: 400, tiles: four, arrange: 'grid', me: 'tile', focused: 'p:bo' })).toBe(s);
});

test('automatic choices: two people, a share, a phone', () => {
  expect(autoChoices({ people: 2, share: false, phone: false })).toEqual({ arrange: 'grid', me: 'corner', place: 'float' });
  expect(autoChoices({ people: 5, share: false, phone: false })).toEqual({ arrange: 'grid', me: 'tile', place: 'float' });
  expect(autoChoices({ people: 5, share: true, phone: false }).arrange).toBe('speaker');
  expect(autoChoices({ people: 5, share: false, phone: true })).toEqual({ arrange: 'speaker', me: 'corner', place: 'dock' });
});

test("where the window is: Above chat and Fill only on the call's own chat; elsewhere floating on a computer, the bar on a phone", () => {
  for (const phone of [false, true]) {
    expect(placeFor('float', null, phone)).toBe('float');
    expect(placeFor('float', 'page', phone)).toBe('float');
    expect(placeFor('dock', 'page', phone)).toBe('dock');
    expect(placeFor('fill', 'page', phone)).toBe('fill');
    // A room: Above chat and Fill are its speakers.
    expect(placeFor('dock', 'room', phone)).toBe('fill');
    expect(placeFor('fill', 'room', phone)).toBe('fill');
    expect(placeFor('float', 'room', phone)).toBe('float');
  }
  // Auto: docked on a phone's chat, floating on a computer's; a room's speakers either way.
  expect(placeFor(undefined, 'page', true)).toBe('dock');
  expect(placeFor(undefined, 'page', false)).toBe('float');
  expect(placeFor(undefined, 'room', false)).toBe('fill');
  expect(placeFor(undefined, 'room', true)).toBe('fill');
  expect(placeFor(undefined, null, true)).toBeNull();
  // Settings, another chat: no slot.
  expect(placeFor('dock', null, false)).toBe('float');
  expect(placeFor('fill', null, false)).toBe('float');
  expect(placeFor('dock', null, true)).toBeNull();
  expect(placeFor('fill', null, true)).toBeNull();
});

test('the floating window stays in its bounds (the screen less the call bar) and no smaller than its least; the dock keeps room for the chat', () => {
  expect(clampFloat({ x: -50, y: 900, w: 400, h: 200 }, screen)).toEqual({ x: 0, y: 600, w: 400, h: 200 });
  expect(clampFloat({ x: 0, y: 0, w: 10, h: 10 }, screen)).toMatchObject({ w: 240, h: 150 });
  expect(clampFloat({ x: 0, y: 0, w: 2000, h: 2000 }, screen)).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
  // A call bar at the top (a phone) or the bottom (a computer): never under it.
  expect(clampFloat({ x: 10, y: 0, w: 300, h: 200 }, { x: 0, y: 56, w: 390, h: 788 }).y).toBe(56);
  expect(clampFloat({ x: 10, y: 700, w: 300, h: 200 }, { x: 0, y: 0, w: 1200, h: 748 })).toMatchObject({ y: 548, h: 200 });
  // It first opens at the top right, under the page's header (clear of the newest messages and the message box).
  const d = defaultFloat({ x: 0, y: 0, w: 1400, h: 900 }, 100);
  expect(d.x + d.w).toBe(1384);
  expect(d.y).toBe(112);
  expect(defaultFloat({ x: 0, y: 56, w: 390, h: 788 }).y).toBe(68);
  expect(clampDock(50, 800)).toBe(120);
  expect(clampDock(900, 800)).toBe(680);
  expect(areaOf('float', 500, 300)).toEqual({ w: 480, h: 280 });
  expect(areaOf('dock', 500, 300)).toEqual({ w: 468, h: 276 });
  expect(areaOf('fill', 500, 300)).toEqual({ w: 476, h: 276 });
});
