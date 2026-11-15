/**
 * For you on this device (docs/foryou.md), the parts with no page in them: what counts as an item being seen and for
 * how long, which events go to the hub, and when the snapshot is taken afresh. ui/ForYou.tsx draws it. Not the X
 * notifications feed (feed.ts, docs/feed.md).
 *
 * An item is shown once at least half of it (or half the pane, for one taller than that) is on screen while the page
 * is visible and in use (usage.ts `inUse`, the rule visits use). Its time on screen sums the moments both held. Seeing
 * an item marks nothing read.
 */
import type * as P from '@dither-chat/protocol';

/** At least this much of an item on screen is "on screen". */
const SHOWN_RATIO = 0.5;
/** A shown item's time is sent again once it grew by this much (the hub keeps the largest). */
export const RESEND_MS = 1000;
/** Time between two ticks counts for at most this much (a sleeping laptop is not reading). */
const MAX_TICK_MS = 5000;
/** Left this long, the pane takes a fresh snapshot when it opens again; shorter, it carries on where you were. */
export const SESSION_GAP = 30 * 60_000;
/** The hub is asked how many new items there are this often while the pane is open. */
export const FRESH_EVERY = 60_000;

/** On screen enough to count, from an IntersectionObserver entry's numbers. */
export function onScreen(ratio: number, visibleHeight: number, paneHeight: number): boolean {
  return ratio >= SHOWN_RATIO || (paneHeight > 0 && visibleHeight >= SHOWN_RATIO * paneHeight);
}

interface Seen {
  on: boolean;
  ms: number;
  at: number | null;
  sent: number;
}

/** Each item's time on screen, by a clock passed in. */
export class Impressions {
  private items = new Map<string, Seen>();
  private last: number;
  private active = false;

  constructor(now: number) {
    this.last = now;
  }

  /** Time since the last call goes to the items on screen, if the page was in use. */
  tick(now: number, active: boolean) {
    const dt = this.active ? Math.min(Math.max(0, now - this.last), MAX_TICK_MS) : 0;
    for (const s of this.items.values()) {
      if (!s.on) continue;
      if (dt) s.ms += dt;
      if (active && s.at === null) s.at = now;
    }
    this.last = now;
    this.active = active;
  }

  /** An item came on screen or went off it. */
  set(id: string, on: boolean, now: number, active: boolean) {
    this.tick(now, active);
    let s = this.items.get(id);
    if (!s) this.items.set(id, (s = { on, ms: 0, at: null, sent: -1 }));
    s.on = on;
    if (on && active && s.at === null) s.at = now;
  }

  /** Everything this device has not sent yet: a newly shown item, or one whose time grew by RESEND_MS (all, with `all`). */
  due(device: string, all = false): P.ForYouEvent[] {
    const out: P.ForYouEvent[] = [];
    for (const [id, s] of this.items) {
      if (s.at === null) continue;
      if (s.sent < 0 || s.ms - s.sent >= RESEND_MS || (all && s.ms > s.sent)) {
        out.push({ itemId: id, device, kind: 'shown', at: s.at, ms: Math.round(s.ms) });
        s.sent = s.ms;
      }
    }
    return out;
  }

  shownMs(id: string): number | null {
    const s = this.items.get(id);
    return s && s.at !== null ? s.ms : null;
  }
}

/** Whether opening the pane takes a fresh snapshot: none yet, or left longer than SESSION_GAP ago. */
export const wantsFresh = (s: { epoch: string | null; closedAt: number | null }, now: number) => !s.epoch || (s.closedAt !== null && now - s.closedAt > SESSION_GAP);

/** "+6 more in #async", or null for a burst of one. */
export function burstLine(count: number, where: string): string | null {
  return count > 1 ? `+${count - 1} more in ${where}` : null;
}
