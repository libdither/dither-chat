/**
 * Index jobs (docs/indexing.md): a server, a folder of servers or one conversation fetched whole through your
 * accounts, the way DiscordChatExporter pages a channel, and its members walked by name.
 *
 * A job's run is planned as tasks: one per conversation to page back to its start (channels, and the threads the hub
 * knows under them), one per space whose members to walk. Each account works through its tasks one at a time, the
 * highest priority job first, with a pause between requests on top of the adapter's own pacing (the Discord
 * extractor spaces requests out and backs off on a 429). Progress is in job_task, so a restart carries on.
 *
 * Pages are kept as history_span: stretches known whole. A conversation's walk skips any span it meets, so a job
 * that repeats fetches only what came since, and a channel already walked to its start costs one page.
 *
 * Threads: Discord's channel lists only the threads someone opened lately, so each channel's are listed first, active
 * then archived (DiscordChatExporter's route for user accounts), and every thread found gets a history task of its own.
 *
 * Members: a walk first asks for the most recently joined members a page at a time (Discord's op 35 lists the 10,000
 * newest, 1,000 a page, to an ordinary member too), which is the whole of a server up to that size. A bigger server,
 * or an adapter without that list, is walked by name prefix (a to z, 0 to 9: a user account may not send an empty
 * query, as discord.py-self's query_members insists), and a prefix that came back full is asked again one character
 * longer, so a big server is listed without one request asking for everyone.
 */
import type * as P from '@dither-chat/protocol';
import { randomId } from '@dither-chat/protocol/ids';
import { type Clock, realClock, sleep, unref } from './clock.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

const PAGE = 100;
/** Between requests per account, on top of the adapter's own pacing. */
export const PAUSE_MS = 1500;
/** How often the queue looks for work to start and repeating jobs that are due. */
const TICK_MS = 5000;
const WALK_LIMIT = 100;
const WALK_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** A name walk: every one-character prefix. */
export const WALK_PREFIXES = [...WALK_ALPHABET];
/** A walk's queue item for a page of recent members, then the page's start ('' for the first). Never a prefix: no '@' in WALK_ALPHABET. */
const RECENT = '@recent:';
/** How a walk starts: the recent members' first page. */
export const WALK_START = [RECENT];
/** The most recent members a network lists (Discord's op 35): a server bigger than this is walked by name. */
export const RECENT_MAX = 10_000;
/** Members a recent page holds at most. */
const RECENT_PAGE = 1000;
/** A prefix longer than this is not widened again: what is left is people with the same long name start. */
const WALK_DEPTH = 4;
/** How many times a channel's thread list waits for Discord to index it before going on without. */
const THREADS_WAITS = 10;
/** A page's messages may land just after its answer (remote accounts): looked for this often, this many times. */
const LAND_MS = 500;
const LAND_TRIES = 6;
/** Channels whose own history holds nothing: their posts are threads. */
const NO_MESSAGES = new Set(['forum', 'media']);
/** Channels that cannot have threads. */
const NO_THREADS = new Set(['voice', 'stage']);
const PRIORITY: Record<P.JobPriority, number> = { low: 0, normal: 1, high: 2 };

type Command = (accountId: string, cmd: any, timeoutMs?: number) => Promise<any>;

export interface JobsOptions {
  command: Command;
  /** The account's adapter is connected. */
  online: (accountId: string) => boolean;
  log?: (msg: string) => void;
  clock?: Clock;
}

export class Jobs {
  private clock: Clock;
  private log: (msg: string) => void;
  /** Accounts working now, and what on. */
  private working = new Map<string, { jobId: string; name: string }>();
  private timer: unknown = null;
  private stopped = false;

  constructor(
    private store: Store,
    private o: JobsOptions,
  ) {
    this.clock = o.clock ?? realClock;
    this.log = o.log ?? (() => {});
  }

  start() {
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.tick();
      this.timer = this.clock.setTimeout(loop, TICK_MS);
      unref(this.timer);
    };
    loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
  }

  // ------------------------------------------------------------------ the API

  list(): P.JobView[] {
    return (this.store.raw<Row>('SELECT * FROM job ORDER BY created_at DESC')).map((j) => this.view(j));
  }

  get(id: string): P.JobView | null {
    const j = this.store.one<Row>('SELECT * FROM job WHERE id = ?', id);
    return j ? this.view(j) : null;
  }

  create(spec: P.JobSpec): P.JobView {
    const t = spec.target;
    if (!t || !['space', 'folder', 'conversation'].includes(t.kind) || typeof t.id !== 'string') throw new Error('index what?');
    if (!spec.history && !spec.members) throw new Error('nothing to do: ask for history, members or both');
    if (!this.targetName(t.kind, t.id)) throw new Error(`no such ${t.kind}`);
    const repeat = typeof spec.repeatHours === 'number' && spec.repeatHours > 0 ? Math.max(1, spec.repeatHours) : null;
    const id = randomId('job');
    this.store.db
      .query('INSERT INTO job (id, target_kind, target_id, history, members, priority, repeat_hours, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, t.kind, t.id, spec.history ? 1 : 0, spec.members ? 1 : 0, PRIORITY[spec.priority ?? 'normal'] ?? 1, repeat, 'queued', this.clock.now());
    this.plan(id);
    this.tick();
    return this.get(id)!;
  }

  pause(id: string): P.JobView | null {
    this.store.db.query(`UPDATE job SET state = 'paused' WHERE id = ? AND state IN ('queued', 'running')`).run(id);
    return this.get(id);
  }

  resume(id: string): P.JobView | null {
    this.store.db.query(`UPDATE job SET state = 'queued' WHERE id = ? AND state = 'paused'`).run(id);
    this.tick();
    return this.get(id);
  }

  /** Start a finished job's next run now, rather than when it is due. */
  runNow(id: string): P.JobView | null {
    const j = this.store.one<Row>('SELECT state FROM job WHERE id = ?', id);
    if (!j) return null;
    if (j.state === 'done' || j.state === 'failed') this.rerun(id);
    else if (j.state === 'paused') this.resume(id);
    this.tick();
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.store.db.query('DELETE FROM job WHERE id = ?').run(id).changes > 0;
  }

  update(id: string, patch: { priority?: P.JobPriority; repeatHours?: number | null }): P.JobView | null {
    if (patch.priority && patch.priority in PRIORITY) this.store.db.query('UPDATE job SET priority = ? WHERE id = ?').run(PRIORITY[patch.priority], id);
    if (patch.repeatHours !== undefined) {
      const repeat = typeof patch.repeatHours === 'number' && patch.repeatHours > 0 ? Math.max(1, patch.repeatHours) : null;
      const j = this.store.one<Row>('SELECT finished_at FROM job WHERE id = ?', id);
      this.store.db.query('UPDATE job SET repeat_hours = ?, next_run_at = ? WHERE id = ?').run(repeat, repeat && j?.finished_at ? j.finished_at + repeat * 3_600_000 : null, id);
    }
    return this.get(id);
  }

  // ------------------------------------------------------------------ planning

  /** The conversations and spaces under a target: spaces walk space_edge down, threads hang off their channel. */
  places(kind: P.JobTargetKind, id: string): { conversations: string[]; spaces: string[] } {
    const spaces = new Set<string>();
    const conversations = new Set<string>();
    const roots: { kind: 'space' | 'conversation'; id: string }[] =
      kind === 'folder'
        ? this.store.raw<Row>(`SELECT item_kind, item_id FROM folder_item WHERE folder_id = ? AND item_kind IN ('space', 'conversation') ORDER BY position`, id).map((r) => ({ kind: r.item_kind, id: r.item_id }))
        : [{ kind, id }];
    let frontier = roots.filter((r) => r.kind === 'space').map((r) => r.id);
    for (const r of roots) if (r.kind === 'conversation') conversations.add(r.id);
    while (frontier.length) {
      const next: string[] = [];
      for (const sid of frontier) {
        if (spaces.has(sid)) continue;
        spaces.add(sid);
        for (const e of this.store.raw<Row>('SELECT child_kind, child_id FROM space_edge WHERE parent_id = ?', sid)) {
          if (e.child_kind === 'space') next.push(e.child_id);
          else conversations.add(e.child_id);
        }
      }
      frontier = next;
    }
    // Threads the hub knows, under each channel.
    for (const cid of [...conversations]) for (const t of this.store.raw<Row>(`SELECT id FROM conversation WHERE parent_id = ? AND shape = 'thread'`, cid)) conversations.add(t.id);
    // Only spaces that are communities have members of their own; sections are a community's categories.
    const communities = [...spaces].filter((s) => this.store.one<Row>(`SELECT 1 FROM space WHERE id = ? AND kind = 'community'`, s));
    return { conversations: [...conversations], spaces: communities };
  }

  /** The account to ask for a place: one that sees it, can do it, and is online if any is. */
  private accountFor(kind: 'space' | 'conversation', id: string, capability: P.Capability): string | null {
    const able = this.store.vantageAccounts(kind, id).filter((a) => this.can(a, capability));
    return able.find((a) => this.o.online(a)) ?? able[0] ?? null;
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

  /** This run's tasks, fresh: what the target holds now, so channels added since a last run are in this one. */
  private plan(jobId: string) {
    const j = this.store.one<Row>('SELECT * FROM job WHERE id = ?', jobId)!;
    const { conversations, spaces } = this.places(j.target_kind, j.target_id);
    let skipped = 0;
    const now = this.clock.now();
    this.store.db.transaction(() => {
      this.store.db.query('DELETE FROM job_task WHERE job_id = ?').run(jobId);
      const put = this.store.db.query('INSERT INTO job_task (job_id, kind, target_id, account_id, walk, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      if (j.history)
        for (const cid of conversations) {
          const c = this.store.one<Row>('SELECT shape, variant FROM conversation WHERE id = ?', cid);
          // Voice channels and the like hold no text worth paging; a category is not a conversation.
          if (!c || c.shape === 'self') continue;
          const acc = this.accountFor('conversation', cid, 'history');
          if (!acc) {
            skipped++;
            continue;
          }
          // A forum's or media channel's messages are its posts, which are threads: nothing of its own to page.
          if (!NO_MESSAGES.has(c.variant)) put.run(jobId, 'history', cid, acc, null, now);
          // A channel (not a thread, not a DM) may hold threads the hub never saw: listed first, where the account can.
          // Voice and stage channels have none (Discord refuses to list them: "Cannot execute action on this channel type").
          if (c.shape === 'channel' && !NO_THREADS.has(c.variant)) {
            const lister = this.accountFor('conversation', cid, 'listThreads');
            if (lister) put.run(jobId, 'threads', cid, lister, JSON.stringify({ archived: false, offset: 0 }), now);
          }
        }
      if (j.members)
        for (const sid of spaces) {
          const acc = this.accountFor('space', sid, 'walkMembers');
          if (!acc) {
            skipped++;
            continue;
          }
          put.run(jobId, 'members', sid, acc, JSON.stringify(WALK_START), now);
        }
      this.store.db.query('UPDATE job SET skipped = ?, error = NULL WHERE id = ?').run(skipped, jobId);
    })();
  }

  private rerun(jobId: string) {
    this.store.db.query(`UPDATE job SET state = 'queued', started_at = NULL, finished_at = NULL, next_run_at = NULL, error = NULL WHERE id = ?`).run(jobId);
    this.plan(jobId);
  }

  // ------------------------------------------------------------------ running

  /** Start repeating jobs that are due, and set every idle account with work going. */
  tick() {
    const now = this.clock.now();
    for (const j of this.store.raw<Row>(`SELECT id FROM job WHERE state IN ('done', 'failed') AND next_run_at IS NOT NULL AND next_run_at <= ?`, now)) this.rerun(j.id);
    // Nothing left to do (every task done while it was paused, or none planned): over.
    for (const j of this.store.raw<Row>(`SELECT id FROM job j WHERE state IN ('queued', 'running') AND NOT EXISTS (SELECT 1 FROM job_task t WHERE t.job_id = j.id AND t.done = 0)`)) this.finishIfDone(j.id);
    const accounts = this.store.raw<Row>(
      `SELECT DISTINCT t.account_id FROM job_task t JOIN job j ON j.id = t.job_id WHERE t.done = 0 AND j.state IN ('queued', 'running')`,
    );
    for (const a of accounts) {
      if (this.working.has(a.account_id) || !this.o.online(a.account_id)) continue;
      void this.work(a.account_id);
    }
  }

  /** The account's next task: highest priority job first, then oldest job, history before members. */
  private next(accountId: string): Row | null {
    return this.store.one<Row>(
      `SELECT t.*, j.id AS job FROM job_task t JOIN job j ON j.id = t.job_id
       WHERE t.account_id = ? AND t.done = 0 AND j.state IN ('queued', 'running')
       ORDER BY j.priority DESC, j.created_at, CASE t.kind WHEN 'threads' THEN 0 WHEN 'history' THEN 1 ELSE 2 END, t.target_id LIMIT 1`,
      accountId,
    );
  }

  private async work(accountId: string) {
    this.working.set(accountId, { jobId: '', name: '' });
    try {
      for (;;) {
        if (this.stopped || !this.o.online(accountId)) return;
        const t = this.next(accountId);
        if (!t) return;
        this.store.db.query(`UPDATE job SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND state = 'queued'`).run(this.clock.now(), t.job_id);
        this.working.set(accountId, { jobId: t.job_id, name: this.placeName(t.kind === 'members' ? 'space' : 'conversation', t.target_id) });
        try {
          if (t.kind === 'history') await this.page(t);
          else if (t.kind === 'threads') await this.threads(t);
          else await this.walk(t);
        } catch (e: any) {
          const msg = String(e?.message ?? e).slice(0, 300);
          this.log(`job ${t.job_id} ${t.kind} ${t.target_id}: ${msg}`);
          // A rate limit is the network asking for time, not the task failing: the adapter waits it out, so ask later.
          if (/rate.?limit|retry_after|429/i.test(msg)) await sleep(this.clock, 30_000);
          else this.store.db.query('UPDATE job_task SET done = 1, error = ?, updated_at = ? WHERE job_id = ? AND kind = ? AND target_id = ?').run(msg, this.clock.now(), t.job_id, t.kind, t.target_id);
        }
        this.finishIfDone(t.job_id);
        await sleep(this.clock, PAUSE_MS);
      }
    } finally {
      this.working.delete(accountId);
    }
  }

  private finishIfDone(jobId: string) {
    const left = this.store.one<Row>('SELECT COUNT(*) AS n, SUM(error IS NULL) AS ok FROM job_task WHERE job_id = ? AND done = 0', jobId)!;
    if (left.n) return;
    const all = this.store.one<Row>('SELECT COUNT(*) AS n, SUM(error IS NOT NULL) AS failed FROM job_task WHERE job_id = ?', jobId)!;
    const j = this.store.one<Row>('SELECT repeat_hours, state FROM job WHERE id = ?', jobId);
    if (!j || j.state === 'paused') return;
    const now = this.clock.now();
    const error = !all.n ? 'None of your accounts can fetch this.' : all.failed === all.n ? 'Every place failed.' : null;
    this.store.db
      .query('UPDATE job SET state = ?, finished_at = ?, next_run_at = ?, error = ? WHERE id = ?')
      .run(error ? 'failed' : 'done', now, j.repeat_hours ? now + j.repeat_hours * 3_600_000 : null, error, jobId);
  }

  // ------------------------------------------------------------------ history

  /** The span the ts falls in, from its top (exclusive of from_ts, inclusive of to_ts). */
  private spanAt(cid: string, ts: number): Row | null {
    return this.store.one<Row>('SELECT * FROM history_span WHERE conversation_id = ? AND from_ts < ? AND to_ts >= ? ORDER BY from_ts LIMIT 1', cid, ts, ts);
  }

  /** [from, to] is known whole: merged with any span it touches. */
  addSpan(cid: string, from: number, to: number) {
    this.store.db.transaction(() => {
      const touching = this.store.raw<Row>('SELECT * FROM history_span WHERE conversation_id = ? AND from_ts <= ? AND to_ts >= ?', cid, to, from);
      let lo = from;
      let hi = to;
      for (const s of touching) {
        lo = Math.min(lo, s.from_ts);
        hi = Math.max(hi, s.to_ts);
      }
      this.store.db.query('DELETE FROM history_span WHERE conversation_id = ? AND from_ts <= ? AND to_ts >= ?').run(cid, to, from);
      this.store.db.query('INSERT INTO history_span (conversation_id, from_ts, to_ts) VALUES (?, ?, ?)').run(cid, lo, hi);
    })();
  }

  /** One page back, skipping what spans say the hub has whole. */
  private async page(t: Row) {
    const cid = t.target_id as string;
    const native = this.store.nativeOf('conversation', cid)?.nativeId;
    if (!native) throw new Error('the conversation is gone');
    const save = (cursor: number | null, patch: { pages?: number; fetched?: number; done?: boolean } = {}) =>
      this.store.db
        .query('UPDATE job_task SET cursor = ?, pages = pages + ?, fetched = fetched + ?, done = ?, updated_at = ? WHERE job_id = ? AND kind = ? AND target_id = ?')
        .run(cursor, patch.pages ?? 0, patch.fetched ?? 0, patch.done ? 1 : 0, this.clock.now(), t.job_id, 'history', cid);
    let cursor: number = t.cursor ?? this.clock.now() + 1;
    // Over what is known whole already; a span reaching the start ends the walk.
    for (let s = this.spanAt(cid, cursor); s; s = this.spanAt(cid, cursor)) {
      if (s.from_ts === 0) return save(cursor, { done: true });
      cursor = s.from_ts;
    }
    const below = this.store.db.query('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND ts < ?');
    const before = (below.get(cid, cursor) as Row).n as number;
    const r = (await this.o.command(t.account_id, { t: 'history', conversation: native, beforeTs: cursor, limit: PAGE }, 180_000)) as P.HistoryResult | null;
    const count = r?.count ?? 0;
    let oldest: number | null = typeof r?.oldest === 'number' ? r.oldest : null;
    if (count && oldest === null) {
      // An adapter that does not say where its page ended: the page is the `count` newest messages below the cursor,
      // which the hub now holds (and maybe kept deleted ones among them, which only makes this a little late).
      const nth = () => (this.store.one<Row>('SELECT ts FROM message WHERE conversation_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1 OFFSET ?', cid, cursor, count - 1)?.ts as number | undefined) ?? null;
      oldest = nth();
      for (let i = 0; i < LAND_TRIES && oldest === null; i++) {
        await sleep(this.clock, LAND_MS);
        oldest = nth();
      }
    }
    const fetched = Math.max(0, ((below.get(cid, cursor) as Row).n as number) - before);
    if (!r || r.done || !count || oldest === null || oldest >= cursor) {
      // The start of the conversation: everything below the cursor is whole.
      this.addSpan(cid, 0, cursor);
      return save(cursor, { pages: 1, fetched, done: true });
    }
    this.addSpan(cid, oldest, cursor);
    save(oldest, { pages: 1, fetched });
  }

  // ------------------------------------------------------------------ members

  private async walk(t: Row) {
    const sid = t.target_id as string;
    const native = this.store.nativeOf('space', sid)?.nativeId;
    if (!native) throw new Error('the space is gone');
    let queue: string[] = [];
    try {
      queue = JSON.parse(t.walk || '[]');
    } catch {
      /* start over */
    }
    const save = (patch: { listed?: number; done?: boolean }) =>
      this.store.db
        .query('UPDATE job_task SET walk = ?, pages = pages + 1, fetched = fetched + ?, done = ?, updated_at = ? WHERE job_id = ? AND kind = ? AND target_id = ?')
        .run(JSON.stringify(queue), patch.listed ?? 0, patch.done || !queue.length ? 1 : 0, this.clock.now(), t.job_id, 'members', sid);
    const prefix = queue.shift();
    if (prefix === undefined) return save({ done: true });
    // A walk saved before walks stopped asking with an empty query.
    if (prefix === '') {
      queue.unshift(...WALK_PREFIXES.filter((c) => !queue.includes(c)));
      return save({});
    }
    if (prefix.startsWith(RECENT)) {
      const after = prefix.slice(RECENT.length) || undefined;
      const r = (await this.o.command(t.account_id, { t: 'walkMembers', space: native, query: '', limit: RECENT_PAGE, recent: true, ...(after ? { after } : {}) }, 60_000)) as P.WalkResult | null;
      const count = r?.count ?? 0;
      // No such list here (the answer has no `next`), or more members than it reaches: by name instead.
      if (r?.next === undefined || (typeof r.total === 'number' && r.total > RECENT_MAX)) queue.unshift(...WALK_PREFIXES);
      else if (typeof r.next === 'string' && r.next && count > 0) queue.unshift(RECENT + r.next);
      return save({ listed: count });
    }
    const r = (await this.o.command(t.account_id, { t: 'walkMembers', space: native, query: prefix, limit: WALK_LIMIT }, 60_000)) as P.WalkResult | null;
    const count = r?.count ?? 0;
    if (count >= WALK_LIMIT && prefix.length < WALK_DEPTH) queue.unshift(...[...WALK_ALPHABET, ' ', '_', '.'].map((c) => prefix + c));
    save({ listed: count });
  }

  // ------------------------------------------------------------------ threads

  /** One page of a channel's threads; at the end, a history task for each thread under it this run has none for. */
  private async threads(t: Row) {
    const cid = t.target_id as string;
    const native = this.store.nativeOf('conversation', cid)?.nativeId;
    if (!native) throw new Error('the conversation is gone');
    let at: { archived: boolean; offset: number; waits?: number } = { archived: false, offset: 0 };
    try {
      at = { ...at, ...JSON.parse(t.walk || '{}') };
    } catch {
      /* from the start */
    }
    const r = (await this.o.command(t.account_id, { t: 'threads', conversation: native, archived: at.archived, offset: at.offset }, 60_000)) as P.ThreadsResult | null;
    // Discord lists threads from its search index (202 while it builds it): the same page again after its wait, a few
    // times, then on as if there were none (the threads the hub knows still get their history tasks).
    if (r?.retryAfterMs && (at.waits ?? 0) < THREADS_WAITS) {
      at.waits = (at.waits ?? 0) + 1;
      this.store.db.query('UPDATE job_task SET walk = ?, updated_at = ? WHERE job_id = ? AND kind = ? AND target_id = ?').run(JSON.stringify(at), this.clock.now(), t.job_id, 'threads', cid);
      await sleep(this.clock, Math.min(r.retryAfterMs, 30_000));
      return;
    }
    const count = r?.count ?? 0;
    let done = false;
    if (count && r?.more) at.offset += count;
    else if (!at.archived) at = { archived: true, offset: 0 };
    else done = true;
    const now = this.clock.now();
    this.store.db
      .query('UPDATE job_task SET walk = ?, pages = pages + 1, fetched = fetched + ?, done = ?, updated_at = ? WHERE job_id = ? AND kind = ? AND target_id = ?')
      .run(JSON.stringify(at), count, done ? 1 : 0, now, t.job_id, 'threads', cid);
    if (!done) return;
    const put = this.store.db.query('INSERT OR IGNORE INTO job_task (job_id, kind, target_id, account_id, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const th of this.store.raw<Row>(`SELECT id FROM conversation WHERE parent_id = ? AND shape = 'thread'`, cid)) {
      const acc = this.accountFor('conversation', th.id, 'history') ?? t.account_id;
      put.run(t.job_id, 'history', th.id, acc, now);
    }
  }

  // ------------------------------------------------------------------ views

  private targetName(kind: string, id: string): string | null {
    if (kind === 'folder') return this.store.one<Row>('SELECT name FROM folder WHERE id = ?', id)?.name ?? null;
    return this.placeName(kind as 'space' | 'conversation', id) || null;
  }

  private placeName(kind: 'space' | 'conversation', id: string): string {
    const r = this.store.one<Row>(`SELECT name FROM ${kind === 'space' ? 'space' : 'conversation'} WHERE id = ?`, id);
    return r?.name ?? (kind === 'conversation' ? 'a conversation' : '');
  }

  private view(j: Row): P.JobView {
    const tasks = this.store.one<Row>(
      `SELECT COUNT(*) AS n, SUM(done) AS done, SUM(error IS NOT NULL) AS failed, SUM(CASE WHEN kind = 'history' THEN pages ELSE 0 END) AS pages,
              SUM(CASE WHEN kind = 'history' THEN fetched ELSE 0 END) AS fetched, SUM(CASE WHEN kind = 'members' THEN fetched ELSE 0 END) AS listed
       FROM job_task WHERE job_id = ?`,
      j.id,
    )!;
    const net = j.target_kind === 'folder' ? null : this.store.one<Row>(`SELECT network FROM ${j.target_kind === 'space' ? 'space' : 'conversation'} WHERE id = ?`, j.target_id)?.network ?? null;
    const current = [...this.working.values()].find((w) => w.jobId === j.id)?.name ?? null;
    return {
      id: j.id,
      target: { kind: j.target_kind, id: j.target_id, name: this.targetName(j.target_kind, j.target_id) ?? '(gone)', network: net },
      history: !!j.history,
      members: !!j.members,
      priority: (Object.keys(PRIORITY) as P.JobPriority[]).find((k) => PRIORITY[k] === j.priority) ?? 'normal',
      repeatHours: j.repeat_hours ?? null,
      state: j.state,
      createdAt: j.created_at,
      startedAt: j.started_at ?? null,
      finishedAt: j.finished_at ?? null,
      nextRunAt: j.next_run_at ?? null,
      tasks: tasks.n ?? 0,
      done: tasks.done ?? 0,
      failed: tasks.failed ?? 0,
      pages: tasks.pages ?? 0,
      fetched: tasks.fetched ?? 0,
      membersListed: tasks.listed ?? 0,
      current,
      skipped: j.skipped ?? 0,
      error: j.error ?? null,
    };
  }
}
