/**
 * A network's notifications about you (docs/feed.md): X's likes, reposts, replies, mentions, quotes and follows arrive
 * as messages in one conversation per account, variant 'feed'. Here: what makes one, what the hub refuses there, how
 * its messages are decided for notifications, and their `extra.feed` turned into what the page reads.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { FEED_ITEM_TYPES, NETWORK_META, withoutHiddenGuests } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';

/** Variants that are not chats (a feed, logged posts): nothing learns from them (docs/feed.md "Threads"). */
export const QUIET_VARIANTS: ReadonlySet<string> = new Set(['feed', 'posts']);
export const QUIET_VARIANTS_SQL = `('feed', 'posts')`;
/** The conversations of those variants, for `conversation_id NOT IN …`. */
export const QUIET_CONVS_SQL = `(SELECT id FROM conversation WHERE variant IN ${QUIET_VARIANTS_SQL})`;

/**
 * A feed conversation, the posts the hub logged (variant 'posts', posts.ts), or a post you follow (variant 'follow',
 * follows.ts): read-only, nothing goes to the network (no message, read mark, typing or reaction). The first two are
 * also quiet (QUIET_VARIANTS); a followed post is a chat, unread and in the inbox.
 */
export function isFeed(db: Database, conversationId: string): boolean {
  return !!db.query(`SELECT 1 FROM conversation WHERE id = ? AND variant IN ('feed', 'posts', 'follow')`).get(conversationId);
}

/** Why nothing can be written, reacted with or changed there, in words. */
const feedRefusal = (network: P.Network, variant: string = 'feed') =>
  `${NETWORK_META[network].name}'s ${variant === 'posts' || variant === 'follow' ? 'posts' : 'notifications'} are read-only here: answer on ${NETWORK_META[network].name}`;

/** The refusal for a conversation that is a feed, logged posts or a followed post, else null. */
export function feedRefusalFor(db: Database, conversationId: string): string | null {
  const r = db.query(`SELECT network, variant FROM conversation WHERE id = ? AND variant IN ('feed', 'posts', 'follow')`).get(conversationId) as { network: P.Network; variant: string } | null;
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
/**
 * An article's pictures (`![alt](url)`) through the hub's media path, as a post's other pictures are: cached, and
 * fetched by the hub rather than by each device. One the hub won't sign stays as it was (the page then shows its words).
 */
export function articleView(md: string, media: (raw: string) => string | null): string {
  return md.replace(/(!\[(?:\\.|[^\]\\])*\]\()(https?:\/\/[^)\s]+)\)/g, (all, head: string, url: string) => {
    const raw = url.replace(/%2[89]/gi, (c) => (c.toLowerCase() === '%28' ? '(' : ')'));
    const m = media(raw);
    // A signed path is base64url and a query: nothing in it ends the Markdown link.
    return m ? `${head}${m})` : all;
  });
}

export function postView(p: P.PostFact, network: P.Network, media: (raw: string) => string | null): P.PostFact {
  return {
    ...p,
    ...(p.article ? { article: articleView(p.article, media) } : {}),
    ...(p.author ? { author: hubId('idn', network, p.author) } : {}),
    ...(p.replyTo ? { replyTo: { id: p.replyTo.id, ...(p.replyTo.author ? { author: hubId('idn', network, p.replyTo.author) } : {}) } } : {}),
    ...(p.repostOf ? { repostOf: postView(p.repostOf, network, media) } : {}),
    ...(p.quoteOf ? { quoteOf: postView(p.quoteOf, network, media) } : {}),
    ...(p.media ? { media: p.media.map((m) => ({ ...m, url: media(m.url) ?? '' })).filter((m) => m.url) } : {}),
    // An event's hosts and guests as hub identity ids (docs/events.md).
    ...(p.event ? { event: { ...p.event, hosts: (p.event.hosts ?? []).map((h) => hubId('idn', network, h)), ...(p.event.guests ? { guests: p.event.guests.map((g) => hubId('idn', network, g)) } : {}) } } : {}),
  };
}

export function feedView(f: P.FeedItem, network: P.Network, media: (raw: string) => string | null): P.FeedItem {
  return {
    ...f,
    ...(f.post ? { post: postView(f.post, network, media) } : {}),
    ...(f.theirs ? { theirs: postView(f.theirs, network, media) } : {}),
  };
}

/**
 * A message's `extra` with no guest of a hidden guest list in the posts it carries (its `post`, its feed item's), as
 * the hub keeps it (docs/events.md "Who is going"). The same object when there was nothing to drop.
 */
export function scrubEventGuests(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extra) return extra;
  const post = extra.post as P.PostFact | undefined;
  const feed = extra.feed as P.FeedItem | undefined;
  const p2 = post && typeof post === 'object' && post.event ? withoutHiddenGuests(post) : post;
  const f2 = feed && typeof feed === 'object' && (feed.post?.event || feed.theirs?.event) ? { ...feed, ...(feed.post ? { post: withoutHiddenGuests(feed.post) } : {}), ...(feed.theirs ? { theirs: withoutHiddenGuests(feed.theirs) } : {}) } : feed;
  return p2 === post && f2 === feed ? extra : { ...extra, ...(post ? { post: p2 } : {}), ...(feed ? { feed: f2 } : {}) };
}

/** Every identity a feed item or a post names (native), so their facts can be checked. */
export function postAuthors(p: P.PostFact | undefined, out: string[] = []): string[] {
  if (!p) return out;
  if (p.author) out.push(p.author);
  postAuthors(p.repostOf, out);
  postAuthors(p.quoteOf, out);
  return out;
}
