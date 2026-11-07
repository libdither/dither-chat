/**
 * How many messages someone has posted in a server, from what the hub has stored and nothing else (docs/profile.md,
 * "Message counts"). It never asks the network. What it says, from surest to least sure:
 *
 * - observed: their messages the hub holds there. Exact, and a lower bound: they posted at least that many.
 * - their share of the messages the hub holds there, with a Wilson score interval (95%), which stays honest for small
 *   samples and for shares of 0 or 1.
 * - an estimated total, only where the data supports one. Discord ids are snowflakes, but one id stream serves all of
 *   Discord, so the spacing of ids in a channel does not count that channel's messages. What a channel's id does give
 *   is when the channel was made. Per channel, then:
 *     - its life runs from when it was made to the newest message held; what is held covers the oldest message held
 *       to the newest, cut into up to 24 equal bins of a week or more. Everything in that window is assumed held
 *       (history pages and live sync arrive without holes). A bin with nothing in it may be a hole (a recent page
 *       and an old reply fetched alone look like years held), so a channel with one gets no estimate at all.
 *     - held back to within a day (or 2%) of the channel's start: the count is complete, nothing to add.
 *     - otherwise the unseen stretch before the oldest message held is filled at the channel's own rate: the mean for
 *       the estimate, and the quietest and busiest of its bins for the range. That is a range of "if it was like any stretch we saw", not a confidence interval: activity drifts.
 *     - their part of the unseen messages is their share in that channel, with its Wilson interval for the range, and
 *       only for the unseen time after they could have posted (their Discord account's id dates it; when they joined
 *       the server, where the adversarial members setting kept it).
 *     - not attempted when the window held is under a week or under a fifth of the channel's life, under 20 messages,
 *       or on a network whose ids are not dated (Matrix, Signal, WhatsApp, Telegram, Google Messages).
 *   Channel ranges add up as they are, which is wider than any one of them, never narrower. Their messages in channels
 *   with no estimate count as observed (`unestimated`: the top may be higher by an unknown amount); when those are
 *   over a tenth of their messages, no total is given at all.
 *
 * Every message the hub holds counts, deleted ones and imported ones included: they were posted.
 */
import type * as P from '@dither-chat/protocol';

const DAY = 86_400_000;
/** Discord's epoch: a snowflake's top 42 bits are milliseconds since 2015-01-01. */
export const DISCORD_EPOCH = 1_420_070_400_000;
export const MIN_MESSAGES = 20;
export const MIN_WINDOW_MS = 7 * DAY;
/** The window held must be at least this part of the channel's life, so the unseen part is at most four times it. */
export const MIN_COVER = 0.2;
export const MAX_BINS = 24;
/** Their messages in channels with no estimate may be at most this part of what was seen of them. */
const MAX_UNESTIMATED = 0.1;

/** When a Discord id (a snowflake) was made, or null when it is not one. */
export function snowflakeTime(id: string, now = Date.now()): number | null {
  if (!/^\d{15,20}$/.test(id)) return null;
  const t = Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
  return t > DISCORD_EPOCH && t <= now + DAY ? t : null;
}

/** Wilson score interval for k successes in n, z = 1.96 (95%). [0, 1] when n is 0. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!(n > 0)) return [0, 1];
  const p = Math.min(1, Math.max(0, k / n));
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [k <= 0 ? 0 : Math.max(0, center - half), k >= n ? 1 : Math.min(1, center + half)];
}

/** How a window held is cut into bins: how many, and how wide. */
export function binsFor(oldest: number, newest: number): { count: number; width: number } {
  const span = Math.max(0, newest - oldest);
  const count = Math.max(1, Math.min(MAX_BINS, Math.floor(span / (7 * DAY)) || 1));
  return { count, width: Math.max(1, span / count) };
}

/** One conversation of the server as the hub holds it. */
export interface ChannelInput {
  network: P.Network;
  /** The conversation's network id: a snowflake on Discord, which dates the channel. */
  nativeId: string;
  /** Messages held, by anyone; the oldest and newest held (ms). */
  captured: number;
  oldest: number | null;
  newest: number | null;
  /** Messages held per bin of binsFor(oldest, newest), oldest first. Empty when not counted. */
  bins: number[];
  /** Of those, theirs. */
  authored: number;
}

/** Messages before the oldest one held, estimated, or why not. */
export type Unseen = { unseen: number; low: number; high: number; created: number; complete: boolean } | { reason: string };

export function unseenOf(c: ChannelInput, now = Date.now()): Unseen {
  if (c.network !== 'discord') return { reason: 'not dated' };
  const created = snowflakeTime(c.nativeId, now);
  if (created === null) return { reason: 'not dated' };
  if (!c.captured || c.oldest === null || c.newest === null) return { reason: 'nothing held' };
  const life = Math.max(1, c.newest - created);
  const before = Math.max(0, c.oldest - created);
  // A stretch with nothing held may be a gap in what was fetched (a recent page and an old reply), not a quiet one.
  if (!c.bins.length || c.bins.some((n) => n === 0)) return { reason: 'gaps in what is held' };
  if (before <= Math.max(DAY, 0.02 * life)) return { unseen: 0, low: 0, high: 0, created, complete: true };
  const window = c.newest - c.oldest;
  if (c.captured < MIN_MESSAGES) return { reason: 'too few messages' };
  if (window < MIN_WINDOW_MS || window / life < MIN_COVER) return { reason: 'too little of its history' };
  const { width } = binsFor(c.oldest, c.newest);
  const rate = c.captured / window;
  const rates = c.bins.map((n) => n / width);
  return {
    unseen: rate * before,
    low: Math.min(rate, ...rates) * before,
    high: Math.max(rate, ...rates) * before,
    created,
    complete: false,
  };
}

export interface Estimate {
  observed: number;
  captured: number;
  shareLow: number;
  shareHigh: number;
  estimate?: number;
  low?: number;
  high?: number;
  total?: { estimate: number; low: number; high: number };
  unestimated?: number;
  method: P.MessageCountEstimate['method'];
  reason?: string;
}

/**
 * Their count in a server from its channels. `from`: the earliest they could have posted (their account was made, or
 * they joined), so unseen time before it is not theirs.
 */
export function estimateMessages(channels: ChannelInput[], opts: { from?: number | null; now?: number } = {}): Estimate {
  const now = opts.now ?? Date.now();
  const observed = channels.reduce((n, c) => n + c.authored, 0);
  const captured = channels.reduce((n, c) => n + c.captured, 0);
  const [shareLow, shareHigh] = wilson(observed, captured);
  const base = { observed, captured, shareLow, shareHigh };
  const held = channels.filter((c) => c.captured > 0);
  if (!held.length) return { ...base, method: 'share', reason: 'The hub holds no messages here.' };
  const ests = held.map((c) => ({ c, u: unseenOf(c, now) }));
  if (ests.every((x) => 'reason' in x.u && x.u.reason === 'not dated'))
    return { ...base, method: 'share', reason: "This network's ids do not date its channels, so the total is unknown." };

  let est = observed;
  let low = observed;
  let high = observed;
  let unestimated = 0;
  let complete = true;
  let tEst = 0;
  let tLow = 0;
  let tHigh = 0;
  let tUnknown = 0;
  // Channels they have nothing in, pooled: their share there is 0 of all of them, its Wilson top over all the unseen.
  let zeroHeld = 0;
  let zeroHigh = 0;
  for (const { c, u } of ests) {
    if ('reason' in u) {
      unestimated += c.authored;
      tUnknown += c.captured;
      continue;
    }
    tEst += c.captured + u.unseen;
    tLow += c.captured + u.low;
    tHigh += c.captured + u.high;
    if (u.complete) continue;
    complete = false;
    // Their part of the unseen stretch: only after they could have posted.
    const start = Math.max(u.created, opts.from ?? u.created);
    const theirs = c.oldest! > u.created ? Math.min(1, Math.max(0, (c.oldest! - start) / (c.oldest! - u.created))) : 0;
    if (!c.authored) {
      zeroHeld += c.captured;
      zeroHigh += u.high * theirs;
      continue;
    }
    const [lo, hi] = wilson(c.authored, c.captured);
    est += (c.authored / c.captured) * u.unseen * theirs;
    low += lo * u.low * theirs;
    high += hi * u.high * theirs;
  }
  if (zeroHeld) high += wilson(0, zeroHeld)[1] * zeroHigh;
  const total = tUnknown <= MAX_UNESTIMATED * captured ? { estimate: Math.round(tEst + tUnknown), low: Math.round(tLow + tUnknown), high: Math.ceil(tHigh + tUnknown) } : undefined;
  if (observed > 0 ? unestimated > MAX_UNESTIMATED * observed : !total)
    return { ...base, method: 'share', reason: 'Too little of the history here is held to estimate the total.', ...(total ? { total } : {}) };
  const r = Math.round(est);
  const why = complete ? 'The hub holds these channels back to their start.' : 'Estimated from how busy each channel was in what the hub holds, back to when it was made.';
  return {
    ...base,
    estimate: r,
    low: Math.min(r, Math.max(observed, Math.floor(low))),
    high: Math.max(r, Math.ceil(high)),
    ...(total ? { total } : {}),
    method: complete && !unestimated ? 'complete' : 'snowflake-lifetime',
    ...(unestimated
      ? { unestimated, reason: `${why} ${unestimated.toLocaleString('en-US')} of their messages are in channels with no estimate, counted as seen only, so it may be more.` }
      : { reason: why }),
  };
}
