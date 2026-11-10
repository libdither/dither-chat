/**
 * The inbox as it was at every moment you opened something (docs/inbox.md, "A learned order"): rebuilt from the
 * database, for the learned order to learn from (rank.ts) and for the replay to measure (scripts/inbox-replay.ts).
 *
 * Every candidate conversation's messages are folded in time order with attention.ts's fold; at each open, the
 * conversations the inbox would have listed are scored as of then: what was unread (messages from others since you
 * last wrote or stayed there; before the activity log starts, everything counts as read), where you had been (the
 * log's stays) and the mutes as they are now. Metadata only: never what was said.
 */
import type { Database } from 'bun:sqlite';
import { decayed } from '@dither-chat/protocol';
import { emptyTally, foldMessage, freshState, scoreConversation, sumTallies, type ConvState, type ScoreInput, type Scored, type Tally } from './attention.ts';
import { HORIZON, rankFeatures, type Moment, type Opened } from './rank.ts';
import type { Triage } from './triage.ts';

type Row = Record<string, any>;

/** Ids that are you: the accounts' own, and the identities of the person marked as you. */
export const SELF_SQL = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL UNION SELECT i.id FROM identity i JOIN person p ON p.id = i.person_id WHERE p.is_self = 1)`;
/** What the inbox always lists (attention.ts LISTED). */
const LISTED = `(c.shape IN ('direct', 'group', 'self') OR (c.shape = 'channel' AND NOT EXISTS (
  SELECT 1 FROM space_edge e WHERE e.child_kind = 'conversation' AND e.child_id = c.id)))`;

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
  /** Messages from others since the log began, in order: when, a mention of you, pushed. Older ones count as read. */
  incoming: { ts: number; mention: boolean; pushed: boolean }[];
  /** When you last wrote. */
  lastOwn: number | null;
}

/** One stay in a conversation or with a person, from the activity log. */
export interface Stay {
  id: string;
  start: number;
  end: number;
  active: number;
  source: string;
  /** Its inbox row's position then, from an inbox row. */
  rank: number | null;
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
}

/** Where you had been by `t`: per usage key, decayed seconds and visits and when you were last there. */
export function usageAt(stays: Stay[], t: number): Map<string, NonNullable<ScoreInput['usage']>> {
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
}

/** The candidates at `t`, as the inbox would have listed and scored them, with everything folded up to `t`. */
export function seenAt(w: World, t: number, usage = usageAt(w.stays, t)): Seen[] {
  const out: Seen[] = [];
  for (const c of w.convs.values()) {
    // Folded up to `t` only: a conversation with no messages yet is not in the inbox.
    if (c.lastMessageAt === null) continue;
    const u = usage.get(c.usageKey) ?? null;
    const there = u ? Math.max(u.at, u.lastVisit ?? 0) : null;
    const read = Math.max(c.lastOwn ?? 0, there ?? 0, w.logStart);
    let unread = 0;
    let mentions = 0;
    let pushedUnread = false;
    for (let i = c.incoming.length - 1; i >= 0 && c.incoming[i].ts > read; i--) {
      unread++;
      if (c.incoming[i].mention) mentions++;
      if (c.incoming[i].pushed) pushedUnread = true;
    }
    if (!c.listed && ((!mentions && !pushedUnread) || c.muted)) continue;
    const turn = c.state.turn?.addressed != null ? c.state.turn : null;
    const author = turn?.authorKey ? sumTallies([...(w.tallies.get(turn.authorKey)?.values() ?? [])], t) : null;
    out.push({
      conv: c,
      lastThere: there,
      input: { now: t, shape: c.shape, members: c.members, lastMessageAt: c.lastMessageAt, state: c.state, author, authorName: null, unread, mentions, pinged: pushedUnread ? 'a push' : null, muted: c.muted, usage: u },
    });
  }
  return out;
}

/** Conversations that ever mentioned you or had a message pushed: read a slice of the messages at a time (a generator, so the hub can pause between slices). */
export function* flagged(db: Database, slice = 10_000): Generator<undefined, Set<string>> {
  const out = new Set<string>();
  const max = ((db.query('SELECT MAX(rowid) AS n FROM message').get() as Row).n as number | null) ?? 0;
  const q = db.query(
    `SELECT DISTINCT m.conversation_id AS id FROM message m LEFT JOIN triage t ON t.message_id = m.id WHERE m.rowid > ? AND m.rowid <= ? AND (m.mentions_self = 1 OR t.decision IN ('push', 'quiet'))`,
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
export function loadWorld(db: Database, mutedOf: (id: string, shape: string) => string | null, since = 0, flaggedIds?: Set<string>): World {
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
          OR c.id IN (SELECT m.conversation_id FROM triage t JOIN message m ON m.id = t.message_id WHERE t.decision IN ('push', 'quiet'))`;
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
    });
  }
  const stays: Stay[] = [];
  for (const v of db
    .query(`SELECT id, start_at, end_at, active, source, rank, sent, view, conversation_id, person_id FROM visit WHERE view IN ('conversation', 'person') AND start_at >= ? ORDER BY start_at`)
    .all(since) as Row[]) {
    const c = v.conversation_id ? convs.get(v.conversation_id) : null;
    const person = v.view === 'person' ? v.person_id : c?.shape === 'direct' ? peerOf.get(c.id) : null;
    const key = person ? `person:${person}` : `conversation:${v.conversation_id}`;
    const targets = v.view === 'person' ? (dmsOf.get(v.person_id) ?? []) : v.conversation_id ? [v.conversation_id] : [];
    stays.push({ id: v.id, start: v.start_at, end: v.end_at, active: v.active, source: v.source, rank: v.rank, sent: v.sent, key, targets });
  }
  return { convs, stays, logStart: stays[0]?.start ?? Infinity, tallies: new Map(), self, selfPerson };
}

const FOLD = `
  SELECT m.id, m.ts, m.conversation_id AS cid, m.author_id, m.mentions_self, m.mentions_all, m.kind, m.deleted, i.is_bot, i.person_id,
         r.author_id AS reply_author,
         EXISTS (SELECT 1 FROM reaction x WHERE x.message_id = m.id AND x.identity_id IN ${SELF_SQL}) AS reacted,
         t.decision IN ('push', 'quiet') AS pushed, t.reasons LIKE '%asks a question%' AS question
  FROM message m INDEXED BY message_ts LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN message r ON r.id = m.reply_to_id LEFT JOIN triage t ON t.message_id = m.id
  WHERE m.conversation_id IN (SELECT value FROM json_each(?)) ORDER BY m.ts, m.rowid`;

/**
 * Fold every candidate's messages in time order, stopping at each moment in `at` (ascending) to call `visit` with
 * the world as it was then. `step` does about `maxMs` of it and says whether it is done, so the hub can run it
 * between other work. It reads through one query from start to end, in time order straight off the `message_ts`
 * index so nothing has to be sorted first: in the hub, give it a connection of its own (read-only), which then
 * reads one snapshot of the database without holding up anything else.
 */
export class Rebuild {
  private rows: Iterator<Row>;
  private next = 0;
  private done = false;

  constructor(
    db: Database,
    private w: World,
    private at: number[],
    private visit: (t: number, w: World) => void,
  ) {
    this.rows = (db.query(FOLD).iterate(JSON.stringify([...w.convs.keys()])) as IterableIterator<Row>)[Symbol.iterator]();
  }

  step(maxMs = 30): boolean {
    const start = performance.now();
    const w = this.w;
    const mine = (id: string | null, person: string | null) => (!!id && w.self.has(id)) || (!!person && person === w.selfPerson);
    let n = 0;
    while (!this.done && (++n % 256 || performance.now() - start < maxMs)) {
      const it = this.rows.next();
      if (it.done) {
        while (this.next < this.at.length) this.visit(this.at[this.next++], w);
        this.done = true;
        break;
      }
      const r = it.value;
      while (this.next < this.at.length && this.at[this.next] < r.ts) this.visit(this.at[this.next++], w);
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
      if (ignore) continue;
      c.lastMessageAt = Math.max(c.lastMessageAt ?? 0, r.ts);
      if (me) c.lastOwn = Math.max(c.lastOwn ?? 0, r.ts);
      else if (r.ts >= w.logStart) c.incoming.push({ ts: r.ts, mention: !!r.mentions_self, pushed: !!r.pushed });
    }
    return this.done;
  }

  /** Stop early: the query is let go. */
  close() {
    this.rows.return?.();
    this.done = true;
  }

  run() {
    while (!this.step(1e9));
  }
}

// ------------------------------------------------------------------ moments to learn from

/** What you opened within the horizon after `t`, each with how you first got there and how soon. */
export function openedAfter(stays: Stay[], t: number, horizon = HORIZON): Map<string, Opened> {
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
      return { x: rankFeatures(s.input, scored.get(s.conv.id)!), weight, open: opened.get(s.conv.id) ?? null, chosen, sent: chosen ? stay.sent > 0 : undefined, pos: pos.get(s.conv.id) };
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
