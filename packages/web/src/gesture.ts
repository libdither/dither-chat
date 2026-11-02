/** The arithmetic of a swipe, apart from the DOM so it can be tested. Distances in px, time in ms. */

/** Which way a touch is going, once it has gone far enough to tell. Sideways has to win clearly over down. */
export function lockAxis(dx: number, dy: number, slop = 10): 'x' | 'y' | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < slop && ay < slop) return null;
  return ax > ay * 1.2 ? 'x' : 'y';
}

/** Speed over the last few samples, so a flick counts even if the finger slowed at the very end. */
export function velocity(samples: { x: number; t: number }[]): number {
  if (samples.length < 2) return 0;
  const a = samples[0];
  const b = samples[samples.length - 1];
  return b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
}

/**
 * Let go between `from` and `to`: does the move complete? Past the middle completes, and so does a flick
 * towards `to`; a flick back the other way cancels even past the middle.
 */
export function commits(from: number, to: number, x: number, v: number, flick = 0.35): boolean {
  const dir = Math.sign(to - from);
  if (v * dir > flick) return true;
  if (v * dir < -flick) return false;
  return (x - from) * dir > Math.abs(to - from) / 2;
}

/** How long the rest of the way takes: about as fast as the finger was going, within limits that still look like motion. */
export function settleMs(remaining: number, v: number, slowest = 320, fastest = 120): number {
  const d = Math.abs(remaining);
  if (d < 1) return 0;
  const speed = Math.max(Math.abs(v), d / slowest);
  return Math.round(Math.min(slowest, Math.max(fastest, (d / speed) * 1.4)));
}

/** Past `limit` the element still moves, but less and less, so it feels attached rather than stuck. */
export function rubber(d: number, limit: number): number {
  const a = Math.abs(d);
  if (a <= limit) return d;
  return Math.sign(d) * (limit + (a - limit) / (1 + (a - limit) / limit) / 2);
}

/** Keep x between the two ends of a drag, with a little give past them that never exceeds `give`. */
export function clampDrag(x: number, lo: number, hi: number, give = 24): number {
  const resist = (over: number) => (give * over) / (over + give);
  if (x < lo) return lo - resist(lo - x);
  if (x > hi) return hi + resist(x - hi);
  return x;
}
