/**
 * Where "Next unread topic" goes (docs/threads.md "Next unread"): the `n` key and the bar at the bottom of a thread.
 * Pure, so tests can import it; ui/NextUnread.tsx gathers its input from what the page holds.
 *
 * From a thread: the channel's other unread threads first (a mention first, then latest activity), then the next
 * channel with any, in sidebar order through the rest of its space and round to its first channels, then the spaces
 * after it, and round to the ones before. A muted thread counts only when it mentions you. From a channel's stream (every thread of it together),
 * "next" is the next channel with anything unread.
 */

/** Something to read in a channel: one of its threads, or its own messages (`id` is then the channel's). */
export interface Slot {
  id: string;
  unread: number;
  mentions: number;
  /** Muted, or kept to the list: skipped unless it mentions you. */
  muted: boolean;
  /** Its latest activity, ms. */
  lastAt: number;
}

/** A channel in sidebar order, with the space it is listed under. */
export interface Lane {
  channel: string;
  space: string;
}

/** Where you are: a thread, or a channel itself (`thread` null: its own messages, or its stream). */
export interface Here {
  channel: string;
  thread: string | null;
  /** The space you are looking at it in, for a channel listed under more than one. */
  space?: string;
}

export interface Next {
  /** What to open: a thread (or a channel's own messages), or in `channel` mode the channel. */
  id: string;
  channel: string;
  space: string;
  unread: number;
  mentions: number;
}

/** Counts toward next unread: unread, and not muted unless it mentions you. */
const counts = (s: Slot) => s.unread > 0 && (!s.muted || s.mentions > 0);

/** A mention first, then latest activity. */
const before = (a: Slot, b: Slot) => Number(b.mentions > 0) - Number(a.mentions > 0) || b.lastAt - a.lastAt;

function best(slots: readonly Slot[], skip: string | null): Slot | null {
  let out: Slot | null = null;
  for (const s of slots) if (s.id !== skip && counts(s) && (!out || before(s, out) < 0)) out = s;
  return out;
}

/**
 * The next unread after `here`. `slotsOf` is asked lazily, channel by channel in order, so a page with thousands of
 * threads only looks as far as the first hit. A channel listed under two spaces is looked at once; `here` is the
 * listing under `here.space` where there is one, else its first. `here` not among `lanes` (a room in no space) looks through its own channel, then every lane from the top.
 */
export function nextUnread(lanes: readonly Lane[], here: Here, slotsOf: (channel: string) => readonly Slot[], mode: 'thread' | 'channel' = 'thread'): Next | null {
  const inSpace = here.space === undefined ? -1 : lanes.findIndex((l) => l.channel === here.channel && l.space === here.space);
  const at = inSpace >= 0 ? inSpace : lanes.findIndex((l) => l.channel === here.channel);
  const space = at >= 0 ? lanes[at].space : '';
  if (mode === 'thread') {
    const s = best(slotsOf(here.channel), here.thread ?? here.channel);
    if (s) return { id: s.id, channel: here.channel, space, unread: s.unread, mentions: s.mentions };
  }
  // The rest of this space round from here, then every other lane round from here.
  const seen = new Set([here.channel]);
  for (const pass of [true, false])
    for (let k = 1; k <= lanes.length; k++) {
      const lane = lanes[(Math.max(at, -1) + k + lanes.length) % lanes.length];
      if (at >= 0 && (lane.space === space) !== pass) continue;
      if (seen.has(lane.channel)) continue;
      seen.add(lane.channel);
      const slots = slotsOf(lane.channel);
      if (mode === 'thread') {
        const s = best(slots, null);
        if (s) return { id: s.id, channel: lane.channel, space: lane.space, unread: s.unread, mentions: s.mentions };
        continue;
      }
      let unread = 0;
      let mentions = 0;
      for (const s of slots) if (counts(s)) (unread += s.unread), (mentions += s.mentions);
      if (unread) return { id: lane.channel, channel: lane.channel, space: lane.space, unread, mentions };
    }
  return null;
}
