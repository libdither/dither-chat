/**
 * Where each video in the call window goes (docs/calls.md "The video window"): pure, so the window (ui/CallWindow.tsx)
 * only draws what this says and the tests can check it without a browser. Every tile keeps its element across a change
 * and moves to its new rectangle with a CSS transition, so a switch between layouts morphs.
 */

export type Arrange = 'grid' | 'speaker';
/** Your own camera: a tile like everyone else, a small inset in a corner, or not shown. */
export type MeMode = 'tile' | 'corner' | 'off';
/** Floating over the conversation, or docked above it, pushing the messages down. */
export type Place = 'float' | 'dock';
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutTile {
  id: string;
  /** This device's own camera. */
  self?: boolean;
  /** A shared screen (someone's Go Live, or your own). */
  share?: boolean;
  /** Its person is talking now. */
  speaking?: boolean;
}

export interface LayoutInput {
  /** The tile area's size (the window less its padding). */
  w: number;
  h: number;
  tiles: LayoutTile[];
  arrange: Arrange;
  me: MeMode;
  corner: Corner;
  /** A tile pinned big (Speaker), by double-click. */
  pinned?: string | null;
  /** The tile Speaker showed last, kept while nobody talks so the big tile does not jump about. */
  lastFocus?: string | null;
}

interface Placed {
  rect: Rect;
  /** Your camera as a small inset in a corner. */
  inset?: boolean;
  /** Not shown (your camera, hidden): it shrinks into its corner and fades. */
  hidden?: boolean;
}

interface Layout {
  tiles: Map<string, Placed>;
  /** The tile Speaker shows big, if it is Speaker. */
  focus: string | null;
}

export const GAP = 8;
/** The window's padding around the tiles, floating and docked. */
export const PAD = { float: { x: 10, top: 10, bottom: 10 }, dock: { x: 16, top: 10, bottom: 14 } } as const;
/** Smallest floating window, and the docked strip's limits. */
const MIN_FLOAT = { w: 240, h: 150 };
const MIN_DOCK = 120;
const INSET_MARGIN = 10;

/** The tile area inside a window of this size. */
export function areaOf(place: Place, w: number, h: number): { w: number; h: number } {
  const p = PAD[place];
  return { w: Math.max(0, w - 2 * p.x), h: Math.max(0, h - p.top - p.bottom) };
}

/** Columns and rows that make n tiles of 16:9 the largest in a W×H area. */
export function bestGrid(n: number, W: number, H: number, gap = GAP): { cols: number; rows: number; tw: number; th: number } {
  let best = { cols: 1, rows: Math.max(1, n), tw: W, th: H, s: -1 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    const tw = (W - gap * (cols - 1)) / cols;
    const th = (H - gap * (rows - 1)) / rows;
    const s = Math.min(tw, (th * 16) / 9);
    if (s > best.s) best = { cols, rows, tw, th, s };
  }
  return { cols: best.cols, rows: best.rows, tw: best.tw, th: best.th };
}

/** The strip under Speaker's big tile: its height for an area H tall, or 0 with nobody in it. */
function stripHeight(H: number, others: number): number {
  return others ? Math.max(44, Math.min(76, H * 0.22)) : 0;
}

/** The inset's size in an area W wide. */
function insetSize(W: number): { w: number; h: number } {
  const w = Math.max(90, Math.min(160, W * 0.24));
  return { w, h: (w * 9) / 16 };
}

/** The corner nearest a rectangle's middle, in a W×H area: where a dragged inset settles. */
export function nearestCorner(r: Rect, W: number, H: number): Corner {
  const left = r.x + r.w / 2 < W / 2;
  const top = r.y + r.h / 2 < H / 2;
  return `${top ? 't' : 'b'}${left ? 'l' : 'r'}` as Corner;
}

/** Whether your camera is drawn as a tile among the others: chosen so, or it is the only video there is. */
const meInGrid = (input: LayoutInput) => input.me === 'tile' || !input.tiles.some((t) => !t.self);

/**
 * Speaker's big tile: the pinned one; else a shared screen; else whoever is talking (a camera over their stream);
 * else the one shown last; else the first.
 */
export function focusOf(tiles: LayoutTile[], pinned?: string | null, lastFocus?: string | null): string | null {
  const ids = new Set(tiles.map((t) => t.id));
  if (pinned && ids.has(pinned)) return pinned;
  const share = tiles.find((t) => t.share && !t.self);
  if (share) return share.id;
  const talking = tiles.filter((t) => t.speaking);
  const talker = talking.find((t) => !t.share) ?? talking[0];
  if (talker) return talker.id;
  if (lastFocus && ids.has(lastFocus)) return lastFocus;
  return tiles[0]?.id ?? null;
}

export function layoutTiles(input: LayoutInput): Layout {
  const { w: W, h: H } = input;
  const out = new Map<string, Placed>();
  const inGrid = meInGrid(input);
  const shown = input.tiles.filter((t) => !t.self || inGrid);
  const self = inGrid ? undefined : input.tiles.find((t) => t.self);
  let focus: string | null = null;
  let bottom = H;

  if (input.arrange === 'grid' || shown.length <= 1) {
    const n = shown.length;
    const g = bestGrid(n, W, H);
    shown.forEach((t, i) => {
      const col = i % g.cols;
      const row = Math.floor(i / g.cols);
      const inRow = Math.min(g.cols, n - row * g.cols);
      const off = ((g.cols - inRow) * (g.tw + GAP)) / 2;
      out.set(t.id, { rect: { x: off + col * (g.tw + GAP), y: row * (g.th + GAP), w: g.tw, h: g.th } });
    });
    if (input.arrange === 'speaker') focus = shown[0]?.id ?? null;
  } else {
    focus = focusOf(shown, input.pinned, input.lastFocus);
    const rest = shown.filter((t) => t.id !== focus);
    const sh = stripHeight(H, rest.length);
    bottom = H - (sh ? sh + GAP : 0);
    out.set(focus!, { rect: { x: 0, y: 0, w: W, h: bottom } });
    const sw = Math.min((sh * 16) / 9, (W - GAP * (rest.length - 1)) / Math.max(1, rest.length));
    const total = rest.length * sw + (rest.length - 1) * GAP;
    rest.forEach((t, i) => out.set(t.id, { rect: { x: (W - total) / 2 + i * (sw + GAP), y: H - sh, w: sw, h: sh } }));
  }

  if (self) {
    const s = insetSize(W);
    const left = input.corner[1] === 'l';
    const top = input.corner[0] === 't';
    const x = left ? INSET_MARGIN : W - s.w - INSET_MARGIN;
    const y = top ? INSET_MARGIN : bottom - s.h - INSET_MARGIN;
    if (input.me === 'corner') out.set(self.id, { rect: { x, y, w: s.w, h: s.h }, inset: true });
    else out.set(self.id, { rect: { x: left ? INSET_MARGIN : W - INSET_MARGIN, y: top ? INSET_MARGIN : bottom - INSET_MARGIN, w: 0, h: 0 }, hidden: true });
  }
  return { tiles: out, focus };
}

/** The window's choices, as this device keeps them. Each is absent until you pick it, and then the automatic one stops. */
export interface WindowChoices {
  arrange?: Arrange;
  me?: MeMode;
  place?: Place;
  corner?: Corner;
  float?: Rect;
  dockH?: number;
}

/**
 * Before you pick: two people in the call → Grid with you in the corner; a screen being shared → Speaker (on the
 * share, focusOf); a phone → Speaker, you in the corner, at the top.
 */
export function autoChoices(o: { people: number; share: boolean; phone: boolean }): Required<Pick<WindowChoices, 'arrange' | 'me' | 'place'>> {
  if (o.phone) return { arrange: 'speaker', me: 'corner', place: 'dock' };
  return { arrange: o.share ? 'speaker' : 'grid', me: o.people === 2 ? 'corner' : 'tile', place: 'float' };
}

/** A floating window kept on screen and no smaller than it may be. */
export function clampFloat(r: Rect, vw: number, vh: number): Rect {
  const w = Math.min(Math.max(MIN_FLOAT.w, r.w), vw);
  const h = Math.min(Math.max(MIN_FLOAT.h, r.h), vh);
  return { x: Math.min(Math.max(0, r.x), vw - w), y: Math.min(Math.max(0, r.y), vh - h), w, h };
}

/** The floating window where it first opens: the conversation's lower right, as the old video panel was. */
export function defaultFloat(vw: number, vh: number): Rect {
  const w = Math.min(560, Math.max(MIN_FLOAT.w, vw * 0.45));
  const h = Math.round((w - 20) * (9 / 16)) + 20;
  return clampFloat({ x: vw - w - 16, y: vh - h - 16, w, h }, vw, vh);
}

/** The docked strip's height in a conversation `paneH` tall. */
export function clampDock(h: number, paneH: number): number {
  return Math.round(Math.max(MIN_DOCK, Math.min(h, Math.max(MIN_DOCK, paneH - MIN_DOCK))));
}
