/**
 * What scripts/verify-perf.ts, scripts/verify-response.ts and scripts/verify-memory.ts read from the page (docs/perf.md).
 *
 * Marks are always made: `dither:content` and `dither:fresh` (main.tsx, state.ts), and `dither:timeline` once a
 * conversation switched to shows its newest message. Render counts are kept only with ?perf=1 in the address, on
 * window.__ditherPerf; without it each counted component pays one check of a constant, and preact's hooks are left
 * alone. Also under ?perf=1, `__ditherPerf.held()` says how much the app's caches hold, for verify-memory.ts.
 */
import { options } from 'preact';

export const counting = typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf');

const renders: Record<string, number> = {};
/**
 * Every component's renders, by its name: `mounts` its first, `updates` each one after, and `live` how many are on
 * the page now. `again` is how many of those on the page at `fresh()` rendered again since, each counted once however
 * often it did: a click that draws a whole list again shows as that list's rows there, the same whether the hub's
 * answer came in one frame or three, and whatever the click itself put on the page (verify-response.ts).
 */
const components = { mounts: {} as Record<string, number>, updates: {} as Record<string, number>, live: {} as Record<string, number>, again: {} as Record<string, number> };
/**
 * How much the app holds in its own caches, by name (timelines, messages, kept pages): scripts/verify-memory.ts reads
 * them after many rounds of the same clicks, and a count that keeps growing is a leak. Registered with `sized`.
 */
const sizes: Record<string, () => number> = {};
let epoch = 0;
const againAt = new WeakMap<object, number>();
const bornAt = new WeakMap<object, number>();
/** Starts `again` over. */
function fresh() {
  epoch++;
  components.again = {};
}
if (counting) {
  const held = () => Object.fromEntries(Object.entries(sizes).map(([k, f]) => [k, f()]));
  (globalThis as { __ditherPerf?: unknown }).__ditherPerf = { renders, components, fresh, held };
  // Preact's own hooks, as preact/hooks and preact/signals use them: `__r` before a component renders, `__c` its
  // instance (preact's mangled names for _render and _component).
  type VNode = { type: unknown; __c?: object };
  const o = options as unknown as { __r?: (v: VNode) => void; unmount?: (v: VNode) => void };
  const nameOf = (t: unknown) => ((t as { displayName?: string }).displayName ?? (t as { name?: string }).name) || '?';
  const seen = new WeakSet<object>();
  const add = (m: Record<string, number>, k: string, by: number) => (m[k] = (m[k] ?? 0) + by);
  const render = o.__r;
  o.__r = (v) => {
    render?.(v);
    const c = v.__c;
    if (!c) return;
    const name = nameOf(v.type);
    if (seen.has(c)) {
      add(components.updates, name, 1);
      if (bornAt.get(c)! < epoch && againAt.get(c) !== epoch) againAt.set(c, epoch), add(components.again, name, 1);
    } else bornAt.set(c, epoch), seen.add(c), add(components.mounts, name, 1), add(components.live, name, 1);
  };
  const unmount = o.unmount;
  o.unmount = (v) => {
    if (typeof v.type === 'function' && v.__c && seen.has(v.__c)) add(components.live, nameOf(v.type), -1);
    unmount?.(v);
  };
}

/** A cache's size for verify-memory.ts, read under ?perf=1 only. */
export function sized(name: string, size: () => number) {
  if (counting) sizes[name] = size;
}

/** One render of this component, counted under ?perf=1. Call it behind `counting`. */
export function rendered(name: string) {
  renders[name] = (renders[name] ?? 0) + 1;
}

/** A mark once what is on screen now has been painted. */
export function markPainted(name: string, detail?: unknown) {
  requestAnimationFrame(() =>
    setTimeout(() => {
      // The last of each name is kept: what watches for them (a PerformanceObserver) sees each as it comes, and the
      // page's list of marks, which nothing else empties, does not grow by one for every chat opened (verify-memory.ts).
      performance.clearMarks(name);
      performance.mark(name, { detail });
    }),
  );
}
