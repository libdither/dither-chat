/**
 * Notices (docs/notices.md): what accounts and services tell you, from dither-accounts' `notifications` interface,
 * kept here, triaged with chat's model (triage.ts) and notified through chat's delivery (notify.ts Notifier.notice).
 *
 * remote.ts (RoutedSupervisor) tells this what the manager says (`NoticeSink`): the accounts with a notifications
 * grant, their events, a gap, the connection, and whether the grant was given. A demo hub has a fake source
 * (fake.ts) instead.
 *
 *  - **Catch-up** (`notify.list`, unread, since the oldest unread kept): when an account is first seen, after the
 *    connection came back, and after a gap. What it finds is rated but notifies nobody; what it no longer lists
 *    (read there meanwhile) is read here too, quietly.
 *  - **Live** (`notify.new`): kept, triaged, and notified if its tier says so. A repeat with nothing new is ignored;
 *    one with a newer time, or back unread, is triaged again; one a catch-up found first (so it notified nobody) is
 *    decided again, live, while it is unread and fresh. The local model is asked outside the queue, so a slow one
 *    holds up nothing else; each notice's own steps still go in order.
 *  - **Not a chat account's**: an account the hub also reads as chat (Telegram Desktop's popups) is left to chat.
 *  - **Read there** (`notify.read`): read here too, never notified; its notification leaves the phones once its group
 *    has nothing unread left (delivery.ts `read`, through `readTs`).
 *  - **Read here** (opening it, Mark read): read here, and `notify.markRead` upstream, best effort.
 *
 * Kept 30 days; a marked one while it is learned from. Marks (`ntc_` ids on POST /api/messages/:id/feedback) join
 * chat's examples (votes.ts `others`).
 */
import type * as P from '@dither-chat/protocol';
import { fit, type Grouped, type Line } from '../delivery.ts';
import { ALERT_BAR, voteWeight, type Example, type Facts } from '../learn.ts';
import { realClock, type Clock } from '../clock.ts';
import type { Store } from '../store.ts';
import type { Triage } from '../triage.ts';
import type { OtherVotes, TriageVotes } from '../votes.ts';
import { decideNotice, NOTICE_TRIAGE, sourceName, textOf, wantsJudge, type NoticeDecision, type NoticeInput, type NoticeRule, type Urgency } from './triage.ts';

type Row = Record<string, any>;

const DAY = 86_400_000;
/** How long a notice is kept. */
export const KEEP_MS = 30 * DAY;
/** A catch-up reads at most this many pages of this many. */
const PAGES = 10;
const PER_PAGE = 50;
/** Lines in a notification, as chat's. */
const LINES = 6;

/** An account the manager lists, as remote.ts's AccountView (as much as this reads). */
export interface NoticeAccountInfo {
  id: string;
  kind: string;
  label: string;
  interfaces: string[];
  grants: Record<string, string>;
}

/** What remote.ts tells notices about the manager (RoutedSupervisor.notices), as it tells mail. */
export interface NoticeSink {
  accounts(list: NoticeAccountInfo[]): void;
  /** Returns whether the account is one of notices'. */
  events(account: string, events: { t: string; [k: string]: unknown }[]): boolean;
  gap(account: string): boolean;
  connection(up: boolean): void;
  setAccess(state: P.NoticeAccessState): void;
}

/** The manager's side: calls, and asking for the grant again. */
export interface NoticeLink {
  call(account: string, op: string, input: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  askAgain?(): Promise<void>;
}

/** A notification main.ts sends (Notifier.notice). */
export interface NoticeDelivery {
  id: string;
  group: string;
  /** "<source> · <context>" */
  title: string;
  /** Its title, then its text. */
  body: string;
  reasons: string[];
  level: 'push' | 'digest';
  importance: number | null;
  /** About you by name (a mention, a review asked of you): what a device set to "Mentions only" still shows. */
  addressed: boolean;
  /** The start alone puts it on the list (phonelist.ts): not a low one, unless it is about you. */
  prior: boolean;
  look: { network: 'notice' };
}

export interface NoticesOpts {
  store: Store;
  triage: Triage;
  votes?: TriageVotes | null;
  link: NoticeLink;
  /** Sends its notification; false when nothing went out (the phone's list held it, or it came within ten minutes). */
  deliver?: (n: NoticeDelivery) => boolean;
  /** The manager's page (DITHER_ACCOUNTS_PUBLIC_URL), for "approve it there". */
  managerUrl?: string | null;
  /** Where access starts: a demo hub's fake source is granted from the start. */
  access?: P.NoticeAccessState;
  /** The time and the timers (the local model's wait): a test's own. */
  clock?: Clock;
}

const digest = (s: string) => Buffer.from(new Bun.CryptoHasher('sha256').update(s).digest().subarray(0, 12)).toString('base64url');
/** A notice's id: per account, from the extractor's own id. */
export const noticeId = (account: string, nativeId: string) => `ntc_${digest(`${account}\0${nativeId}`)}`;
/** Its group: per account, its context (a repository, an app), else its source. */
export const groupId = (account: string, key: string) => `ntg_${digest(`${account}\0${key}`)}`;

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x : null);
const URGENCIES = new Set(['high', 'normal', 'low']);

/** The interface's Notification, checked; null when it is not one. */
function parse(x: unknown): { id: string; source: string; title: string; body: string | null; url: string | null; reason: string | null; context: string | null; subject: unknown; actors: { name: string; url: string | null }[]; at: number; unread: boolean; urgency: Urgency } | null {
  const n = x as Record<string, any> | null;
  if (!n || typeof n !== 'object' || !str(n.id) || typeof n.title !== 'string' || typeof n.at !== 'number' || !Number.isFinite(n.at)) return null;
  const actors = Array.isArray(n.actors) ? n.actors.filter((a: any) => a && typeof a.name === 'string').map((a: any) => ({ name: a.name as string, url: str(a.url) })) : [];
  return {
    id: n.id,
    source: str(n.source) ?? 'unknown',
    title: n.title,
    body: str(n.body),
    url: typeof n.url === 'string' && /^https?:\/\//i.test(n.url) ? n.url : null,
    reason: str(n.reason),
    context: str(n.context),
    subject: n.subject && typeof n.subject === 'object' ? { kind: String(n.subject.kind ?? ''), title: String(n.subject.title ?? ''), url: str(n.subject.url), state: str(n.subject.state) } : null,
    actors: actors.slice(0, 10),
    at: n.at,
    unread: n.unread !== false,
    // Absent (or anything else) is normal: the interface added it later, as optional.
    urgency: URGENCIES.has(n.urgency) ? n.urgency : 'normal',
  };
}

export class Notices implements NoticeSink {
  private st: Store;
  private accountsById = new Map<string, NoticeAccountInfo>();
  /** Accounts caught up since the connection last came up. */
  private caught = new Set<string>();
  private catching = new Set<string>();
  private again = new Set<string>();
  private up = false;
  private state: P.NoticeAccessState;
  /** Everything that writes runs in order: catch-ups, live notices, reads. */
  private queue: Promise<void> = Promise.resolve();
  private now: () => number;
  private clock: Clock;
  /** Each notice's own steps (its local model's answer, then its decision), in order. */
  private steps = new Map<string, Promise<void>>();

  constructor(private o: NoticesOpts) {
    this.st = o.store;
    this.clock = o.clock ?? realClock;
    this.now = () => this.clock.now();
    this.state = o.access ?? 'unreachable';
    const v: OtherVotes = {
      examples: (at) => this.examples(at),
      mark: (id, m, at) => this.mark(id, m, at),
      names: { conversation: (id) => this.groupName(id), space: (id) => this.accountName(id) },
    };
    o.votes?.others.push(v);
    this.prune();
  }

  /** Catch-ups and local model's answers under way. */
  private busy = new Set<Promise<unknown>>();

  /** Resolves once the catch-ups and answers under way and everything queued are done (tests wait on it). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.busy.size) await Promise.all([...this.busy]);
      await this.queue;
      if (!this.busy.size) return;
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const q = p.finally(() => this.busy.delete(q));
    this.busy.add(q);
    return q;
  }

  private catchUpSoon(account: string) {
    void this.track(this.catchUp(account));
  }

  private run(what: string, fn: () => unknown): Promise<void> {
    this.queue = this.queue.then(fn).then(
      () => {},
      (e) => console.error(`notices: ${what} failed:`, e),
    );
    return this.queue;
  }

  // ---------------------------------------------------------- NoticeSink (remote.ts)

  accounts(list: NoticeAccountInfo[]) {
    // An account the hub reads as chat too (Telegram with Desktop's popups) is chat's: its messages notify there.
    const mine = list.filter((a) => a.interfaces.includes('notifications') && (a.grants.notifications === 'read' || a.grants.notifications === 'write') && !(a.interfaces.includes('chat') && a.grants.chat));
    this.accountsById = new Map(mine.map((a) => [a.id, a]));
    for (const id of [...this.caught]) if (!this.accountsById.has(id)) this.caught.delete(id);
    if (this.up) for (const a of mine) if (!this.caught.has(a.id)) this.catchUpSoon(a.id);
  }

  events(account: string, events: { t: string; [k: string]: unknown }[]): boolean {
    if (!this.accountsById.has(account)) return false;
    for (const e of events) {
      if (e.t === 'notify.new') this.run('a new notice', () => this.arrived(account, e.notification));
      else if (e.t === 'notify.read' && Array.isArray(e.ids)) this.run('a read', () => this.readThere(account, e.ids as unknown[]));
    }
    return true;
  }

  gap(account: string): boolean {
    if (!this.accountsById.has(account)) return false;
    this.caught.delete(account);
    this.catchUpSoon(account);
    return true;
  }

  connection(up: boolean) {
    this.up = up;
    if (!up) this.caught.clear();
    else for (const id of this.accountsById.keys()) if (!this.caught.has(id)) this.catchUpSoon(id);
  }

  setAccess(state: P.NoticeAccessState) {
    this.state = state;
  }

  access(): P.NoticeAccessState {
    return this.state;
  }

  askAgain(): Promise<void> {
    if (!this.o.link.askAgain) return Promise.reject(new Error('dither-accounts is not reachable'));
    return this.o.link.askAgain().then(() => this.setAccess('pending'));
  }

  // ---------------------------------------------------------- catch-up

  /**
   * notify.list, unread, since the oldest unread kept (else the newest kept): what it finds is rated quietly, and what
   * it does not list in the window it covered was read there meanwhile, so it is read here, quietly. Once at a time
   * per account; asked again meanwhile, once more after.
   */
  async catchUp(account: string): Promise<number> {
    if (this.catching.has(account)) {
      this.again.add(account);
      return 0;
    }
    this.catching.add(account);
    this.caught.add(account);
    let n = 0;
    try {
      const kept = this.st.db.query('SELECT MAX(at) AS newest, MIN(CASE WHEN unread = 1 THEN at END) AS unread FROM notice WHERE account = ?').get(account) as Row | null;
      const since: number | null = kept?.unread ?? kept?.newest ?? null;
      const started = this.now();
      const floor = started - KEEP_MS;
      const listed = new Set<string>();
      let oldest = Infinity;
      let whole = false;
      let token: string | null = null;
      for (let page = 0; page < PAGES; page++) {
        const input: Record<string, unknown> = { unreadOnly: true, limit: PER_PAGE, ...(since !== null ? { since } : {}), ...(token ? { pageToken: token } : {}) };
        const r = (await this.o.link.call(account, 'notify.list', input, 60_000)) as { notifications?: unknown[]; next?: string | null } | null;
        const list = Array.isArray(r?.notifications) ? r!.notifications : [];
        let old = false;
        await this.run('a catch-up', () => {
          for (const x of list) {
            const p = parse(x);
            if (!p) continue;
            if (p.at < floor) {
              old = true;
              continue;
            }
            listed.add(p.id);
            oldest = Math.min(oldest, p.at);
            if (this.keep(account, p, false)) n++;
          }
        });
        token = typeof r?.next === 'string' && r.next ? r.next : null;
        if (!token || old) {
          whole = true;
          break;
        }
      }
      // The window the listing covered: all of it, or (cut off after PAGES) from the oldest it reached. What is unread
      // here in it and was not listed was read there. Not what came here since the listing began.
      const from = whole ? Math.max(since ?? floor, floor) : oldest;
      if (from !== Infinity)
        await this.run('reads a catch-up found', () =>
          this.st.db
            .query(`UPDATE notice SET unread = 0, read_at = ? WHERE account = ? AND unread = 1 AND at >= ? AND at <= ? AND created_at < ? AND native_id NOT IN (SELECT value FROM json_each(?))`)
            .run(this.now(), account, from, started, started, JSON.stringify([...listed])),
        );
      this.prune();
    } catch (e) {
      // Tried again at the next connection, account list after this, or gap.
      this.caught.delete(account);
      console.warn(`notices: catching up ${account} failed: ${(e as Error)?.message ?? e}`);
    } finally {
      this.catching.delete(account);
    }
    if (this.again.delete(account)) n += await this.catchUp(account);
    return n;
  }

  // ---------------------------------------------------------- arrival

  /**
   * A live notice (in the queue): kept, then its own steps: the local model's answer (outside the queue, so a slow one
   * holds up nothing else), then its decision and notification (back in the queue). A newer arrival of the same
   * notice waits for the one before; a decision whose notice changed meanwhile is dropped for the newer one's.
   */
  private arrived(account: string, raw: unknown) {
    const p = parse(raw);
    if (!p) return;
    const id = this.keep(account, p, true);
    if (!id) return;
    const at = p.at;
    const prev = this.steps.get(id) ?? Promise.resolve();
    const step = this.track(
      prev
        .then(() => this.answer(id))
        .then((a) =>
          this.run('a decision', () => {
            const r = this.row(id);
            // Changed since (a newer arrival is deciding it), or decided already.
            if (!r || r.at !== at || r.decision != null) return;
            this.decideNow(id, a);
          }),
        )
        .catch((e) => console.error('notices: a decision failed:', e)),
    );
    this.steps.set(id, step);
    void step.finally(() => this.steps.get(id) === step && this.steps.delete(id));
  }

  /** The local model's answer for a kept notice, when it is one to ask. */
  private async answer(id: string): Promise<{ judge?: number; unjudged?: boolean }> {
    const r = this.row(id);
    if (!r) return {};
    const n = inputOf(r);
    if (!wantsJudge(n, { rule: this.ruleFor(r.grp, r.account), keyword: this.keywordIn(textOf(n)) })) return {};
    const j = await this.ask(textOf(n));
    if (j === undefined) return { unjudged: true };
    return j === null ? {} : { judge: Math.round(j * 1000) / 1000 };
  }

  /**
   * Keep a notice. Returns its id when it is new or new again (a newer time, or back unread), so it is triaged; null
   * when nothing changed that matters. What came by a catch-up is decided here, quietly.
   */
  private keep(account: string, p: NonNullable<ReturnType<typeof parse>>, live: boolean): string | null {
    const id = noticeId(account, p.id);
    const prev = this.st.db.query('SELECT at, unread, read_at, decision, delivered, caught FROM notice WHERE id = ?').get(id) as Row | null;
    // Read here and not raised again since: a catch-up still listing it unread (our markRead not there yet, failed, or
    // a read-only grant) does not make it unread.
    const readHere = !!prev && prev.read_at != null && p.at <= prev.at;
    const fresh = !prev || p.at > prev.at || (p.unread && !prev.unread && !readHere) || prev.decision == null;
    // A catch-up found it first, and so it notified nobody: the live one decides it again while it is unread and fresh.
    const late = live && !!prev && !fresh && prev.caught === 1 && !prev.delivered && prev.unread === 1 && p.unread && this.now() - p.at <= NOTICE_TRIAGE.freshMs;
    if (late) {
      this.st.db.query('UPDATE notice SET decision = NULL, caught = 0 WHERE id = ?').run(id);
      return id;
    }
    if (!fresh) {
      // Read there since: read here too.
      if (!p.unread && prev.unread) this.st.db.query('UPDATE notice SET unread = 0, read_at = ? WHERE id = ?').run(this.now(), id);
      return null;
    }
    const grp = groupId(account, p.context ?? p.source);
    this.st.db
      .query(
        `INSERT INTO notice (id, account, native_id, grp, source, title, body, url, reason, context, subject, actors, urgency, at, unread, read_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (id) DO UPDATE SET grp = excluded.grp, source = excluded.source, title = excluded.title, body = excluded.body, url = excluded.url,
           reason = excluded.reason, context = excluded.context, subject = excluded.subject, actors = excluded.actors, urgency = excluded.urgency,
           at = excluded.at, unread = excluded.unread, read_at = NULL, decision = NULL, delivered = 0, caught = 0`,
      )
      .run(id, account, p.id, grp, p.source, p.title.slice(0, 500), p.body?.slice(0, 2000) ?? null, p.url, p.reason, p.context, p.subject ? JSON.stringify(p.subject) : null, JSON.stringify(p.actors), p.urgency, p.at, p.unread ? 1 : 0, this.now());
    if (!live) this.decideNow(id, { catchUp: true });
    return id;
  }

  private decideNow(id: string, o: { judge?: number; unjudged?: boolean; catchUp?: boolean }): NoticeDecision | null {
    const r = this.row(id);
    if (!r) return null;
    const n = inputOf(r);
    const tr = this.o.triage;
    const now = this.now();
    const d = decideNotice(n, {
      model: tr.learned,
      thresholds: tr.thresholds(),
      namer: tr.namer,
      rule: this.ruleFor(r.grp, r.account),
      keyword: this.keywordIn(textOf(n)),
      quietHours: this.st.quietHours(),
      judge: o.judge,
      unjudged: o.unjudged,
      catchUp: o.catchUp,
      now,
    });
    const ok = d.hold === null && (d.decision === 'push' || d.decision === 'digest');
    // Kept first: the notification's lines read the group's decisions.
    this.st.db
      .query(`UPDATE notice SET decision = ?, importance = ?, alert = ?, reasons = ?, decided_by = ?, facts = ?, words = ?, delivered = 0, caught = ?, decided_at = ? WHERE id = ?`)
      .run(d.decision, d.importance, d.alert, JSON.stringify(d.reasons), d.decidedBy, d.facts ? JSON.stringify(d.facts) : null, JSON.stringify(d.words), o.catchUp ? 1 : 0, now, id);
    // An alert quiet hours held is counted for their summary, as chat's are.
    if (d.held) {
      const held = this.st.quietHeld();
      this.st.setQuietHeld({ count: (held?.count ?? 0) + 1, conversationId: r.grp, messageId: r.id });
    }
    // Delivered only when a notification really went out: what is read of it then takes it off the phones (readTs).
    if (ok && this.o.deliver?.(this.delivery(r, n, d))) this.st.db.query('UPDATE notice SET delivered = 1 WHERE id = ?').run(id);
    return d;
  }

  /** Ask the local model (triage.ts's, the stop-now question), for at most the time chat's triage waits. */
  private async ask(text: string): Promise<number | null | undefined> {
    const judge = this.o.triage.judge;
    const t = text.slice(0, NOTICE_TRIAGE.judgeChars).trim();
    if (!judge || !t) return null;
    let timer: unknown;
    try {
      return await Promise.race([
        judge(t).catch(() => null),
        new Promise<undefined>((r) => {
          timer = this.clock.setTimeout(() => r(undefined), this.o.triage.judgeTimeoutMs);
        }),
      ]);
    } finally {
      this.clock.clearTimeout(timer);
    }
  }

  /** A rule of yours on its group, else on its account. */
  private ruleFor(group: string, account: string): NoticeRule | null {
    const rules = this.st.rules();
    const g = rules.find((x) => x.scope === 'conversation' && x.target === group);
    const a = rules.find((x) => x.scope === 'account' && x.target === account);
    const lv = (l: string) => (l === 'all' || l === 'digest' || l === 'none' ? l : null);
    if (g && lv(g.level)) return { level: lv(g.level)!, source: 'this group of notices' };
    if (a && lv(a.level)) return { level: lv(a.level)!, source: `account ${this.accountsById.get(account)?.label ?? account}` };
    return null;
  }

  private keywordIn(text: string): string | null {
    const k = this.st.rules().find((r) => r.scope === 'keyword' && r.target && r.level === 'all' && new RegExp(`\\b${r.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
    return k?.target ?? null;
  }

  private delivery(r: Row, n: NoticeInput, d: NoticeDecision): NoticeDelivery {
    const mention = !!d.facts?.mention;
    return {
      id: r.id,
      group: r.grp,
      title: groupTitle(r.source, r.context),
      body: n.body ? `${n.title} — ${n.body}` : n.title,
      reasons: d.reasons,
      level: d.decision as 'push' | 'digest',
      importance: d.importance,
      addressed: mention,
      prior: n.urgency !== 'low' || mention,
      look: { network: 'notice' },
    };
  }

  // ---------------------------------------------------------- reads

  /** Read elsewhere (notify.read): read here, never notified. */
  private readThere(account: string, ids: unknown[]) {
    const mine = ids.filter((x): x is string => typeof x === 'string').map((x) => noticeId(account, x));
    if (!mine.length) return;
    this.st.db.query('UPDATE notice SET unread = 0, read_at = ? WHERE unread = 1 AND id IN (SELECT value FROM json_each(?))').run(this.now(), JSON.stringify(mine));
  }

  /** Read here (opened, or Mark read): and upstream, best effort. Returns false for no such notice. */
  markRead(id: string): boolean {
    const r = this.row(id);
    if (!r) return false;
    if (!r.unread) return true;
    this.st.db.query('UPDATE notice SET unread = 0, read_at = ? WHERE id = ?').run(this.now(), id);
    if (this.accountsById.get(r.account)?.grants.notifications === 'write') {
      this.o.link.call(r.account, 'notify.markRead', { ids: [r.native_id] }, 30_000).catch((e) => console.warn(`notices: marking read upstream failed: ${(e as Error)?.message ?? e}`));
    }
    return true;
  }

  // ---------------------------------------------------------- the page

  page(): P.NoticesPage {
    const rows = this.st.db.query('SELECT * FROM notice WHERE at >= ? ORDER BY at DESC LIMIT 300').all(this.now() - KEEP_MS) as Row[];
    return {
      access: this.state,
      managerUrl: this.o.managerUrl ?? null,
      accounts: [...this.accountsById.values()].map((a) => ({ id: a.id, kind: a.kind, label: a.label })),
      items: rows.map(viewOf),
    };
  }

  boot(): P.NoticesBoot {
    return { access: this.state };
  }

  view(id: string): P.NoticeView | null {
    const r = this.row(id);
    return r ? viewOf(r) : null;
  }

  // ---------------------------------------------------------- one notification per group (delivery.ts)

  /** A device rule's chain for a group (devices.ts): the group, its account, all notices. Null: not a group. */
  chain(group: string): string[] | null {
    if (!group.startsWith('ntg_')) return null;
    const r = this.st.db.query('SELECT account FROM notice WHERE grp = ? LIMIT 1').get(group) as Row | null;
    return [`conversation:${group}`, ...(r ? [`account:${r.account}`] : []), 'network:notice'];
  }

  /**
   * Read up to this time: just before the oldest unread notice in the group that a notification showed (delivery.ts
   * compares the newest shown). What notified nobody (a catch-up's, below the list) does not keep it showing.
   */
  readTs(group: string): number | null {
    if (!group.startsWith('ntg_')) return null;
    const r = this.st.db.query('SELECT MIN(at) AS at FROM notice WHERE grp = ? AND unread = 1 AND delivered = 1').get(group) as Row | null;
    return r?.at == null ? Number.MAX_SAFE_INTEGER : r.at - 1;
  }

  /** The group's unread notices, oldest first and ending with this one, as chat's lines (delivery.ts gather). */
  gather(group: string, id: string): Omit<Grouped, 'alert'> | null {
    if (!group.startsWith('ntg_')) return null;
    const own = this.row(id);
    if (!own) return null;
    const rows = this.st.db.query(`SELECT * FROM notice WHERE grp = ? AND at <= ? AND (unread = 1 OR id = ?) ORDER BY at DESC, id DESC LIMIT 40`).all(group, own.at, id) as Row[];
    const lines: Line[] = [];
    let count = 0;
    for (const r of rows) {
      const mine = r.id === id;
      count++;
      if (!mine && !['push', 'digest'].includes(r.decision)) continue;
      if (lines.length >= LINES && !mine) continue;
      lines.push(lineOf(r));
    }
    lines.reverse();
    const s = lineOf(own);
    return fit({ count, conv: { title: groupTitle(own.source, own.context), shape: 'group' }, sender: { name: s.author, key: s.key }, lines, icons: {} });
  }

  // ---------------------------------------------------------- votes (votes.ts `others`)

  /** A mark on a notice; undefined when the id is not a notice's. */
  mark(id: string, marks: P.TriageMarks, now = this.now()): P.TriageMarks | undefined {
    if (!id.startsWith('ntc_')) return undefined;
    const r = this.st.db.query('SELECT decision, alert_mark, less_mark FROM notice WHERE id = ?').get(id) as Row | null;
    if (!r?.decision) throw new Error('Triage never decided on this notice');
    if (r.decision === 'silent') throw new Error('These notices are muted: unmute them instead');
    let alert: number | null = r.alert_mark;
    let less: number | null = r.less_mark;
    if (marks.alert !== undefined) alert = marks.alert === null ? null : marks.alert ? 1 : 0;
    if (marks.less !== undefined) less = marks.less ? 1 : null;
    const any = alert !== null || less !== null;
    this.st.db.query('UPDATE notice SET alert_mark = ?, less_mark = ?, marked_at = ? WHERE id = ?').run(alert, less, any ? now : null, id);
    return { ...(alert !== null ? { alert: !!alert } : {}), ...(less ? { less: true } : {}) };
  }

  /** Every mark on a notice, as votes.ts examples. A notification left alone says nothing. */
  examples(now = this.now()): Example[] {
    const out: Example[] = [];
    for (const r of this.st.db.query('SELECT id, facts, words, alert_mark, less_mark, marked_at FROM notice WHERE marked_at IS NOT NULL AND facts IS NOT NULL ORDER BY marked_at DESC LIMIT 5000').all() as Row[]) {
      const y: Example['y'] = {};
      if (r.alert_mark != null) y.alert = r.alert_mark ? 1 : 0;
      if (r.less_mark) y.important = 0;
      if (!Object.keys(y).length) continue;
      out.push({ id: r.id, facts: json<Facts>(r.facts, null as any), words: json<string[]>(r.words, []), y, weight: voteWeight(r.marked_at, now), vote: true, at: r.marked_at });
    }
    return out.filter((e) => e.facts);
  }

  private groupName(id: string): string | null {
    if (!id.startsWith('ntg_')) return null;
    const r = this.st.db.query('SELECT source, context FROM notice WHERE grp = ? LIMIT 1').get(id) as Row | null;
    return r ? `notices from ${groupTitle(r.source, r.context)}` : 'a group of notices';
  }

  private accountName(id: string): string | null {
    const a = this.accountsById.get(id);
    return a ? `your ${a.label} notices` : null;
  }

  // ---------------------------------------------------------- upkeep

  /** Past 30 days they go, unless marked (learned from). */
  prune() {
    this.st.db.query('DELETE FROM notice WHERE at < ? AND marked_at IS NULL').run(this.now() - KEEP_MS);
  }

  private row(id: string): Row | null {
    return this.st.db.query('SELECT * FROM notice WHERE id = ?').get(id) as Row | null;
  }

  // ---------------------------------------------------------- routes (server.ts)

  /** /api/notices…; null when the path is not one of these. */
  async route(req: Request, url: URL): Promise<Response | null> {
    const ok = (x: unknown = { ok: true }) => Response.json(x);
    const bad = (error: string, status = 400) => Response.json({ error }, { status });
    const path = url.pathname;
    let m: RegExpMatchArray | null;
    if (path === '/api/notices' && req.method === 'GET') return ok(this.page());
    if ((m = path.match(/^\/api\/notices\/(ntc_[\w-]+)$/)) && req.method === 'GET') {
      const v = this.view(m[1]);
      return v ? ok(v) : bad('No such notice', 404);
    }
    if ((m = path.match(/^\/api\/notices\/(ntc_[\w-]+)\/read$/)) && req.method === 'POST') {
      if (!this.markRead(m[1])) return bad('No such notice', 404);
      return ok(this.view(m[1]));
    }
    if (path === '/api/notices/access/ask' && req.method === 'POST') {
      try {
        await this.askAgain();
        return ok({ access: this.state });
      } catch (e) {
        return bad((e as Error).message, 503);
      }
    }
    return null;
  }
}

/** "GitHub · owner/repo" */
export const groupTitle = (source: string, context: string | null) => (context ? `${sourceName(source)} · ${context}` : sourceName(source));

function lineOf(r: Row): Line {
  const actor = json<{ name: string }[]>(r.actors, [])[0];
  const author = actor?.name ?? sourceName(r.source);
  return { author, key: author, body: (r.body ? `${r.title} — ${r.body}` : r.title).slice(0, 200), ts: r.at };
}

function inputOf(r: Row): NoticeInput {
  return { group: r.grp, account: r.account, source: r.source, title: r.title, body: r.body, url: r.url, reason: r.reason, urgency: r.urgency, actors: json(r.actors, []), at: r.at, unread: !!r.unread };
}

function viewOf(r: Row): P.NoticeView {
  const facts = json<Partial<Facts> | null>(r.facts, null);
  return {
    id: r.id,
    accountId: r.account,
    source: r.source,
    context: r.context,
    group: r.grp,
    title: r.title,
    body: r.body,
    url: r.url,
    reason: r.reason,
    urgency: r.urgency,
    actors: json(r.actors, []),
    at: r.at,
    unread: !!r.unread,
    ...(r.decision
      ? {
          triage: {
            decision: r.decision,
            score: r.importance ?? null,
            reasons: json<string[]>(r.reasons, []),
            decidedBy: r.decided_by ?? 'rules',
            feedback: null,
            probs: r.alert != null && r.importance != null ? { alert: r.alert, important: r.importance } : null,
            ...(typeof facts?.judge === 'number' ? { judge: facts.judge, bar: ALERT_BAR.other } : {}),
            marks: { ...(r.alert_mark != null ? { alert: !!r.alert_mark } : {}), ...(r.less_mark ? { less: true } : {}) },
          } satisfies P.TriageView,
        }
      : {}),
  };
}
