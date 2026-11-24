/**
 * Sort modes and the Organize view (docs/organize.md): pick how the rail and the lists sort, freeze an
 * automatic order into your own, and rearrange many servers at once (OrganizeServers.tsx, a chunk of its own).
 */
import type { SortMode, SortScope } from '@dither-chat/protocol';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { arrange, freezeOrder, organizing, resort, setInteracting, setQuietShelf, setSort, snapshot, SORT_LABELS, sortOf, startArrange } from '../arrange.ts';
import { quietShelfOn } from '../quiet.ts';
import { rev, toast } from '../state.ts';
import { resetUsage } from '../usage.ts';
import { contextMenu, openMenu, type MenuEntry } from './ContextMenu.tsx';
import { drag } from './dnd.tsx';
import { lazyPane } from './LazyPane.tsx';

// ------------------------------------------------------------------ when the order may change

let pointerOnList = false;
let touchedAt = 0;
let listening = false;
const LISTS = '.rail, .sidebar .side-scroll';
/** Moving through a list by keyboard; a button merely left focused by a click does not count. */
const keyboardIn = () => {
  const el = document.activeElement;
  return !!el?.closest(LISTS) && el.matches(':focus-visible');
};
/** Starts measuring and sorting, and tells the sorter what counts as "in use". Idempotent. */
export function startOrganize() {
  if (typeof window === 'undefined') return;
  startArrange();
  if (listening) return;
  listening = true;
  document.addEventListener('pointerover', (e) => (pointerOnList = !!(e.target as Element)?.closest?.(LISTS)), { passive: true });
  // Out of the window altogether.
  document.addEventListener('pointerout', (e) => !e.relatedTarget && (pointerOnList = false), { passive: true });
  window.addEventListener('blur', () => (pointerOnList = false));
  document.addEventListener('touchstart', (e) => (e.target as Element)?.closest?.(LISTS) && (touchedAt = Date.now()), { passive: true, capture: true });
  setInteracting(() => !!drag.value || !!contextMenu.value || pointerOnList || Date.now() - touchedAt < 4000 || keyboardIn());
}

/** Where each row is, from the top of the list's content. */
function rowTops(box: HTMLElement, sel: string) {
  const origin = box.getBoundingClientRect().top - box.scrollTop;
  const id = (x: HTMLElement) => `${x.dataset.dndKey ?? x.dataset.row ?? x.dataset.rowKey}|${x.dataset.dndFolder ?? ''}`;
  return new Map([...box.querySelectorAll<HTMLElement>(sel)].map((x) => [id(x), { el: x, top: x.getBoundingClientRect().top - origin }]));
}

/**
 * Moves animate: each row slides from where it was when the order changed. Rows are `sel`, keyed by their data.
 * Rows are measured only when `version` (the order) changes: before the new order is drawn, from the DOM as it still
 * is, and after. Measuring after every render forced a layout of the whole list each time.
 */
export function useFlip(ref: { current: HTMLElement | null }, version: number, sel = '[data-dnd-key]') {
  const seen = useRef(version);
  const before = useRef<ReturnType<typeof rowTops> | null>(null);
  if (seen.current !== version && !before.current && ref.current && !matchMedia('(prefers-reduced-motion: reduce)').matches) before.current = rowTops(ref.current, sel);
  useLayoutEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    const was = before.current;
    before.current = null;
    const box = ref.current;
    if (!box || !was) return;
    for (const [key, { el, top }] of rowTops(box, sel)) {
      const from = was.get(key)?.top;
      if (from === undefined || Math.abs(from - top) < 1) continue;
      el.animate([{ transform: `translateY(${from - top}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  });
}

// ------------------------------------------------------------------ the sort menu

export const MODES: Record<SortScope, SortMode[]> = { rail: ['manual', 'smart', 'recent', 'az'], people: ['recent', 'smart', 'az'] };
export const HELP: Record<SortMode, string> = {
  manual: 'Your order',
  smart: 'Time you spend',
  recent: 'Latest message first',
  az: 'By name',
};

export function sortEntries(scope: SortScope): MenuEntry[] {
  const mode = sortOf(scope);
  return [
    { kind: 'label', label: scope === 'rail' ? 'Order servers by' : 'Order by' },
    ...MODES[scope].map((m): MenuEntry => ({ label: m === 'manual' || m === 'smart' ? `${SORT_LABELS[m]} (${HELP[m].toLowerCase()})` : SORT_LABELS[m], radio: true, checked: mode === m, run: () => setSort(scope, m) })),
    { kind: 'sep' },
    scope === 'rail' && { label: 'Freeze This Order', icon: 'lock', disabled: mode === 'manual', run: () => freezeOrder() },
    mode === 'smart' && { label: 'Sort Again Now', icon: 'refresh', run: () => resort('asked') },
    scope === 'rail' && { label: 'Quiet Servers on a Shelf', checked: quietShelfOn(), run: () => setQuietShelf(!quietShelfOn()) },
    { label: 'Organize Servers…', icon: 'layers', run: () => (organizing.value = true) },
    {
      label: 'Reset Usage History…',
      icon: 'trash',
      danger: true,
      run: () => {
        if (!confirm('Forget how much you used each place, on every device? Smart order starts over from recent activity.')) return;
        resetUsage()
          .then(() => (resort('asked'), toast({ kind: 'info', title: 'Usage history cleared', body: 'Smart order starts over.' })))
          .catch((e) => toast({ kind: 'error', title: 'Could not reset', body: e.message }));
      },
    },
  ].filter(Boolean) as MenuEntry[];
}

export function SortIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 6h11M3 12h7M3 18h4" />
      <path d="M18 4v16M15 17l3 3 3-3" />
    </svg>
  );
}

/** A small button that opens the sort menu; it says which order is on. */
export function SortButton({ scope, class: cls }: { scope: SortScope; class?: string }) {
  const mode = sortOf(scope);
  const label = `Order: ${SORT_LABELS[mode]}. Click to change`;
  return (
    <button
      class={`icon-btn small sort-btn ${mode !== MODES[scope][0] ? 'on' : ''} ${cls ?? ''}`}
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu({ x: r.left, y: r.bottom + 4 }, { items: sortEntries(scope), label: 'Order', head: <div class="cm-sheet-title">Order</div> }, e.currentTarget);
      }}
    >
      <SortIcon size={15} />
    </button>
  );
}

// ------------------------------------------------------------------ the Organize view

const Organize = lazyPane(() => import('./OrganizeServers.tsx').then((m) => m.Organize), 'Organize', null);

export function OrganizeView() {
  rev.value;
  snapshot.value;
  arrange.value;
  if (!organizing.value) return null;
  return <Organize onClose={() => (organizing.value = false)} />;
}
