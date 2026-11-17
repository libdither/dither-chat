/**
 * A feed of your own (docs/feed.md "Feeds"): several home timelines, from any of your accounts and networks, put in one
 * list. Each timeline in it has a share (how much of the list it gets) and the feed has an order, which can be swapped
 * at any time: the same posts, put in another order, with nothing asked of the networks again.
 *
 * Orders here are plain functions of what the hub holds: each timeline's posts in its own order (a Following by time,
 * a For you as the network ranked it), when each was posted, its counts, and who put it there.
 */

/** How a feed puts its timelines' posts in one list. */
export type MixOrder = 'newest' | 'turns' | 'liked' | 'spread';
export const MIX_ORDERS: readonly MixOrder[] = ['newest', 'turns', 'liked', 'spread'];

/** A share's steps: off, less, even, more, most, as weights. */
export const SHARE_WEIGHTS: readonly number[] = [0, 0.5, 1, 2, 4];

/** One post in one timeline of a feed. */
export interface MixItem {
  /** The post shown (`<network>:<id>`): the same post in two timelines is one. */
  key: string;
  /** Which timeline of the feed (an index into its weights). */
  source: number;
  /** Its place in that timeline, 0 the first. */
  rank: number;
  /** When it was posted (a repost's, when it was reposted). */
  ts: number;
  /** Who put it in the timeline (the reposter of a repost). */
  author?: string;
  /** Likes, reposts, replies and quotes, weighted (`engagement`). */
  engagement?: number;
}

export interface MixOrdered {
  /** Each post once, in order. */
  keys: string[];
  /** For each, the timeline whose look at it the list shows: whose turn it was, or where it came first. */
  from: number[];
  /** The order stopped where a timeline with more posts at the network ran out in what the hub holds: what comes after
   * waits for that timeline's next page, so it is placed rightly. */
  cut: boolean;
}

/** A post's likes, reposts, replies and quotes as one number: a reply or a repost says more than a like. */
export function engagement(c: { likes?: number; reposts?: number; replies?: number; quotes?: number } | undefined): number {
  if (!c) return 0;
  return (c.likes ?? 0) + 2 * (c.reposts ?? 0) + 2 * (c.replies ?? 0) + 2 * (c.quotes ?? 0);
}

/** In Spread out, each further post of one person counts as this much older. */
export const SPREAD_MS = 3 * 3_600_000;

/**
 * The feed's posts in order. `weights[i]` is timeline i's share (0: left out); `more[i]` says timeline i has posts
 * past those given (held further back or at the network). Newest first and Taking turns stop where such a timeline
 * runs out (`cut`); Most liked and Spread out rank what is given.
 */
export function orderMix(items: readonly MixItem[], order: MixOrder, weights: readonly number[], more: readonly boolean[], now: number): MixOrdered {
  const on = items.filter((i) => (weights[i.source] ?? 0) > 0);
  const lists: MixItem[][] = weights.map(() => []);
  for (const i of on) lists[i.source].push(i);
  for (const l of lists) l.sort((a, b) => a.rank - b.rank);
  const firstOf = (sorted: MixItem[]): Omit<MixOrdered, 'cut'> => {
    const seen = new Set<string>();
    const keys: string[] = [];
    const from: number[] = [];
    for (const i of sorted) if (!seen.has(i.key)) (seen.add(i.key), keys.push(i.key), from.push(i.source));
    return { keys, from };
  };
  const byTime = (a: MixItem, b: MixItem) => b.ts - a.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  if (order === 'newest') {
    // Nothing older than the oldest post held of a timeline that has more: its next page may come in between.
    let floor = -Infinity;
    lists.forEach((l, s) => {
      if (more[s] && (weights[s] ?? 0) > 0) floor = Math.max(floor, l.length ? Math.min(...l.map((i) => i.ts)) : Infinity);
    });
    const sorted = [...on].sort(byTime);
    const kept = sorted.filter((i) => i.ts >= floor);
    return { ...firstOf(kept), cut: kept.length < sorted.length || floor === Infinity };
  }

  if (order === 'turns') {
    // Smooth weighted turns: each round every timeline gains its share, the one most owed goes, and pays the round.
    const credit = weights.map(() => 0);
    const at = weights.map(() => 0);
    const total = weights.reduce((n, w) => n + (w > 0 ? w : 0), 0);
    const seen = new Set<string>();
    const keys: string[] = [];
    const from: number[] = [];
    const live = new Set(lists.map((_, s) => s).filter((s) => (weights[s] ?? 0) > 0));
    while (live.size) {
      let best = -1;
      for (const s of live) {
        credit[s] += weights[s];
        if (best < 0 || credit[s] > credit[best]) best = s;
      }
      credit[best] -= total;
      // Its next post not already shown through another timeline.
      while (at[best] < lists[best].length && seen.has(lists[best][at[best]].key)) at[best]++;
      if (at[best] >= lists[best].length) {
        if (more[best]) return { keys, from, cut: true };
        live.delete(best);
        continue;
      }
      const it = lists[best][at[best]++];
      seen.add(it.key);
      keys.push(it.key);
      from.push(best);
    }
    return { keys, from, cut: false };
  }

  if (order === 'liked') {
    // As Hacker News ranks: what people did with it, against how long it has been up, times the timeline's share.
    const score = (i: MixItem) => (((i.engagement ?? 0) + 1) * weights[i.source]) / Math.pow(Math.max(0, now - i.ts) / 3_600_000 + 2, 1.5);
    const best = new Map<string, { score: number; source: number }>();
    for (const i of on) {
      const sc = score(i);
      const had = best.get(i.key);
      if (!had || sc > had.score) best.set(i.key, { score: sc, source: i.source });
    }
    const keys = [...best.keys()].sort((a, b) => best.get(b)!.score - best.get(a)!.score || (a < b ? -1 : 1));
    return { keys, from: keys.map((k) => best.get(k)!.source), cut: false };
  }

  // Spread out: newest first, each person's second post three hours further down, their third six, and so on.
  const sorted = [...on].sort(byTime);
  const seen = new Set<string>();
  const count = new Map<string, number>();
  const placed: { key: string; at: number; source: number }[] = [];
  for (const i of sorted) {
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    const n = i.author ? (count.get(i.author) ?? 0) : 0;
    if (i.author) count.set(i.author, n + 1);
    placed.push({ key: i.key, at: i.ts - n * SPREAD_MS, source: i.source });
  }
  placed.sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
  return { keys: placed.map((p) => p.key), from: placed.map((p) => p.source), cut: false };
}
