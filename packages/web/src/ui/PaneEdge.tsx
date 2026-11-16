/**
 * The edge between the list and the conversation, and between the conversation and the details panel: drag it to
 * make the panel wider or narrower, double-click it to go back to the usual width; arrow keys move it when focused.
 * Widths are kept per device (panes.ts). docs/desktop.md "Panel widths".
 */
import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { PANE_DEFAULT, clampPane, paneWidths, setPaneWidth, type Pane } from '../panes.ts';

const VAR: Record<Pane, string> = { sidebar: '--sidebar-w', details: '--details-w' };
/** At or under this the details panel lies over the conversation instead of beside it (styles.css "responsive"). */
const OVERLAY_AT = 1100;

const windowW = signal(typeof innerWidth === 'number' ? innerWidth : 1280);
if (typeof addEventListener === 'function') addEventListener('resize', () => (windowW.value = innerWidth));

/** The width the other pane takes from the conversation's room. */
function otherOf(pane: Pane, detailsOpen: boolean, w: number): number {
  if (pane === 'details') return paneWidths.value.sidebar ?? PANE_DEFAULT.sidebar;
  return detailsOpen && w > OVERLAY_AT ? (paneWidths.value.details ?? PANE_DEFAULT.details) : 0;
}

/** The widths as the window allows them, on the page's root; none on a phone, which lays out its own way. */
export function usePaneWidths(on: boolean, detailsOpen: boolean) {
  const kept = paneWidths.value;
  const w = windowW.value;
  useEffect(() => {
    const root = document.documentElement.style;
    for (const pane of ['sidebar', 'details'] as Pane[]) {
      const v = kept[pane];
      if (on && v != null) root.setProperty(VAR[pane], `${clampPane(pane, v, w, pane === 'details' && w <= OVERLAY_AT ? 0 : otherOf(pane, detailsOpen, w))}px`);
      else root.removeProperty(VAR[pane]);
    }
  }, [on, detailsOpen, kept, w]);
}

export function PaneEdge({ pane, detailsOpen }: { pane: Pane; detailsOpen: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; w: number; id: number; last: number } | null>(null);
  const now = () => {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(VAR[pane]));
    return Number.isFinite(v) ? v : PANE_DEFAULT[pane];
  };
  const fit = (w: number) => clampPane(pane, w, innerWidth, pane === 'details' && innerWidth <= OVERLAY_AT ? 0 : otherOf(pane, detailsOpen, innerWidth));
  const sign = pane === 'sidebar' ? 1 : -1;

  // Gone mid-drag (the panel closed under it): keep where it got to.
  useEffect(
    () => () => {
      if (!drag.current) return;
      document.documentElement.classList.remove('pane-dragging');
      setPaneWidth(pane, drag.current.last);
    },
    [],
  );

  return (
    <div
      ref={el}
      class={`pane-edge pane-edge-${pane}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={pane === 'sidebar' ? 'Width of the list' : 'Width of the details'}
      aria-valuenow={Math.round(paneWidths.value[pane] ?? PANE_DEFAULT[pane])}
      tabIndex={0}
      title="Drag to resize · double-click for the usual width"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const w = now();
        drag.current = { x: e.clientX, w, id: e.pointerId, last: w };
        el.current!.setPointerCapture(e.pointerId);
        document.documentElement.classList.add('pane-dragging');
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || e.pointerId !== d.id) return;
        // Straight onto the root while dragging; the signal (and every reader of it) hears once, at the end.
        d.last = fit(d.w + sign * (e.clientX - d.x));
        document.documentElement.style.setProperty(VAR[pane], `${d.last}px`);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d || e.pointerId !== d.id) return;
        drag.current = null;
        document.documentElement.classList.remove('pane-dragging');
        if (d.last !== d.w) setPaneWidth(pane, d.last);
      }}
      onPointerCancel={() => {
        const d = drag.current;
        drag.current = null;
        document.documentElement.classList.remove('pane-dragging');
        if (d && d.last !== d.w) setPaneWidth(pane, d.last);
      }}
      onDblClick={() => setPaneWidth(pane, null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const by = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
        if (by) {
          e.preventDefault();
          setPaneWidth(pane, fit(now() + sign * by));
        } else if (e.key === 'Home') {
          e.preventDefault();
          setPaneWidth(pane, null);
        }
      }}
    />
  );
}
