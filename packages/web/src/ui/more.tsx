/**
 * Long lists draw their first rows, and the rest a page at a time as the view nears their end (docs/perf.md). The
 * inbox's 500 rows were 8,700 DOM nodes where a phone shows 11, and they were all built again each time the list came
 * back (the Home tab, back from a page).
 */
import type { ComponentChild } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/** Rows drawn at first: more than the tallest screen holds. */
export const FIRST_ROWS = 60;
/** Rows added each time the view comes within MARGIN of the last one drawn. */
export const MORE_ROWS = 100;
const MARGIN = '0px 0px 1200px 0px';

/** How many of `total` rows to draw, and what goes after them: a marker that draws more when the view nears it. */
export function useShown(total: number): [number, ComponentChild] {
  const [shown, setShown] = useState(FIRST_ROWS);
  if (total <= shown) return [total, null];
  // Keyed by the count, so each page is a new marker: one still in view after a page asks for the next at once.
  return [shown, <MoreRows key={shown} onMore={() => setShown((n) => n + MORE_ROWS)} />];
}

function MoreRows({ onMore }: { onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') return void onMore();
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && onMore(), { root: el.closest('.side-scroll, .rail-scroll'), rootMargin: MARGIN });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} class="more-rows" aria-hidden="true" />;
}
