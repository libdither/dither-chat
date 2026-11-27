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
import { POST_NETWORKS, postNativeId } from '@dither-chat/protocol';
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
  const ts = before?.ts ?? Number.MAX_SAFE_INTEGER;
  const ph = ids.map(() => '?').join(',');
  const rows = s.db
    .query(
      `SELECT m.* FROM message m JOIN conversation c ON c.id = m.conversation_id
       WHERE m.author_id IN (${ph}) AND (m.ts < ? OR (m.ts = ? AND m.id < ?)) AND m.deleted = 0
         AND (c.variant IN ('posts', 'follow') OR (c.variant = 'feed' AND json_extract(m.extra, '$.feed.type') IN ('reply', 'mention', 'quote')))
       ORDER BY m.ts DESC, m.id DESC LIMIT ?`,
    )
    .all(...ids, ts, ts, before?.id ?? '', limit + 1) as Row[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const views = s.messageViews(page);
  const selfIds = (p: P.PostFact) => !!p.replyTo?.author && s.isSelf(p.replyTo.author);
  const seen = new Set<string>();
  const out: P.PersonPostView[] = [];
  for (const m of views) {
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
    out.push({ messageId: m.id, network: m.network, ts: m.ts, post, ...(kind ? { toYou: kind } : {}) });
  }
  const named = new Set<string>();
  for (const v of out) {
    for (const a of postAuthors(v.post)) named.add(a);
    if (v.post.replyTo?.author) named.add(v.post.replyTo.author);
  }
  const last = page[page.length - 1];
  return { posts: out, identities: s.identitiesByIds(named), hasMore, before: hasMore && last ? `${last.ts}:${last.id}` : null };
}
