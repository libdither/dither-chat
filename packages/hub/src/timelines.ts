/**
 * The Feed page's posts (docs/feed.md "The Feed page"): your accounts' home timelines, what you posted, posting to
 * several accounts in one press, and drafts the hub posts at their time.
 *
 * A home timeline is read only when someone looks at it (the page opens, is pulled to refresh, or scrolls past what
 * the hub holds), at the network's reading pace, and nothing is marked seen. Each post read is logged as a message in
 * the account's quiet posts conversation, as a thread's are (posts.ts); `feed_item` keeps which timeline showed it,
 * in what order and why. Following is ordered by time (each post's own, a repost's when it was reposted), For you by
 * the network's ranking: each fresh read's batch goes on top, as the network's own Home tab shows it.
 *
 * A feed of yours (`feed_mix`, protocol mix.ts) puts timelines from any of your accounts in one list: each with its
 * share, in an order you swap at will, a post that two timelines show once. Following (every account's Following,
 * newest first) and Discover (every account's For you, taking turns) are always there; you change them or make more.
 * Your posts are the messages your own identities wrote in the posts conversations; posts made together in one press
 * of Post are one entry with copies (`post_group`).
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { HOME_FEEDS, homeFeedsOf, isEventNetwork, NETWORK_META, postIdOf, postNativeId, postRulesFor, REPLY_GATES, splitThread, withoutHiddenGuests } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { engagement, MIX_ORDERS, orderMix, SHARE_WEIGHTS, type MixItem, type MixOrder } from '@dither-chat/protocol/mix';
import { eventDecorated } from './eventseen.ts';
import { postAuthors, postView } from './feed.ts';
import { type Posts, PostsError } from './posts.ts';
import type { AccountRow, Store } from './store.ts';

type Row = Record<string, any>;

interface TimelinesDeps {
  store: Store;
  posts: Posts;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: { t: 'home'; feed: P.HomeFeed; cursor?: string; count?: number } | { t: 'profile'; who: string }, timeoutMs?: number) => Promise<T>;
  /** Upload ids to files (uploads.ts), null when one is gone. */
  files?: (ids: string[]) => P.OutgoingAttachment[] | null | Promise<P.OutgoingAttachment[] | null>;
  changed?: () => void;
}

/** A timeline read within this long is answered from what the hub holds: back and forth asks the network once. */
const FRESH_MS = 60_000;
/** The hub waits this long for a read: the extractor paces its reads. */
const READ_TIMEOUT_MS = 150_000;
/** Posts asked for in a page. */
const PAGE = 20;
/** Entries in a page of the view. */
const VIEW_PAGE = 30;
/** Kept per timeline; the oldest go. */
const KEEP = 1_500;
/** A scheduled post more than this late (its account was not connected) is held as failed, not posted. */
const LATE_MS = 30 * 60_000;
/** How often scheduled drafts are looked at. */
const TICK_MS = 15_000;
/** At most this many drafts. */
const DRAFTS_MAX = 200;
/** At most this many feeds of your own. */
const MIXES_MAX = 20;
/** A share's step for an even share (SHARE_WEIGHTS). */
const EVEN = 2;
/**
 * Feeds always there: as they are until changed, and put back by DELETE. Events (docs/events.md) takes the event sites'
 * Explore and Your events, which Following and Discover leave out: a party list is not a timeline of posts.
 */
const BUILT_IN: Record<string, { name: string; order: MixOrder; on: (network: P.Network, feed: P.HomeFeed) => boolean }> = {
  following: { name: 'Following', order: 'newest', on: (n, f) => f === 'following' && !isEventNetwork(n) },
  discover: { name: 'Discover', order: 'turns', on: (n, f) => f === 'foryou' && !isEventNetwork(n) },
  events: { name: 'Events', order: 'turns', on: (n) => isEventNetwork(n) },
};
/** A timeline the network orders by time (a Following of posts); the others keep the network's order. */
const byTime = (network: P.Network, feed: P.HomeFeed) => feed === 'following' && !isEventNetwork(network);

const made = new WeakSet<Database>();
function tables(db: Database) {
  if (made.has(db)) return;
  db.run(`CREATE TABLE IF NOT EXISTS feed_item (
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    feed       TEXT NOT NULL,
    post_id    TEXT NOT NULL,
    message_id TEXT NOT NULL,
    pos        REAL NOT NULL,
    item       TEXT NOT NULL,
    seen_at    INTEGER NOT NULL,
    PRIMARY KEY (account_id, feed, post_id)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS feed_item_order ON feed_item(feed, pos DESC)');
  db.run('CREATE INDEX IF NOT EXISTS feed_item_message ON feed_item(message_id)');
  db.run(`CREATE TABLE IF NOT EXISTS feed_read (
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    feed       TEXT NOT NULL,
    top        TEXT,
    bottom     TEXT,
    read_at    INTEGER,
    PRIMARY KEY (account_id, feed)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS post_group (
    message_id TEXT PRIMARY KEY,
    grp        TEXT NOT NULL,
    account_id TEXT NOT NULL,
    at         INTEGER NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS post_group_grp ON post_group(grp)');
  db.run(`CREATE TABLE IF NOT EXISTS feed_mix (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    ord     TEXT NOT NULL,
    shares  TEXT NOT NULL,
    made_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS post_draft (
    id           TEXT PRIMARY KEY,
    body         TEXT NOT NULL,
    scheduled_at INTEGER,
    failed       TEXT,
    updated_at   INTEGER NOT NULL
  )`);
  made.add(db);
}

const caps = (store: Store, accountId: string): P.Capability[] => {
  try {
    return JSON.parse(store.account(accountId)?.capabilities ?? '[]');
  } catch {
    return [];
  }
};

/** The post a timeline item shows (a repost's original). */
const shownOf = (p: P.PostFact) => p.repostOf ?? p;

/** A source's timelines: an account's Following or For you, each with its share's weight. */
type Lines = { accountId: string; feed: P.HomeFeed; weight: number }[];
/** What a source shows: timelines in an order, or your posts. */
type Parsed = { lines: Lines; order: MixOrder; mine: false } | { lines: []; mine: true };

export class Timelines {
  private asking = new Map<string, Promise<void>>();
  private notes = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: TimelinesDeps) {
    tables(d.store.db);
  }

  /** Scheduled drafts go out at their time. */
  start() {
    this.timer ??= setInterval(() => void this.tick().catch(() => {}), TICK_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private get db() {
    return this.d.store.db;
  }

  /** Accounts on networks that have posts, in the accounts' order. */
  private accounts(): AccountRow[] {
    return this.d.store.accounts().filter((a) => a.enabled && !!postRulesFor(a.network));
  }

  sources(): P.FeedSourcesView {
    const s = this.d.store;
    const accounts = this.accounts().map((a): P.FeedAccountView => {
      const c = caps(s, a.id);
      const feedConv = s.one<Row>(
        `SELECT c.id FROM conversation c JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = c.id WHERE v.account_id = ? AND c.variant = 'feed' ORDER BY c.id LIMIT 1`,
        a.id,
      );
      return {
        accountId: a.id,
        network: a.network,
        label: a.label,
        identityId: a.self_identity,
        online: this.d.online(a.id),
        home: c.includes('home'),
        publish: c.includes('publish'),
        media: c.includes('postMedia'),
        unpublish: c.includes('unpublish'),
        feedConvId: feedConv?.id ?? null,
      };
    });
    const drafts = (this.db.query('SELECT COUNT(*) n FROM post_draft').get() as Row).n as number;
    return { accounts, mixes: this.mixes(), drafts };
  }

  // ------------------------------------------------------------------ your feeds

  /** Following, Discover and (with an event site) Events, then the feeds you made, each listing every timeline it could take. */
  mixes(): P.FeedMixView[] {
    const homes = this.accounts().filter((a) => caps(this.d.store, a.id).includes('home'));
    const rows = new Map((this.db.query('SELECT * FROM feed_mix ORDER BY made_at').all() as Row[]).map((r) => [r.id as string, r]));
    const view = (id: string, r: Row | undefined): P.FeedMixView => {
      const built = BUILT_IN[id];
      let shares: Record<string, number> = {};
      try {
        shares = r ? JSON.parse(r.shares) : {};
      } catch {}
      return {
        id,
        name: r?.name ?? built?.name ?? id,
        order: (r?.ord as MixOrder) ?? built?.order ?? 'turns',
        // A timeline it does not name (an account added since) is in Following's or Discover's own kind, else out.
        sources: homes.flatMap((a) => homeFeedsOf(a.network).map((feed) => ({ accountId: a.id, feed, share: shares[`${a.id}:${feed}`] ?? (built?.on(a.network, feed) ? EVEN : 0) }))),
        custom: !built,
      };
    };
    // Events only once there is an event site to read.
    const built = Object.keys(BUILT_IN).filter((id) => id !== 'events' || homes.some((a) => isEventNetwork(a.network)));
    return [...built.map((id) => view(id, rows.get(id))), ...[...rows.values()].filter((r) => !BUILT_IN[r.id]).map((r) => view(r.id, r))];
  }

  /** A feed saved: any of its name, order and shares; a new id makes one. */
  saveMix(id: string, body: unknown): P.FeedMixView {
    if (!/^[\w-]{1,40}$/.test(id) || /^(mine|activity|drafts|home)$/.test(id)) throw new PostsError('Not a feed id.', 400);
    const b = (body ?? {}) as Partial<Omit<P.FeedMixView, 'id' | 'custom'>>;
    const had = this.mixes().find((m) => m.id === id);
    const row = this.db.query('SELECT * FROM feed_mix WHERE id = ?').get(id) as Row | null;
    if (!had && (this.db.query(`SELECT COUNT(*) n FROM feed_mix WHERE id NOT IN (${Object.keys(BUILT_IN).map(() => '?').join(',')})`).get(...Object.keys(BUILT_IN)) as Row).n >= MIXES_MAX)
      throw new PostsError(`At most ${MIXES_MAX} feeds of your own.`, 409);
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 40)) throw new PostsError('name: up to 40 characters', 400);
    if (b.order !== undefined && !MIX_ORDERS.includes(b.order)) throw new PostsError(`order: ${MIX_ORDERS.join(', ')}`, 400);
    let shares: Record<string, number> = {};
    try {
      shares = row ? JSON.parse(row.shares) : {};
    } catch {}
    // A feed's timelines as they were (a new one starts with every Following, even), then what was sent.
    const netOf = (accountId: string) => this.d.store.account(accountId)?.network ?? 'x';
    if (!row) for (const x of had?.sources ?? this.mixes()[0].sources) shares[`${x.accountId}:${x.feed}`] = had ? x.share : BUILT_IN.following.on(netOf(x.accountId), x.feed) ? EVEN : 0;
    if (b.sources !== undefined) {
      if (!Array.isArray(b.sources)) throw new PostsError('sources: [{ accountId, feed, share }]', 400);
      for (const x of b.sources) {
        if (!x || typeof x.accountId !== 'string' || !HOME_FEEDS.includes(x.feed) || !Number.isInteger(x.share) || x.share < 0 || x.share >= SHARE_WEIGHTS.length)
          throw new PostsError(`sources: [{ accountId, feed: ${HOME_FEEDS.join(', ')}, share: 0 to ${SHARE_WEIGHTS.length - 1} }]`, 400);
        if (!homeFeedsOf(netOf(x.accountId)).includes(x.feed)) throw new PostsError(`${NETWORK_META[netOf(x.accountId)].name} has no ${x.feed} timeline.`, 400);
        shares[`${x.accountId}:${x.feed}`] = x.share;
      }
    }
    const name = b.name?.trim() ?? had?.name ?? 'New feed';
    const order = b.order ?? had?.order ?? 'turns';
    this.db
      .query(
        `INSERT INTO feed_mix (id, name, ord, shares, made_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, ord = excluded.ord, shares = excluded.shares`,
      )
      .run(id, name, order, JSON.stringify(shares), Date.now());
    this.d.changed?.();
    return this.mixes().find((m) => m.id === id)!;
  }

  /** A feed you made, gone; Following or Discover, back as they were. */
  dropMix(id: string) {
    this.db.query('DELETE FROM feed_mix WHERE id = ?').run(id);
    this.d.changed?.();
  }

  /** The timelines a source reads, in what order, or Your posts. `home`, the merged source of old links, is Following. */
  private parse(source: string): Parsed {
    if (source === 'mine') return { lines: [], mine: true };
    const mix = this.mixes().find((m) => m.id === (source === 'home' ? 'following' : source));
    if (mix) {
      const lines = mix.sources.filter((x) => x.share > 0).map((x) => ({ accountId: x.accountId, feed: x.feed, weight: SHARE_WEIGHTS[x.share] }));
      return { lines, order: mix.order, mine: false };
    }
    const m = source.match(/^([\w-]+):(following|foryou|explore|mine)$/);
    if (!m) throw new PostsError('source: a feed, mine, or <account>:following, :foryou, :explore or :mine', 400);
    const acc = this.d.store.account(m[1]);
    if (!acc || !postRulesFor(acc.network)) throw new PostsError('No such account.', 404);
    if (m[2] === 'mine') return { lines: [], mine: true };
    if (!homeFeedsOf(acc.network).includes(m[2] as P.HomeFeed)) throw new PostsError(`${NETWORK_META[acc.network].name} has no ${m[2]} timeline.`, 404);
    // One timeline alone, in its own order.
    return { lines: [{ accountId: acc.id, feed: m[2] as P.HomeFeed, weight: 1 }], order: 'turns', mine: false };
  }

  // ------------------------------------------------------------------ reading

  /**
   * Ask the networks for a source's timelines (a person's own look at them), then answer what the hub holds. `older`:
   * the next page past what the hub holds. A timeline read in the last minute is not asked again (older pages are).
   */
  async read(source: string, older = false): Promise<P.FeedEntriesView> {
    const p = this.parse(source);
    if (p.mine) await Promise.all(this.mineAccounts(source).map((a) => this.readMine(a)));
    else await Promise.all(p.lines.map((l) => this.readLine(l.accountId, l.feed, older)));
    return this.entries(source);
  }

  private mineAccounts(source: string): string[] {
    const m = source.match(/^([\w-]+):mine$/);
    if (m) return [m[1]];
    return this.accounts().map((a) => a.id);
  }

  private readLine(accountId: string, feed: P.HomeFeed, older: boolean): Promise<void> {
    const key = `${accountId}:${feed}:${older ? 'older' : 'top'}`;
    const live = this.asking.get(key);
    if (live) return live;
    const p = this.ask(accountId, feed, older).finally(() => this.asking.delete(key));
    this.asking.set(key, p);
    return p;
  }

  private async ask(accountId: string, feed: P.HomeFeed, older: boolean): Promise<void> {
    const s = this.d.store;
    const acc = s.account(accountId);
    if (!acc) return;
    const net = NETWORK_META[acc.network].name;
    const noteKey = `${accountId}:${feed}`;
    const st = this.db.query('SELECT top, bottom, read_at FROM feed_read WHERE account_id = ? AND feed = ?').get(accountId, feed) as Row | null;
    if (!older && st?.read_at && Date.now() - st.read_at < FRESH_MS) return;
    if (older && st && !st.bottom) return;
    if (!this.d.online(accountId)) return void this.notes.set(noteKey, `${net} · ${acc.label} is not connected, so this is what was read before.`);
    if (!caps(s, accountId).includes('home')) return void this.notes.set(noteKey, `The ${net} adapter cannot read timelines yet.`);
    let page: P.HomePage;
    try {
      page = await this.d.command<P.HomePage>(accountId, { t: 'home', feed, count: PAGE, ...(older && st?.bottom ? { cursor: st.bottom } : {}) }, READ_TIMEOUT_MS);
    } catch (e) {
      this.notes.set(noteKey, `Could not read ${net} · ${acc.label}: ${(e as Error).message}`);
      return;
    }
    this.notes.delete(noteKey);
    this.keep(acc, feed, page, older);
  }

  /** A page of a timeline: its posts logged, its items in order. */
  keep(acc: AccountRow, feed: P.HomeFeed, page: P.HomePage, older: boolean) {
    // A hidden guest list's guests are never kept (docs/events.md "Who is going"), in the item as in its logged post.
    const items = (page?.items ?? []).filter((i) => i?.post?.id).map((i) => ({ ...i, post: withoutHiddenGuests(i.post), ...(i.above ? { above: i.above.map(withoutHiddenGuests) } : {}) }));
    const timed = byTime(acc.network, feed);
    this.d.posts.log(acc.id, items.flatMap((i) => [...(i.above ?? []), i.post]));
    const now = Date.now();
    const lowest = (this.db.query('SELECT MIN(pos) p FROM feed_item WHERE account_id = ? AND feed = ?').get(acc.id, feed) as Row).p as number | null;
    const put = this.db.query(
      `INSERT INTO feed_item (account_id, feed, post_id, message_id, pos, item, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, feed, post_id) DO UPDATE SET item = excluded.item, seen_at = excluded.seen_at, pos = CASE WHEN ? THEN excluded.pos ELSE feed_item.pos END`,
    );
    this.db.transaction(() => {
      items.forEach((it, i) => {
        // Following: by time. For you, Explore and an event site's own events: this read's batch on top in the network's
        // order; an older page below the rest.
        const pos = timed ? it.post.ts : older ? (lowest ?? now) - 1 - i : now - i;
        const shown = shownOf(it.post);
        put.run(acc.id, feed, it.post.id, hubId('msg', acc.network, postNativeId(shown.id)), pos, JSON.stringify(it), now, !timed && !older ? 1 : 0);
      });
      const bottom = page?.more ?? null;
      const top = page?.top ?? null;
      this.db
        .query(
          `INSERT INTO feed_read (account_id, feed, top, bottom, read_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (account_id, feed) DO UPDATE SET top = COALESCE(excluded.top, feed_read.top), read_at = excluded.read_at,
             bottom = CASE WHEN ? THEN excluded.bottom WHEN feed_read.bottom IS NULL THEN excluded.bottom ELSE feed_read.bottom END`,
        )
        .run(acc.id, feed, top, bottom, now, older ? 1 : 0);
      // The oldest go past KEEP.
      this.db.query(`DELETE FROM feed_item WHERE account_id = ? AND feed = ? AND pos < (SELECT pos FROM feed_item WHERE account_id = ? AND feed = ? ORDER BY pos DESC LIMIT 1 OFFSET ?)`).run(acc.id, feed, acc.id, feed, KEEP);
    })();
    this.d.changed?.();
  }

  /** Your own recent posts, as your profile shows them on the network: logged, so Your posts holds them. */
  private async readMine(accountId: string): Promise<void> {
    const key = `${accountId}:mine`;
    const live = this.asking.get(key);
    if (live) return live;
    const p = (async () => {
      const s = this.d.store;
      const acc = s.account(accountId);
      if (!acc?.self_identity) return;
      const st = this.db.query(`SELECT read_at FROM feed_read WHERE account_id = ? AND feed = 'mine'`).get(accountId) as Row | null;
      if (st?.read_at && Date.now() - st.read_at < FRESH_MS) return;
      if (!this.d.online(accountId) || !caps(s, accountId).includes('profile')) return;
      const self = s.nativeOf('identity', acc.self_identity)?.nativeId;
      if (!self) return;
      try {
        const about = await this.d.command<P.PersonAbout>(accountId, { t: 'profile', who: self }, READ_TIMEOUT_MS);
        const posts = (about?.posts ?? []).filter((x) => !x.repostOf);
        this.d.posts.log(accountId, posts);
        this.notes.delete(key);
      } catch (e) {
        this.notes.set(key, `Could not read your posts on ${NETWORK_META[acc.network].name} · ${acc.label}: ${(e as Error).message}`);
      }
      this.db.query(`INSERT INTO feed_read (account_id, feed, read_at) VALUES (?, 'mine', ?) ON CONFLICT (account_id, feed) DO UPDATE SET read_at = excluded.read_at`).run(accountId, Date.now());
    })().finally(() => this.asking.delete(key));
    this.asking.set(key, p);
    return p;
  }

  // ------------------------------------------------------------------ the view

  /**
   * What the hub holds for a source, in its order. `before`: for Your posts, the time the page after starts below; for
   * a feed or a timeline, how many entries came before (its order is worked out afresh each time, so a swapped order
   * shows at once).
   */
  entries(source: string, before?: number): P.FeedEntriesView {
    const p = this.parse(source);
    const { lines, mine } = p;
    const named = new Set<string>();
    let entries: P.FeedEntryView[];
    let held: number | null;
    let next: number | null;
    if (p.mine) {
      entries = this.mineEntries(source, before, named);
      next = entries.length ? entries[entries.length - 1].at : (before ?? null);
      held = entries.length === VIEW_PAGE ? next : null;
    } else {
      const v = this.mixEntries(p.lines, p.order, before ?? 0, named);
      entries = v.entries;
      held = v.more ? v.next : null;
      next = v.next;
    }
    const reads = mine
      ? this.mineAccounts(source).map((a) => this.db.query(`SELECT read_at, NULL bottom FROM feed_read WHERE account_id = ? AND feed = 'mine'`).get(a) as Row | null)
      : lines.map((l) => this.db.query('SELECT read_at, bottom FROM feed_read WHERE account_id = ? AND feed = ?').get(l.accountId, l.feed) as Row | null);
    const readAt = reads.length && reads.every((r) => r?.read_at) ? Math.min(...reads.map((r) => r!.read_at as number)) : null;
    const notes: P.FeedEntriesView['notes'] = [];
    const keys = mine ? this.mineAccounts(source).map((a) => [a, `${a}:mine`]) : lines.map((l) => [l.accountId, `${l.accountId}:${l.feed}`]);
    for (const [accountId, k] of keys) {
      const n = this.notes.get(k);
      if (n) notes.push({ accountId, text: n });
    }
    for (const a of this.accounts()) if (a.self_identity) named.add(a.self_identity);
    return {
      source,
      entries,
      before: held,
      next,
      older: !mine && reads.some((r) => !!r?.bottom),
      readAt,
      notes,
      identities: this.d.store.identitiesByIds(named),
    };
  }

  /** A post as the page shows it: hub ids, signed pictures, and its counts as last logged. */
  private view(p: P.PostFact, network: P.Network, accountId: string, named: Set<string>): P.PostView {
    const s = this.d.store;
    const shown = shownOf(p);
    const m = s.one<Row>('SELECT id, extra, deleted FROM message WHERE id = ?', hubId('msg', network, postNativeId(shown.id)));
    let kept: P.PostFact | null = null;
    try {
      kept = m?.extra ? ((JSON.parse(m.extra) as { post?: P.PostFact }).post ?? null) : null;
    } catch {}
    // Counts as last logged (an act since this read shows); what you did as this account last saw it.
    const fresh = kept ? { ...shown, ...(kept.counts ? { counts: kept.counts } : {}) } : shown;
    const q = p.repostOf ? { ...p, repostOf: fresh } : fresh;
    for (const n of postAuthors(q)) named.add(hubId('idn', network, n));
    if (q.replyTo?.author) named.add(hubId('idn', network, q.replyTo.author));
    const v: P.PostView = { ...postView(withoutHiddenGuests(q), network, (u) => s.mediaUrl(u, accountId)), messageId: m && !m.deleted ? m.id : null };
    // An event's card: the people you know first, a few guests, its conversation (docs/events.md).
    return v.event ? eventDecorated(s, v, network, accountId, named) : v;
  }

  /**
   * A page of a feed's (or one timeline's) entries: what each timeline holds, put in the feed's order (mix.ts), a post
   * shown through two timelines once, from `offset` on. Each timeline gives its newest held posts, enough to fill the
   * page however its share falls; Most liked and Spread out look further back, as they rank by more than place.
   */
  private mixEntries(lines: Lines, order: MixOrder, offset: number, named: Set<string>): { entries: P.FeedEntryView[]; more: boolean; next: number } {
    if (!lines.length) return { entries: [], more: false, next: offset };
    const s = this.d.store;
    const win = order === 'liked' || order === 'spread' ? Math.max(300, offset + 2 * VIEW_PAGE) : Math.max(60, offset + 2 * VIEW_PAGE);
    const items: MixItem[] = [];
    const more: boolean[] = [];
    // Every place each post was held, for the card (which timeline's look at it) and its seenBy.
    const at = new Map<string, { line: number; row: Row; it: P.HomeItem }[]>();
    lines.forEach((l, source) => {
      const rows = this.db
        .query(
          `SELECT message_id, pos, item FROM feed_item fi WHERE account_id = ? AND feed = ?
             AND NOT EXISTS (SELECT 1 FROM message m WHERE m.id = fi.message_id AND m.deleted = 1)
           ORDER BY pos DESC LIMIT ?`,
        )
        .all(l.accountId, l.feed, win + 1) as Row[];
      const st = this.db.query('SELECT bottom FROM feed_read WHERE account_id = ? AND feed = ?').get(l.accountId, l.feed) as Row | null;
      more[source] = rows.length > win || !!st?.bottom;
      rows.slice(0, win).forEach((r, rank) => {
        let it: P.HomeItem;
        try {
          it = JSON.parse(r.item);
        } catch {
          return;
        }
        const key = r.message_id as string;
        items.push({ key, source, rank, ts: it.post.ts, ...(it.post.author ? { author: it.post.author } : {}), engagement: engagement(shownOf(it.post).counts) });
        const had = at.get(key);
        if (had) had.push({ line: source, row: r, it });
        else at.set(key, [{ line: source, row: r, it }]);
      });
    });
    const o = orderMix(items, order, lines.map((l) => l.weight), more, Date.now());
    const page = o.keys.slice(offset, offset + VIEW_PAGE);
    const out: P.FeedEntryView[] = [];
    page.forEach((key, i) => {
      const all = at.get(key)!;
      // The look of the timeline it came through; why it is there, from whichever look says (For you does).
      const first = all.find((x) => x.line === o.from[offset + i]) ?? all[0];
      const acc = s.account(lines[first.line].accountId);
      if (!acc) return;
      const it = first.it;
      const network = acc.network;
      const why = it.reason ?? all.find((x) => x.it.reason && lines[x.line].accountId === acc.id)?.it.reason;
      const reason = why ? { ...why, ...(why.who ? { who: hubId('idn', network, why.who) } : {}) } : undefined;
      if (reason?.who) named.add(reason.who);
      // What this account did to it, as it last read it (another account's like is not this one's).
      const post = this.view(it.post, network, acc.id, named);
      out.push({
        key: `${network}:${shownOf(it.post).id}`,
        network,
        post,
        ...(it.above?.length ? { above: it.above.map((a) => this.view(a, network, acc.id, named)) } : {}),
        ...(reason ? { reason } : {}),
        seenBy: [first, ...all.filter((x) => x !== first)].map((x) => ({ accountId: lines[x.line].accountId, feed: lines[x.line].feed })),
        at: it.post.ts,
      });
    });
    return { entries: out, more: o.keys.length > offset + VIEW_PAGE, next: offset + page.length };
  }

  /** Your posts: what your own identities wrote, newest first; posts made in one press as one entry with copies. */
  private mineEntries(source: string, before: number | undefined, named: Set<string>): P.FeedEntryView[] {
    const s = this.d.store;
    const accounts = this.mineAccounts(source)
      .map((id) => s.account(id))
      .filter((a): a is AccountRow => !!a?.self_identity);
    if (!accounts.length) return [];
    const selves = accounts.map((a) => a.self_identity!);
    const byIdentity = new Map(accounts.map((a) => [a.self_identity!, a]));
    const marks = selves.map(() => '?').join(',');
    // Not the rest of your own threads: a thread is its first post (the replies to yourself open with it).
    const rows = this.db
      .query(
        `SELECT m.id, m.ts, m.author_id, m.extra, m.native_id, c.network FROM message m JOIN conversation c ON c.id = m.conversation_id
         WHERE c.variant = 'posts' AND m.author_id IN (${marks}) AND m.deleted = 0 AND m.native_id LIKE 'post:%'
           ${before !== undefined ? 'AND m.ts < ?' : ''}
           AND NOT EXISTS (SELECT 1 FROM message p WHERE p.id = m.reply_to_id AND p.author_id = m.author_id)
         ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(...selves, ...(before !== undefined ? [before] : []), VIEW_PAGE * 2) as Row[];
    const groups = new Map<string, string>();
    for (const g of this.db.query(`SELECT message_id, grp FROM post_group WHERE message_id IN (${rows.map(() => '?').join(',') || "''"})`).all(...rows.map((r) => r.id)) as Row[]) groups.set(g.message_id, g.grp);
    const out: P.FeedEntryView[] = [];
    const byGroup = new Map<string, P.FeedEntryView>();
    for (const r of rows) {
      const acc = byIdentity.get(r.author_id);
      if (!acc) continue;
      let p: P.PostFact | null = null;
      try {
        p = (JSON.parse(r.extra ?? 'null') as { post?: P.PostFact } | null)?.post ?? null;
      } catch {}
      const id = postIdOf(r.native_id);
      if (!id) continue;
      p ??= { id, url: '', ts: r.ts, text: '' };
      const view = this.view(p, r.network, acc.id, named);
      const grp = groups.get(r.id);
      const had = grp ? byGroup.get(grp) : undefined;
      if (had) {
        (had.copies ??= []).push({ accountId: acc.id, post: view });
        had.seenBy.push({ accountId: acc.id, feed: 'mine' });
        continue;
      }
      const e: P.FeedEntryView = { key: `${r.network}:${id}`, network: r.network, post: view, seenBy: [{ accountId: acc.id, feed: 'mine' }], at: r.ts };
      if (grp) byGroup.set(grp, e);
      out.push(e);
      if (out.length >= VIEW_PAGE) break;
    }
    return out;
  }

  /** Like or repost as the account whose timeline showed it: its own items follow. */
  noteAct(accountId: string, network: P.Network, post: string, viewer: P.PostViewer) {
    const rows = this.db.query('SELECT rowid, item FROM feed_item WHERE account_id = ? AND message_id = ?').all(accountId, hubId('msg', network, postNativeId(post))) as Row[];
    for (const r of rows) {
      try {
        const it = JSON.parse(r.item) as P.HomeItem;
        const shown = shownOf(it.post);
        shown.viewer = { ...shown.viewer, ...viewer };
        this.db.query('UPDATE feed_item SET item = ? WHERE rowid = ?').run(JSON.stringify(it), r.rowid);
      } catch {}
    }
  }

  // ------------------------------------------------------------------ posting

  private results = new Map<string, { at: number; p: Promise<P.PublishView> }>();

  /**
   * One press of Post to several accounts (the Feed page's composer). Each destination is posted at once, side by side;
   * a thread's parts one after another, each a reply to the one before. The same `key` again within ten minutes is
   * answered with the first results; each post also has its own key, so a retry posts only what did not go.
   */
  publish(req: unknown): Promise<P.PublishView> {
    const r = (req ?? {}) as Partial<P.PublishRequest>;
    if (typeof r.key !== 'string' || !r.key || r.key.length > 100) return Promise.reject(new PostsError('key: the composer\'s id for this press', 400));
    for (const [k, v] of this.results) if (Date.now() - v.at > 10 * 60_000) this.results.delete(k);
    const had = this.results.get(r.key);
    if (had) return had.p;
    const p = this.publishNow(r);
    this.results.set(r.key, { at: Date.now(), p });
    p.catch(() => this.results.delete(r.key!));
    return p;
  }

  private async publishNow(r: Partial<P.PublishRequest>): Promise<P.PublishView> {
    const s = this.d.store;
    const dests = Array.isArray(r.destinations) ? r.destinations : [];
    if (!dests.length) throw new PostsError('Pick an account to post as.', 400);
    if (dests.length > 20) throw new PostsError('At most 20 accounts at once.', 400);
    const seen = new Set<string>();
    for (const d of dests) {
      if (!d || typeof d.accountId !== 'string' || typeof d.text !== 'string') throw new PostsError('destinations: { accountId, text, parts? }', 400);
      if (seen.has(d.accountId)) throw new PostsError('An account is picked twice.', 400);
      seen.add(d.accountId);
      if (d.parts !== undefined && (!Array.isArray(d.parts) || d.parts.length > 24 || d.parts.some((x) => typeof x !== 'string'))) throw new PostsError('parts: the rest of a thread, as texts', 400);
      for (const f of ['title', 'place', 'warning'] as const) if (d[f] !== undefined && typeof d[f] !== 'string') throw new PostsError(`${f}: text`, 400);
    }
    if (r.replies !== undefined && !REPLY_GATES.includes(r.replies)) throw new PostsError('replies: everyone, following, mentioned or verified', 400);
    const ids = Array.isArray(r.media) ? r.media.filter((x): x is string => typeof x === 'string') : [];
    const media = ids.length ? await this.d.files?.(ids) : [];
    if (ids.length && !media) throw new PostsError('A picture is gone from the hub: add it again.', 410);
    const key = r.key!;
    const results = await Promise.all(
      dests.map(async (d): Promise<P.PublishResult> => {
        const acc = s.account(d.accountId);
        if (!acc) return { accountId: d.accountId, ok: false, error: 'No such account.' };
        const texts = [d.text, ...(d.parts ?? [])];
        const made: P.PostView[] = [];
        let replyTo: string | undefined;
        for (const [i, text] of texts.entries()) {
          try {
            const v = await this.d.posts.publish(acc.network, {
              text,
              key: `${key}:${acc.id}:${i}`,
              account: acc.id,
              ...(replyTo ? { replyTo } : {}),
              // Who can reply only where the network has such a choice: X's goes, Mastodon's has none to give.
              ...(i === 0 && r.replies && postRulesFor(acc.network)?.replyGates.includes(r.replies) ? { replies: r.replies } : {}),
              ...(i === 0 && media?.length ? { media } : {}),
              // A title and a place go with the first post; a content warning with every part, as it covers the words.
              ...(i === 0 && d.title ? { title: d.title } : {}),
              ...(i === 0 && d.place ? { place: d.place } : {}),
              ...(d.warning ? { warning: d.warning } : {}),
            });
            made.push(v);
            replyTo = v.id;
          } catch (e) {
            const error = (e as Error).message;
            const unsure = e instanceof PostsError && e.status === 504;
            const done = made.length ? ` (${made.length} of ${texts.length} posted)` : '';
            return { accountId: acc.id, ok: false, error: error + done, ...(unsure ? { unsure } : {}), ...(made.length ? { post: made[0], parts: made.slice(1) } : {}) };
          }
        }
        return { accountId: acc.id, ok: true, post: made[0], parts: made.slice(1) };
      }),
    );
    // Posts made in one press are one entry in Your posts, with copies.
    const firsts = results.filter((x) => x.post?.messageId);
    if (firsts.length > 1) {
      const put = this.db.query('INSERT OR REPLACE INTO post_group (message_id, grp, account_id, at) VALUES (?, ?, ?, ?)');
      for (const x of firsts) put.run(x.post!.messageId, key, x.accountId, Date.now());
    }
    this.d.changed?.();
    return { results };
  }

  // ------------------------------------------------------------------ drafts

  drafts(): P.DraftView[] {
    return (this.db.query('SELECT * FROM post_draft ORDER BY COALESCE(scheduled_at, updated_at) DESC').all() as Row[]).map((r) => this.draftOf(r));
  }

  private draftOf(r: Row): P.DraftView {
    const b = JSON.parse(r.body) as Omit<P.DraftView, 'id' | 'updatedAt' | 'scheduledAt' | 'failed'>;
    return { ...b, id: r.id, updatedAt: r.updated_at, ...(r.scheduled_at ? { scheduledAt: r.scheduled_at } : {}), ...(r.failed ? { failed: r.failed } : {}) };
  }

  saveDraft(id: string, body: unknown): P.DraftView {
    if (!/^[\w-]{6,64}$/.test(id)) throw new PostsError('Not a draft id.', 400);
    const b = (body ?? {}) as Partial<P.DraftView>;
    const text = typeof b.text === 'string' ? b.text : '';
    if (text.length > 25_000) throw new PostsError('Too long to keep.', 413);
    const accounts = Array.isArray(b.accounts) ? b.accounts.filter((a): a is string => typeof a === 'string').slice(0, 20) : [];
    const own: Record<string, string> = {};
    if (b.own && typeof b.own === 'object') for (const [k, v] of Object.entries(b.own)) if (accounts.includes(k) && typeof v === 'string' && v.length <= 25_000) own[k] = v;
    const replies = b.replies && REPLY_GATES.includes(b.replies) ? b.replies : undefined;
    const fields: Record<string, P.PostFields> = {};
    if (b.fields && typeof b.fields === 'object')
      for (const [k, v] of Object.entries(b.fields)) {
        if (!accounts.includes(k) || !v || typeof v !== 'object') continue;
        const f: P.PostFields = {};
        for (const n of ['title', 'place', 'warning'] as const) if (typeof v[n] === 'string' && v[n]!.trim() && v[n]!.length <= 1_000) f[n] = v[n];
        if (Object.keys(f).length) fields[k] = f;
      }
    const scheduledAt = typeof b.scheduledAt === 'number' && Number.isFinite(b.scheduledAt) ? Math.round(b.scheduledAt) : null;
    if (scheduledAt !== null) {
      if (!accounts.length) throw new PostsError('Pick an account to post as before scheduling.', 400);
      if (!text.trim() && !Object.values(own).some((v) => v.trim())) throw new PostsError('Nothing to post.', 422);
      if (scheduledAt > Date.now() + 366 * 24 * 3_600_000) throw new PostsError('At most a year ahead.', 400);
    }
    const had = this.db.query('SELECT 1 FROM post_draft WHERE id = ?').get(id);
    if (!had && (this.db.query('SELECT COUNT(*) n FROM post_draft').get() as Row).n >= DRAFTS_MAX) throw new PostsError(`At most ${DRAFTS_MAX} drafts.`, 409);
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO post_draft (id, body, scheduled_at, failed, updated_at) VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT (id) DO UPDATE SET body = excluded.body, scheduled_at = excluded.scheduled_at, failed = NULL, updated_at = excluded.updated_at`,
      )
      .run(id, JSON.stringify({ text, accounts, ...(Object.keys(own).length ? { own } : {}), ...(Object.keys(fields).length ? { fields } : {}), ...(replies ? { replies } : {}) }), scheduledAt, now);
    this.d.changed?.();
    return this.draftOf(this.db.query('SELECT * FROM post_draft WHERE id = ?').get(id) as Row);
  }

  dropDraft(id: string) {
    this.db.query('DELETE FROM post_draft WHERE id = ?').run(id);
    this.d.changed?.();
  }

  /** Scheduled drafts whose time has come: posted, each destination once (the draft's id is the press's key). */
  async tick(now = Date.now()) {
    const due = this.db.query('SELECT * FROM post_draft WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? AND failed IS NULL').all(now) as Row[];
    for (const r of due) {
      const d = this.draftOf(r);
      const offline = d.accounts.filter((a) => !this.d.online(a));
      if (offline.length) {
        if (now - d.scheduledAt! > LATE_MS) this.db.query('UPDATE post_draft SET failed = ? WHERE id = ?').run(`Not posted: ${offline.map((a) => this.d.store.account(a)?.label ?? a).join(', ')} was not connected at the time.`, r.id);
        continue;
      }
      const rules = (a: string) => postRulesFor(this.d.store.account(a)?.network ?? '');
      const destinations = d.accounts.map((a): P.PublishDestination => {
        const text = d.own?.[a] ?? d.text;
        const rs = rules(a);
        const parts = rs ? splitThread(text, rs) : [text];
        return { accountId: a, text: parts[0] ?? '', ...(parts.length > 1 ? { parts: parts.slice(1) } : {}), ...d.fields?.[a] };
      });
      try {
        const v = await this.publish({ key: `draft-${r.id}`, destinations, ...(d.replies ? { replies: d.replies } : {}) });
        const failed = v.results.filter((x) => !x.ok);
        if (!failed.length) this.db.query('DELETE FROM post_draft WHERE id = ?').run(r.id);
        else this.db.query('UPDATE post_draft SET failed = ? WHERE id = ?').run(failed.map((x) => `${this.d.store.account(x.accountId)?.label ?? x.accountId}: ${x.error}`).join('; '), r.id);
      } catch (e) {
        this.db.query('UPDATE post_draft SET failed = ? WHERE id = ?').run((e as Error).message, r.id);
      }
      this.d.changed?.();
    }
  }
}

