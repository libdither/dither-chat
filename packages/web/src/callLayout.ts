/**
 * Where each tile in the call window goes (docs/calls.md "The video window"): pure, so the window (ui/CallWindow.tsx)
 * only draws what this says and the tests can check it without a browser. A tile is a person in the call (their camera
 * when they have it on, else their picture) or a shared screen. Every tile keeps its element across a change and moves
 * to its new rectangle with a CSS transition, so a switch between layouts morphs.
 */

export type Arrange = 'grid' | 'speaker';
/** Your own tile: a tile like everyone else's, a small inset in a corner, or not shown. */
export type MeMode = 'tile' | 'corner' | 'off';
/** Floating over the app, docked above the call's chat (pushing the messages down), or filling its page. */
export type Place = 'float' | 'dock' | 'fill';
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutTile {
  id: string;
  /** Whose (a hub identity id). */
  who?: string;
  /** This device's own: your tile or your shared screen. Never Speaker's big tile unless you pick it. */
  mine?: boolean;
  /** Your own tile (your camera or your picture): what "Your camera" places. */
  self?: boolean;
  /** A shared screen (someone's Go Live, or your own). */
  share?: boolean;
}

export interface LayoutInput {
  /** The tile area's size (the window less its padding). */
  w: number;
  h: number;
  tiles: LayoutTile[];
  arrange: Arrange;
  me: MeMode;
  corner: Corner;
  /** A tile you clicked to see big: Speaker on it, whatever Arrange says, until you click it again. */
  focused?: string | null;
  /** Whom the call features now (call.ts featuredSpeaker): the latest to start talking, never you. */
  featured?: string | null;
  /** The tile Speaker showed last, kept while nobody talks so the big tile does not jump about. */
  lastFocus?: string | null;
}

interface Placed {
  rect: Rect;
  /** Your tile as a small inset in a corner. */
  inset?: boolean;
  /** Not shown (your tile, hidden): it shrinks into its corner and fades. */
  hidden?: boolean;
}

interface Layout {
  tiles: Map<string, Placed>;
  /** The tile Speaker shows big, if it is Speaker. */
  focus: string | null;
}

export const GAP = 8;
/** The window's padding around the tiles: floating, docked, filling a page. */
export const PAD = { float: { x: 10, top: 10, bottom: 10 }, dock: { x: 16, top: 10, bottom: 14 }, fill: { x: 12, top: 12, bottom: 12 } } as const;
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

/** Whether your tile is drawn among the others: chosen so, or it is the only one there is. */
const meInGrid = (input: Pick<LayoutInput, 'me' | 'tiles'>) => input.me === 'tile' || !input.tiles.some((t) => !t.self);

/**
 * Speaker's big tile: the one you clicked; else a screen someone else shares; else whom the call features (their camera
 * over their screen); else the one shown last; else the first that isn't yours. Your own tile or screen is big only
 * when you click it, or when nothing else is there.
 */
export function focusOf(tiles: LayoutTile[], o: { focused?: string | null; featured?: string | null; lastFocus?: string | null } = {}): string | null {
  const ids = new Set(tiles.map((t) => t.id));
  if (o.focused && ids.has(o.focused)) return o.focused;
  const theirs = tiles.filter((t) => !t.mine);
  const share = theirs.find((t) => t.share);
  if (share) return share.id;
  const featured = o.featured ? (theirs.find((t) => t.who === o.featured && !t.share) ?? theirs.find((t) => t.who === o.featured)) : undefined;
  if (featured) return featured.id;
  if (o.lastFocus && theirs.some((t) => t.id === o.lastFocus)) return o.lastFocus;
  return theirs[0]?.id ?? tiles[0]?.id ?? null;
}

/** Speaker is drawn: chosen, or a tile clicked big. */
const speakerOn = (input: Pick<LayoutInput, 'arrange' | 'focused' | 'tiles'>) => input.arrange === 'speaker' || (!!input.focused && input.tiles.some((t) => t.id === input.focused));

export function layoutTiles(input: LayoutInput): Layout {
  const { w: W, h: H } = input;
  const out = new Map<string, Placed>();
  const inGrid = meInGrid(input);
  const shown = input.tiles.filter((t) => !t.self || inGrid);
  const self = inGrid ? undefined : input.tiles.find((t) => t.self);
  let focus: string | null = null;
  let bottom = H;

  if (!speakerOn(input) || shown.length <= 1) {
    const n = shown.length;
    const g = bestGrid(n, W, H);
    shown.forEach((t, i) => {
      const col = i % g.cols;
      const row = Math.floor(i / g.cols);
      const inRow = Math.min(g.cols, n - row * g.cols);
      const off = ((g.cols - inRow) * (g.tw + GAP)) / 2;
      out.set(t.id, { rect: { x: off + col * (g.tw + GAP), y: row * (g.th + GAP), w: g.tw, h: g.th } });
    });
    if (speakerOn(input)) focus = shown[0]?.id ?? null;
  } else {
    focus = focusOf(shown, input);
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

/**
 * The tile area's height that fits its tiles at width W with no bars around them (16:9 each): what a window snaps to
 * when a resize ends. In a grid, of the heights that fit (one for each number of columns), the nearest to `h`, the
 * height the resize left it at.
 */
export function fitHeight(input: Omit<LayoutInput, 'corner' | 'lastFocus' | 'featured'>): number {
  const W = input.w;
  const shown = input.tiles.filter((t) => !t.self || meInGrid(input));
  if (speakerOn(input) && shown.length > 1) {
    const big = (W * 9) / 16;
    // The strip's height depends on the whole height: settle it in a few rounds.
    let H = big;
    for (let i = 0; i < 4; i++) H = big + stripHeight(H, shown.length - 1) + GAP;
    return Math.round(H);
  }
  const n = Math.max(1, shown.length);
  let best = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = (W - GAP * (cols - 1)) / cols;
    const H = rows * ((tw * 9) / 16) + (rows - 1) * GAP;
    if (Math.abs(H - input.h) < Math.abs(best - input.h)) best = H;
  }
  return Math.round(best);
}

/** The window's choices, as this device keeps them. Each is absent until you pick it (Auto is absent), and then the automatic one stops. */
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
 * share, focusOf); a phone → Speaker, you in the corner, docked above the chat.
 */
export function autoChoices(o: { people: number; share: boolean; phone: boolean }): Required<Pick<WindowChoices, 'arrange' | 'me' | 'place'>> {
  if (o.phone) return { arrange: 'speaker', me: 'corner', place: 'dock' };
  return { arrange: o.share ? 'speaker' : 'grid', me: o.people === 2 ? 'corner' : 'tile', place: 'float' };
}

/** Where the page on screen has room for the window (ui/CallSlot.tsx): the call's own chat, or its room. */
export type SlotKind = 'page' | 'room';

/**
 * Where the window is now, from where you put it (`chosen`, undefined for Auto). On the call's own chat (`slot` 'page')
 * where you chose, or Auto's: docked on a phone, floating on a computer. In its room (`slot` 'room'), Above chat, Fill
 * and Auto are the room's speakers. Anywhere else Above chat and Fill step down: to the floating window on a computer,
 * to the call bar on a phone (null: no window).
 */
export function placeFor(chosen: Place | undefined, slot: SlotKind | null, phone: boolean): Place | null {
  if (slot === 'room') return chosen === 'float' ? 'float' : 'fill';
  const want = chosen ?? autoChoices({ people: 0, share: false, phone }).place;
  if (want === 'float') return 'float';
  if (slot === 'page') return want;
  return phone ? null : 'float';
}

/** Room for a floating window: the screen less the call bar. */
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A floating window kept inside `b` and no smaller than it may be. */
export function clampFloat(r: Rect, b: Bounds): Rect {
  const w = Math.min(Math.max(MIN_FLOAT.w, r.w), b.w);
  const h = Math.min(Math.max(MIN_FLOAT.h, r.h), b.h);
  return { x: Math.min(Math.max(b.x, r.x), b.x + b.w - w), y: Math.min(Math.max(b.y, r.y), b.y + b.h - h), w, h };
}

/** The floating window where it first opens: the lower right, as the old video panel was. */
export function defaultFloat(b: Bounds): Rect {
  const w = Math.min(560, Math.max(MIN_FLOAT.w, b.w * 0.45));
  const h = Math.round((w - 20) * (9 / 16)) + 20;
  return clampFloat({ x: b.x + b.w - w - 16, y: b.y + b.h - h - 16, w, h }, b);
}

/** The docked strip's height in a conversation `paneH` tall. */
export function clampDock(h: number, paneH: number): number {
  return Math.round(Math.max(MIN_DOCK, Math.min(h, Math.max(MIN_DOCK, paneH - MIN_DOCK))));
}
