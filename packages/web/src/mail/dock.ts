/**
 * Where the composer sits on a computer (docs/mail.md, "Sending"): docked at the bottom right, or wherever it was moved
 * and as big as it was made (by any edge or corner), maximized to the window, or minimized to a bar at the bottom edge. Measured from the window's right and bottom
 * edges, so it stays near its corner as the window changes size; always kept wholly on screen. Remembered per browser.
 */

/** Gaps to the window's right and bottom edges, and the size, in CSS pixels. */
export interface Dock {
  r: number;
  b: number;
  w: number;
  h: number;
}
/** As remembered: `at` null is the default dock; `max` fills the window, and un-maximized goes back to `at`. */
export interface DockSaved {
  at: Dock | null;
  min: boolean;
  max?: boolean;
}

export const MIN_W = 360;
export const MIN_H = 260;
/** A minimized composer: a bar this wide at the bottom edge. */
export const BAR_W = 300;
const GAP = 16;
const KEY = 'dither.mail.dock';

const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Where it starts: bottom right, 560 × 660 where the window has room. */
export function defaultDock(vw: number, vh: number): Dock {
  return { r: GAP, b: GAP, w: Math.max(0, Math.min(560, vw - 2 * GAP)), h: Math.max(0, Math.min(660, vh - 2 * GAP)) };
}

/** Wholly on screen: no smaller than the least size (or the window), no bigger than the window, no edge past it. */
export function clampDock(d: Dock, vw: number, vh: number): Dock {
  const w = clampN(d.w, Math.min(MIN_W, vw), vw);
  const h = clampN(d.h, Math.min(MIN_H, vh), vh);
  return { w, h, r: clampN(d.r, 0, vw - w), b: clampN(d.b, 0, vh - h) };
}

/** Dragged by (dx, dy) from where it was. */
export function moveDock(d: Dock, dx: number, dy: number, vw: number, vh: number): Dock {
  return clampDock({ ...d, r: d.r - dx, b: d.b - dy }, vw, vh);
}

/** An edge or a corner it is resized by: n, s, e, w and the corners between. */
export type Edge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
export const EDGES: Edge[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

/**
 * Its edge or corner pulled by (dx, dy): the opposite edges stay where they are, and it grows no further than the
 * window's edge nor shrinks below the least size.
 */
export function resizeDock(d: Dock, edge: Edge, dx: number, dy: number, vw: number, vh: number): Dock {
  let { r, b, w, h } = d;
  if (edge.includes('w')) w = clampN(d.w - dx, Math.min(MIN_W, vw - d.r), vw - d.r);
  if (edge.includes('n')) h = clampN(d.h - dy, Math.min(MIN_H, vh - d.b), vh - d.b);
  if (edge.includes('e')) {
    // The left edge stays: the right one moves, as far as the window's.
    const left = vw - d.r - d.w;
    w = clampN(d.w + dx, Math.min(MIN_W, vw - left), vw - left);
    r = vw - left - w;
  }
  if (edge.includes('s')) {
    const top = vh - d.b - d.h;
    h = clampN(d.h + dy, Math.min(MIN_H, vh - top), vh - top);
    b = vh - top - h;
  }
  return clampDock({ r, b, w, h }, vw, vh);
}

/** Maximized: the whole window but a gap around it. */
export function maxDock(vw: number, vh: number): Dock {
  const g = vw < 2 * MIN_W || vh < 2 * MIN_H ? 0 : GAP;
  return { r: g, b: g, w: vw - 2 * g, h: vh - 2 * g };
}

/** What was remembered, or the default for anything that is not a dock. */
export function parseDock(raw: string | null): DockSaved {
  const none: DockSaved = { at: null, min: false };
  if (!raw) return none;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return none;
    const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
    const at = v.at && ok(v.at.r) && ok(v.at.b) && ok(v.at.w) && ok(v.at.h) ? { r: v.at.r, b: v.at.b, w: v.at.w, h: v.at.h } : null;
    return v.max === true ? { at, min: v.min === true, max: true } : { at, min: v.min === true };
  } catch {
    return none;
  }
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadDock(store: Store | null = local()): DockSaved {
  try {
    return parseDock(store?.getItem(KEY) ?? null);
  } catch {
    return { at: null, min: false };
  }
}

export function saveDock(s: DockSaved, store: Store | null = local()): void {
  try {
    if (!s.at && !s.min && !s.max) store?.removeItem(KEY);
    else store?.setItem(KEY, JSON.stringify({ at: s.at && { r: Math.round(s.at.r), b: Math.round(s.at.b), w: Math.round(s.at.w), h: Math.round(s.at.h) }, min: s.min, ...(s.max ? { max: true } : {}) }));
  } catch {}
}
