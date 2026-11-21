/**
 * Catching up (docs/catch-up.md): the hub notices it may be missing messages, works out where, fetches them through
 * the account's own history at the reading pace, and keeps track of each hole until it is filled, found whole, or
 * known to need another source.
 *
 * Reports come from what the hub sees (EventWatch, called by the supervisor), from adapters (a `gap` event), from
 * the network (a chat's `lastMessageAt` newer than anything held), and from people and scripts
 * (`POST /api/catch-up/report`). Each lands in a hole: a stretch of time across an account's chats (scope `account`),
 * or one chat (`chat`). Reports a few minutes apart about the same account or chat merge into one hole.
 *
 * A hole is planned a minute after its first report, so the reports of one trouble merge first. Its account's chats
 * are ranked by how many messages each was likely to get in the stretch (its pace in the two weeks before), direct
 * chats and groups first, and channels you never read left out (you can ask for them). A hole whose cause only makes
 * a loss possible (an account offline for a while: most networks replay what it missed) checks its three likeliest
 * chats first; when they are whole, the hole is clear and nothing more is fetched. When chat holes on one account turn
 * out to miss messages around the same time, the trouble was the account's, not the chats': the account's other
 * chats are checked for that time too (`nearby`).
 *
 * A chat is paged back from the end of the stretch to its start, 50 messages a page, jumping over what is known whole
 * (history_span, shared with the index jobs), and each page is recorded there. One reader per account at a time
 * through the shared reading pace (readingpace.ts). An account that cannot fetch history (Signal keeps none on its
 * servers) leaves its holes `unfetchable`, with the chats that likely had messages, for an import to fill.
 *
 * Its state is in catchup_hole and catchup_task, and in meta (catchup:*) for what it must remember across a restart:
 * when it last heard each account, since when the manager was away, an account offline since, and events that waited
 * to be applied.
 */
import type * as P from '@dither-chat/protocol';
import { hubId, randomId } from '@dither-chat/protocol/ids';
import { type Clock, realClock, sleep, unref } from './clock.ts';
import { jobFailed } from './errors.ts';
import { addSpan, spanAt } from './historyspan.ts';
import { READING, ReadingPace } from './readingpace.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Messages a page: what Discord's client loads when you scroll up. */
export const PAGE = 50;
/** The pace's name for this reader (readingpace.ts: one reader per account). */
const READER = 'catchup';
/** How often it looks for work, plans holes that are due and turns what it heard into reports. */
const TICK_MS = 5000;
/** Reports this close to an open hole's stretch join it. */
const MERGE_MS = 30 * MIN;
/** A hole is planned this long after its first report (a person's report: at once). */
export const PLAN_DELAY_MS = MIN;
/** The longest stretch a hole looks at; further back is the index jobs' business. */
const MAX_STRETCH_MS = 14 * DAY;
/** How far back a chat's pace is measured, to guess how many messages it had in a stretch. */
const RATE_MS = 14 * DAY;
/** A chat you opened here, or read on the network, this recently is one you read. */
const READ_RECENTLY_MS = 30 * DAY;
/** Direct chats and groups with a message this recently are checked, however quiet. */
const DIRECT_RECENT_MS = 90 * DAY;
/** Channels expected to have had fewer messages than this in the stretch are left out. */
const MIN_EXPECTED = 0.3;
/** Chats one hole plans at most; the rest wait until you ask for them. */
const MAX_CHATS = 60;
/** How many chats a `possible` hole checks first. */
const PROBES = 3;
/** Pages one chat of one hole fetches at most: 3,000 messages, a day's reading. */
const MAX_PAGES = 60;
/** An account offline this long opens a hole when it is back. */
export const OFFLINE_MIN_MS = 2 * MIN;
/** A network's claim about a chat waits this long: the messages it names often come right after it. */
export const CLAIM_SETTLE_MS = 2 * MIN;
/** A claim must be this much newer than the newest message held (clocks differ, seconds get rounded). */
const CLAIM_SLACK_MS = 2000;
/** A chat with nothing held this recently is not followed: a claim about it is a chat never fetched, not a hole. */
const FOLLOWED_MS = 30 * DAY;
/** Chat holes on one account that found messages, this many close in time: the account's other chats are checked. */
const NEARBY = 3;
/** Finished holes are kept this long. */
const KEEP_MS = 30 * DAY;
/** What it remembers across a restart is saved at most this often. */
const SAVE_MS = MIN;
/** A wait for the pace is slept in steps this long at most, so a stop or an account going offline tells soon. */
const REST_STEP_MS = MIN;
/** An adapter that cannot read just now (deferMs) is asked again after at most this long. */
const DEFER_MAX_MS = 10 * MIN;
/** A page's messages may land just after its answer (remote accounts): looked for this often, this many times. */
const LAND_MS = 500;
const LAND_TRIES = 6;
/** Channels whose own history holds nothing: their posts are threads. */
const NO_MESSAGES = new Set(['forum', 'media']);
const STRENGTH: Record<P.CatchUpStrength, number> = { possible: 0, likely: 1, sure: 2 };
const OPEN = `('planning', 'checking', 'fetching')`;

/** What the supervisor tells it as events come and go (supervisor.ts). Called inside a write: memory only. */
export interface EventWatch {
  /** Events of this account were applied. */
  heard(accountId: string): void;
  /** Events wait in the supervisor's queue rather than being applied at once. */
  queued(accountId: string, events: readonly P.AdapterEvent[]): void;
  /** Events that could not be applied and are gone. */
  lost(accountId: string, events: readonly P.AdapterEvent[], why: string): void;
  /** The adapter's `gap` event. */
  gap(accountId: string, ev: Extract<P.AdapterEvent, { t: 'gap' }>): void;
  /** A conversation fact, after it is stored. */
  conversation(accountId: string, c: P.ConversationFact): void;
  /** dither-accounts' manager dropped events it held for the hub (remote.ts). */
  dropped(accountId: string, count: number): void;
  /** The manager's connection went down or came back (remote.ts). */
  connection(up: boolean): void;
}

interface Report {
  scope: 'account' | 'chat';
  accountId?: string;
  conversationId?: string | null;
  from: number;
  to?: number;
  strength: P.CatchUpStrength;
  cause: P.CatchUpCause;
  note: string;
}

interface Options {
  command: (accountId: string, cmd: any, timeoutMs?: number) => Promise<any>;
  /** The account's adapter is connected. */
  online: (accountId: string) => boolean;
  /** Events waiting in the supervisor's queue (Supervisor.backlog). */
  backlog?: () => number;
  /** Shared with the index jobs and the gap fill: one reader per account. */
  pace?: ReadingPace;
  clock?: Clock;
  log?: (msg: string) => void;
}

/** The waiting events' marker in meta: set while events wait, so a start after a crash knows what may be lost. */
interface Backlog {
  since: number;
  /** Last saved: the crash came after this. */
  at: number;
  /** Per account, the oldest message among the waiting events (null: none was a message). */
  accounts: Record<string, number | null>;
  /** A clean stop that could not save what waited (Supervisor.settle). */
  lostAtStop?: number;
}

const hm = (ms: number) => {
  const m = Math.round(ms / MIN);
  return m < 90 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
};
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

export class CatchUp implements EventWatch {
  private clock: Clock;
  private log: (msg: string) => void;
  readonly pace: ReadingPace;
  private timer: unknown = null;
  private stopped = true;
  /** Accounts fetching now, and on which chat; `resting` while it waits for the pace. */
  private working = new Map<string, { holeId: string; cid: string; resting?: boolean }>();

  // What the supervisor told it, turned into reports on the next tick (never inside its write).
  private lastHeard = new Map<string, number>();
  private heardSaved = 0;
  private reports: Report[] = [];
  private lostIds = new Map<string, number>();
  private claims = new Map<string, { accountId: string; ts: number; at: number }>();
  private networks = new Map<string, P.Network>();
  private backlog: Backlog | null = null;
  private backlogSaved = 0;
  /** Since when the manager has been out of reach (or the hub stopped); kept a while after it is back, for its gaps. */
  private awaySince: number | null = null;
  private backAt: number | null = null;
  /** Account up or not at the last look; offline since when. */
  private up = new Map<string, boolean>();
  private offlineSince = new Map<string, number>();
  private lastSweep = 0;

  constructor(
    private store: Store,
    private o: Options,
  ) {
    this.clock = o.clock ?? realClock;
    this.log = o.log ?? (() => {});
    this.pace = o.pace ?? new ReadingPace(store, READING, this.clock);
    this.lastHeard = new Map(Object.entries(this.meta<Record<string, number>>('catchup:heard') ?? {}));
    this.offlineSince = new Map(Object.entries(this.meta<Record<string, number>>('catchup:offline') ?? {}));
    this.awaySince = this.meta<number>('catchup:away');
  }

  /**
   * Starts looking. `unclean`: the hub did not stop cleanly last time (journal.ts), so events that waited to be
   * applied then are gone.
   */
  start(o: { unclean?: boolean } = {}) {
    const marker = this.meta<Backlog>('catchup:backlog');
    if (marker && (o.unclean || marker.lostAtStop)) {
      const accounts = Object.keys(marker.accounts);
      const to = marker.at + 2 * TICK_MS;
      for (const acc of accounts) {
        const oldest = marker.accounts[acc];
        this.reports.push({
          scope: 'account',
          accountId: acc,
          from: Math.min(oldest ?? marker.since, marker.since) - MIN,
          to,
          strength: 'sure',
          cause: 'lost',
          note: marker.lostAtStop ? `The hub stopped and could not save ${plural(marker.lostAtStop, 'event')} that waited to be applied` : 'The hub stopped without warning while events waited to be applied',
        });
      }
    }
    if (marker) this.setMeta('catchup:backlog', null);
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      try {
        this.tick();
      } catch (e) {
        console.error('catch-up: tick failed', e);
        jobFailed('catch-up: tick', e);
      }
      this.timer = this.clock.setTimeout(loop, TICK_MS);
      unref(this.timer);
    };
    loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * The hub is stopping (main.ts), after the supervisor settled: what it heard is saved, the manager counts as away
   * from now, and the waiting events' marker goes unless some were lost.
   */
  stopping(lost = 0) {
    this.saveHeard(true);
    if (this.awaySince === null) this.setMeta('catchup:away', this.clock.now());
    if (lost > 0 && this.backlog) this.setMeta('catchup:backlog', { ...this.backlog, at: this.clock.now(), lostAtStop: lost });
    else if (lost > 0) this.setMeta('catchup:backlog', { since: this.clock.now(), at: this.clock.now(), accounts: {}, lostAtStop: lost });
    else this.setMeta('catchup:backlog', null);
  }

  // ------------------------------------------------------------------ what the supervisor tells it

  heard(accountId: string) {
    this.lastHeard.set(accountId, this.clock.now());
  }

  queued(accountId: string, events: readonly P.AdapterEvent[]) {
    const now = this.clock.now();
    const first = !this.backlog;
    this.backlog ??= { since: now, at: now, accounts: {} };
    let oldest = this.backlog.accounts[accountId] ?? null;
    for (const e of events) if (e.t === 'message' && typeof e.message.ts === 'number') oldest = oldest === null ? e.message.ts : Math.min(oldest, e.message.ts);
    this.backlog.accounts[accountId] = oldest;
    // At once the first time, so a crash right after knows; then with the tick.
    if (first) this.saveBacklog(now);
  }

  lost(accountId: string, events: readonly P.AdapterEvent[], why: string) {
    const network = this.networkOf(accountId);
    if (!network) return;
    const now = this.clock.now();
    for (const e of events) {
      if (e.t !== 'message') continue;
      // A message that fails each time it comes (a bug) is reported once a day, not fetched over and over.
      const key = `${accountId}:${e.message.nativeId}`;
      if ((this.lostIds.get(key) ?? 0) > now - DAY) continue;
      this.lostIds.set(key, now);
      this.reports.push({ scope: 'chat', accountId, conversationId: hubId('cnv', network, e.message.conversation), from: e.message.ts - 1, to: e.message.ts + 1, strength: 'sure', cause: 'lost', note: `A message could not be stored: ${why}` });
    }
  }

  gap(accountId: string, ev: Extract<P.AdapterEvent, { t: 'gap' }>) {
    const network = this.networkOf(accountId);
    if (!network || typeof ev.from !== 'number') return;
    const note = ev.note ? `The account says it may have missed messages: ${ev.note}` : 'The account says it may have missed messages';
    if (ev.conversations?.length) {
      for (const c of ev.conversations.slice(0, MAX_CHATS)) this.reports.push({ scope: 'chat', accountId, conversationId: hubId('cnv', network, c), from: ev.from, to: ev.to, strength: 'likely', cause: 'adapter', note });
    } else this.reports.push({ scope: 'account', accountId, from: ev.from, to: ev.to, strength: 'likely', cause: 'adapter', note });
  }

  conversation(accountId: string, c: P.ConversationFact) {
    if (typeof c.lastMessageAt !== 'number' || !Number.isFinite(c.lastMessageAt)) return;
    const network = this.networkOf(accountId);
    if (!network) return;
    const cid = hubId('cnv', network, c.nativeId);
    const had = this.claims.get(cid);
    if (had && had.ts >= c.lastMessageAt) return;
    this.claims.set(cid, { accountId, ts: c.lastMessageAt, at: this.clock.now() });
  }

  /** The manager dropped events it held for this account (remote.ts onGap): everything since the hub was away. */
  dropped(accountId: string, count: number) {
    const now = this.clock.now();
    const recentlyBack = this.backAt !== null && now - this.backAt < 5 * MIN;
    const from = (recentlyBack || this.backAt === null) && this.awaySince !== null ? this.awaySince : (this.lastHeard.get(accountId) ?? now - HOUR);
    this.reports.push({ scope: 'account', accountId, from: from - MIN, to: now, strength: 'sure', cause: 'dropped', note: `dither-accounts dropped ${plural(count, 'event')} it held for the hub` });
  }

  /** The manager's connection went down or came back (remote.ts onConnection). */
  connection(up: boolean) {
    const now = this.clock.now();
    if (!up) {
      if (this.awaySince === null || this.backAt !== null) {
        this.awaySince = now;
        this.backAt = null;
        this.setMeta('catchup:away', now);
      }
      return;
    }
    this.backAt = now;
  }

  // ------------------------------------------------------------------ the API

  /** POST /api/catch-up/report. */
  reportFrom(r: P.CatchUpReport): P.CatchUpHoleView {
    if (typeof r?.from !== 'number' || !Number.isFinite(r.from)) throw new Error('from when? `from` is a time in ms');
    if (r.to !== undefined && (typeof r.to !== 'number' || !Number.isFinite(r.to))) throw new Error('`to` is a time in ms');
    if (!r.accountId && !r.conversationId) throw new Error('which account or chat?');
    if (r.strength !== undefined && !(r.strength in STRENGTH)) throw new Error('strength is possible, likely or sure');
    const id = this.report({
      scope: r.conversationId ? 'chat' : 'account',
      accountId: r.accountId,
      conversationId: r.conversationId ?? null,
      from: r.from,
      to: r.to,
      strength: r.strength ?? 'likely',
      cause: 'report',
      note: typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, 200) : 'Reported',
    });
    if (!id) throw new Error(r.conversationId ? 'no such chat, or no account sees it' : 'no such account');
    return this.get(id)!;
  }

  list(): P.CatchUpHoleView[] {
    return this.store.raw<Row>('SELECT * FROM catchup_hole ORDER BY created_at DESC LIMIT 100').map((h) => this.view(h));
  }

  get(id: string): P.CatchUpHoleView | null {
    const h = this.store.one<Row>('SELECT * FROM catchup_hole WHERE id = ?', id);
    return h ? this.view(h, true) : null;
  }

  /** Stops a hole: what it has not fetched stays unfetched. */
  stopHole(id: string): P.CatchUpHoleView | null {
    const now = this.clock.now();
    this.store.db.query(`UPDATE catchup_hole SET state = 'stopped', updated_at = ? WHERE id = ? AND state IN ${OPEN}`).run(now, id);
    this.store.db.query(`UPDATE catchup_task SET state = 'skipped', why = 'stopped', updated_at = ? WHERE hole_id = ? AND state = 'queued'`).run(now, id);
    return this.get(id);
  }

  /** Plans the hole again with the chats it left out, and fetches them. */
  allChats(id: string): P.CatchUpHoleView | null {
    const h = this.store.one<Row>('SELECT * FROM catchup_hole WHERE id = ?', id);
    if (!h) return null;
    if (h.state === 'unfetchable') return this.get(id);
    const now = this.clock.now();
    // Asked by a person: whatever the first chats showed, every chat is fetched.
    const strength = STRENGTH[h.strength as P.CatchUpStrength] < STRENGTH.likely ? 'likely' : h.strength;
    this.store.db.query(`UPDATE catchup_hole SET all_chats = 1, strength = ?, state = 'planning', plan_at = ?, updated_at = ? WHERE id = ?`).run(strength, now, now, id);
    this.store.db.query(`UPDATE catchup_task SET state = 'queued', updated_at = ? WHERE hole_id = ? AND state = 'skipped'`).run(now, id);
    this.tick();
    return this.get(id);
  }

  remove(id: string): boolean {
    this.store.db.query('DELETE FROM catchup_task WHERE hole_id = ?').run(id);
    return this.store.db.query('DELETE FROM catchup_hole WHERE id = ?').run(id).changes > 0;
  }

  // ------------------------------------------------------------------ reports into holes

  /** A report: into the open hole it is close to, or a new one. The hole's id; null if it names nothing known. */
  report(r: Report): string | null {
    const now = this.clock.now();
    const to = Math.min(typeof r.to === 'number' ? r.to : now, now);
    let from = Math.max(r.from, to - MAX_STRETCH_MS);
    if (from >= to) from = to - 1;
    let accountId = r.accountId ?? null;
    const cid = r.scope === 'chat' ? (r.conversationId ?? null) : null;
    if (r.scope === 'chat') {
      if (!cid || !this.store.one('SELECT 1 FROM conversation WHERE id = ?', cid)) return null;
      if (!accountId || !this.store.vantageAccounts('conversation', cid).includes(accountId)) accountId = this.accountFor(cid);
    }
    if (!accountId || !this.store.account(accountId)) return null;
    const open = this.store.one<Row>(
      `SELECT * FROM catchup_hole WHERE scope = ? AND account_id = ? AND conversation_id IS ? AND state IN ${OPEN} AND from_ts <= ? AND to_ts >= ?
       ORDER BY created_at LIMIT 1`,
      r.scope,
      accountId,
      cid,
      to + MERGE_MS,
      from - MERGE_MS,
    );
    if (open) {
      const causes = JSON.parse(open.causes) as P.CatchUpCause[];
      const notes = JSON.parse(open.notes) as string[];
      if (!causes.includes(r.cause)) causes.push(r.cause);
      if (notes[notes.length - 1] !== r.note) notes.push(r.note);
      const lo = Math.min(open.from_ts, from);
      const hi = Math.max(open.to_ts, to);
      const strength = STRENGTH[r.strength] > STRENGTH[open.strength as P.CatchUpStrength] ? r.strength : open.strength;
      // A wider stretch, or a surer cause, plans it again (what was fetched stays fetched: the spans skip it).
      const replan = open.state !== 'planning' && (lo < open.from_ts || hi > open.to_ts || strength !== open.strength);
      this.store.db
        .query('UPDATE catchup_hole SET from_ts = ?, to_ts = ?, strength = ?, causes = ?, notes = ?, updated_at = ? WHERE id = ?')
        .run(lo, hi, strength, JSON.stringify(causes), JSON.stringify(notes.slice(-20)), now, open.id);
      if (replan) this.store.db.query(`UPDATE catchup_hole SET state = 'planning', plan_at = ? WHERE id = ?`).run(now, open.id);
      return open.id;
    }
    const id = randomId('cup');
    this.store.db
      .query(`INSERT INTO catchup_hole (id, scope, account_id, conversation_id, from_ts, to_ts, strength, causes, notes, state, plan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?)`)
      .run(id, r.scope, accountId, cid, from, to, r.strength, JSON.stringify([r.cause]), JSON.stringify([r.note]), r.cause === 'report' ? now : now + PLAN_DELAY_MS, now, now);
    this.log(`catch-up: ${r.cause} ${r.scope} ${cid ?? accountId} ${new Date(from).toISOString()}..${new Date(to).toISOString()}`);
    return id;
  }

  // ------------------------------------------------------------------ the loop

  tick() {
    const now = this.clock.now();
    this.takeReports();
    this.watchAccounts(now);
    this.settleClaims(now);
    this.keepBacklog(now);
    this.saveHeard(false);
    if (this.backAt !== null && now - this.backAt > 5 * MIN) {
      this.awaySince = null;
      this.backAt = null;
      this.setMeta('catchup:away', null);
    }
    for (const h of this.store.raw<Row>(`SELECT * FROM catchup_hole WHERE state = 'planning' AND plan_at <= ?`, now)) this.plan(h);
    if (now - this.lastSweep > HOUR) {
      this.lastSweep = now;
      const old = this.store.raw<Row>(`SELECT id FROM catchup_hole WHERE state NOT IN ${OPEN} AND updated_at < ?`, now - KEEP_MS);
      for (const h of old) this.remove(h.id);
      for (const [k, at] of this.lostIds) if (at < now - DAY) this.lostIds.delete(k);
    }
    if (this.stopped) return;
    const accounts = this.store.raw<Row>(`SELECT DISTINCT t.account_id FROM catchup_task t JOIN catchup_hole h ON h.id = t.hole_id WHERE t.state = 'queued' AND h.state IN ('checking', 'fetching')`);
    for (const a of accounts) if (!this.working.has(a.account_id) && this.o.online(a.account_id)) void this.work(a.account_id);
  }

  private takeReports() {
    const reports = this.reports;
    this.reports = [];
    for (const r of reports) this.report(r);
  }

  /** Accounts that went offline and came back: a hole for the time between, when it was long enough to matter. */
  private watchAccounts(now: number) {
    let changed = false;
    for (const a of this.store.accounts()) {
      if (!a.enabled || a.network === 'calendar') continue;
      const up = this.o.online(a.id) && a.status === 'online';
      const was = this.up.get(a.id);
      this.up.set(a.id, up);
      if (was === undefined && !up) continue;
      if (was !== false && !up) {
        this.offlineSince.set(a.id, now);
        changed = true;
        continue;
      }
      if (!up) continue;
      const since = this.offlineSince.get(a.id);
      if (since === undefined) continue;
      this.offlineSince.delete(a.id);
      changed = true;
      if (now - since >= OFFLINE_MIN_MS) this.report({ scope: 'account', accountId: a.id, from: since - MIN, to: now, strength: 'possible', cause: 'offline', note: `The account was offline for ${hm(now - since)}` });
    }
    for (const id of this.offlineSince.keys())
      if (!this.store.account(id)) {
        this.offlineSince.delete(id);
        changed = true;
      }
    if (changed) this.setMeta('catchup:offline', this.offlineSince.size ? Object.fromEntries(this.offlineSince) : null);
  }

  /** The network says a chat's newest message is newer than any the hub holds: a chat hole, once per claim. */
  private settleClaims(now: number) {
    for (const [cid, c] of this.claims) {
      if (now - c.at < CLAIM_SETTLE_MS) continue;
      this.claims.delete(cid);
      if (c.ts > now + 5 * MIN || c.ts < now - MAX_STRETCH_MS) continue;
      const seen = this.store.one<Row>('SELECT ts FROM catchup_claim WHERE conversation_id = ?', cid)?.ts as number | undefined;
      if (seen !== undefined && c.ts <= seen) continue;
      const newest = this.newest(cid);
      if (newest === null || newest < now - FOLLOWED_MS || c.ts <= newest + CLAIM_SLACK_MS) continue;
      this.store.db.query('INSERT INTO catchup_claim (conversation_id, ts) VALUES (?, ?) ON CONFLICT (conversation_id) DO UPDATE SET ts = MAX(ts, excluded.ts)').run(cid, c.ts);
      // A chat whose newest message is one the hub does not keep (a join, a pin, a call) claims more than it has
      // every time: after two checks that found nothing, its claims rest a week.
      const checks = this.store.raw<Row>(
        `SELECT (SELECT COALESCE(SUM(found), 0) FROM catchup_task t WHERE t.hole_id = h.id) AS found FROM catchup_hole h
         WHERE h.scope = 'chat' AND h.conversation_id = ? AND h.causes = '["behind"]' AND h.state IN ('done', 'clear') AND h.created_at >= ? ORDER BY h.created_at DESC LIMIT 2`,
        cid,
        now - 7 * DAY,
      );
      if (checks.length === 2 && checks.every((x) => !x.found)) continue;
      this.report({ scope: 'chat', accountId: c.accountId, conversationId: cid, from: newest, to: c.ts + 1, strength: 'likely', cause: 'behind', note: 'The network has newer messages here than the hub' });
    }
  }

  private newest(cid: string): number | null {
    return (this.store.one<Row>('SELECT MAX(ts) AS t FROM message WHERE conversation_id = ?', cid)?.t as number | null) ?? null;
  }

  private keepBacklog(now: number) {
    if (!this.backlog) return;
    if ((this.o.backlog?.() ?? 0) === 0) {
      this.backlog = null;
      this.setMeta('catchup:backlog', null);
      return;
    }
    if (now - this.backlogSaved >= TICK_MS) this.saveBacklog(now);
  }

  private saveBacklog(now: number) {
    if (!this.backlog) return;
    this.backlog.at = now;
    this.backlogSaved = now;
    this.setMeta('catchup:backlog', this.backlog);
  }

  private saveHeard(force: boolean) {
    const now = this.clock.now();
    if (!force && now - this.heardSaved < SAVE_MS) return;
    this.heardSaved = now;
    if (this.lastHeard.size) this.setMeta('catchup:heard', Object.fromEntries(this.lastHeard));
  }

  // ------------------------------------------------------------------ planning

  /** The account to fetch a chat through: one that sees it and can fetch, online first; or any that sees it. */
  private accountFor(cid: string): string | null {
    const seen = this.store.vantageAccounts('conversation', cid);
    const able = seen.filter((a) => this.can(a, 'history'));
    return able.find((a) => this.o.online(a)) ?? able[0] ?? seen[0] ?? null;
  }

  private can(accountId: string, capability: P.Capability): boolean {
    const a = this.store.account(accountId);
    if (!a || !a.enabled) return false;
    try {
      return (JSON.parse(a.capabilities || '[]') as string[]).includes(capability);
    } catch {
      return false;
    }
  }

  /** Which chats, in what order, and why; which first when the hole only checks. */
  private plan(h: Row) {
    const now = this.clock.now();
    const acc = this.store.account(h.account_id);
    if (!acc) {
      this.remove(h.id);
      return;
    }
    const from = h.from_ts as number;
    const to = h.to_ts as number;
    const all = !!h.all_chats;
    const causes = JSON.parse(h.causes) as P.CatchUpCause[];
    // Someone said so, or a message was lost there: the chat is fetched whatever it looks like.
    const named = causes.some((c) => c === 'report' || c === 'lost' || c === 'adapter');
    const convs =
      h.scope === 'chat'
        ? this.store.raw<Row>('SELECT id, shape, variant, name, archived FROM conversation WHERE id = ?', h.conversation_id)
        : this.store.raw<Row>(
            `SELECT c.id, c.shape, c.variant, c.name, c.archived FROM conversation c
             JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = c.id AND v.account_id = ?
             WHERE c.shape IN ('direct', 'group', 'channel', 'thread') AND c.archived = 0`,
            h.account_id,
          );
    const countIn = this.store.db.query('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND ts >= ? AND ts < ?');
    const visited = this.store.db.query(`SELECT last_visit FROM place_usage WHERE kind = 'conversation' AND id = ?`);
    const readOn = this.store.db.query(`SELECT MAX(last_read_ts) AS t FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`);
    const left = new Map<string, number>();
    const leave = (why: string) => left.set(why, (left.get(why) ?? 0) + 1);
    const picked: { id: string; expected: number; score: number; why: string; direct: boolean }[] = [];
    for (const c of convs) {
      if (NO_MESSAGES.has(c.variant)) continue;
      const before = (countIn.get(c.id, from - RATE_MS, from) as Row).n as number;
      const expected = (before / RATE_MS) * (to - from);
      const direct = c.shape === 'direct' || c.shape === 'group';
      const lastVisit = ((visited.get(c.id) as Row | null)?.last_visit as number | null) ?? 0;
      const lastRead = ((readOn.get(c.id) as Row | null)?.t as number | null) ?? 0;
      const read = Math.max(lastVisit, lastRead) >= now - READ_RECENTLY_MS;
      if (h.scope === 'account' && !all) {
        if (direct && expected < MIN_EXPECTED && (this.newest(c.id) ?? 0) < now - DIRECT_RECENT_MS) {
          leave('no messages in the 90 days before');
          continue;
        }
        if (!direct && !read) {
          leave("you don't read them");
          continue;
        }
        if (!direct && expected < MIN_EXPECTED) {
          leave('quiet before then');
          continue;
        }
      }
      if (h.scope === 'chat' && !all && !named && !direct && !read) {
        leave("you don't read it");
        continue;
      }
      const why = direct ? (c.shape === 'direct' ? 'a direct chat' : 'a group') : read ? 'a channel you read' : 'a channel';
      picked.push({ id: c.id, expected, direct, why, score: direct ? 3 * (expected + 0.5) : (expected + 0.5) * (read ? 1 : 0.3) });
    }
    picked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    if (!all && picked.length > MAX_CHATS) {
      for (let i = MAX_CHATS; i < picked.length; i++) leave(`beyond the first ${MAX_CHATS}`);
      picked.length = MAX_CHATS;
    }
    const fetchable = this.can(h.account_id, 'history');
    if (!fetchable && h.scope === 'account' && !all)
      // Nothing will be fetched: the list is of the chats likely to have had messages then, for an import to fill.
      for (let i = picked.length - 1; i >= 0; i--)
        if (picked[i].expected < MIN_EXPECTED) {
          leave('quiet before then');
          picked.splice(i, 1);
        }
    const possible = h.strength === 'possible' && !all;
    // The likeliest few, checked first when the hole is only possible: the busiest, a direct chat before a channel.
    const probes = new Set(
      [...picked]
        .filter((p) => p.expected >= 1 || (p.direct && p.expected >= 0.5))
        .sort((a, b) => b.expected * (b.direct ? 2 : 1) - a.expected * (a.direct ? 2 : 1))
        .slice(0, PROBES)
        .map((p) => p.id),
    );
    let state: P.CatchUpState = !fetchable ? 'unfetchable' : possible ? 'checking' : 'fetching';
    const notes = JSON.parse(h.notes) as string[];
    if (state === 'checking' && !probes.size) {
      state = 'clear';
      notes.push('No chat was busy enough then to be worth checking');
    }
    if (state !== 'unfetchable' && !picked.length) state = 'done';
    this.store.db.transaction(() => {
      const had = new Map(this.store.raw<Row>('SELECT * FROM catchup_task WHERE hole_id = ?', h.id).map((t) => [t.conversation_id as string, t]));
      const put = this.store.db.query(
        `INSERT INTO catchup_task (hole_id, conversation_id, account_id, rank, probe, expected, why, state, from_ts, to_ts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const update = this.store.db.query(`UPDATE catchup_task SET rank = ?, probe = ?, expected = ?, why = ?, state = ?, from_ts = ?, to_ts = ?, cursor = ?, walk = ?, updated_at = ? WHERE hole_id = ? AND conversation_id = ?`);
      picked.forEach((p, rank) => {
        const t = had.get(p.id);
        const taskState = state === 'unfetchable' ? 'unfetchable' : state === 'clear' ? 'skipped' : 'queued';
        if (!t) return put.run(h.id, p.id, h.account_id, rank, probes.has(p.id) ? 1 : 0, p.expected, p.why, taskState, from, to, now);
        // Planned again (a wider stretch, a surer cause, every chat asked for): a finished chat goes again only if
        // its stretch grew; the walk starts over from the top, and the spans skip what it fetched.
        const grew = from < t.from_ts || to > t.to_ts;
        const again = t.state === 'queued' || grew || (t.state === 'skipped' && taskState === 'queued');
        update.run(rank, probes.has(p.id) ? 1 : 0, p.expected, p.why, again ? taskState : t.state, Math.min(from, t.from_ts), Math.max(to, t.to_ts), grew ? null : t.cursor, grew ? null : t.walk, now, h.id, p.id);
      });
      const leftOut = [...left].map(([why, count]) => ({ why, count }));
      if (state === 'unfetchable') notes.push(`${acc.label || 'This account'} cannot fetch older messages from ${acc.network}: an import (Settings → Import) can fill this`);
      this.store.db
        .query('UPDATE catchup_hole SET state = ?, left_out = ?, notes = ?, updated_at = ? WHERE id = ?')
        .run(state, leftOut.length ? JSON.stringify(leftOut) : null, JSON.stringify(notes.slice(-20)), now, h.id);
    })();
    this.log(`catch-up: planned ${h.id}: ${picked.length} chats, ${state}`);
    // Planned again with every chat already done (the spans covered it): it is over now, not when a chat finishes.
    if (state === 'checking' || state === 'fetching') this.finished(h.id);
  }

  // ------------------------------------------------------------------ fetching

  /** The account's next chat: the surest hole first, then the oldest, each in its own order. */
  private next(accountId: string): Row | null {
    return this.store.one<Row>(
      `SELECT t.*, h.state AS hole_state FROM catchup_task t JOIN catchup_hole h ON h.id = t.hole_id
       WHERE t.account_id = ? AND t.state = 'queued' AND (h.state = 'fetching' OR (h.state = 'checking' AND t.probe = 1))
       ORDER BY CASE h.strength WHEN 'sure' THEN 0 WHEN 'likely' THEN 1 ELSE 2 END, h.created_at, t.rank LIMIT 1`,
      accountId,
    );
  }

  private async work(accountId: string) {
    this.working.set(accountId, { holeId: '', cid: '' });
    let last = '';
    try {
      for (;;) {
        if (this.stopped || !this.o.online(accountId)) return;
        const t = this.next(accountId);
        if (!t) return;
        const rest = this.pace.wait(accountId, READER);
        if (rest > 0) {
          this.working.set(accountId, { holeId: t.hole_id, cid: t.conversation_id, resting: true });
          await sleep(this.clock, Math.min(rest, REST_STEP_MS));
          continue;
        }
        this.working.set(accountId, { holeId: t.hole_id, cid: t.conversation_id });
        let pause = 0;
        try {
          const r = await this.page(t);
          if (r.deferMs) pause = Math.min(Math.max(r.deferMs, 1000), DEFER_MAX_MS);
          else pause = this.pace.read(accountId, READER, r.count, r.done || last !== t.conversation_id);
          if (r.done) this.finished(t.hole_id);
        } catch (e: any) {
          const msg = String(e?.message ?? e).slice(0, 300);
          this.log(`catch-up ${t.hole_id} ${t.conversation_id}: ${msg}`);
          if (/rate.?limit|retry_after|429/i.test(msg)) pause = 30_000;
          else if (/not connected/i.test(msg)) return;
          else {
            jobFailed('catch-up: page', e, { account: accountId });
            this.store.db.query(`UPDATE catchup_task SET state = 'failed', error = ?, updated_at = ? WHERE hole_id = ? AND conversation_id = ?`).run(msg, this.clock.now(), t.hole_id, t.conversation_id);
            this.finished(t.hole_id);
          }
        }
        last = t.conversation_id;
        if (pause > 0) await sleep(this.clock, pause);
      }
    } finally {
      this.working.delete(accountId);
      this.pace.release(accountId, READER);
    }
  }

  /** One page of a chat back from its cursor, over what is known whole; whether the chat is done. */
  private async page(t: Row): Promise<{ count: number; done: boolean; deferMs?: number }> {
    const cid = t.conversation_id as string;
    const now = () => this.clock.now();
    const save = (patch: { cursor?: number | null; walk?: string | null; state?: string; error?: string | null; pages?: number; found?: number }) =>
      this.store.db
        .query('UPDATE catchup_task SET cursor = ?, walk = ?, state = ?, error = ?, pages = pages + ?, found = found + ?, updated_at = ? WHERE hole_id = ? AND conversation_id = ?')
        .run(patch.cursor === undefined ? t.cursor : patch.cursor, patch.walk === undefined ? null : patch.walk, patch.state ?? 'queued', patch.error ?? null, patch.pages ?? 0, patch.found ?? 0, now(), t.hole_id, cid);
    const native = this.store.nativeOf('conversation', cid)?.nativeId;
    if (!native) return (save({ state: 'failed', error: 'the chat is gone' }), { count: 0, done: true });
    let cursor: number = t.cursor ?? t.to_ts + 1;
    for (let s = spanAt(this.store, cid, cursor); s; s = spanAt(this.store, cid, cursor)) cursor = s.from_ts;
    if (cursor <= t.from_ts) return (save({ cursor, state: 'done' }), { count: 0, done: true });
    if (t.pages >= MAX_PAGES) return (save({ cursor, state: 'done', error: `Stopped after ${MAX_PAGES} pages; older messages in the stretch were not fetched` }), { count: 0, done: true });
    let mark: { next?: string; at?: number } = {};
    try {
      mark = JSON.parse(t.walk || '{}') ?? {};
    } catch {
      /* none */
    }
    const below = this.store.db.query('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND ts < ?');
    const before = (below.get(cid, cursor) as Row).n as number;
    const cmd = { t: 'history' as const, conversation: native, beforeTs: cursor, limit: PAGE, pace: 'read' as const, ...(mark.next && mark.at === cursor ? { cursor: mark.next } : {}) };
    const r = (await this.o.command(t.account_id, cmd, 180_000)) as P.HistoryResult | null;
    if (r?.deferMs && !r.count) return { count: 0, done: false, deferMs: r.deferMs };
    const count = r?.count ?? 0;
    let oldest: number | null = typeof r?.oldest === 'number' ? r.oldest : null;
    if (count && oldest === null) {
      // An adapter that does not say where its page ended: the `count` newest below the cursor, once they land.
      const nth = () => (this.store.one<Row>('SELECT ts FROM message WHERE conversation_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1 OFFSET ?', cid, cursor, count - 1)?.ts as number | undefined) ?? null;
      oldest = nth();
      for (let i = 0; i < LAND_TRIES && oldest === null; i++) {
        await sleep(this.clock, LAND_MS);
        oldest = nth();
      }
    }
    const found = Math.max(0, ((below.get(cid, cursor) as Row).n as number) - before);
    if (!r || r.done || !count || oldest === null || oldest >= cursor) {
      // The start of the chat: everything below the cursor is whole.
      addSpan(this.store, cid, 0, cursor);
      save({ cursor: 0, state: 'done', pages: 1, found });
      return { count, done: true };
    }
    addSpan(this.store, cid, oldest, cursor);
    const done = oldest <= t.from_ts;
    save({ cursor: oldest, walk: !done && typeof r.next === 'string' ? JSON.stringify({ next: r.next, at: oldest }) : null, state: done ? 'done' : 'queued', pages: 1, found });
    return { count, done };
  }

  /** A chat of the hole is done: whether the hole is, and what the first chats of a check said. */
  private finished(holeId: string) {
    const h = this.store.one<Row>('SELECT * FROM catchup_hole WHERE id = ?', holeId);
    if (!h) return;
    const now = this.clock.now();
    const notes = JSON.parse(h.notes) as string[];
    const sum = (where: string) => this.store.one<Row>(`SELECT COUNT(*) AS n, COALESCE(SUM(found), 0) AS found FROM catchup_task WHERE hole_id = ? AND ${where}`, holeId)!;
    if (h.state === 'checking') {
      if (sum(`probe = 1 AND state = 'queued'`).n) return;
      const found = sum('probe = 1').found as number;
      if (found > 0) {
        notes.push(`${plural(found, 'missing message')} in the first chats checked: fetching the rest`);
        this.store.db.query(`UPDATE catchup_hole SET state = 'fetching', strength = 'likely', notes = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(notes.slice(-20)), now, holeId);
      } else {
        notes.push('The chats likeliest to have had messages then were whole, so the rest were not fetched');
        this.store.db.query(`UPDATE catchup_task SET state = 'skipped', why = 'the first chats checked were whole', updated_at = ? WHERE hole_id = ? AND state = 'queued'`).run(now, holeId);
        this.store.db.query(`UPDATE catchup_hole SET state = 'clear', notes = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(notes.slice(-20)), now, holeId);
      }
      return;
    }
    if (h.state === 'fetching' && !sum(`state = 'queued'`).n) this.store.db.query(`UPDATE catchup_hole SET state = 'done', updated_at = ? WHERE id = ?`).run(now, holeId);
    else this.store.db.query('UPDATE catchup_hole SET updated_at = ? WHERE id = ?').run(now, holeId);
    if (h.scope === 'chat' && sum('1').found > 0) this.nearby(h);
  }

  /** Several chats of one account missed messages around the same time: the account's other chats are checked too. */
  private nearby(h: Row) {
    const now = this.clock.now();
    const rows = this.store.raw<Row>(
      `SELECT h.from_ts, h.to_ts FROM catchup_hole h WHERE h.scope = 'chat' AND h.account_id = ? AND h.created_at >= ? AND h.from_ts <= ? AND h.to_ts >= ?
       AND EXISTS (SELECT 1 FROM catchup_task t WHERE t.hole_id = h.id AND t.found > 0)`,
      h.account_id,
      now - DAY,
      h.to_ts + MERGE_MS,
      h.from_ts - MERGE_MS,
    );
    if (rows.length < NEARBY) return;
    const from = Math.min(...rows.map((r) => r.from_ts));
    const to = Math.max(...rows.map((r) => r.to_ts));
    // Once: an account hole of the last day already over this stretch, open or done, is enough.
    if (this.store.one(`SELECT 1 FROM catchup_hole WHERE scope = 'account' AND account_id = ? AND created_at >= ? AND from_ts <= ? AND to_ts >= ? AND state != 'stopped'`, h.account_id, now - DAY, to, from))
      return;
    this.report({ scope: 'account', accountId: h.account_id, from, to, strength: 'likely', cause: 'nearby', note: `${rows.length} chats were missing messages around the same time, so the account's other chats are checked for then` });
  }

  // ------------------------------------------------------------------ views

  private view(h: Row, withList = false): P.CatchUpHoleView {
    const acc = this.store.account(h.account_id);
    const c = h.conversation_id ? this.store.one<Row>('SELECT name FROM conversation WHERE id = ?', h.conversation_id) : null;
    const tasks = this.store.one<Row>(
      `SELECT COUNT(*) AS n, SUM(state != 'queued') AS done, COALESCE(SUM(pages), 0) AS pages, COALESCE(SUM(found), 0) AS found FROM catchup_task WHERE hole_id = ?`,
      h.id,
    )!;
    const w = this.working.get(h.account_id);
    // Between pages the worker still names the chat it read last: only while the hole is open is it on it.
    const here = w && w.holeId === h.id && ['checking', 'fetching'].includes(h.state) ? w : null;
    const v: P.CatchUpHoleView = {
      id: h.id,
      scope: h.scope,
      accountId: h.account_id,
      accountName: acc?.label ?? '(removed)',
      network: (acc?.network as P.Network | undefined) ?? null,
      conversationId: h.conversation_id ?? null,
      conversationName: c?.name ?? null,
      from: h.from_ts,
      to: h.to_ts,
      strength: h.strength,
      causes: JSON.parse(h.causes),
      notes: JSON.parse(h.notes),
      state: h.state === 'planning' ? (h.strength === 'possible' ? 'checking' : 'fetching') : h.state,
      createdAt: h.created_at,
      updatedAt: h.updated_at,
      chats: tasks.n ?? 0,
      chatsDone: tasks.done ?? 0,
      left: h.left_out ? JSON.parse(h.left_out) : [],
      pages: tasks.pages ?? 0,
      found: tasks.found ?? 0,
      current: here && !here.resting ? (this.store.one<Row>('SELECT name FROM conversation WHERE id = ?', here.cid)?.name ?? here.cid) : null,
      resting: here?.resting ? this.pace.resting(h.account_id) : null,
    };
    if (withList)
      v.list = this.store
        .raw<Row>(`SELECT t.*, c.name, c.shape FROM catchup_task t LEFT JOIN conversation c ON c.id = t.conversation_id WHERE t.hole_id = ? ORDER BY t.rank`, h.id)
        .map((t) => ({
          conversationId: t.conversation_id,
          name: t.name ?? '',
          shape: t.shape ?? 'channel',
          accountId: t.account_id,
          state: here && !here.resting && here.cid === t.conversation_id && t.state === 'queued' ? 'fetching' : t.state,
          why: t.why,
          expected: Math.round(t.expected * 10) / 10,
          pages: t.pages,
          found: t.found,
          error: t.error ?? null,
        }));
    return v;
  }

  // ------------------------------------------------------------------ small things

  private networkOf(accountId: string): P.Network | null {
    let n = this.networks.get(accountId);
    if (!n) {
      const a = this.store.account(accountId);
      if (!a) return null;
      n = a.network as P.Network;
      this.networks.set(accountId, n);
    }
    return n;
  }

  private meta<T>(key: string): T | null {
    const r = this.store.one<Row>('SELECT value FROM meta WHERE key = ?', key);
    if (!r) return null;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return null;
    }
  }

  private setMeta(key: string, value: unknown) {
    if (value === null || value === undefined) this.store.db.query('DELETE FROM meta WHERE key = ?').run(key);
    else this.store.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
}
