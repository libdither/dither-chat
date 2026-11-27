/**
 * A channel's stream (docs/threads.md "The channel stream"): every thread's messages together by time, with the
 * channel's own where it has any (a Matrix room does; a Zulip channel takes none), a header each time the thread
 * changes, and a box that sends to the thread on its chip. Its timeline is `k:<channel>` (state.ts timelineKey).
 *
 * Which channels have one, the view each opens on, and the switch between the stream and the thread cards (or the
 * channel's own messages) are here; the page is Timeline.tsx's StreamPane.
 */
import { effect, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { db, pref, route, setPrefs } from './state.ts';

/** The stream; the thread cards (ui/Threads.tsx ForumView); the channel's own messages alone. */
export type ChannelView = 'stream' | 'cards' | 'own';

const posts = (c: P.ConversationView) => c.variant === 'forum' || c.variant === 'media';
/** A Zulip channel: a forum of topics that takes no messages of its own. */
const topics = (c: P.ConversationView) => c.network === 'zulip' && posts(c);

/**
 * The views a channel offers, the one it opens on first; null where it has nothing to switch between. A Zulip channel
 * and a Matrix room with threads open on the stream; a Discord forum on its cards (its posts are long), a Discord text
 * channel on its own messages, each with the stream a click away once it has threads.
 */
export function channelViews(c: P.ConversationView | null | undefined): ChannelView[] | null {
  if (!c || (c.shape !== 'channel' && c.shape !== 'group')) return null;
  if (c.variant !== 'text' && c.variant !== 'announcement' && !posts(c)) return null;
  if (!topics(c) && !db.threads.get(c.id)?.length) return null;
  if (topics(c) || c.network === 'matrix') return ['stream', 'cards'];
  return posts(c) ? ['cards', 'stream'] : ['own', 'stream'];
}

/**
 * A view shown for this visit only, not kept: the sidebar's "N more topics" opens the channel on its cards, and the
 * next visit opens on the channel's own view again. It ends on leaving the channel for anything but one of its
 * threads (back from a topic comes back to the cards), or on a pick in the switch.
 */
const viewOnce = signal<{ channel: string; view: ChannelView } | null>(null);

/** Show a channel's cards for this visit, where it has them; false where it has none (a Discord text channel). */
export function showCardsOnce(c: P.ConversationView): boolean {
  if (!channelViews(c)?.includes('cards')) return false;
  viewOnce.value = { channel: c.id, view: 'cards' };
  return true;
}

effect(() => {
  const r = route.value;
  const here = 'conv' in r ? r.conv : undefined;
  const once = viewOnce.peek();
  if (!once || here === once.channel || (here && db.conversations.get(here)?.parentId === once.channel)) return;
  viewOnce.value = null;
});

/** The view a channel shows on this device: one shown for this visit, else the one picked here, else the one it opens on. */
export function channelView(c: P.ConversationView | null | undefined): ChannelView {
  const vs = channelViews(c);
  if (!vs) return c && posts(c) ? 'cards' : 'own';
  const once = viewOnce.value;
  if (once?.channel === c!.id && vs.includes(once.view)) return once.view;
  const v = pref('channelViews')?.[c!.id];
  return v && vs.includes(v) ? v : vs[0];
}

export function setChannelView(channelId: string, v: ChannelView) {
  if (viewOnce.peek()?.channel === channelId) viewOnce.value = null;
  setPrefs({ channelViews: { ...pref('channelViews'), [channelId]: v } });
}

/** The switch's words: Zulip's "Topics", a forum's "Posts", "Threads" elsewhere (model.ts threadWords). */
export function viewLabel(c: P.ConversationView, v: ChannelView, many: string): string {
  if (v === 'cards') return many[0].toUpperCase() + many.slice(1);
  if (v === 'own') return c.network === 'matrix' ? 'Room' : 'Channel';
  // Beside the channel's own: the same messages with its threads'.
  return channelViews(c)?.includes('own') ? `With ${many}` : 'All messages';
}

/** Whether a channel takes messages of its own, so its stream holds them and its box may send to it. */
export const takesOwn = (c: P.ConversationView) => !posts(c);

/** The conversations a channel's stream holds: itself where it takes messages, and every thread of it. */
export function streamConvIds(c: P.ConversationView): string[] {
  const threads = db.threads.get(c.id) ?? [];
  return takesOwn(c) ? [c.id, ...threads] : [...threads];
}

/**
 * Whether a thread header goes before `m`: the first message drawn, a new day (its line breaks the run), or a message
 * of another conversation than the one before it.
 */
export function headBefore(prev: Pick<P.MessageView, 'conversationId'> | null, m: Pick<P.MessageView, 'conversationId'>, newDay: boolean): boolean {
  return !prev || newDay || prev.conversationId !== m.conversationId;
}

/**
 * The thread the box sends to when you have not said: the one you last clicked a message of or replied to (`picked`),
 * while the stream still has it; else that of the newest message held (a room's own message: the room, "no thread");
 * else the thread with the latest activity; else the channel itself where it takes messages. Null: nothing to send to
 * until a new topic is named.
 */
export function chipDefault(o: {
  channel: string;
  /** The channel takes messages of its own (a Matrix room). */
  own: boolean;
  picked?: string | null;
  messages: readonly Pick<P.MessageView, 'conversationId'>[];
  threads: readonly Pick<P.ConversationView, 'id' | 'lastMessageAt'>[];
}): string | null {
  const ok = (id: string) => (id === o.channel ? o.own : o.threads.some((t) => t.id === id));
  if (o.picked && ok(o.picked)) return o.picked;
  for (let i = o.messages.length - 1; i >= 0; i--) if (ok(o.messages[i].conversationId)) return o.messages[i].conversationId;
  let best: Pick<P.ConversationView, 'id' | 'lastMessageAt'> | null = null;
  for (const t of o.threads) if (!best || (t.lastMessageAt ?? 0) > (best.lastMessageAt ?? 0)) best = t;
  return best?.id ?? (o.own ? o.channel : null);
}

/** The thread you last clicked a message of, replied to, picked on the chip or started, by channel, for this session. */
const picks = new Map<string, string>();
export const pickedThread = (channelId: string) => picks.get(channelId) ?? null;
export const pickThread = (channelId: string, convId: string) => void picks.set(channelId, convId);
