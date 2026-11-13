/**
 * A network's notifications about you (docs/feed.md), pure: which conversations are feeds, the cards a feed's messages
 * make (the same thing done to the same post, one after another, is one card), what a card and the inbox's row say,
 * and a post's link and short text. Drawn by ui/FeedRow.tsx (the row) and ui/feed/ (the view, a lazy chunk).
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';

export const isFeedConv = (c: Pick<P.ConversationView, 'variant'> | null | undefined) => c?.variant === 'feed';
/**
 * A feed, or the posts the hub logged (variant 'posts', docs/feed.md "Threads"): neither is a chat. Out of the inbox's
 * rows, every unread total and a profile's In common.
 */
export const isQuietConv = (c: Pick<P.ConversationView, 'variant'> | null | undefined) => c?.variant === 'feed' || c?.variant === 'posts';

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

// ------------------------------------------------------------------ the feed by post

/**
 * The feed drawn by post (docs/feed.md "The feed's page"): one unit per post of yours that something happened to, with
 * what people said under it (replies, quotes) and who reacted (likes, reposts) folded into one line; a post of
 * theirs that talks to you without one of yours (a mention, a reply to a post the feed does not carry); follows in a
 * row; anything else as the network said it. Newest activity first.
 *
 * Nothing in it is X's: a unit is a post and what came of it, which is also what a Mastodon post with its replies,
 * favourites and boosts, a YouTube video with its comments, or a Reddit or Discourse post with its comments is.
 */
export type FeedUnit =
  | {
      kind: 'post';
      key: string;
      /** The post, as the newest message about it carried it (its counts change). */
      post: P.PostFact;
      /** What people said under it, newest first: their post, who, and whether it came after the read line. */
      talk: FeedTalk[];
      /** Who reacted, by how, newest first, each once. */
      reactors: { like: string[]; repost: string[] };
      ts: number;
      /** When someone last said something under it (0: never). */
      talkTs: number;
      fresh: boolean;
      network: P.Network;
    }
  | { kind: 'said'; key: string; talk: FeedTalk; ts: number; talkTs: number; fresh: boolean; network: P.Network }
  | { kind: 'follow'; key: string; actors: string[]; ts: number; talkTs: 0; fresh: boolean; network: P.Network }
  | { kind: 'other'; key: string; text: string; post?: P.PostFact; ts: number; talkTs: 0; fresh: boolean; network: P.Network };

export interface FeedTalk {
  type: 'reply' | 'mention' | 'quote';
  /** Their post; absent when the network sent only words (the message's body). */
  theirs?: P.PostFact;
  message: P.MessageView;
  fresh: boolean;
}

/** Which units a feed shows: everything, or only people talking (no likes, reposts or follows). */
export type FeedFilter = 'all' | 'talk';

/**
 * A feed's messages (any order, any pages of it) as units, newest activity first. With `filter` 'talk', only units
 * where someone said something, by when they last did. Each person reacting once per way is one face.
 */
export function feedUnits(messages: readonly P.MessageView[], readTs = Infinity, filter: FeedFilter = 'all'): FeedUnit[] {
  const posts = new Map<string, Extract<FeedUnit, { kind: 'post' }>>();
  const out: FeedUnit[] = [];
  const sorted = messages.filter((m) => m.feed && !m.deleted).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  for (const m of sorted) {
    const f = m.feed!;
    const fresh = m.ts > readTs;
    const said = f.type === 'reply' || f.type === 'mention' || f.type === 'quote';
    if (f.post && (said || f.type === 'like' || f.type === 'repost')) {
      let u = posts.get(f.post.id);
      if (!u) {
        u = { kind: 'post', key: `post:${f.post.id}`, post: f.post, talk: [], reactors: { like: [], repost: [] }, ts: m.ts, talkTs: 0, fresh: false, network: m.network };
        posts.set(f.post.id, u);
        out.push(u);
      }
      u.fresh ||= fresh;
      if (said) {
        u.talk.push({ type: f.type as FeedTalk['type'], ...(f.theirs ? { theirs: f.theirs } : {}), message: m, fresh });
        u.talkTs ||= m.ts;
      } else {
        const list = u.reactors[f.type as 'like' | 'repost'];
        if (m.authorId && !list.includes(m.authorId)) list.push(m.authorId);
      }
      continue;
    }
    if (said) {
      out.push({ kind: 'said', key: m.id, talk: { type: f.type as FeedTalk['type'], ...(f.theirs ? { theirs: f.theirs } : {}), message: m, fresh }, ts: m.ts, talkTs: m.ts, fresh, network: m.network });
      continue;
    }
    if (f.type === 'follow') {
      out.push({ kind: 'follow', key: m.id, actors: m.authorId ? [m.authorId] : [], ts: m.ts, talkTs: 0, fresh, network: m.network });
      continue;
    }
    out.push({ kind: 'other', key: m.id, text: f.text ?? m.body, ...(f.post ? { post: f.post } : {}), ts: m.ts, talkTs: 0, fresh, network: m.network });
  }
  if (filter === 'talk') return out.filter((u) => u.talkTs > 0).sort((a, b) => b.talkTs - a.talkTs);
  // Follows one after another (nothing else newer between them) are one row.
  const merged: FeedUnit[] = [];
  for (const u of out) {
    const last = merged[merged.length - 1];
    if (u.kind === 'follow' && last?.kind === 'follow') {
      for (const a of u.actors) if (!last.actors.includes(a)) last.actors.push(a);
      last.fresh ||= u.fresh;
    } else merged.push(u.kind === 'follow' ? { ...u, actors: [...u.actors] } : u);
  }
  return merged;
}

/** How many reacted each way: the network's count when it gave one (it counts everyone), else the faces named. */
export function reactionCounts(u: Extract<FeedUnit, { kind: 'post' }>): { like: number; repost: number; quote: number; reply: number } {
  const c = u.post.counts ?? {};
  const quotes = u.talk.filter((t) => t.type === 'quote').length;
  const replies = u.talk.filter((t) => t.type === 'reply').length;
  return {
    like: Math.max(c.likes ?? 0, u.reactors.like.length),
    repost: Math.max(c.reposts ?? 0, u.reactors.repost.length),
    quote: Math.max(c.quotes ?? 0, quotes),
    reply: Math.max(c.replies ?? 0, replies),
  };
}

/** The reactions line's words: "Liked by Theo, Maya K. and 3 others" (or reposted, when nobody liked it). */
export function reactorsPhrase(u: Extract<FeedUnit, { kind: 'post' }>, nameOf: (identityId: string) => string): string {
  const [verb, ids] = u.reactors.like.length ? ['Liked by', u.reactors.like] : u.reactors.repost.length ? ['Reposted by', u.reactors.repost] : ['', []];
  if (!ids.length) return '';
  return `${verb} ${namesPhrase(ids.slice(0, 3).map(nameOf), ids.length)}`;
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

// ------------------------------------------------------------------ threads

/**
 * A post's thread opens beside the inbox as a conversation would (docs/feed.md "Threads"): its key stands where a
 * conversation id would, `pst_<network>_<post id>`, or `pst_m_<message id>` for a logged post's message.
 */
export const postKey = (network: P.Network, post: string) => `pst_${network}_${post}`;
export const postMessageKey = (messageId: string) => `pst_m_${messageId}`;
export const isPostKey = (key: string | null | undefined) => !!key?.startsWith('pst_');

/** What a post key names: a network's post, or a logged post's message. */
export function parsePostKey(key: string): { network: P.Network; post: string } | { message: string } | null {
  const m = key.match(/^pst_m_([\w-]+)$/);
  if (m) return { message: m[1] };
  const p = key.match(/^pst_([a-z]+)_(\d{1,25})$/);
  return p && p[1] in NETWORK_META ? { network: p[1] as P.Network, post: p[2] } : null;
}

/** Where a post's thread opens in the app. */
export const postHref = (network: P.Network, post: string) => `#/inbox/c/${postKey(network, post)}`;

/** A click on a post's card that means "open it": not on a link or button inside it, and not the end of a selection. */
export function opensPost(e: { target: EventTarget | null; currentTarget: EventTarget | null }, selection = typeof getSelection === 'function' ? getSelection()?.toString() : ''): boolean {
  const t = e.target as Element | null;
  if (selection) return false;
  const hit = t?.closest?.('a, button, input, textarea, video, [role="button"]');
  return !hit || hit === e.currentTarget;
}
