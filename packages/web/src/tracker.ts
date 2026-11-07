/**
 * The measuring behind usage.ts, with the clock passed in: which place gets the time, and when a stay
 * counts as a visit (docs/organize.md).
 */
import type { UsageDelta, UsageKind } from '@dither-chat/protocol';

/** Seconds in a place before it counts as a visit, so passing through on the way elsewhere does not. */
export const VISIT_AFTER = 3;
/** No input for this long and the app stops counting, as if it were in the background. */
export const IDLE_AFTER = 5 * 60_000;
/** One tick never counts for more than this: a laptop that slept is not a laptop in use. */
export const MAX_TICK = 30_000;
/** Back after this long away, the place you left counts as visited again. */
export const NEW_VISIT_AFTER = 30 * 60_000;

export type Acc = { seconds: number; visits: number; lastVisit: number | null; at: number };

/** The measuring itself, with the clock passed in so it can be tested. */
export class Tracker {
  pending = new Map<string, Acc>();
  /** Visits counted so far: a change means one just began. */
  visits = 0;
  private current: string[] = [];
  private stay = new Map<string, number>();
  private counted = new Set<string>();
  private active = false;
  private last: number;

  constructor(now: number) {
    this.last = now;
  }

  /** Where you are now and whether the app is in use. The time since the last call goes to where you were. */
  update(now: number, keys: string[], active: boolean) {
    const elapsed = this.active ? Math.min(Math.max(0, now - this.last), MAX_TICK) / 1000 : 0;
    if (elapsed > 0) {
      for (const k of this.current) {
        const a = this.acc(k, now);
        a.seconds += elapsed;
        const s = (this.stay.get(k) ?? 0) + elapsed;
        this.stay.set(k, s);
        if (s >= VISIT_AFTER && !this.counted.has(k)) {
          this.counted.add(k);
          a.visits++;
          a.lastVisit = now;
          this.visits++;
        }
      }
    }
    if (keys.join() !== this.current.join()) {
      for (const k of this.current) {
        if (keys.includes(k)) continue;
        this.stay.delete(k);
        this.counted.delete(k);
      }
      this.current = [...keys];
    }
    this.active = active;
    this.last = now;
  }

  /** Coming back after a long time away: the place still open is a new visit. */
  newStay() {
    this.stay.clear();
    this.counted.clear();
  }

  private acc(k: string, now: number): Acc {
    let a = this.pending.get(k);
    if (!a) this.pending.set(k, (a = { seconds: 0, visits: 0, lastVisit: null, at: now }));
    a.at = now;
    return a;
  }

  /** What to send, and forget it here. */
  take(): UsageDelta[] {
    const out: UsageDelta[] = [];
    for (const [k, a] of this.pending) {
      if (a.seconds < 0.5 && !a.visits) continue;
      const i = k.indexOf(':');
      out.push({ kind: k.slice(0, i) as UsageKind, id: k.slice(i + 1), seconds: Math.round(a.seconds * 10) / 10, visits: a.visits, at: a.at, lastVisit: a.lastVisit });
    }
    this.pending.clear();
    return out;
  }
}
