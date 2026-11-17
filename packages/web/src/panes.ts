/**
 * How wide the list and the details panel are on a computer: dragged by their edges (ui/PaneEdge.tsx), kept per
 * device. Absent: the stylesheet's width (--sidebar-w, --details-w). docs/desktop.md "Panel widths".
 */
import { signal } from '@preact/signals';

export type Pane = 'sidebar' | 'details';
type PaneWidths = Partial<Record<Pane, number>>;

/** The stylesheet's widths, which a double-click on an edge goes back to. */
export const PANE_DEFAULT: Record<Pane, number> = { sidebar: 332, details: 320 };
const PANE_MIN: Record<Pane, number> = { sidebar: 220, details: 260 };
const PANE_MAX: Record<Pane, number> = { sidebar: 640, details: 640 };
/** The conversation keeps at least this much, however wide the panels beside it are dragged. */
export const CENTER_MIN = 380;
const RAIL = 72;

/**
 * The width a pane may have in a window `windowW` wide, beside `other` (the other pane's width, 0 when it is not open).
 * The pane's own bounds win over the conversation's room, so a narrow window keeps a usable list.
 */
export function clampPane(pane: Pane, w: number, windowW: number, other: number): number {
  const room = windowW - RAIL - other - CENTER_MIN;
  return Math.round(Math.max(PANE_MIN[pane], Math.min(PANE_MAX[pane], room, w)));
}

const KEY = 'dither-chat:panes';
function stored(): PaneWidths {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    const out: PaneWidths = {};
    for (const p of ['sidebar', 'details'] as Pane[]) if (typeof v?.[p] === 'number' && v[p] > 0) out[p] = v[p];
    return out;
  } catch {
    return {};
  }
}
export const paneWidths = signal<PaneWidths>(typeof localStorage === 'undefined' ? {} : stored());

/** Keep a width, or forget it (null) to go back to the stylesheet's. */
export function setPaneWidth(pane: Pane, w: number | null) {
  const next = { ...paneWidths.value };
  if (w == null) delete next[pane];
  else next[pane] = w;
  paneWidths.value = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
}
