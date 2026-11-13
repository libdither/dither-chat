/**
 * An account's own self (docs/account-self.md, protocol self.ts): what its network wants done (notices), its presence
 * and status, its folders and privacy as the network keeps them, where it is signed in, and ignoring someone (blocking
 * and network notes are people.ts's, shared with Signal). Every write starts with the owner's click; the one thing that runs by itself is the opt-in
 * "Do not disturb during quiet hours", which only an owner's tick turns on.
 *
 * Its own tables (account_self, person_ignore). The store hands it the events, the server its routes under /api/self/.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { bioLength, NETWORK_META, OWN_PRESENCE_STATES, SELF_LIMITS } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { inQuietHours } from './triage.ts';
import type { AccountRow, Store } from './store.ts';

type Row = Record<string, any>;

// ------------------------------------------------------------------ tables

const made = new WeakSet<Database>();
export function selfTables(db: Database) {
  if (made.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS account_self (
    account_id          TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
    notices             TEXT,
    presence            TEXT,
    folders             TEXT,
    privacy             TEXT,
    folders_imported_at INTEGER,
    dnd_quiet           INTEGER NOT NULL DEFAULT 0,
    dnd_restore         TEXT
  ) WITHOUT ROWID`);
  // Whom each account ignores on its network (the `ignored` events): the whole list each time.
  db.exec(`CREATE TABLE IF NOT EXISTS person_ignore (
    account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    identity_id TEXT NOT NULL,
    PRIMARY KEY (account_id, identity_id)
  ) WITHOUT ROWID`);
  db.exec('CREATE INDEX IF NOT EXISTS person_ignore_identity ON person_ignore(identity_id)');
  made.add(db);
}

const parse = <T>(s: string | null | undefined): T | undefined => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

const str = (x: unknown, max: number): string | undefined => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : undefined);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const NOTICE_KINDS: readonly P.AccountNotice['kind'][] = ['verify', 'agreements', 'standing', 'age', 'other'];

function cleanNotice(n: unknown): P.AccountNotice | null {
  const x = n as P.AccountNotice;
  const key = str(x?.key, 120);
  const title = str(x?.title, 120);
  const message = str(x?.message, 600);
  if (!key || !title || !message) return null;
  return { key, kind: NOTICE_KINDS.includes(x.kind) ? x.kind : 'other', title, message, ...(x.liveView ? { liveView: true } : {}), ...(num(x.since) ? { since: x.since } : {}) };
}

function cleanPresence(p: unknown): P.OwnPresence | undefined {
  const x = p as P.OwnPresence;
  if (!x || !OWN_PRESENCE_STATES.includes(x.state)) return undefined;
  const st = x.status && typeof x.status === 'object' ? x.status : undefined;
  const text = str(st?.text, 200);
  const emoji = str(st?.emoji, 80);
  const status = text || emoji ? { ...(text ? { text } : {}), ...(emoji ? { emoji } : {}), ...(num(st?.expiresAt) ? { expiresAt: st!.expiresAt } : {}) } : undefined;
  return { state: x.state, ...(num(x.until) ? { until: x.until } : {}), ...(status ? { status } : {}) };
}

function cleanFolders(f: unknown): P.NetworkFolder[] | undefined {
  if (!Array.isArray(f)) return undefined;
  return f
    .filter((x) => x && Array.isArray(x.spaces))
    .slice(0, 500)
    .map((x: P.NetworkFolder) => ({
      ...(str(x.id, 40) ? { id: str(x.id, 40) } : {}),
      ...(str(x.name, 100) ? { name: str(x.name, 100) } : {}),
      ...(typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color) ? { color: x.color } : {}),
      spaces: x.spaces.filter((s) => typeof s === 'string' && s).slice(0, 500),
    }));
}

function cleanFacts(f: unknown): P.SelfFact[] | undefined {
  if (!Array.isArray(f)) return undefined;
  return f.map((x) => ({ label: str(x?.label, 120), value: str(x?.value, 300) })).filter((x): x is P.SelfFact => !!x.label && !!x.value).slice(0, 40);
}

/** The self events, inside the store's ingest. */
export function ingestSelf(store: Store, acc: AccountRow, ev: P.SelfEvent) {
  const db = store.db;
  selfTables(db);
  db.query('INSERT OR IGNORE INTO account_self (account_id) VALUES (?)').run(acc.id);
  if (ev.t === 'notices') {
    if (!Array.isArray(ev.notices)) return;
    // A notice the hub had keeps the time it first came; one gone is gone, as the network no longer says it.
    const before = new Map((parse<(P.AccountNotice & { since: number })[]>((db.query('SELECT notices FROM account_self WHERE account_id = ?').get(acc.id) as Row).notices) ?? []).map((n) => [n.key, n.since]));
    const now = Date.now();
    const list = ev.notices.map(cleanNotice).filter((n): n is P.AccountNotice => !!n).slice(0, 20).map((n) => ({ ...n, since: before.get(n.key) ?? n.since ?? now }));
    db.query('UPDATE account_self SET notices = ? WHERE account_id = ?').run(list.length ? JSON.stringify(list) : null, acc.id);
  } else if (ev.t === 'selfState') {
    const s = ev.state ?? {};
    if (s.presence !== undefined) db.query('UPDATE account_self SET presence = ? WHERE account_id = ?').run(JSON.stringify(cleanPresence(s.presence) ?? null), acc.id);
    const folders = cleanFolders(s.folders);
    if (folders) db.query('UPDATE account_self SET folders = ? WHERE account_id = ?').run(JSON.stringify(folders), acc.id);
    const privacy = cleanFacts(s.privacy);
    if (privacy) db.query('UPDATE account_self SET privacy = ? WHERE account_id = ?').run(JSON.stringify(privacy), acc.id);
  } else if (ev.t === 'ignored') {
    if (!Array.isArray(ev.identities)) return;
    db.query('DELETE FROM person_ignore WHERE account_id = ?').run(acc.id);
    const put = db.query('INSERT OR IGNORE INTO person_ignore (account_id, identity_id) VALUES (?, ?)');
    for (const n of ev.identities) if (typeof n === 'string' && n) put.run(acc.id, store.ensureIdentity(acc, n));
  }
  store.accountChanged(acc.id);
}

/** AccountView.self, or nothing while the network has said none of it. */
export function accountSelfView(store: Store, accountId: string): { self?: P.AccountSelfView } {
  const db = store.db;
  selfTables(db);
  const r = db.query('SELECT * FROM account_self WHERE account_id = ?').get(accountId) as Row | null;
  if (!r) return {};
  const net = store.account(accountId)?.network;
  const presence = parse<P.OwnPresence | null>(r.presence) ?? undefined;
  const folders = parse<P.NetworkFolder[]>(r.folders);
  const privacy = parse<P.SelfFact[]>(r.privacy);
  const known = (native: string) => {
    const id = net ? hubId('spc', net, native) : null;
    return id && db.query('SELECT 1 FROM space WHERE id = ?').get(id) ? id : null;
  };
  return {
    self: {
      notices: parse(r.notices) ?? [],
      ...(presence ? { presence } : {}),
      ...(folders ? { folders: folders.map((f) => ({ name: f.name ?? null, ...(f.color ? { color: f.color } : {}), spaces: f.spaces.map(known).filter((x): x is string => !!x) })) } : {}),
      ...(r.folders_imported_at ? { foldersImportedAt: r.folders_imported_at } : {}),
      ...(privacy?.length ? { privacy } : {}),
      ...(r.dnd_quiet ? { dndQuietHours: true } : {}),
    },
  };
}

/**
 * Why a message from this identity must not alert, if it must not: an account of yours ignores them on their network.
 * Asked by triage before anything else weighs the message (a block is triage's own blockedByYou, before this).
 */
export function quietAuthor(db: Database, identityId: string | null): string | null {
  if (!identityId) return null;
  selfTables(db);
  if (db.query('SELECT 1 FROM person_ignore WHERE identity_id = ? LIMIT 1').get(identityId)) return 'You ignore them';
  return null;
}

/** Your accounts that ignore these identities (ProfileView.ignored). */
export function ignoredOf(db: Database, identityIds: string[]): { accountId: string; identityId: string }[] {
  selfTables(db);
  return (db.query('SELECT account_id, identity_id FROM person_ignore WHERE identity_id IN (SELECT value FROM json_each(?)) ORDER BY account_id').all(JSON.stringify(identityIds)) as Row[]).map((r) => ({ accountId: r.account_id, identityId: r.identity_id }));
}

// ------------------------------------------------------------------ actions

export interface SelfDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: any, timeoutMs?: number) => Promise<T>;
  note: (accountId: string, line: string) => void;
  flush: () => void;
  /** Quiet hours as set (triage.ts), for the opt-in Do not disturb. */
  quietHours: () => P.QuietHours | null;
}

export class SelfError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const caps = (acc: AccountRow): P.Capability[] => {
  try {
    return JSON.parse(acc.capabilities);
  } catch {
    return [];
  }
};

/** How often the quiet-hours opt-in looks. A failed change waits this long times ten before it is tried again. */
export const DND_TICK_MS = 60_000;

export class AccountSelf {
  private timer: ReturnType<typeof setInterval> | null = null;
  private dndFailedAt = new Map<string, number>();

  constructor(private d: SelfDeps) {
    selfTables(d.store.db);
  }

  /** The quiet-hours opt-in's clock. Does nothing for an account that did not opt in. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), DND_TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private label(acc: AccountRow) {
    return `${NETWORK_META[acc.network].name} · ${acc.label}`;
  }

  /** The account, connected and able to do this; or why not. */
  private ready(accountId: string, cap: P.Capability, what: string): AccountRow {
    const acc = this.d.store.account(accountId);
    if (!acc) throw new SelfError('No such account', 404);
    if (!caps(acc).includes(cap)) throw new SelfError(`${what} is not something ${this.label(acc)} can do from here`, 409);
    if (!this.d.online(acc.id)) throw new SelfError(`${this.label(acc)} is not connected`, 409);
    return acc;
  }

  /** Which of your accounts acts on someone: the one asked for, else one on their network that can, connected, that has them on its list or shares a chat. */
  private accountFor(identityId: string, cap: P.Capability, what: string, asked: unknown): { acc: AccountRow; native: string } {
    const s = this.d.store;
    const who = s.nativeOf('identity', identityId);
    if (!who) throw new SelfError('No such person', 404);
    if (typeof asked === 'string' && asked) {
      const acc = this.ready(asked, cap, what);
      if (acc.network !== who.network) throw new SelfError(`${this.label(acc)} is not on ${NETWORK_META[who.network].name}`, 400);
      return { acc, native: who.nativeId };
    }
    const able = s.accounts().filter((a) => a.network === who.network && caps(a).includes(cap) && this.d.online(a.id) && a.self_identity !== identityId);
    if (!able.length) throw new SelfError(`No connected ${NETWORK_META[who.network].name} account can ${what.toLowerCase()} here`, 409);
    const near = able.find((a) => s.db.query('SELECT 1 FROM vantage v JOIN participant p ON p.conversation_id = v.target_id WHERE v.account_id = ? AND p.identity_id = ? LIMIT 1').get(a.id, identityId));
    return { acc: near ?? able[0], native: who.nativeId };
  }

  private async ask<T>(acc: AccountRow, cmd: P.SelfCommand extends infer C ? (C extends { id: string } ? Omit<C, 'id'> : never) : never, timeoutMs = 60_000): Promise<T> {
    try {
      return (await this.d.command<T>(acc.id, cmd, timeoutMs)) as T;
    } catch (e) {
      throw new SelfError(`${NETWORK_META[acc.network].name} did not take it: ${(e as Error).message}`, 502);
    }
  }

  /** Ignore someone or stop (capability 'ignore'). The account's `ignored` event follows; the hub's list waits for it. */
  async ignore(identityId: string, b: { ignored?: unknown; accountId?: unknown }): Promise<{ ignored: boolean }> {
    if (typeof b.ignored !== 'boolean') throw new SelfError('Say ignored: true or false');
    const { acc, native } = this.accountFor(identityId, 'ignore', 'Ignoring people', b.accountId);
    const r = (await this.ask<{ ignored?: unknown }>(acc, { t: 'ignore', identity: native, ignored: b.ignored })) ?? {};
    const now = typeof r.ignored === 'boolean' ? r.ignored : b.ignored;
    // Said at once here too, so a message right after already stays quiet; the list event says the same.
    if (now) this.d.store.db.query('INSERT OR IGNORE INTO person_ignore (account_id, identity_id) VALUES (?, ?)').run(acc.id, identityId);
    else this.d.store.db.query('DELETE FROM person_ignore WHERE account_id = ? AND identity_id = ?').run(acc.id, identityId);
    this.d.note(acc.id, `[self] ${now ? 'ignored' : 'stopped ignoring'} someone`);
    this.d.flush();
    return { ignored: now };
  }

  /** Your presence and status line (capability 'setPresence'). */
  async setPresence(accountId: string, b: { state?: unknown; status?: unknown }): Promise<P.OwnPresence> {
    const acc = this.ready(accountId, 'setPresence', 'Setting your status');
    const change: P.PresenceChange = {};
    if (b.state !== undefined) {
      if (!OWN_PRESENCE_STATES.includes(b.state as P.OwnPresenceState)) throw new SelfError(`state: ${OWN_PRESENCE_STATES.join(', ')}`);
      change.state = b.state as P.OwnPresenceState;
    }
    if (b.status !== undefined) {
      if (b.status === null) change.status = null;
      else {
        const st = b.status as P.OwnStatus;
        const text = typeof st?.text === 'string' ? st.text.trim() : '';
        const emoji = typeof st?.emoji === 'string' ? st.emoji.trim() : '';
        const limit = SELF_LIMITS[acc.network]?.statusText;
        if (limit && bioLength(text) > limit) throw new SelfError(`Too long for ${NETWORK_META[acc.network].name}: ${bioLength(text)} characters, and a status takes ${limit}`);
        if (st?.expiresAt !== undefined && (!num(st.expiresAt) || st.expiresAt <= Date.now())) throw new SelfError('expiresAt: a time to come');
        change.status = text || emoji ? { ...(text ? { text } : {}), ...(emoji ? { emoji: emoji.slice(0, 80) } : {}), ...(st.expiresAt ? { expiresAt: st.expiresAt } : {}) } : null;
      }
    }
    if (change.state === undefined && change.status === undefined) throw new SelfError('Nothing to change: say state, status or both');
    const r = cleanPresence(await this.ask<P.OwnPresence>(acc, { t: 'setPresence', change }));
    if (r) ingestSelf(this.d.store, acc, { t: 'selfState', state: { presence: r } });
    // The owner chose a state themselves: the quiet-hours opt-in does not put back what it had before.
    if (change.state) this.d.store.db.query('UPDATE account_self SET dnd_restore = NULL WHERE account_id = ?').run(acc.id);
    this.d.flush();
    return r ?? { state: change.state ?? 'online' };
  }

  /** Where the account is signed in (capability 'sessions'), asked as the owner opens the list. */
  async sessions(accountId: string): Promise<P.SessionsResult> {
    const acc = this.ready(accountId, 'sessions', 'Listing where you are signed in');
    const r = (await this.ask<P.SessionsResult>(acc, { t: 'sessions' }, 30_000)) ?? { sessions: [] };
    return { sessions: Array.isArray(r.sessions) ? r.sessions.filter((x) => x && typeof x.id === 'string').slice(0, 100) : [] };
  }

  /**
   * The network's folders made into dither folders, once, on the owner's click. Nothing the owner arranged moves: a
   * space already in one of their folders stays there, and only new folders are added after theirs.
   */
  importFolders(accountId: string): P.FolderImportResult {
    const s = this.d.store;
    const acc = s.account(accountId);
    if (!acc) throw new SelfError('No such account', 404);
    const view = accountSelfView(s, accountId).self;
    if (!view?.folders) throw new SelfError(`${this.label(acc)} has not said its folders`, 409);
    const existing = s.folders();
    const placed = new Set(existing.flatMap((f) => f.items.filter((i) => i.kind === 'space').map((i) => i.id)));
    const made: { name: string; color: string | null; spaces: string[] }[] = [];
    const skipped: P.FolderImportResult['skipped'] = [];
    for (const f of view.folders) {
      // A lone space is not a folder on the network either.
      if (!f.name && f.spaces.length <= 1) continue;
      const free = f.spaces.filter((id) => !placed.has(id));
      if (!f.spaces.length) skipped.push({ name: f.name, why: 'none of its servers are here' });
      else if (!free.length) skipped.push({ name: f.name, why: 'its servers are in your folders already' });
      else {
        for (const id of free) placed.add(id);
        made.push({ name: f.name ?? `${NETWORK_META[acc.network].name} folder`, color: f.color ?? null, spaces: free });
      }
    }
    if (made.length)
      s.setFolders([...existing, ...made.map((f) => ({ id: '', name: f.name, icon: null, color: f.color, items: f.spaces.map((id) => ({ kind: 'space' as const, id })) }))]);
    s.db.query('UPDATE account_self SET folders_imported_at = ? WHERE account_id = ?').run(Date.now(), accountId);
    s.accountChanged(accountId);
    const after = s.folders().slice(existing.length);
    this.d.flush();
    return { made: after.map((f) => ({ id: f.id, name: f.name, spaces: f.items.length })), skipped };
  }

  /** The owner's opt-in to Do not disturb on this network during quiet hours. */
  setDndQuiet(accountId: string, on: unknown) {
    const s = this.d.store;
    const acc = s.account(accountId);
    if (!acc) throw new SelfError('No such account', 404);
    if (typeof on !== 'boolean') throw new SelfError('Say on: true or false');
    if (on && !caps(acc).includes('setPresence')) throw new SelfError(`${this.label(acc)} cannot set its status from here`, 409);
    s.db.query('INSERT OR IGNORE INTO account_self (account_id) VALUES (?)').run(accountId);
    s.db.query('UPDATE account_self SET dnd_quiet = ?, dnd_restore = CASE WHEN ? THEN dnd_restore ELSE NULL END WHERE account_id = ?').run(on ? 1 : 0, on ? 1 : 0, accountId);
    s.accountChanged(accountId);
    this.d.flush();
    return { on };
  }

  /**
   * Quiet hours began or ended: each opted-in account goes to Do not disturb, and back to what it was after, unless
   * the owner changed it in between (then it is theirs and left alone).
   */
  async tick(now = Date.now()) {
    const s = this.d.store;
    const quiet = inQuietHours(this.d.quietHours(), now);
    const rows = s.db.query('SELECT account_id, presence, dnd_restore FROM account_self WHERE dnd_quiet = 1').all() as Row[];
    for (const r of rows) {
      const acc = s.account(r.account_id);
      if (!acc || !caps(acc).includes('setPresence') || !this.d.online(acc.id)) continue;
      if (now - (this.dndFailedAt.get(acc.id) ?? 0) < DND_TICK_MS * 10) continue;
      const state = (parse<P.OwnPresence | null>(r.presence) ?? null)?.state ?? 'online';
      const restore = r.dnd_restore as string | null;
      let next: P.OwnPresenceState | null = null;
      let keep: string | null = restore;
      if (quiet && !restore) {
        // Already Do not disturb or invisible by the owner's choice: nothing to do, nothing to put back.
        if (state === 'dnd' || state === 'invisible') keep = 'owner';
        else {
          next = 'dnd';
          keep = state;
        }
      } else if (!quiet && restore) {
        if (restore !== 'owner' && state === 'dnd') next = restore as P.OwnPresenceState;
        keep = null;
      }
      if (next) {
        try {
          const p = cleanPresence(await this.d.command<P.OwnPresence>(acc.id, { t: 'setPresence', change: { state: next } }, 30_000));
          if (p) ingestSelf(s, acc, { t: 'selfState', state: { presence: p } });
          this.d.note(acc.id, `[self] quiet hours ${quiet ? 'began: Do not disturb' : `ended: back to ${next}`}`);
        } catch (e) {
          this.dndFailedAt.set(acc.id, now);
          this.d.note(acc.id, `[self] quiet hours: could not set ${next}: ${(e as Error).message}`);
          continue;
        }
      }
      if (keep !== restore) s.db.query('UPDATE account_self SET dnd_restore = ? WHERE account_id = ?').run(keep, acc.id);
    }
    this.d.flush();
  }

  async route(req: Request, _url: URL, path: string): Promise<Response | null> {
    if (!path.startsWith('/api/self/')) return null;
    const method = req.method;
    const body = async <T>() => (method === 'GET' ? ({} as T) : ((await req.json().catch(() => ({}))) as T));
    let m: RegExpMatchArray | null;
    try {
      // Every write is a click on the hub's own page: a browser sends Origin, and the server refused other sites'.
      if (method !== 'GET' && !req.headers.get('origin')) throw new SelfError('This is done from the app itself', 403);
      if ((m = path.match(/^\/api\/self\/people\/([\w-]+)\/ignore$/)) && method === 'POST') return Response.json(await this.ignore(m[1], await body()));
      if ((m = path.match(/^\/api\/self\/([\w-]+)\/sessions$/)) && method === 'GET') return Response.json(await this.sessions(m[1]));
      if ((m = path.match(/^\/api\/self\/([\w-]+)\/presence$/)) && method === 'POST') return Response.json(await this.setPresence(m[1], await body()));
      if ((m = path.match(/^\/api\/self\/([\w-]+)\/folders\/import$/)) && method === 'POST') return Response.json(this.importFolders(m[1]));
      if ((m = path.match(/^\/api\/self\/([\w-]+)\/dnd-quiet$/)) && method === 'PUT') return Response.json(this.setDndQuiet(m[1], (await body<{ on?: unknown }>()).on));
    } catch (e) {
      if (e instanceof SelfError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}
