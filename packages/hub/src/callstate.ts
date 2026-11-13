/**
 * Calls as the networks say they stand (docs/calls.md "Ringing"): one model for every network, apart from the calls
 * this hub joins (calls.ts). An adapter's `callState` event says a call rings you, goes on, or is over; the hub keeps
 * the newest of each (call_log), tells open pages (the `calls` client event), and rings your devices:
 *
 *  - a call that rings you alerts once (`ringStep`), on the highest tier, with Answer and Decline;
 *  - it stops ringing on every device as soon as the network says it stopped for you (answered on any device, declined
 *    anywhere, or given up), or when you decline here;
 *  - it never alerts again: not when the adapter reconnects and says it all again, not for a call that started more
 *    than RING.freshMs before the hub heard it ring (the call's own time, not the hub's);
 *  - a ring that the network leaves hanging for RING.maxMs is over, as missed (`sweep`).
 *
 * A call only goes forward: ringing, going on, over. An ended call that is heard ringing again (an old event replayed)
 * stays ended.
 *
 * Who is in which voice channel (the `voice` event) is kept here too, only with the adversarial `voice` setting on
 * (docs/history.md): who is in each channel now (voice_member), and each join and leave in the change log, under the
 * person, like presence. A channel's status line (`voiceStatus`) is kept whatever the setting: it is the channel's.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { callSeconds, RING } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { AccountRow, Store } from './store.ts';

type Row = Record<string, any>;

const made = new WeakSet<Database>();

export function callTables(db: Database) {
  if (made.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS call_log (
    id                  TEXT PRIMARY KEY,
    account_id          TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    native_id           TEXT NOT NULL,
    conversation_id     TEXT NOT NULL,
    conversation_native TEXT NOT NULL,
    caller_id           TEXT,
    started_at          INTEGER NOT NULL,
    state               TEXT NOT NULL,
    rings_self          INTEGER NOT NULL DEFAULT 0,
    rang_self           INTEGER NOT NULL DEFAULT 0,
    outgoing            INTEGER NOT NULL DEFAULT 0,
    video               INTEGER NOT NULL DEFAULT 0,
    participants        TEXT NOT NULL DEFAULT '[]',
    outcome             TEXT,
    answered_at         INTEGER,
    ended_at            INTEGER,
    message_id          TEXT,
    alerted_at          INTEGER,
    declined_at         INTEGER,
    heard_at            INTEGER NOT NULL,
    UNIQUE (account_id, native_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS call_log_state ON call_log(state, heard_at)');
  db.exec('CREATE INDEX IF NOT EXISTS call_log_conversation ON call_log(conversation_id, started_at)');
  // Who is in each voice channel now, as last heard (adversarial `voice` only).
  db.exec(`CREATE TABLE IF NOT EXISTS voice_member (
    conversation_id TEXT NOT NULL,
    identity_id     TEXT NOT NULL,
    account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    flags           TEXT NOT NULL DEFAULT '{}',
    since           INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, identity_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS voice_channel (
    conversation_id TEXT PRIMARY KEY,
    status          TEXT,
    at              INTEGER NOT NULL
  )`);
  made.add(db);
}

const callId = (accountId: string, nativeId: string) =>
  `cll_${Buffer.from(new Bun.CryptoHasher('sha256').update(`${accountId}\0${nativeId}`).digest().subarray(0, 12)).toString('base64url')}`;

const STATES = new Set(['ringing', 'ongoing', 'ended']);
const OUTCOMES = new Set<P.CallOutcome>(['answered', 'elsewhere', 'missed', 'declined', 'busy', 'cancelled']);
const ORDER: Record<string, number> = { ringing: 0, ongoing: 1, ended: 2 };
/** A call going on with no word for this long is over (an adapter that restarted mid-call never says). */
const ONGOING_MAX = 12 * 3_600_000;
/** Ended calls are kept this long: what the timeline needs is in the call's own message. */
const KEEP_ENDED = 30 * 24 * 3_600_000;

/**
 * The ring rule, by itself: whether this change alerts ('ring'), takes an alert back ('stop'), or neither.
 * `before`: the call as the hub had it (null: new). `ringing`: it rings you now. `startedAt`: the call's own time.
 */
export function ringStep(before: { ringing: boolean; alerted: boolean } | null, ringing: boolean, startedAt: number, now: number): 'ring' | 'stop' | null {
  if (ringing && !before?.alerted) return now - startedAt <= RING.freshMs ? 'ring' : null;
  if (!ringing && before?.alerted && before.ringing) return 'stop';
  return null;
}

/** What a call that ended without saying how means for you. */
export function endedOutcome(row: { declined_at: number | null; rang_self: number; outgoing: number; participants: string[] }, self: string | null, given?: P.CallOutcome): P.CallOutcome | null {
  if (given) return given;
  if (row.declined_at) return 'declined';
  if (row.outgoing) return row.participants.some((p) => p !== self) ? 'answered' : 'cancelled';
  if (self && row.participants.includes(self)) return 'answered';
  if (row.rang_self) return 'missed';
  return null;
}

function validFact(c: P.CallFact | undefined): c is P.CallFact {
  return (
    !!c &&
    typeof c.nativeId === 'string' &&
    !!c.nativeId &&
    typeof c.conversation === 'string' &&
    !!c.conversation &&
    typeof c.startedAt === 'number' &&
    Number.isFinite(c.startedAt) &&
    STATES.has(c.state) &&
    (c.outcome === undefined || OUTCOMES.has(c.outcome))
  );
}

/** A ring to send, or one to take back (main.ts delivers them). */
export interface RingNotice {
  kind: 'ring' | 'stop';
  call: P.CallView;
}

const listeners = new WeakMap<Store, (n: RingNotice) => void>();

/** Who delivers rings for this store (main.ts). */
export function onRing(store: Store, fn: (n: RingNotice) => void) {
  listeners.set(store, fn);
}

function caps(acc: Pick<AccountRow, 'capabilities'> | null | undefined): P.Capability[] {
  try {
    return JSON.parse(acc?.capabilities || '[]');
  } catch {
    return [];
  }
}

export function callView(store: Store, r: Row): P.CallView {
  const acc = store.account(r.account_id);
  const c = caps(acc);
  const participants = JSON.parse(r.participants || '[]') as string[];
  const ended = r.state === 'ended';
  return {
    id: r.id,
    accountId: r.account_id,
    network: (acc?.network ?? 'discord') as P.Network,
    conversationId: r.conversation_id,
    callerId: r.caller_id ?? null,
    startedAt: r.started_at,
    state: r.state,
    ringing: !ended && !!r.rings_self && !r.declined_at,
    outgoing: !!r.outgoing,
    video: !!r.video,
    participants,
    outcome: r.outcome ?? null,
    endedAt: r.ended_at ?? null,
    duration: ended ? callSeconds({ startedAt: r.started_at, answeredAt: r.answered_at ?? undefined, endedAt: r.ended_at ?? undefined, outcome: r.outcome ?? undefined }) : null,
    messageId: r.message_id ?? null,
    canDecline: c.includes('declineCall'),
    canAnswer: c.includes('calls'),
  };
}

const ringingNow = (r: Row | null) => !!r && r.state !== 'ended' && !!r.rings_self && !r.declined_at;

/** One `callState` event. Runs inside the store's ingest transaction. */
export function ingestCall(store: Store, acc: AccountRow, f: P.CallFact, now = Date.now()) {
  if (!validFact(f)) return;
  const db = store.db;
  callTables(db);
  const id = callId(acc.id, f.nativeId);
  const before = db.query('SELECT * FROM call_log WHERE id = ?').get(id) as Row | null;
  const conversationId = hubId('cnv', acc.network, f.conversation);
  const self = acc.self_identity;
  const ids = (natives: string[] | undefined) => [...new Set((natives ?? []).filter((x) => typeof x === 'string' && x).map((x) => store.ensureIdentity(acc, x)))];
  // Forward only: an ended call stays ended, a call going on never rings again as new.
  const state = before && ORDER[before.state] > ORDER[f.state] ? before.state : f.state;
  const participants = f.participants ? ids(f.participants) : before ? (JSON.parse(before.participants) as string[]) : [];
  const ringsSelf = state === 'ended' ? false : !!f.ringsSelf;
  const row = {
    declined_at: before?.declined_at ?? null,
    rang_self: before?.rang_self || ringsSelf ? 1 : 0,
    outgoing: f.outgoing || before?.outgoing ? 1 : 0,
    participants,
  };
  // An outcome is the network's word, else worked out once the call is over; an earlier one stands unless the network says otherwise.
  // Declined here stays declined, though the network may only say you were not in it.
  const given = row.declined_at && (!f.outcome || f.outcome === 'missed') ? 'declined' : f.outcome;
  const outcome = state === 'ended' ? (given ?? before?.outcome ?? endedOutcome(row, self)) : null;
  const endedAt = state === 'ended' ? (f.endedAt ?? before?.ended_at ?? now) : null;
  const answeredAt = f.answeredAt ?? before?.answered_at ?? (state === 'ongoing' && self && participants.includes(self) ? now : null);
  db.query(
    `INSERT INTO call_log (id, account_id, native_id, conversation_id, conversation_native, caller_id, started_at, state, rings_self, rang_self, outgoing, video,
                           participants, outcome, answered_at, ended_at, message_id, alerted_at, declined_at, heard_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT (id) DO UPDATE SET caller_id = COALESCE(excluded.caller_id, caller_id), started_at = MIN(started_at, excluded.started_at),
       state = excluded.state, rings_self = excluded.rings_self, rang_self = excluded.rang_self, outgoing = excluded.outgoing,
       video = MAX(video, excluded.video), participants = excluded.participants, outcome = excluded.outcome, answered_at = excluded.answered_at,
       ended_at = excluded.ended_at, message_id = COALESCE(excluded.message_id, message_id), heard_at = excluded.heard_at`,
  ).run(
    id,
    acc.id,
    f.nativeId,
    conversationId,
    f.conversation,
    f.caller ? store.ensureIdentity(acc, f.caller) : null,
    f.startedAt,
    state,
    ringsSelf ? 1 : 0,
    row.rang_self,
    row.outgoing,
    f.video ? 1 : 0,
    JSON.stringify(participants),
    outcome,
    answeredAt,
    endedAt,
    f.message ? hubId('msg', acc.network, f.message) : null,
    now,
  );
  changed(store, id, before, now);
}

/** Tell open pages, and ring or stop ringing, after a call's row changed. */
function changed(store: Store, id: string, before: Row | null, now: number) {
  const after = store.db.query('SELECT * FROM call_log WHERE id = ?').get(id) as Row;
  const step = ringStep(before ? { ringing: ringingNow(before), alerted: !!before.alerted_at } : null, ringingNow(after), after.started_at, now);
  if (step === 'ring') {
    store.db.query('UPDATE call_log SET alerted_at = ? WHERE id = ?').run(now, id);
    after.alerted_at = now;
  }
  const view = callView(store, after);
  store.dirty.extra.push({ t: 'calls', calls: [view] });
  if (step) listeners.get(store)?.({ kind: step, call: view });
}

/** Calls ringing you or going on, and those that ended in the last hour (GET /api/calls). */
export function currentCalls(store: Store, now = Date.now()): P.CallView[] {
  callTables(store.db);
  const rows = store.db.query(`SELECT * FROM call_log WHERE state != 'ended' OR ended_at > ? ORDER BY started_at DESC LIMIT 50`).all(now - 3_600_000) as Row[];
  return rows.map((r) => callView(store, r));
}

/** A conversation's calls, newest first (GET /api/calls?conversation=). */
export function conversationCalls(store: Store, conversationId: string, limit = 50): P.CallView[] {
  callTables(store.db);
  return (store.db.query('SELECT * FROM call_log WHERE conversation_id = ? ORDER BY started_at DESC LIMIT ?').all(conversationId, limit) as Row[]).map((r) => callView(store, r));
}

/**
 * Rings left hanging stop as missed; calls going on with no word for half a day are over; ended calls older than a
 * month go. Called every few seconds (main.ts).
 */
export function sweepCalls(store: Store, now = Date.now()) {
  const db = store.db;
  callTables(db);
  const hanging = db.query(`SELECT * FROM call_log WHERE state != 'ended' AND ((rings_self = 1 AND heard_at < ?) OR heard_at < ?)`).all(now - RING.maxMs, now - ONGOING_MAX) as Row[];
  for (const r of hanging) {
    // Nobody answered, or a call going on that nobody has said a word about for half a day: over. A call going on that
    // still rings you: it goes on, and stops ringing.
    if (r.state === 'ringing' || r.heard_at < now - ONGOING_MAX) {
      const self = store.account(r.account_id)?.self_identity ?? null;
      const outcome = endedOutcome({ declined_at: r.declined_at, rang_self: r.rang_self, outgoing: r.outgoing, participants: JSON.parse(r.participants) }, self);
      const endedAt = Math.min(now, r.heard_at + (r.state === 'ringing' ? RING.maxMs : 0));
      db.query(`UPDATE call_log SET state = 'ended', rings_self = 0, outcome = ?, ended_at = ? WHERE id = ?`).run(outcome, endedAt, r.id);
    } else db.query('UPDATE call_log SET rings_self = 0 WHERE id = ?').run(r.id);
    changed(store, r.id, r, now);
  }
  db.query(`DELETE FROM call_log WHERE state = 'ended' AND ended_at < ?`).run(now - KEEP_ENDED);
}

/** You declined it here: it stops ringing on every device, whatever the network says next. */
export function markDeclined(store: Store, id: string, now = Date.now()): P.CallView | null {
  callTables(store.db);
  const before = store.db.query('SELECT * FROM call_log WHERE id = ?').get(id) as Row | null;
  if (!before) return null;
  store.db.query('UPDATE call_log SET declined_at = COALESCE(declined_at, ?) WHERE id = ?').run(now, id);
  changed(store, id, before, now);
  return callView(store, store.db.query('SELECT * FROM call_log WHERE id = ?').get(id) as Row);
}

export function callRow(store: Store, id: string): Row | null {
  callTables(store.db);
  return store.db.query('SELECT * FROM call_log WHERE id = ?').get(id) as Row | null;
}

// ------------------------------------------------------------------ voice channels

/** Who is in voice channels is logged: an adversarial feature, off unless shown and switched on. */
export function logsVoice(store: Store): boolean {
  const r = store.retention();
  return r.adversarial && !!r.voice;
}

function flagsOf(m: P.VoiceMember): Record<string, boolean> {
  const f: Record<string, boolean> = {};
  for (const k of ['muted', 'deafened', 'video', 'streaming'] as const) if (m[k] === true) f[k] = true;
  return f;
}

export function voiceView(store: Store, conversationId: string): P.VoiceChannelView {
  const db = store.db;
  callTables(db);
  const members = logsVoice(store)
    ? (db.query('SELECT identity_id, flags FROM voice_member WHERE conversation_id = ? ORDER BY since').all(conversationId) as Row[]).map((r) => ({ identityId: r.identity_id, ...JSON.parse(r.flags) }))
    : [];
  const ch = db.query('SELECT status, at FROM voice_channel WHERE conversation_id = ?').get(conversationId) as Row | null;
  return { conversationId, members, at: ch?.at ?? 0, status: ch?.status ?? null };
}

/** Every voice channel with someone in it or a status line (GET /api/voice). */
export function voiceChannels(store: Store): P.VoiceChannelView[] {
  const db = store.db;
  callTables(db);
  const ids = new Set<string>((db.query('SELECT conversation_id FROM voice_channel WHERE status IS NOT NULL').all() as Row[]).map((r) => r.conversation_id));
  if (logsVoice(store)) for (const r of db.query('SELECT DISTINCT conversation_id FROM voice_member').all() as Row[]) ids.add(r.conversation_id);
  return [...ids].map((c) => voiceView(store, c));
}

/** One `voice` event: the channel's people now. Joins and leaves go in the change log under each person. */
export function ingestVoice(store: Store, acc: AccountRow, ev: Extract<P.AdapterEvent, { t: 'voice' }>, now = Date.now()) {
  if (!logsVoice(store) || typeof ev.conversation !== 'string' || !Array.isArray(ev.members)) return;
  const db = store.db;
  callTables(db);
  const cid = hubId('cnv', acc.network, ev.conversation);
  const at = typeof ev.ts === 'number' && Number.isFinite(ev.ts) ? ev.ts : now;
  const was = new Map((db.query('SELECT identity_id, flags FROM voice_member WHERE conversation_id = ?').all(cid) as Row[]).map((r) => [r.identity_id as string, r.flags as string]));
  const seen = new Set<string>();
  let news = false;
  for (const m of ev.members) {
    if (!m || typeof m.who !== 'string' || !m.who) continue;
    const iid = store.ensureIdentity(acc, m.who);
    seen.add(iid);
    const flags = JSON.stringify(flagsOf(m));
    if (!was.has(iid)) {
      // Someone in two channels at once is not: joining this one is leaving the other.
      for (const other of db.query('SELECT conversation_id FROM voice_member WHERE identity_id = ? AND conversation_id != ?').all(iid, cid) as Row[]) {
        db.query('DELETE FROM voice_member WHERE conversation_id = ? AND identity_id = ?').run(other.conversation_id, iid);
        store.dirty.extra.push({ t: 'voice', channels: [voiceView(store, other.conversation_id)] });
      }
      db.query('INSERT INTO voice_member (conversation_id, identity_id, account_id, flags, since) VALUES (?, ?, ?, ?, ?)').run(cid, iid, acc.id, flags, at);
      logVoice(store, iid, cid, acc.id, at);
      news = true;
    } else if (was.get(iid) !== flags) {
      db.query('UPDATE voice_member SET flags = ? WHERE conversation_id = ? AND identity_id = ?').run(flags, cid, iid);
      news = true;
    }
  }
  for (const iid of was.keys()) {
    if (seen.has(iid)) continue;
    db.query('DELETE FROM voice_member WHERE conversation_id = ? AND identity_id = ?').run(cid, iid);
    logVoice(store, iid, null, acc.id, at);
    news = true;
  }
  db.query('INSERT INTO voice_channel (conversation_id, status, at) VALUES (?, NULL, ?) ON CONFLICT (conversation_id) DO UPDATE SET at = excluded.at').run(cid, at);
  if (news) store.dirty.extra.push({ t: 'voice', channels: [voiceView(store, cid)] });
}

/** Where someone is in voice, as the change log keeps it: the channel joined, or null for none. Each person's newest 1000. */
function logVoice(store: Store, iid: string, conversationId: string | null, accountId: string, at: number) {
  const db = store.db;
  const last = db.query(`SELECT new FROM change_log WHERE target_kind = 'identity' AND target_id = ? AND field = 'voice' ORDER BY at DESC, id DESC LIMIT 1`).get(iid) as Row | null;
  const now = conversationId === null ? null : JSON.stringify(conversationId);
  if ((last?.new ?? null) === now) return;
  db.query(`INSERT INTO change_log (target_kind, target_id, field, old, new, at, account_id) VALUES ('identity', ?, 'voice', ?, ?, ?, ?)`).run(iid, last?.new ?? null, now, at, accountId);
  db.query(`DELETE FROM change_log WHERE id IN (SELECT id FROM change_log WHERE target_kind = 'identity' AND target_id = ? AND field = 'voice' ORDER BY at DESC, id DESC LIMIT -1 OFFSET 1000)`).run(iid);
}

/** A channel's status line. */
export function ingestVoiceStatus(store: Store, acc: AccountRow, ev: Extract<P.AdapterEvent, { t: 'voiceStatus' }>, now = Date.now()) {
  if (typeof ev.conversation !== 'string') return;
  const text = typeof ev.text === 'string' && ev.text.trim() ? ev.text.trim().slice(0, 500) : null;
  const db = store.db;
  callTables(db);
  const cid = hubId('cnv', acc.network, ev.conversation);
  const had = db.query('SELECT status FROM voice_channel WHERE conversation_id = ?').get(cid) as Row | null;
  if ((had?.status ?? null) === text && had) return;
  db.query('INSERT INTO voice_channel (conversation_id, status, at) VALUES (?, ?, ?) ON CONFLICT (conversation_id) DO UPDATE SET status = excluded.status, at = excluded.at').run(cid, text, now);
  store.dirty.extra.push({ t: 'voice', channels: [voiceView(store, cid)] });
}

/** Whether anything about voice channels is kept (Forget, store.ts keptKinds). */
export function voiceKept(store: Store): boolean {
  callTables(store.db);
  return !!store.db.query(`SELECT 1 FROM voice_member LIMIT 1`).get() || !!store.db.query(`SELECT 1 FROM change_log WHERE target_kind = 'identity' AND field = 'voice' LIMIT 1`).get();
}

/** Forget who was in voice channels: now and the log. */
export function eraseVoice(store: Store): number {
  callTables(store.db);
  const channels = (store.db.query('SELECT DISTINCT conversation_id FROM voice_member').all() as Row[]).map((r) => r.conversation_id as string);
  const n = store.db.query('DELETE FROM voice_member').run().changes + store.db.query(`DELETE FROM change_log WHERE target_kind = 'identity' AND field = 'voice'`).run().changes;
  if (channels.length) store.dirty.extra.push({ t: 'voice', channels: channels.map((c) => voiceView(store, c)) });
  return n;
}

/** The adapter events this module takes (store.ts ingest). */
export function ingestCallEvent(store: Store, acc: AccountRow, ev: Extract<P.AdapterEvent, { t: 'callState' | 'voice' | 'voiceStatus' }>) {
  if (ev.t === 'callState') ingestCall(store, acc, ev.call);
  else if (ev.t === 'voice') ingestVoice(store, acc, ev);
  else ingestVoiceStatus(store, acc, ev);
}

// ------------------------------------------------------------------ routes

export interface CallRouteDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: any, timeoutMs?: number) => Promise<T>;
  flush: () => void;
}

/**
 * GET /api/calls (ringing, going on, the last hour's), ?conversation=<id> for a chat's; POST /api/calls/<id>/decline;
 * GET /api/voice. Null when the path is not one of these.
 */
export async function callRoute(d: CallRouteDeps, req: Request, url: URL, path: string): Promise<Response | null> {
  const ok = (v: unknown) => Response.json(v);
  const bad = (error: string, status = 400) => Response.json({ error }, { status });
  if (path === '/api/calls' && req.method === 'GET') {
    const c = url.searchParams.get('conversation');
    return ok({ calls: c ? conversationCalls(d.store, c) : currentCalls(d.store) });
  }
  if (path === '/api/voice' && req.method === 'GET') return ok({ channels: voiceChannels(d.store) });
  const m = path.match(/^\/api\/calls\/([\w-]+)\/decline$/);
  if (m && req.method === 'POST') {
    const r = callRow(d.store, m[1]);
    if (!r) return bad('No such call.', 404);
    if (r.state === 'ended') return ok({ call: callView(d.store, r) });
    const acc = d.store.account(r.account_id);
    if (!caps(acc).includes('declineCall')) return bad(`${acc?.label ?? 'This account'} cannot decline calls from here: answer or decline it in the network's own app.`);
    if (!d.online(r.account_id)) return bad(`${acc?.label ?? 'The account'} is not connected, so the call could not be declined. It stops ringing by itself.`, 503);
    try {
      await d.command(r.account_id, { t: 'declineCall', conversation: r.conversation_native, call: r.native_id }, 20_000);
    } catch (e: any) {
      return bad(`The network refused to stop the ringing: ${String(e?.message ?? e)}`, 502);
    }
    const view = markDeclined(d.store, r.id);
    d.flush();
    return ok({ call: view });
  }
  return null;
}

// ------------------------------------------------------------------ ringing your devices

/** A mute on the chat, the caller, the account, the network or everything keeps a ring off your devices (the ring card still shows). */
export function ringMuted(store: Store, c: Pick<P.CallView, 'conversationId' | 'accountId' | 'network' | 'callerId'>): boolean {
  const rules = new Map(store.rules().map((r) => [`${r.scope}:${r.target ?? ''}`, r.level]));
  const person = c.callerId ? ((store.db.query('SELECT person_id FROM identity WHERE id = ?').get(c.callerId) as Row | null)?.person_id ?? null) : null;
  for (const key of [`conversation:${c.conversationId}`, person ? `person:${person}` : '', `account:${c.accountId}`, `network:${c.network}`, 'global:']) {
    const l = key ? rules.get(key) : undefined;
    if (l) return l === 'none';
  }
  return false;
}

/** What a ring says: "Alice is calling", "Discord call in Climbing crew". */
export function ringWords(store: Store, c: P.CallView): { title: string; body: string } {
  const one = <T>(sql: string, ...a: string[]) => store.db.query(sql).get(...a) as T | null;
  const caller = c.callerId ? one<Row>('SELECT i.display_name, i.handle, p.name FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.id = ?', c.callerId) : null;
  const conv = one<Row>('SELECT name, shape FROM conversation WHERE id = ?', c.conversationId);
  const who = caller?.name ?? caller?.display_name ?? caller?.handle ?? 'Someone';
  const net = c.network.charAt(0).toUpperCase() + c.network.slice(1);
  const kind = c.video ? 'video call' : 'call';
  const where = conv?.shape === 'group' && conv.name ? ` in ${conv.name}` : '';
  const how = c.canAnswer ? 'Answer or decline' : c.canDecline ? `Decline here, or answer in ${net}` : `Answer in ${net} on your phone`;
  return { title: `${who} is calling`, body: `${net} ${kind}${where}. ${how}.` };
}
