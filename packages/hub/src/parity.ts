/**
 * Read-only checks of a hub database (docs/testing.md, "Parity audit"; scripts/audit-parity.ts runs them on a copy).
 *
 *  - auditHubInvariants: what should never be in the database, or only rarely: an edit stored as a second message (a
 *    row whose edited time is another row's sent time, same chat and author: Signal's edit chains), replies to rows
 *    that are not there (and how many of them name an edited time), reactions, tallies, files and history rows of
 *    messages that are gone, and edited messages that get far fewer reactions than the rest (reactions dropped
 *    because they named an id the hub stored under another).
 *  - diffSignalDesktop: the hub against a linked Signal Desktop profile, read with the importer's own reader
 *    (imports/signal-desktop.ts) so both name each message the same way. Per chat, over the time both cover: messages,
 *    edited ones, reactions and files on each side, which of Desktop's the hub lacks, which of the hub's Desktop does
 *    not know (an edit stored twice), and reactions Desktop has that the hub dropped.
 *
 * Counts and ids only. Nothing here reads a message's words into what it returns, nor a name or an emoji; chats are
 * named by a hash of their hub id unless `showIds` is asked for.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { desktopKey, desktopSelf, mapDesktop, unpackDesktop } from './imports/signal-desktop.ts';

type Row = Record<string, any>;

const DAY = 86_400_000;

/** A stable short name for an id, so a report can be compared across runs without naming the chat. */
export const anonId = (id: string) => createHash('sha256').update(`dither-parity\0${id}`).digest('base64url').slice(0, 10);

const label = (id: string, showIds: boolean | undefined) => (showIds ? id : anonId(id));

// ------------------------------------------------------------------ invariants

interface ReactionRate {
  messages: number;
  /** Of them, with at least one reaction. */
  reacted: number;
  rate: number;
}

export interface NetworkInvariants {
  network: string;
  messages: number;
  /** Pairs (a, b) in one chat by one author where a.edited_ts = b.ts: an edit stored as a message of its own. */
  chainedEditDuplicates: number;
  /** Replies whose reply_to_id has no row: with a quote kept, and with a quote naming a time some row was edited at. */
  danglingReplies: { count: number; withQuote: number; targetsEditedTs: number };
  /** Messages (not system lines, not deleted) with a reaction, edited against not. */
  edited: ReactionRate;
  unedited: ReactionRate;
  /** Edited messages are reacted to less than a third as often as the rest, with enough of both to say so. */
  editedReactionDrop: boolean;
  /** Edited messages with no `edit` history row: normal for edits from before the hub saw them, or with edits not kept. */
  editedWithoutEditEvent: number;
}

export interface Anomaly {
  check: 'chainedEditDuplicates' | 'danglingRepliesToEdits' | 'editedReactionDrop' | 'orphanReactions' | 'orphanTallies' | 'orphanAttachments' | 'orphanEvents';
  network: string | null;
  count: number;
}

export interface HubInvariants {
  networks: NetworkInvariants[];
  /** Rows of other tables whose message is not there (no network: the message that would say is gone). */
  orphans: { reactions: number; tallies: number; attachments: number; events: number };
  /** A few of each, by chat and message (hashed unless showIds), to look up locally. */
  samples: { chainedEditDuplicates: { conversation: string; edited: string; duplicate: string }[] };
  /** What should be looked at, the most first. Empty for a clean database. */
  anomalies: Anomaly[];
}

interface InvariantOptions {
  network?: string;
  showIds?: boolean;
  /** Samples of each kind kept (default 5). */
  samples?: number;
  /** The fewest edited messages and reacted unedited ones that editedReactionDrop judges by (default 10). */
  minForRate?: number;
}

const hasTable = (db: Database, t: string) => !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);

/** The checks, read-only: open the database with `{ readonly: true }`, on a copy for the live one. */
export function auditHubInvariants(db: Database, o: InvariantOptions = {}): HubInvariants {
  const net = o.network ?? null;
  const nSamples = o.samples ?? 5;
  const minForRate = o.minForRate ?? 10;
  const by = new Map<string, NetworkInvariants>();
  const of = (network: string) =>
    by.get(network) ??
    by
      .set(network, {
        network,
        messages: 0,
        chainedEditDuplicates: 0,
        danglingReplies: { count: 0, withQuote: 0, targetsEditedTs: 0 },
        edited: { messages: 0, reacted: 0, rate: 0 },
        unedited: { messages: 0, reacted: 0, rate: 0 },
        editedReactionDrop: false,
        editedWithoutEditEvent: 0,
      })
      .get(network)!;

  for (const r of db.query('SELECT network, COUNT(*) AS n FROM message WHERE (?1 IS NULL OR network = ?1) GROUP BY network').all(net) as Row[]) of(r.network).messages = r.n;

  const samples: HubInvariants['samples'] = { chainedEditDuplicates: [] };
  for (const r of db
    .query(
      `SELECT a.network, a.conversation_id AS conv, a.id AS a, b.id AS b FROM message a
       JOIN message b ON b.conversation_id = a.conversation_id AND b.ts = a.edited_ts AND b.id != a.id AND b.network = a.network AND b.author_id IS a.author_id
       WHERE a.edited_ts IS NOT NULL AND a.edited_ts != a.ts AND (?1 IS NULL OR a.network = ?1)`,
    )
    .iterate(net) as Iterable<Row>) {
    of(r.network).chainedEditDuplicates++;
    if (samples.chainedEditDuplicates.length < nSamples) samples.chainedEditDuplicates.push({ conversation: label(r.conv, o.showIds), edited: label(r.a, o.showIds), duplicate: label(r.b, o.showIds) });
  }

  // Only whether a quote is there and the time it names: never its words.
  const quoteTs = `CASE WHEN json_valid(m.extra) THEN json_extract(m.extra, '$.quote.ts') END`;
  for (const r of db
    .query(
      `SELECT m.network, COUNT(*) AS n,
         SUM(CASE WHEN json_valid(m.extra) AND json_type(m.extra, '$.quote') IS NOT NULL THEN 1 ELSE 0 END) AS quoted,
         SUM(EXISTS (SELECT 1 FROM message e WHERE e.conversation_id = m.conversation_id AND e.edited_ts IS NOT NULL AND e.edited_ts = ${quoteTs})) AS to_edited
       FROM message m
       WHERE m.reply_to_id IS NOT NULL AND (?1 IS NULL OR m.network = ?1) AND NOT EXISTS (SELECT 1 FROM message t WHERE t.id = m.reply_to_id)
       GROUP BY m.network`,
    )
    .all(net) as Row[])
    of(r.network).danglingReplies = { count: r.n, withQuote: r.quoted ?? 0, targetsEditedTs: r.to_edited ?? 0 };

  const tallies = hasTable(db, 'reaction_tally');
  for (const r of db
    .query(
      `SELECT m.network, m.edited_ts IS NOT NULL AS edited, COUNT(*) AS n,
         SUM(EXISTS (SELECT 1 FROM reaction r WHERE r.message_id = m.id)${tallies ? ' OR EXISTS (SELECT 1 FROM reaction_tally t WHERE t.message_id = m.id)' : ''}) AS reacted
       FROM message m WHERE m.deleted = 0 AND m.kind NOT IN ('system', 'call') AND (?1 IS NULL OR m.network = ?1)
       GROUP BY m.network, edited`,
    )
    .all(net) as Row[]) {
    const rate: ReactionRate = { messages: r.n, reacted: r.reacted ?? 0, rate: r.n ? (r.reacted ?? 0) / r.n : 0 };
    if (r.edited) of(r.network).edited = rate;
    else of(r.network).unedited = rate;
  }
  for (const n of by.values()) n.editedReactionDrop = n.edited.messages >= minForRate && n.unedited.reacted >= minForRate && n.edited.rate < n.unedited.rate / 3;

  if (hasTable(db, 'message_event'))
    for (const r of db
      .query(
        `SELECT network, COUNT(*) AS n FROM message m WHERE edited_ts IS NOT NULL AND (?1 IS NULL OR network = ?1)
         AND NOT EXISTS (SELECT 1 FROM message_event e WHERE e.message_id = m.id AND e.kind = 'edit') GROUP BY network`,
      )
      .all(net) as Row[])
      of(r.network).editedWithoutEditEvent = r.n;

  const orphan = (t: string) => (hasTable(db, t) ? ((db.query(`SELECT COUNT(*) AS n FROM ${t} x WHERE NOT EXISTS (SELECT 1 FROM message m WHERE m.id = x.message_id)`).get() as Row).n as number) : 0);
  const orphans = { reactions: orphan('reaction'), tallies: tallies ? orphan('reaction_tally') : 0, attachments: orphan('attachment'), events: orphan('message_event') };

  const networks = [...by.values()].sort((a, b) => a.network.localeCompare(b.network));
  const anomalies: Anomaly[] = [];
  for (const n of networks) {
    if (n.chainedEditDuplicates) anomalies.push({ check: 'chainedEditDuplicates', network: n.network, count: n.chainedEditDuplicates });
    if (n.danglingReplies.targetsEditedTs) anomalies.push({ check: 'danglingRepliesToEdits', network: n.network, count: n.danglingReplies.targetsEditedTs });
    if (n.editedReactionDrop) anomalies.push({ check: 'editedReactionDrop', network: n.network, count: n.edited.messages - n.edited.reacted });
  }
  if (orphans.reactions) anomalies.push({ check: 'orphanReactions', network: null, count: orphans.reactions });
  if (orphans.tallies) anomalies.push({ check: 'orphanTallies', network: null, count: orphans.tallies });
  if (orphans.attachments) anomalies.push({ check: 'orphanAttachments', network: null, count: orphans.attachments });
  if (orphans.events) anomalies.push({ check: 'orphanEvents', network: null, count: orphans.events });
  anomalies.sort((a, b) => b.count - a.count);
  return { networks, orphans, samples, anomalies };
}

// ------------------------------------------------------------------ Signal Desktop

export interface SideCounts {
  messages: number;
  edited: number;
  reactions: number;
  attachments: number;
}

export interface ConversationDiff {
  /** The hub's conversation id, hashed unless showIds. */
  conversation: string;
  shape: P.ConversationFact['shape'];
  desktop: SideCounts;
  hub: SideCounts;
  /** Desktop's messages with no hub row. */
  missingInHub: number;
  /** The hub's messages (not deleted) Desktop does not have. */
  extraInHub: number;
  /** Of those, the ones sent at a time a message here was edited at: an edit stored as a message. */
  editDuplicates: number;
  /** On messages both have: reactions Desktop has beyond the hub's, and the other way. */
  reactionsMissing: number;
  reactionsExtra: number;
  /** On messages both have: edited on one side only. */
  editedMismatch: number;
  /** Weighted sum of the above, to sort by. */
  severity: number;
}

export interface DesktopDiff {
  /** The time both cover (ms epoch), or null when they do not overlap. */
  window: { from: number; to: number } | null;
  desktop: SideCounts;
  hub: SideCounts;
  missingInHub: number;
  extraInHub: number;
  editDuplicates: number;
  reactionsMissing: number;
  reactionsExtra: number;
  editedMismatch: number;
  /** Chats compared, and how many of them matched exactly. */
  conversations: number;
  matching: number;
  /** Signal chats the hub has messages in, in the window, that Desktop has none in. */
  hubOnlyConversations: number;
  /** The chats that differ, the most first. */
  mismatches: ConversationDiff[];
}

interface DesktopSource {
  /** A Signal Desktop profile folder (holding sql/db.sqlite): decrypted to a private temporary copy, removed after. */
  profile?: string;
  /** Its key, when config.json's is wrapped by a keyring. */
  key?: Buffer;
  /** Or a plain copy already made (an import's work/<source>/desktop.sqlite, or a test's). */
  plainDb?: string;
}

interface DesktopDiffOptions {
  /** Only the last N days (of the overlap). */
  days?: number;
  now?: number;
  showIds?: boolean;
  /** The ACI the Desktop is linked as, when its database does not say. */
  selfId?: string;
}

interface DesktopMsg {
  id: string;
  ts: number;
  editedTs: number | null;
  reactions: number;
  attachments: number;
}

const zero = (): SideCounts => ({ messages: 0, edited: 0, reactions: 0, attachments: 0 });

/** The hub against a Signal Desktop profile, counts only. `hub` is opened read-only by the caller. */
export function diffSignalDesktop(hub: Database, src: DesktopSource, o: DesktopDiffOptions = {}): DesktopDiff {
  let tmp: string | null = null;
  try {
    let plain = src.plainDb;
    if (!plain) {
      if (!src.profile) throw new Error('give a Signal Desktop profile or a plain copy of its database');
      const k = src.key ? { key: src.key } : desktopKey(src.profile);
      if (!('key' in k)) throw new Error(k.missing === 'keyring' ? 'the profile’s key is wrapped by a desktop keyring: give it by hand' : 'the profile has no config.json key');
      tmp = mkdtempSync(join(tmpdir(), 'dither-parity-'));
      plain = join(tmp, 'desktop.sqlite');
      unpackDesktop({ profile: src.profile, key: k.key, dbPath: plain, sourceSha: 'parity' });
    }
    const self = desktopSelf(plain) ?? o.selfId ?? hubSignalSelf(hub);
    if (!self) throw new Error('could not tell which account the Desktop is linked as: pass selfId');
    const chats = new Map<string, { shape: P.ConversationFact['shape']; msgs: DesktopMsg[] }>();
    mapDesktop(plain, { selfId: self, profile: src.profile ?? join(plain, '..'), mediaDir: join(tmp ?? tmpdir(), 'unused-media'), countOnly: true }, (line: any) => {
      if (line.t === 'conversation') chats.set(line.conversation.nativeId, { shape: line.conversation.shape, msgs: [] });
      else if (line.t === 'message') {
        const m = line.m as P.MessageFact;
        if (m.kind === 'system') return;
        chats.get(m.conversation)?.msgs.push({
          id: hubId('msg', 'signal', m.nativeId),
          ts: m.ts,
          editedTs: m.editedTs ?? null,
          reactions: (m.reactions ?? []).reduce((n, r) => n + (r.authors?.length ?? 0), 0),
          attachments: m.attachments?.length ?? 0,
        });
      }
    });
    return compare(hub, chats, self, o);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** The one Signal account's own ACI, when the hub has exactly one. */
function hubSignalSelf(hub: Database): string | null {
  const rows = hub.query(`SELECT i.native_id FROM account a JOIN identity i ON i.id = a.self_identity WHERE a.network = 'signal'`).all() as Row[];
  return rows.length === 1 ? rows[0]!.native_id : null;
}

function compare(hub: Database, chats: Map<string, { shape: P.ConversationFact['shape']; msgs: DesktopMsg[] }>, self: string, o: DesktopDiffOptions): DesktopDiff {
  const out: DesktopDiff = {
    window: null, desktop: zero(), hub: zero(), missingInHub: 0, extraInHub: 0, editDuplicates: 0, reactionsMissing: 0, reactionsExtra: 0, editedMismatch: 0,
    conversations: 0, matching: 0, hubOnlyConversations: 0, mismatches: [],
  };
  // The overlap: from the later of the two firsts to the earlier of the two lasts, over Desktop's chats.
  let dMin = Infinity;
  let dMax = -Infinity;
  for (const c of chats.values()) for (const m of c.msgs) (dMin = Math.min(dMin, m.ts), dMax = Math.max(dMax, m.ts));
  const cids = [...chats.keys()].map((n) => hubId('cnv', 'signal', n));
  let hMin = Infinity;
  let hMax = -Infinity;
  const range = hub.query(`SELECT MIN(ts) AS a, MAX(ts) AS b FROM message WHERE conversation_id = ? AND kind NOT IN ('system', 'call')`);
  for (const cid of cids) {
    const r = range.get(cid) as Row;
    if (r?.a != null) (hMin = Math.min(hMin, r.a), hMax = Math.max(hMax, r.b));
  }
  let from = Math.max(dMin, hMin);
  const to = Math.min(dMax, hMax);
  if (o.days) from = Math.max(from, (o.now ?? Date.now()) - o.days * DAY);
  if (!(from <= to)) return out;
  out.window = { from, to };

  const rowsOf = hub.query(
    `SELECT m.id, m.ts, m.edited_ts, m.deleted,
       (SELECT COUNT(*) FROM reaction r WHERE r.message_id = m.id) AS reactions,
       (SELECT COUNT(*) FROM attachment a WHERE a.message_id = m.id) AS attachments
     FROM message m WHERE m.conversation_id = ? AND m.ts BETWEEN ? AND ? AND m.kind NOT IN ('system', 'call')`,
  );
  const add = (a: SideCounts, b: SideCounts) => {
    a.messages += b.messages;
    a.edited += b.edited;
    a.reactions += b.reactions;
    a.attachments += b.attachments;
  };
  for (const [native, chat] of chats) {
    const cid = hubId('cnv', 'signal', native);
    const msgs = chat.msgs.filter((m) => m.ts >= from && m.ts <= to);
    const rows = rowsOf.all(cid, from, to) as Row[];
    if (!msgs.length && !rows.length) continue;
    out.conversations++;
    const d: ConversationDiff = {
      conversation: label(cid, o.showIds), shape: chat.shape, desktop: zero(), hub: zero(),
      missingInHub: 0, extraInHub: 0, editDuplicates: 0, reactionsMissing: 0, reactionsExtra: 0, editedMismatch: 0, severity: 0,
    };
    const byId = new Map(msgs.map((m) => [m.id, m]));
    const editTimes = new Set<number>();
    for (const m of msgs) {
      d.desktop.messages++;
      if (m.editedTs) (d.desktop.edited++, editTimes.add(m.editedTs));
      d.desktop.reactions += m.reactions;
      d.desktop.attachments += m.attachments;
    }
    for (const r of rows) if (r.edited_ts != null) editTimes.add(r.edited_ts);
    const held = new Set<string>();
    for (const r of rows) {
      held.add(r.id);
      if (r.deleted) continue;
      d.hub.messages++;
      if (r.edited_ts != null) d.hub.edited++;
      d.hub.reactions += r.reactions;
      d.hub.attachments += r.attachments;
      const m = byId.get(r.id);
      if (!m) {
        d.extraInHub++;
        if (editTimes.has(r.ts)) d.editDuplicates++;
        continue;
      }
      if (m.reactions > r.reactions) d.reactionsMissing += m.reactions - r.reactions;
      else d.reactionsExtra += r.reactions - m.reactions;
      if (!!m.editedTs !== (r.edited_ts != null)) d.editedMismatch++;
    }
    for (const m of msgs) if (!held.has(m.id)) d.missingInHub++;
    d.severity = d.editDuplicates * 4 + d.reactionsMissing * 3 + d.missingInHub * 2 + d.extraInHub * 2 + d.editedMismatch + d.reactionsExtra + Math.abs(d.desktop.attachments - d.hub.attachments);
    add(out.desktop, d.desktop);
    add(out.hub, d.hub);
    for (const k of ['missingInHub', 'extraInHub', 'editDuplicates', 'reactionsMissing', 'reactionsExtra', 'editedMismatch'] as const) out[k] += d[k];
    if (d.severity) out.mismatches.push(d);
    else out.matching++;
  }
  out.mismatches.sort((a, b) => b.severity - a.severity);

  // Signal chats of this account the hub has messages in, in the window, that Desktop has none of.
  const known = new Set(cids);
  const acc = hub.query(`SELECT a.id FROM account a JOIN identity i ON i.id = a.self_identity WHERE a.network = 'signal' AND i.native_id = ?`).get(self) as Row | null;
  const others = acc
    ? (hub
        .query(
          `SELECT DISTINCT m.conversation_id AS id FROM message m JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = m.conversation_id AND v.account_id = ?
           WHERE m.network = 'signal' AND m.ts BETWEEN ? AND ? AND m.kind NOT IN ('system', 'call') AND m.deleted = 0`,
        )
        .all(acc.id, from, to) as Row[])
    : (hub.query(`SELECT DISTINCT conversation_id AS id FROM message WHERE network = 'signal' AND ts BETWEEN ? AND ? AND kind NOT IN ('system', 'call') AND deleted = 0`).all(from, to) as Row[]);
  out.hubOnlyConversations = others.filter((r) => !known.has(r.id)).length;
  return out;
}
