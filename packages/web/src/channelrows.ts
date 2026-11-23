/**
 * One inbox row per channel for its threads (docs/inbox.md, "One row per channel"): a Zulip channel's topics, a
 * Discord channel's threads or a forum's posts, a Matrix room's threads fold into one row under `channel:<id>`, as a
 * person's several DMs fold into `person:<id>` (chatroutes.ts). Pure, so tests can import it; model.ts makes the
 * parts of the hub's scores and ui/Sidebar.tsx draws the row.
 */
import type { RoutePart } from './chatroutes.ts';

/** The inbox's key for a channel's row of threads. A channel listed without threads keeps its own id. */
export const channelKey = (channelId: string) => `channel:${channelId}`;

/** One conversation of a channel's row: a thread of it, or the channel itself where it would have had a row of its own. */
export interface ChannelPart extends RoutePart {
  /** Its red count: mentions of you (model.ts `unreadOf`). */
  badge: number;
}

interface MergedChannel<T extends ChannelPart> {
  score: number;
  needs: boolean;
  reasons: string[];
  owedSince: number | null;
  /** Summed, a muted part's only where it mentions you (as `sumUnread` counts a place's). */
  unread: number;
  /** Mentions of you, summed: the row's red badge. */
  badge: number;
  muted: boolean;
  /** The latest message the row shows: of the parts that are not muted, else of all. */
  last: number;
  /** The part with the highest score: its reasons are the row's. */
  top: T;
  /** The part of the latest message: the row's preview. */
  latest: T;
}

/**
 * A channel's threads as one row: it scores the highest of its parts, needs you if any does, is owed since the
 * earliest, sums the unread and the mentions, and is muted only if every part is. A muted part does not lift the
 * row: while any part is not muted, only those count for the score, the ↩, the time and the preview, so a busy muted
 * topic leaves its channel where its other topics put it.
 */
export function mergeChannel<T extends ChannelPart>(parts: T[]): MergedChannel<T> {
  const loud = parts.filter((p) => !p.muted);
  const lift = loud.length ? loud : parts;
  const top = lift.reduce((a, b) => (b.score > a.score ? b : a));
  const latest = lift.reduce((a, b) => (b.last > a.last ? b : a));
  const owed = lift.map((p) => p.owedSince).filter((x): x is number => x !== null);
  let unread = 0;
  let badge = 0;
  for (const p of parts) {
    if (p.muted && !p.badge) continue;
    unread += p.unread;
    badge += p.badge;
  }
  return {
    score: top.score,
    needs: lift.some((p) => p.needs),
    reasons: top.reasons,
    owedSince: owed.length ? Math.min(...owed) : null,
    unread,
    badge,
    muted: !loud.length,
    last: latest.last,
    top,
    latest,
  };
}

/** A channel's row: the merge, its key, the channel, and its parts newest first. */
interface ChannelRow<T extends ChannelPart> extends MergedChannel<T> {
  key: string;
  channelId: string;
  parts: T[];
}

/**
 * The inbox's rows with each channel's threads made one (model.ts convRows). `parentOf` names the channel a thread
 * row belongs to, else null; `idOf` is a row's own conversation. A thread row comes back merged under
 * `channel:<parent>`, and so does the parent's own row where it has one (a Matrix room listed on its own, a Discord
 * text channel the hub scored): the channel and its threads are the same row. A channel's own row with no thread row
 * of it is one too where `folds` says so (it has unread threads to open on). The rest stay as they are.
 */
export function groupChannels<T extends ChannelPart>(rows: T[], parentOf: (r: T) => string | null, idOf: (r: T) => string, folds: (r: T) => boolean = () => false): { rows: T[]; channels: ChannelRow<T>[] } {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const p = parentOf(r);
    if (p) by.set(p, [...(by.get(p) ?? []), r]);
  }
  const plain: T[] = [];
  for (const r of rows) {
    if (parentOf(r)) continue;
    const own = by.get(idOf(r));
    if (own) own.push(r);
    else if (folds(r)) by.set(idOf(r), [r]);
    else plain.push(r);
  }
  const channels = [...by].map(([channelId, parts]): ChannelRow<T> => ({ ...mergeChannel(parts), key: channelKey(channelId), channelId, parts: [...parts].sort((a, b) => b.last - a.last) }));
  return { rows: plain, channels };
}

/** A thread as the open row lists it. */
interface SubThread {
  id: string;
  unread: number;
  badge: number;
  muted: boolean;
  last: number;
}

/**
 * The threads an open channel row lists under it: the unread ones, a muted one only where it mentions you (as the
 * sidebar lists a Zulip channel's topics), those that mention you first, then the latest.
 */
export function subThreads<T extends SubThread>(threads: T[]): T[] {
  return threads.filter((t) => t.unread > 0 && (!t.muted || t.badge > 0)).sort((a, b) => Number(b.badge > 0) - Number(a.badge > 0) || b.last - a.last);
}
