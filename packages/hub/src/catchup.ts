/**
 * Catching up (docs/catch-up.md): the hub notices it may be missing messages, works out where, fetches them through
 * the account's own history at the reading pace, and keeps track of each hole until it is filled, found whole, or
 * known to need another source.
 *
 * Reports come from what the hub sees (EventWatch, called by the supervisor), from adapters (a `gap` event), from
 * the network (a chat's `lastMessageAt` newer than anything held), and from people and scripts
 * (`POST /api/catch-up/report`), and from you (Check for missing messages, on a chat or an account). Each lands in a
 * hole: a stretch of time across an account's chats (scope `account`), or only the chats it names (`chat`). Every
 * report about one account that comes within half an hour of an open hole of that account joins it, so one trouble
 * (an account hole, then a claim per chat as its adapter restarts) is one hole, one row in Settings.
 *
 * A hole is planned a minute after its first report, so the reports of one trouble merge first. Its account's chats
 * are ranked by how many messages each was likely to get in the stretch (its pace in the two weeks before), direct
 * chats and groups first, and channels you never read left out (you can ask for them). A hole whose cause only makes
 * a loss possible (an account offline for a while: most networks replay what it missed) checks its three likeliest
 * chats first; when they are whole, the hole is clear and nothing more is fetched. When chat holes on one account turn
 * out to miss messages around the same time, the trouble was the account's, not the chats': the account's other
 * chats are checked for that time too (`nearby`).
 *
 * A chat is paged back from the end of the stretch to its start, 50 messages a page, through historypage.ts as the
 * index jobs and the gap fill read: what a page brought is known exactly (the store records the page's own messages,
 * and the reader waits until the account's events before its answer are applied), and what it covered is recorded
 * whole (history_span), so nothing is fetched twice. One reader per account at a time through the shared reading
 * pace (readingpace.ts). An account that cannot fetch history (Signal keeps none on its
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
import { LAND_AGAIN_MS, LAND_RETRIES, NOT_LANDED, type Pager, readPage, skipWhole } from './historypage.ts';
import { cutSpan } from './historyspan.ts';
import { READING, ReadingPace } from './readingpace.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export { PAGE } from './historypage.ts';
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
/** Channels expected to have had fewer messages than this in the stretch are left out. */
const MIN_EXPECTED = 0.3;
/** Chats one hole plans at most; the rest wait until you ask for them. */
const MAX_CHATS = 60;
/** How many chats a `possible` hole checks first. */
const PROBES = 3;
/** Pages one chat of a hole the hub found fetches at most: 3,000 messages, a day's reading. One you asked for has no cap. */
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
/** While events wait to be applied, their marker is saved at least this often, so a crash's time is known that closely. */
const BACKLOG_SAVE_MS = 30_000;
/**
 * Direct chats and groups: the quietest are left out while all those left out together were expected to have had
 * fewer messages than this. Eighty chats that each rarely talk may still have had a few messages between them.
 */
const DIRECT_TAIL = 0.5;
/** A direct chat or group with messages this close to the stretch is fetched however quiet it was before. */
const AROUND_MS = 30 * MIN;
/** Claims looked at in one tick: after a snapshot thousands come at once. */
const CLAIMS_PER_TICK = 300;
/** A wait for the pace is slept in steps this long at most, so a stop or an account going offline tells soon. */
const REST_STEP_MS = MIN;
/** An adapter that cannot read just now (deferMs) is asked again after at most this long. */
const DEFER_MAX_MS = 10 * MIN;
/** Channels whose own history holds nothing: their posts are threads. */
const NO_MESSAGES = new Set(['forum', 'media']);
const STRENGTH: Record<P.CatchUpStrength, number> = { possible: 0, likely: 1, sure: 2 };
const OPEN = `('planning', 'checking', 'fetching')`;
/** Another connection held the database past busy_timeout, or wrote between a transaction's read and its write (SQLITE_BUSY_SNAPSHOT). */
const isBusy = (e: unknown) => String((e as { code?: string } | null)?.code ?? '').startsWith('SQLITE_BUSY');

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
  /** `account`: every chat of it over the stretch; `chat`: only the one named. */
  scope: 'account' | 'chat';
  accountId?: string;
  conversationId?: string | null;
  from: number;
  to?: number;
  strength: P.CatchUpStrength;
  cause: P.CatchUpCause;
  note: string;
  /** You asked (the app's Check for missing messages): every chat, no two-week limit, no page cap. */
  asked?: boolean;
}

/** A hole's named chats: each with its own stretch, fetched whatever the plan says of the account's other chats. */
type Named = Record<string, { from: number; to: number }>;

interface Options extends Pager {
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
  private backlogDirty = false;
  private awayDirty = false;
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
      // Which accounts: those whose events waited; a stop that lost events it never said whose, every account heard.
      const accounts = Object.keys(marker.accounts ?? {}).length ? Object.keys(marker.accounts) : [...this.lastHeard.keys()];
      // The marker is saved at least every BACKLOG_SAVE_MS while events wait: the crash came before the next save.
      const to = marker.at + BACKLOG_SAVE_MS + 2 * TICK_MS;
      for (const acc of accounts) {
        const oldest = marker.accounts?.[acc] ?? null;
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
    this.backlog ??= { since: now, at: now, accounts: {} };
    const had = this.backlog.accounts[accountId];
    let oldest = had ?? null;
    // Live messages only: a history page or a snapshot in the queue holds old messages the network still has, and a
    // crash then loses nothing a fetch of the time since `since` would not bring back.
    for (const e of events) if (e.t === 'message' && e.live && Number.isFinite(e.message.ts)) oldest = oldest === null ? e.message.ts : Math.min(oldest, e.message.ts);
    if (had === undefined || oldest !== had) {
      this.backlog.accounts[accountId] = oldest;
      this.backlogDirty = true;
    }
  }

  lost(accountId: string, events: readonly P.AdapterEvent[], why: string) {
    const network = this.networkOf(accountId);
    if (!network) return;
    const now = this.clock.now();
    for (const e of events) {
      if (e.t !== 'message' || !Number.isFinite(e.message?.ts) || typeof e.message.conversation !== 'string') continue;
      // A message that fails each time it comes (a bug) is reported once a day, not fetched over and over.
      const key = `${accountId}:${e.message.nativeId}`;
      if ((this.lostIds.get(key) ?? 0) > now - DAY) continue;
      this.lostIds.set(key, now);
      this.reports.push({ scope: 'chat', accountId, conversationId: hubId('cnv', network, e.message.conversation), from: e.message.ts - 1, to: e.message.ts + 1, strength: 'sure', cause: 'lost', note: `A message could not be stored: ${why}` });
    }
  }

  gap(accountId: string, ev: Extract<P.AdapterEvent, { t: 'gap' }>) {
    const network = this.networkOf(accountId);
    if (!network || !Number.isFinite(ev.from) || (ev.to !== undefined && !Number.isFinite(ev.to))) return;
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
        this.awayDirty = true;
      }
      return;
    }
    this.backAt = now;
  }

  // ------------------------------------------------------------------ the API

  /** POST /api/catch-up/report: a script's report, or your ask from the app (`asked`). */
  reportFrom(r: P.CatchUpReport): P.CatchUpHoleView {
    if (typeof r?.from !== 'number' || !Number.isFinite(r.from)) throw new Error('from when? `from` is a time in ms');
    if (r.to !== undefined && (typeof r.to !== 'number' || !Number.isFinite(r.to))) throw new Error('`to` is a time in ms');
    if (!r.accountId && !r.conversationId) throw new Error('which account or chat?');
    if (r.strength !== undefined && !(r.strength in STRENGTH)) throw new Error('strength is possible, likely or sure');
    const asked = r.asked === true;
    const id = this.report({
      scope: r.conversationId ? 'chat' : 'account',
      accountId: r.accountId,
      conversationId: r.conversationId ?? null,
      from: r.from,
      to: r.to,
      strength: asked ? 'sure' : (r.strength ?? 'likely'),
      cause: asked ? 'asked' : 'report',
      asked,
      note: typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, 200) : asked ? 'You asked' : 'Reported',
    });
    if (!id) throw new Error(r.conversationId ? 'no such chat, or no account sees it' : 'no such account');
    this.tick();
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

  /**
   * A report: into the account's open hole it is close to, or a new one. The hole's id; null if it names nothing
   * known. A chat's report names the chat in that hole, with its own stretch; an account's widens the hole's stretch
   * across every chat (and makes a hole that named only chats one of the account).
   */
  report(r: Report): string | null {
    if (!Number.isFinite(r.from) || (r.to !== undefined && !Number.isFinite(r.to))) return null;
    const now = this.clock.now();
    const to = Math.min(typeof r.to === 'number' ? r.to : now, now);
    // What the hub found looks back two weeks at most; what you asked for, as far as you said.
    let from = r.asked ? Math.max(0, r.from) : Math.max(r.from, to - MAX_STRETCH_MS);
    if (from >= to) from = to - 1;
    let accountId = r.accountId ?? null;
    const cid = r.scope === 'chat' ? (r.conversationId ?? null) : null;
    if (r.scope === 'chat') {
      if (!cid || !this.store.one('SELECT 1 FROM conversation WHERE id = ?', cid)) return null;
      if (!accountId || !this.store.vantageAccounts('conversation', cid).includes(accountId)) accountId = this.accountFor(cid);
    }
    if (!accountId || !this.store.account(accountId)) return null;
    const open = this.store.one<Row>(
      `SELECT * FROM catchup_hole WHERE account_id = ? AND state IN ${OPEN} AND from_ts <= ? AND to_ts >= ? ORDER BY scope = 'account' DESC, created_at LIMIT 1`,
      accountId,
      to + MERGE_MS,
      from - MERGE_MS,
    );
    if (open) {
      const causes = JSON.parse(open.causes) as P.CatchUpCause[];
      const notes = JSON.parse(open.notes) as string[];
      if (!causes.includes(r.cause)) causes.push(r.cause);
      if (notes[notes.length - 1] !== r.note) notes.push(r.note);
      const named = JSON.parse(open.named || '{}') as Named;
      let { from_ts: lo, to_ts: hi, scope, strength } = open as { from_ts: number; to_ts: number; scope: 'account' | 'chat'; strength: P.CatchUpStrength };
      let grew = false;
      if (cid) {
        // Named in the hole, with its own stretch; a hole of named chats only spans them all.
        const had = named[cid];
        if (!had || from < had.from || to > had.to) {
          named[cid] = { from: Math.min(had?.from ?? from, from), to: Math.max(had?.to ?? to, to) };
          grew = true;
        }
        if (scope === 'chat') {
          lo = Math.min(lo, from);
          hi = Math.max(hi, to);
        }
      } else {
        // The account's chats over this stretch: a hole that named only chats becomes the account's, as sure as this.
        if (scope === 'chat') {
          scope = 'account';
          lo = from;
          hi = to;
          strength = r.strength;
          grew = true;
        } else {
          grew = from < lo || to > hi || STRENGTH[r.strength] > STRENGTH[strength];
          lo = Math.min(lo, from);
          hi = Math.max(hi, to);
          if (STRENGTH[r.strength] > STRENGTH[strength]) strength = r.strength;
        }
      }
      if (cid && STRENGTH[r.strength] > STRENGTH[strength] && scope === 'chat') strength = r.strength;
      const all = open.all_chats || (r.asked && !cid) ? 1 : 0;
      // Wider, surer or more: planned again (what was fetched stays fetched: the spans skip it).
      const replan = open.state !== 'planning' && (grew || all !== open.all_chats);
      this.store.db
        .query('UPDATE catchup_hole SET scope = ?, conversation_id = ?, from_ts = ?, to_ts = ?, strength = ?, causes = ?, notes = ?, named = ?, all_chats = ?, updated_at = ? WHERE id = ?')
        .run(scope, open.conversation_id ?? cid, lo, hi, strength, JSON.stringify(causes), JSON.stringify(notes.slice(-20)), Object.keys(named).length ? JSON.stringify(named) : null, all, now, open.id);
      if (replan) this.store.db.query(`UPDATE catchup_hole SET state = 'planning', plan_at = ? WHERE id = ?`).run(now, open.id);
      return open.id;
    }
    const id = randomId('cup');
    const named: Named | null = cid ? { [cid]: { from, to } } : null;
    this.store.db
      .query(
        `INSERT INTO catchup_hole (id, scope, account_id, conversation_id, from_ts, to_ts, strength, causes, notes, named, all_chats, state, plan_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?)`,
      )
      .run(id, r.scope, accountId, cid, from, to, r.strength, JSON.stringify([r.cause]), JSON.stringify([r.note]), named ? JSON.stringify(named) : null, r.asked && !cid ? 1 : 0, r.cause === 'report' || r.cause === 'asked' ? now : now + PLAN_DELAY_MS, now, now);
    this.log(`catch-up: ${r.cause} ${r.scope} ${cid ?? accountId} ${new Date(from).toISOString()}..${new Date(to).toISOString()}`);
    return id;
  }

  // ------------------------------------------------------------------ the loop

  tick() {
    const now = this.clock.now();
    // What must outlive a crash first: each step on its own, so a locked database delays one, not the rest.
    const steps: [string, () => void][] = [
      ['backlog', () => this.keepBacklog(now)],
      ['away', () => this.keepAway(now)],
      ['heard', () => this.saveHeard(false)],
      ['reports', () => this.takeReports()],
      ['accounts', () => this.watchAccounts(now)],
      ['claims', () => this.settleClaims(now)],
      ['plans', () => {
        for (const h of this.store.raw<Row>(`SELECT * FROM catchup_hole WHERE state = 'planning' AND plan_at <= ?`, now)) this.plan(h);
      }],
      ['finish', () => {
        // Open holes with nothing left to fetch (a check whose only chats were its first ones, a restart between a
        // chat's end and its hole's): over now.
        const idle = this.store.raw<Row>(
          `SELECT id FROM catchup_hole h WHERE state IN ('checking', 'fetching') AND NOT EXISTS
           (SELECT 1 FROM catchup_task t WHERE t.hole_id = h.id AND t.state = 'queued' AND (h.state = 'fetching' OR t.probe = 1))`,
        );
        for (const h of idle) if (![...this.working.values()].some((w) => w.holeId === h.id)) this.finished(h.id);
      }],
      ['sweep', () => this.sweep(now)],
    ];
    for (const [what, step] of steps)
      try {
        step();
      } catch (e) {
        console.error(`catch-up: ${what} failed`, e);
        // A locked database is tried again at the next tick: said, not reported as a bug.
        if (!isBusy(e)) jobFailed(`catch-up: ${what}`, e);
      }
    if (this.stopped) return;
    const accounts = this.store.raw<Row>(`SELECT DISTINCT t.account_id FROM catchup_task t JOIN catchup_hole h ON h.id = t.hole_id WHERE t.state = 'queued' AND h.state IN ('checking', 'fetching')`);
    for (const a of accounts) if (!this.working.has(a.account_id) && this.o.online(a.account_id)) void this.work(a.account_id);
  }

  /**
   * Each report on its own: one that cannot be stored does not take the others with it. A locked database keeps this
   * one and the rest for the next tick.
   */
  private takeReports() {
    const reports = this.reports;
    this.reports = [];
    for (let i = 0; i < reports.length; i++) {
      const r = reports[i];
      try {
        // A message that failed to be stored sits inside a stretch a page may have marked whole: not that moment.
        if (r.cause === 'lost' && r.scope === 'chat' && r.conversationId) cutSpan(this.store, r.conversationId, r.from, r.to ?? r.from + 1);
        this.report(r);
      } catch (e) {
        if (isBusy(e)) {
          this.reports.unshift(...reports.slice(i));
          throw e;
        }
        console.error('catch-up: a report failed', e);
        jobFailed('catch-up: report', e, { account: r.accountId ?? '' });
      }
    }
  }

  /** Old holes go; open holes of an account that is gone go too, since nothing will ever fetch them. */
  private sweep(now: number) {
    if (now - this.lastSweep < HOUR) return;
    this.lastSweep = now;
    const old = this.store.raw<Row>(`SELECT id FROM catchup_hole WHERE (state NOT IN ${OPEN} AND updated_at < ?) OR account_id NOT IN (SELECT id FROM account)`, now - KEEP_MS);
    for (const h of old) this.remove(h.id);
    for (const [k, at] of this.lostIds) if (at < now - DAY) this.lostIds.delete(k);
  }

  /**
   * Accounts that went offline and came back: a hole for the time between, when it was long enough to matter. An
   * account turned off counts as offline: turned on again days later, it checks those days.
   */
  private watchAccounts(now: number) {
    let changed = false;
    for (const a of this.store.accounts()) {
      if (a.network === 'calendar') continue;
      const up = !!a.enabled && this.o.online(a.id) && a.status === 'online';
      const was = this.up.get(a.id);
      this.up.set(a.id, up);
      if (!up) {
        // Down from now, unless known down since earlier (saved across a restart). At a start too: an account that
        // never comes up is offline from then; one that comes up within OFFLINE_MIN_MS, as most do, opens nothing.
        if (was !== false && !this.offlineSince.has(a.id)) {
          this.offlineSince.set(a.id, now);
          changed = true;
        }
        continue;
      }
      const since = this.offlineSince.get(a.id);
      if (since === undefined) continue;
      // Reported first: a locked database leaves it offline-since, to be reported at the next tick.
      if (now - since >= OFFLINE_MIN_MS) this.report({ scope: 'account', accountId: a.id, from: since - MIN, to: now, strength: 'possible', cause: 'offline', note: `The account was offline for ${hm(now - since)}` });
      this.offlineSince.delete(a.id);
      changed = true;
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
    let n = 0;
    for (const [cid, c] of this.claims) {
      if (now - c.at < CLAIM_SETTLE_MS) continue;
      if (++n > CLAIMS_PER_TICK) break;
      try {
        this.settleClaim(cid, c, now);
      } catch (e) {
        // A locked database: this claim and the rest wait for the next tick.
        if (isBusy(e)) throw e;
        this.claims.delete(cid);
        throw e;
      }
      this.claims.delete(cid);
    }
  }

  private settleClaim(cid: string, c: { accountId: string; ts: number }, now: number) {
    {
      if (c.ts > now + 5 * MIN || c.ts < now - MAX_STRETCH_MS) return;
      const seen = this.store.one<Row>('SELECT ts FROM catchup_claim WHERE conversation_id = ?', cid)?.ts as number | undefined;
      if (seen !== undefined && c.ts <= seen) return;
      const newest = this.newest(cid);
      if (newest === null || newest < now - FOLLOWED_MS) return;
      // The claimed message itself, or none: what the hub holds up to the claim, not its newest now (a live message
      // that came after the claim says nothing of the ones before it).
      const upTo = this.newest(cid, c.ts + CLAIM_SLACK_MS);
      if (upTo !== null && upTo >= c.ts - CLAIM_SLACK_MS) return;
      // Marked seen once settled, after its report: a write that fails leaves it to be settled again.
      const mark = () => this.store.db.query('INSERT INTO catchup_claim (conversation_id, ts) VALUES (?, ?) ON CONFLICT (conversation_id) DO UPDATE SET ts = MAX(ts, excluded.ts)').run(cid, c.ts);
      // A channel you do not read is not worth a page each time it moves (the hub follows it, you do not).
      const conv = this.store.one<Row>('SELECT shape FROM conversation WHERE id = ?', cid);
      if (!conv || ((conv.shape === 'channel' || conv.shape === 'thread') && !this.reads(cid, now))) return void mark();
      // A chat whose newest message is one the hub does not keep (a join, a pin, a call) claims more than it has
      // every time: after two checks that fetched and found nothing, its claims rest a week.
      const checks = this.store.raw<Row>(
        `SELECT t.found FROM catchup_task t JOIN catchup_hole h ON h.id = t.hole_id
         WHERE t.conversation_id = ? AND t.state = 'done' AND h.causes = '["behind"]' AND h.state IN ('done', 'clear') AND h.created_at >= ?
         ORDER BY h.created_at DESC LIMIT 2`,
        cid,
        now - 7 * DAY,
      );
      if (checks.length === 2 && checks.every((x) => !x.found)) return void mark();
      this.report({ scope: 'chat', accountId: c.accountId, conversationId: cid, from: upTo ?? c.ts - HOUR, to: c.ts + 1, strength: 'likely', cause: 'behind', note: 'The network has newer messages here than the hub' });
      mark();
    }
  }

  /** You opened the chat here, or read it on the network, lately. */
  private reads(cid: string, now: number): boolean {
    const r = this.store.one<Row>(
      `SELECT MAX(COALESCE((SELECT last_visit FROM place_usage WHERE kind = 'conversation' AND id = ?), 0), COALESCE((SELECT MAX(last_read_ts) FROM vantage WHERE target_kind = 'conversation' AND target_id = ?), 0)) AS t`,
      cid,
      cid,
    );
    return ((r?.t as number | null) ?? 0) >= now - READ_RECENTLY_MS;
  }

  /** The newest message held, or the newest up to `upTo`. */
  private newest(cid: string, upTo = Number.MAX_SAFE_INTEGER): number | null {
    return (this.store.one<Row>('SELECT MAX(ts) AS t FROM message WHERE conversation_id = ? AND ts <= ?', cid, upTo)?.t as number | null) ?? null;
  }

  /** The waiting events' marker: gone once nothing waits, saved when it changed and every so often while events wait. */
  private keepBacklog(now: number) {
    if (!this.backlog) return;
    if ((this.o.backlog?.() ?? 0) === 0) {
      // The marker goes first: if the database is locked, memory still says so and the next tick tries again.
      if (this.backlogSaved) this.setMeta('catchup:backlog', null);
      this.backlog = null;
      this.backlogDirty = false;
      this.backlogSaved = 0;
      return;
    }
    if (this.backlogDirty || now - this.backlogSaved >= BACKLOG_SAVE_MS) this.saveBacklog(now);
  }

  private saveBacklog(now: number) {
    if (!this.backlog) return;
    this.backlog.at = now;
    this.setMeta('catchup:backlog', this.backlog);
    this.backlogSaved = now;
    this.backlogDirty = false;
  }

  /** Since when the manager was away, kept while it matters: a while after it is back, for its gaps. */
  private keepAway(now: number) {
    if (this.backAt !== null && now - this.backAt > 5 * MIN) {
      this.awaySince = null;
      this.backAt = null;
      this.awayDirty = true;
    }
    if (!this.awayDirty) return;
    this.setMeta('catchup:away', this.awaySince);
    this.awayDirty = false;
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
    const able = seen.filter((a) => this.can(a, 'history') && !!this.store.account(a)?.enabled);
    return able.find((a) => this.o.online(a)) ?? able[0] ?? seen[0] ?? null;
  }

  /** The account's adapter said it can (whether the account is on or not). */
  private can(accountId: string, capability: P.Capability): boolean {
    const a = this.store.account(accountId);
    if (!a) return false;
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
    if (!acc.enabled) {
      // Turned off: planned once it is on again, when what it can do is known (turned off is not unfetchable).
      const notes = JSON.parse(h.notes) as string[];
      const waiting = 'Waiting for the account to be turned on';
      if (notes[notes.length - 1] !== waiting) notes.push(waiting);
      this.store.db.query('UPDATE catchup_hole SET plan_at = ?, notes = ? WHERE id = ?').run(now + 10 * MIN, JSON.stringify(notes.slice(-20)), h.id);
      return;
    }
    const from = h.from_ts as number;
    const to = h.to_ts as number;
    const all = !!h.all_chats;
    const named = JSON.parse(h.named || '{}') as Named;
    // Each chat with what planning needs in one statement: its pace before its stretch, whether it had messages
    // right around it, and when you last read it.
    const cols = `c.id, c.shape, c.variant,
      (SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id AND m.ts >= ?1 AND m.ts < ?2) AS before,
      EXISTS (SELECT 1 FROM message m WHERE m.conversation_id = c.id AND m.ts >= ?3 AND m.ts < ?4) AS around,
      MAX(COALESCE((SELECT last_visit FROM place_usage p WHERE p.kind = 'conversation' AND p.id = c.id), 0),
          COALESCE((SELECT MAX(last_read_ts) FROM vantage r WHERE r.target_kind = 'conversation' AND r.target_id = c.id), 0)) AS read_at`;
    const args = (a: number, b: number) => [a - RATE_MS, a, a - AROUND_MS, b + AROUND_MS];
    const left = new Map<string, number>();
    const leave = (why: string) => left.set(why, (left.get(why) ?? 0) + 1);
    type Pick = { id: string; from: number; to: number; expected: number; score: number; tie: number; why: string; direct: boolean; around: boolean; named: boolean };
    const picked: Pick[] = [];
    const pick = (c: Row, a: number, b: number, isNamed: boolean): Pick => {
      const expected = ((c.before as number) / RATE_MS) * (b - a);
      const direct = c.shape === 'direct' || c.shape === 'group';
      const read = (c.read_at as number) >= now - READ_RECENTLY_MS;
      const why = isNamed ? 'named by a report' : direct ? (c.shape === 'direct' ? 'a direct chat' : 'a group') : read ? 'a channel you read' : 'a channel';
      // Ranked by messages likely missed, a direct chat or group's counting three times; among chats as quiet, a
      // direct chat first, then a channel you read.
      const weight = direct ? 3 : read ? 1 : 0.3;
      return { id: c.id, from: a, to: b, expected, direct, around: !!c.around, why, score: weight * expected, tie: weight, named: isNamed };
    };
    if (h.scope === 'account')
      for (const c of this.store.raw<Row>(
        `SELECT ${cols} FROM conversation c
         JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = c.id AND v.account_id = ?5
         WHERE c.shape IN ('direct', 'group', 'channel', 'thread') AND c.archived = 0`,
        ...args(from, to),
        h.account_id,
      )) {
        if (NO_MESSAGES.has(c.variant) || named[c.id]) continue;
        const p = pick(c, from, to, false);
        if (!all) {
          // A channel you do not read, or quiet before then, is left out. Direct chats and groups: their tail is cut
          // below, together (each costs a page, wanted or not).
          if (!p.direct && p.tie < 1) {
            leave("you don't read them");
            continue;
          }
          if (!p.direct && p.expected < MIN_EXPECTED) {
            leave('quiet before then');
            continue;
          }
        }
        picked.push(p);
      }
    // The chats a report named are fetched whatever they look like, each over its own stretch (and the account's).
    for (const [cid, st] of Object.entries(named)) {
      const a = h.scope === 'account' ? Math.min(st.from, from) : st.from;
      const b = h.scope === 'account' ? Math.max(st.to, to) : st.to;
      const c = this.store.one<Row>(`SELECT ${cols} FROM conversation c WHERE c.id = ?5`, ...args(a, b), cid);
      if (c && !NO_MESSAGES.has(c.variant)) picked.push(pick(c, a, b, true));
    }
    if (h.scope === 'account' && !all) {
      // The quietest direct chats and groups go while all that went were expected under DIRECT_TAIL messages between
      // them; one with messages right around the stretch stays however quiet (a conversation that started that day).
      const quiet = picked.filter((p) => p.direct && !p.around && !p.named).sort((a, b) => a.expected - b.expected || a.id.localeCompare(b.id));
      let sum = 0;
      const out = new Set<string>();
      for (const p of quiet) {
        if (sum + p.expected >= DIRECT_TAIL) break;
        sum += p.expected;
        out.add(p.id);
        leave('quiet then');
      }
      if (out.size) picked.splice(0, picked.length, ...picked.filter((p) => !out.has(p.id)));
    }
    // Named chats first, then by messages likely missed.
    picked.sort((a, b) => Number(b.named) - Number(a.named) || b.score - a.score || b.tie - a.tie || a.id.localeCompare(b.id));
    const cap = MAX_CHATS + picked.filter((p) => p.named).length;
    if (!all && picked.length > cap) {
      for (let i = cap; i < picked.length; i++) leave(`beyond the first ${MAX_CHATS}`);
      picked.length = cap;
    }
    const fetchable = this.can(h.account_id, 'history');
    if (!fetchable && h.scope === 'account' && !all)
      // Nothing will be fetched: the list is of the chats likely to have had messages then, for an import to fill.
      for (let i = picked.length - 1; i >= 0; i--)
        if (!picked[i].named && picked[i].expected < MIN_EXPECTED) {
          leave('quiet before then');
          picked.splice(i, 1);
        }
    const possible = h.strength === 'possible' && !all;
    // The likeliest few, checked first when the hole is only possible: the busiest, a direct chat before a channel.
    // Named chats are always among them: something said those may be missing messages.
    const probes = new Set([
      ...picked.filter((p) => p.named).map((p) => p.id),
      ...[...picked]
        .filter((p) => !p.named && (p.expected >= 1 || (p.direct && p.expected >= 0.5)))
        .sort((a, b) => b.expected * (b.direct ? 2 : 1) - a.expected * (a.direct ? 2 : 1))
        .slice(0, PROBES)
        .map((p) => p.id),
    ]);
    let state: P.CatchUpState = !fetchable ? 'unfetchable' : possible ? 'checking' : 'fetching';
    const notes = JSON.parse(h.notes) as string[];
    if (state !== 'unfetchable' && !picked.length) {
      // Nothing worth a page: clear, with the reasons in left_out (a channel you don't read, chats quiet then).
      state = 'clear';
      notes.push(h.scope === 'chat' ? 'Not fetched: the chat cannot be read here' : 'No chat was likely to have had messages then');
    } else if (state === 'checking' && !probes.size) {
      state = 'clear';
      notes.push('No chat was busy enough then to be worth checking');
    }
    this.store.db.transaction(() => {
      const had = new Map(this.store.raw<Row>('SELECT * FROM catchup_task WHERE hole_id = ?', h.id).map((t) => [t.conversation_id as string, t]));
      const put = this.store.db.query(
        `INSERT INTO catchup_task (hole_id, conversation_id, account_id, rank, probe, expected, why, state, from_ts, to_ts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const update = this.store.db.query(`UPDATE catchup_task SET rank = ?, probe = ?, expected = ?, why = ?, state = ?, from_ts = ?, to_ts = ?, cursor = ?, walk = ?, pages = ?, error = ?, updated_at = ? WHERE hole_id = ? AND conversation_id = ?`);
      picked.forEach((p, rank) => {
        const t = had.get(p.id);
        const taskState = state === 'unfetchable' ? 'unfetchable' : state === 'clear' ? 'skipped' : 'queued';
        // A check with nothing worth checking: each chat says why it was not fetched, not why it was planned.
        const why = taskState === 'skipped' ? 'quiet then: no messages were expected' : p.why;
        if (!t) return put.run(h.id, p.id, h.account_id, rank, probes.has(p.id) ? 1 : 0, p.expected, why, taskState, p.from, p.to, now);
        // Planned again (a wider stretch, a surer cause, every chat asked for): a finished chat goes again only if
        // its stretch grew. Grown further back, the walk goes on from where it was; grown at its end, it starts at the
        // new end, and the spans its pages recorded skip what it read.
        const grew = p.from < t.from_ts || p.to > t.to_ts;
        const again = t.state === 'queued' || grew || (t.state === 'skipped' && taskState === 'queued');
        // A stretch that grew is a new walk with its own page budget. Grown only further back, the walk goes on from
        // where it was; grown at the end, it starts at the new end and, reaching the old one, jumps to where it was
        // (`resume`): an account without spans (no `oldest`) would otherwise read it all again.
        const later = p.to > t.to_ts;
        const cursor = grew && later ? null : t.cursor;
        // The adapter's cursor goes with the walk's: kept only while the walk goes on from where it was.
        const walk = grew && later ? null : t.walk;
        update.run(rank, probes.has(p.id) ? 1 : 0, p.expected, again ? why : t.why, again ? taskState : t.state, Math.min(p.from, t.from_ts), Math.max(p.to, t.to_ts), cursor, walk, grew ? 0 : t.pages, again ? null : t.error, now, h.id, p.id);
      });
      const leftOut = [...left].map(([why, count]) => ({ why, count }));
      if (state === 'unfetchable') notes.push(`${acc.label || 'This account'} cannot fetch older messages from ${acc.network}: an import (Settings → Import) can fill this`);
      this.store.db
        .query('UPDATE catchup_hole SET state = ?, left_out = ?, notes = ?, updated_at = ? WHERE id = ?')
        .run(state, leftOut.length ? JSON.stringify(leftOut) : null, JSON.stringify(notes.slice(-20)), now, h.id);
    }).immediate();
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
          // A page read counts against the pace even when it is to be asked again (its messages had not landed).
          const read = !r.deferMs || r.count ? this.pace.read(accountId, READER, r.count, r.done || last !== t.conversation_id) : 0;
          pause = r.deferMs ? Math.max(Math.min(Math.max(r.deferMs, 1000), DEFER_MAX_MS), read) : read;
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

  /**
   * One page of a chat back from its cursor, over what is known whole (historypage.ts); whether the chat is done.
   * What it found is the page's own messages the hub did not hold, inside the stretch: older history a page reaches
   * below it is not missing, and a message the network replays live meanwhile is not the page's.
   */
  private async page(t: Row): Promise<{ count: number; done: boolean; deferMs?: number }> {
    const cid = t.conversation_id as string;
    const native = this.store.nativeOf('conversation', cid)?.nativeId;
    const save = (patch: { cursor?: number | null; walk?: object | null; state?: string; error?: string | null; pages?: number; found?: number }) =>
      this.store.db
        .query('UPDATE catchup_task SET cursor = ?, walk = ?, state = ?, error = ?, pages = pages + ?, found = found + ?, updated_at = ? WHERE hole_id = ? AND conversation_id = ?')
        .run(patch.cursor === undefined ? t.cursor : patch.cursor, patch.walk ? JSON.stringify(patch.walk) : null, patch.state ?? 'queued', patch.error ?? null, patch.pages ?? 0, patch.found ?? 0, this.clock.now(), t.hole_id, cid);
    if (!native) return (save({ state: 'failed', error: 'the chat is gone' }), { count: 0, done: true });
    // The adapter's cursor at `at`; `tries`: times the page at `at` was asked again for not landing.
    let mark: { next?: string; at?: number; tries?: number } = {};
    try {
      mark = JSON.parse(t.walk || '{}') ?? {};
    } catch {
      /* none */
    }
    const cursor = skipWhole(this.store, cid, t.cursor ?? t.to_ts + 1);
    if (cursor <= t.from_ts) return (save({ cursor, state: 'done' }), { count: 0, done: true });
    const capped = !(JSON.parse(this.store.one<Row>('SELECT causes FROM catchup_hole WHERE id = ?', t.hole_id)?.causes ?? '[]') as string[]).includes('asked');
    if (capped && t.pages >= MAX_PAGES) return (save({ cursor, state: 'done', error: `Stopped after ${MAX_PAGES} pages; older messages in the stretch were not fetched` }), { count: 0, done: true });
    const p = await readPage(this.store, this.o, { accountId: t.account_id, cid, native, beforeTs: cursor, cursor: mark.next && mark.at === cursor ? mark.next : undefined });
    if (p.kind === 'defer') return { count: 0, done: false, deferMs: p.deferMs };
    // While it was out, the hole may have been stopped or planned again: what this page says is no longer the task's.
    // (Whatever it recorded whole stays: that is true of the chat, whoever asked.)
    const now_ = this.store.one<Row>('SELECT * FROM catchup_task WHERE hole_id = ? AND conversation_id = ?', t.hole_id, cid);
    const same = !!now_ && now_.state === 'queued' && now_.cursor === t.cursor && now_.walk === t.walk && now_.from_ts === t.from_ts && now_.to_ts === t.to_ts;
    if (p.kind === 'unlanded') {
      const tries = mark.at === cursor ? (mark.tries ?? 0) : 0;
      if (tries >= LAND_RETRIES) {
        if (same) save({ cursor, state: 'failed', error: NOT_LANDED, pages: 1 });
        return { count: p.count, done: true };
      }
      if (same) {
        save({ cursor, walk: { ...(mark.at === cursor && mark.next ? { next: mark.next } : {}), at: cursor, tries: tries + 1 } });
        // What it brought may still come and be stored, uncounted: this chat cannot say it was whole.
        this.store.db.query('UPDATE catchup_task SET unsure = 1 WHERE hole_id = ? AND conversation_id = ?').run(t.hole_id, cid);
      }
      return { count: p.count, done: false, deferMs: LAND_AGAIN_MS };
    }
    const found = p.fresh.filter((ts) => ts >= t.from_ts && ts <= t.to_ts).length;
    if (p.kind === 'failed') {
      if (same) save({ state: 'failed', error: p.error, pages: 1, found });
      return { count: p.count, done: true };
    }
    if (p.end) {
      if (same) save({ cursor: 0, state: 'done', pages: 1, found });
      return { count: p.count, done: true };
    }
    const done = p.oldest! <= t.from_ts;
    if (same) save({ cursor: p.oldest, walk: done || !p.next ? null : { next: p.next, at: p.oldest }, state: done ? 'done' : 'queued', pages: 1, found });
    return { count: p.count, done };
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
      // A chat that could not be read, or one a page's messages came late in (maybe uncounted), did not show it whole.
      const failed = sum(`probe = 1 AND (state != 'done' OR unsure = 1)`).n as number;
      if (found > 0 || failed > 0) {
        // Messages missing, or a chat that could not be checked: either way the first chats did not show it whole.
        notes.push(found > 0 ? `${plural(found, 'missing message')} in the first chats checked: fetching the rest` : `${plural(failed, 'chat')} of the first could not be checked: fetching the rest`);
        this.store.db.query(`UPDATE catchup_hole SET state = 'fetching', strength = 'likely', notes = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(notes.slice(-20)), now, holeId);
        // Its first chats may have been all it planned: then it is over now.
        h.state = 'fetching';
      } else {
        notes.push('The chats likeliest to have had messages then were whole, so the rest were not fetched');
        this.store.db.query(`UPDATE catchup_task SET state = 'skipped', why = 'the first chats checked were whole', updated_at = ? WHERE hole_id = ? AND state = 'queued'`).run(now, holeId);
        this.store.db.query(`UPDATE catchup_hole SET state = 'clear', notes = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(notes.slice(-20)), now, holeId);
        return;
      }
    }
    if (h.state === 'fetching' && !sum(`state = 'queued'`).n) {
      const failed = sum(`state = 'failed'`).n as number;
      if (failed) notes.push(`${plural(failed, 'chat')} could not be fetched`);
      this.store.db.query(`UPDATE catchup_hole SET state = 'done', notes = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(notes.slice(-20)), now, holeId);
    }
    else this.store.db.query('UPDATE catchup_hole SET updated_at = ? WHERE id = ?').run(now, holeId);
    // History you asked for is not a trouble at one time: only what the hub found looks for others near it.
    if (h.scope === 'chat' && !(JSON.parse(h.causes) as string[]).includes('asked') && sum('1').found > 0) this.nearby(h);
  }

  /** Several chats of one account missed messages around the same time: the account's other chats are checked too. */
  private nearby(h: Row) {
    const now = this.clock.now();
    // Each chat that was missing messages then, in holes of named chats (one hole may name many).
    const rows = this.store.raw<Row>(
      `SELECT MIN(t.from_ts) AS from_ts, MAX(t.to_ts) AS to_ts FROM catchup_task t JOIN catchup_hole h ON h.id = t.hole_id
       WHERE h.scope = 'chat' AND h.account_id = ? AND h.created_at >= ? AND t.from_ts <= ? AND t.to_ts >= ? AND t.found > 0 GROUP BY t.conversation_id`,
      h.account_id,
      now - DAY,
      h.to_ts + MERGE_MS,
      h.from_ts - MERGE_MS,
    );
    if (rows.length < NEARBY) return;
    const from = Math.min(...rows.map((r) => r.from_ts));
    const to = Math.max(...rows.map((r) => r.to_ts));
    // Once: an account hole of the last day already over this stretch, open or done, is enough.
    if (this.store.one(`SELECT 1 FROM catchup_hole WHERE scope = 'account' AND account_id = ? AND created_at >= ? AND from_ts <= ? AND to_ts >= ?`, h.account_id, now - DAY, to, from))
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
    // The stretch shown spans the account's and every named chat's.
    const named = Object.values(JSON.parse(h.named || '{}') as Named);
    const v: P.CatchUpHoleView = {
      id: h.id,
      scope: h.scope,
      accountId: h.account_id,
      accountName: acc?.label ?? '(removed)',
      network: (acc?.network as P.Network | undefined) ?? null,
      conversationId: h.conversation_id ?? null,
      conversationName: c?.name ?? null,
      named: named.length,
      from: Math.min(h.from_ts, ...named.map((n) => n.from)),
      to: Math.max(h.to_ts, ...named.map((n) => n.to)),
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
