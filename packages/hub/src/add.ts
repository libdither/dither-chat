/**
 * Adding (docs/add.md): what a pasted invite, address, name or handle is, joining and adding through one of your
 * accounts, and the requests waiting on you. Every call here starts with a click on the hub's page; nothing runs in
 * the background. Paced per account in a table, so a restart does not reset it.
 *
 * Its own tables (add_request, add_pace). The store hands it the requests events, the server its routes.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { ADD_ACTIONS, addCapability, addRefKey, describeAddRef, NETWORK_META, notBuiltLine, REQUEST_ANSWERS, validAddRef } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { AccountRow, Store } from './store.ts';

type Row = Record<string, any>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type PaceKind = 'resolve' | 'join' | 'connect';

/** How much each account may do, per window. Past it the hub answers 429 with when it frees up. */
export const ADD_LIMITS: Record<PaceKind, { windowMs: number; max: number; networks: Partial<Record<P.Network, number>> }> = {
  // WhatsApp looks a +phone up with a usync query, which it watches.
  resolve: { windowMs: HOUR, max: 60, networks: { whatsapp: 20 } },
  join: { windowMs: DAY, max: 10, networks: { whatsapp: 5 } },
  connect: { windowMs: DAY, max: 20, networks: {} },
};

/** How long the hub waits for the network. A join may wait on it (a Discord guild's first sync, a Matrix knock). */
export const ADD_TIMEOUTS = { resolve: 30_000, add: 90_000, answer: 90_000 };

/**
 * Previews kept in memory per account and reading, so an invite in a message that was looked up once shows again
 * (another page, a reload, another device) without asking the network or counting against the pace. Errors are not kept.
 */
export const PREVIEW_CACHE = { ttlMs: HOUR, max: 500, perRequest: 50 };

const REQUEST_KINDS: readonly P.RequestFact['kind'][] = ['friend', 'follow', 'invite', 'message', 'join'];

// ------------------------------------------------------------------ tables

const made = new WeakSet<Database>();
export function addTables(db: Database) {
  if (made.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS add_request (
    id             TEXT PRIMARY KEY,
    account_id     TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    native_id      TEXT NOT NULL,
    kind           TEXT NOT NULL,
    from_id        TEXT,
    target_kind    TEXT,
    target_native  TEXT,
    target_id      TEXT,
    target_name    TEXT,
    target_members INTEGER,
    ts             INTEGER NOT NULL,
    answers        TEXT NOT NULL,
    UNIQUE (account_id, native_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS add_request_target ON add_request(target_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS add_pace (
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    at         INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS add_pace_at ON add_pace(account_id, kind, at)');
  made.add(db);
}

const requestId = (accountId: string, nativeId: string) =>
  `req_${Buffer.from(new Bun.CryptoHasher('sha256').update(`${accountId}\0${nativeId}`).digest().subarray(0, 12)).toString('base64url')}`;

/**
 * A conversation an open message request is about: it stays out of the inbox and its notifications, and the hub
 * tells the network nothing about it (no read receipts, no typing) until it is accepted. Opening a request tells the
 * sender on Signal, Instagram, Messenger and X.
 */
export function requestHeld(db: Database, conversationId: string): boolean {
  addTables(db);
  return !!db.query(`SELECT 1 FROM add_request WHERE kind = 'message' AND target_kind = 'conversation' AND target_id = ? LIMIT 1`).get(conversationId);
}

export function requestViews(store: Store): P.RequestView[] {
  const db = store.db;
  addTables(db);
  const rows = db.query('SELECT r.*, a.network FROM add_request r JOIN account a ON a.id = r.account_id ORDER BY r.ts DESC').all() as Row[];
  const has = (kind: string, id: string) => !!db.query(`SELECT 1 FROM ${kind === 'space' ? 'space' : 'conversation'} WHERE id = ?`).get(id);
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    network: r.network,
    nativeId: r.native_id,
    kind: r.kind,
    from: r.from_id,
    target: r.target_kind ? { kind: r.target_kind, id: has(r.target_kind, r.target_id) ? r.target_id : null, name: r.target_name, members: r.target_members } : null,
    ts: r.ts,
    answers: JSON.parse(r.answers),
  }));
}

/** The requests list changed: one `requests` event goes with the next flush, and the places they hold are scored again. */
function requestsChanged(store: Store, held: Iterable<string>) {
  for (const id of held) if (store.db.query('SELECT 1 FROM conversation WHERE id = ?').get(id)) store.dirty.conversations.add(id);
  store.dirty.extra = store.dirty.extra.filter((e) => e.t !== 'requests');
  store.dirty.extra.push({ t: 'requests', requests: requestViews(store) });
}

const heldBy = (db: Database, accountId: string, nativeId?: string): string[] =>
  (db.query(`SELECT target_id FROM add_request WHERE account_id = ? AND (? IS NULL OR native_id = ?) AND kind = 'message' AND target_kind = 'conversation'`).all(accountId, nativeId ?? null, nativeId ?? null) as Row[]).map((r) => r.target_id);

/** A fact the adapter sent, if it is one: anything else is dropped. */
function validRequest(f: unknown): f is P.RequestFact {
  const r = f as P.RequestFact;
  return !!r && typeof r.nativeId === 'string' && !!r.nativeId && REQUEST_KINDS.includes(r.kind) && typeof r.ts === 'number' && Array.isArray(r.answers) && (r.from === undefined || typeof r.from === 'string') &&
    (r.target === undefined || ((r.target.kind === 'space' || r.target.kind === 'conversation') && typeof r.target.nativeId === 'string'));
}

function putRequest(store: Store, acc: AccountRow, f: P.RequestFact) {
  const t = f.target;
  const targetId = t ? hubId(t.kind === 'space' ? 'spc' : 'cnv', acc.network, t.nativeId) : null;
  store.db
    .query(
      `INSERT INTO add_request (id, account_id, native_id, kind, from_id, target_kind, target_native, target_id, target_name, target_members, ts, answers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, from_id = excluded.from_id, target_kind = excluded.target_kind, target_native = excluded.target_native,
         target_id = excluded.target_id, target_name = excluded.target_name, target_members = excluded.target_members, ts = excluded.ts, answers = excluded.answers`,
    )
    .run(
      requestId(acc.id, f.nativeId),
      acc.id,
      f.nativeId,
      f.kind,
      f.from ? store.ensureIdentity(acc, f.from) : null,
      t?.kind ?? null,
      t?.nativeId ?? null,
      targetId,
      typeof t?.name === 'string' ? t.name.slice(0, 200) : null,
      typeof t?.members === 'number' ? t.members : null,
      f.ts,
      JSON.stringify(f.answers.filter((a) => REQUEST_ANSWERS.includes(a))),
    );
  return targetId;
}

/** The requests events, inside the store's ingest. The list stays as it is until the adapter sends one of these. */
export function ingestRequests(store: Store, acc: AccountRow, ev: Extract<P.AdapterEvent, { t: 'requests' | 'request' | 'requestGone' }>) {
  const db = store.db;
  addTables(db);
  const held = new Set<string>();
  if (ev.t === 'requests') {
    if (!Array.isArray(ev.requests)) return;
    for (const id of heldBy(db, acc.id)) held.add(id);
    db.query('DELETE FROM add_request WHERE account_id = ?').run(acc.id);
    for (const f of ev.requests) if (validRequest(f)) held.add(putRequest(store, acc, f) ?? '');
  } else if (ev.t === 'request') {
    if (!validRequest(ev.request)) return;
    for (const id of heldBy(db, acc.id, ev.request.nativeId)) held.add(id);
    held.add(putRequest(store, acc, ev.request) ?? '');
  } else {
    for (const id of heldBy(db, acc.id, ev.nativeId)) held.add(id);
    if (!db.query('DELETE FROM add_request WHERE account_id = ? AND native_id = ?').run(acc.id, ev.nativeId).changes) return;
  }
  held.delete('');
  requestsChanged(store, held);
}

// ------------------------------------------------------------------ pacing

const paceOf = (action: P.AddAction): PaceKind => (action === 'join' || action === 'ask' ? 'join' : 'connect');

function inWords(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

const DID: Record<PaceKind, string> = { resolve: 'looked up', join: 'joined or asked to join', connect: 'added' };
const WHAT: Record<PaceKind, string> = { resolve: 'links and names', join: 'places', connect: 'people' };

/** Count one more for this account, or say when the next frees up. */
export function takePace(db: Database, acc: Pick<AccountRow, 'id' | 'network' | 'label'>, kind: PaceKind, now = Date.now()): { ok: true } | { ok: false; error: string; retryAt: number } {
  addTables(db);
  const l = ADD_LIMITS[kind];
  const max = l.networks[acc.network] ?? l.max;
  const since = now - l.windowMs;
  db.query('DELETE FROM add_pace WHERE account_id = ? AND kind = ? AND at <= ?').run(acc.id, kind, since);
  const rows = db.query('SELECT at FROM add_pace WHERE account_id = ? AND kind = ? ORDER BY at ASC').all(acc.id, kind) as Row[];
  if (rows.length >= max) {
    const retryAt = rows[rows.length - max].at + l.windowMs;
    const window = l.windowMs === HOUR ? 'hour' : 'day';
    return {
      ok: false,
      retryAt,
      error: `${NETWORK_META[acc.network].name} ${acc.label} has ${DID[kind]} ${max} ${WHAT[kind]} in the last ${window}, the most dither-chat lets one account. The next frees up in ${inWords(retryAt - now)}.`,
    };
  }
  db.query('INSERT INTO add_pace (account_id, kind, at) VALUES (?, ?, ?)').run(acc.id, kind, now);
  return { ok: true };
}

// ------------------------------------------------------------------ routes

export interface AddDeps {
  store: Store;
  online(accountId: string): boolean;
  command<T>(accountId: string, cmd: P.AdapterCommand extends infer C ? (C extends { id: string } ? Omit<C, 'id'> : C) : never, timeoutMs: number): Promise<T>;
  /** A line in the account's log on the hub. */
  note(accountId: string, line: string): void;
  /** Send what the adapter emitted before its reply, so the page has it. */
  flush(): void;
  /** This hub carries the account's live view now. */
  liveView(accountId: string): boolean;
  now?: () => number;
}

class AddError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const caps = (acc: AccountRow): P.Capability[] => JSON.parse(acc.capabilities || '[]');
const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export class Adding {
  constructor(private d: AddDeps) {
    addTables(d.store.db);
  }

  private now = () => this.d.now?.() ?? Date.now();

  /** /api/add/* and /api/requests*, or null for any other path. */
  async route(req: Request, url: URL, path: string): Promise<Response | null> {
    const method = req.method;
    const body = async <T>() => (await req.json().catch(() => ({}))) as T;
    let m: RegExpMatchArray | null;
    try {
      if (path === '/api/add/resolve' && method === 'POST') return Response.json(await this.resolve(await body()));
      if (path === '/api/add/cached' && method === 'POST') return Response.json(this.cachedPreviews(await body()));
      if (path === '/api/add' && method === 'POST') return Response.json(await this.add(await body()));
      if (path === '/api/requests' && method === 'GET') return Response.json({ requests: requestViews(this.d.store) });
      if ((m = path.match(/^\/api\/requests\/([\w-]+)$/)) && method === 'POST') return Response.json(await this.answer(m[1], await body()));
    } catch (e) {
      if (e instanceof AddError) return Response.json({ error: e.message, ...e.extra }, { status: e.status });
      throw e;
    }
    return path === '/api/add' || path.startsWith('/api/add/') || path.startsWith('/api/requests') ? Response.json({ error: 'not found' }, { status: 404 }) : null;
  }

  /** The account, the reading checked against it, and the account connected and able to do this; or why not. */
  private account(accountId: unknown, ref: unknown, need: (ref: P.AddRef) => [P.Capability, string]): [AccountRow, P.AddRef] {
    const acc = typeof accountId === 'string' ? this.d.store.account(accountId) : null;
    if (!acc) throw new AddError('no such account', 404);
    if (!validAddRef(ref)) throw new AddError("That isn't an invite, address or handle dither-chat can read", 400);
    if (ref.network !== acc.network) throw new AddError(`That is ${describeAddRef(ref)}, and ${acc.label} is a ${NETWORK_META[acc.network].name} account`, 400);
    const [cap, refused] = need(ref);
    if (!caps(acc).includes(cap)) throw new AddError(refused, 409);
    if (!this.d.online(acc.id)) throw new AddError(`${NETWORK_META[acc.network].name} ${acc.label} is not connected`, 409);
    return [acc, ref];
  }

  private pace(acc: AccountRow, kind: PaceKind) {
    const p = takePace(this.d.store.db, acc, kind, this.now());
    if (!p.ok) throw new AddError(p.error, 429, { retryAt: p.retryAt });
  }

  /** The network's own sentence, or what a timeout means for this step. */
  private async ask<T>(acc: AccountRow, cmd: Parameters<AddDeps['command']>[1], timeoutMs: number, acted: boolean): Promise<T> {
    try {
      return await this.d.command<T>(acc.id, cmd, timeoutMs);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const net = NETWORK_META[acc.network].name;
      if (/timed out/i.test(msg))
        throw new AddError(acted ? `${net} did not answer in ${timeoutMs / 1000} seconds. It may still have gone through: look again in a minute.` : `${net} did not answer in ${timeoutMs / 1000} seconds.`, 504);
      if (/disconnected|not connected/i.test(msg)) throw new AddError(`${net} ${acc.label} went offline before it answered${acted ? '; it may still have gone through' : ''}.`, 502);
      throw new AddError(msg, 502);
    }
  }

  async resolve(b: { accountId?: unknown; ref?: unknown }): Promise<P.AddPreviewView> {
    const [acc, ref] = this.account(b.accountId, b.ref, (r) => ['resolve', notBuiltLine(r)]);
    // Looked up within the hour: the same answer, without asking the network or counting against the pace.
    const kept = this.kept(acc.id, ref);
    if (kept) return this.preview(acc, ref, kept.raw);
    this.pace(acc, 'resolve');
    const r = (await this.ask<P.AddPreview>(acc, { t: 'resolve', ref }, ADD_TIMEOUTS.resolve, false)) ?? ({} as P.AddPreview);
    this.keep(acc.id, ref, r);
    this.d.flush();
    return this.preview(acc, ref, r);
  }

  // Previews kept for the hour (PREVIEW_CACHE), in insertion order: the least recently used goes first.
  private previews = new Map<string, { at: number; raw: P.AddPreview }>();
  private cacheKey = (accountId: string, ref: P.AddRef) => `${accountId}\u0000${addRefKey(ref)}`;

  private kept(accountId: string, ref: P.AddRef): { at: number; raw: P.AddPreview } | null {
    const k = this.cacheKey(accountId, ref);
    const hit = this.previews.get(k);
    if (!hit) return null;
    this.previews.delete(k);
    if (hit.at <= this.now() - PREVIEW_CACHE.ttlMs) return null;
    this.previews.set(k, hit);
    return hit;
  }

  private keep(accountId: string, ref: P.AddRef, raw: P.AddPreview) {
    const k = this.cacheKey(accountId, ref);
    this.previews.delete(k);
    this.previews.set(k, { at: this.now(), raw });
    for (const old of this.previews.keys()) {
      if (this.previews.size <= PREVIEW_CACHE.max) break;
      this.previews.delete(old);
    }
  }

  /**
   * POST /api/add/cached: what the hub already knows of these readings, from any account's look within the hour.
   * Nothing is asked of a network and nothing counts against the pace, so a page may call it for every invite it shows.
   */
  cachedPreviews(b: { refs?: unknown }): { previews: P.AddPreviewView[] } {
    if (!Array.isArray(b.refs) || b.refs.length > PREVIEW_CACHE.perRequest) throw new AddError(`refs: a list of up to ${PREVIEW_CACHE.perRequest} readings`, 400);
    const refs = b.refs.filter(validAddRef);
    const accounts = this.d.store.accounts();
    const previews: P.AddPreviewView[] = [];
    for (const ref of refs)
      for (const acc of accounts) {
        if (acc.network !== ref.network) continue;
        const hit = this.kept(acc.id, ref);
        if (hit) previews.push(this.preview(acc, ref, hit.raw));
      }
    return { previews };
  }

  /** A kept preview after acting on it: in it now, asked, or added. A check did nothing, so it stays as it was. */
  private acted(acc: AccountRow, ref: P.AddRef, action: P.AddAction, r: P.AddResult) {
    const hit = this.previews.get(this.cacheKey(acc.id, ref));
    if (!hit || r.check) return;
    const p = { ...hit.raw, actions: (Array.isArray(hit.raw.actions) ? hit.raw.actions : []).filter((a) => a !== action) };
    // The space when it is one, else the conversation: as a fresh look would say.
    if ((action === 'join' || action === 'ask') && !r.pending && (str(r.space) || str(r.conversation))) p.joined = str(r.space) ? { space: r.space } : { conversation: r.conversation };
    if (str(r.relationship)) p.relationship = r.relationship;
    if (r.pending) p.notes = [...(Array.isArray(p.notes) ? p.notes : []), ...(Array.isArray(r.notes) && r.notes.length ? r.notes : ['Asked; waiting on them'])];
    hit.raw = p;
  }

  /** In it already by the hub's own spaces and conversations, when the network's id for it is the one the hub keeps. */
  private joinedHere(net: P.Network, what: P.AddPreview['what'], nativeId: string | null): { space?: string; conversation?: string } | null {
    if (!nativeId || what === 'person') return null;
    const space = hubId('spc', net, nativeId);
    if (this.d.store.one('SELECT 1 FROM space WHERE id = ?', space)) return { space };
    const conversation = hubId('cnv', net, nativeId);
    if (this.d.store.one('SELECT 1 FROM conversation WHERE id = ?', conversation)) return { conversation };
    return null;
  }

  private preview(acc: AccountRow, ref: P.AddRef, r: P.AddPreview): P.AddPreviewView {
    const store = this.d.store;
    const net = acc.network;
    const have = caps(acc);
    const what = (['space', 'group', 'channel', 'room', 'person'] as const).includes(r.what) ? r.what : ref.kind === 'person' ? 'person' : 'group';
    const nativeId = str(r.nativeId);
    const identityId = what === 'person' && nativeId ? hubId('idn', net, nativeId) : null;
    const inviter = str(r.inviter) ? hubId('idn', net, r.inviter!) : null;
    const joined =
      r.joined && (str(r.joined.space) || str(r.joined.conversation))
        ? { ...(str(r.joined.space) ? { space: hubId('spc', net, r.joined.space!) } : {}), ...(str(r.joined.conversation) ? { conversation: hubId('cnv', net, r.joined.conversation!) } : {}) }
        : this.joinedHere(net, what, nativeId);
    const actions = (Array.isArray(r.actions) ? r.actions : []).filter((a, i, all) => ADD_ACTIONS.includes(a) && all.indexOf(a) === i && have.includes(addCapability(a)));
    return {
      accountId: acc.id,
      ref,
      what,
      name: str(r.name) ?? describeAddRef(ref),
      ...(r.partial ? { partial: true as const } : {}),
      nativeId,
      identityId,
      avatar: store.media(str(r.avatar), acc.id),
      description: str(r.description),
      members: num(r.members),
      online: num(r.online),
      joined,
      relationship: str(r.relationship) as P.PersonRelationship | null,
      actions,
      expires: num(r.expires),
      inviter,
      notes: Array.isArray(r.notes) ? r.notes.filter((n) => typeof n === 'string').slice(0, 8) : [],
      identities: store.identitiesByIds([inviter, identityId].filter((x): x is string => !!x)),
    };
  }

  async add(b: { accountId?: unknown; ref?: unknown; action?: unknown }): Promise<P.AddResultView> {
    const action = b.action as P.AddAction;
    if (!ADD_ACTIONS.includes(action)) throw new AddError('Join, ask, friend, follow or contact?', 400);
    if (action === 'message') throw new AddError('A message starts with POST /api/directs', 400);
    const [acc, ref] = this.account(b.accountId, b.ref, (r) => [addCapability(action), builtFor(r, action)]);
    this.pace(acc, paceOf(action));
    const r = (await this.ask<P.AddResult>(acc, { t: 'add', ref, action }, ADD_TIMEOUTS.add, true)) ?? {};
    this.d.note(acc.id, `[add] ${VERB[action]} ${describeAddRef(ref)}${outcome(r)}`);
    this.acted(acc, ref, action, r);
    return this.result(acc, r);
  }

  async answer(id: string, b: { answer?: unknown }): Promise<P.AddResultView> {
    const db = this.d.store.db;
    const row = db.query('SELECT r.*, a.network FROM add_request r JOIN account a ON a.id = r.account_id WHERE r.id = ?').get(id) as Row | null;
    if (!row) throw new AddError('That request is not waiting any more', 404);
    const answer = b.answer as P.RequestAnswer;
    if (!REQUEST_ANSWERS.includes(answer) || !(JSON.parse(row.answers) as P.RequestAnswer[]).includes(answer)) throw new AddError(`This request can be answered with ${(JSON.parse(row.answers) as string[]).join(', ') || 'nothing here'}`, 400);
    const acc = this.d.store.account(row.account_id)!;
    if (!caps(acc).includes('requests')) throw new AddError(`Answering ${NETWORK_META[acc.network].name} requests isn't built for this account yet`, 409);
    if (!this.d.online(acc.id)) throw new AddError(`${NETWORK_META[acc.network].name} ${acc.label} is not connected`, 409);
    const r = (await this.ask<P.AddResult>(acc, { t: 'answer', request: row.native_id, answer }, ADD_TIMEOUTS.answer, true)) ?? {};
    this.d.note(acc.id, `[add] ${answer === 'accept' ? 'accepted' : answer === 'decline' ? 'declined' : 'blocked'} the ${row.kind} request${row.target_name ? ` (${row.target_name})` : ''}${outcome(r)}`);
    // Answered: gone here now, whether or not the adapter says so too. A check did nothing, so it stays.
    if (!r.check) ingestRequests(this.d.store, acc, { t: 'requestGone', nativeId: row.native_id });
    return this.result(acc, r);
  }

  private result(acc: AccountRow, r: P.AddResult): P.AddResultView {
    const store = this.d.store;
    const net = acc.network;
    const conversationId = str(r.conversation) ? hubId('cnv', net, r.conversation!) : null;
    if (conversationId && store.db.query('SELECT 1 FROM conversation WHERE id = ?').get(conversationId)) store.touchConversation(conversationId);
    this.d.flush();
    const checks: P.AddCheck[] = ['captcha', 'verify', 'phone', 'rules'];
    return {
      accountId: acc.id,
      conversation: conversationId ? store.conversationView(conversationId) : null,
      spaceId: str(r.space) ? hubId('spc', net, r.space!) : null,
      identityId: str(r.identity) ? hubId('idn', net, r.identity!) : null,
      relationship: str(r.relationship) as P.PersonRelationship | null,
      pending: r.pending === true,
      check: checks.includes(r.check as P.AddCheck) ? r.check! : null,
      notes: Array.isArray(r.notes) ? r.notes.filter((n) => typeof n === 'string').slice(0, 8) : [],
      liveView: this.d.liveView(acc.id),
      managerUrl: store.accountView(acc).managedBy?.url ?? null,
    };
  }
}

const VERB: Record<Exclude<P.AddAction, 'message'>, string> = { join: 'joined', ask: 'asked to join', friend: 'sent a friend request to', follow: 'followed', contact: 'added as a contact' };
const outcome = (r: P.AddResult) => (r.check ? ` - ${r.check} check wanted first, nothing done` : r.pending ? ' - waiting on them' : '');

function builtFor(ref: P.AddRef, action: P.AddAction): string {
  return action === 'join' || action === 'ask' ? `Joining on ${NETWORK_META[ref.network].name} isn't built for this account yet` : `Adding people on ${NETWORK_META[ref.network].name} isn't built for this account yet`;
}
