/**
 * Public posts (X) as messages (docs/feed.md "Threads"). A post the hub reads, in a thread someone opened or on a
 * profile, is logged as a message in one read-only conversation per account (variant 'posts', native id
 * `posts:<self>`), so search, a person's history and Recent messages, edits and kept pictures work on them as on any
 * message. A post's message id is `post:<id>` and its `replyTo` the post it answers, so a thread can be read back from
 * what the hub logged when the network cannot be asked. The conversation is quiet: no unread counts, no notifications,
 * no persons made for everyone in a thread, nothing sent to the network.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, postIdOf, postNativeId } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { postAuthors, postView } from './feed.ts';
import type { AccountRow, Store } from './store.ts';

type Row = Record<string, any>;

export interface PostsDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: { t: 'post'; post: string; cursor?: string }, timeoutMs?: number) => Promise<T>;
  /** After posts were logged: devices hear of them. */
  changed?: () => void;
}

const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

/** At most this many posts down one reply chain when the thread is read back from what was logged. */
const STORED_CHAIN = 4;
/** And this many replies under the post. */
const STORED_REPLIES = 60;

/** The posts conversation's native id for an account: one per account, as its feed is. */
export function postsConvNative(store: Store, acc: AccountRow): string {
  const self = acc.self_identity ? store.nativeOf('identity', acc.self_identity)?.nativeId : null;
  return self ? `posts:${self}` : 'posts';
}

/** The post and everything inside it worth a message of its own: a repost's original and a quoted post. */
function withInner(p: P.PostFact, out: P.PostFact[] = []): P.PostFact[] {
  if (p.repostOf) withInner(p.repostOf, out);
  // A repost is the reposter's: it has no words of its own, and its original is what was said.
  else out.push(p);
  if (p.quoteOf) withInner(p.quoteOf, out);
  return out;
}

/** A post as its message: its words, the post it answers, its pictures as attachments, the post itself in `extra`. */
export function postMessage(p: P.PostFact, conversation: string): P.MessageFact | null {
  if (!p.author) return null;
  return {
    nativeId: postNativeId(p.id),
    conversation,
    author: p.author,
    ts: p.ts,
    kind: 'text',
    body: p.text,
    ...(p.replyTo ? { replyTo: postNativeId(p.replyTo.id) } : {}),
    // Each picture is an image (a video's is its poster frame), so `has:image` finds it and the media archive keeps it.
    ...(p.media?.length ? { attachments: p.media.map((m, i) => ({ nativeId: String(i), kind: 'image' as const, url: m.url, ...(m.width ? { width: m.width } : {}), ...(m.height ? { height: m.height } : {}), ...(m.alt ? { name: m.alt.slice(0, 200) } : {}) })) } : {}),
    // Counts change at every read; the words and pictures are what the message is. A pinned mark belongs to a profile.
    extra: { post: { ...p, pinned: undefined } },
  };
}

export class Posts {
  /** Reads in flight, so two devices opening one thread ask once. */
  private asking = new Map<string, Promise<P.PostThreadView>>();

  constructor(private d: PostsDeps) {}

  /** Which account reads a network's posts: a connected one that can, else any on that network (for what it logged). */
  accountFor(network: P.Network): string | null {
    const s = this.d.store;
    const all = (s.db.query('SELECT id FROM account WHERE network = ? AND enabled = 1 ORDER BY created_at').all(network) as Row[]).map((r) => r.id as string);
    return all.find((a) => this.d.online(a) && caps(s, a).includes('posts')) ?? all[0] ?? null;
  }

  /**
   * Log posts as messages in the account's posts conversation (made the first time). Not live: nothing notifies, and
   * a post the hub has is updated (its words if X shows them changed, its counts). Returns how many were new.
   */
  log(accountId: string, posts: readonly P.PostFact[]): number {
    const s = this.d.store;
    const acc = s.account(accountId);
    if (!acc || !posts.length) return 0;
    const conv = postsConvNative(s, acc);
    const cid = hubId('cnv', acc.network, conv);
    let fresh = 0;
    const all = posts.flatMap((p) => withInner(p));
    const seen = new Set<string>();
    s.db.transaction(() => {
      if (!s.one('SELECT 1 FROM conversation WHERE id = ?', cid)) s.ingest(acc, { t: 'conversation', conversation: { nativeId: conv, shape: 'channel', variant: 'posts', name: `${NETWORK_META[acc.network].name} posts` } });
      for (const p of all) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const f = postMessage(p, conv);
        if (!f) continue;
        const mid = hubId('msg', acc.network, f.nativeId);
        const had = s.one<Row>('SELECT conversation_id FROM message WHERE id = ?', mid);
        if (!had) fresh++;
        // Logged by another account first: it stays where it is (one message per post).
        s.ingest(acc, { t: 'message', message: had && had.conversation_id !== cid ? { ...f, conversation: s.nativeOf('conversation', had.conversation_id)!.nativeId } : f });
      }
    })();
    this.d.changed?.();
    return fresh;
  }

  /** A post's thread: from the network when an account can ask (and logged), else what the hub logged. */
  thread(network: P.Network, post: string, cursor?: string): Promise<P.PostThreadView> {
    const key = `${network}:${post}:${cursor ?? ''}`;
    const live = this.asking.get(key);
    if (live) return live;
    const p = this.ask(network, post, cursor).finally(() => this.asking.delete(key));
    this.asking.set(key, p);
    return p;
  }

  private async ask(network: P.Network, post: string, cursor: string | undefined): Promise<P.PostThreadView> {
    const s = this.d.store;
    const net = NETWORK_META[network].name;
    const accountId = this.accountFor(network);
    const why = !accountId
      ? `None of your accounts is on ${net}.`
      : !this.d.online(accountId)
        ? `${net} · ${s.account(accountId)?.label} is not connected.`
        : !caps(s, accountId).includes('posts')
          ? `The ${net} adapter cannot read threads yet.`
          : null;
    if (accountId && !why) {
      try {
        const t = await this.d.command<P.PostThread>(accountId, { t: 'post', post, ...(cursor ? { cursor } : {}) }, 90_000);
        if (!t || (!t.focal && !cursor)) throw new Error(`${net} did not give this post`);
        this.log(accountId, [...(t.focal ? [t.focal] : []), ...t.ancestors, ...t.replies.flat()]);
        return this.view(network, post, accountId, t, undefined);
      } catch (e) {
        // A page of more replies has nothing logged to fall back on beyond the first page.
        if (cursor) throw e;
        return this.stored(network, post, accountId, `Could not ask ${net}: ${(e as Error).message}`);
      }
    }
    if (cursor) throw new Error(why!);
    return this.stored(network, post, accountId, why!);
  }

  /** The thread in hub ids, each post with the message it was logged as. */
  private view(network: P.Network, post: string, accountId: string | null, t: P.PostThread, stored: string | undefined): P.PostThreadView {
    const s = this.d.store;
    const media = (u: string) => s.mediaUrl(u, accountId);
    const one = (p: P.PostFact): P.PostView => {
      const shown = p.repostOf ?? p;
      const m = s.one<Row>('SELECT id FROM message WHERE id = ?', hubId('msg', network, postNativeId(shown.id)));
      return { ...postView(p, network, media), messageId: m?.id ?? null };
    };
    const all = [...(t.focal ? [t.focal] : []), ...t.ancestors, ...t.replies.flat()];
    const named = new Set<string>();
    for (const p of all) {
      for (const n of postAuthors(p)) named.add(hubId('idn', network, n));
      if (p.replyTo?.author) named.add(hubId('idn', network, p.replyTo.author));
    }
    const acc = accountId ? s.account(accountId) : null;
    const conv = acc ? hubId('cnv', network, postsConvNative(s, acc)) : null;
    return {
      network,
      post,
      focal: t.focal ? one(t.focal) : null,
      ancestors: t.ancestors.map(one),
      replies: t.replies.map((c) => c.map(one)),
      more: t.more,
      conversationId: conv && s.one('SELECT 1 FROM conversation WHERE id = ?', conv) ? conv : null,
      ...(stored ? { stored } : {}),
      identities: s.identitiesByIds(named),
    };
  }

  /** The post's message, as logged: the post in its `extra`, else rebuilt from the message. */
  private postOf(r: Row): P.PostFact | null {
    const id = postIdOf(r.native_id);
    if (!id) return null;
    let p: P.PostFact | null = null;
    try {
      p = (JSON.parse(r.extra ?? 'null') as { post?: P.PostFact } | null)?.post ?? null;
    } catch {}
    if (p) return { ...p, text: r.body ?? p.text };
    const author = r.author_id ? this.d.store.nativeOf('identity', r.author_id)?.nativeId : undefined;
    const parentNative = r.reply_to_id ? this.d.store.nativeOf('message', r.reply_to_id)?.nativeId : null;
    const parent = parentNative ? postIdOf(parentNative) : null;
    return { id, url: `https://x.com/i/web/status/${id}`, ts: r.ts, text: r.body ?? '', ...(author ? { author } : {}), ...(parent ? { replyTo: { id: parent } } : {}) };
  }

  /** What the hub logged of a thread: what the post answers, back to the first post logged, and the replies to it. */
  private stored(network: P.Network, post: string, accountId: string | null, why: string): P.PostThreadView {
    const s = this.d.store;
    const row = (id: string) => s.one<Row>('SELECT * FROM message WHERE id = ? AND deleted = 0', id);
    const focalRow = row(hubId('msg', network, postNativeId(post)));
    if (!focalRow) return { ...this.view(network, post, accountId, { ancestors: [], replies: [], more: null }, why), focal: null };
    const focal = this.postOf(focalRow)!;
    const ancestors: P.PostFact[] = [];
    const visited = new Set<string>([focalRow.id]);
    for (let r = focalRow; r.reply_to_id && ancestors.length < 50; ) {
      const up = row(r.reply_to_id);
      if (!up || visited.has(up.id)) break;
      visited.add(up.id);
      const p = this.postOf(up);
      if (!p) break;
      ancestors.unshift(p);
      r = up;
    }
    const repliesTo = (id: string, limit: number) =>
      s.db.query('SELECT * FROM message WHERE conversation_id = ? AND reply_to_id = ? AND deleted = 0 ORDER BY ts LIMIT ?').all(focalRow.conversation_id, id, limit) as Row[];
    const direct = repliesTo(focalRow.id, STORED_REPLIES);
    // The author continuing their own thread first, as X shows it.
    direct.sort((a, b) => Number(b.author_id === focalRow.author_id) - Number(a.author_id === focalRow.author_id) || a.ts - b.ts);
    const replies: P.PostFact[][] = [];
    for (const r of direct) {
      const chain = [r];
      for (let last = r; chain.length < STORED_CHAIN; ) {
        const next = repliesTo(last.id, 1)[0];
        if (!next || visited.has(next.id)) break;
        visited.add(next.id);
        chain.push(next);
        last = next;
      }
      replies.push(chain.map((x) => this.postOf(x)).filter((p): p is P.PostFact => !!p));
    }
    return this.view(network, post, accountId, { focal, ancestors, replies, more: null }, why);
  }
}
