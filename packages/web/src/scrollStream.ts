/**
 * Smooth upward scroll streaming for chat timelines (docs/perf.md, "Scrolling up"):
 *
 * Instead of waiting until the scroll position is 400 px from the top edge (slamming into a wall,
 * flashing a spinner, and stalling on the network), this tracks upward scroll direction and velocity
 * from cached container dimensions (zero forced layouts) and decouples two stages:
 *
 * 1. Network runway (`fetch`): proactively prefetches the next 60-message page in the background
 *    into memory well before the viewport reaches the top of what is held, upgrading to a visible
 *    load only if the user actually reaches the top edge while the buffer is empty.
 * 2. DOM runway (`draw`): streams already-held messages from memory into the DOM in small slices
 *    one animation frame at a time while scrolling up, keeping frame work small and continuous.
 */

/** Messages streamed into the DOM per animation frame while scrolling up (matches slices.ts SLICE). */
export const STREAM_SLICE = 15;
/** Within this distance of the top edge of drawn content, draw/fetch immediately. */
export const URGENT_PX = 350;
/** Distance from the top edge within which synchronous DOM anchoring is needed (above this, column-reverse holds the view still). */
export const ANCHOR_EDGE_PX = 64;
/** Minimum drawn runway (px) maintained above the viewport while scrolling up. */
export const DRAW_RUNWAY_MIN = 1200;
/** Maximum velocity-scaled drawn runway (px). */
const DRAW_RUNWAY_MAX = 3000;
/** Minimum runway (px) at which to prefetch the next older page from the hub. */
export const PREFETCH_RUNWAY_MIN = 1800;
/** Maximum velocity-scaled prefetch runway (px). */
const PREFETCH_RUNWAY_MAX = 4800;
/** Prefetch when fewer than this many already-fetched messages sit undrawn above the DOM. */
export const PREFETCH_BUFFER = 60;

export interface ScrollSample {
  /** Current scrollTop (column-reverse: 0 at newest end, negative going up). */
  scrollTop: number;
  /** Cached scrollHeight (from ResizeObserver). */
  scrollHeight: number;
  /** Cached clientHeight (from ResizeObserver). */
  clientHeight: number;
  /** Monotonic timestamp in ms. */
  now: number;
  /** Whether slices still have undrawn messages within the current drawn window. */
  more: boolean;
  /** Index of the oldest currently drawn message in `all` (= undrawn messages in memory above). */
  start: number;
  /** Whether the hub may have older messages beyond `all[0]`. */
  hasMore: boolean;
  /** Whether a timeline fetch is already in flight. */
  loading: boolean;
  /** Whether the in-flight fetch is a silent background prefetch. */
  prefetching: boolean;
  /** Whether the app is offline. */
  offline: boolean;
}

interface StreamPlan {
  /** How to stream already-held messages into the DOM above the viewport. */
  draw: 'none' | 'frame' | 'immediate';
  /** Whether to prefetch the next older page, start an urgent visible load, or promote a prefetch. */
  fetch: 'none' | 'prefetch' | 'urgent';
}

export class ScrollStream {
  private key = '';
  private lastTop = 0;
  private lastTime = 0;
  /** Smoothed upward scroll speed in px/s (0 when idle or scrolling down). */
  velocity = 0;

  /** Reset when switching timelines. */
  begin(key: string) {
    if (key === this.key) return;
    this.key = key;
    this.lastTop = 0;
    this.lastTime = 0;
    this.velocity = 0;
  }

  /** Decide what to draw and fetch for the current scroll position. Pure of DOM reads. */
  plan(s: ScrollSample): StreamPlan {
    const dt = this.lastTime ? s.now - this.lastTime : 0;
    // In column-reverse, scrolling up makes scrollTop more negative (lastTop - scrollTop > 0).
    const upPx = this.lastTime ? this.lastTop - s.scrollTop : 0;
    let goingUp = false;
    if (dt > 0 && dt < 200) {
      if (upPx > 1) {
        goingUp = true;
        const inst = Math.min(6000, (upPx / Math.max(dt, 8)) * 1000);
        this.velocity = this.velocity ? this.velocity * 0.6 + inst * 0.4 : inst;
      } else if (upPx < -2) {
        this.velocity = 0;
      } else {
        // Brief gap between wheel ticks: decay gently so buffered DOM streaming stays primed.
        this.velocity *= Math.max(0, 1 - dt / 180);
        if (this.velocity < 20) this.velocity = 0;
      }
    } else if (dt >= 200) {
      this.velocity = 0;
      if (upPx > 1) goingUp = true;
    }
    this.lastTop = s.scrollTop;
    this.lastTime = s.now;

    const topRemaining = Math.max(0, s.scrollHeight + s.scrollTop - s.clientHeight);
    const hasBuffered = s.more || s.start > 0;
    const drawRunway = Math.min(DRAW_RUNWAY_MAX, Math.max(DRAW_RUNWAY_MIN, s.clientHeight * 1.5, this.velocity * 0.5));
    const prefetchRunway = Math.min(PREFETCH_RUNWAY_MAX, Math.max(PREFETCH_RUNWAY_MIN, s.clientHeight * 2.5, this.velocity * 0.9));

    let draw: StreamPlan['draw'] = 'none';
    if (hasBuffered) {
      if (topRemaining < URGENT_PX) draw = 'immediate';
      else if ((goingUp || this.velocity > 40) && topRemaining < drawRunway) draw = 'frame';
    }

    let fetch: StreamPlan['fetch'] = 'none';
    if (!s.offline && s.hasMore) {
      if (!hasBuffered && topRemaining < URGENT_PX) {
        // At the top edge with nothing buffered in RAM: urgent visible load (or promote silent prefetch).
        if (!s.loading || s.prefetching) fetch = 'urgent';
      } else if (!s.loading && goingUp && Math.abs(s.scrollTop) > 80) {
        // Actively scrolling up with a shallow RAM buffer: silently prefetch the next page ahead of time.
        if (s.start < PREFETCH_BUFFER && topRemaining < prefetchRunway) fetch = 'prefetch';
      }
    }

    return { draw, fetch };
  }
}
