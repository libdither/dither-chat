/**
 * Long lists draw their first rows, and the rest a page at a time as the view nears their end (docs/perf.md). The
 * inbox's 500 rows were 8,700 DOM nodes where a phone shows 11, and they were all built again each time the list came
 * back (the Home tab, back from a page).
 */
import type { ComponentChild } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { whenIdle } from '../slices.ts';

/**
 * Rows drawn first: a screenful and a little more (a row is 48 px or taller). The screen's height, not the window's:
 * reading `innerHeight` while a page is being drawn lays it out there and then.
 */
const screenRows = () => Math.min(FIRST_ROWS, Math.ceil((typeof screen === 'object' ? Math.max(screen.height, screen.width) : 900) / 44) + 2);
/** Rows drawn once the page is idle after that: more than the tallest screen holds. */
export const FIRST_ROWS = 60;
/** Rows added each time the view comes within MARGIN of the last one drawn. */
export const MORE_ROWS = 100;
const MARGIN = '0px 0px 1200px 0px';

/**
 * How many of `total` rows to draw, and what goes after them: a marker that draws more when the view nears it. A
 * screenful first, the rest of the first rows once the page is idle (slices.ts): a list coming back (the Home tab, back
 * from a page) was 60 rows in one task, 0.2 to 0.3 s of a phone's at 4x.
 */
export function useShown(total: number): [number, ComponentChild] {
  const [shown, setShown] = useState(screenRows);
  const waiting = shown < FIRST_ROWS && total > shown;
  useEffect(() => (waiting ? whenIdle(() => setShown((n) => Math.max(n, FIRST_ROWS))) : undefined), [waiting]);
  if (total <= shown) return [total, null];
  // The marker only after the first rows: one a screen down would ask for a hundred more at once.
  if (shown < FIRST_ROWS) return [shown, null];
  // Keyed by the count, so each page is a new marker: one still in view after a page asks for the next at once.
  return [shown, <MoreRows key={shown} onMore={() => setShown((n) => n + MORE_ROWS)} />];
}

function MoreRows({ onMore }: { onMore: () => void }) {
  const ref = useNear<HTMLDivElement>(onMore, '.side-scroll, .rail-scroll', MARGIN, true);
  return <div ref={ref} class="more-rows" aria-hidden="true" />;
}

/**
 * Calls `onNear` once when the element comes within `margin` of the view of its nearest `root` (a selector). Key the
 * element by the page it asks for, so one still in view after that page arrives asks for the next.
 */
function useNear<T extends HTMLElement>(onNear: () => void, root: string, margin: string, noObserver: boolean) {
  const ref = useRef<T>(null);
  const call = useRef(onNear);
  call.current = onNear;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') return void (noObserver && call.current());
    let done = false;
    const io = new IntersectionObserver(
      (es) => {
        if (done || !es.some((e) => e.isIntersecting)) return;
        done = true;
        io.disconnect();
        call.current();
      },
      { root: el.closest(root), rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/**
 * A "More results" button that also presses itself when scrolled near (search results, chat and mail). It stays a
 * button: without IntersectionObserver, or after a page that failed, a tap still asks.
 */
export function MoreResults({ onMore, root, busy, class: cls }: { onMore: () => void; root: string; busy?: boolean; class: string }) {
  const ref = useNear<HTMLButtonElement>(onMore, root, '0px 0px 600px 0px', false);
  return (
    <button ref={ref} class={cls} disabled={busy} aria-busy={busy} onClick={onMore}>
      {busy ? 'Loading…' : 'More results'}
    </button>
  );
}
