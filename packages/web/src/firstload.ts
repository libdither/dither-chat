/**
 * A first start, with nothing kept on this device: how full the start screen's orb is and what it says, from how far
 * its bootstrap has come (state.ts `firstLoad`, ui/Loader.tsx). Pure, for firstload.test.ts.
 */

/** A first start's bootstrap as it comes (state.ts `firstLoad`). */
export interface FirstLoad {
  phase: 'reach' | 'download' | 'draw';
  got: number;
  total: number | null;
}

/**
 * How full the start screen's orb is: a sliver while the hub is reached, most of it as the bytes come, and the rest
 * while the page sets them up, a step with no bytes to count (a sixth to a quarter of the wait on a slow phone link,
 * docs/perf.md "First start"). That last part runs on its own, `ms` long, as a transition the compositor plays: setting
 * the list up holds the page's thread for up to a second at a time.
 */
export function bootFill(load: FirstLoad, connected: boolean): { fill: number; ms: number } {
  if (!connected) return { fill: 0, ms: 0 };
  if (load.phase === 'reach') return { fill: 0.06, ms: 300 };
  const MB = 1 << 20;
  if (load.phase === 'download') {
    // Without a total (an older hub), it creeps: half way at 2 MB, never full.
    const f = load.total ? Math.min(1, load.got / load.total) : 1 - Math.exp(-load.got / (2 * MB));
    return { fill: 0.08 + (load.total ? 0.72 : 0.5) * f, ms: 250 };
  }
  // About a quarter second a megabyte on a phone (the slow-link probe: 0.9 s for 4 MB).
  return { fill: 1, ms: Math.round(Math.min(4000, Math.max(400, ((load.total ?? load.got) / MB) * 250))) };
}

/** Megabytes to a tenth, or kilobytes for an inbox under one. */
const size = (n: number, of: number) => (of < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

/** What the start screen says it is doing. */
export function bootStatus(load: FirstLoad, connected: boolean): string {
  if (!connected) return 'Connecting to your hub…';
  if (load.phase === 'reach') return 'Asking your hub for your inbox…';
  if (load.phase === 'draw') return 'Setting it up on this device…';
  return load.total ? `Downloading your inbox · ${size(load.got, load.total).replace(/ [KM]B$/, '')} of ${size(load.total, load.total)}` : `Downloading your inbox · ${size(load.got, load.got)}`;
}

