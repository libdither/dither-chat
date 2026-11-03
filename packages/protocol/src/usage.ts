/**
 * How much you use each place, and the orderings built on it (docs/organize.md). Only ids, seconds and
 * times: never what was said. Shared by the hub, which keeps the decayed totals, and the web app, which
 * measures them and sorts by them.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Time spent and visits lose half their weight each week, so the order follows current habits. */
export const USAGE_HALF_LIFE = 7 * DAY;

/** What usage is kept for: a community, a conversation outside one, or a person (their DMs merged). */
export type UsageKind = 'space' | 'conversation' | 'person';
export const USAGE_KINDS: readonly UsageKind[] = ['space', 'conversation', 'person'];

export interface UsageView {
  kind: UsageKind;
  id: string;
  /** Seconds in the place, decayed to `at`. */
  score: number;
  /** Visits, decayed to `at`. */
  visitScore: number;
  at: number;
  /** All time, not decayed: for showing, not for sorting. */
  seconds: number;
  visits: number;
  lastVisit: number | null;
}

/** One device's measurement since its last batch. */
export interface UsageDelta {
  kind: UsageKind;
  id: string;
  seconds: number;
  visits: number;
  /** When the measurement ended; it decays from then. */
  at: number;
  lastVisit?: number | null;
}

export type SortMode = 'manual' | 'smart' | 'recent' | 'az';
/** The rail (and the phone's Spaces list, which is the same arrangement), and the People list. The inbox has its own order (docs/inbox.md). */
export type SortScope = 'rail' | 'people';

export interface ArrangeSettings {
  sort: Record<SortScope, SortMode>;
  /** Folder suggestions you dismissed: category id -> the places it suggested then. New places bring it back. */
  dismissed: Record<string, string[]>;
}
export const DEFAULT_ARRANGE: ArrangeSettings = { sort: { rail: 'manual', people: 'recent' }, dismissed: {} };

export interface UsageState {
  now: number;
  halfLife: number;
  places: UsageView[];
  arrange: ArrangeSettings;
}

/** `value` as measured at `from`, seen from `to`. */
export function decayed(value: number, from: number, to: number, halfLife = USAGE_HALF_LIFE): number {
  return value * 2 ** (-(to - from) / halfLife);
}

export type Decayed = Pick<UsageView, 'score' | 'visitScore' | 'at'>;

/**
 * Add a measurement to a decayed total. The total stays at the later of the two times, so batches that
 * arrive late or out of order give the same result as in order.
 */
export function addDecayed(acc: Decayed | null, d: { seconds: number; visits: number; at: number }, halfLife = USAGE_HALF_LIFE): Decayed {
  if (!acc) return { score: d.seconds, visitScore: d.visits, at: d.at };
  if (d.at <= acc.at) return { score: acc.score + decayed(d.seconds, d.at, acc.at, halfLife), visitScore: acc.visitScore + decayed(d.visits, d.at, acc.at, halfLife), at: acc.at };
  return { score: decayed(acc.score, acc.at, d.at, halfLife) + d.seconds, visitScore: decayed(acc.visitScore, acc.at, d.at, halfLife) + d.visits, at: d.at };
}

/** Weights of the smart order, in minutes of reading. */
export const SMART = {
  /** A visit is worth a minute: a place you check often but briefly still counts. */
  visit: 1,
  /** A visit just now is worth this much, halving every `recentHalfLife`. */
  recent: 20,
  recentHalfLife: DAY,
  /** Each unread mention, up to `mentionCap` of them. */
  mention: 10,
  mentionCap: 3,
};

/**
 * Smart score: time + visits (both decayed, half-life a week) + how recently you were there + a nudge for
 * unread mentions. In minutes, so a place you read for half an hour a day settles near 320, one you check
 * ten times a day for a few seconds near 140, and a mention adds 10 at most 30: enough to lift a place
 * among its peers, not enough to beat a habit.
 */
export function smartScore(u: Pick<UsageView, 'score' | 'visitScore' | 'at' | 'lastVisit'> | null | undefined, now: number, mentions = 0): number {
  const nudge = SMART.mention * Math.min(Math.max(0, mentions), SMART.mentionCap);
  if (!u) return nudge;
  const time = decayed(u.score, u.at, now) / 60;
  const visits = decayed(u.visitScore, u.at, now) * SMART.visit;
  const recent = u.lastVisit ? SMART.recent * 2 ** (-Math.max(0, now - u.lastVisit) / SMART.recentHalfLife) : 0;
  return time + visits + recent + nudge;
}

/** Hub-side sanity for one delta from a device: a batch covers a minute or so, never more than an hour. */
export function cleanDelta(d: Partial<UsageDelta>, now: number): UsageDelta | null {
  if (!d || !USAGE_KINDS.includes(d.kind as UsageKind) || typeof d.id !== 'string' || !d.id || d.id.length > 200) return null;
  const seconds = Math.min(Math.max(Number(d.seconds) || 0, 0), 3600);
  const visits = Math.min(Math.max(Math.floor(Number(d.visits) || 0), 0), 100);
  if (!seconds && !visits) return null;
  // A device whose clock is off, or a batch kept offline for weeks, still lands somewhere sensible.
  const at = Math.min(Math.max(Number(d.at) || now, now - 30 * DAY), now);
  const lastVisit = d.lastVisit ? Math.min(Math.max(Number(d.lastVisit), now - 30 * DAY), now) : null;
  return { kind: d.kind as UsageKind, id: d.id, seconds, visits, at, lastVisit };
}
