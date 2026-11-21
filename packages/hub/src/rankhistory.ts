/**
 * The inbox as it was at every moment you opened something (docs/inbox.md, "A learned order"): rebuilt from the
 * database, for the learned order to learn from (rank.ts) and for the replay to measure (scripts/inbox-replay.ts).
 *
 * Every candidate conversation's messages are folded in time order with attention.ts's fold; at each open, the
 * conversations the inbox would have listed are scored as of then: what was unread (messages from others since you
 * last wrote or stayed there; before the activity log starts, everything counts as read), where you had been (the
 * log's stays) and the mutes as they are now. Metadata only: never what was said.
 *
 * With `mail` (loadWorld's option), mail threads from a person are candidates too (mail/attention.ts): their messages
 * fold in the same time order from a second query, listed by MAIL_INBOX's rules as of each moment, with what is not
 * replayed (the account, flagged, rule 11, roles, mutes) as it is now. Opens of a thread are the log's `mail` stays
 * (and, before 2026-11-20, `conversation` stays with its id).
 */
import type { Database } from 'bun:sqlite';
import { QUIET_VARIANTS_SQL } from './feed.ts';
import type * as P from '@dither-chat/protocol';
import { decayed } from '@dither-chat/protocol';
import { emptyTally, foldMessage, freshState, PIN_FOR, scoreConversation, sumTallies, voteDirection, votesAt, type ConvState, type ScoreInput, type Scored, type Tally } from './attention.ts';
import { bondAt, HORIZON, mailRankFeatures, rankFeatures, type MailFacts, type Moment, type Opened } from './rank.ts';
import { MAIL_INBOX, MAIL_WINDOW } from './mail/attention.ts';
import type { Triage } from './triage.ts';
import { DEFAULT_MAIL_OWED_TABLE, type OwedTable } from './owed.ts';
import { FACTS_SQL, factsOf, type MessageFacts, type NeedsModel } from './needsreply.ts';

type Row = Record<string, any>;

/** Ids that are you: the accounts' own, and the identities of the person marked as you. */
export const SELF_SQL = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL UNION SELECT i.id FROM person p CROSS JOIN identity i ON i.person_id = p.id WHERE p.is_self = 1)`;
/** What the inbox always lists (attention.ts LISTED). */
const LISTED = `(c.variant NOT IN ${QUIET_VARIANTS_SQL} AND (c.shape IN ('direct', 'group', 'self') OR (c.shape = 'channel' AND NOT EXISTS (
  SELECT 1 FROM space_edge e WHERE e.child_kind = 'conversation' AND e.child_id = c.id))))`;

/** One conversation the inbox may list. */
export interface Conv {
  id: string;
  shape: ScoreInput['shape'];
  members: number;
  /** Always listed (a DM, group, notes, a room outside a space); else only while it has an unread mention or push. */
  listed: boolean;
  /** The usage key: the person for a DM, else the conversation. */
  usageKey: string;
  muted: string | null;
  state: ConvState;
  lastMessageAt: number | null;
  /**
   * Messages from others since the log began, in order: when, a mention of you, whether triage put it in a tier
   * (`pushed`), which (null: not decided, or silent) and its importance, with your vote and when. Older ones count as
   * read.
   */
  incoming: { ts: number; mention: boolean; pushed: boolean; level: P.TriageDecision | null; score: number | null; vote: P.TriageDecision | null; votedAt: number | null }[];
  /** When you last wrote. */
  lastOwn: number | null;
  /** The open turn's messages from others as facts (needsreply.ts), with when, up to TURN_FACTS of them. */
  turnFacts: (MessageFacts & { ts: number })[];
  /** A mail thread's (world option `mail`): what the fold keeps of it besides a chat's. */
  mail?: MailConv;
}

/** A mail thread as a candidate: what is as it is now, and what the fold keeps. */
export interface MailConv {
  account: string;
  unknown: boolean;
  flagged: boolean;
  /** Your own messages' Message-IDs so far: a reply to one replies to you. */
  mine: Set<string>;
  /** The latest message from someone else so far: how it reached you, and its sender (lower-cased). */
  addressed: MailFacts['addressed'];
  from: string | null;
}

/** A turn's messages the needs-reply model reads, at most (needsreply.ts `turnMessagesQuery` reads as many). */
const TURN_FACTS = 60;

/** One stay in a conversation or with a person, from the activity log. */
export interface Stay {
  id: string;
  start: number;
  end: number;
  active: number;
  source: string;
  /** Its inbox row's position then, from an inbox row. */
  rank: number | null;
  /** Where that row stood in the shadow order with mail (docs/inbox.md), when the device said. */
  shadowRank?: number | null;
  sent: number;
  /** The usage key it counts for, and the conversations it opens. */
  key: string;
  targets: string[];
}

/** Opens worth learning from and asking about: a choice you made. App start and resuming are not. */
export const isChoice = (s: Pick<Stay, 'source' | 'active'>) => s.source !== 'start' && s.source !== 'resume' && (s.active >= 3 || s.source === 'notification' || s.source === 'toast');

export interface World {
  convs: Map<string, Conv>;
  stays: Stay[];
  /** The first stay in the log: before it, nobody knows where you were. */
  logStart: number;
  /** Tallies per author, per conversation. */
  tallies: Map<string, Map<string, Tally>>;
  self: Set<string>;
  selfPerson: string | null;
  /** Your votes on each conversation's messages: when, and up (1), down (−1) or right (0). */
  votes: Map<string, { at: number; dir: number }[]>;
  /** The owed table to score with (owed.ts): the hub's, else the default. */
  owedTable?: OwedTable;
  /** Mail's, as mail/attention.ts weighs its rows: the hub's, else DEFAULT_MAIL_OWED_TABLE. */
  mailOwedTable?: OwedTable;
  /** The needs-reply model over it (needsreply.ts): the hub's, else the table alone. */
  needsModel?: NeedsModel | null;
  /** With mail: how you answer each mail correspondent, per thread, keyed by their person (else address). */
  mailTallies?: Map<string, Map<string, Tally>>;
  /** With mail: the person behind each email address, and each person's closeness by month (`bondAt`). */
  personOf?: Map<string, string>;
  bonds?: Map<string, number[]>;
}

/** Where you had been by `t`: per usage key, decayed seconds and visits and when you were last there. */
function usageAt(stays: Stay[], t: number): Map<string, NonNullable<ScoreInput['usage']>> {
  const out = new Map<string, NonNullable<ScoreInput['usage']>>();
  for (const s of stays) {
    if (s.start >= t) break;
    const end = Math.min(s.end, t);
    const seconds = Math.min(s.active, (end - s.start) / 1000 + 60);
    const counted = s.active >= 3;
    const u = out.get(s.key) ?? { score: 0, visitScore: 0, at: end, lastVisit: null };
    const at = Math.max(u.at, end);
    out.set(s.key, {
      score: decayed(u.score, u.at, at) + decayed(seconds, end, at),
      visitScore: decayed(u.visitScore, u.at, at) + (counted ? decayed(1, end, at) : 0),
      at,
      lastVisit: counted ? Math.max(u.lastVisit ?? 0, s.start + 3000) : u.lastVisit,
    });
  }
  return out;
}

/** One candidate at one moment: cheap to list; `input` folds in what scoring needs. */
export interface Seen {
  conv: Conv;
  input: ScoreInput;
  /** When you were last there (from the log), or null. */
  lastThere: number | null;
  /** A mail thread's facts as of then. */
  mail?: MailFacts;
}

/**
 * A mail thread at `t`, as mail/attention.ts lists and scores it (`isListed`, `input`): unread since you were last
 * there or wrote, To you a mention; only an alert is pinned; how you answer its author is their mail and chat summed.
 */
function mailSeen(w: World, c: Conv, m: MailConv, t: number, usage: Map<string, NonNullable<ScoreInput['usage']>>): Seen | null {
  const u = usage.get(c.usageKey) ?? null;
  const there = u ? Math.max(u.at, u.lastVisit ?? 0) : null;
  const read = Math.max(c.lastOwn ?? 0, there ?? 0, w.logStart);
  let unread = 0;
  let mentions = 0;
  let told: (typeof c.incoming)[number] | null = null;
  let level: P.TriageDecision | null = null;
  for (let i = c.incoming.length - 1; i >= 0 && c.incoming[i].ts > read; i--) {
    const x = c.incoming[i];
    unread++;
    if (x.mention) mentions++;
    if (x.pushed) told ??= x;
    if (!level && x.level) level = x.level;
  }
  const turn = c.state.turn?.addressed != null ? c.state.turn : null;
  const W = MAIL_INBOX;
  const last = c.lastMessageAt ?? 0;
  const listed = (unread > 0 && t - last <= W.unread) || (!!turn && t - turn.addressed! <= W.owed) || t - last <= W.recent || (there !== null && t - there <= W.opened);
  if (!listed) return null;
  const person = turn?.authorKey?.startsWith('per_') ? turn.authorKey : null;
  const author = turn?.authorKey ? sumTallies([...(w.mailTallies?.get(turn.authorKey)?.values() ?? []), ...(person ? (w.tallies.get(person)?.values() ?? []) : [])], t) : null;
  const sender = m.from ? (w.personOf?.get(m.from) ?? null) : null;
  return {
    conv: c,
    lastThere: there,
    mail: { addressed: m.addressed, unknown: m.unknown, flagged: m.flagged, account: m.account, known: !!sender, bond: sender ? bondAt(w.bonds?.get(sender), t) : 0 },
    input: {
      now: t,
      shape: c.shape,
      members: c.members,
      lastMessageAt: c.lastMessageAt,
      state: c.state,
      author,
      authorName: null,
      unread,
      mentions,
      pinged: told && told.level === 'push' ? 'a push' : null,
      alerted: !!told && told.level === 'push' && t - told.ts <= PIN_FOR,
      importance: told?.score ?? null,
      muted: null,
      usage: u,
      level,
      // Mail's own table and two weeks, as the live mail rows (mail/attention.ts MAIL_WINDOW).
      owedTable: w.mailOwedTable ?? DEFAULT_MAIL_OWED_TABLE,
      needsModel: null,
      turnMessages: null,
    },
  };
}

/** The candidates at `t`, as the inbox would have listed and scored them, with everything folded up to `t`. */
export function seenAt(w: World, t: number, usage = usageAt(w.stays, t)): Seen[] {
  const out: Seen[] = [];
  for (const c of w.convs.values()) {
    // Folded up to `t` only: a conversation with no messages yet is not in the inbox.
    if (c.lastMessageAt === null) continue;
    if (c.mail) {
      const m = mailSeen(w, c, c.mail, t, usage);
      if (m) out.push(m);
      continue;
    }
    const u = usage.get(c.usageKey) ?? null;
    const there = u ? Math.max(u.at, u.lastVisit ?? 0) : null;
    const read = Math.max(c.lastOwn ?? 0, there ?? 0, w.logStart);
    let unread = 0;
    let mentions = 0;
    let pushedUnread = false;
    let level: P.TriageDecision | null = null;
    // The newest unread message triage put in a tier, as Attention.input reads it (`lastPush`).
    let told: (typeof c.incoming)[number] | null = null;
    for (let i = c.incoming.length - 1; i >= 0 && c.incoming[i].ts > read; i--) {
      const m = c.incoming[i];
      unread++;
      if (m.mention) mentions++;
      if (m.pushed) {
        pushedUnread = true;
        told ??= m;
      }
      // The newest one triage decided on, with your vote only once you had cast it.
      if (!level && m.level) level = m.vote && m.votedAt != null && m.votedAt <= t ? m.vote : m.level;
    }
    if (!c.listed && ((!mentions && !pushedUnread) || c.muted)) continue;
    const turn = c.state.turn?.addressed != null ? c.state.turn : null;
    const author = turn?.authorKey ? sumTallies([...(w.tallies.get(turn.authorKey)?.values() ?? [])], t) : null;
    out.push({
      conv: c,
      lastThere: there,
      input: {
        now: t,
        shape: c.shape,
        members: c.members,
        lastMessageAt: c.lastMessageAt,
        state: c.state,
        author,
        authorName: null,
        unread,
        mentions,
        // As the live inbox has it: an alert or a Conversation is pinged, an alert is pinned while fresh, and any tier
        // brings its importance. (A swipe since is not replayed: the row then counts a little more than it did.)
        pinged: told && (told.level === 'push' || told.level === 'quiet') ? 'a push' : null,
        alerted: !!told && told.level === 'push' && t - told.ts <= PIN_FOR,
        importance: told?.score ?? null,
        muted: c.muted,
        usage: u,
        level,
        votes: votesAt(w.votes.get(c.id), t),
        owedTable: w.owedTable ?? null,
        needsModel: w.needsModel ?? null,
        turnMessages: turn ? c.turnFacts : null,
      },
    });
  }
  return out;
}

/** Conversations that ever mentioned you or had a message pushed: read a slice of the messages at a time (a generator, so the hub can pause between slices). */
export function* flagged(db: Database, slice = 10_000): Generator<undefined, Set<string>> {
  const out = new Set<string>();
  const max = ((db.query('SELECT MAX(rowid) AS n FROM message').get() as Row).n as number | null) ?? 0;
  const q = db.query(
    `SELECT DISTINCT m.conversation_id AS id FROM message m LEFT JOIN triage t ON t.message_id = m.id WHERE m.rowid > ? AND m.rowid <= ? AND (m.mentions_self = 1 OR t.decision IN ('push', 'quiet', 'digest'))`,
  );
  for (let a = 0; a < max; a += slice) {
    for (const r of q.all(a, a + slice) as Row[]) out.add(r.id);
    yield;
  }
  return out;
}

/**
 * The candidates and the log, ready to fold. `mutedOf` says where a conversation's mute comes from now (triage's
 * effective level), or null. Stays from `since` on. `flaggedIds` (from `flagged`) saves reading every message here.
 */
export function loadWorld(db: Database, mutedOf: (id: string, shape: string) => string | null, since = 0, flaggedIds?: Set<string>, o: WorldOptions = {}): World {
  const self = new Set((db.query(`SELECT * FROM ${SELF_SQL}`).all() as Row[]).map((r) => Object.values(r)[0] as string));
  const selfPerson = (db.query('SELECT id FROM person WHERE is_self = 1').get() as Row | null)?.id ?? null;
  const peerOf = new Map<string, string>();
  const dmsOf = new Map<string, string[]>();
  for (const r of db
    .query(
      `SELECT c.id, i.person_id FROM conversation c JOIN participant pa ON pa.conversation_id = c.id JOIN identity i ON i.id = pa.identity_id
       LEFT JOIN person p ON p.id = i.person_id WHERE c.shape = 'direct' AND i.person_id IS NOT NULL AND COALESCE(p.is_self, 0) = 0 AND i.id NOT IN ${SELF_SQL}`,
    )
    .all() as Row[]) {
    if (peerOf.has(r.id)) continue;
    peerOf.set(r.id, r.person_id);
    dmsOf.set(r.person_id, [...(dmsOf.get(r.person_id) ?? []), r.id]);
  }
  // Candidates: what the inbox always lists, and anything that ever mentioned you or was pushed.
  const convs = new Map<string, Conv>();
  const extra = flaggedIds
    ? `c.id IN (SELECT value FROM json_each(?))`
    : `c.id IN (SELECT conversation_id FROM message WHERE mentions_self = 1)
          OR c.id IN (SELECT m.conversation_id FROM triage t JOIN message m ON m.id = t.message_id WHERE t.decision IN ('push', 'quiet', 'digest'))`;
  for (const r of db
    .query(`SELECT c.id, c.shape, ${LISTED} AS listed, (SELECT COUNT(*) FROM participant WHERE conversation_id = c.id) AS members FROM conversation c WHERE ${LISTED} OR ${extra}`)
    .all(...(flaggedIds ? [JSON.stringify([...flaggedIds])] : [])) as Row[]) {
    const peer = peerOf.get(r.id);
    convs.set(r.id, {
      id: r.id,
      shape: r.shape,
      members: r.members,
      listed: !!r.listed,
      usageKey: r.shape === 'direct' && peer ? `person:${peer}` : `conversation:${r.id}`,
      muted: mutedOf(r.id, r.shape),
      state: freshState(),
      lastMessageAt: null,
      incoming: [],
      lastOwn: null,
      turnFacts: [],
    });
  }
  const mail = o.mail && hasMail(db) ? loadMail(db, convs, o.bonds) : null;
  const stays: Stay[] = [];
  for (const v of db
    .query(
      `SELECT id, start_at, end_at, active, source, rank, ${hasColumn(db, 'visit', 'shadow_rank') ? 'shadow_rank' : 'NULL AS shadow_rank'}, sent, view, conversation_id, person_id FROM visit
       WHERE (view IN ('conversation', 'person') OR (? AND view = 'mail' AND conversation_id IS NOT NULL)) AND start_at >= ? ORDER BY start_at`,
    )
    .all(mail ? 1 : 0, since) as Row[]) {
    // A mail thread's: from the Mail page or an inbox row (a `conversation` stay with its id, before 2026-11-20).
    if (v.conversation_id?.startsWith('mth_')) {
      if (!mail) continue;
      stays.push({ id: v.id, start: v.start_at, end: v.end_at, active: v.active, source: v.source, rank: v.rank, shadowRank: v.shadow_rank, sent: v.sent, key: `mail:${v.conversation_id}`, targets: [v.conversation_id] });
      continue;
    }
    if (v.view === 'mail') continue;
    const c = v.conversation_id ? convs.get(v.conversation_id) : null;
    const person = v.view === 'person' ? v.person_id : c?.shape === 'direct' ? peerOf.get(c.id) : null;
    const key = person ? `person:${person}` : `conversation:${v.conversation_id}`;
    const targets = v.view === 'person' ? (dmsOf.get(v.person_id) ?? []) : v.conversation_id ? [v.conversation_id] : [];
    stays.push({ id: v.id, start: v.start_at, end: v.end_at, active: v.active, source: v.source, rank: v.rank, shadowRank: v.shadow_rank, sent: v.sent, key, targets });
  }
  const votes = new Map<string, { at: number; dir: number }[]>();
  for (const r of db
    .query(`SELECT m.conversation_id AS cid, t.decision, t.feedback, t.feedback_at AS at FROM triage t JOIN message m ON m.id = t.message_id WHERE t.feedback IS NOT NULL AND t.feedback_at IS NOT NULL`)
    .all() as Row[]) {
    if (!convs.has(r.cid)) continue;
    votes.set(r.cid, [...(votes.get(r.cid) ?? []), { at: r.at, dir: voteDirection(r.decision, r.feedback) }]);
  }
  return { convs, stays, logStart: stays[0]?.start ?? Infinity, tallies: new Map(), self, selfPerson, votes, ...(mail ?? {}) };
}

/** What loadWorld can be asked for besides chats. */
interface WorldOptions {
  /** Mail threads from a person as candidates too. */
  mail?: boolean;
  /** The people graph's closeness by identity (closeness.ts `byIdentity`), for mail's `mailBond`. */
  bonds?: Record<string, number[]> | null;
}

const hasMail = (db: Database) => !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mail_triage'`).get();
const hasColumn = (db: Database, table: string, col: string) => (db.query(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, col) as Row | null) !== null;

/**
 * Mail threads the one-list inbox may have listed (mail/attention.ts): from a person, in Inbox, not muted, on an
 * account not hidden, and, personal only by rule 11, rated by mail triage now. Their people and closeness.
 */
function loadMail(db: Database, convs: Map<string, Conv>, bonds?: Record<string, number[]> | null): Pick<World, 'mailTallies' | 'personOf' | 'bonds'> {
  const lc = (x: string | null) => (x ?? '').trim().toLowerCase();
  for (const r of db
    .query(
      `SELECT t.id, t.participants, t.flagged, a.kind, COALESCE(f.unknown, 0) AS unknown, a.address,
              (SELECT COALESCE(mt.feedback, mt.level, mt.decision) FROM mail_triage mt JOIN mail_message mm ON mm.id = mt.message_id WHERE mm.thread_id = t.id ORDER BY mm.received_at DESC, mm.id DESC LIMIT 1) AS rated
       FROM mail_thread t JOIN mail_account a ON a.id = t.account_id LEFT JOIN mail_feature f ON f.thread_id = t.id
       WHERE t.class = 'personal' AND t.muted = 0 AND a.hidden = 0 AND EXISTS (SELECT 1 FROM json_each(t.roles) WHERE value = 'inbox')`,
    )
    .all() as Row[]) {
    if (r.unknown && !['push', 'quiet', 'digest'].includes(r.rated)) continue;
    const selfAddr = new Set([lc(r.address)]);
    let parts: { e?: string }[] = [];
    try {
      parts = JSON.parse(r.participants);
    } catch {}
    const others = parts.filter((p) => p.e && !selfAddr.has(lc(p.e))).length;
    convs.set(r.id, {
      id: r.id,
      shape: others <= 1 ? 'direct' : 'group',
      members: others <= 1 ? 2 : others + 1,
      listed: false,
      usageKey: `mail:${r.id}`,
      muted: null,
      state: freshState(),
      lastMessageAt: null,
      incoming: [],
      lastOwn: null,
      turnFacts: [],
      mail: { account: r.kind, unknown: !!r.unknown, flagged: !!r.flagged, mine: new Set(), addressed: null, from: null },
    });
  }
  const personOf = new Map<string, string>();
  for (const r of db.query(`SELECT native_id, person_id FROM identity WHERE network = 'email' AND person_id IS NOT NULL`).all() as Row[]) personOf.set(lc(r.native_id), r.person_id);
  const out = new Map<string, number[]>();
  if (bonds) {
    const ids = Object.keys(bonds);
    const q = db.query(`SELECT id, person_id FROM identity WHERE person_id IS NOT NULL AND id IN (SELECT value FROM json_each(?))`);
    for (let i = 0; i < ids.length; i += 5000)
      for (const r of q.all(JSON.stringify(ids.slice(i, i + 5000))) as Row[]) {
        const months = out.get(r.person_id);
        if (months) months.push(...bonds[r.id]);
        else out.set(r.person_id, [...bonds[r.id]]);
      }
  }
  return { mailTallies: new Map(), personOf, bonds: out };
}

const FOLD = `
  SELECT m.id, m.ts, m.conversation_id AS cid, m.author_id, m.mentions_self, m.mentions_all, m.kind, m.deleted, i.is_bot, i.person_id,
         r.author_id AS reply_author,
         EXISTS (SELECT 1 FROM reaction x WHERE x.message_id = m.id AND x.identity_id IN ${SELF_SQL}) AS reacted,
         t.decision IN ('push', 'quiet', 'digest') AS pushed, t.reasons LIKE '%asks a question%' AS question,
         t.decision, t.score, t.feedback, t.feedback_at, ${FACTS_SQL}
  FROM message m INDEXED BY message_ts LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN message r ON r.id = m.reply_to_id LEFT JOIN triage t ON t.message_id = m.id
  WHERE m.conversation_id IN (SELECT value FROM json_each(?)) ORDER BY m.ts, m.rowid`;

const MAIL_FOLD = `
  SELECT m.id, m.thread_id AS cid, m.received_at AS ts, lower(trim(m.from_addr)) AS author, m.addressed, m.in_reply_to, m.message_id_hdr, m.class,
         mt.decision, mt.level, mt.score, mt.delivered, mt.feedback, mt.facts LIKE '%"question":true%' AS question
  FROM mail_message m LEFT JOIN mail_triage mt ON mt.message_id = m.id
  WHERE m.thread_id IN (SELECT value FROM json_each(?)) AND m.draft = 0 ORDER BY m.received_at, m.id`;

/**
 * Fold every candidate's messages in time order, stopping at each moment in `at` (ascending) to call `visit` with
 * the world as it was then. `step` does about `maxMs` of it and says whether it is done, so the hub can run it
 * between other work. It reads through one query from start to end, in time order straight off the `message_ts`
 * index so nothing has to be sorted first: in the hub, give it a connection of its own (read-only), which then
 * reads one snapshot of the database without holding up anything else.
 */
export class Rebuild {
  private rows: Iterator<Row>;
  /** Mail's messages, merged in by time; the next of each stream waiting. */
  private mailRows: Iterator<Row> | null = null;
  private chatHead: Row | null | undefined = undefined;
  private mailHead: Row | null | undefined = undefined;
  private next = 0;
  private done = false;

  constructor(
    db: Database,
    private w: World,
    private at: number[],
    private visit: (t: number, w: World) => void,
  ) {
    const chats = [...w.convs.values()].filter((c) => !c.mail).map((c) => c.id);
    const mails = [...w.convs.values()].filter((c) => c.mail).map((c) => c.id);
    this.rows = (db.query(FOLD).iterate(JSON.stringify(chats)) as IterableIterator<Row>)[Symbol.iterator]();
    if (mails.length) this.mailRows = (db.query(MAIL_FOLD).iterate(JSON.stringify(mails)) as IterableIterator<Row>)[Symbol.iterator]();
  }

  /** The next message of either stream, the earlier first; null when both are done. */
  private take(): { r: Row; mail: boolean } | null {
    if (this.chatHead === undefined) this.chatHead = this.rows.next().value ?? null;
    if (this.mailHead === undefined) this.mailHead = this.mailRows?.next().value ?? null;
    const c = this.chatHead;
    const m = this.mailHead;
    if (!c && !m) return null;
    if (c && (!m || c.ts <= m.ts)) {
      this.chatHead = undefined;
      return { r: c, mail: false };
    }
    this.mailHead = undefined;
    return { r: m!, mail: true };
  }

  /** One mail message, as MailAttention.fold folds it. */
  private foldMail(r: Row) {
    const w = this.w;
    const c = w.convs.get(r.cid)!;
    const m = c.mail!;
    const me = r.addressed === 'self';
    if (me && r.message_id_hdr) m.mine.add(r.message_id_hdr);
    const person = r.author ? (w.personOf?.get(r.author) ?? null) : null;
    const key = person ?? (r.author || null);
    foldMessage(
      c.state,
      (k) => {
        const tallies = (w.mailTallies ??= new Map());
        let x = tallies.get(k);
        if (!x) tallies.set(k, (x = new Map()));
        let t = x.get(c.id);
        if (!t) x.set(c.id, (t = emptyTally()));
        return t;
      },
      {
        id: r.id,
        ts: r.ts,
        author: r.author || null,
        authorKey: key,
        mine: me,
        bot: r.class === 'bulk',
        mentionsMe: r.addressed === 'to',
        repliesToMe: !!r.in_reply_to && m.mine.has(r.in_reply_to),
        question: !!r.question,
        pushed: !!r.delivered,
        ignore: false,
      },
      { shape: c.shape, members: c.members, window: MAIL_WINDOW },
    );
    c.lastMessageAt = Math.max(c.lastMessageAt ?? 0, r.ts);
    if (me) {
      c.lastOwn = Math.max(c.lastOwn ?? 0, r.ts);
      return;
    }
    m.addressed = r.addressed === 'to' || r.addressed === 'cc' ? r.addressed : 'hidden';
    m.from = r.author || null;
    if (r.ts >= w.logStart) {
      const level = r.feedback ?? r.level ?? r.decision;
      c.incoming.push({ ts: r.ts, mention: r.addressed === 'to', pushed: !!r.delivered, level: level && level !== 'silent' ? level : null, score: r.delivered ? (r.score ?? null) : null, vote: null, votedAt: null });
    }
  }

  step(maxMs = 30): boolean {
    const start = performance.now();
    const w = this.w;
    const mine = (id: string | null, person: string | null) => (!!id && w.self.has(id)) || (!!person && person === w.selfPerson);
    let n = 0;
    while (!this.done && (++n % 256 || performance.now() - start < maxMs)) {
      const it = this.take();
      if (!it) {
        while (this.next < this.at.length) this.visit(this.at[this.next++], w);
        this.done = true;
        break;
      }
      const r = it.r;
      while (this.next < this.at.length && this.at[this.next] < r.ts) this.visit(this.at[this.next++], w);
      if (it.mail) {
        this.foldMail(r);
        continue;
      }
      const c = w.convs.get(r.cid)!;
      const me = mine(r.author_id, r.person_id);
      const ignore = !!r.deleted || r.kind === 'system';
      foldMessage(
        c.state,
        (k) => {
          let m = w.tallies.get(k);
          if (!m) w.tallies.set(k, (m = new Map()));
          let t = m.get(c.id);
          if (!t) m.set(c.id, (t = emptyTally()));
          return t;
        },
        {
          id: r.id,
          ts: r.ts,
          author: r.author_id,
          authorKey: r.person_id ?? r.author_id,
          mine: me,
          bot: !!r.is_bot,
          mentionsMe: !!r.mentions_self && !r.mentions_all,
          repliesToMe: mine(r.reply_author, null),
          question: !!r.question,
          pushed: !!r.pushed,
          ignore,
          reactedByMe: !!r.reacted,
        },
        { shape: c.shape, members: c.members },
      );
      // The open turn's messages, as the hub reads them for the needs-reply model.
      const turn = c.state.turn?.addressed ?? null;
      if (me || turn === null) c.turnFacts.length = 0;
      else if (!ignore) {
        if (c.turnFacts.length && c.turnFacts[0].ts < turn) c.turnFacts = c.turnFacts.filter((f) => f.ts >= turn);
        if (c.turnFacts.length < TURN_FACTS && r.ts <= turn + 2 * 86_400_000)
          c.turnFacts.push({ ts: r.ts, ...factsOf(r as any, (!!r.mentions_self && !r.mentions_all) || mine(r.reply_author, null), r.person_id ?? r.author_id) });
      }
      if (ignore) continue;
      c.lastMessageAt = Math.max(c.lastMessageAt ?? 0, r.ts);
      if (me) c.lastOwn = Math.max(c.lastOwn ?? 0, r.ts);
      else if (r.ts >= w.logStart)
        c.incoming.push({
          ts: r.ts,
          mention: !!r.mentions_self,
          pushed: !!r.pushed,
          level: r.decision && r.decision !== 'silent' ? r.decision : null,
          score: r.score ?? null,
          vote: r.feedback ?? null,
          votedAt: r.feedback_at ?? null,
        });
    }
    return this.done;
  }

  /** Stop early: the query is let go. */
  close() {
    this.rows.return?.();
    this.mailRows?.return?.();
    this.done = true;
  }

  run() {
    while (!this.step(1e9));
  }
}

// ------------------------------------------------------------------ moments to learn from

/** What you opened within the horizon after `t`, each with how you first got there and how soon. */
function openedAfter(stays: Stay[], t: number, horizon = HORIZON): Map<string, Opened> {
  const out = new Map<string, Opened>();
  for (const s of stays) {
    if (s.start < t) continue;
    if (s.start > t + horizon) break;
    if (!isChoice(s)) continue;
    for (const id of s.targets) if (!out.has(id)) out.set(id, { source: s.source, rank: s.rank, after: s.start - t });
  }
  return out;
}

/** Rows kept per moment besides what was opened: the likeliest by recency, and a sample of the rest standing for all of it. */
export const KEEP_RECENT = 40;
export const KEEP_SAMPLE = 40;

/**
 * Which candidates of one moment to learn from: everything opened within the horizon, the KEEP_RECENT with the
 * latest message or stay (the ones the order has to get right), and KEEP_SAMPLE of the rest, each counting for as
 * many as it stands for. Deterministic for a given moment.
 */
export function sample(seen: Seen[], opened: Map<string, unknown>, t: number): { seen: Seen; weight: number }[] {
  const recent = (s: Seen) => Math.max(s.input.lastMessageAt ?? 0, s.lastThere ?? 0);
  const pos = seen.filter((s) => opened.has(s.conv.id));
  const neg = seen.filter((s) => !opened.has(s.conv.id)).sort((a, b) => recent(b) - recent(a) || (a.conv.id < b.conv.id ? -1 : 1));
  const top = neg.slice(0, KEEP_RECENT);
  const rest = neg.slice(KEEP_RECENT);
  let seed = Math.floor(t) % 2147483647 || 1;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const kept = rest.slice(0, KEEP_SAMPLE);
  const w = kept.length ? rest.length / kept.length : 1;
  return [...pos.map((s) => ({ seen: s, weight: 1 })), ...top.map((s) => ({ seen: s, weight: 1 })), ...kept.map((s) => ({ seen: s, weight: w }))];
}

/**
 * One open as a training moment: the sampled candidates' features, opened within the horizon or not. Null if the
 * inbox did not list it. The replay builds them with a longer `horizon` to try shorter ones (fitRank's `horizon`).
 */
export function momentOf(w: World, stay: Stay, t: number, seen = seenAt(w, t), horizon = HORIZON): Moment | null {
  if (!stay.targets.some((id) => seen.some((s) => s.conv.id === id))) return null;
  const opened = openedAfter(w.stays, t, horizon);
  const scored = new Map(seen.map((s) => [s.conv.id, scoreConversation(s.input)]));
  const pos = positions(seen, scored);
  return {
    at: t,
    rows: sample(seen, opened, t).map(({ seen: s, weight }) => {
      const chosen = stay.targets.includes(s.conv.id);
      const sc = scored.get(s.conv.id)!;
      return { x: s.mail ? mailRankFeatures(s.input, sc, s.mail) : rankFeatures(s.input, sc), weight, mail: !!s.mail, open: opened.get(s.conv.id) ?? null, chosen, sent: chosen ? stay.sent > 0 : undefined, pos: pos.get(s.conv.id) };
    }),
  };
}

/**
 * Where each candidate stood in the formula's one list (muted last, then by score, then the latest message): what
 * the inbox showed, near enough. The visit log keeps the position of what you opened only.
 */
export function positions(seen: Seen[], scored: Map<string, Scored>): Map<string, number> {
  const muted = (s: Seen) => Number(!!s.input.muted && s.conv.shape !== 'self');
  const order = [...seen].sort(
    (a, b) => muted(a) - muted(b) || scored.get(b.conv.id)!.score - scored.get(a.conv.id)!.score || (b.input.lastMessageAt ?? 0) - (a.input.lastMessageAt ?? 0) || (a.conv.id < b.conv.id ? -1 : 1),
  );
  return new Map(order.map((s, i) => [s.conv.id, i]));
}

/** Where a conversation's mute comes from now, by triage's effective level; notes to self are quiet, not muted. */
export const mutedBy = (triage: Pick<Triage, 'effectiveLevel'>) => (id: string, shape: string) => {
  const eff = triage.effectiveLevel(id);
  const quiet = eff.level === 'none' || eff.level === 'digest';
  return quiet && !(shape === 'self' && !eff.explicit) ? eff.source : null;
};
