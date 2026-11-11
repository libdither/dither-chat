/**
 * Network search (docs/search.md, "On the networks"): the networks' own search, for what the hub has not stored.
 *
 * Discord searches one server (or one DM) per request and rate-limits it, so asking every server you are in for
 * every query is out of the question. Places are put in order first: jev's P(yes) that the place talks about the
 * query (the categorizer's probe, over names, topics and channel names; keywords when jev is not there), what the
 * hub's own search found there, and how lately the place was active. The first few are asked, more on request, one
 * request at a time per account and a few seconds apart, under an hourly cap.
 *
 * Hits arrive as ordinary message facts, so whatever the hub did not have is stored like any backfill and found by
 * its own search from then on.
 */
import type * as P from '@dither-chat/protocol';
import { parseSearch } from '@dither-chat/protocol';
import { hubId, randomId } from '@dither-chat/protocol/ids';
import { type Clock, realClock, sleep } from './clock.ts';
import { markSnippet, type Store } from './store.ts';

type Row = Record<string, any>;

/** Places asked at once, and per "more". */
export const BATCH = 6;
/** Between two searches by one account. Discord's search bucket is narrow; others take more. */
export const GAP_MS: Partial<Record<P.Network, number>> = { discord: 3000 };
const GAP_DEFAULT = 1000;
/** Searches per account per hour, all queries together. */
export const HOURLY_CAP = 120;
/** How long jev may take to put places in order before the hub orders them without it. */
const RANK_WAIT_MS = 6000;
const LAND_MS = 250;
const LAND_TRIES = 12;
/** A search nobody looked at for this long is forgotten. */
const IDLE_MS = 15 * 60_000;
const DAY = 86_400_000;

type Command = (accountId: string, cmd: any, timeoutMs?: number) => Promise<any>;
type Probe = (question: string) => Promise<P.CategoryProbe>;

export interface NetSearchOptions {
  command: Command;
  online: (accountId: string) => boolean;
  /** The categorizer's probe (categorize.ts); absent: ordered by the hub's own signals alone. */
  probe?: Probe;
  log?: (msg: string) => void;
  clock?: Clock;
}

interface Place extends P.NetSearchPlace {
  /** The native scope the command takes. */
  scope: { kind: 'space' | 'conversation'; id: string } | { kind: 'all' };
  query: P.NetworkQuery;
  rank: number;
  asked: boolean;
}

interface Session {
  id: string;
  query: string;
  ranked: P.NetSearchView['ranked'];
  places: Place[];
  hits: Map<string, P.SearchHit>;
  identities: Map<string, P.IdentityView>;
  not: string[];
  terms: string[];
  oldest: boolean;
  note: string | null;
  seenAt: number;
  ready: Promise<void>;
  /** Putting places in order, before any is asked: running, though no place shows yet. */
  ordering: boolean;
}

export class NetSearch {
  private sessions = new Map<string, Session>();
  /** Per account: when it may search next, and the times of its searches this past hour. */
  private nextAt = new Map<string, number>();
  private recent = new Map<string, number[]>();
  /** Per account, its searches one after another whichever query asked. */
  private chain = new Map<string, Promise<void>>();
  private clock: Clock;
  private log: (msg: string) => void;

  constructor(
    private store: Store,
    private o: NetSearchOptions,
  ) {
    this.clock = o.clock ?? realClock;
    this.log = o.log ?? (() => {});
  }

  /** Put places in order and ask the first few. The view comes back at once; follow it with view(). */
  start(input: string): P.NetSearchView {
    this.prune();
    const q = parseSearch(input);
    const text = [...q.phrases.map((p) => `"${p}"`), ...q.terms].join(' ').trim();
    const s: Session = {
      id: randomId('nsr'),
      query: input,
      ranked: 'local',
      places: [],
      hits: new Map(),
      identities: new Map(),
      not: q.not,
      terms: [...q.phrases, ...q.terms],
      oldest: q.oldest,
      note: null,
      seenAt: this.clock.now(),
      ready: Promise.resolve(),
      ordering: false,
    };
    this.sessions.set(s.id, s);
    if (!text && !q.from.length && !q.mentions.length && !q.mentionsMe && !q.has.length) {
      s.note = 'Type some words or a filter to search the networks.';
      return this.view(s.id)!;
    }
    if (q.is.includes('deleted')) {
      s.note = 'Deleted messages are only here: the networks do not keep them.';
      return this.view(s.id)!;
    }
    const places = this.candidates(q, text, input);
    if (!places.length) {
      s.note = this.store.accounts().some((a) => this.can(a.id))
        ? 'Nothing to search on the networks for this: no place your searching accounts see matches the filters.'
        : 'None of your accounts can search its network. Discord and Matrix can.';
      return this.view(s.id)!;
    }
    s.places = places;
    s.ordering = true;
    s.ready = this.order(s, text, input)
      .then(() => this.ask(s, BATCH))
      .finally(() => (s.ordering = false));
    return this.view(s.id)!;
  }

  view(id: string): P.NetSearchView | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.seenAt = this.clock.now();
    const hits = [...s.hits.values()].sort((a, b) => (s.oldest ? a.message.ts - b.message.ts : b.message.ts - a.message.ts));
    const shown = s.places.filter((p) => p.asked);
    return {
      id: s.id,
      query: s.query,
      running: s.ordering || shown.some((p) => p.state === 'queued' || p.state === 'searching'),
      ranked: s.ranked,
      places: shown.map(({ scope: _s, query: _q, rank: _r, asked: _a, ...p }) => p),
      left: s.places.filter((p) => !p.asked).length,
      hits,
      identities: [...s.identities.values()],
      note: s.note,
    };
  }

  /** The next few places. */
  async more(id: string): Promise<P.NetSearchView | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    await s.ready;
    this.ask(s, BATCH);
    return this.view(id);
  }

  /** Wait for a search's asked places to finish (tests, scripts). */
  async settled(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.ready;
    await Promise.all([...this.chain.values()]);
  }

  // ------------------------------------------------------------------ places

  private can(accountId: string): boolean {
    const a = this.store.account(accountId);
    if (!a || !a.enabled) return false;
    try {
      return (JSON.parse(a.capabilities || '[]') as string[]).includes('search');
    } catch {
      return false;
    }
  }

  /** Native ids, on this network, of the identities whose names match. */
  private natives(names: string[], network: P.Network): string[] | null {
    if (!names.length) return [];
    const ids = names.flatMap((n) => this.store.identitiesNamed(n));
    const out = ids.length ? this.store.raw<Row>(`SELECT native_id FROM identity WHERE network = ? AND id IN (SELECT value FROM json_each(?))`, network, JSON.stringify(ids)).map((r) => r.native_id as string) : [];
    // Named someone, and nobody of that name is on this network: nothing there can match.
    return out.length ? out : null;
  }

  /** The community a conversation sits in (through its sections), or null for one in none. */
  private topSpaces(): (cid: string) => string | null {
    const parentOf = new Map<string, string>();
    for (const e of this.store.raw<Row>('SELECT parent_id, child_kind, child_id FROM space_edge')) parentOf.set(`${e.child_kind}:${e.child_id}`, e.parent_id);
    const community = new Set(this.store.raw<Row>(`SELECT id FROM space WHERE kind = 'community'`).map((r) => r.id as string));
    return (cid) => {
      const thread = this.store.one<Row>(`SELECT parent_id FROM conversation WHERE id = ? AND shape = 'thread'`, cid);
      let key = `conversation:${thread?.parent_id ?? cid}`;
      let top: string | null = null;
      for (let i = 0; i < 8; i++) {
        const p = parentOf.get(key);
        if (!p) break;
        if (community.has(p)) top = p;
        key = `space:${p}`;
      }
      return top;
    };
  }

  /** Every place an account of yours can search for this query, one per place, not yet in order. */
  private candidates(q: P.SearchQuery, text: string, input: string): Place[] {
    const accounts = this.store.accounts().filter((a) => this.can(a.id));
    const byAccount = q.account.length ? new Set(q.account.flatMap((a) => this.store.accountsNamed(a))) : null;
    const top = this.topSpaces();
    // in: narrows to the places holding those conversations, and to those conversations inside them.
    const inConvs = q.in.length ? q.in.flatMap((n) => this.store.conversationsNamed(n)) : null;
    const places = new Map<string, Place>();
    for (const acc of accounts) {
      const network = acc.network as P.Network;
      if (byAccount && !byAccount.has(acc.id)) continue;
      if (q.network.length && !q.network.includes(network)) continue;
      const authors = this.natives(q.from, network);
      const mentions = this.natives(q.mentions, network);
      if (!authors || !mentions) continue;
      if (q.mentionsMe) {
        const self = acc.self_identity ? this.store.nativeOf('identity', acc.self_identity)?.nativeId : null;
        if (self) mentions.push(self);
      }
      const base: P.NetworkQuery = {
        text,
        ...(authors.length ? { authors } : {}),
        ...(mentions.length ? { mentions } : {}),
        ...(q.has.length ? { has: q.has } : {}),
        ...(q.after !== null ? { after: q.after } : {}),
        ...(q.before !== null ? { before: q.before } : {}),
        sort: q.relevance ? 'relevance' : q.oldest ? 'oldest' : 'newest',
      };
      const add = (key: string, p: Omit<Place, 'accountId' | 'state' | 'total' | 'found' | 'fresh' | 'error' | 'score' | 'rank' | 'asked' | 'network'>) => {
        const had = places.get(key);
        // Two accounts see it: the one online asks.
        if (had && (this.o.online(had.accountId) || !this.o.online(acc.id))) return;
        places.set(key, { ...p, network, accountId: acc.id, state: 'queued', total: null, found: 0, fresh: 0, error: null, score: null, rank: 0, asked: false });
      };
      if (network !== 'discord') {
        // One request covers every room the account is in (Matrix's /search): the place is the account.
        const rooms = inConvs ? this.store.raw<Row>(`SELECT native_id FROM conversation WHERE network = ? AND id IN (SELECT value FROM json_each(?))`, network, JSON.stringify(inConvs)).map((r) => r.native_id as string) : null;
        if (rooms && !rooms.length) continue;
        add(`all:${acc.id}`, { kind: 'all', id: acc.id, name: `Everything on ${acc.label}`, scope: { kind: 'all' }, query: { ...base, ...(rooms ? { in: rooms } : {}) } });
        continue;
      }
      const seen = new Set(this.store.raw<Row>(`SELECT target_kind, target_id FROM vantage WHERE account_id = ?`, acc.id).map((r) => `${r.target_kind}:${r.target_id}`));
      // Servers: each searched whole, or only the channels in: names.
      const want = new Map<string, string[] | null>();
      if (inConvs) {
        for (const cid of inConvs) {
          const sid = top(cid);
          const c = this.store.one<Row>('SELECT native_id, shape, network FROM conversation WHERE id = ?', cid);
          if (!c || c.network !== network) continue;
          if (sid) want.set(sid, [...(want.get(sid) ?? []), c.native_id]);
          else if ((c.shape === 'direct' || c.shape === 'group') && seen.has(`conversation:${cid}`)) want.set(`c:${cid}`, null);
        }
      } else {
        for (const r of this.store.raw<Row>(`SELECT s.id FROM space s JOIN vantage v ON v.target_kind = 'space' AND v.target_id = s.id AND v.account_id = ? WHERE s.network = 'discord' AND s.kind = 'community'`, acc.id)) want.set(r.id, null);
        for (const r of this.store.raw<Row>(`SELECT c.id FROM conversation c JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = c.id AND v.account_id = ? WHERE c.network = 'discord' AND c.shape IN ('direct', 'group')`, acc.id)) want.set(`c:${r.id}`, null);
      }
      for (const [key, channels] of want) {
        if (key.startsWith('c:')) {
          const cid = key.slice(2);
          const c = this.store.one<Row>('SELECT native_id, name FROM conversation WHERE id = ?', cid);
          if (c) add(cid, { kind: 'conversation', id: cid, name: c.name ?? this.directName(cid), scope: { kind: 'conversation', id: c.native_id }, query: base });
          continue;
        }
        const sp = this.store.one<Row>('SELECT native_id, name FROM space WHERE id = ?', key);
        if (sp) add(key, { kind: 'space', id: key, name: sp.name, scope: { kind: 'space', id: sp.native_id }, query: { ...base, ...(channels ? { in: channels } : {}) } });
      }
    }
    void input;
    return [...places.values()];
  }

  private directName(cid: string): string {
    const r = this.store.one<Row>(
      `SELECT GROUP_CONCAT(COALESCE(i.display_name, i.handle, i.native_id), ', ') AS n FROM participant p JOIN identity i ON i.id = p.identity_id
       WHERE p.conversation_id = ? AND i.id NOT IN (SELECT self_identity FROM account WHERE self_identity IS NOT NULL)`,
      cid,
    );
    return r?.n || 'A direct message';
  }

  /**
   * Places in order: jev's word on each (what it was asked to judge is names, topics and channel names, never
   * messages), what the hub's own search found there, and how lately it was active.
   */
  private async order(s: Session, text: string, input: string) {
    const top = this.topSpaces();
    const now = this.clock.now();
    // The hub's own hits, by place.
    const local = new Map<string, number>();
    try {
      for (const h of this.store.search(input, 100).hits) {
        const cid = h.message.conversationId;
        const key = top(cid) ?? cid;
        local.set(key, (local.get(key) ?? 0) + 1);
      }
    } catch {
      /* a query the local search refuses still searches the networks */
    }
    const maxLocal = Math.max(1, ...local.values());
    // How lately each place had a message.
    const lately = new Map<string, number>();
    for (const r of this.store.raw<Row>('SELECT id, last_message_at FROM conversation WHERE last_message_at IS NOT NULL')) {
      const key = top(r.id) ?? r.id;
      lately.set(key, Math.max(lately.get(key) ?? 0, r.last_message_at));
    }
    let jev = new Map<string, number>();
    if (text && this.o.probe) {
      const probe = this.o.probe(`Would people here talk about ${text}?`);
      const timeout = new Promise<null>((r) => this.clock.setTimeout(() => r(null), RANK_WAIT_MS));
      const p = await Promise.race([probe.catch(() => null), timeout]);
      if (p) {
        jev = new Map(p.scores.map((x) => [x.id, x.p]));
        s.ranked = p.provider === 'jev' ? 'jev' : 'keyword';
      }
    }
    for (const p of s.places) {
      const key = p.kind === 'all' ? null : p.id;
      const j = key ? (jev.get(key) ?? null) : null;
      const l = key ? (local.get(key) ?? 0) / maxLocal : 0.5;
      const last = key ? (lately.get(key) ?? 0) : now;
      const recency = Math.exp(-(now - last) / (30 * DAY));
      p.score = j;
      // A place jev did not judge (a DM, a network searched whole) stands on the other two, with a middling prior.
      p.rank = 0.6 * (j ?? (p.kind === 'all' ? 0.6 : 0.15)) + 0.3 * l + 0.1 * recency;
    }
    s.places.sort((a, b) => b.rank - a.rank);
  }

  // ------------------------------------------------------------------ asking

  private ask(s: Session, n: number) {
    for (const p of s.places.filter((x) => !x.asked).slice(0, n)) {
      p.asked = true;
      const prev = this.chain.get(p.accountId) ?? Promise.resolve();
      const next = prev.then(() => this.one(s, p)).catch((e) => this.log(`network search ${p.accountId}: ${e?.message ?? e}`));
      this.chain.set(p.accountId, next);
    }
  }

  private async one(s: Session, p: Place) {
    if (!this.sessions.has(s.id)) return;
    if (!this.o.online(p.accountId)) {
      p.state = 'failed';
      p.error = 'The account is offline.';
      return;
    }
    const now = this.clock.now();
    const recent = (this.recent.get(p.accountId) ?? []).filter((t) => t > now - 3_600_000);
    this.recent.set(p.accountId, recent);
    if (recent.length >= HOURLY_CAP) {
      p.state = 'failed';
      p.error = `Held back: ${HOURLY_CAP} searches this past hour on this account.`;
      return;
    }
    const wait = (this.nextAt.get(p.accountId) ?? 0) - now;
    if (wait > 0) await sleep(this.clock, wait);
    p.state = 'searching';
    try {
      for (let attempt = 0; ; attempt++) {
        const at = this.clock.now();
        this.recent.get(p.accountId)!.push(at);
        this.nextAt.set(p.accountId, at + (GAP_MS[p.network] ?? GAP_DEFAULT));
        const before = (this.store.one<Row>('SELECT MAX(rowid) AS r FROM message')?.r as number | null) ?? 0;
        const r = (await this.o.command(p.accountId, { t: 'search', scope: p.scope, query: p.query, limit: 25 }, 60_000)) as P.NetworkSearchResult | null;
        if (r?.retryAfterMs && attempt === 0) {
          // Discord is still indexing the place: once more, after it said to.
          await sleep(this.clock, Math.min(r.retryAfterMs, 15_000));
          continue;
        }
        await this.take(s, p, r, before);
        break;
      }
      p.state = 'done';
    } catch (e: any) {
      p.state = 'failed';
      p.error = String(e?.message ?? e).slice(0, 200);
    }
  }

  /** The hits as the hub now holds them, each once, without the words the query left out. */
  private async take(s: Session, p: Place, r: P.NetworkSearchResult | null, rowidBefore: number) {
    const ids = [...new Set((r?.hits ?? []).filter((x) => typeof x === 'string'))].map((n) => hubId('msg', p.network, n));
    p.total = typeof r?.total === 'number' ? r.total : null;
    const rows = () => (ids.length ? this.store.raw<Row>(`SELECT *, rowid AS rid FROM message WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)) : []);
    let got = rows();
    // Facts from a remote account may land just after the answer.
    for (let i = 0; i < LAND_TRIES && got.length < ids.length; i++) {
      await sleep(this.clock, LAND_MS);
      got = rows();
    }
    const not = s.not.map((t) => t.toLowerCase());
    got = got.filter((m) => !m.deleted && !not.some((t) => String(m.body ?? '').toLowerCase().includes(t)));
    const views = this.store.messageViews(got);
    const fresh = new Set(got.filter((m) => m.rid > rowidBefore).map((m) => m.id as string));
    for (const v of views) {
      if (s.hits.has(v.id)) continue;
      s.hits.set(v.id, { message: v, snippet: markSnippet(v.body ?? '', s.terms) });
    }
    for (const i of this.store.identitiesOf(views)) s.identities.set(i.id, i);
    p.found = views.length;
    p.fresh = views.filter((v) => fresh.has(v.id)).length;
  }

  private prune() {
    const now = this.clock.now();
    for (const [id, s] of this.sessions) if (now - s.seenAt > IDLE_MS) this.sessions.delete(id);
  }
}
