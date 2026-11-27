/**
 * A person's public posts (docs/places.md "A person's networks", the Posts tab): what the hub logged whose author is
 * one of their identities, newest first, read only from the log. Nothing here asks a network.
 *
 * Three variants hold posts: 'posts' (read in a thread or on a profile, posts.ts), 'follow' (under a post you follow,
 * follows.ts), and 'feed' (your notifications, feed.ts), where a reply, a mention or a quote carries their post whole
 * (`feed.theirs`). A like, a repost or a follow there is no post of theirs and is left out, and a notification whose
 * post was also logged is that post once, as logged.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, POST_NETWORKS, postNativeId } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { postAuthors } from './feed.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

const NETS_SQL = `(${POST_NETWORKS.map((n) => `'${n}'`).join(', ')})`;
/** What a notification is when it carries their post. */
const TO_YOU: ReadonlySet<string> = new Set(['reply', 'mention', 'quote']);

/** Their identities that can post: on a network of posts. */
export function postingIdentities(s: Store, personId: string): string[] {
  return (s.db.query(`SELECT id FROM identity WHERE person_id = ? AND network IN ${NETS_SQL} ORDER BY id`).all(personId) as Row[]).map((r) => r.id as string);
}

/**
 * A page of their posts. `before`: the oldest held, `<ts>:<message id>` (chats.ts parseCursor). `toYou`: only what they
 * wrote to you (a reply to your post, a mention, a quote), for the rows in their chat. Null for nobody by that id.
 *
 * Read over `message_author_ts`, one range per identity, and only their identities on networks of posts: a Signal or
 * Discord account with years of messages is never scanned. What those identities wrote anywhere older than the
 * cursor is sorted for the page (an X account's DMs are few beside its posts).
 */
export function personPosts(s: Store, personId: string, before: { ts: number; id: string | null } | null, limit: number, toYou = false): P.PersonPostsPage | null {
  if (!s.one('SELECT 1 FROM person WHERE id = ?', personId)) return null;
  const ids = postingIdentities(s, personId);
  if (!ids.length) return { posts: [], identities: [], hasMore: false, before: null };
  const { posts, rows, hasMore } = between(s, ids, before, 0, limit, toYou);
  const last = rows[rows.length - 1];
  return { posts, identities: named(s, posts), hasMore, before: hasMore && last ? `${last.ts}:${last.id}` : null };
}

/** Their posts older than `before` and at `lo` or newer, newest first, at most `limit` rows read. */
function between(s: Store, ids: string[], before: { ts: number; id: string | null } | null, lo: number, limit: number, toYou: boolean): { posts: P.PersonPostView[]; rows: Row[]; hasMore: boolean } {
  const ts = before?.ts ?? Number.MAX_SAFE_INTEGER;
  const ph = ids.map(() => '?').join(',');
  const found = s.db
    .query(
      `SELECT m.* FROM message m JOIN conversation c ON c.id = m.conversation_id
       WHERE m.author_id IN (${ph}) AND (m.ts < ? OR (m.ts = ? AND m.id < ?)) AND m.ts >= ? AND m.deleted = 0
         AND (c.variant IN ('posts', 'follow') OR (c.variant = 'feed' AND json_extract(m.extra, '$.feed.type') IN ('reply', 'mention', 'quote')))
       ORDER BY m.ts DESC, m.id DESC LIMIT ?`,
    )
    .all(...ids, ts, ts, before?.id ?? '', lo, limit + 1) as Row[];
  const hasMore = found.length > limit;
  const rows = found.slice(0, limit);
  const selfIds = (p: P.PostFact) => !!p.replyTo?.author && s.isSelf(p.replyTo.author);
  const seen = new Set<string>();
  const posts: P.PersonPostView[] = [];
  for (const m of s.messageViews(rows)) {
    let post: P.PostFact | undefined;
    let kind: P.PersonPostView['toYou'];
    if (m.feed) {
      if (!TO_YOU.has(m.feed.type) || !m.feed.theirs) continue;
      post = m.feed.theirs;
      kind = m.feed.type as P.PersonPostView['toYou'];
      // Logged as a post too: shown there, as the network last showed it.
      const logged = hubId('msg', m.network, postNativeId(post.id));
      if (s.one(`SELECT 1 FROM message WHERE id = ? AND deleted = 0`, logged)) continue;
    } else if (m.post) {
      post = m.post;
      // A repost is the reposter's own row of someone else's words: theirs to list, but never written to you.
      if (!post.repostOf && selfIds(post)) kind = 'reply';
    }
    if (!post || seen.has(post.id)) continue;
    if (toYou && !kind) continue;
    seen.add(post.id);
    posts.push({ messageId: m.id, network: m.network, ts: m.ts, post, ...(kind ? { toYou: kind } : {}) });
  }
  return { posts, rows, hasMore };
}

/** Everyone the posts name: their authors, and whom a reply, repost or quote names. */
function named(s: Store, posts: readonly P.PersonPostView[]): P.IdentityView[] {
  const ids = new Set<string>();
  for (const v of posts) {
    for (const a of postAuthors(v.post)) ids.add(a);
    if (v.post.replyTo?.author) ids.add(v.post.replyTo.author);
  }
  return s.identitiesByIds(ids);
}

/** At most this many public rows in one page of their chat. */
const PUBLIC_MAX = 100;
/** A row's first words: this many characters at most. */
const FIRST_WORDS = 140;
const ACT: Record<NonNullable<P.PersonPostView['toYou']>, string> = { reply: 'replied to your post', mention: 'mentioned you', quote: 'quoted your post' };

/**
 * A page of a person's chat with what they wrote to you in public in its range added to `elsewhere` (docs/places.md
 * "A person's networks"): their replies to your posts, their posts that mention or quote you, each one short row at
 * its time, as their mail in threads with others is (mail/chatpage.ts elsewhereIn). The range is the page's, as
 * there: from its oldest message when more come before it (else from the start) to the cursor it was asked from.
 */
export function withPublic(s: Store, personId: string, before: { ts: number; id: string | null } | null, page: P.MessagePage): P.MessagePage {
  const ids = postingIdentities(s, personId);
  if (!ids.length) return page;
  const lo = page.hasMore && page.messages.length ? page.messages[0]!.ts : 0;
  const { posts } = between(s, ids, before ? { ts: before.ts, id: null } : null, lo, PUBLIC_MAX, true);
  if (!posts.length) return page;
  const items = posts.map(
    (v): P.ElsewhereView => ({
      place: `pst_${v.network}_${v.post.id}`,
      placeKind: 'post',
      post: { network: v.network, act: v.toYou! },
      title: `${ACT[v.toYou!]} on ${NETWORK_META[v.network].name}`,
      others: [],
      messageId: v.messageId,
      ts: v.ts,
      unread: false,
      awaits: false,
      excerpt: v.post.text.length > FIRST_WORDS ? `${v.post.text.slice(0, FIRST_WORDS - 1).trimEnd()}…` : v.post.text,
    }),
  );
  const have = new Set(page.identities.map((i) => i.id));
  return { ...page, identities: [...page.identities, ...named(s, posts).filter((i) => !have.has(i.id))], elsewhere: [...(page.elsewhere ?? []), ...items.reverse()] };
}
