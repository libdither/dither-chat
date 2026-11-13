/**
 * A network's notifications about you (docs/feed.md): X's likes, reposts, replies, mentions, quotes and follows arrive
 * as messages in one conversation per account, variant 'feed'. Here: what makes one, what the hub refuses there, how
 * its messages are decided for notifications, and their `extra.feed` turned into what the page reads.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { FEED_ITEM_TYPES, NETWORK_META } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';

/** Variants that are not chats (a feed, logged posts): nothing learns from them (docs/feed.md "Threads"). */
export const QUIET_VARIANTS: ReadonlySet<string> = new Set(['feed', 'posts']);
export const QUIET_VARIANTS_SQL = `('feed', 'posts')`;
/** The conversations of those variants, for `conversation_id NOT IN …`. */
export const QUIET_CONVS_SQL = `(SELECT id FROM conversation WHERE variant IN ${QUIET_VARIANTS_SQL})`;

/**
 * A feed conversation, or the posts the hub logged (variant 'posts', posts.ts): read-only, kept out of the inbox's
 * rows, People and unread totals; nothing goes to the network.
 */
export function isFeed(db: Database, conversationId: string): boolean {
  return !!db.query(`SELECT 1 FROM conversation WHERE id = ? AND variant IN ('feed', 'posts')`).get(conversationId);
}

/** Why nothing can be written, reacted with or changed there, in words. */
export const feedRefusal = (network: P.Network, variant: string = 'feed') =>
  `${NETWORK_META[network].name}'s ${variant === 'posts' ? 'posts' : 'notifications'} are read-only here: answer on ${NETWORK_META[network].name}`;

/** The refusal for a conversation that is a feed or logged posts, else null. */
export function feedRefusalFor(db: Database, conversationId: string): string | null {
  const r = db.query(`SELECT network, variant FROM conversation WHERE id = ? AND variant IN ('feed', 'posts')`).get(conversationId) as { network: P.Network; variant: string } | null;
  return r ? feedRefusal(r.network, r.variant) : null;
}

/**
 * Types that never notify: someone liking, reposting or following is worth a look in the feed, never a sound or a row
 * on the phone. Replies, mentions and quotes are someone writing to you in public: at most a silent row on the list.
 */
export const QUIET_FEED: ReadonlySet<P.FeedItemType> = new Set(['like', 'repost', 'follow', 'other']);

/** What a feed message's reasons say it is. */
export const FEED_REASON: Record<P.FeedItemType, string> = {
  like: 'liked your post',
  repost: 'reposted your post',
  reply: 'a reply to your post',
  mention: 'a mention of you',
  quote: 'a quote of your post',
  follow: 'followed you',
  other: 'a notification',
};

/** The FeedItem in a stored message's `extra`, if it is one. */
export function feedItemOf(extra: unknown): P.FeedItem | null {
  const f = (extra as { feed?: unknown } | null)?.feed as P.FeedItem | undefined;
  return f && typeof f === 'object' && FEED_ITEM_TYPES.includes(f.type) ? f : null;
}

/** Native ids to hub ids and pictures to signed paths, in a post and the posts it holds. */
export function postView(p: P.PostFact, network: P.Network, media: (raw: string) => string | null): P.PostFact {
  return {
    ...p,
    ...(p.author ? { author: hubId('idn', network, p.author) } : {}),
    ...(p.replyTo ? { replyTo: { id: p.replyTo.id, ...(p.replyTo.author ? { author: hubId('idn', network, p.replyTo.author) } : {}) } } : {}),
    ...(p.repostOf ? { repostOf: postView(p.repostOf, network, media) } : {}),
    ...(p.quoteOf ? { quoteOf: postView(p.quoteOf, network, media) } : {}),
    ...(p.media ? { media: p.media.map((m) => ({ ...m, url: media(m.url) ?? '' })).filter((m) => m.url) } : {}),
  };
}

export function feedView(f: P.FeedItem, network: P.Network, media: (raw: string) => string | null): P.FeedItem {
  return {
    ...f,
    ...(f.post ? { post: postView(f.post, network, media) } : {}),
    ...(f.theirs ? { theirs: postView(f.theirs, network, media) } : {}),
  };
}

/** Every identity a feed item or a post names (native), so their facts can be checked. */
export function postAuthors(p: P.PostFact | undefined, out: string[] = []): string[] {
  if (!p) return out;
  if (p.author) out.push(p.author);
  postAuthors(p.repostOf, out);
  postAuthors(p.quoteOf, out);
  return out;
}
