/**
 * What scripts/verify-perf.ts reads from the page (docs/perf.md).
 *
 * Marks are always made: `dither:content` and `dither:fresh` (main.tsx, state.ts), and `dither:timeline` once a
 * conversation switched to shows its newest message. Render counts are kept only with ?perf=1 in the address, on
 * window.__ditherPerf; without it each counted component pays one check of a constant.
 */
export const counting = typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf');

const renders: Record<string, number> = {};
if (counting) (globalThis as { __ditherPerf?: unknown }).__ditherPerf = { renders };

/** One render of this component, counted under ?perf=1. Call it behind `counting`. */
export function rendered(name: string) {
  renders[name] = (renders[name] ?? 0) + 1;
}

/** A mark once what is on screen now has been painted. */
export function markPainted(name: string, detail?: unknown) {
  requestAnimationFrame(() => setTimeout(() => performance.mark(name, { detail })));
}
