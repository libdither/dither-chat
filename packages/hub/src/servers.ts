/**
 * Servers beyond their channels (docs/servers.md): scheduled events kept as the adapters say them, saying Interested,
 * the calendar's feed of them, leaving a conversation or space, and answering what a space asks on joining (its
 * rules, an application, onboarding). Each passes on only what the network's rules and a fresh read say this account
 * may do, and a write only from a click on the hub's own page.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { gateAnswerProblem, NETWORK_META, nickProblem } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { AccountRow, Store } from './store.ts';

type Cmd =
  | { t: 'about'; target: P.AboutTarget }
  | { t: 'scheduledEvents'; space: string }
  | { t: 'rsvp'; space: string; event: string; occurrence?: string; interested: boolean }
  | { t: 'leave'; target: P.AboutTarget; silent?: boolean }
  | { t: 'gate'; space: string }
  | { t: 'answerGate'; space: string; answer: P.GateAnswer }
  | { t: 'setNick'; space: string; nick: string };

export interface ServersDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: Cmd, timeoutMs?: number) => Promise<T>;
  /** Which account speaks for a conversation, honouring a request. */
  pickAccount: (conversationId: string, requested?: string) => string | null;
  note?: (accountId: string, line: string) => void;
  flush?: () => void;
  now?: () => number;
  /** An About in hub terms, kept as the place page's (about.ts Abouts). */
  aboutView?: (kind: 'space', id: string, network: P.Network, accountId: string, about: P.About) => P.AboutView;
}

export class ServersError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const made = new WeakSet<Database>();

/** The tables: each account's events and gates as it last said them. */
export function serverTables(db: Database) {
  if (made.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_event (
    id          TEXT NOT NULL,
    account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    space_id    TEXT NOT NULL,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (id, account_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS scheduled_event_space ON scheduled_event(space_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS space_gate (
    space_id    TEXT NOT NULL,
    account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (space_id, account_id)
  )`);
  made.add(db);
}

const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

/** Is this a well formed event fact? Anything else is dropped, never kept half. */
function isEvent(e: unknown): e is P.ScheduledEventFact {
  const x = e as P.ScheduledEventFact;
  return !!x && typeof x === 'object' && typeof x.nativeId === 'string' && !!x.nativeId && typeof x.space === 'string' && typeof x.name === 'string' && typeof x.start === 'number' && Number.isFinite(x.start);
}

function putEvent(store: Store, acc: AccountRow, e: P.ScheduledEventFact, at: number) {
  if (e.creator) store.ensureIdentity(acc, e.creator);
  store.db
    .query('INSERT INTO scheduled_event (id, account_id, space_id, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id, account_id) DO UPDATE SET space_id = excluded.space_id, data = excluded.data, updated_at = excluded.updated_at')
    .run(hubId('evt', acc.network, e.nativeId), acc.id, hubId('spc', acc.network, e.space), JSON.stringify(e), at);
}

/** An adapter's scheduledEvents, scheduledEvent, scheduledEventGone and gate events (store.ts ingest). */
export function ingestServers(store: Store, acc: AccountRow, ev: P.AdapterEvent, now = Date.now()) {
  serverTables(store.db);
  const db = store.db;
  switch (ev.t) {
    case 'scheduledEvents': {
      const space = hubId('spc', acc.network, ev.space);
      db.query('DELETE FROM scheduled_event WHERE account_id = ? AND space_id = ?').run(acc.id, space);
      for (const e of Array.isArray(ev.events) ? ev.events : []) if (isEvent(e) && e.space === ev.space) putEvent(store, acc, e, now);
      break;
    }
    case 'scheduledEvent':
      if (isEvent(ev.event)) putEvent(store, acc, ev.event, now);
      break;
    case 'scheduledEventGone':
      db.query('DELETE FROM scheduled_event WHERE id = ? AND account_id = ?').run(hubId('evt', acc.network, ev.nativeId), acc.id);
      break;
    case 'gate': {
      const space = hubId('spc', acc.network, ev.space);
      if (ev.gate && typeof ev.gate === 'object') {
        db.query('INSERT INTO space_gate (space_id, account_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (space_id, account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(space, acc.id, JSON.stringify(ev.gate), now);
      } else db.query('DELETE FROM space_gate WHERE space_id = ? AND account_id = ?').run(space, acc.id);
      break;
    }
  }
}

/** Where a network's own app opens an event. */
function eventUrl(network: P.Network, spaceNative: string, eventNative: string): string | null {
  return network === 'discord' ? `https://discord.com/events/${spaceNative}/${eventNative}` : null;
}

/** An event in hub ids, as one account sees it. */
export function eventView(store: Store, accountId: string, network: P.Network, e: P.ScheduledEventFact, updatedAt: number): P.ScheduledEventView {
  const place: P.ScheduledEventView['place'] =
    e.place?.kind === 'external' ? { kind: 'external', location: String(e.place.location ?? '') } : e.place && (e.place.kind === 'voice' || e.place.kind === 'stage') ? { kind: e.place.kind, conversationId: hubId('cnv', network, e.place.conversation) } : null;
  return {
    id: hubId('evt', network, e.nativeId),
    nativeId: e.nativeId,
    network,
    spaceId: hubId('spc', network, e.space),
    name: e.name,
    description: e.description ?? null,
    start: e.start,
    end: e.end ?? null,
    status: e.status,
    place,
    image: e.imageUrl ? store.mediaUrl(e.imageUrl, accountId) : null,
    interested: typeof e.interested === 'number' ? e.interested : null,
    youInterested: typeof e.youInterested === 'boolean' ? e.youInterested : null,
    creatorId: e.creator ? hubId('idn', network, e.creator) : null,
    rrule: e.rrule ?? null,
    exceptions: Array.isArray(e.exceptions) ? e.exceptions : [],
    accountId,
    url: eventUrl(network, e.space, e.nativeId),
    updatedAt,
  };
}

/** Still to come (or on now) first, soonest first; then the rest, latest first. */
export function eventOrder(now: number) {
  const ahead = (v: P.ScheduledEventView) => v.status === 'active' || (v.status === 'scheduled' && (v.end ?? v.start) >= now) || (!!v.rrule && v.status !== 'cancelled');
  return (a: P.ScheduledEventView, b: P.ScheduledEventView) => {
    const x = ahead(a);
    const y = ahead(b);
    if (x !== y) return x ? -1 : 1;
    return x ? a.start - b.start : b.start - a.start;
  };
}

/** One event to the calendar's terms (protocol calendar.ts NetworkEventEntry). */
export function calendarEntry(store: Store, v: P.ScheduledEventView): P.NetworkEventEntry {
  const space = store.one<{ name: string }>('SELECT name FROM space WHERE id = ?', v.spaceId)?.name ?? NETWORK_META[v.network].name;
  const where =
    v.place?.kind === 'external'
      ? v.place.location
      : v.place
        ? `${store.one<{ name: string | null }>('SELECT name FROM conversation WHERE id = ?', v.place.conversationId)?.name ?? (v.place.kind === 'stage' ? 'Stage' : 'Voice channel')} · ${space}`
        : space;
  const ex = v.exceptions.filter((x) => typeof x.original === 'number');
  return {
    key: v.id,
    network: v.network,
    title: v.name.slice(0, 200) || '(No title)',
    description: v.description,
    location: where ? where.slice(0, 200) : null,
    allDay: false,
    startAt: v.start,
    endAt: v.end,
    timeZone: 'UTC',
    rrule: v.rrule,
    exdates: ex.filter((x) => x.cancelled).map((x) => x.original),
    moved: ex.filter((x) => !x.cancelled && typeof x.start === 'number').map((x) => ({ original: x.original, startAt: x.start!, endAt: x.end ?? null })),
    status: v.status,
    interested: v.youInterested,
    place: space,
    spaceId: v.spaceId,
    open: v.url,
    updatedAt: v.updatedAt,
  };
}

export class Servers {
  constructor(private d: ServersDeps) {
    serverTables(d.store.db);
  }

  private get now() {
    return this.d.now?.() ?? Date.now();
  }

  /** The account whose view a space is seen as: the one asked for if it is there, else one online, else any. */
  private spaceAccount(spaceId: string, requested?: string | null): string | null {
    const vs = this.d.store.vantageAccounts('space', spaceId);
    if (requested && vs.includes(requested)) return requested;
    return vs.find((a) => this.d.online(a)) ?? vs[0] ?? null;
  }

  private space(id: string): { network: P.Network; nativeId: string } {
    const t = this.d.store.nativeOf('space', id);
    if (!t) throw new ServersError('no such space', 404);
    return t;
  }

  /** The account, connected and able to do this; or why not. */
  private able(accountId: string | null, network: P.Network, cap: P.Capability, what: string): AccountRow {
    const net = NETWORK_META[network].name;
    if (!accountId) throw new ServersError('None of your accounts is in it.', 409);
    const acc = this.d.store.account(accountId)!;
    if (!caps(this.d.store, accountId).includes(cap)) throw new ServersError(`${what} on ${net} isn't built for this account yet.`, 409);
    if (!this.d.online(accountId)) throw new ServersError(`${net} · ${acc.label} is not connected`, 409);
    return acc;
  }

  // ------------------------------------------------------------ events

  /** The events one account keeps for a space, as views. */
  private kept(spaceId: string, accountId: string, network: P.Network): P.ScheduledEventView[] {
    const rows = this.d.store.db.query('SELECT data, updated_at FROM scheduled_event WHERE space_id = ? AND account_id = ?').all(spaceId, accountId) as { data: string; updated_at: number }[];
    const out: P.ScheduledEventView[] = [];
    for (const r of rows) {
      try {
        out.push(eventView(this.d.store, accountId, network, JSON.parse(r.data), r.updated_at));
      } catch {}
    }
    return out.sort(eventOrder(this.now));
  }

  /** GET /api/spaces/:id/events: kept, or with fresh asked again of the network first (opening its events list). */
  async events(spaceId: string, requested?: string | null, fresh = false): Promise<P.SpaceEventsView> {
    const t = this.space(spaceId);
    const accountId = this.spaceAccount(spaceId, requested);
    if (!accountId) return { events: [], canRsvp: false, accountId: null, stale: 'None of your accounts is in this space.' };
    const has = caps(this.d.store, accountId);
    let stale: string | undefined;
    if (fresh && has.includes('events') && this.d.online(accountId)) {
      try {
        const r = await this.d.command<P.ScheduledEventsResult>(accountId, { t: 'scheduledEvents', space: t.nativeId }, 30_000);
        ingestServers(this.d.store, this.d.store.account(accountId)!, { t: 'scheduledEvents', space: t.nativeId, events: r?.events ?? [] }, this.now);
      } catch (e) {
        stale = `Could not ask ${NETWORK_META[t.network].name}: ${(e as Error).message}`;
      }
    } else if (!this.d.online(accountId)) stale = `${NETWORK_META[t.network].name} · ${this.d.store.account(accountId)?.label} is not connected; this is what it said last.`;
    return { events: this.kept(spaceId, accountId, t.network), canRsvp: has.includes('rsvp') && this.d.online(accountId), accountId, ...(stale ? { stale } : {}) };
  }

  /** POST /api/spaces/:id/events/:eventId/rsvp { interested, occurrence?, accountId? } */
  async rsvp(spaceId: string, eventId: string, b: { interested?: unknown; occurrence?: unknown; accountId?: unknown }): Promise<P.ScheduledEventView> {
    const t = this.space(spaceId);
    if (typeof b.interested !== 'boolean') throw new ServersError('Say interested: true or false', 400);
    const accountId = this.spaceAccount(spaceId, typeof b.accountId === 'string' ? b.accountId : null);
    const acc = this.able(accountId, t.network, 'rsvp', 'Saying Interested');
    const row = this.d.store.one<{ data: string }>('SELECT data FROM scheduled_event WHERE id = ? AND account_id = ? AND space_id = ?', eventId, acc.id, spaceId);
    if (!row) throw new ServersError('No such event in this space', 404);
    const e = JSON.parse(row.data) as P.ScheduledEventFact;
    if (e.status === 'completed' || e.status === 'cancelled') throw new ServersError(e.status === 'cancelled' ? 'This event was called off' : 'This event is over', 409);
    const occurrence = typeof b.occurrence === 'string' && b.occurrence ? b.occurrence : undefined;
    if (occurrence && !e.rrule) throw new ServersError('This event does not repeat', 400);
    let after: P.ScheduledEventFact;
    try {
      after = await this.d.command<P.ScheduledEventFact>(acc.id, { t: 'rsvp', space: t.nativeId, event: e.nativeId, ...(occurrence ? { occurrence } : {}), interested: b.interested }, 30_000);
    } catch (err) {
      throw new ServersError(String((err as Error).message ?? err), 502);
    }
    const fact = isEvent(after) ? after : { ...e, ...(occurrence ? {} : { youInterested: b.interested }) };
    putEvent(this.d.store, acc, fact, this.now);
    this.d.note?.(acc.id, `[event] ${b.interested ? 'interested in' : 'no longer interested in'} ${e.name}${occurrence ? ' (one occurrence)' : ''}`);
    return eventView(this.d.store, acc.id, t.network, fact, this.now);
  }

  /** Every account's kept events, one view each (the account first seen for it), within [from, to). */
  allEvents(from: number | null, to: number | null): P.ScheduledEventView[] {
    const rows = this.d.store.db.query(`SELECT e.id, e.account_id, e.data, e.updated_at, a.network FROM scheduled_event e JOIN account a ON a.id = e.account_id ORDER BY e.id, e.updated_at DESC`).all() as {
      id: string;
      account_id: string;
      data: string;
      updated_at: number;
      network: P.Network;
    }[];
    const out: P.ScheduledEventView[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      let v: P.ScheduledEventView;
      try {
        v = eventView(this.d.store, r.account_id, r.network, JSON.parse(r.data), r.updated_at);
      } catch {
        continue;
      }
      // A repeating event stays in any window after its first start; the calendar expands it.
      const last = v.rrule ? Infinity : (v.end ?? v.start);
      if (from !== null && last < from) continue;
      if (to !== null && v.start >= to) continue;
      out.push(v);
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** GET /api/calendar/network-events?since=<ms>: what dither-calendar reads (protocol calendar.ts NetworkEvents). */
  calendarFeed(since: number): P.NetworkEvents {
    const events = this.allEvents(null, null)
      .filter((v) => v.updatedAt >= since)
      .map((v) => calendarEntry(this.d.store, v));
    return { now: this.now, events };
  }

  // ------------------------------------------------------------ leaving

  /** POST /api/(spaces|conversations)/:id/leave { accountId?, silent? }: through the account whose view it is. */
  async leave(kind: 'space' | 'conversation', id: string, b: P.LeaveRequest): Promise<P.LeaveResult> {
    const t = this.d.store.nativeOf(kind, id);
    if (!t) throw new ServersError(`no such ${kind}`, 404);
    const accountId = kind === 'space' ? this.spaceAccount(id, b.accountId) : this.d.pickAccount(id, b.accountId);
    const acc = this.able(accountId, t.network, 'leave', 'Leaving from here');
    const target = { kind, nativeId: t.nativeId };
    // Never on a stale answer: whether this account may leave (it owns it now?) can have changed since the page opened.
    const fresh = await this.d.command<P.About>(acc.id, { t: 'about', target }, 30_000).catch((e: Error) => {
      throw new ServersError(`Could not ask ${NETWORK_META[t.network].name}: ${e.message}`, 502);
    });
    const leaving = fresh?.leaving;
    if (!leaving?.can) throw new ServersError(leaving?.reason ?? `You cannot leave this ${kind} from here.`, 403);
    const silent = b.silent === true && leaving.silent === true;
    // Its name now: once left, the hub may forget it.
    const name = (kind === 'space' ? this.d.store.one<{ name: string }>('SELECT name FROM space WHERE id = ?', id) : this.d.store.one<{ name: string | null }>('SELECT name FROM conversation WHERE id = ?', id))?.name ?? kind;
    let r: P.LeaveResult;
    try {
      r = await this.d.command<P.LeaveResult>(acc.id, { t: 'leave', target, ...(silent ? { silent } : {}) }, 45_000);
    } catch (e) {
      throw new ServersError(String((e as Error).message ?? e), 502);
    }
    this.d.note?.(acc.id, `[leave] left ${name}${silent ? ' without telling the others' : ''}`);
    if (kind === 'space') this.d.store.db.query('DELETE FROM scheduled_event WHERE space_id = ? AND account_id = ?').run(id, acc.id);
    this.d.store.db.query('DELETE FROM space_gate WHERE space_id = ? AND account_id = ?').run(id, acc.id);
    return { left: r?.left !== false };
  }

  // ------------------------------------------------------------ nickname

  /** POST /api/spaces/:id/nick { nick, accountId? }: your own nickname there, when a fresh About says you may. */
  async setNick(spaceId: string, b: { nick?: unknown; accountId?: unknown }): Promise<P.AboutView | P.About> {
    const t = this.space(spaceId);
    const problem = nickProblem(b.nick);
    if (problem) throw new ServersError(problem, 400);
    const accountId = this.spaceAccount(spaceId, typeof b.accountId === 'string' ? b.accountId : null);
    const acc = this.able(accountId, t.network, 'nick', 'Setting your nickname');
    const fresh = await this.d.command<P.About>(acc.id, { t: 'about', target: { kind: 'space', nativeId: t.nativeId } }, 30_000).catch((e: Error) => {
      throw new ServersError(`Could not ask ${NETWORK_META[t.network].name}: ${e.message}`, 502);
    });
    if (!fresh?.nick?.canEdit) throw new ServersError(fresh?.nick?.reason ?? 'You cannot change your nickname here.', 403);
    let about: P.About;
    try {
      about = await this.d.command<P.About>(acc.id, { t: 'setNick', space: t.nativeId, nick: (b.nick as string).trim() }, 30_000);
    } catch (e) {
      throw new ServersError(String((e as Error).message ?? e), 502);
    }
    this.d.note?.(acc.id, `[nick] ${(b.nick as string).trim() ? 'set a nickname' : 'cleared the nickname'} in ${this.d.store.one<{ name: string }>('SELECT name FROM space WHERE id = ?', spaceId)?.name ?? 'a server'}`);
    const a = about && typeof about === 'object' && 'fields' in about ? about : fresh;
    return this.d.aboutView ? this.d.aboutView('space', spaceId, t.network, acc.id, a) : a;
  }

  // ------------------------------------------------------------ gates

  private keptGate(spaceId: string, accountId: string): P.SpaceGate | null {
    const r = this.d.store.one<{ data: string }>('SELECT data FROM space_gate WHERE space_id = ? AND account_id = ?', spaceId, accountId);
    try {
      return r ? (JSON.parse(r.data) as P.SpaceGate) : null;
    } catch {
      return null;
    }
  }

  /** GET /api/spaces/:id/gate: what it asks now, asked fresh when the account can; else what it said last. */
  async gate(spaceId: string, requested?: string | null): Promise<P.SpaceGateView> {
    const t = this.space(spaceId);
    const accountId = this.spaceAccount(spaceId, requested);
    if (!accountId) return { gate: null, accountId: null };
    const acc = this.d.store.account(accountId)!;
    if (!caps(this.d.store, accountId).includes('gates')) return { gate: this.keptGate(spaceId, accountId), accountId, reason: `Answering this from here isn't built for this ${NETWORK_META[t.network].name} account yet: open its live view.` };
    if (!this.d.online(accountId)) return { gate: this.keptGate(spaceId, accountId), accountId, reason: `${NETWORK_META[t.network].name} · ${acc.label} is not connected` };
    try {
      const gate = await this.d.command<P.SpaceGate | null>(accountId, { t: 'gate', space: t.nativeId }, 30_000);
      ingestServers(this.d.store, acc, { t: 'gate', space: t.nativeId, gate: gate ?? null }, this.now);
      return { gate: gate ?? null, accountId };
    } catch (e) {
      return { gate: this.keptGate(spaceId, accountId), accountId, reason: `Could not ask ${NETWORK_META[t.network].name}: ${(e as Error).message}` };
    }
  }

  /** POST /api/spaces/:id/gate { answer, accountId? }: the owner's own answer, checked against a fresh read first. */
  async answerGate(spaceId: string, b: { answer?: unknown; accountId?: unknown }): Promise<P.GateResult> {
    const t = this.space(spaceId);
    const answer = b.answer as P.GateAnswer;
    if (!answer || typeof answer !== 'object') throw new ServersError('What is the answer?', 400);
    const accountId = this.spaceAccount(spaceId, typeof b.accountId === 'string' ? b.accountId : null);
    const acc = this.able(accountId, t.network, 'gates', 'Answering this');
    const gate = await this.d.command<P.SpaceGate | null>(acc.id, { t: 'gate', space: t.nativeId }, 30_000).catch((e: Error) => {
      throw new ServersError(`Could not ask ${NETWORK_META[t.network].name}: ${e.message}`, 502);
    });
    if (!gate) throw new ServersError('It asks nothing of you now.', 409);
    const problem = gateAnswerProblem(gate, answer);
    if (problem) throw new ServersError(problem, 400);
    let r: P.GateResult;
    try {
      r = await this.d.command<P.GateResult>(acc.id, { t: 'answerGate', space: t.nativeId, answer }, 45_000);
    } catch (e) {
      throw new ServersError(String((e as Error).message ?? e), 502);
    }
    const next = r?.next ?? (r?.done ? null : gate);
    ingestServers(this.d.store, acc, { t: 'gate', space: t.nativeId, gate: r?.status === 'submitted' ? { ...gate, status: 'submitted' } : next }, this.now);
    const name = this.d.store.one<{ name: string }>('SELECT name FROM space WHERE id = ?', spaceId)?.name ?? 'a space';
    this.d.note?.(acc.id, `[join] ${gate.kind === 'rules' ? 'agreed to the rules of' : gate.kind === 'apply' ? 'applied to join' : 'answered onboarding in'} ${name}`);
    return { done: !!r?.done, ...(r?.status ? { status: r.status } : {}), next: next ?? null };
  }

  // ------------------------------------------------------------ routes

  static handles(path: string): boolean {
    return /^\/api\/spaces\/[\w-]+\/(events(\/[\w-]+\/rsvp)?|gate|leave|nick)$/.test(path) || /^\/api\/conversations\/[\w-]+\/leave$/.test(path) || path === '/api/events' || path === '/api/calendar/network-events';
  }

  async route(req: Request, url: URL, path: string): Promise<Response | null> {
    if (!Servers.handles(path)) return null;
    const method = req.method;
    const body = async <T>() => (await req.json().catch(() => ({}))) as T;
    const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : null);
    // A write is the owner's click on the hub's own page: a browser sends Origin, and the server has refused any other site's.
    const fromPage = () => {
      if (!req.headers.get('origin')) throw new ServersError('This is done from the app itself', 403);
    };
    let m: RegExpMatchArray | null;
    try {
      if (path === '/api/events' && method === 'GET') return Response.json({ events: this.allEvents(num('from'), num('to')) });
      if (path === '/api/calendar/network-events' && method === 'GET') return Response.json(this.calendarFeed(num('since') ?? 0));
      if ((m = path.match(/^\/api\/spaces\/([\w-]+)\/events$/)) && method === 'GET') return Response.json(await this.events(m[1], url.searchParams.get('account'), url.searchParams.get('fresh') === '1'));
      if ((m = path.match(/^\/api\/spaces\/([\w-]+)\/events\/([\w-]+)\/rsvp$/)) && method === 'POST') {
        fromPage();
        const v = await this.rsvp(m[1], m[2], await body());
        this.d.flush?.();
        return Response.json(v);
      }
      if ((m = path.match(/^\/api\/spaces\/([\w-]+)\/gate$/))) {
        if (method === 'GET') return Response.json(await this.gate(m[1], url.searchParams.get('account')));
        if (method === 'POST') {
          fromPage();
          const r = await this.answerGate(m[1], await body());
          this.d.flush?.();
          return Response.json(r);
        }
      }
      if ((m = path.match(/^\/api\/spaces\/([\w-]+)\/nick$/)) && method === 'POST') {
        fromPage();
        const v = await this.setNick(m[1], await body());
        this.d.flush?.();
        return Response.json(v);
      }
      if ((m = path.match(/^\/api\/(spaces|conversations)\/([\w-]+)\/leave$/)) && method === 'POST') {
        fromPage();
        const b = await body<P.LeaveRequest>();
        const r = await this.leave(m[1] === 'spaces' ? 'space' : 'conversation', m[2], { ...(typeof b.accountId === 'string' ? { accountId: b.accountId } : {}), ...(b.silent === true ? { silent: true } : {}) });
        this.d.flush?.();
        return Response.json(r);
      }
    } catch (e) {
      if (e instanceof ServersError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}
