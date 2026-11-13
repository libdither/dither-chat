/**
 * Adding (docs/add.md): what a pasted invite, address, name or handle is, joining and adding through one of your
 * accounts, and the requests waiting on you. Every call here starts with a click on the hub's page; nothing runs in
 * the background. Paced per account in a table, so a restart does not reset it.
 *
 * Its own tables (add_request, add_pace). The store hands it the requests events, the server its routes.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { ADD_ACTIONS, addCapability, addRefKey, describeAddRef, LINK_RELATIONSHIPS, NETWORK_META, notBuiltLine, REQUEST_ANSWERS, validAddRef } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { AccountRow, Store } from './store.ts';

type Row = Record<string, any>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type PaceKind = 'resolve' | 'join' | 'connect' | 'disconnect' | 'members' | 'groups';

/** How much each account may do, per window. Past it the hub answers 429 with when it frees up. */
export const ADD_LIMITS: Record<PaceKind, { windowMs: number; max: number; networks: Partial<Record<P.Network, number>> }> = {
  // WhatsApp looks a +phone up with a usync query, which it watches.
  resolve: { windowMs: HOUR, max: 60, networks: { whatsapp: 20 } },
  join: { windowMs: DAY, max: 10, networks: { whatsapp: 5 } },
  connect: { windowMs: DAY, max: 20, networks: {} },
  // Unfriending, cancelling a request, unblocking, removing a contact, unfollowing.
  disconnect: { windowMs: DAY, max: 20, networks: {} },
  // People added to groups, one each (about.ts addMembers). Telegram limits adding (PEER_FLOOD) well before Signal does.
  members: { windowMs: DAY, max: 30, networks: { telegram: 15 } },
  // Groups made (groups.ts), each also one `members` slot per person in it. Telegram watches new groups most.
  groups: { windowMs: DAY, max: 5, networks: { telegram: 3 } },
};

/** How long the hub waits for the network. A join may wait on it (a Discord guild's first sync, a Matrix knock). */
export const ADD_TIMEOUTS = { resolve: 30_000, add: 90_000, answer: 90_000, remove: 90_000 };

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
  // The network's words when it flagged a request (added after the table was).
  if (!(db.query(`SELECT 1 FROM pragma_table_info('add_request') WHERE name = 'warning'`).get())) db.exec('ALTER TABLE add_request ADD COLUMN warning TEXT');
  // The network filed it as spam (RequestFact.spam): it never notifies.
  if (!(db.query(`SELECT 1 FROM pragma_table_info('add_request') WHERE name = 'spam'`).get())) db.exec('ALTER TABLE add_request ADD COLUMN spam INTEGER NOT NULL DEFAULT 0');
  // Each account's list: friends, requests it sent, blocks, contacts, follows (the relationships events). Replaced
  // by a `relationships` event, changed by a `relationship` one; 'stranger' is no row.
  db.exec(`CREATE TABLE IF NOT EXISTS person_link (
    account_id   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    identity_id  TEXT NOT NULL,
    relationship TEXT NOT NULL,
    since        INTEGER,
    PRIMARY KEY (account_id, identity_id)
  ) WITHOUT ROWID`);
  db.exec('CREATE INDEX IF NOT EXISTS person_link_identity ON person_link(identity_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS add_pace (
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    at         INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS add_pace_at ON add_pace(account_id, kind, at)');
  // Requests the hub has judged for a notification, once each (requestnotify.ts). Kept a while after they go, so one
  // that comes back is not news again.
  const had = !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'add_request_seen'`).get();
  db.exec(`CREATE TABLE IF NOT EXISTS add_request_seen (
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    native_id  TEXT NOT NULL,
    at         INTEGER NOT NULL,
    PRIMARY KEY (account_id, native_id)
  ) WITHOUT ROWID`);
  // What the hub held before it notified any is not news.
  if (!had) db.exec('INSERT OR IGNORE INTO add_request_seen (account_id, native_id, at) SELECT account_id, native_id, ts FROM add_request');
  made.add(db);
}

const heardBy = new WeakMap<Store, (accountId: string, nativeIds: string[]) => void>();
/** Told of every request an adapter sends, new or not: requestnotify.ts decides which are news. */
export function onRequestsHeard(store: Store, fn: (accountId: string, nativeIds: string[]) => void) {
  heardBy.set(store, fn);
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
    warning: r.warning ?? null,
    ...(r.spam ? { spam: true } : {}),
  }));
}

/** The requests list changed: one `requests` event goes with the next flush, and the places they hold are scored again. */
function requestsChanged(store: Store, held: Iterable<string>, accountId: string, people: Iterable<string>) {
  for (const id of held) if (store.db.query('SELECT 1 FROM conversation WHERE id = ?').get(id)) store.dirty.conversations.add(id);
  dmsChanged(store, accountId, people);
  store.dirty.extra = store.dirty.extra.filter((e) => e.t !== 'requests');
  store.dirty.extra.push({ t: 'requests', requests: requestViews(store) });
}

/** Who asked this account to be friends or to follow it, for the DMs that show it. */
const askersOf = (db: Database, accountId: string, nativeId?: string): string[] =>
  (db.query(`SELECT from_id FROM add_request WHERE account_id = ? AND (? IS NULL OR native_id = ?) AND kind IN ('friend', 'follow') AND from_id IS NOT NULL`).all(accountId, nativeId ?? null, nativeId ?? null) as Row[]).map((r) => r.from_id);

const heldBy = (db: Database, accountId: string, nativeId?: string): string[] =>
  (db.query(`SELECT target_id FROM add_request WHERE account_id = ? AND (? IS NULL OR native_id = ?) AND kind = 'message' AND target_kind = 'conversation'`).all(accountId, nativeId ?? null, nativeId ?? null) as Row[]).map((r) => r.target_id);

/** A fact the adapter sent, if it is one: anything else is dropped. */
function validRequest(f: unknown): f is P.RequestFact {
  const r = f as P.RequestFact;
  return !!r && typeof r.nativeId === 'string' && !!r.nativeId && REQUEST_KINDS.includes(r.kind) && typeof r.ts === 'number' && Array.isArray(r.answers) && (r.from === undefined || typeof r.from === 'string') && (r.warning === undefined || typeof r.warning === 'string') && (r.spam === undefined || typeof r.spam === 'boolean') &&
    (r.target === undefined || ((r.target.kind === 'space' || r.target.kind === 'conversation') && typeof r.target.nativeId === 'string'));
}

function putRequest(store: Store, acc: AccountRow, f: P.RequestFact) {
  const t = f.target;
  const targetId = t ? hubId(t.kind === 'space' ? 'spc' : 'cnv', acc.network, t.nativeId) : null;
  store.db
    .query(
      `INSERT INTO add_request (id, account_id, native_id, kind, from_id, target_kind, target_native, target_id, target_name, target_members, ts, answers, warning, spam)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, from_id = excluded.from_id, target_kind = excluded.target_kind, target_native = excluded.target_native,
         target_id = excluded.target_id, target_name = excluded.target_name, target_members = excluded.target_members, ts = excluded.ts, answers = excluded.answers,
         warning = excluded.warning, spam = excluded.spam`,
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
      f.warning?.trim() ? f.warning.trim().slice(0, 300) : null,
      f.spam === true ? 1 : 0,
    );
  return targetId;
}

/** The requests events, inside the store's ingest. The list stays as it is until the adapter sends one of these. */
export function ingestRequests(store: Store, acc: AccountRow, ev: Extract<P.AdapterEvent, { t: 'requests' | 'request' | 'requestGone' }>) {
  const db = store.db;
  addTables(db);
  const held = new Set<string>();
  const people = new Set<string>();
  const heard: string[] = [];
  if (ev.t === 'requests') {
    if (!Array.isArray(ev.requests)) return;
    for (const id of heldBy(db, acc.id)) held.add(id);
    for (const id of askersOf(db, acc.id)) people.add(id);
    db.query('DELETE FROM add_request WHERE account_id = ?').run(acc.id);
    for (const f of ev.requests) {
      if (!validRequest(f)) continue;
      held.add(putRequest(store, acc, f) ?? '');
      heard.push(f.nativeId);
    }
    for (const id of askersOf(db, acc.id)) people.add(id);
  } else if (ev.t === 'request') {
    if (!validRequest(ev.request)) return;
    for (const id of heldBy(db, acc.id, ev.request.nativeId)) held.add(id);
    for (const id of askersOf(db, acc.id, ev.request.nativeId)) people.add(id);
    held.add(putRequest(store, acc, ev.request) ?? '');
    for (const id of askersOf(db, acc.id, ev.request.nativeId)) people.add(id);
    heard.push(ev.request.nativeId);
  } else {
    for (const id of heldBy(db, acc.id, ev.nativeId)) held.add(id);
    for (const id of askersOf(db, acc.id, ev.nativeId)) people.add(id);
    if (!db.query('DELETE FROM add_request WHERE account_id = ? AND native_id = ?').run(acc.id, ev.nativeId).changes) return;
  }
  held.delete('');
  requestsChanged(store, held, acc.id, people);
  if (heard.length) heardBy.get(store)?.(acc.id, heard);
}

// ------------------------------------------------------------------ relationships

/** Direct conversations an account has with these people: their view says whether a request waits (`pending`). */
function dmsChanged(store: Store, accountId: string, identityIds: Iterable<string>) {
  const ids = [...identityIds];
  if (!ids.length) return;
  const rows = store.db
    .query(
      `SELECT DISTINCT p.conversation_id AS id FROM participant p JOIN conversation c ON c.id = p.conversation_id AND c.shape = 'direct'
       JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = c.id AND v.account_id = ?
       WHERE p.identity_id IN (SELECT value FROM json_each(?))`,
    )
    .all(accountId, JSON.stringify(ids)) as Row[];
  for (const r of rows) store.dirty.conversations.add(r.id);
}

const validLink = (x: unknown): x is P.LinkRelationship => LINK_RELATIONSHIPS.includes(x as P.LinkRelationship);

/** One entry of an account's list, or none for 'stranger' (and for 'requesting': incoming requests are add_request). */
export function setLink(store: Store, accountId: string, identityId: string, relationship: P.PersonRelationship | null, since?: number | null) {
  addTables(store.db);
  if (relationship && validLink(relationship))
    store.db
      .query(
        `INSERT INTO person_link (account_id, identity_id, relationship, since) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, identity_id) DO UPDATE SET relationship = excluded.relationship, since = COALESCE(excluded.since, person_link.since)`,
      )
      .run(accountId, identityId, relationship, since ?? null);
  else if (relationship === 'stranger') store.db.query('DELETE FROM person_link WHERE account_id = ? AND identity_id = ?').run(accountId, identityId);
  else return;
  dmsChanged(store, accountId, [identityId]);
}

/** The relationships events, inside the store's ingest. The list stays as it is until the adapter sends one. */
export function ingestRelationships(store: Store, acc: AccountRow, ev: Extract<P.AdapterEvent, { t: 'relationships' | 'relationship' }>) {
  const db = store.db;
  addTables(db);
  const ok = (f: unknown): f is P.RelationshipFact => {
    const r = f as P.RelationshipFact;
    return !!r && typeof r.identity === 'string' && !!r.identity && (validLink(r.relationship) || r.relationship === 'stranger') && (r.since === undefined || typeof r.since === 'number');
  };
  if (ev.t === 'relationship') {
    if (!ok(ev.fact)) return;
    setLink(store, acc.id, store.ensureIdentity(acc, ev.fact.identity), ev.fact.relationship, ev.fact.since);
    return;
  }
  if (!Array.isArray(ev.list)) return;
  const before = (db.query('SELECT identity_id, relationship FROM person_link WHERE account_id = ?').all(acc.id) as Row[]).map((r) => [r.identity_id as string, r.relationship as string] as const);
  db.query('DELETE FROM person_link WHERE account_id = ?').run(acc.id);
  const put = db.query('INSERT OR REPLACE INTO person_link (account_id, identity_id, relationship, since) VALUES (?, ?, ?, ?)');
  for (const f of ev.list) if (ok(f) && f.relationship !== 'stranger') put.run(acc.id, store.ensureIdentity(acc, f.identity), f.relationship, f.since ?? null);
  // Only a request sent shows on a DM; a list that changed none of those changes no DM.
  const after = (db.query(`SELECT identity_id FROM person_link WHERE account_id = ? AND relationship = 'requested'`).all(acc.id) as Row[]).map((r) => r.identity_id as string);
  const was = before.filter(([, r]) => r === 'requested').map(([id]) => id);
  dmsChanged(store, acc.id, [...was.filter((id) => !after.includes(id)), ...after.filter((id) => !was.includes(id))]);
}

/** How this account stands with them by its own list, when it has one for them. */
export function linkOf(db: Database, accountId: string, identityId: string): P.LinkRelationship | null {
  addTables(db);
  return ((db.query('SELECT relationship FROM person_link WHERE account_id = ? AND identity_id = ?').get(accountId, identityId) as Row | null)?.relationship as P.LinkRelationship) ?? null;
}

/** Whether one of your accounts blocked them (its own list says so): nothing from them alerts. */
export function blockedByYou(db: Database, identityId: string): boolean {
  addTables(db);
  return !!db.query(`SELECT 1 FROM person_link WHERE identity_id = ? AND relationship = 'blocked' LIMIT 1`).get(identityId);
}

const linkView = (r: Row): P.PersonLinkView => ({ accountId: r.account_id, identityId: r.identity_id, personId: r.person_id ?? null, relationship: r.relationship, since: r.since ?? null });

/** Every account's list entries for these identities (a profile). */
export function linksOf(db: Database, identityIds: string[]): P.PersonLinkView[] {
  addTables(db);
  return (
    db
      .query(`SELECT l.*, i.person_id FROM person_link l JOIN identity i ON i.id = l.identity_id WHERE l.identity_id IN (SELECT value FROM json_each(?)) ORDER BY l.account_id`)
      .all(JSON.stringify(identityIds)) as Row[]
  ).map(linkView);
}

/**
 * Friend and follow requests waiting between an account and someone, keyed `account\0identity`: theirs to you
 * (incoming, from add_request) or yours to them (the account's list says 'requested'). Only for these identities
 * when given. Incoming wins when both are there.
 */
export function pendingLinks(db: Database, identityIds?: string[]): Map<string, P.PendingLinkView> {
  addTables(db);
  const out = new Map<string, P.PendingLinkView>();
  const only = identityIds ? JSON.stringify(identityIds) : null;
  const outgoing = db.query(`SELECT account_id, identity_id FROM person_link WHERE relationship = 'requested' AND (?1 IS NULL OR identity_id IN (SELECT value FROM json_each(?1)))`).all(only) as Row[];
  for (const r of outgoing) out.set(`${r.account_id}\0${r.identity_id}`, { accountId: r.account_id, identityId: r.identity_id, incoming: false, requestId: null });
  const incoming = db.query(`SELECT id, account_id, from_id FROM add_request WHERE kind IN ('friend', 'follow') AND from_id IS NOT NULL AND (?1 IS NULL OR from_id IN (SELECT value FROM json_each(?1))) ORDER BY ts`).all(only) as Row[];
  for (const r of incoming) out.set(`${r.account_id}\0${r.from_id}`, { accountId: r.account_id, identityId: r.from_id, incoming: true, requestId: r.id });
  return out;
}

/**
 * GET /api/people: who is on your accounts' lists, by name; one relationship and one account when given. Then the
 * follows that accounts with no list of them say in their kept profiles (profileFollows), and `followsYou` on a
 * listed follow its profile says they return. `friend` also has the mutual follows, listed or not.
 */
export function peopleLinks(store: Store, relationship: string | null, accountId: string | null): P.PeopleLinksView {
  const db = store.db;
  addTables(db);
  const rows = db
    .query(
      `SELECT l.*, i.person_id FROM person_link l JOIN identity i ON i.id = l.identity_id LEFT JOIN person p ON p.id = i.person_id
       WHERE (?1 IS NULL OR l.relationship = ?1) AND (?2 IS NULL OR l.account_id = ?2)
       ORDER BY COALESCE(p.name, i.display_name, i.handle, i.native_id) COLLATE NOCASE, l.account_id`,
    )
    .all(relationship, accountId) as Row[];
  const links = rows.map(linkView);
  if (relationship !== null && relationship !== 'friend' && relationship !== 'following') return { links, identities: store.identitiesByIds([...new Set(links.map((l) => l.identityId))]) };
  const back = followedBackOnLists(db, { accountId });
  // Following and all: a listed follow says it is returned. Friends: the listed follows that are, beside the friends.
  for (const l of links) if (back.has(`${l.accountId}\0${l.identityId}`)) l.followsYou = true;
  if (relationship === 'friend') links.push(...back.values());
  const fromProfiles = profileFollows(db, { accountId }).filter((l) => relationship !== 'friend' || l.followsYou);
  const shown = [...links, ...fromProfiles];
  return { links: shown, identities: store.identitiesByIds([...new Set(shown.map((l) => l.identityId))]) };
}

/**
 * Who your accounts follow, as their kept profiles of them say (the `about` table, docs/profile.md "Connections"), for
 * accounts that keep no list (no `relationships` capability: X today). An account with a list is left out, its list
 * being the truth even when an older profile still says following, and so is anyone already on an account's list.
 * Never your own identities: your second X account is not a friend of your first. Each `from: 'profile'`, `seenAt`
 * when that profile was kept.
 */
export function profileFollows(db: Database, only: { accountId?: string | null; identityIds?: string[] }): P.PersonLinkView[] {
  addTables(db);
  const rows = db.query(PROFILE_FOLLOWS_SQL).all(only.accountId ?? null, only.identityIds ? JSON.stringify(only.identityIds) : null) as Row[];
  // JSON true reads back as 1.
  return rows.map((r) => ({ accountId: r.account_id, identityId: r.identity_id, personId: r.person_id ?? null, relationship: 'following', since: null, ...(r.follows_you === 1 ? { followsYou: true as const } : {}), from: 'profile', seenAt: r.fetched_at }));
}

/**
 * profileFollows' query, `?1` an account or null, `?2` a JSON array of identities or null. Its first condition is
 * index `about_following`'s WHERE (schema.sql), word for word, so only those rows are read, not every kept profile
 * with its posts (links.test.ts checks the plan).
 */
export const PROFILE_FOLLOWS_SQL = `SELECT a.account_id, a.target_id AS identity_id, a.fetched_at, i.person_id, json_extract(a.data, '$.followsYou') AS follows_you
   FROM about a JOIN identity i ON i.id = a.target_id JOIN account acc ON acc.id = a.account_id
  WHERE json_extract(a.data, '$.relationship') = 'following'
    AND (?1 IS NULL OR a.account_id = ?1)
    AND (?2 IS NULL OR a.target_id IN (SELECT value FROM json_each(?2)))
    AND NOT EXISTS (SELECT 1 FROM json_each(acc.capabilities) c WHERE c.value = 'relationships')
    AND NOT EXISTS (SELECT 1 FROM person_link l WHERE l.account_id = a.account_id AND l.identity_id = a.target_id)
    AND a.target_id NOT IN (SELECT self_identity FROM account WHERE self_identity IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM person p WHERE p.id = i.person_id AND p.is_self = 1)
  ORDER BY a.account_id, a.target_id`;

/** Follows on an account's list whose kept profile (same account) says they follow back, keyed `account\0identity`. */
function followedBackOnLists(db: Database, only: { accountId?: string | null; identityIds?: string[] }): Map<string, P.PersonLinkView> {
  const rows = db
    .query(
      `SELECT l.*, i.person_id FROM person_link l JOIN identity i ON i.id = l.identity_id JOIN about a ON a.target_id = l.identity_id AND a.account_id = l.account_id
        WHERE l.relationship = 'following' AND json_extract(a.data, '$.followsYou') = 1 AND (?1 IS NULL OR l.account_id = ?1)
          AND (?2 IS NULL OR l.identity_id IN (SELECT value FROM json_each(?2)))`,
    )
    .all(only.accountId ?? null, only.identityIds ? JSON.stringify(only.identityIds) : null) as Row[];
  return new Map(rows.map((r) => [`${r.account_id}\0${r.identity_id}`, { ...linkView(r), followsYou: true as const }]));
}

/**
 * A profile's links (ProfileView.links): each account's list entries for these identities, with `followsYou` where
 * its profile says so, and the follows from the profiles of accounts with no list, so the profile says what People's
 * lists say, whichever account asked last.
 */
export function profileLinksOf(db: Database, identityIds: string[]): P.PersonLinkView[] {
  const back = followedBackOnLists(db, { identityIds });
  return [...linksOf(db, identityIds).map((l) => (back.has(`${l.accountId}\0${l.identityId}`) ? { ...l, followsYou: true as const } : l)), ...profileFollows(db, { identityIds })];
}

// ------------------------------------------------------------------ pacing

const paceOf = (action: P.AddAction): PaceKind => (action === 'join' || action === 'ask' ? 'join' : 'connect');

function inWords(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

const DID: Record<PaceKind, string> = { resolve: 'looked up', join: 'joined or asked to join', connect: 'added', disconnect: 'removed or unblocked', members: 'added', groups: 'made' };
const WHAT: Record<PaceKind, string> = { resolve: 'links and names', join: 'places', connect: 'people', disconnect: 'people', members: 'people to groups', groups: 'groups' };

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

/** Give one back: the network asked for a confirm first and nothing was done. */
export function givePace(db: Database, accountId: string, kind: PaceKind, at: number) {
  db.query('DELETE FROM add_pace WHERE rowid = (SELECT rowid FROM add_pace WHERE account_id = ? AND kind = ? AND at = ? LIMIT 1)').run(accountId, kind, at);
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

  /** /api/add/*, /api/requests*, GET /api/people and POST /api/people/:id/remove, or null for any other path. */
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
      if (path === '/api/people' && method === 'GET') {
        const rel = url.searchParams.get('relationship');
        if (rel && !LINK_RELATIONSHIPS.includes(rel as P.LinkRelationship)) throw new AddError(`relationship: ${LINK_RELATIONSHIPS.join(', ')}`, 400);
        return Response.json(peopleLinks(this.d.store, rel, url.searchParams.get('account')));
      }
      if ((m = path.match(/^\/api\/people\/([\w-]+)\/remove$/)) && method === 'POST') {
        // A click on the hub's own page: a browser sends Origin, and the server has refused any other site's.
        if (!req.headers.get('origin')) throw new AddError('Removing people is done from the app itself', 403);
        return Response.json(await this.remove(m[1], await body()));
      }
    } catch (e) {
      if (e instanceof AddError) return Response.json({ error: e.message, ...e.extra }, { status: e.status });
      throw e;
    }
    return path === '/api/add' || path.startsWith('/api/add/') || path.startsWith('/api/requests') || path === '/api/people' || /^\/api\/people\/[\w-]+\/remove$/.test(path)
      ? Response.json({ error: 'not found' }, { status: 404 })
      : null;
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

  /** Count one, or refuse past the limit. Returns when it was counted, to give it back if nothing was done. */
  private pace(acc: AccountRow, kind: PaceKind): number {
    const at = this.now();
    const p = takePace(this.d.store.db, acc, kind, at);
    if (!p.ok) throw new AddError(p.error, 429, { retryAt: p.retryAt });
    return at;
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

  /** A kept preview after acting on it: in it now, asked, or added. A check or a confirm did nothing, so it stays as it was. */
  private acted(acc: AccountRow, ref: P.AddRef, action: P.AddAction, r: P.AddResult) {
    const hit = this.previews.get(this.cacheKey(acc.id, ref));
    if (!hit || r.check || str(r.confirm)) return;
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

  async add(b: { accountId?: unknown; ref?: unknown; action?: unknown; confirm?: unknown }): Promise<P.AddResultView> {
    const action = b.action as P.AddAction;
    if (!ADD_ACTIONS.includes(action)) throw new AddError('Join, ask, friend, follow or contact?', 400);
    if (action === 'message') throw new AddError('A message starts with POST /api/directs', 400);
    const [acc, ref] = this.account(b.accountId, b.ref, (r) => [addCapability(action), builtFor(r, action)]);
    const kind = paceOf(action);
    const at = this.pace(acc, kind);
    // Only when the owner pressed "Add anyway" after the network asked.
    const r = (await this.ask<P.AddResult>(acc, { t: 'add', ref, action, ...(b.confirm === true ? { confirm: true as const } : {}) }, ADD_TIMEOUTS.add, true)) ?? {};
    this.d.note(acc.id, `[add] ${VERB[action]} ${describeAddRef(ref)}${b.confirm === true ? ', confirmed' : ''}${outcome(r)}`);
    if (str(r.confirm)) givePace(this.d.store.db, acc.id, kind, at);
    this.acted(acc, ref, action, r);
    return this.result(acc, r);
  }

  async answer(id: string, b: { answer?: unknown; confirm?: unknown }): Promise<P.AddResultView> {
    const db = this.d.store.db;
    const row = db.query('SELECT r.*, a.network FROM add_request r JOIN account a ON a.id = r.account_id WHERE r.id = ?').get(id) as Row | null;
    if (!row) throw new AddError('That request is not waiting any more', 404);
    const answer = b.answer as P.RequestAnswer;
    if (!REQUEST_ANSWERS.includes(answer) || !(JSON.parse(row.answers) as P.RequestAnswer[]).includes(answer)) throw new AddError(`This request can be answered with ${(JSON.parse(row.answers) as string[]).join(', ') || 'nothing here'}`, 400);
    const acc = this.d.store.account(row.account_id)!;
    if (!caps(acc).includes('requests')) throw new AddError(`Answering ${NETWORK_META[acc.network].name} requests isn't built for this account yet`, 409);
    if (!this.d.online(acc.id)) throw new AddError(`${NETWORK_META[acc.network].name} ${acc.label} is not connected`, 409);
    // Only when the owner pressed "Accept anyway": after the network asked, or after its warning on the card.
    const confirm = b.confirm === true;
    const r = (await this.ask<P.AddResult>(acc, { t: 'answer', request: row.native_id, answer, ...(confirm ? { confirm: true as const } : {}) }, ADD_TIMEOUTS.answer, true)) ?? {};
    this.d.note(acc.id, `[add] ${answer === 'accept' ? 'accepted' : answer === 'decline' ? 'declined' : 'blocked'} the ${row.kind} request${row.target_name ? ` (${row.target_name})` : ''}${confirm ? ', confirmed' : ''}${outcome(r)}`);
    // Answered: gone here now, whether or not the adapter says so too. A check or a confirm did nothing, so it stays.
    if (!r.check && !str(r.confirm)) ingestRequests(this.d.store, acc, { t: 'requestGone', nativeId: row.native_id });
    return this.result(acc, { ...r, identity: r.identity ?? (row.from_id ? (this.d.store.nativeOf('identity', row.from_id)?.nativeId ?? undefined) : undefined) });
  }

  /**
   * POST /api/people/:identityId/remove { relationship, accountId? }: end how an account stands with them, on the
   * owner's click. `relationship` is what the page showed; the adapter refuses if the network says otherwise now.
   * Without accountId, the one account whose list says so, else the only one on that network that can.
   */
  async remove(identityId: string, b: { relationship?: unknown; accountId?: unknown }): Promise<P.AddResultView> {
    const store = this.d.store;
    const who = store.nativeOf('identity', identityId);
    if (!who) throw new AddError('Nobody by that id', 404);
    const rel = b.relationship as P.LinkRelationship;
    if (!LINK_RELATIONSHIPS.includes(rel)) throw new AddError('Remove a friend, a request you sent, a block, a contact or a follow?', 400);
    const net = NETWORK_META[who.network].name;
    let acc: AccountRow | null = null;
    if (b.accountId !== undefined) {
      acc = typeof b.accountId === 'string' ? store.account(b.accountId) : null;
      if (!acc) throw new AddError('no such account', 404);
      if (acc.network !== who.network) throw new AddError(`They are on ${net}, and ${acc.label} is a ${NETWORK_META[acc.network].name} account`, 400);
    } else {
      const listed = (store.db.query('SELECT account_id FROM person_link WHERE identity_id = ? AND relationship = ?').all(identityId, rel) as Row[]).map((r) => r.account_id as string);
      const able = (store.db.query('SELECT id FROM account WHERE network = ?').all(who.network) as Row[]).map((r) => r.id as string).filter((id) => caps(store.account(id)!).includes('disconnect'));
      const one = listed.length === 1 ? listed[0] : !listed.length && able.length === 1 ? able[0] : null;
      if (!one) throw new AddError(`Which ${net} account?`, 400);
      acc = store.account(one);
    }
    if (!acc) throw new AddError('no such account', 404);
    if (acc.self_identity === identityId) throw new AddError('That is this account', 400);
    if (!caps(acc).includes('disconnect')) throw new AddError(`Removing people on ${net} isn't built for this account yet`, 409);
    if (!this.d.online(acc.id)) throw new AddError(`${net} ${acc.label} is not connected`, 409);
    const at = this.pace(acc, 'disconnect');
    const r = (await this.ask<P.AddResult>(acc, { t: 'remove', identity: who.nativeId, relationship: rel }, ADD_TIMEOUTS.remove, true)) ?? {};
    const name = store.identitiesByIds([identityId])[0];
    this.d.note(acc.id, `[add] ${REMOVED[rel]} ${name?.handle ?? name?.displayName ?? who.nativeId}${outcome(r)}`);
    const nothing = !!r.check || !!str(r.confirm);
    if (nothing) givePace(store.db, acc.id, 'disconnect', at);
    // The adapter says how they stand now; ended, unless it said otherwise.
    return this.result(acc, { ...r, identity: r.identity ?? who.nativeId, ...(nothing ? {} : { relationship: (str(r.relationship) as P.PersonRelationship | null) ?? 'stranger' }) });
  }

  private result(acc: AccountRow, r: P.AddResult): P.AddResultView {
    const store = this.d.store;
    const net = acc.network;
    const conversationId = str(r.conversation) ? hubId('cnv', net, r.conversation!) : null;
    if (conversationId && store.db.query('SELECT 1 FROM conversation WHERE id = ?').get(conversationId)) store.touchConversation(conversationId);
    const identityId = str(r.identity) ? hubId('idn', net, r.identity!) : null;
    const relationship = str(r.relationship) as P.PersonRelationship | null;
    // Their profile, as last asked through this account, says how you stand now, until it is asked again (people.ts).
    if (identityId && relationship) store.db.query(`UPDATE about SET data = json_set(data, '$.relationship', ?) WHERE target_id = ? AND account_id = ?`).run(relationship, identityId, acc.id);
    // And the account's list, when it keeps one: its relationship event says the same soon after.
    if (identityId && relationship && caps(acc).includes('relationships')) setLink(store, acc.id, identityId, relationship);
    this.d.flush();
    const checks: P.AddCheck[] = ['captcha', 'verify', 'phone', 'rules'];
    return {
      accountId: acc.id,
      conversation: conversationId ? store.conversationView(conversationId) : null,
      spaceId: str(r.space) ? hubId('spc', net, r.space!) : null,
      identityId,
      relationship,
      pending: r.pending === true,
      check: checks.includes(r.check as P.AddCheck) ? r.check! : null,
      confirm: str(r.confirm)?.slice(0, 300) ?? null,
      notes: Array.isArray(r.notes) ? r.notes.filter((n) => typeof n === 'string').slice(0, 8) : [],
      liveView: this.d.liveView(acc.id),
      managerUrl: store.accountView(acc).managedBy?.url ?? null,
    };
  }
}

const VERB: Record<Exclude<P.AddAction, 'message'>, string> = { join: 'joined', ask: 'asked to join', friend: 'sent a friend request to', follow: 'followed', contact: 'added as a contact' };
const outcome = (r: P.AddResult) => (r.check ? ` - ${r.check} check wanted first, nothing done` : str(r.confirm) ? ' - the network wants a confirm first, nothing done' : r.pending ? ' - waiting on them' : '');
const REMOVED: Record<P.LinkRelationship, string> = { friend: 'removed the friend', requested: 'cancelled the friend request to', blocked: 'unblocked', contact: 'removed the contact', following: 'unfollowed' };

function builtFor(ref: P.AddRef, action: P.AddAction): string {
  return action === 'join' || action === 'ask' ? `Joining on ${NETWORK_META[ref.network].name} isn't built for this account yet` : `Adding people on ${NETWORK_META[ref.network].name} isn't built for this account yet`;
}
