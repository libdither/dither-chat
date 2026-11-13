/**
 * Public posts (X) as messages (docs/feed.md "Threads"). A post the hub reads, in a thread someone opened or on a
 * profile, is logged as a message in one read-only conversation per account (variant 'posts', native id
 * `posts:<self>`), so search, a person's history and Recent messages, edits and kept pictures work on them as on any
 * message. A post's message id is `post:<id>` and its `replyTo` the post it answers, so a thread can be read back from
 * what the hub logged when the network cannot be asked. The conversation is quiet: no unread counts, no notifications,
 * no persons made for everyone in a thread, nothing sent to the network.
 */
import type * as P from '@dither-chat/protocol';
import { composeState, NETWORK_META, POST_ACTS, postIdOf, postNativeId, postRulesFor } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { postAuthors, postView } from './feed.ts';
import { rankReactors, type ReactorIn } from './reactors.ts';
import type { AccountRow, Store } from './store.ts';

type Row = Record<string, any>;

export interface PostsDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(
    accountId: string,
    cmd:
      | { t: 'post'; post: string; cursor?: string }
      | { t: 'postAct'; post: string; act: P.PostAct }
      | { t: 'publish'; text: string; replyTo?: string; quote?: string }
      | { t: 'postReactors'; post: string; kind: 'like' | 'repost'; cursor?: string },
    timeoutMs?: number,
  ) => Promise<T>;
  /** After posts were logged: devices hear of them. */
  changed?: () => void;
}

const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

/** At most this many posts down one reply chain when the thread is read back from what was logged. */
const STORED_CHAIN = 4;
/** And this many replies under the post. */
const STORED_REPLIES = 60;
/** A thread's logged posts below it: this deep, at most this many. */
const LOGGED_DEPTH = 10;
const LOGGED_MAX = 500;

/** The posts conversation's native id for an account: one per account, as its feed is. */
export function postsConvNative(store: Store, acc: AccountRow): string {
  const self = acc.self_identity ? store.nativeOf('identity', acc.self_identity)?.nativeId : null;
  return self ? `posts:${self}` : 'posts';
}

/**
 * The post and everything inside it worth a message of its own: a repost's original and a quoted post. `inner`: seen
 * inside another, so possibly shortened (X clips a quoted post, and stops nesting two deep): such a copy only fills a
 * post the hub does not have, never replaces one.
 */
function withInner(p: P.PostFact, out: { p: P.PostFact; inner: boolean }[] = [], inner = false): { p: P.PostFact; inner: boolean }[] {
  // A repost is the reposter's: it has no words of its own, and its original is what was said.
  if (p.repostOf) withInner(p.repostOf, out, inner);
  else out.push({ p, inner });
  if (p.quoteOf) withInner(p.quoteOf, out, true);
  return out;
}

/** A thread read is answered from the last read for this long: back and forth between posts asks X once. */
const CACHE_MS = 2 * 60_000;
/** The hub waits this long for X: the extractor paces its reads, and a read may wait behind a long history read. */
const THREAD_TIMEOUT_MS = 150_000;

/**
 * Like, repost and posting wait this long for X: longer than the extractor's own 120 s for a request, so a slow post
 * comes back as what X said rather than as "it may have posted".
 */
const WRITE_TIMEOUT_MS = 130_000;
/** A post sent with the same key within this long is the same post: a second press or a retried request posts once. */
const PUBLISH_DEDUPE_MS = 10 * 60_000;
/** Who reacted is asked again after this long (a like or repost of yours clears it at once). */
const REACTORS_CACHE_MS = 5 * 60_000;

/** The network may have done it: the adapter stopped answering, not refused (as server.ts unknownOutcome). */
const unknownOutcome = (e: unknown) => /timed out|disconnected mid/i.test(String((e as Error)?.message ?? e));

/** A refusal in words, with the HTTP status the route answers with. */
export class PostsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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
  /** The last answers from the network, by post (first pages only). */
  private recent = new Map<string, { at: number; t: P.PostThread; accountId: string }>();

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
    // Whole posts first, so a post seen whole and quoted in one answer is logged whole.
    const all = posts.flatMap((p) => withInner(p)).sort((a, b) => Number(a.inner) - Number(b.inner));
    const seen = new Set<string>();
    s.db.transaction(() => {
      if (!s.one('SELECT 1 FROM conversation WHERE id = ?', cid)) s.ingest(acc, { t: 'conversation', conversation: { nativeId: conv, shape: 'channel', variant: 'posts', name: `${NETWORK_META[acc.network].name} posts` } });
      for (const { p, inner } of all) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const f = postMessage(p, conv);
        if (!f) continue;
        const mid = hubId('msg', acc.network, f.nativeId);
        const had = s.one<Row>('SELECT conversation_id FROM message WHERE id = ?', mid);
        // A copy from inside another post never replaces the post as logged: it may be clipped, and has lost its own quote.
        if (had && inner) continue;
        if (!had) fresh++;
        // Logged by another account first: it stays where it is (one message per post).
        s.ingest(acc, { t: 'message', message: had && had.conversation_id !== cid ? { ...f, conversation: s.nativeOf('conversation', had.conversation_id)!.nativeId } : f });
      }
    })();
    this.d.changed?.();
    return fresh;
  }

  /** A connected account of the network that can do this, else why not in words. */
  private able(network: P.Network, cap: P.Capability, doing: string): string {
    const s = this.d.store;
    const net = NETWORK_META[network].name;
    const all = (s.db.query('SELECT id FROM account WHERE network = ? AND enabled = 1 ORDER BY created_at').all(network) as Row[]).map((r) => r.id as string);
    const ok = all.find((a) => this.d.online(a) && caps(s, a).includes(cap));
    if (ok) return ok;
    if (!all.length) throw new PostsError(`None of your accounts is on ${net}.`, 409);
    if (!all.some((a) => this.d.online(a))) throw new PostsError(`${net} is not connected, so it cannot ${doing} now.`, 409);
    throw new PostsError(`The ${net} adapter cannot ${doing} yet.`, 409);
  }

  /** The post as logged, if it is. */
  private loggedPost(network: P.Network, post: string): P.PostFact | null {
    const r = this.d.store.one<Row>('SELECT * FROM message WHERE id = ? AND deleted = 0', hubId('msg', network, postNativeId(post)));
    return r ? this.postOf(r) : null;
  }

  private viewOf(network: P.Network, accountId: string, p: P.PostFact): P.PostView {
    const s = this.d.store;
    const shown = p.repostOf ?? p;
    const m = s.one<Row>('SELECT id FROM message WHERE id = ?', hubId('msg', network, postNativeId(shown.id)));
    return { ...postView(p, network, (u) => s.mediaUrl(u, accountId)), messageId: m?.id ?? null };
  }

  /**
   * Like, repost, or take either back: the network's own button, pressed once (docs/feed.md "Answering"). The logged
   * post follows: what you did to it, and its count by one. Returns the post as it stands.
   */
  async act(network: P.Network, post: string, act: P.PostAct): Promise<{ post: P.PostView | null; viewer: P.PostViewer }> {
    if (!POST_ACTS.includes(act)) throw new PostsError('act: like, unlike, repost or unrepost', 400);
    const rules = postRulesFor(network);
    if (!rules || !(act.endsWith('like') ? rules.actions.like : rules.actions.repost)) throw new PostsError(`${NETWORK_META[network].name} has no ${act.replace(/^un/, '')} here.`, 409);
    const accountId = this.able(network, 'postActions', act.replace(/^un/, ''));
    let viewer: P.PostViewer;
    try {
      viewer = (await this.d.command<P.PostViewer>(accountId, { t: 'postAct', post, act }, WRITE_TIMEOUT_MS)) ?? {};
    } catch (e) {
      if (unknownOutcome(e)) throw new PostsError(`${NETWORK_META[network].name} did not answer in ${WRITE_TIMEOUT_MS / 1000} seconds. It may still have gone through: look again in a minute.`, 504);
      throw new PostsError((e as Error).message, 502);
    }
    const had = this.loggedPost(network, post);
    if (!had) return { post: null, viewer };
    const key = act.endsWith('like') ? 'liked' : 'reposted';
    const on = !act.startsWith('un');
    const was = !!had.viewer?.[key];
    const now = viewer[key] ?? on;
    const count = key === 'liked' ? 'likes' : 'reposts';
    const counts = { ...had.counts, ...(had.counts?.[count] !== undefined && was !== now ? { [count]: Math.max(0, had.counts[count]! + (now ? 1 : -1)) } : {}) };
    const next: P.PostFact = { ...had, counts, viewer: { ...had.viewer, ...viewer, [key]: now } };
    this.log(accountId, [next]);
    this.forget(network, post);
    for (const k of this.reactorsSeen.keys()) if (k.startsWith(`${network}:${post}:`)) this.reactorsSeen.delete(k);
    return { post: this.viewOf(network, accountId, next), viewer: next.viewer! };
  }

  private publishing = new Map<string, { at: number; p: Promise<P.PostView>; sig: string }>();

  /**
   * Write a post: a reply (`replyTo`), a quote (`quote`) or a new one, checked against the network's rules first
   * (compose.ts, the count the page shows). `key`, the page's id for this post: the same key again within ten minutes
   * is answered with the first, so a double press or a retried request posts once. Logged as soon as it is made.
   */
  publish(network: P.Network, b: { text?: unknown; replyTo?: unknown; quote?: unknown; key?: unknown }): Promise<P.PostView> {
    const key = typeof b.key === 'string' && b.key.length <= 100 ? `${network}:${b.key}` : null;
    for (const [k, v] of this.publishing) if (Date.now() - v.at > PUBLISH_DEDUPE_MS) this.publishing.delete(k);
    const sig = JSON.stringify([b.text, b.replyTo ?? null, b.quote ?? null]);
    const had = key ? this.publishing.get(key) : null;
    // The same post again (a double press, a retried request): the first answer. Something else under the same key is
    // a page that kept its key by mistake: refused rather than dropped.
    if (had) return had.sig === sig ? had.p : Promise.reject(new PostsError('This box already posted something else: open a new one to post again.', 409));
    const p = this.write(network, b);
    if (key) {
      this.publishing.set(key, { at: Date.now(), p, sig });
      // Refused, or failed with the network's own answer: nothing was posted, the same key may try again. No answer at
      // all (504): it may have been posted, so the key stays and a retry is answered with this, not a second post.
      p.catch((e) => {
        if (!(e instanceof PostsError && e.status === 504)) this.publishing.delete(key);
      });
    }
    return p;
  }

  private async write(network: P.Network, b: { text?: unknown; replyTo?: unknown; quote?: unknown }): Promise<P.PostView> {
    const rules = postRulesFor(network);
    const net = NETWORK_META[network].name;
    if (!rules) throw new PostsError(`${net} has no posts here.`, 409);
    const text = typeof b.text === 'string' ? b.text : '';
    const id = (v: unknown, what: string) => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v !== 'string' || !/^\d{1,25}$/.test(v)) throw new PostsError(`${what}: not a post`, 400);
      return v;
    };
    const replyTo = id(b.replyTo, 'replyTo');
    const quote = id(b.quote, 'quote');
    if (replyTo && !rules.actions.reply) throw new PostsError(`${net} has no replies here.`, 409);
    if (quote && !rules.actions.quote) throw new PostsError(`${net} has no quotes here.`, 409);
    const st = composeState(text, rules);
    if (!st.sendable) throw new PostsError(st.remaining < 0 ? `Too long: ${-st.remaining} over ${net}'s ${rules.maxLength}.` : 'Nothing to post.', 422);
    const accountId = this.able(network, 'publish', 'post');
    let made: P.PostFact;
    try {
      made = await this.d.command<P.PostFact>(accountId, { t: 'publish', text, ...(replyTo ? { replyTo } : {}), ...(quote ? { quote } : {}) }, WRITE_TIMEOUT_MS);
    } catch (e) {
      if (unknownOutcome(e)) throw new PostsError(`${net} did not answer in ${WRITE_TIMEOUT_MS / 1000} seconds. It may still have posted: look on ${net} before posting again.`, 504);
      throw new PostsError((e as Error).message, 502);
    }
    if (!made?.id) throw new PostsError(`${net} did not say what it posted. It may have posted: look on ${net} before posting again.`, 504);
    // What it answers, as X may leave it out of the made post.
    const p: P.PostFact = { ...made, ...(replyTo && !made.replyTo ? { replyTo: { id: replyTo } } : {}) };
    this.log(accountId, [p]);
    if (replyTo) this.forget(network, replyTo);
    return this.viewOf(network, accountId, p);
  }

  /** A post's thread is read from X again next time (it changed). */
  private forget(network: P.Network, post: string) {
    this.recent.delete(`${network}:${post}:`);
  }

  private reactorsSeen = new Map<string, { at: number; p: Promise<P.ReactorsView> }>();

  /**
   * Who liked or reposted a post, ranked for you (reactors.ts). Hovering a button asks: an answer is reused for five
   * minutes (and a read in flight shared), so hovering back and forth asks X once.
   */
  reactors(network: P.Network, post: string, kind: 'like' | 'repost', cursor?: string): Promise<P.ReactorsView> {
    const key = `${network}:${post}:${kind}:${cursor ?? ''}`;
    for (const [k, v] of this.reactorsSeen) if (Date.now() - v.at > REACTORS_CACHE_MS) this.reactorsSeen.delete(k);
    const had = this.reactorsSeen.get(key);
    if (had) return had.p;
    const p = this.readReactors(network, post, kind, cursor);
    this.reactorsSeen.set(key, { at: Date.now(), p });
    p.catch(() => this.reactorsSeen.delete(key));
    return p;
  }

  private async readReactors(network: P.Network, post: string, kind: 'like' | 'repost', cursor?: string): Promise<P.ReactorsView> {
    const s = this.d.store;
    const net = NETWORK_META[network].name;
    const rules = postRulesFor(network);
    const accounts = (s.db.query('SELECT id FROM account WHERE network = ? AND enabled = 1 ORDER BY created_at').all(network) as Row[]).map((r) => r.id as string);
    const accountId = accounts.find((a) => this.d.online(a) && caps(s, a).includes('postReactors')) ?? null;
    const view = (people: ReactorIn[], more: string | null, from: P.ReactorsView['from'], note?: string): P.ReactorsView => {
      const ranked = rankReactors(s, people);
      return { network, post, kind, people: ranked, more, from, ...(note ? { note } : {}), identities: s.identitiesByIds(new Set(ranked.map((r) => r.identityId))) };
    };
    const notified = (): ReactorIn[] => {
      const page = s.postActivity(network, post);
      const seen = new Set<string>();
      return page.messages
        .filter((m) => m.feed?.type === kind && m.authorId && !seen.has(m.authorId) && (seen.add(m.authorId), true))
        .map((m) => ({ identityId: m.authorId!, ts: m.ts }));
    };
    let why = '';
    if (kind === 'like' && rules?.likersVisible === 'none') why = `${net} does not say who liked a post.`;
    else if (!accountId) why = accounts.length ? `${net} cannot be asked now.` : `None of your accounts is on ${net}.`;
    if (accountId && !why) {
      try {
        const page = await this.d.command<P.ReactorsPage>(accountId, { t: 'postReactors', post, kind, ...(cursor ? { cursor } : {}) }, THREAD_TIMEOUT_MS);
        const when = new Map(notified().map((r) => [r.identityId, r.ts]));
        const people = (page?.who ?? []).map((w): ReactorIn => {
          const identityId = hubId('idn', network, w.id);
          return { identityId, ...(w.followers !== undefined ? { followers: w.followers } : {}), ...(w.followsYou !== undefined ? { followsYou: w.followsYou } : {}), ...(w.following !== undefined ? { following: w.following } : {}), ...(when.get(identityId) ? { ts: when.get(identityId) } : {}) };
        });
        // An empty first page for a post that is not yours: X shows likers to the author only.
        if (!people.length && !cursor && kind === 'like' && rules?.likersVisible === 'author') {
          const n = notified();
          return view(n, null, 'notifications', n.length ? undefined : `${net} shows who liked a post only to its author.`);
        }
        return view(people, page?.more && page.more !== cursor ? page.more : null, 'network');
      } catch (e) {
        if (cursor) throw new PostsError((e as Error).message, 502);
        why = `Could not ask ${net}: ${(e as Error).message}`;
      }
    }
    if (cursor) throw new PostsError(why, 409);
    return view(notified(), null, 'notifications', `${why} These are the people your notifications named.`);
  }

  /** A post's thread: from the network when an account can ask (and logged), else what the hub logged. */
  thread(network: P.Network, post: string, cursor?: string): Promise<P.PostThreadView> {
    const key = `${network}:${post}:${cursor ?? ''}`;
    const live = this.asking.get(key);
    if (live) return live;
    const hit = !cursor ? this.recent.get(key) : null;
    // What X said is reused; the view is made again, so the branches logged since (opened under a reply) come with it.
    if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(this.view(network, post, hit.accountId, hit.t, undefined));
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
        const t = await this.d.command<P.PostThread>(accountId, { t: 'post', post, ...(cursor ? { cursor } : {}) }, THREAD_TIMEOUT_MS);
        if (!t || (!t.focal && !cursor)) throw new Error(`${net} did not give this post`);
        // A page of more replies that brings none, or the same cursor back, is the end: no button that never ends.
        if (cursor && (!t.replies.flat().length || t.more === cursor)) t.more = null;
        this.log(accountId, [...(t.focal ? [t.focal] : []), ...t.ancestors, ...t.replies.flat()]);
        if (!cursor) {
          this.recent.set(`${network}:${post}:`, { at: Date.now(), t, accountId });
          for (const [k, r] of this.recent) if (Date.now() - r.at >= CACHE_MS) this.recent.delete(k);
        }
        return this.view(network, post, accountId, t, undefined, !cursor);
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
  private view(network: P.Network, post: string, accountId: string | null, t: P.PostThread, stored: string | undefined, withLogged = true): P.PostThreadView {
    const s = this.d.store;
    const media = (u: string) => s.mediaUrl(u, accountId);
    const one = (p: P.PostFact): P.PostView => {
      const shown = p.repostOf ?? p;
      const m = s.one<Row>('SELECT id, extra FROM message WHERE id = ?', hubId('msg', network, postNativeId(shown.id)));
      // What you did to it and its counts as logged: a like since a cached read shows (log() keeps them current).
      let kept: P.PostFact | null = null;
      try {
        kept = m?.extra ? ((JSON.parse(m.extra) as { post?: P.PostFact }).post ?? null) : null;
      } catch {}
      const q = kept && p === shown ? { ...p, ...(kept.viewer ? { viewer: kept.viewer } : {}), ...(kept.counts ? { counts: kept.counts } : {}) } : p;
      return { ...postView(q, network, media), messageId: m?.id ?? null };
    };
    const shown = [...(t.focal ? [t.focal] : []), ...t.ancestors, ...t.replies.flat()];
    const ids = new Set(shown.map((p) => p.id));
    // A page of more replies goes into a thread already holding them.
    const logged = t.focal && withLogged ? this.logged(network, post).filter((p) => !ids.has(p.id)) : [];
    const all = [...shown, ...logged];
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
      ...(logged.length ? { logged: logged.map(one) } : {}),
      conversationId: conv && s.one('SELECT 1 FROM conversation WHERE id = ?', conv) ? conv : null,
      ...(stored ? { stored } : {}),
      identities: s.identitiesByIds(named),
    };
  }

  /** Posts logged under a post, any depth to LOGGED_DEPTH, oldest first (through message_post_reply). */
  private logged(network: P.Network, post: string): P.PostFact[] {
    const rows = this.d.store.db
      .query(
        `WITH RECURSIVE d(id, depth) AS (
           SELECT ?, 0
           UNION ALL
           SELECT m.id, d.depth + 1 FROM message m JOIN d ON m.reply_to_id = d.id
           WHERE d.depth < ? AND m.native_id LIKE 'post:%' AND m.deleted = 0
         )
         -- CROSS JOIN keeps d first: a plain join lets the planner scan message by ts and probe d (whole table).
         SELECT m.* FROM d CROSS JOIN message m ON m.id = d.id WHERE d.depth > 0 ORDER BY m.ts LIMIT ?`,
      )
      .all(hubId('msg', network, postNativeId(post)), LOGGED_DEPTH, LOGGED_MAX) as Row[];
    return rows.map((r) => this.postOf(r)).filter((p): p is P.PostFact => !!p);
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
    // Any account's logged posts (each post is logged once, where it was first read), through message_post_reply.
    const repliesTo = (id: string, limit: number) =>
      s.db.query(`SELECT * FROM message WHERE reply_to_id = ? AND native_id LIKE 'post:%' AND deleted = 0 ORDER BY ts LIMIT ?`).all(id, limit) as Row[];
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
