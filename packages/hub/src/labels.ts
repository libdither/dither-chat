/**
 * Labels from what you did (docs/notifications.md): what happened after a message, read from the future, and what
 * that says about its importance. Your marks stay the gold standard (votes.ts); these fill in where there are none,
 * each with a weight. Nothing here says anything about alerts: answering or opening something says it mattered, not
 * that it could not wait.
 *
 * `gatherOutcomes` reads the outcomes for a span of messages in one pass (messages, your reactions, notifications and
 * visits), for the live hub and the replay alike. `implicitLabel` turns one outcome into a label.
 * Nothing here reads what was said.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { SELF_SQL } from './interact.ts';

type Head = P.TriageHead;
type Row = Record<string, any>;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** You wrote there this recently before it: you were already in the conversation. */
export const ENGAGED_BEFORE = 15 * MIN;
/** A quick answer. */
export const QUICK = 15 * MIN;
/** An answer at all: worth seeing. */
export const LATE = 3 * HOUR;
/** Opened within this long. */
export const OPEN_WITHIN = HOUR;
/** A push not opened in this long was ignored. */
export const IGNORED_AFTER = DAY;
/** Messages from others closer together than this are one burst. */
export const BURST = 30 * MIN;
/** The coalescing lull: a message after this long without one starts a new alert (design §7). */
export const LULL = 5 * MIN;

/** What happened after one message from someone else. Times are ms after the message. */
export interface Outcome {
  id: string;
  conv: string;
  ts: number;
  /** You wrote there in the 15 minutes before it. */
  engaged: boolean;
  /** A visit to its conversation (or its DM peer) spanned it: you saw it arrive. */
  seenLive: boolean;
  /** Your next message in its conversation, after it. */
  nextOwn: number | null;
  /** That message answers this one: it replies to it, or this was the last message before it. */
  answered: boolean;
  /** You reacted to it (reactions carry no time). */
  reacted: boolean;
  /** Triage's decision at the time, and whether a notification went out. */
  decision: string;
  notified: boolean;
  shown: boolean;
  suppressed: boolean;
  dismissed: boolean;
  tapped: number | null;
  /** Seconds in use during the visit the tap led to. */
  tapDwell: number | null;
  /** First open of its conversation after it, any route, and that visit's seconds in use. */
  opened: number | null;
  openDwell: number | null;
  /** The first message of a burst of others' messages (after a lull of BURST), and of one after LULL. */
  burstFirst: boolean;
  lullFirst: boolean;
  /** The first message of a burst nobody was notified about, whose conversation you opened within the hour anyway. */
  unprompted: boolean;
  /** It mentions you or replies to you. */
  addressed: boolean;
  /** How long after it there is data. */
  observed: number;
}

/**
 * Weights of each kind of label, against a mark's 1. Only what you did counts by default. The replay tried the two
 * "you did not" labels on ten days of a real hub (2026-11, docs/triage-replay.md) and both made the list worse:
 *  - with "nothing happened" as a no, the list at its strictest level (0.9) held 15 of the 54 chats you opened,
 *    where what you did alone finds 30;
 *  - a swipe as a no: 24 at that level against 30. A swipe says you read the row, not that it did not matter.
 * "Less like this" is the way to say no (votes.ts).
 */
export interface LabelWeights {
  /** You answered it within three hours, or reacted to it. */
  answered: number;
  /** You tapped its notification, or opened its chat within a day and stayed a few seconds. */
  opened: number;
  /** You swiped its list row away and did not open the chat within a day. Off: see above. */
  dismissed: number;
  /**
   * Nothing at all happened after the first message of a burst (no answer, reaction or open in a day, not addressed
   * to you). Off: see above.
   */
  nothing: number;
}

export const LABEL_WEIGHTS: LabelWeights = { answered: 0.5, opened: 0.5, dismissed: 0, nothing: 0 };
/** An open counts when you stayed at least this many seconds. */
export const OPEN_DWELL = 5;

export interface Label {
  y: Partial<Record<Head, 0 | 1>>;
  weight: number;
  /** Which rules said so, for reports. */
  why: string[];
  /** When the label could first be known: training on day d only sees labels known before it. */
  knownAt: number;
}

/**
 * What an outcome says about importance, or null when it says nothing. Something you did (answered, reacted, opened)
 * wins over something you did not; the weight is the strongest rule's. A message you watched arrive says nothing:
 * you were already there.
 */
export function implicitLabel(o: Outcome, w: LabelWeights = LABEL_WEIGHTS): Label | null {
  const there = o.engaged || o.seenLive || o.suppressed;
  const answer = o.answered && o.nextOwn !== null && o.nextOwn <= LATE ? o.nextOwn : null;
  if (answer !== null || o.reacted) {
    if (!w.answered) return null;
    return { y: { important: 1 }, weight: w.answered, why: [answer !== null ? 'answered' : 'reacted'], knownAt: o.ts + (answer ?? LATE) };
  }
  if (there) return null;
  const tapped = o.tapped !== null && (o.tapDwell ?? o.openDwell ?? OPEN_DWELL) >= OPEN_DWELL;
  const opened = o.opened !== null && o.opened <= IGNORED_AFTER && (o.openDwell ?? OPEN_DWELL) >= OPEN_DWELL;
  if (tapped || opened) {
    if (!w.opened) return null;
    return { y: { important: 1 }, weight: w.opened, why: [tapped ? 'tapped' : 'opened'], knownAt: o.ts + (tapped ? o.tapped! : o.opened!) };
  }
  if (o.observed < IGNORED_AFTER) return null;
  // Only a list row swiped away says "not this": swiping a Conversation row away says you saw it.
  if (o.dismissed && o.decision === 'digest' && w.dismissed) return { y: { important: 0 }, weight: w.dismissed, why: ['dismissed'], knownAt: o.ts + IGNORED_AFTER };
  if (o.burstFirst && !o.addressed && o.nextOwn === null && o.opened === null && w.nothing) return { y: { important: 0 }, weight: w.nothing, why: ['nothing happened'], knownAt: o.ts + IGNORED_AFTER };
  return null;
}

export interface GatherOptions {
  /** Only these messages get an outcome (default: every triaged message from someone else in the span). */
  only?: Set<string>;
  /** The time the data ends: `observed` is measured to it. */
  now?: number;
}

/**
 * The outcome of every triaged message from someone else with `from <= ts < to`, in one pass per conversation.
 * Reads messages from half an hour before to a day after, your reactions, the notifications sent, and the visits.
 */
export function gatherOutcomes(db: Database, from: number, to: number, opts: GatherOptions = {}): Map<string, Outcome> {
  const now = opts.now ?? Date.now();
  const out = new Map<string, Outcome>();
  const self = new Set((db.query(`SELECT * FROM ${SELF_SQL}`).all() as Row[]).map((r) => Object.values(r)[0] as string));
  const reacted = new Set(
    (db.query(`SELECT DISTINCT r.message_id FROM reaction r JOIN message m ON m.id = r.message_id WHERE m.ts >= ? AND m.ts < ? AND r.identity_id IN ${SELF_SQL}`).all(from, to) as Row[]).map((r) => r.message_id as string),
  );
  const notes = new Map<string, Row>();
  for (const n of db.query(`SELECT * FROM notification WHERE kind = 'message' AND message_id IS NOT NULL AND sent_at >= ?`).all(from - HOUR) as Row[]) if (!notes.has(n.message_id)) notes.set(n.message_id, n);
  const visitById = new Map<string, Row>();
  const visitsByConv = new Map<string, Row[]>();
  const visitsByPerson = new Map<string, Row[]>();
  for (const v of db.query(`SELECT id, conversation_id, person_id, start_at, end_at, active FROM visit WHERE view IN ('conversation', 'person') AND end_at >= ? ORDER BY start_at`).all(from - DAY) as Row[]) {
    visitById.set(v.id, v);
    if (v.conversation_id) (visitsByConv.get(v.conversation_id) ?? visitsByConv.set(v.conversation_id, []).get(v.conversation_id)!).push(v);
    if (v.person_id) (visitsByPerson.get(v.person_id) ?? visitsByPerson.set(v.person_id, []).get(v.person_id)!).push(v);
  }
  const peers = new Map<string, string | null>();
  for (const r of db
    .query(
      `SELECT c.id, (SELECT i.person_id FROM participant pa JOIN identity i ON i.id = pa.identity_id LEFT JOIN person p ON p.id = i.person_id
                     WHERE pa.conversation_id = c.id AND i.person_id IS NOT NULL AND COALESCE(p.is_self, 0) = 0 AND i.id NOT IN ${SELF_SQL} LIMIT 1) AS peer
       FROM conversation c WHERE c.shape = 'direct'`,
    )
    .all() as Row[])
    peers.set(r.id, r.peer);

  // Decisions and the authors of replied-to messages are looked up in memory: joining them in costs three times as much.
  const decisions = new Map<string, string>();
  for (const t of db.query('SELECT message_id, decision FROM triage WHERE created_at >= ?').iterate(from - DAY) as Iterable<Row>) decisions.set(t.message_id, t.decision);
  const authorQuery = db.query('SELECT author_id FROM message WHERE id = ?');
  const rows = db
    .query(
      `SELECT m.id, m.conversation_id AS conv, m.ts, m.author_id, m.reply_to_id, m.mentions_self
       FROM message m WHERE m.ts >= ? AND m.ts < ? AND m.deleted = 0 ORDER BY m.conversation_id, m.ts`,
    )
    .iterate(from - BURST, to + DAY) as Iterable<Row>;

  let conv: string | null = null;
  let msgs: Row[] = [];
  const flush = () => {
    if (conv !== null && msgs.length) perConversation(conv, msgs);
    msgs = [];
  };
  for (const r of rows) {
    if (r.conv !== conv) {
      flush();
      conv = r.conv;
    }
    r.decision = decisions.get(r.id) ?? null;
    msgs.push(r);
  }
  flush();
  return out;

  function perConversation(cid: string, ms: Row[]) {
    const peer = peers.get(cid) ?? null;
    const visits = [...(visitsByConv.get(cid) ?? []), ...(peer ? (visitsByPerson.get(peer) ?? []) : [])].sort((a, b) => a.start_at - b.start_at);
    const mine = ms.map((m) => self.has(m.author_id));
    const ownTimes = ms.filter((_, i) => mine[i]).map((m) => m.ts as number);
    // Which message each of yours answers: the one it replies to, else the last from someone else before it.
    const answers = new Set<string>();
    let lastOther: Row | null = null;
    const byId = new Map(ms.map((m) => [m.id as string, m]));
    const replyAuthor = (m: Row): string | null => (m.reply_to_id ? (byId.get(m.reply_to_id)?.author_id ?? (authorQuery.get(m.reply_to_id) as Row | null)?.author_id ?? null) : null);
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!mine[i]) {
        lastOther = m;
        continue;
      }
      const target = m.reply_to_id && byId.has(m.reply_to_id) && !self.has(byId.get(m.reply_to_id)!.author_id) ? byId.get(m.reply_to_id)! : lastOther;
      if (target) answers.add(target.id);
      lastOther = null;
    }
    // Bursts of others' messages, with whether anyone was notified in each, for unprompted opens.
    let prevOther: number | null = null;
    let prevAny: number | null = null;
    let burst: Row[] = [];
    const bursts: Row[][] = [];
    const burstFirst = new Set<string>();
    const lullFirst = new Set<string>();
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!mine[i]) {
        if (prevOther === null || m.ts - prevOther > BURST) {
          if (burst.length) bursts.push(burst);
          burst = [];
          burstFirst.add(m.id);
        }
        if (prevAny === null || m.ts - prevAny > LULL) lullFirst.add(m.id);
        burst.push(m);
        prevOther = m.ts;
      }
      prevAny = m.ts;
    }
    if (burst.length) bursts.push(burst);
    const unprompted = new Set<string>();
    for (const b of bursts) {
      const first = b[0].ts as number;
      const last = b[b.length - 1].ts as number;
      if (visits.some((v) => v.start_at <= first && v.end_at >= first)) continue;
      const open = visits.find((v) => v.start_at >= first && v.start_at <= last + OPEN_WITHIN);
      if (!open) continue;
      const pushedBefore = b.some((m) => m.ts <= open.start_at && (m.decision === 'push' || m.decision === 'quiet' || notes.has(m.id)));
      if (!pushedBefore) unprompted.add(b[0].id);
    }
    let own = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (mine[i] || m.ts < from || m.ts >= to || !m.decision || m.decision === 'silent') continue;
      if (opts.only && !opts.only.has(m.id)) continue;
      while (own < ownTimes.length && ownTimes[own] <= m.ts) own++;
      const next = own < ownTimes.length ? ownTimes[own] - m.ts : null;
      const before = own > 0 ? ownTimes[own - 1] : null;
      const n = notes.get(m.id);
      const tapVisit = n?.visit_id ? visitById.get(n.visit_id) : undefined;
      const openVisit = visits.find((v) => v.start_at >= m.ts);
      out.set(m.id, {
        id: m.id,
        conv: cid,
        ts: m.ts,
        engaged: before !== null && m.ts - before <= ENGAGED_BEFORE,
        seenLive: visits.some((v) => v.start_at <= m.ts && v.end_at >= m.ts),
        nextOwn: next,
        answered: answers.has(m.id),
        reacted: reacted.has(m.id),
        decision: m.decision,
        notified: !!n,
        shown: n?.shown_at != null,
        suppressed: n?.suppressed_at != null,
        dismissed: n?.dismissed_at != null,
        tapped: n?.tapped_at != null ? n.tapped_at - m.ts : null,
        tapDwell: tapVisit?.active ?? null,
        opened: openVisit || n?.tapped_at != null ? Math.min(openVisit ? openVisit.start_at - m.ts : Infinity, n?.tapped_at != null ? n.tapped_at - m.ts : Infinity) : null,
        openDwell: openVisit?.active ?? null,
        burstFirst: burstFirst.has(m.id),
        lullFirst: lullFirst.has(m.id),
        unprompted: unprompted.has(m.id),
        addressed: !!m.mentions_self || self.has(replyAuthor(m) ?? ''),
        observed: Math.max(0, now - m.ts),
      });
    }
  }
}
