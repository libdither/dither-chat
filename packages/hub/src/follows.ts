/**
 * Following a post (docs/feed.md "Following a post"): the post gets a conversation of its own (variant 'follow', native
 * id `follow:<post>`, for the account that reads it), and the replies found after you followed it go there as
 * messages (posts.ts log), in the inbox like any chat's: a reply a check found unread and told, one your own reading
 * brought in read.
 *
 * The hub reads the thread again for new replies itself, slower and slower: CONFIG.first after following or after a
 * check found something, the gap doubling up to CONFIG.max; after CONFIG.quiet with nothing new it stops (the
 * conversation stays, and says so). Following again starts over.
 *
 * Each check reads the thread's first page only, past Posts' short cache, through the account's reading pace
 * (readingpace.ts: the owner's hours, sessions and breaks, a pause after each read), one at a time per account, and
 * not while the account is offline: a check due then waits for it. X ranks that page by relevance, so on a busy post
 * a new reply can be missed.
 *
 * Following reads the thread once first, before the follow exists: the replies there already are not new.
 */
import type * as P from '@dither-chat/protocol';
import { followNativeId, NETWORK_META, postIdOf } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { realClock, unref, type Clock } from './clock.ts';
import { PostsError, type Posts } from './posts.ts';
import type { ReadingPace } from './readingpace.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

const MIN = 60_000;

export interface FollowConfig {
  /** The first check after following, and after a check that found a new reply, ms. */
  first: number;
  /** The gap doubles up to this, ms. */
  max: number;
  /** No new reply for this long: checks stop, ms. */
  quiet: number;
}

export const FOLLOW: FollowConfig = { first: 5 * MIN, max: 6 * 60 * MIN, quiet: 7 * 24 * 60 * MIN };

/** `DITHER_FOLLOW_FIRST_MS`: the first gap (a verify script's demo hub checks within seconds). */
export function followFromEnv(env: Record<string, string | undefined> = process.env): FollowConfig {
  const first = Number(env.DITHER_FOLLOW_FIRST_MS);
  return env.DITHER_FOLLOW_FIRST_MS && Number.isFinite(first) && first > 0 ? { ...FOLLOW, first } : FOLLOW;
}

/** The reader's name in the reading pace. */
const READER = 'follows';
/** A check due while its account is offline is looked at again this often. */
const OFFLINE_RETRY = MIN;

interface FollowsDeps {
  store: Store;
  posts: Posts;
  online: (accountId: string) => boolean;
  pace: ReadingPace;
  clock?: Clock;
  config?: FollowConfig;
  /** Something changed that devices should hear of. */
  changed?: () => void;
  log?: (line: string) => void;
}

/** "Replies to Maya's post", for the inbox. */
function convName(store: Store, network: P.Network, author: string | undefined): string {
  if (!author) return 'Replies to a post';
  const id = hubId('idn', network, author);
  if (store.isSelf(id)) return 'Replies to your post';
  const i = store.one<Row>('SELECT display_name, handle FROM identity WHERE id = ?', id);
  const name = i?.display_name || (i?.handle ? `@${String(i.handle).replace(/^@/, '')}` : null);
  return name ? `Replies to ${name}'s post` : 'Replies to a post';
}

export class Follows {
  private clock: Clock;
  private config: FollowConfig;
  /** Accounts with a check under way. */
  private busy = new Set<string>();
  /** Not before then, by account: the pace's wait, or the pause after a read. */
  private notBefore = new Map<string, number>();
  private timer: unknown = null;
  private wakeAt = Infinity;
  private running = false;
  private following = new Map<string, Promise<P.PostFollow>>();

  constructor(private d: FollowsDeps) {
    this.clock = d.clock ?? realClock;
    this.config = d.config ?? FOLLOW;
  }

  /** Checks go on as they come due. */
  start() {
    this.running = true;
    this.arm();
  }

  stop() {
    this.running = false;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.wakeAt = Infinity;
  }

  private row(network: P.Network, post: string): Row | null {
    return this.d.store.one<Row>('SELECT * FROM post_follow WHERE network = ? AND post = ?', network, post);
  }

  /** The post's follow, or null. `fresh`: with the replies found since its conversation was last read. */
  state(network: P.Network, post: string, fresh = false): P.PostFollow | null {
    const r = this.row(network, post);
    if (!r) return null;
    const f = this.d.store.postFollow(r.conversation_id);
    if (!f || !fresh) return f;
    // Found after the last read, and not yours (what you post reads the conversation).
    const rows = this.d.store.db
      .query(
        `SELECT m.native_id, m.author_id FROM post_follow_found x CROSS JOIN message m ON m.id = x.message_id
         WHERE x.conversation_id = ? AND m.deleted = 0 AND x.at > COALESCE((SELECT last_read_ts FROM vantage WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?), 0)
         ORDER BY x.at`,
      )
      .all(r.conversation_id, r.account_id, r.conversation_id) as Row[];
    return { ...f, fresh: rows.filter((m) => !this.d.store.isSelf(m.author_id)).map((m) => postIdOf(m.native_id)).filter((id): id is string => !!id) };
  }

  /**
   * Follow a post (again): read its thread now, so what is there is not new, then make its conversation and check
   * from CONFIG.first on. Following one followed already answers as it stands.
   */
  follow(network: P.Network, post: string): Promise<P.PostFollow> {
    const key = `${network}:${post}`;
    const had = this.following.get(key);
    if (had) return had;
    const p = this.start1(network, post).finally(() => this.following.delete(key));
    this.following.set(key, p);
    return p;
  }

  private async start1(network: P.Network, post: string): Promise<P.PostFollow> {
    const s = this.d.store;
    const was = this.row(network, post);
    if (was && was.stopped === null) return s.postFollow(was.conversation_id)!;
    // The account that followed it before (its conversation is that account's), else one that can read threads.
    const accountId = this.d.posts.able(network, 'posts', 'follow posts', was?.account_id ?? undefined);
    // Before the follow goes on: replies found by this read are not new.
    const { thread } = await this.d.posts.reread(network, post, accountId, false);
    const acc = s.account(accountId);
    if (!acc) throw new PostsError(`No such ${NETWORK_META[network].name} account.`, 404);
    const focal = thread.focal!.repostOf ?? thread.focal!;
    const now = this.clock.now();
    const native = followNativeId(post);
    const cid = hubId('cnv', network, native);
    s.db.transaction(() => {
      if (!s.one('SELECT 1 FROM conversation WHERE id = ?', cid)) {
        const avatar = focal.author ? s.one<Row>('SELECT avatar_url FROM identity WHERE id = ?', hubId('idn', network, focal.author))?.avatar_url : null;
        s.ingest(acc, {
          t: 'conversation',
          conversation: {
            nativeId: native,
            shape: 'channel',
            variant: 'follow',
            name: convName(s, network, focal.author),
            ...(focal.text ? { topic: focal.text.length > 200 ? `${focal.text.slice(0, 199)}…` : focal.text } : {}),
            ...(avatar ? { avatarUrl: avatar } : {}),
          },
        });
      }
      s.db
        .query(
          `INSERT INTO post_follow (conversation_id, account_id, network, post, since, last_new, gap, next_at, checked_at, stopped, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT (conversation_id) DO UPDATE SET account_id = excluded.account_id, since = excluded.since, last_new = excluded.last_new, gap = excluded.gap,
             next_at = excluded.next_at, checked_at = excluded.checked_at, stopped = NULL, why = NULL`,
        )
        .run(cid, accountId, network, post, now, now, this.config.first, now + this.config.first, now);
      s.dirty.conversations.add(cid);
    })();
    this.d.changed?.();
    this.arm();
    return s.postFollow(cid)!;
  }

  /** Stop following: checks stop, the conversation stays with what it found. */
  unfollow(network: P.Network, post: string): P.PostFollow {
    const r = this.row(network, post);
    if (!r) throw new PostsError('That post is not followed.', 404);
    if (r.stopped === null) this.stopRow(r.conversation_id, 'unfollowed');
    return this.d.store.postFollow(r.conversation_id)!;
  }

  private stopRow(cid: string, why: 'unfollowed' | 'quiet') {
    const s = this.d.store;
    s.db.query('UPDATE post_follow SET stopped = ?, why = ?, next_at = NULL WHERE conversation_id = ?').run(this.clock.now(), why, cid);
    s.dirty.conversations.add(cid);
    this.d.changed?.();
  }

  /** The timer, set for the next check due (or the next time one of its account may read). */
  private arm() {
    if (!this.running) return;
    const now = this.clock.now();
    const next = this.d.store.one<{ at: number | null }>('SELECT MIN(next_at) AS at FROM post_follow WHERE next_at IS NOT NULL')?.at ?? null;
    if (next === null) return;
    // Due already: when the account it waits for may read (its pace, or an offline account looked at again).
    let at = next;
    if (next <= now) {
      const accounts = (this.d.store.db.query('SELECT DISTINCT account_id FROM post_follow WHERE next_at IS NOT NULL AND next_at <= ?').all(now) as Row[]).map((r) => r.account_id as string);
      const waits = accounts.filter((a) => !this.busy.has(a)).map((a) => (this.d.online(a) ? (this.notBefore.get(a) ?? now) : now + OFFLINE_RETRY));
      // Every account due is checking now: its check arms the timer when it ends.
      if (!waits.length) return;
      at = Math.max(now, Math.min(...waits));
    }
    if (this.timer && this.wakeAt <= at) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.wakeAt = at;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.wakeAt = Infinity;
      void this.tick();
    }, at - now);
    unref(this.timer);
  }

  /**
   * The checks that are due, one per account and only where the account is online and its pace lets it read. Returns
   * when those started have ended (tests).
   */
  async tick(): Promise<void> {
    const now = this.clock.now();
    const due = this.d.store.db.query('SELECT * FROM post_follow WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at').all(now) as Row[];
    const runs: Promise<void>[] = [];
    const taken = new Set<string>();
    for (const r of due) {
      const a = r.account_id as string;
      if (taken.has(a) || this.busy.has(a)) continue;
      taken.add(a);
      if (!this.d.online(a) || (this.notBefore.get(a) ?? 0) > now) continue;
      const wait = this.d.pace.wait(a, READER);
      if (wait > 0) {
        this.notBefore.set(a, now + wait);
        continue;
      }
      runs.push(this.check(r));
    }
    this.arm();
    await Promise.all(runs);
  }

  /** One check: the thread's first page read again; the gap after it doubles, or starts over when it found a reply. */
  private async check(r: Row): Promise<void> {
    const s = this.d.store;
    const a = r.account_id as string;
    this.busy.add(a);
    let found = 0;
    let read = 0;
    try {
      const got = await this.d.posts.reread(r.network, r.post, a, true);
      found = got.followed;
      read = got.read;
    } catch (e) {
      // Taken as nothing new: the gap grows, and a week of failures stops it as a quiet week would.
      this.d.log?.(`follows: could not read ${r.network} post ${r.post} for ${a}: ${(e as Error).message}`);
    }
    const now = this.clock.now();
    try {
      // Unfollowed while it read: it stays stopped.
      const cur = s.one<Row>('SELECT * FROM post_follow WHERE conversation_id = ?', r.conversation_id);
      if (cur && cur.stopped === null) {
        if (found > 0) {
          s.db.query('UPDATE post_follow SET checked_at = ?, last_new = ?, gap = ?, next_at = ? WHERE conversation_id = ?').run(now, now, this.config.first, now + this.config.first, r.conversation_id);
          s.dirty.conversations.add(r.conversation_id);
        } else if (now - cur.last_new >= this.config.quiet) {
          s.db.query('UPDATE post_follow SET checked_at = ? WHERE conversation_id = ?').run(now, r.conversation_id);
          this.stopRow(r.conversation_id, 'quiet');
        } else {
          const gap = Math.min(cur.gap * 2, this.config.max);
          // The last check falls on the end of the quiet week, not past it.
          s.db.query('UPDATE post_follow SET checked_at = ?, gap = ?, next_at = ? WHERE conversation_id = ?').run(now, gap, Math.min(now + gap, cur.last_new + this.config.quiet), r.conversation_id);
          s.dirty.conversations.add(r.conversation_id);
        }
        this.d.changed?.();
      }
      // A pause after the read, as a person reading takes; the turn is kept through it only while more is due.
      const pause = read ? this.d.pace.read(a, READER, read) : 0;
      this.notBefore.set(a, now + pause);
      if (!s.one('SELECT 1 FROM post_follow WHERE account_id = ? AND next_at IS NOT NULL AND next_at <= ?', a, now + pause)) this.d.pace.release(a, READER);
    } finally {
      this.busy.delete(a);
      this.arm();
    }
  }
}
