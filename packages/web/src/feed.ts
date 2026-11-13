/**
 * A network's notifications about you (docs/feed.md), pure: which conversations are feeds, the cards a feed's messages
 * make (the same thing done to the same post, one after another, is one card), what a card and the inbox's row say,
 * and a post's link and short text. Drawn by ui/FeedRow.tsx (the row) and ui/feed/ (the view, a lazy chunk).
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';

export const isFeedConv = (c: Pick<P.ConversationView, 'variant'> | null | undefined) => c?.variant === 'feed';

/** One card: what was done, by whom (newest first, each once), to which post, and when the newest was. */
export interface FeedCard {
  key: string;
  type: P.FeedItemType;
  /** Its messages, newest first. */
  messages: P.MessageView[];
  /** Who did it, identity ids, newest first, each once. */
  actors: string[];
  /** Your post it is about. */
  post?: P.PostFact;
  /** Their post (a reply, mention or quote). */
  theirs?: P.PostFact;
  /** The network's own sentence (`other`). */
  text?: string;
  url?: string;
  ts: number;
  /** Any of it after this time (the read line): new. */
  fresh: boolean;
}

/** Types whose same-post neighbours make one card: many people liking one post is one thing that happened. */
const GROUPS: ReadonlySet<P.FeedItemType> = new Set(['like', 'repost', 'follow']);

/**
 * A feed's messages (any order) as cards, newest first. Two items are one card when they are next to each other,
 * of the same type, about the same post (follows need no post), and of a grouping type: likes, reposts, follows.
 * `readTs`: what came after it is new.
 */
export function feedCards(messages: readonly P.MessageView[], readTs = Infinity): FeedCard[] {
  const out: FeedCard[] = [];
  const sorted = messages.filter((m) => m.feed && !m.deleted).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  for (const m of sorted) {
    const f = m.feed!;
    const last = out[out.length - 1];
    if (last && GROUPS.has(f.type) && last.type === f.type && (f.type === 'follow' || last.post?.id === f.post?.id)) {
      last.messages.push(m);
      if (m.authorId && !last.actors.includes(m.authorId)) last.actors.push(m.authorId);
      last.fresh ||= m.ts > readTs;
      continue;
    }
    out.push({
      key: m.id,
      type: f.type,
      messages: [m],
      actors: m.authorId ? [m.authorId] : [],
      ...(f.post ? { post: f.post } : {}),
      ...(f.theirs ? { theirs: f.theirs } : {}),
      ...(f.text ? { text: f.text } : {}),
      ...(f.url ? { url: f.url } : {}),
      ts: m.ts,
      fresh: m.ts > readTs,
    });
  }
  return out;
}

/** "Alice", "Alice and Bob", "Alice, Bob and Cam", "Alice, Bob and 3 others". */
export function namesPhrase(names: readonly string[], total = names.length): string {
  const n = Math.max(total, names.length);
  if (n <= 1) return names[0] ?? 'Someone';
  if (n === 2) return `${names[0]} and ${names[1] ?? 'someone'}`;
  if (n === 3 && names.length >= 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  const others = n - 2;
  return `${names[0]}, ${names[1]} and ${others} other${others === 1 ? '' : 's'}`;
}

/** What they did, after their names. */
export const FEED_VERB: Record<P.FeedItemType, string> = {
  like: 'liked your post',
  repost: 'reposted your post',
  reply: 'replied to your post',
  mention: 'mentioned you',
  quote: 'quoted your post',
  follow: 'followed you',
  other: '',
};

/** A card in one sentence: "Alice, Bob and 3 others liked your post". */
export function cardSentence(c: Pick<FeedCard, 'type' | 'actors' | 'text' | 'messages'>, nameOf: (identityId: string) => string): string {
  if (c.type === 'other') return c.text ?? c.messages[0]?.body ?? '';
  const verb = c.type === 'reply' && !c.messages[0]?.feed?.post ? 'replied to you' : FEED_VERB[c.type];
  return `${namesPhrase(c.actors.slice(0, 3).map(nameOf), c.actors.length)} ${verb}`;
}

/** The inbox row of a feed: how many new, who (newest first), what the newest card says, and when. */
export interface FeedRowView {
  count: number;
  who: string[];
  what: string;
  lastAt: number;
}

/**
 * The row while there is something to show: anything unread, or something in the last day (`RECENT`). Its words
 * come from the cards when the feed's page is held, else from the conversation's last message.
 */
export const RECENT = 24 * 60 * 60_000;
export function feedRow(c: P.ConversationView, messages: readonly P.MessageView[] | null, nameOf: (identityId: string) => string, now = Date.now()): FeedRowView | null {
  const count = c.vantages.reduce((n, v) => n + v.unread, 0);
  const lastAt = c.lastMessageAt ?? 0;
  if (!count && now - lastAt > RECENT) return null;
  const readTs = Math.min(...c.vantages.map((v) => v.lastReadTs ?? 0));
  const cards = messages?.length ? feedCards(messages, readTs) : [];
  const fresh = cards.filter((x) => x.fresh);
  const shown = fresh.length ? fresh : cards.slice(0, 1);
  const who = [...new Set(shown.flatMap((x) => x.actors))].slice(0, 4);
  const last = c.lastMessage;
  const by = last?.authorId ? nameOf(last.authorId) : 'Someone';
  const what = shown.length ? cardSentence(shown[0], nameOf) + (shown.length > 1 ? `, and ${shown.length - 1} more` : '') : last ? (last.kind === 'system' ? `${by} ${last.text}` : `${by}: ${last.text}`) : '';
  return { count, who: who.length ? who : last?.authorId ? [last.authorId] : [], what, lastAt };
}

/** A post's text in one short line, for "replied to your post: …". */
export function clip(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Where the network shows its notifications, for "Open on X". */
export function notificationsUrl(network: P.Network): string | null {
  return network === 'x' ? 'https://x.com/notifications' : null;
}

/** "Replies, likes and follows happen on X." */
export const feedBarLine = (network: P.Network) => `Replies, likes and follows happen on ${NETWORK_META[network].name}.`;

/** A count as X writes it: 980, 3.1K, 15K, 1.2M. */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
