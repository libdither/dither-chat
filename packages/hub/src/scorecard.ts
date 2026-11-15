/**
 * The scorecard (docs/scorecard.md): how well the notification and inbox models did, day by day. Once a day's
 * outcomes are in (a day and an hour after its end), each of its live decisions is scored against what happened
 * afterwards, and the numbers are kept in `model_score`: one row per day and metric, a value and how many it is of.
 * Nothing is scored before its windows close, so no number peeks at what was not known yet.
 *
 * It is prequential: what triage logged with each decision (`probs`, `shadow`, the facts its start comes from) is
 * scored as it was, against the start (`learn.ts` prior, what learning nothing gives) on the same messages. The models
 * refit themselves (votes.ts, ranker.ts); this says whether a refit helped.
 *
 * Off the request path: a generator run in slices (slices.ts), every query bounded by a day (or a quarter hour of
 * decisions) and on an index. Counts and times only, never what was said.
 */
import type { Database } from 'bun:sqlite';
import { SCORE_METRICS, type ModelScoresView } from '@dither-chat/protocol/scorecard';
import { prior, type Facts } from './learn.ts';
import { OPEN_DWELL } from './labels.ts';
import { sliced } from './slices.ts';
import { jobFailed } from './errors.ts';
import { needsOutcomes } from './needsreply.ts';
import { REPLY_WINDOW } from './tally.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Bump when a metric's meaning changes: every day is scored again from what the database still holds. A day whose
 * decisions or visits have since been let go then scores with less (housekeeping.ts keeps triage 90 days, the log for
 * its retention).
 */
/** 2: the needs-reply chance's calibration (needsReply) and For you's opens, scored back over the days already kept. */
export const SCORE_VERSION = 2;
/** A notification was followed when you opened its chat within this long. */
const FOLLOW_WITHIN = 3 * HOUR;
/** A chat-day was opened when you opened the chat within this long of one of its messages. */
const OPENED_WITHIN = DAY;
/** A Conversation message was answered quickly when you wrote there within this long. */
const ANSWER_WITHIN = 3 * HOUR;
/** A chat opened with no notification about it in this long before was opened unprompted. */
const UNPROMPTED_AFTER = DAY;
/** A day is scored this long after it ends: its longest window, and an hour for late visits. */
export const MATURE_AFTER = OPENED_WITHIN + HOUR;
/** On a first run, scoring goes back at most this far. */
const BACKFILL_DAYS = 120;
/** Decisions are read this much at a time: a busy hub makes a few thousand in a quarter hour. */
const WINDOW = 15 * MIN;
/** Inbox rows: the first screen, and where a row is far down. */
const TOP_ROWS = 8;
const DEEP_ROW = 20;

/** One metric on one day. `value` is null when the day had nothing to score for it. */
export interface ScoreRow {
  day: string;
  metric: string;
  value: number | null;
  n: number;
  extra?: Record<string, number> | null;
}

/** What a scorer gets for one day. */
interface DayContext {
  db: Database;
  day: string;
  /** The day's bounds, local midnight to local midnight. */
  from: number;
  to: number;
  /** Your identities on every network: what you wrote. */
  self: string[];
  /** Opens of 5 s or more, by conversation: from a day before the day to its scoring. */
  opens: OpenIndex;
}

/**
 * A metric's scorer: yields how many rows it read since it last yielded (slices.ts), returns its rows for the day.
 * To score something new, add a scorer here and its chart to the protocol's SCORE_CHARTS (docs/scorecard.md, "Seams").
 */
type DayScorer = (c: DayContext) => Generator<number, ScoreRow[]>;

/** The hub's local day of `t`, YYYY-MM-DD. */
export function dayOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local midnight at the start of `day`, and of the day after (a day can be 23 or 25 hours long). */
export function dayBounds(day: string): [number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

const nextDay = (day: string) => dayOf(dayBounds(day)[1]);

/** The share of `k` in `n`, or null of nothing. */
const share = (k: number, n: number) => (n ? k / n : null);
const row = (day: string, metric: string, value: number | null, n: number, extra?: Record<string, number>): ScoreRow => ({ day, metric, value, n, extra: extra ?? null });

/**
 * The area under the ROC curve: the chance that a positive scores above a negative, ties counting half. Null with
 * no positives or no negatives.
 */
export function auc(pos: readonly number[], neg: readonly number[]): number | null {
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map((s) => [s, 1] as const), ...neg.map((s) => [s, 0] as const)].sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const mid = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (all[k][1]) rankSum += mid;
    i = j;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/**
 * Average precision: down a list sorted by score, the precision at each positive, averaged. How near the top the
 * positives are, where AUC also counts every easy negative far below. Tied scores share their precision. Null with no
 * positives or no negatives.
 */
export function averagePrecision(pos: readonly number[], neg: readonly number[]): number | null {
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map((s) => [s, 1] as const), ...neg.map((s) => [s, 0] as const)].sort((a, b) => b[0] - a[0]);
  let seen = 0;
  let hits = 0;
  let sum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    let k = 0;
    while (j < all.length && all[j][0] === all[i][0]) k += all[j++][1];
    seen = j;
    hits += k;
    sum += k * (hits / seen);
    i = j;
  }
  return sum / pos.length;
}

/** Times of opens by conversation, sorted, for "was it opened between a and b". */
export class OpenIndex {
  private by = new Map<string, number[]>();
  add(conv: string, t: number) {
    const a = this.by.get(conv);
    if (a) a.push(t);
    else this.by.set(conv, [t]);
  }
  seal() {
    for (const a of this.by.values()) a.sort((x, y) => x - y);
    return this;
  }
  /** Some open of `conv` began in [a, b]. */
  between(conv: string, a: number, b: number): boolean {
    const ts = this.by.get(conv);
    if (!ts) return false;
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < a) lo = mid + 1;
      else hi = mid;
    }
    return lo < ts.length && ts[lo] <= b;
  }
}

const TIER_METRIC: Record<string, string> = { push: 'alert', quiet: 'conversation', digest: 'list' };

/**
 * Notifications that reached a phone that day (a push server took them), by tier, and the share after which you
 * opened that chat within 3 hours. Each counts: a busy chat's row brought up to date ten times is ten.
 */
function* notified(c: DayContext): Generator<number, ScoreRow[]> {
  const rows = c.db
    .query(
      `SELECT n.conversation_id AS conv, n.sent_at AS at, n.tapped_at AS tapped, t.decision FROM notification n LEFT JOIN triage t ON t.message_id = n.message_id
       WHERE n.sent_at >= ? AND n.sent_at < ? AND n.kind = 'message' AND n.conversation_id IS NOT NULL AND COALESCE(n.accepted, 1) > 0 LIMIT 50000`,
    )
    .all(c.from, c.to) as Row[];
  yield rows.length;
  const by: Record<string, { n: number; opened: number; tapped: number }> = {};
  for (const tier of Object.values(TIER_METRIC)) by[tier] = { n: 0, opened: 0, tapped: 0 };
  const chats: Record<string, Set<string>> = {};
  for (const r of rows) {
    const tier = TIER_METRIC[r.decision];
    if (!tier) continue;
    const b = by[tier];
    b.n++;
    (chats[tier] ??= new Set()).add(r.conv);
    if (r.tapped != null) b.tapped++;
    if (c.opens.between(r.conv, r.at, r.at + FOLLOW_WITHIN)) b.opened++;
  }
  return Object.entries(by).map(([tier, b]) => row(c.day, `${tier}.opened`, share(b.opened, b.n), b.n, { opened: b.opened, tapped: b.tapped, chats: chats[tier]?.size ?? 0 }));
}

interface ChatDay {
  first: number;
  last: number;
  /** Decided by the Conversation rule (or alerted) at least once: importance did not decide it. */
  conv: boolean;
  /** The highest importance of its messages with facts: logged, the start's, the candidate's. */
  live: number;
  start: number;
  cand: number;
  scored: boolean;
}

interface AlertItem {
  conv: string;
  at: number;
  live: number;
  start: number;
  cand: number | null;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const parse = <T>(s: string | null): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

/**
 * The day's decisions, a quarter hour at a time, scored three ways:
 *  - importance: per chat with messages that day outside the Conversation tier, its highest importance against
 *    whether you opened it within a day of one of them (AUC), as logged, as the start would have it, and as the
 *    candidate model logged it;
 *  - the alert chance: per Conversation message the local model read, against whether you wrote there within 3 hours;
 *  - your alert marks on the day's decisions.
 * Only decisions with their facts and an importance logged count in the first two, so the three lines score the same
 * messages.
 */
function* decisions(c: DayContext): Generator<number, ScoreRow[]> {
  const chats = new Map<string, ChatDay>();
  const alerts: AlertItem[] = [];
  let alertsSent = 0;
  let convs = 0;
  let wrong = 0;
  let should = 0;
  const q = c.db.query(
    `SELECT t.decision, t.created_at AS at, t.facts, t.probs, t.shadow, t.alert_mark AS mark, m.conversation_id AS conv
     FROM triage t JOIN message m ON m.id = t.message_id WHERE t.created_at >= ? AND t.created_at < ?`,
  );
  for (let w = c.from; w < c.to; w += WINDOW) {
    const rows = q.all(w, Math.min(w + WINDOW, c.to)) as Row[];
    for (const r of rows) {
      if (r.decision === 'silent') continue;
      if (r.decision === 'push') alertsSent++;
      if (r.decision === 'quiet') convs++;
      if (r.mark === 0 && r.decision === 'push') wrong++;
      if (r.mark === 1) should++;
      let d = chats.get(r.conv);
      if (!d) chats.set(r.conv, (d = { first: r.at, last: r.at, conv: false, live: 0, start: 0, cand: 0, scored: false }));
      d.first = Math.min(d.first, r.at);
      d.last = Math.max(d.last, r.at);
      if (r.decision === 'quiet' || r.decision === 'push') d.conv = true;
      const facts = parse<Facts>(r.facts);
      const probs = parse<Record<string, unknown>>(r.probs);
      const live = num(probs?.important);
      if (!facts || live === null) continue;
      const p0 = prior(facts);
      const shadow = parse<Record<string, unknown>>(r.shadow);
      d.scored = true;
      d.live = Math.max(d.live, live);
      d.start = Math.max(d.start, p0.important);
      d.cand = Math.max(d.cand, num(shadow?.important) ?? live);
      const alert = num(probs?.alert);
      if (facts.conv && facts.judge !== undefined && alert !== null && !facts.cap) alerts.push({ conv: r.conv, at: r.at, live: alert, start: p0.alert, cand: num(shadow?.alert) });
    }
    yield rows.length + 1;
  }

  // Importance, per chat-day outside the Conversation tier.
  const imp = { live: [[], []] as number[][], start: [[], []] as number[][], cand: [[], []] as number[][] };
  for (const [conv, d] of chats) {
    if (!d.scored || d.conv) continue;
    const k = c.opens.between(conv, d.first, d.last + OPENED_WITHIN) ? 0 : 1;
    imp.live[k].push(d.live);
    imp.start[k].push(d.start);
    imp.cand[k].push(d.cand);
  }
  yield chats.size;
  const nImp = imp.live[0].length + imp.live[1].length;
  const openedImp = imp.live[0].length;

  // The alert chance, per Conversation message the local model read: did you write there within 3 hours?
  const own = new Map<string, number[]>();
  if (alerts.length && c.self.length) {
    const marks = c.self.map(() => '?').join(',');
    const ownQ = c.db.query(`SELECT ts FROM message WHERE conversation_id = ? AND ts > ? AND ts <= ? AND author_id IN (${marks}) ORDER BY ts LIMIT 5000`);
    for (const conv of new Set(alerts.map((a) => a.conv))) {
      const ts = (ownQ.all(conv, c.from, c.to + ANSWER_WITHIN, ...c.self) as Row[]).map((r) => r.ts as number);
      own.set(conv, ts);
      yield ts.length + 1;
    }
  }
  const al = { live: [[], []] as number[][], start: [[], []] as number[][], cand: [[], []] as number[][] };
  let candAll = true;
  for (const a of alerts) {
    const k = (own.get(a.conv) ?? []).some((t) => t > a.at && t <= a.at + ANSWER_WITHIN) ? 0 : 1;
    al.live[k].push(a.live);
    al.start[k].push(a.start);
    if (a.cand === null) candAll = false;
    al.cand[k].push(a.cand ?? a.live);
  }
  const answered = al.live[0].length;
  return [
    row(c.day, 'importance.auc', auc(imp.live[0], imp.live[1]), nImp, { opened: openedImp }),
    row(c.day, 'importance.auc_start', auc(imp.start[0], imp.start[1]), nImp, { opened: openedImp }),
    row(c.day, 'importance.auc_candidate', auc(imp.cand[0], imp.cand[1]), nImp, { opened: openedImp }),
    row(c.day, 'importance.ap', averagePrecision(imp.live[0], imp.live[1]), nImp, { opened: openedImp }),
    row(c.day, 'importance.ap_start', averagePrecision(imp.start[0], imp.start[1]), nImp, { opened: openedImp }),
    row(c.day, 'importance.ap_candidate', averagePrecision(imp.cand[0], imp.cand[1]), nImp, { opened: openedImp }),
    row(c.day, 'alert.auc', auc(al.live[0], al.live[1]), alerts.length, { answered }),
    row(c.day, 'alert.auc_start', auc(al.start[0], al.start[1]), alerts.length, { answered }),
    // Without the candidate's chance on every message, its line would mix in the live one's: left out.
    row(c.day, 'alert.auc_candidate', candAll ? auc(al.cand[0], al.cand[1]) : null, alerts.length, { answered }),
    row(c.day, 'marks.alert_wrong', wrong, alertsSent),
    row(c.day, 'marks.should_alert', should, convs + alertsSent),
  ];
}

/**
 * Chats you opened by yourself: the first open of each chat that day with no notification about it in the day
 * before, and the share of those the list held (a message there at the list or above in that day).
 */
function* unprompted(c: DayContext): Generator<number, ScoreRow[]> {
  const firsts = c.db
    .query(
      `SELECT v.conversation_id AS conv, MIN(v.start_at) AS at FROM visit v JOIN conversation k ON k.id = v.conversation_id
       WHERE v.start_at >= ? AND v.start_at < ? AND v.active >= ? GROUP BY v.conversation_id LIMIT 5000`,
    )
    .all(c.from, c.to, OPEN_DWELL) as Row[];
  yield firsts.length;
  const sent = new OpenIndex();
  for (const r of c.db.query(`SELECT conversation_id AS conv, sent_at AS at FROM notification WHERE sent_at >= ? AND sent_at < ? AND conversation_id IS NOT NULL LIMIT 50000`).all(c.from - UNPROMPTED_AFTER, c.to) as Row[]) sent.add(r.conv, r.at);
  sent.seal();
  const listed = c.db.query(
    `SELECT 1 FROM message m JOIN triage t ON t.message_id = m.id WHERE m.conversation_id = ? AND m.ts >= ? AND m.ts < ? AND t.decision IN ('digest', 'quiet', 'push') LIMIT 1`,
  );
  let n = 0;
  let caught = 0;
  for (const f of firsts) {
    if (sent.between(f.conv, f.at - UNPROMPTED_AFTER, f.at)) continue;
    n++;
    if (listed.get(f.conv, f.at - UNPROMPTED_AFTER, f.at)) caught++;
    yield 1;
  }
  return [row(c.day, 'unprompted.list', share(caught, n), n, { caught, opened: firsts.length })];
}

/** Opens from the inbox's rows: the mean of 1 ÷ row, and the shares in the first 8 rows and below row 20. */
function* inbox(c: DayContext): Generator<number, ScoreRow[]> {
  const ranks = (c.db.query(`SELECT rank FROM visit WHERE start_at >= ? AND start_at < ? AND source = 'inbox' AND rank IS NOT NULL LIMIT 20000`).all(c.from, c.to) as Row[]).map((r) => r.rank as number);
  yield ranks.length;
  const n = ranks.length;
  const top = ranks.filter((r) => r < TOP_ROWS).length;
  const deep = ranks.filter((r) => r >= DEEP_ROW).length;
  return [
    row(c.day, 'inbox.mrr', n ? ranks.reduce((s, r) => s + 1 / (r + 1), 0) / n : null, n),
    row(c.day, 'inbox.top8', share(top, n), n, { top }),
    row(c.day, 'inbox.deep', share(deep, n), n, { deep }),
  ];
}

/**
 * The needs-reply chance (needsreply.ts, docs/inbox.md "Needs a reply"): for owed replies whose three days ended that
 * day, the mean chance shown (as kept at each age) and the share answered, and the Brier score of the chance and of the
 * owed table's alone. A turn's window ends by the day's end, so the day is matured for it as for the rest.
 */
function* needsReply(c: DayContext): Generator<number, ScoreRow[]> {
  const rows = needsOutcomes(c.db, c.from - REPLY_WINDOW, c.to - REPLY_WINDOW, c.to).filter((r): r is typeof r & { y: boolean } => r.y !== null);
  yield rows.length;
  const n = rows.length;
  const answered = rows.filter((r) => r.y).length;
  const mean = (f: (r: (typeof rows)[number]) => number) => (n ? rows.reduce((a, r) => a + f(r), 0) / n : null);
  return [
    row(c.day, 'needs.predicted', mean((r) => r.p), n),
    row(c.day, 'needs.answered', share(answered, n), n, { answered }),
    row(c.day, 'needs.brier', mean((r) => (r.p - (r.y ? 1 : 0)) ** 2), n),
    row(c.day, 'needs.brier_table', mean((r) => (r.table - (r.y ? 1 : 0)) ** 2), n),
  ];
}

/**
 * For you (foryou.ts, docs/foryou.md): of the items on screen that day (a `shown` event on any device), the share
 * opened from it (`clicked`); and the same for exploration slots alone, whose items no order chose.
 */
function* foryou(c: DayContext): Generator<number, ScoreRow[]> {
  // A copy from before For you has no tables for it: nothing to score.
  if (!c.db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'foryou_event'`).get()) return [row(c.day, 'foryou.clicked', null, 0), row(c.day, 'foryou.clicked_explore', null, 0)];
  const rows = c.db
    .query(
      `SELECT i.slot AS slot, EXISTS (SELECT 1 FROM foryou_event k WHERE k.item_id = e.item_id AND k.kind = 'clicked') AS clicked
       FROM foryou_event e JOIN foryou_item i ON i.id = e.item_id WHERE e.kind = 'shown' AND e.at >= ? AND e.at < ? GROUP BY e.item_id LIMIT 50000`,
    )
    .all(c.from, c.to) as Row[];
  yield rows.length;
  const clicked = rows.filter((r) => r.clicked).length;
  const explore = rows.filter((r) => r.slot === 'explore');
  const exploreClicked = explore.filter((r) => r.clicked).length;
  return [row(c.day, 'foryou.clicked', share(clicked, rows.length), rows.length, { clicked }), row(c.day, 'foryou.clicked_explore', share(exploreClicked, explore.length), explore.length, { clicked: exploreClicked })];
}

const SCORERS: DayScorer[] = [notified, decisions, unprompted, inbox, needsReply, foryou];

/**
 * Your identities: what you wrote is by one of these. As interact.ts SELF_SQL, but on identity's person index: SQLite
 * plans SELF_SQL's join as a scan of every identity (60 ms on a real hub).
 */
function selfIds(db: Database): string[] {
  return (db.query(`SELECT self_identity AS id FROM account WHERE self_identity IS NOT NULL UNION SELECT id FROM identity WHERE person_id IN (SELECT id FROM person WHERE is_self = 1)`).all() as Row[]).map((r) => r.id);
}

/** Score one day with every scorer. Reads only. */
function* scoreDay(db: Database, day: string, self = selfIds(db), scorers: DayScorer[] = SCORERS): Generator<number, ScoreRow[]> {
  const [from, to] = dayBounds(day);
  const opens = new OpenIndex();
  const vs = db.query(`SELECT conversation_id AS conv, start_at AS at FROM visit WHERE start_at >= ? AND start_at < ? AND conversation_id IS NOT NULL AND active >= ? LIMIT 100000`).all(from, to + MATURE_AFTER, OPEN_DWELL) as Row[];
  for (const v of vs) opens.add(v.conv, v.at);
  opens.seal();
  yield vs.length;
  const ctx: DayContext = { db, day, from, to, self, opens };
  const out: ScoreRow[] = [];
  for (const s of scorers) out.push(...(yield* s(ctx)));
  return out;
}

/** The first day with anything to score, at most BACKFILL_DAYS back. */
function firstDay(db: Database, now: number): string | null {
  const firsts = [`SELECT MIN(created_at) AS t FROM triage`, `SELECT MIN(sent_at) AS t FROM notification`, `SELECT MIN(start_at) AS t FROM visit`].map((s) => num((db.query(s).get() as Row | null)?.t)).filter((t): t is number => t !== null);
  if (!firsts.length) return null;
  return dayOf(Math.max(Math.min(...firsts), now - BACKFILL_DAYS * DAY));
}

/** Every day from the first with data whose outcomes are all in by `now`, oldest first. */
function maturedDays(db: Database, now: number): string[] {
  const first = firstDay(db, now);
  const out: string[] = [];
  for (let d = first; d && dayBounds(d)[1] + MATURE_AFTER <= now; d = nextDay(d)) out.push(d);
  return out;
}

/** Score every matured day, without writing: for the script and tests. */
export function* scoreAll(db: Database, now: number, scorers: DayScorer[] = SCORERS): Generator<number, ScoreRow[]> {
  const self = selfIds(db);
  const out: ScoreRow[] = [];
  for (const d of maturedDays(db, now)) out.push(...(yield* scoreDay(db, d, self, scorers)));
  return out;
}

/** Rows as the API gives them: aligned by day, oldest first. */
export function viewOf(rows: readonly ScoreRow[], pending: string | null): ModelScoresView {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const at = new Map(days.map((d, i) => [d, i]));
  const metrics: ModelScoresView['metrics'] = {};
  for (const m of SCORE_METRICS) metrics[m.key] = { v: days.map(() => null), n: days.map(() => 0) };
  for (const r of rows) {
    const s = (metrics[r.metric] ??= { v: days.map(() => null), n: days.map(() => 0) });
    const i = at.get(r.day)!;
    s.v[i] = r.value === null ? null : Math.round(r.value * 10000) / 10000;
    s.n[i] = r.n;
  }
  return { days, metrics, pending };
}

/** The hub's side: scores what has matured and not been scored, keeps it, and answers the page. */
export class Scorecard {
  private running: Promise<number> | null = null;
  constructor(
    private db: Database,
    private scorers: DayScorer[] = SCORERS,
  ) {}

  /** Score every matured day not yet kept, in slices. Resolves to how many days it scored. One run at a time. */
  run(now = Date.now()): Promise<number> {
    return (this.running ??= sliced('scorecard', this.steps(now))
      .catch((e) => {
        console.error('scorecard failed', e);
        jobFailed('scorecard', e);
        return 0;
      })
      .finally(() => (this.running = null)));
  }

  *steps(now: number): Generator<number, number> {
    const db = this.db;
    const v = (db.query(`SELECT value FROM meta WHERE key = 'model_score_version'`).get() as Row | null)?.value;
    if (v !== String(SCORE_VERSION)) {
      db.transaction(() => {
        db.query('DELETE FROM model_score').run();
        db.query(`INSERT INTO meta (key, value) VALUES ('model_score_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(String(SCORE_VERSION));
      })();
    }
    const have = new Set((db.query('SELECT DISTINCT day FROM model_score').all() as Row[]).map((r) => r.day as string));
    const self = selfIds(db);
    const put = db.query('INSERT OR REPLACE INTO model_score (day, metric, value, n, extra, at) VALUES (?, ?, ?, ?, ?, ?)');
    let done = 0;
    for (const d of maturedDays(db, now)) {
      if (have.has(d)) continue;
      const rows = yield* scoreDay(db, d, self, this.scorers);
      db.transaction(() => {
        for (const r of rows) put.run(r.day, r.metric, r.value, r.n, r.extra ? JSON.stringify(r.extra) : null, now);
      })();
      done++;
    }
    if (done) console.log(`scorecard: scored ${done} day${done === 1 ? '' : 's'}`);
    return done;
  }

  /** The last `days` scored days. */
  view(days: number, now = Date.now()): ModelScoresView {
    const rows = this.db.query('SELECT day, metric, value, n FROM model_score WHERE day >= ? ORDER BY day').all(dayOf(now - days * DAY)) as ScoreRow[];
    // The newest day whose end has passed but whose outcomes are not all in yet.
    const last = dayOf(now - DAY);
    return viewOf(rows, dayBounds(last)[1] + MATURE_AFTER > now ? last : null);
  }
}

/**
 * The demo world's scorecard (main.ts, `--demo`): three invented weeks that improve, so the page has something to
 * draw. Only into an empty table.
 */
export function seedDemoScores(db: Database, now: number) {
  if (db.query('SELECT 1 FROM model_score LIMIT 1').get()) return;
  const put = db.query('INSERT OR REPLACE INTO model_score (day, metric, value, n, extra, at) VALUES (?, ?, ?, ?, NULL, ?)');
  // A fixed wobble, so the demo is the same every time.
  const wob = (i: number, k: number) => Math.sin(i * 1.7 + k * 2.3) * 0.5 + Math.sin(i * 0.6 + k) * 0.5;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const days = 21;
  db.transaction(() => {
    db.query(`INSERT INTO meta (key, value) VALUES ('model_score_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(String(SCORE_VERSION));
    for (let i = 0; i < days; i++) {
      const day = dayOf(now - MATURE_AFTER - (days - i) * DAY);
      const t = i / (days - 1);
      const v: [string, number | null, number][] = [
        ['alert.opened', i < 7 ? null : clamp(0.6 + 0.2 * t + 0.08 * wob(i, 1)), i < 7 ? 0 : 2 + (i % 4)],
        ['conversation.opened', clamp(0.62 + 0.18 * t + 0.07 * wob(i, 2)), 40 + ((i * 7) % 30)],
        ['list.opened', clamp(0.3 - 0.22 * t + 0.03 * wob(i, 3)), 60 + ((i * 11) % 90)],
        ['importance.auc', clamp(0.8 + 0.12 * t + 0.02 * wob(i, 4)), 400 + ((i * 13) % 200)],
        ['importance.auc_start', clamp(0.82 + 0.02 * wob(i, 5)), 400 + ((i * 13) % 200)],
        ['importance.auc_candidate', clamp(0.82 + 0.13 * t + 0.02 * wob(i, 6)), 400 + ((i * 13) % 200)],
        ['importance.ap', clamp(0.25 + 0.2 * t + 0.04 * wob(i, 15)), 400 + ((i * 13) % 200)],
        ['importance.ap_start', clamp(0.18 + 0.04 * wob(i, 16)), 400 + ((i * 13) % 200)],
        ['importance.ap_candidate', clamp(0.24 + 0.22 * t + 0.04 * wob(i, 17)), 400 + ((i * 13) % 200)],
        ['alert.auc', clamp(0.66 + 0.1 * t + 0.05 * wob(i, 7)), 80 + (i % 20)],
        ['alert.auc_start', clamp(0.66 + 0.05 * wob(i, 8)), 80 + (i % 20)],
        ['alert.auc_candidate', null, 80 + (i % 20)],
        ['marks.alert_wrong', Math.max(0, Math.round(2 - 2 * t + wob(i, 9))), 3],
        ['marks.should_alert', Math.max(0, Math.round(1.5 - t + wob(i, 10))), 120],
        ['unprompted.list', clamp(0.2 + 0.25 * t + 0.08 * wob(i, 11)), 8 + (i % 6)],
        ['inbox.mrr', clamp(0.3 + 0.22 * t + 0.05 * wob(i, 12)), 20 + (i % 15)],
        ['inbox.top8', clamp(0.55 + 0.25 * t + 0.06 * wob(i, 13)), 20 + (i % 15)],
        ['inbox.deep', clamp(0.15 - 0.1 * t + 0.03 * wob(i, 14)), 20 + (i % 15)],
        ['needs.predicted', clamp(0.7 + 0.04 * wob(i, 18)), 30 + (i % 12)],
        ['needs.answered', clamp(0.74 - 0.03 * t + 0.08 * wob(i, 19)), 30 + (i % 12)],
        ['needs.brier', clamp(0.17 - 0.03 * t + 0.02 * wob(i, 20)), 30 + (i % 12)],
        ['needs.brier_table', clamp(0.19 + 0.02 * wob(i, 21)), 30 + (i % 12)],
        ['foryou.clicked', i < 10 ? null : clamp(0.08 + 0.06 * t + 0.03 * wob(i, 18)), i < 10 ? 0 : 30 + ((i * 5) % 25)],
        ['foryou.clicked_explore', i < 10 ? null : clamp(0.05 + 0.04 * t + 0.04 * wob(i, 19)), i < 10 ? 0 : 6 + (i % 5)],
      ];
      for (const [m, value, n] of v) put.run(day, m, value, n, now);
    }
  })();
}
