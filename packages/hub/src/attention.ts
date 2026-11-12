/**
 * The inbox's order: how much each conversation needs you, from its metadata only (docs/inbox.md).
 *
 * Two halves:
 *  - features: a fold over each conversation's messages in order (who wrote, when, who replied to whom, mentions,
 *    triage decisions), kept per conversation with a cursor. New messages are added as they arrive; an older one
 *    (backfill, imported history) makes the conversation fold again from the start, in batches, once it is quiet.
 *  - the score: those features plus unread state, mutes and time spent (usage.ts), at a given moment, with the
 *    reasons in words.
 *
 * Nothing here reads what was said. "Asks a question" comes from triage's stored decision, never from the text.
 */
import type * as P from '@dither-chat/protocol';
import { decayed, EXPLORE_REASON, USAGE_HALF_LIFE } from '@dither-chat/protocol';
import type { Store } from './store.ts';
import type { Triage } from './triage.ts';
import type { ActivityStore } from './activity.ts';
import { requestHeld } from './add.ts';
import { noteWork } from './stalls.ts';

type Row = Record<string, any>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Message rates and reply habits lose half their weight in a month: what you do now, with enough history to mean it. */
export const FEATURE_HALF_LIFE = 30 * DAY;
/** A reply later than this did not answer the message; it counts as unanswered. */
export const REPLY_WINDOW = 3 * DAY;
/** In a small group, the first message from someone else this soon after yours answers you. */
export const FOLLOW_UP = HOUR;
/** A group this size or smaller (you included) is talking to you. */
export const SMALL_GROUP = 6;
/** Reply latency histogram: bucket i counts replies within LATENCY_EDGES[i] and after the edge before it. */
export const LATENCY_EDGES = [5 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR, DAY, 2 * DAY, REPLY_WINDOW];
/** Bumped when the fold changes meaning: every conversation folds again, in the background. */
export const FEATURE_VERSION = 3;
/** A conversation that got older messages folds again once none have arrived for this long. */
const QUIET = 5_000;
/** Scores move with time (an unanswered message ages, recency fades): all are recomputed this often. */
export const RESCORE_EVERY = 5 * MIN;

// ------------------------------------------------------------------ features

/** Turns addressed to you, how many you answered in time, and how fast. Decayed sums as of `at`. */
export interface Tally {
  at: number;
  addressed: number;
  replied: number;
  latency: number[];
}
export const emptyTally = (): Tally => ({ at: 0, addressed: 0, replied: 0, latency: LATENCY_EDGES.map(() => 0) });

export type OwedKind = 'direct' | 'mention' | 'reply' | 'question' | 'answer';

/** Messages from others since your last one; `addressed` is the first of them meant for you. */
export interface Turn {
  since: number;
  count: number;
  addressed: number | null;
  kind: OwedKind | null;
  author: string | null;
  authorKey: string | null;
}

export interface ConvState {
  /** The decayed sums below are as of this time. */
  at: number;
  /** Messages from others, from you, and those triage put in a tier (an alert, a Conversation, the list): decayed. */
  received: number;
  sent: number;
  pushed: number;
  tally: Tally;
  totalReceived: number;
  totalSent: number;
  lastReceived: number | null;
  lastSent: number | null;
  /** The last message was yours. */
  lastWasMine: boolean;
  turn: Turn | null;
  /** The latest message triage put in a tier. */
  lastPush: { ts: number; id: string } | null;
}

export const freshState = (): ConvState => ({
  at: 0,
  received: 0,
  sent: 0,
  pushed: 0,
  tally: emptyTally(),
  totalReceived: 0,
  totalSent: 0,
  lastReceived: null,
  lastSent: null,
  lastWasMine: false,
  turn: null,
  lastPush: null,
});

/** One message as the fold sees it: no text. */
export interface FoldMessage {
  id: string;
  ts: number;
  author: string | null;
  /** The author's person, else the identity. */
  authorKey: string | null;
  mine: boolean;
  bot: boolean;
  mentionsMe: boolean;
  repliesToMe: boolean;
  /** Triage's reasons say it asks a question. */
  question: boolean;
  pushed: boolean;
  /** Deleted, or a system line: moves the cursor, counts for nothing. */
  ignore: boolean;
  /** You reacted to it: an answer, as far as what you owe goes. */
  reactedByMe?: boolean;
}

export interface Place {
  shape: P.Shape;
  /** Listed members, you included; 0 when the network does not list them (big channels). */
  members: number;
}

const toward = (from: number, to: number) => 2 ** (-(to - from) / FEATURE_HALF_LIFE);

/** Bring the state's sums to `when` if that is later; returns the weight of something that happened at `when`. */
function advance(s: ConvState, when: number): number {
  if (when < s.at) return toward(when, s.at);
  const f = toward(s.at, when);
  s.received *= f;
  s.sent *= f;
  s.pushed *= f;
  s.at = when;
  return 1;
}

const bucketOf = (latency: number) => {
  const i = LATENCY_EDGES.findIndex((e) => latency <= e);
  return i < 0 ? LATENCY_EDGES.length - 1 : i;
};

/**
 * Count one addressed turn, answered after `latency` or (null) not at all. Order-independent, like usage.ts. An
 * answer of unknown speed (a reaction, which carries no time) counts as answered but not in the latency histogram.
 */
export function record(t: Tally, when: number, latency: number | null, timed = true) {
  let w = 1;
  if (when >= t.at) {
    const f = toward(t.at, when);
    t.addressed *= f;
    t.replied *= f;
    t.latency = t.latency.map((x) => x * f);
    t.at = when;
  } else w = toward(when, t.at);
  t.addressed += w;
  if (latency !== null && latency <= REPLY_WINDOW) {
    t.replied += w;
    if (timed) t.latency[bucketOf(Math.max(0, latency))] += w;
  }
}

/** Whether a message from someone else is meant for you, and how. */
function addressedKind(m: FoldMessage, place: Place, s: ConvState): OwedKind | null {
  if (m.mine || m.bot || place.shape === 'self') return null;
  if (place.shape === 'direct') return 'direct';
  if (m.mentionsMe) return 'mention';
  if (m.repliesToMe) return 'reply';
  const small = place.shape === 'group' && place.members > 0 && place.members <= SMALL_GROUP;
  if (small && m.question) return 'question';
  if (small && s.lastWasMine && s.lastSent !== null && m.ts - s.lastSent <= FOLLOW_UP) return 'answer';
  return null;
}

/** The open turn is over: answered at `answeredAt`, or (null) it ran out. `timed`: whether that is when you answered. */
function settle(s: ConvState, tallyOf: (key: string) => Tally, answeredAt: number | null, timed = true) {
  const t = s.turn;
  if (!t || t.addressed === null) return;
  const latency = answeredAt === null ? null : answeredAt - t.addressed;
  const when = answeredAt ?? t.addressed + REPLY_WINDOW;
  record(s.tally, when, latency, timed);
  if (t.authorKey) record(tallyOf(t.authorKey), when, latency, timed);
}

/** Add one message, in (ts, rowid) order. `tallyOf` gives this conversation's tally for an author, to update. */
export function foldMessage(s: ConvState, tallyOf: (key: string) => Tally, m: FoldMessage, place: Place) {
  if (m.ignore) return;
  if (m.mine) {
    s.sent += advance(s, m.ts);
    s.totalSent++;
    s.lastSent = Math.max(s.lastSent ?? 0, m.ts);
    settle(s, tallyOf, m.ts);
    s.turn = null;
    s.lastWasMine = true;
    return;
  }
  const w = advance(s, m.ts);
  s.received += w;
  s.totalReceived++;
  s.lastReceived = Math.max(s.lastReceived ?? 0, m.ts);
  if (m.pushed) {
    s.pushed += w;
    if (!s.lastPush || m.ts >= s.lastPush.ts) s.lastPush = { ts: m.ts, id: m.id };
  }
  const kind = addressedKind(m, place, s);
  s.lastWasMine = false;
  s.turn ??= { since: m.ts, count: 0, addressed: null, kind: null, author: null, authorKey: null };
  s.turn.count++;
  if (!kind) return acknowledge(s, tallyOf, m);
  // Unanswered for so long it ran out: that turn is over, and this one starts the clock again.
  if (s.turn.addressed !== null && m.ts - s.turn.addressed > REPLY_WINDOW) {
    settle(s, tallyOf, null);
    s.turn = { since: m.ts, count: 1, addressed: null, kind: null, author: null, authorKey: null };
  }
  if (s.turn.addressed === null) Object.assign(s.turn, { addressed: m.ts, kind, author: m.author, authorKey: m.authorKey });
  acknowledge(s, tallyOf, m);
}

/**
 * A reaction of yours to a message from someone else answers what was owed up to it: a 👍 is often the whole reply.
 * It counts where the message is, since reactions carry no time, so what they wrote after it is owed afresh. It
 * counts toward how often you answer, not how fast.
 */
function acknowledge(s: ConvState, tallyOf: (key: string) => Tally, m: FoldMessage) {
  if (!m.reactedByMe || s.turn?.addressed == null) return;
  settle(s, tallyOf, m.ts, false);
  s.turn = null;
}

/** Triage decided after the message was folded: a push counts, and a question in a small group opens what you owe. */
export function lateTriage(s: ConvState, place: Place, m: Pick<FoldMessage, 'id' | 'ts' | 'author' | 'authorKey'>, d: { pushed: boolean; question: boolean }): boolean {
  let changed = false;
  if (d.pushed) {
    s.pushed += m.ts >= s.at ? 1 : toward(m.ts, s.at);
    if (!s.lastPush || m.ts >= s.lastPush.ts) s.lastPush = { ts: m.ts, id: m.id };
    changed = true;
  }
  const small = place.shape === 'group' && place.members > 0 && place.members <= SMALL_GROUP;
  const t = s.turn;
  if (d.question && small && t && t.addressed === null && m.ts >= t.since) {
    Object.assign(t, { addressed: m.ts, kind: 'question', author: m.author, authorKey: m.authorKey });
    changed = true;
  }
  return changed;
}

// ------------------------------------------------------------------ reading features at a moment

/** A tally as seen from `now`. */
export function tallyAt(t: Tally, now: number): Tally {
  const f = toward(t.at, Math.max(now, t.at));
  return { at: Math.max(now, t.at), addressed: t.addressed * f, replied: t.replied * f, latency: t.latency.map((x) => x * f) };
}

export function sumTallies(ts: Tally[], now: number): Tally {
  const out = emptyTally();
  out.at = now;
  for (const t of ts.map((x) => tallyAt(x, now))) {
    out.addressed += t.addressed;
    out.replied += t.replied;
    t.latency.forEach((x, i) => (out.latency[i] += x));
  }
  return out;
}

/** Answered over addressed, pulled toward `prior` while there are few: `weight` turns' worth of it. */
export function replyRate(t: Pick<Tally, 'addressed' | 'replied'> | null, prior: number, weight = 2): number {
  return ((t?.replied ?? 0) + prior * weight) / ((t?.addressed ?? 0) + weight);
}

/** The time within which you answer half the time; null with fewer than about two answers to go on. */
export function medianLatency(t: Tally | null): number | null {
  if (!t) return null;
  const total = t.latency.reduce((a, b) => a + b, 0);
  if (total < 1.5) return null;
  let acc = 0;
  for (let i = 0; i < t.latency.length; i++) if ((acc += t.latency[i]) >= total / 2) return LATENCY_EDGES[i];
  return REPLY_WINDOW;
}

/**
 * How much an unanswered message weighs as it ages: all of it from the moment it arrives, through the first day,
 * then half every two days. It used to rise over the time you usually take to answer, so a message just read
 * weighed almost nothing and sank below chats you had finished with (docs/inbox.md).
 */
export function owedCurve(age: number): number {
  if (age < 0) return 0;
  return age <= DAY ? 1 : 2 ** (-(age - DAY) / (2 * DAY));
}

/** A decayed sum with half-life `h`, as a steady rate per day. */
const perDay = (sum: number, h: number) => (sum * Math.LN2) / (h / DAY);

// ------------------------------------------------------------------ the score

export const WEIGHTS = {
  /** An unanswered message at its peak, times how often you answer. */
  owed: 60,
  /** Per unread DM message or mention, up to `unreadCap` of them. */
  unreadAddressed: 12,
  /** Per other unread message, up to `unreadCap`. */
  unreadOther: 3,
  unreadCap: 3,
  /** Anything unread at all. */
  unreadAny: 8,
  /** An alert or a Conversation message you have not read (or swiped away). */
  pinged: 15,
  /** An alert you have not seen, on top: with `ALERT_PIN` it sorts before everything else. */
  alerted: 40,
  /** The importance, 0 to 1, of the newest unread message triage put in a tier, times this. */
  importance: 25,
  /** A conversation going on now (you wrote, they wrote around then), halving each `liveHalfLife` after your last message. */
  live: 30,
  liveHalfLife: 30 * MIN,
  /** Their message and yours this close together make it a conversation rather than a one-off. */
  liveGap: HOUR,
  /** Relationship strength 0..1 times this. */
  relationship: 25,
  /** Noise fit -1..1: drowning sinks this much, quiet-but-engaged rises `quiet`. */
  noise: 20,
  quiet: 8,
  /** The latest message, halving each `recencyHalfLife`: the tiebreaker. */
  recency: 10,
  recencyHalfLife: DAY,
  /** You were here, halving each `visitedHalfLife` since you left: the chat you were just in stays near the top. */
  visited: 30,
  visitedHalfLife: 2 * HOUR,
  /** At or above this (without `visited`), a conversation needs you. */
  needs: 20,
  /** Muted places sit here, ordered among themselves by recency. */
  mutedFloor: -50,
  /** A local model's importance 0..1 times this (follow-up; nothing provides it yet). */
  judged: 10,
};

export interface ScoreInput {
  now: number;
  shape: P.Shape;
  members: number;
  lastMessageAt: number | null;
  state: ConvState;
  /** Your answers to whoever you owe, over all your conversations with them. */
  author: Tally | null;
  /** Their name, for the reasons. */
  authorName: string | null;
  unread: number;
  mentions: number;
  /** The first reason of an unread alert or Conversation message, until you swipe its notification away. */
  pinged: string | null;
  /** That message is an alert. */
  alerted?: boolean;
  /** The importance, 0 to 1, of the newest unread message triage put in a tier (triage's `score`), until you swipe it away. */
  importance?: number | null;
  /** Where the mute comes from, when the place is muted or kept to the list. */
  muted: string | null;
  /** usage.ts: decayed seconds and visits (half-life a week) as of `at` (the last time you were there), and the last visit. */
  usage: { score: number; visitScore: number; at: number; lastVisit: number | null } | null;
  /** Follow-up seam: a local model's answer for this conversation (AttentionJudge). */
  judged?: Judged | null;
  /**
   * Where triage put the newest unread message it decided on (your vote, else its decision), and your votes on this
   * conversation's messages lately, up a level and down (decayed, VOTE_HALF_LIFE). The replay fills them in to try
   * them as features of the learned order (rank.ts TRIAGE_FEATURES); the hub does not yet.
   */
  level?: P.TriageDecision | null;
  votes?: { up: number; down: number } | null;
}

/** Added to the score of a conversation with an alert you have not seen: above any score the formula or the model gives. */
export const ALERT_PIN = 1000;
/** An alert is pinned this long at most: what could not wait an hour is, a day later, an unread message like any other. */
export const PIN_FOR = DAY;

/** A vote on a message counts half after two weeks, as far as the learned order goes. */
export const VOTE_HALF_LIFE = 14 * DAY;
const LEVEL_ORDER: Record<P.TriageDecision, number> = { silent: -1, drop: 0, digest: 1, quiet: 2, push: 3 };
/** A vote's direction: 1 up a level or more, −1 down, 0 "it was right". */
export const voteDirection = (decision: P.TriageDecision, feedback: P.TriageDecision): number => Math.sign(LEVEL_ORDER[feedback] - LEVEL_ORDER[decision]);

/** Votes as of `now`: up and down, each decayed by VOTE_HALF_LIFE; votes after `now` do not count yet. */
export function votesAt(votes: readonly { at: number; dir: number }[] | undefined, now: number): { up: number; down: number } | null {
  if (!votes?.length) return null;
  let up = 0;
  let down = 0;
  for (const v of votes) {
    if (v.at > now) continue;
    const w = 2 ** (-(now - v.at) / VOTE_HALF_LIFE);
    if (v.dir > 0) up += w;
    else if (v.dir < 0) down += w;
  }
  return up || down ? { up, down } : null;
}

export interface Judged {
  /** 0..1: does the latest message need a reply from you. */
  needsReply: number;
  /** 0..1. */
  importance: number;
  reason: string;
}

/** Per-place volume against your engagement. Kept so triage can use it later (docs/inbox.md). */
export interface Noise {
  receivedPerDay: number;
  pushedPerDay: number;
  /** Your messages and visits per day. */
  engagedPerDay: number;
  /** -1: busy and you never take part .. 1: quiet and you always do. */
  fit: number;
}

export interface Scored {
  score: number;
  needs: boolean;
  reasons: string[];
  /** Each term's points. */
  parts: Record<string, number>;
  noise: Noise;
  relationship: number;
  owedSince: number | null;
}

export function noiseOf(s: ConvState, usage: ScoreInput['usage'], now: number): Noise {
  const receivedPerDay = perDay(decayed(s.received, s.at, now, FEATURE_HALF_LIFE), FEATURE_HALF_LIFE);
  const pushedPerDay = perDay(decayed(s.pushed, s.at, now, FEATURE_HALF_LIFE), FEATURE_HALF_LIFE);
  const sentPerDay = perDay(decayed(s.sent, s.at, now, FEATURE_HALF_LIFE), FEATURE_HALF_LIFE);
  const visitsPerDay = usage ? perDay(decayed(usage.visitScore, usage.at, now), USAGE_HALF_LIFE) : 0;
  const engagedPerDay = sentPerDay + visitsPerDay;
  const fit = Math.max(-1, Math.min(1, Math.log2((1 + 4 * engagedPerDay) / (1 + receivedPerDay + pushedPerDay)) / 5));
  return { receivedPerDay, pushedPerDay, engagedPerDay, fit };
}

/** 0..1, and which part says the most. */
export function relationshipOf(s: ConvState, usage: ScoreInput['usage'], now: number): { strength: number; top: string; parts: Record<string, number> } {
  const sent = decayed(s.sent, s.at, now, FEATURE_HALF_LIFE);
  const received = decayed(s.received, s.at, now, FEATURE_HALF_LIFE);
  const tally = tallyAt(s.tally, now);
  const median = medianLatency(tally);
  const minutes = usage ? decayed(usage.score, usage.at, now) / 60 : 0;
  const parts = {
    talk: 0.25 * (1 - Math.exp(-(perDay(sent, FEATURE_HALF_LIFE) * 7) / 5)),
    reply: 0.15 * replyRate(tally, 0, 1),
    speed: 0.1 * (median === null ? 0 : 1 / (1 + median / (2 * HOUR))),
    mutual: 0.15 * (sent > 0 && received > 0 ? Math.min(sent, received) / Math.max(sent, received) : 0),
    recent: 0.15 * (s.lastSent ? 2 ** (-Math.max(0, now - s.lastSent) / (14 * DAY)) : 0),
    time: 0.2 * (1 - Math.exp(-minutes / 60)),
  };
  const top = Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0];
  return { strength: Object.values(parts).reduce((a, b) => a + b, 0), top, parts };
}

/** When you were last here: the end of your latest stay. Null for a place you never stayed in long enough to count a visit. */
export function lastThere(usage: ScoreInput['usage']): number | null {
  return usage?.lastVisit ? Math.max(usage.lastVisit, usage.at) : null;
}

/** "a minute", "5 minutes", "an hour", "3 days", "2 weeks". */
export function duration(ms: number): string {
  const n = (x: number, one: string, many: string) => (Math.round(x) <= 1 ? one : `${Math.round(x)} ${many}`);
  if (ms < 45_000) return 'a moment';
  if (ms < 50 * MIN) return n(ms / MIN, 'a minute', 'minutes');
  if (ms < 22 * HOUR) return n(ms / HOUR, 'an hour', 'hours');
  if (ms < 13 * DAY) return n(ms / DAY, 'a day', 'days');
  return n(ms / (7 * DAY), 'a week', 'weeks');
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const round = (x: number) => Math.round(x * 10) / 10;

/** The whole formula; docs/inbox.md explains it term by term. Pure: same input, same answer. */
export function scoreConversation(x: ScoreInput): Scored {
  const W = WEIGHTS;
  const { now, state: s } = x;
  const reasons: { w: number; text: string }[] = [];
  const parts: Record<string, number> = {};
  const age = x.lastMessageAt ? Math.max(0, now - x.lastMessageAt) : Infinity;
  parts.recency = W.recency * 2 ** (-age / W.recencyHalfLife);
  const noise = noiseOf(s, x.usage, now);
  const rel = relationshipOf(s, x.usage, now);
  const turn = s.turn?.addressed != null && x.shape !== 'self' ? s.turn : null;

  if (x.muted) {
    const score = W.mutedFloor + parts.recency;
    const why = [`Muted: ${x.muted}`];
    if (x.unread) why.push(`${plural(x.unread, 'unread message')}`);
    return { score: round(score), needs: false, reasons: why, parts, noise, relationship: rel.strength, owedSince: turn?.addressed ?? null };
  }

  // Owed reply: weighted by how often you answer this person (everywhere), then this conversation.
  if (turn) {
    const owedAge = now - turn.addressed!;
    const person = x.author ? tallyAt(x.author, now) : null;
    const conv = tallyAt(s.tally, now);
    let p = replyRate(conv, replyRate(person, 0.5));
    if (x.judged) p = (p + x.judged.needsReply) / 2;
    const personUsual = medianLatency(person);
    const usual = personUsual ?? medianLatency(conv);
    parts.owed = W.owed * p * owedCurve(owedAge);
    const who = x.authorName ?? (x.shape === 'direct' ? 'They' : 'Someone');
    const since = duration(owedAge);
    let text: string;
    if (personUsual !== null) text = `You usually reply to ${who} within ${duration(personUsual)}; unanswered for ${since}`;
    else if (usual !== null) text = `You usually reply here within ${duration(usual)}; unanswered for ${since}`;
    else if ((person?.addressed ?? 0) >= 3) text = `You reply to ${who} ${p >= 0.7 ? 'most of the time' : p >= 0.35 ? 'about half the time' : 'rarely'}; unanswered for ${since}`;
    else {
      const did = { direct: 'wrote to you', mention: 'mentioned you', reply: 'replied to you', question: 'asked the group something', answer: 'answered you' }[turn.kind ?? 'direct'];
      text = `${who} ${did} ${since} ago; not answered yet`;
    }
    reasons.push({ w: parts.owed, text });
  }

  // Unread: what is addressed to you counts most.
  if (x.unread > 0) {
    const addressed = x.shape === 'direct' ? x.unread : Math.min(x.mentions, x.unread);
    const other = x.unread - addressed;
    parts.unread = W.unreadAny + W.unreadAddressed * Math.min(addressed, W.unreadCap) + W.unreadOther * Math.min(other, W.unreadCap);
    const text =
      x.shape === 'direct' ? plural(x.unread, 'unread message') : x.mentions ? `${plural(x.mentions, 'unread mention')}${other ? `, ${other} more unread` : ''}` : plural(x.unread, 'unread message');
    reasons.push({ w: parts.unread, text });
  }
  if (x.pinged) {
    parts.pinged = W.pinged + (x.alerted ? W.alerted : 0);
    const why = x.pinged.length > 70 ? x.pinged.slice(0, 69) + '…' : x.pinged;
    reasons.push({ w: parts.pinged, text: x.alerted ? `Alerted you: ${why}` : why });
  }
  if (x.importance) {
    parts.importance = W.importance * x.importance;
    if (!x.pinged) reasons.push({ w: parts.importance, text: `On your list: importance ${Math.round(x.importance * 100)}%` });
  }

  // A conversation going on right now keeps its place above the line while the back-and-forth lasts, so the chat you
  // just answered is easy to find again, and lets go as it fades.
  if (x.shape !== 'self' && s.lastSent && s.lastReceived && Math.abs(s.lastReceived - s.lastSent) <= W.liveGap) {
    const since = Math.max(0, now - s.lastSent);
    parts.live = W.live * 2 ** (-since / W.liveHalfLife);
    reasons.push({ w: parts.live, text: `You're in a conversation here: you wrote ${duration(since)} ago` });
  }

  // Something to read, something to answer and a conversation going on are one need, not three: the largest counts.
  // So reading a message you will answer leaves it where it was, and reading one you would not answer lets it go.
  const toRead = (parts.unread ?? 0) + (parts.pinged ?? 0);
  const need = [parts.owed ?? 0, toRead, parts.live ?? 0];
  const sum = need.reduce((a, b) => a + b, 0);
  if (sum > Math.max(...need)) parts.overlap = Math.max(...need) - sum;

  parts.relationship = W.relationship * rel.strength;
  // "You wrote here a moment ago" says nothing a conversation going on has not.
  if (rel.strength >= 0.3 && !(parts.live && rel.top === 'recent')) {
    const sentPerWeek = perDay(decayed(s.sent, s.at, now, FEATURE_HALF_LIFE), FEATURE_HALF_LIFE) * 7;
    const minutes = x.usage ? decayed(x.usage.score, x.usage.at, now) / 60 : 0;
    const with_ = x.shape === 'direct' && x.authorName ? ` with ${x.authorName}` : ' here';
    const text = {
      talk: `You talk${with_} often: about ${plural(Math.max(1, Math.round(sentPerWeek)), 'message')} a week`,
      time: `You spend time here: ${duration(minutes * MIN)} lately`,
      recent: `You wrote here ${duration(now - (s.lastSent ?? now))} ago`,
      reply: `You answer${with_} ${Math.round(replyRate(tallyAt(s.tally, now), 0, 1) * 100)}% of the time`,
      speed: `You answer${with_} quickly`,
      mutual: `It goes both ways${with_}`,
    }[rel.top]!;
    reasons.push({ w: parts.relationship, text });
  }

  parts.noise = noise.fit < 0 ? W.noise * noise.fit : W.quiet * noise.fit;
  if (noise.fit <= -0.3) reasons.push({ w: parts.noise, text: `Busy (about ${Math.round(noise.receivedPerDay)} messages a day) and you rarely take part` });
  else if (noise.fit >= 0.3 && noise.receivedPerDay < 5) reasons.push({ w: parts.noise, text: 'Quiet, and you take part when it speaks' });

  if (x.judged) {
    parts.judged = W.judged * x.judged.importance;
    reasons.push({ w: parts.judged, text: `Model: ${x.judged.reason}` });
  }

  // You were just here: the chat you left is still near the top when you go back to it. It moves the row, not
  // whether the row needs you.
  const there = lastThere(x.usage);
  if (there !== null) {
    parts.visited = W.visited * 2 ** (-Math.max(0, now - there) / W.visitedHalfLife);
    reasons.push({ w: parts.visited, text: `You were here ${duration(Math.max(0, now - there))} ago` });
  }

  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  const shown = reasons.filter((r) => Math.abs(r.w) >= 2).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  if (!shown.length && x.lastMessageAt) shown.push({ w: parts.recency, text: `Last message ${duration(age)} ago` });
  return {
    score: round(score),
    needs: score - (parts.visited ?? 0) >= W.needs,
    reasons: shown.slice(0, 4).map((r) => r.text),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v)])),
    noise,
    relationship: rel.strength,
    owedSince: turn?.addressed ?? null,
  };
}

// ------------------------------------------------------------------ the follow-up seam

/**
 * A model's say in the order (docs/inbox.md). Two ways in:
 *  - `judge`: a local model asked "does this need a reply from me?" and "how important is it?" for a few candidate
 *    conversations. Nothing implements it yet; `Attention.judged` is where answers
 *    would go, and `scoreConversation` already uses them.
 *  - `rank`: a learned order (ranker.ts), asked as each conversation is scored, with the formula's answer. Its score
 *    is what the inbox sorts by; `needs` and the reasons stay the formula's. Null keeps the formula's score.
 */
export interface AttentionJudge {
  judge?(items: { conversationId: string; messageIds: string[] }[]): Promise<Map<string, Judged>>;
  rank?(conversationId: string, x: ScoreInput, formula: Scored): { score: number; reason?: string } | null;
  /** What it says about one conversation, for `explain`. */
  explain?(conversationId: string): unknown;
  forget?(conversationId: string): void;
}

/**
 * Rows of another kind in the same inbox (mail/attention.ts): scored by their own code with `scoreConversation`, and
 * listed, sent and kept with the conversations' views, in the same `attention` events.
 */
export interface AttentionSource {
  /** Score everything (`all`), or what changed since it last did: the views that changed, and ids no longer listed. */
  rescore(now: number, all: boolean): { items: P.AttentionView[]; removed: string[] };
  view(id: string): P.AttentionView | undefined;
  list(): P.AttentionView[];
  explain?(id: string, now: number): unknown;
  /** Whether it has changes waiting for the next rescore. */
  readonly busy?: boolean;
}

// ------------------------------------------------------------------ kept in the database

const FOLD_SQL = `
  SELECT m.id, m.rowid AS rid, m.ts, m.author_id, m.mentions_self, m.mentions_all, m.kind, m.deleted, i.is_bot, i.person_id,
         r.author_id AS reply_author,
         EXISTS (SELECT 1 FROM reaction x JOIN identity xi ON xi.id = x.identity_id LEFT JOIN person xp ON xp.id = xi.person_id
                 WHERE x.message_id = m.id AND (xp.is_self = 1 OR xi.id IN (SELECT self_identity FROM account))) AS reacted, t.decision IN ('push', 'quiet', 'digest') AS pushed, t.reasons LIKE '%asks a question%' AS question
  FROM message m
  LEFT JOIN identity i ON i.id = m.author_id
  LEFT JOIN message r ON r.id = m.reply_to_id
  LEFT JOIN triage t ON t.message_id = m.id
  WHERE m.conversation_id = ? AND (m.ts > ? OR (m.ts = ? AND m.rowid > ?))
  ORDER BY m.ts, m.rowid LIMIT ?`;

const LISTED = `(c.shape IN ('direct', 'group', 'self') OR (c.shape = 'channel' AND NOT EXISTS (
  SELECT 1 FROM space_edge e WHERE e.child_kind = 'conversation' AND e.child_id = c.id)))`;

const sameView = (a: P.AttentionView, b: P.AttentionView) =>
  Math.abs(a.score - b.score) < 0.5 && a.needs === b.needs && a.owedSince === b.owedSince && a.reasons.join('\n') === b.reasons.join('\n');

export class Attention {
  /** What the inbox lists, as last computed. */
  private views = new Map<string, P.AttentionView>();
  /** Conversations to fold and score at the next sync. */
  private pending = new Set<string>();
  private scored = false;
  private selfPerson: string | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  /** Answers from an AttentionJudge, by conversation (follow-up). */
  readonly judged = new Map<string, Judged>();
  /** A model's say in the order: the learned one (ranker.ts). */
  judge?: AttentionJudge;
  /** The activity log's per-place features (docs/activity.md): shown by `explain`, not scored yet. */
  activity?: Pick<ActivityStore, 'features'>;
  /** Other rows of the inbox: mail threads (mail/attention.ts). */
  readonly sources: AttentionSource[] = [];
  /** How you answer an author elsewhere (their mail, mail/attention.ts), summed with their chat tallies. */
  otherTallies?: (authorKey: string) => Tally[];
  /** The clock the pump's and a sync's time budgets are kept by, in ms (a test's stands in for it). */
  budgetClock: () => number = () => performance.now();

  constructor(
    private store: Store,
    private triage: Triage,
    private now: () => number = Date.now,
  ) {
    const db = store.db;
    const v = db.query(`SELECT value FROM meta WHERE key = 'attention_version'`).get() as Row | null;
    if (v?.value !== String(FEATURE_VERSION)) {
      // Rows from another version mean something else: drop them, and the pump folds everything again.
      db.exec('DELETE FROM conv_feature; DELETE FROM conv_author_feature;');
      db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('attention_version', ?)`).run(String(FEATURE_VERSION));
    }
  }

  // ---------------------------------------------------------------- folding

  private refreshSelf() {
    this.selfPerson = (this.store.db.query('SELECT id FROM person WHERE is_self = 1').get() as Row | null)?.id ?? null;
  }
  private mine(identityId: string | null, personId?: string | null) {
    return this.store.isSelf(identityId) || (!!personId && personId === this.selfPerson);
  }

  private place(cid: string): Place | null {
    const c = this.store.db.query('SELECT shape FROM conversation WHERE id = ?').get(cid) as Row | null;
    if (!c) return null;
    const members = (this.store.db.query('SELECT COUNT(*) AS n FROM participant WHERE conversation_id = ?').get(cid) as Row).n;
    return { shape: c.shape, members };
  }

  /** Fold up to `limit` more messages of one conversation. Returns how many it folded; fewer than `limit` means it is up to date. */
  fold(cid: string, limit = 1000): number {
    const db = this.store.db;
    const place = this.place(cid);
    if (!place) {
      this.forget(cid);
      return 0;
    }
    const row = db.query('SELECT * FROM conv_feature WHERE conversation_id = ?').get(cid) as Row | null;
    const rows = db.query(FOLD_SQL).all(cid, row?.cursor_ts ?? -1, row?.cursor_ts ?? -1, row?.cursor_rid ?? 0, limit) as Row[];
    if (!rows.length) {
      if (!row) db.query('INSERT INTO conv_feature (conversation_id, state) VALUES (?, ?)').run(cid, JSON.stringify(freshState()));
      return 0;
    }
    const s: ConvState = row ? JSON.parse(row.state) : freshState();
    const authors = new Map<string, Tally>();
    const tallyOf = (key: string) => {
      let t = authors.get(key);
      if (!t) {
        const r = db.query('SELECT tally FROM conv_author_feature WHERE conversation_id = ? AND author_key = ?').get(cid, key) as Row | null;
        authors.set(key, (t = r ? JSON.parse(r.tally) : emptyTally()));
      }
      return t!;
    };
    for (const r of rows) {
      foldMessage(
        s,
        tallyOf,
        {
          id: r.id,
          ts: r.ts,
          author: r.author_id,
          authorKey: r.person_id ?? r.author_id,
          mine: this.mine(r.author_id, r.person_id),
          bot: !!r.is_bot,
          // @everyone is not addressed to you: it notifies, but owes no answer.
          mentionsMe: !!r.mentions_self && !r.mentions_all,
          repliesToMe: this.mine(r.reply_author),
          question: !!r.question,
          pushed: !!r.pushed,
          ignore: !!r.deleted || r.kind === 'system',
          reactedByMe: !!r.reacted,
        },
        place,
      );
    }
    const last = rows[rows.length - 1];
    db.transaction(() => {
      db.query(
        `INSERT INTO conv_feature (conversation_id, cursor_ts, cursor_rid, state) VALUES (?, ?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET cursor_ts = excluded.cursor_ts, cursor_rid = excluded.cursor_rid, state = excluded.state`,
      ).run(cid, last.ts, last.rid, JSON.stringify(s));
      for (const [key, t] of authors) db.query('INSERT OR REPLACE INTO conv_author_feature (conversation_id, author_key, tally) VALUES (?, ?, ?)').run(cid, key, JSON.stringify(t));
    })();
    return rows.length;
  }

  /** Start a conversation's features over; the pump folds it again. */
  private reset(cid: string) {
    this.store.db.query('DELETE FROM conv_author_feature WHERE conversation_id = ?').run(cid);
    this.store.db.query('DELETE FROM conv_feature WHERE conversation_id = ?').run(cid);
  }
  private forget(cid: string) {
    this.reset(cid);
    this.judged.delete(cid);
    this.judge?.forget?.(cid);
  }

  /**
   * Fold again from the start: these conversations, or all of them. For history imported by other means than
   * the ingest (which notices older messages by itself), and for anything that changed what was already folded.
   */
  invalidate(ids?: string[]) {
    const now = this.now();
    if (!ids) this.store.db.query('UPDATE conv_feature SET stale_at = ?').run(now);
    else for (const id of ids) this.store.db.query('UPDATE conv_feature SET stale_at = ? WHERE conversation_id = ?').run(now, id);
  }

  /** Messages the store took in since last time: appends fold now, anything older than a cursor means starting over. */
  private noteIngested() {
    // Your reactions answer what you owed where they are, so those conversations fold again from the start.
    if (this.store.selfReacted.size) {
      this.invalidate([...this.store.selfReacted]);
      for (const cid of this.store.selfReacted) this.pending.add(cid);
      this.store.selfReacted.clear();
    }
    const ing = this.store.ingested;
    if (!ing.size) return;
    const now = this.now();
    for (const [cid, ts] of ing) {
      const row = this.store.db.query('SELECT cursor_ts FROM conv_feature WHERE conversation_id = ?').get(cid) as Row | null;
      if (row && ts < row.cursor_ts) this.store.db.query('UPDATE conv_feature SET stale_at = ? WHERE conversation_id = ?').run(now, cid);
      this.pending.add(cid);
    }
    ing.clear();
  }

  /**
   * Background work, `budget` messages at a time: conversations whose older messages arrived start over once
   * quiet, then everything behind its cursor catches up. At most `budget` messages and about `maxMs` per call, so
   * the hub keeps answering while millions of imported messages fold. Returns how many it folded; 0 when idle.
   */
  pump(budget = 5000, maxMs = 30): number {
    const start = this.budgetClock();
    const db = this.store.db;
    const now = this.now();
    this.refreshSelf();
    for (const r of db.query('SELECT conversation_id FROM conv_feature WHERE stale_at IS NOT NULL AND stale_at <= ? LIMIT 100').all(now - QUIET) as Row[]) this.reset(r.conversation_id);
    const behind = db
      .query(
        `SELECT c.id FROM conversation c LEFT JOIN conv_feature f ON f.conversation_id = c.id
         WHERE c.last_message_at IS NOT NULL AND (f.conversation_id IS NULL OR (c.last_message_at > f.cursor_ts AND f.stale_at IS NULL))
         ORDER BY c.last_message_at DESC LIMIT 200`,
      )
      .all() as Row[];
    let spent = 0;
    let folded = 0;
    for (const r of behind) {
      // At least one each call, however slow the machine: 0 says there was nothing to fold.
      if (spent >= budget || (folded > 0 && this.budgetClock() - start > maxMs)) break;
      spent += this.fold(r.id, Math.min(500, budget - spent));
      folded++;
      this.pending.add(r.id);
    }
    return spent;
  }

  /** Triage decided on a message: if it was folded already, add what the fold could not see yet. */
  triaged(messageId: string, d: { decision: P.TriageDecision; reasons: string[] }) {
    const db = this.store.db;
    const m = db.query('SELECT m.rowid AS rid, m.ts, m.conversation_id AS cid, m.author_id, i.person_id FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.id = ?').get(messageId) as Row | null;
    if (!m) return;
    const row = db.query('SELECT * FROM conv_feature WHERE conversation_id = ?').get(m.cid) as Row | null;
    // Not folded yet: the fold reads the decision itself.
    if (!row || m.ts > row.cursor_ts || (m.ts === row.cursor_ts && m.rid > row.cursor_rid)) return;
    const place = this.place(m.cid);
    if (!place) return;
    const s: ConvState = JSON.parse(row.state);
    const question = d.reasons.some((r) => r.includes('asks a question'));
    if (lateTriage(s, place, { id: messageId, ts: m.ts, author: m.author_id, authorKey: m.person_id ?? m.author_id }, { pushed: d.decision === 'push' || d.decision === 'quiet' || d.decision === 'digest', question })) {
      db.query('UPDATE conv_feature SET state = ? WHERE conversation_id = ?').run(JSON.stringify(s), m.cid);
      this.pending.add(m.cid);
    }
  }

  // ---------------------------------------------------------------- scoring

  private input(cid: string, now: number): (ScoreInput & { listed: boolean }) | null {
    const db = this.store.db;
    const c = db.query(`SELECT c.id, c.shape, c.last_message_at, ${LISTED} AS listed FROM conversation c WHERE c.id = ?`).get(cid) as Row | null;
    // An open message request waits under Requests, not in the inbox (add.ts).
    if (!c || requestHeld(db, cid)) return null;
    const v = db.query(`SELECT MAX(unread) AS unread, MAX(mentions) AS mentions, MIN(COALESCE(last_read_ts, 0)) AS read FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`).get(cid) as Row;
    const unread = v?.unread ?? 0;
    const mentions = v?.mentions ?? 0;
    const listed = !!c.listed;
    if (!listed && !unread) return null;
    const row = db.query('SELECT state FROM conv_feature WHERE conversation_id = ?').get(cid) as Row | null;
    const state: ConvState = row ? JSON.parse(row.state) : freshState();
    const pushedUnread = unread > 0 && !!state.lastPush && state.lastPush.ts > (v?.read ?? 0);
    // Everything else only while it has something for you.
    if (!listed && !mentions && !pushedUnread) return null;
    const eff = this.triage.effectiveLevel(cid);
    // Notes to self are silent by default because you do not notify yourself, not because you muted them.
    const quiet = eff.level === 'none' || eff.level === 'digest';
    const muted = quiet && !(c.shape === 'self' && !eff.explicit) ? eff.source : null;
    if (!listed && muted) return null;
    let pinged: string | null = null;
    let alerted = false;
    let importance: number | null = null;
    // Swiped away on the phone since: seen. It stays unread, and counts for nothing more here.
    const seen = pushedUnread && ((db.query('SELECT MAX(dismissed_at) AS at FROM notification WHERE conversation_id = ?').get(cid) as Row | null)?.at ?? 0) >= state.lastPush!.ts;
    if (pushedUnread && !seen) {
      const t = db.query('SELECT decision, score, reasons FROM triage WHERE message_id = ?').get(state.lastPush!.id) as Row | null;
      importance = t?.score ?? null;
      alerted = t?.decision === 'push' && now - state.lastPush!.ts <= PIN_FOR;
      // The list's rows have their importance; an alert or a Conversation says why it is one.
      if (!t || t.decision === 'push' || t.decision === 'quiet') pinged = (t ? (JSON.parse(t.reasons) as string[])[0] : null) ?? 'a message you have not read';
    }
    const members = (db.query('SELECT COUNT(*) AS n FROM participant WHERE conversation_id = ?').get(cid) as Row).n;
    const nameOf = (identityId: string | null) =>
      identityId
        ? ((db.query('SELECT COALESCE(p.name, i.display_name, i.handle, i.native_id) AS n FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.id = ?').get(identityId) as Row | null)?.n ?? null)
        : null;
    let peer: Row | null = null;
    if (c.shape === 'direct') {
      peer = (db.query('SELECT i.id, i.person_id FROM participant pa JOIN identity i ON i.id = pa.identity_id WHERE pa.conversation_id = ?').all(cid) as Row[]).find((p) => !this.mine(p.id, p.person_id)) ?? null;
    }
    const turn = state.turn?.addressed != null ? state.turn : null;
    const author = turn?.authorKey
      ? sumTallies([...(db.query('SELECT tally FROM conv_author_feature WHERE author_key = ?').all(turn.authorKey) as Row[]).map((r) => JSON.parse(r.tally)), ...(this.otherTallies?.(turn.authorKey) ?? [])], now)
      : null;
    const usageKey = c.shape === 'direct' && peer?.person_id ? ['person', peer.person_id] : ['conversation', cid];
    const u = db.query('SELECT score, visit_score, score_at, last_visit FROM place_usage WHERE kind = ? AND id = ?').get(usageKey[0], usageKey[1]) as Row | null;
    return {
      listed,
      now,
      shape: c.shape,
      members,
      lastMessageAt: c.last_message_at,
      state,
      author,
      authorName: nameOf(turn?.author ?? peer?.id ?? null),
      unread,
      mentions,
      pinged,
      alerted,
      importance,
      muted,
      usage: u ? { score: u.score, visitScore: u.visit_score, at: u.score_at, lastVisit: u.last_visit } : null,
      judged: this.judged.get(cid) ?? null,
    };
  }

  /** Everything about one conversation's score, for the API and for checking the formula. */
  explain(cid: string, now = this.now()) {
    this.refreshSelf();
    const x = this.input(cid, now);
    if (!x) {
      for (const src of this.sources) {
        const e = src.explain?.(cid, now);
        if (e) return e;
      }
      return null;
    }
    const s = scoreConversation(x);
    const f = x.state;
    // So what the learned order says is as of now too.
    this.judge?.rank?.(cid, x, s);
    return {
      ...s,
      listed: x.listed,
      features: {
        received: f.totalReceived,
        sent: f.totalSent,
        lastReceived: f.lastReceived,
        lastSent: f.lastSent,
        replyRate: replyRate(tallyAt(f.tally, now), 0, 1),
        usualReply: medianLatency(tallyAt(f.tally, now)),
        owedKind: f.turn?.kind ?? null,
      },
      activity: this.activity?.features(cid, now) ?? null,
      learned: this.judge?.explain?.(cid) ?? null,
    };
  }

  /** Volume against engagement for one place, or null before it is folded. For triage, later. */
  placeNoise(cid: string, now = this.now()): Noise | null {
    const row = this.store.db.query('SELECT state FROM conv_feature WHERE conversation_id = ?').get(cid) as Row | null;
    if (!row) return null;
    const u = this.store.db.query(`SELECT score, visit_score, score_at, last_visit FROM place_usage WHERE kind = 'conversation' AND id = ?`).get(cid) as Row | null;
    return noiseOf(JSON.parse(row.state), u ? { score: u.score, visitScore: u.visit_score, at: u.score_at, lastVisit: u.last_visit } : null, now);
  }

  private compute(cid: string, now: number): P.AttentionView | null {
    const x = this.input(cid, now);
    if (!x) return null;
    const s = scoreConversation(x);
    const r = this.judge?.rank?.(cid, x, s) ?? null;
    // Lifted to learn about it: that comes first, since it is why the row is where it is.
    const reasons = !r?.reason ? s.reasons : r.reason === EXPLORE_REASON ? [r.reason, ...s.reasons.slice(0, 3)] : [...s.reasons.slice(0, 3), r.reason];
    // An alert you have not seen comes before everything, whatever the order learned.
    return { id: cid, score: (r ? r.score : s.score) + (x.alerted ? ALERT_PIN : 0), needs: s.needs, reasons, owedSince: s.owedSince, at: now };
  }

  /** The view if it changed, 'removed' if the inbox no longer lists it, null if nothing changed. */
  private rescore(cid: string, now: number): P.AttentionView | 'removed' | null {
    const v = this.compute(cid, now);
    const prev = this.views.get(cid);
    if (!v) {
      if (!prev) return null;
      this.views.delete(cid);
      return 'removed';
    }
    // Unchanged: keep the view as it was sent, so what clients hold and what a bootstrap lists stay the same.
    if (prev && sameView(prev, v)) return null;
    this.views.set(cid, v);
    return v;
  }

  private event(items: P.AttentionView[], removed: string[]): P.ClientEvent[] {
    return items.length || removed.length ? [{ t: 'attention', items, removed }] : [];
  }

  /** Every conversation the inbox may list, scored now. Returns what changed. */
  rescoreAll(now = this.now()): P.ClientEvent[] {
    const db = this.store.db;
    this.refreshSelf();
    this.noteIngested();
    const ids = new Set<string>(this.views.keys());
    for (const r of db.query(`SELECT c.id FROM conversation c WHERE ${LISTED}`).all() as Row[]) ids.add(r.id);
    for (const r of db.query(`SELECT DISTINCT target_id AS id FROM vantage WHERE target_kind = 'conversation' AND mentions > 0`).all() as Row[]) ids.add(r.id);
    for (const r of db.query(`SELECT DISTINCT m.conversation_id AS id FROM triage t JOIN message m ON m.id = t.message_id WHERE t.decision IN ('push', 'quiet', 'digest') AND t.created_at > ?`).all(now - 14 * DAY) as Row[]) ids.add(r.id);
    const items: P.AttentionView[] = [];
    const removed: string[] = [];
    for (const id of ids) {
      const r = this.rescore(id, now);
      if (r === 'removed') removed.push(id);
      else if (r) items.push(r);
    }
    this.fromSources(now, true, items, removed);
    this.scored = true;
    return this.event(items, removed);
  }

  private fromSources(now: number, all: boolean, items: P.AttentionView[], removed: string[]) {
    for (const src of this.sources) {
      const r = src.rescore(now, all);
      items.push(...r.items);
      removed.push(...r.removed);
    }
  }

  /** Whether conversations (or a source's rows) wait to be scored again: the next sync has them. */
  get busy(): boolean {
    return this.pending.size > 0 || this.sources.some((s) => s.busy);
  }

  /** One conversation's score as last sent, if the inbox lists it. */
  view(id: string): P.AttentionView | undefined {
    if (!this.scored) this.rescoreAll();
    const v = this.views.get(id);
    if (v || !this.sources.length) return v;
    for (const src of this.sources) {
      const x = src.view(id);
      if (x) return x;
    }
    return undefined;
  }

  /** For the bootstrap: every listed conversation's score. */
  list(): P.AttentionView[] {
    if (!this.scored) this.rescoreAll();
    const out = [...this.views.values()];
    for (const src of this.sources) out.push(...src.list());
    return out;
  }

  /**
   * After the store flushed: fold what arrived in the conversations that changed, and score them again.
   * Bounded by `budgetMs`; the rest waits for the next flush. Returns the events to send with the flush.
   */
  sync(changed: Iterable<string>, removed: Iterable<string> = [], budgetMs = 20): P.ClientEvent[] {
    if (!this.scored) return [];
    this.noteIngested();
    for (const id of changed) this.pending.add(id);
    const items: P.AttentionView[] = [];
    const gone: string[] = [];
    for (const id of removed) {
      this.pending.delete(id);
      this.forget(id);
      if (this.views.delete(id)) gone.push(id);
    }
    const now = this.now();
    if (this.sources.length) this.fromSources(now, false, items, gone);
    if (!this.pending.size) return this.event(items, gone);
    this.refreshSelf();
    const start = this.budgetClock();
    let steps = 0;
    for (const id of this.pending) {
      // At least one each sync, however slow the machine.
      if (steps++ > 0 && this.budgetClock() - start > budgetMs) break;
      this.pending.delete(id);
      const stale = this.store.db.query('SELECT stale_at FROM conv_feature WHERE conversation_id = ?').get(id) as Row | null;
      // More than this is a backlog: the pump has it.
      if (!stale?.stale_at) this.fold(id, 500);
      const r = this.rescore(id, now);
      if (r === 'removed') gone.push(id);
      else if (r) items.push(r);
    }
    return this.event(items, gone);
  }

  /**
   * A device said where you have been (usage.ts): score those conversations again now, so the chat you were just in
   * is near the top by the time you leave it. A person's usage is their DMs'.
   */
  visited(places: { kind: string; id: string }[]): P.ClientEvent[] {
    const db = this.store.db;
    const ids = new Set<string>();
    for (const p of places) {
      if (p.kind === 'conversation') ids.add(p.id);
      else if (p.kind === 'person')
        for (const r of db
          .query(`SELECT DISTINCT c.id FROM conversation c JOIN participant pa ON pa.conversation_id = c.id JOIN identity i ON i.id = pa.identity_id WHERE c.shape = 'direct' AND i.person_id = ?`)
          .all(p.id) as Row[])
          ids.add(r.id);
    }
    return ids.size ? this.sync(ids) : [];
  }

  /** The background pump, and scores that move with time. `send` broadcasts to clients. */
  start(send: (events: P.ClientEvent[]) => void) {
    this.rescoreAll();
    let busy = false;
    const pumpSoon = () => {
      if (busy) return;
      busy = true;
      const step = () => {
        const n = this.pump();
        if (n > 0) setTimeout(step, 5);
        else busy = false;
      };
      step();
    };
    pumpSoon();
    this.timers.push(setInterval(pumpSoon, 2000));
    this.timers.push(
      setInterval(() => {
        noteWork('attention: rescore all');
        send(this.rescoreAll());
      }, RESCORE_EVERY),
    );
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
