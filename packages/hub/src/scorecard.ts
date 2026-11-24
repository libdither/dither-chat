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
import { ACTIVE_MS, BURST_MS, FORGET_MS, PHONE } from './delivery.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Bump when a metric's meaning changes: every day is scored again from what the database still holds. A day whose
 * decisions or visits have since been let go then scores with less (housekeeping.ts keeps triage 90 days, the log for
 * its retention).
 */
/**
 * 2: the needs-reply chance's calibration (needsReply) and For you's opens, scored back over the days already kept.
 * 3: the cost side (sounds, stale pushes, checks with nothing new, and the people metrics), scored back the same way.
 * 4: the loudness scale's check-ins and its comparison with the tiers (loudnessScores).
 */
export const SCORE_VERSION = 4;
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
  /** What a scorer reads once a run and keeps for every day of it (the turns open now). */
  cache: Record<string, unknown>;
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

/**
 * Opens from the inbox's rows: the mean of 1 ÷ row, and the shares in the first 8 rows and below row 20. And, for the
 * opens whose device said where the row stood in the shadow order with mail (docs/inbox.md, "Mail in the learned
 * order"), the mean of 1 ÷ row as shown and as it would have stood, for every row and for mail rows alone. The rows
 * were seen where they were shown, so the order shown has the better of it: the shadow order catching up says more
 * than its level does.
 */
function* inbox(c: DayContext): Generator<number, ScoreRow[]> {
  const rows = c.db
    .query(`SELECT rank, shadow_rank AS shadow, conversation_id AS conv FROM visit WHERE start_at >= ? AND start_at < ? AND source = 'inbox' AND rank IS NOT NULL LIMIT 20000`)
    .all(c.from, c.to) as Row[];
  yield rows.length;
  const ranks = rows.map((r) => r.rank as number);
  const n = ranks.length;
  const top = ranks.filter((r) => r < TOP_ROWS).length;
  const deep = ranks.filter((r) => r >= DEEP_ROW).length;
  const mrr = (xs: number[]) => (xs.length ? xs.reduce((s, r) => s + 1 / (r + 1), 0) / xs.length : null);
  const both = rows.filter((r) => r.shadow != null);
  const mail = both.filter((r) => typeof r.conv === 'string' && r.conv.startsWith('mth_'));
  const mailOpens = rows.filter((r) => typeof r.conv === 'string' && r.conv.startsWith('mth_')).length;
  return [
    row(c.day, 'inbox.mrr', mrr(ranks), n),
    row(c.day, 'inbox.top8', share(top, n), n, { top }),
    row(c.day, 'inbox.deep', share(deep, n), n, { deep }),
    row(c.day, 'inbox.mrr_live', mrr(both.map((r) => r.rank)), both.length),
    row(c.day, 'inbox.mrr_shadow', mrr(both.map((r) => r.shadow)), both.length),
    row(c.day, 'inbox.mail_mrr', mrr(mail.map((r) => r.rank)), mail.length, { opens: mailOpens }),
    row(c.day, 'inbox.mail_mrr_shadow', mrr(mail.map((r) => r.shadow)), mail.length, { opens: mailOpens }),
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

/**
 * The loudness scale (loudness.ts, checkin.ts): the check-ins' answers, weighted back by the chance each question had
 * of being picked (only the random half counts, so the rates are honest), and how the loudness compares with the tiers
 * on the same messages while it runs in shadow.
 */
export function* loudnessScores(c: DayContext): Generator<number, ScoreRow[]> {
  const keys = ['attn.worth', 'attn.worth_shadow', 'attn.could_wait', 'attn.shouldnt', 'attn.missed', 'attn.asked', 'foryou.worth', 'shadow.sounds', 'shadow.agree', 'shadow.quick_show', 'shadow.quick_show_live'];
  if (!c.db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'checkin'`).get()) return keys.map((k) => row(c.day, k, null, 0));
  const asked = c.db.query(`SELECT side, arm, propensity, shadow_band, answer, skipped FROM checkin WHERE created_at >= ? AND created_at < ? LIMIT 1000`).all(c.from, c.to) as Row[];
  yield asked.length;
  /** The weighted share of `yes` among the random half's answers that `of` keeps. */
  const ips = (of: (r: Row) => boolean, yes: (r: Row) => boolean) => {
    const rs = asked.filter((r) => r.arm === 'random' && r.answer && r.propensity > 0 && of(r));
    const w = rs.reduce((s, r) => s + 1 / r.propensity, 0);
    const y = rs.filter(yes).reduce((s, r) => s + 1 / r.propensity, 0);
    return { value: rs.length ? Math.round((y / w) * 1000) / 1000 : null, n: rs.length };
  };
  const out: ScoreRow[] = [];
  const put = (k: string, x: { value: number | null; n: number }) => out.push(row(c.day, k, x.value, x.n));
  const sounded = (r: Row) => r.side === 'sounded';
  put('attn.worth', ips(sounded, (r) => r.answer === 'worth'));
  put('attn.worth_shadow', ips((r) => sounded(r) && r.shadow_band === 'sound', (r) => r.answer === 'worth'));
  put('attn.could_wait', ips(sounded, (r) => r.answer === 'could_wait'));
  put('attn.shouldnt', ips(sounded, (r) => r.answer === 'shouldnt'));
  put('attn.missed', ips((r) => r.side === 'quiet', (r) => r.answer === 'sooner'));
  put('foryou.worth', ips((r) => r.side === 'foryou', (r) => r.answer === 'glad'));
  const shown = asked.filter((r) => r.side !== 'foryou');
  out.push(row(c.day, 'attn.asked', shown.length, shown.length, { answered: shown.filter((r) => r.answer).length, skipped: shown.filter((r) => r.skipped).length }));
  // The loudness beside the tiers, on the day's decisions about others' messages.
  const self = c.self.length ? c.self : [''];
  const ph = self.map(() => '?').join(',');
  const ds = c.db
    .query(
      `SELECT t.decision, t.loud, EXISTS (SELECT 1 FROM message o WHERE o.conversation_id = m.conversation_id AND o.ts > m.ts AND o.ts <= m.ts + ${30 * MIN} AND o.author_id IN (${ph})) AS quick
       FROM triage t INDEXED BY triage_created JOIN message m ON m.id = t.message_id
       WHERE t.created_at >= ? AND t.created_at < ? AND t.loud IS NOT NULL AND t.decision != 'silent' LIMIT 200000`,
    )
    .all(...self, c.from, c.to) as Row[];
  yield ds.length;
  const band = (l: number) => (l >= 80 ? 'sound' : l >= 55 ? 'show' : l >= 30 ? 'next' : l >= 10 ? 'inbox' : 'unread');
  const tierBand: Record<string, string> = { push: 'sound', quiet: 'show', digest: 'inbox', drop: 'unread' };
  const sounds = ds.filter((r) => r.loud >= 80).length;
  out.push(row(c.day, 'shadow.sounds', ds.length ? sounds : null, ds.length, { live: ds.filter((r) => r.decision === 'push').length }));
  const agree = ds.filter((r) => band(r.loud) === tierBand[r.decision] || (band(r.loud) === 'next' && r.decision === 'digest')).length;
  out.push(row(c.day, 'shadow.agree', share(agree, ds.length), ds.length));
  const quick = ds.filter((r) => r.quick);
  out.push(row(c.day, 'shadow.quick_show', share(quick.filter((r) => r.loud >= 55).length, quick.length), quick.length));
  out.push(row(c.day, 'shadow.quick_show_live', share(quick.filter((r) => r.decision === 'push' || r.decision === 'quiet').length, quick.length), quick.length));
  return out;
}

// ---------------------------------------------------------------- the cost side: attention and people

/** Phones, by the label their page or app gave (delivery.ts): every other device is a computer. */
const isPhone = (label: unknown) => PHONE.test(typeof label === 'string' ? label : '');
/** An app open is a stay that begins this long after every earlier one on any device ended. */
const LOOK_GAP = 10 * MIN;
/** Notifications are read this much at a time: a noisy day sends over a thousand. */
const NOTICE_WINDOW = 2 * HOUR;
/** Spans of a month are read this much at a time. */
const SPAN_WINDOW = 5 * DAY;
/** A reply owed for longer than this is long owed. */
const LONG_OWED = 3 * DAY;
/** Turns begun longer ago than this are left out of what is owed: they ran out long since. */
export const OWED_LOOKBACK = 30 * DAY;
/** Who you talk with: the people you wrote to in this long, against the same span before it. */
const BREADTH_SPAN = 30 * DAY;
/** People only: a DM, or a group of at most this many, you included (attention.ts SMALL_GROUP). */
const PEOPLE_GROUP = 6;

/**
 * A conversation with people, for the people metrics: a DM, or a group of six or fewer, on a network of people.
 * Not channels, threads, feeds, mail (its threads are not conversations), a calendar or an agent's threads.
 */
export const PEOPLE_SQL = (c: string) =>
  `(${c}.network NOT IN ('calendar', 't3') AND (${c}.shape = 'direct' OR (${c}.shape = 'group' AND (SELECT COUNT(*) FROM participant pp WHERE pp.conversation_id = ${c}.id) BETWEEN 1 AND ${PEOPLE_GROUP})))`;

const hasColumn = (db: Database, table: string, col: string) => (db.query(`PRAGMA table_info(${table})`).all() as Row[]).some((r) => r.name === col);
const hasTable = (db: Database, name: string) => !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

/** A sorted list's quantile (nearest rank), or null of nothing. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Stays on a computer with the app in use, within [a, b): [start, end] each. */
function computerStays(db: Database, a: number, b: number): [number, number][] {
  return (db.query(`SELECT start_at AS s, end_at AS e, device_label AS label FROM visit WHERE start_at >= ? AND start_at < ? AND end_at >= ? AND active > 0 LIMIT 20000`).all(a - DAY, b, a) as Row[])
    .filter((r) => !isPhone(r.label))
    .map((r) => [r.s, r.e]);
}

/**
 * Sounds a day (docs/scorecard.md, "The cost side"): notifications a push server took that sounded where they went,
 * an alert's first push in a burst or a ring, as the hub kept it (`notification.alert`). Before that was kept, the
 * hub's own rule is played back over the log (delivery.ts): an alert sounds when it is the first push about its chat in
 * five minutes, follows only silent ones, or is to you, and not while a computer was in use in the two minutes before;
 * a ring and quiet hours' summary sound. Also per hour a computer was in use: the sounds in clock hours in which one
 * was, over those hours.
 */
function* sounds(c: DayContext): Generator<number, ScoreRow[]> {
  const alertCol = hasColumn(c.db, 'notification', 'alert') ? 'n.alert' : 'NULL';
  const q = c.db.query(
    `SELECT n.kind, n.conversation_id AS conv, n.sent_at AS at, ${alertCol} AS alert, COALESCE(n.accepted, 1) AS accepted, t.decision, m.mentions_self AS me
     FROM notification n LEFT JOIN triage t ON t.message_id = n.message_id LEFT JOIN message m ON m.id = n.message_id
     WHERE n.sent_at >= ? AND n.sent_at < ? ORDER BY n.sent_at LIMIT 50000`,
  );
  const rows: Row[] = [];
  for (let w = c.from - BURST_MS; w < c.to; w += NOTICE_WINDOW) {
    const part = q.all(w, Math.min(w + NOTICE_WINDOW, c.to)) as Row[];
    rows.push(...part);
    yield part.length + 1;
  }
  const stays = computerStays(c.db, c.from - ACTIVE_MS, c.to);
  yield stays.length;
  const atComputer = (t: number) => stays.some(([s, e]) => s <= t && e >= t - ACTIVE_MS);
  const hours = new Set<number>();
  for (const [s, e] of stays) for (let h = Math.max(0, Math.floor((s - c.from) / HOUR)); h <= Math.floor((Math.min(e, c.to - 1) - c.from) / HOUR); h++) hours.add(h);
  const ORDER: Record<string, number> = { digest: 0, quiet: 1, push: 2 };
  const showing = new Map<string, { at: number; top: string }>();
  let n = 0;
  let sounded = 0;
  let estimated = 0;
  let rings = 0;
  let inHours = 0;
  for (const r of rows) {
    let est = false;
    if (r.kind === 'ring' || r.kind === 'held') est = true;
    else if (r.kind === 'message' && r.conv) {
      const level = r.decision === 'push' || r.decision === 'quiet' || r.decision === 'digest' ? r.decision : 'digest';
      const prev = showing.get(r.conv);
      const fresh = prev && r.at - prev.at < BURST_MS ? prev : undefined;
      est = level === 'push' && (!fresh || fresh.top !== 'push' || !!r.me) && !atComputer(r.at);
      showing.set(r.conv, { at: r.at, top: fresh && ORDER[fresh.top] > ORDER[level] ? fresh.top : level });
    }
    if (r.at < c.from || r.accepted <= 0) continue;
    n++;
    const s = r.alert === null ? est : !!r.alert;
    if (!s) continue;
    sounded++;
    if (r.alert === null) estimated++;
    if (r.kind === 'ring') rings++;
    if (hours.has(Math.floor((r.at - c.from) / HOUR))) inHours++;
  }
  return [row(c.day, 'attn.sounds', sounded, n, { estimated, rings }), row(c.day, 'attn.sounds_computer_hour', hours.size ? inHours / hours.size : null, hours.size, { sounds: inHours })];
}

/**
 * Pushes that came too late to matter, from what the devices report:
 *  - `attn.stale`: of the message notifications a push server took, the share sent while that chat was open on a
 *    computer in use and read past the message there (a stay spanning the push whose read point reached it);
 *  - `attn.stale_shown`: notifications still up on a device after their chat was read on a computer, as far as the
 *    devices say: tapped or swiped away after a stay on a computer read past them. A phone does not report a clear,
 *    and a notification left alone says nothing, so this counts only those you then had to tap or swipe.
 */
function* stale(c: DayContext): Generator<number, ScoreRow[]> {
  const q = c.db.query(
    `SELECT n.conversation_id AS conv, n.sent_at AS at, m.ts, n.visit_id AS visit, MIN(COALESCE(n.tapped_at, n.dismissed_at), COALESCE(n.dismissed_at, n.tapped_at)) AS gone
     FROM notification n LEFT JOIN message m ON m.id = n.message_id
     WHERE n.sent_at >= ? AND n.sent_at < ? AND n.kind = 'message' AND n.conversation_id IS NOT NULL AND COALESCE(n.accepted, 1) > 0 LIMIT 50000`,
  );
  const rows: Row[] = [];
  for (let w = c.from; w < c.to; w += NOTICE_WINDOW) {
    const part = q.all(w, Math.min(w + NOTICE_WINDOW, c.to)) as Row[];
    rows.push(...part);
    yield part.length + 1;
  }
  const reads = new Map<string, Row[]>();
  for (const v of c.db
    .query(
      `SELECT id, conversation_id AS conv, start_at AS s, end_at AS e, COALESCE(read_to_ts, seen_to_ts) AS upTo, device_label AS label FROM visit
       WHERE start_at >= ? AND start_at < ? AND end_at >= ? AND conversation_id IS NOT NULL AND active > 0 LIMIT 50000`,
    )
    .all(c.from - DAY, c.to + FORGET_MS, c.from) as Row[]) {
    if (isPhone(v.label)) continue;
    const a = reads.get(v.conv);
    if (a) a.push(v);
    else reads.set(v.conv, [v]);
  }
  yield reads.size;
  let staleN = 0;
  let swiped = 0;
  let lingered = 0;
  for (const r of rows) {
    const vs = reads.get(r.conv) ?? [];
    const ts = r.ts ?? r.at;
    if (vs.some((v) => v.s <= r.at && v.e >= r.at && (r.ts === null || (v.upTo ?? 0) >= ts))) staleN++;
    if (r.gone === null) continue;
    swiped++;
    if (vs.some((v) => v.id !== r.visit && v.s > r.at && v.s < r.gone && (v.upTo ?? 0) >= ts)) lingered++;
  }
  return [row(c.day, 'attn.stale', share(staleN, rows.length), rows.length, { stale: staleN }), row(c.day, 'attn.stale_shown', lingered, swiped)];
}

/**
 * Checks with nothing new: app opens (a stay on any device that begins ten minutes or more after every earlier one
 * ended) with nothing at the list or above since the last look (no chat message triage put on the list, in a
 * Conversation or alerted, and no such mail, in between).
 */
function* checks(c: DayContext): Generator<number, ScoreRow[]> {
  const stays = c.db.query(`SELECT start_at AS s, end_at AS e FROM visit WHERE start_at >= ? AND start_at < ? AND active > 0 ORDER BY start_at LIMIT 50000`).all(c.from - DAY, c.to) as Row[];
  yield stays.length;
  // On the time index (`+decision`): by tier, SQLite would walk every list row there is.
  const chat = c.db.query(`SELECT 1 FROM triage WHERE created_at > ? AND created_at <= ? AND +decision IN ('push', 'quiet', 'digest') LIMIT 1`);
  const mail = hasTable(c.db, 'mail_triage') ? c.db.query(`SELECT 1 FROM mail_triage WHERE created_at > ? AND created_at <= ? AND +decision IN ('push', 'quiet', 'digest') LIMIT 1`) : null;
  let lastEnd: number | null = null;
  let opens = 0;
  let empty = 0;
  for (const v of stays) {
    if (v.s >= c.from && lastEnd !== null && v.s - lastEnd >= LOOK_GAP) {
      opens++;
      if (!chat.get(lastEnd, v.s) && !mail?.get(lastEnd, v.s)) empty++;
      yield 1;
    }
    lastEnd = Math.max(lastEnd ?? 0, v.e);
  }
  return [row(c.day, 'attn.checks', empty, opens)];
}

/** Turns answered that day in conversations with people: the median and 90th-percentile wait, in hours. */
function* peopleWait(c: DayContext): Generator<number, ScoreRow[]> {
  const waits = (
    c.db
      .query(
        `SELECT o.answered_at - o.addressed AS wait FROM owed_turn o JOIN conversation c ON c.id = o.conversation_id
         WHERE o.answered_at >= ? AND o.answered_at < ? AND o.timed = 1 AND o.dismissed = 0 AND ${PEOPLE_SQL('c')} LIMIT 50000`,
      )
      .all(c.from, c.to) as Row[]
  )
    .map((r) => Math.max(0, r.wait as number) / HOUR)
    .sort((a, b) => a - b);
  yield waits.length;
  return [row(c.day, 'people.wait', quantile(waits, 0.5), waits.length), row(c.day, 'people.wait_p90', quantile(waits, 0.9), waits.length)];
}

/**
 * Replies owed to people for over 3 days, at the day's end: in each conversation with people, its latest turn begun
 * in the last 30 days, when it began 3 days or more before and was neither answered by then nor marked "No reply
 * needed". The turns still open now are in the fold's state (conv_feature), read once a run.
 */
function* owedLong(c: DayContext): Generator<number, ScoreRow[]> {
  const open = (c.cache.openTurns ??= yield* openTurns(c.db)) as Map<string, number>;
  const latest = new Map<string, { addressed: number; answered: number | null; dismissed: boolean }>();
  const q = c.db.query(
    `SELECT o.conversation_id AS conv, o.addressed, o.answered_at AS answered, o.dismissed FROM owed_turn o JOIN conversation c ON c.id = o.conversation_id
     WHERE o.addressed >= ? AND o.addressed < ? AND ${PEOPLE_SQL('c')} LIMIT 50000`,
  );
  const rows: Row[] = [];
  for (let w = c.to - OWED_LOOKBACK; w <= c.to; w += SPAN_WINDOW) {
    const part = q.all(w, Math.min(w + SPAN_WINDOW, c.to + 1)) as Row[];
    rows.push(...part);
    yield part.length + 1;
  }
  for (const r of rows) {
    const l = latest.get(r.conv);
    if (!l || r.addressed > l.addressed) latest.set(r.conv, { addressed: r.addressed, answered: r.answered, dismissed: !!r.dismissed });
  }
  for (const [conv, addressed] of open) {
    if (addressed < c.to - OWED_LOOKBACK || addressed > c.to) continue;
    const l = latest.get(conv);
    if (!l || addressed > l.addressed) latest.set(conv, { addressed, answered: null, dismissed: false });
  }
  let owed = 0;
  for (const l of latest.values()) if (l.addressed <= c.to - LONG_OWED && !l.dismissed && (l.answered === null || l.answered > c.to)) owed++;
  return [row(c.day, 'people.owed_3d', owed, latest.size)];
}

/** The turns open now, in conversations with people: when each began, by conversation. Read in pages. */
function* openTurns(db: Database): Generator<number, Map<string, number>> {
  const out = new Map<string, number>();
  const page = db.query(
    `SELECT f.conversation_id AS conv, json_extract(f.state, '$.turn.addressed') AS addressed FROM conv_feature f JOIN conversation c ON c.id = f.conversation_id
     WHERE f.conversation_id > ? AND ${PEOPLE_SQL('c')} ORDER BY f.conversation_id LIMIT 300`,
  );
  let after = '';
  for (;;) {
    const rows = page.all(after) as Row[];
    for (const r of rows) if (typeof r.addressed === 'number') out.set(r.conv, r.addressed);
    yield rows.length + 1;
    if (rows.length < 300) return out;
    after = rows[rows.length - 1].conv;
  }
}

/** The people you wrote to in [a, b): in conversations with people you wrote in then, everyone else there but bots. */
function* peopleWritten(db: Database, self: readonly string[], a: number, b: number): Generator<number, Set<string>> {
  const out = new Set<string>();
  if (!self.length) return out;
  const convs = new Set<string>();
  const mine = db.query(`SELECT DISTINCT conversation_id AS conv FROM message WHERE author_id = ? AND ts >= ? AND ts < ? LIMIT 20000`);
  for (const id of self)
    for (let w = a; w < b; w += SPAN_WINDOW) {
      const rows = mine.all(id, w, Math.min(w + SPAN_WINDOW, b)) as Row[];
      for (const r of rows) convs.add(r.conv);
      yield rows.length + 1;
    }
  const selfSet = new Set(self);
  const people = db.query(
    `SELECT i.id, i.person_id AS person FROM conversation c JOIN participant p ON p.conversation_id = c.id JOIN identity i ON i.id = p.identity_id
     WHERE c.id = ? AND i.is_bot = 0 AND ${PEOPLE_SQL('c')}`,
  );
  const selfPerson = db.query(`SELECT 1 FROM person WHERE id = ? AND is_self = 1`);
  for (const conv of convs) {
    const rows = people.all(conv) as Row[];
    for (const r of rows) if (!selfSet.has(r.id) && !(r.person && selfPerson.get(r.person))) out.add(r.person ?? r.id);
    yield rows.length + 1;
  }
  return out;
}

/** Who you talk with: how many people you wrote to in the 30 days to the day's end, and in the 30 before. */
function* breadth(c: DayContext): Generator<number, ScoreRow[]> {
  const recent = yield* peopleWritten(c.db, c.self, c.to - BREADTH_SPAN, c.to);
  const before = yield* peopleWritten(c.db, c.self, c.to - 2 * BREADTH_SPAN, c.to - BREADTH_SPAN);
  const both = [...recent].filter((p) => before.has(p)).length;
  return [row(c.day, 'people.breadth', recent.size, recent.size, { kept: both }), row(c.day, 'people.breadth_before', before.size, before.size)];
}

const SCORERS: DayScorer[] = [notified, decisions, unprompted, inbox, needsReply, foryou, sounds, stale, checks, peopleWait, owedLong, breadth, loudnessScores];

/**
 * Your identities: what you wrote is by one of these. As interact.ts SELF_SQL, but on identity's person index: SQLite
 * plans SELF_SQL's join as a scan of every identity (60 ms on a real hub).
 */
export function selfIds(db: Database): string[] {
  return (db.query(`SELECT self_identity AS id FROM account WHERE self_identity IS NOT NULL UNION SELECT id FROM identity WHERE person_id IN (SELECT id FROM person WHERE is_self = 1)`).all() as Row[]).map((r) => r.id);
}

/** Score one day with every scorer. Reads only. */
function* scoreDay(db: Database, day: string, self = selfIds(db), scorers: DayScorer[] = SCORERS, cache: Record<string, unknown> = {}): Generator<number, ScoreRow[]> {
  const [from, to] = dayBounds(day);
  const opens = new OpenIndex();
  const vs = db.query(`SELECT conversation_id AS conv, start_at AS at FROM visit WHERE start_at >= ? AND start_at < ? AND conversation_id IS NOT NULL AND active >= ? LIMIT 100000`).all(from, to + MATURE_AFTER, OPEN_DWELL) as Row[];
  for (const v of vs) opens.add(v.conv, v.at);
  opens.seal();
  yield vs.length;
  const ctx: DayContext = { db, day, from, to, self, opens, cache };
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
  const cache = {};
  const out: ScoreRow[] = [];
  for (const d of maturedDays(db, now)) out.push(...(yield* scoreDay(db, d, self, scorers, cache)));
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
    const cache = {};
    for (const d of maturedDays(db, now)) {
      if (have.has(d)) continue;
      const rows = yield* scoreDay(db, d, self, this.scorers, cache);
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
        ['inbox.mrr_live', i < 12 ? null : clamp(0.45 + 0.03 * wob(i, 22)), i < 12 ? 0 : 15 + (i % 10)],
        ['inbox.mrr_shadow', i < 12 ? null : clamp(0.38 + 0.08 * t + 0.03 * wob(i, 23)), i < 12 ? 0 : 15 + (i % 10)],
        ['inbox.mail_mrr', i < 12 ? null : clamp(0.3 + 0.05 * wob(i, 24)), i < 12 ? 0 : 2 + (i % 4)],
        ['inbox.mail_mrr_shadow', i < 12 ? null : clamp(0.32 + 0.1 * t + 0.05 * wob(i, 25)), i < 12 ? 0 : 2 + (i % 4)],
        ['needs.predicted', clamp(0.7 + 0.04 * wob(i, 18)), 30 + (i % 12)],
        ['needs.answered', clamp(0.74 - 0.03 * t + 0.08 * wob(i, 19)), 30 + (i % 12)],
        ['needs.brier', clamp(0.17 - 0.03 * t + 0.02 * wob(i, 20)), 30 + (i % 12)],
        ['needs.brier_table', clamp(0.19 + 0.02 * wob(i, 21)), 30 + (i % 12)],
        ['foryou.clicked', i < 10 ? null : clamp(0.08 + 0.06 * t + 0.03 * wob(i, 18)), i < 10 ? 0 : 30 + ((i * 5) % 25)],
        ['foryou.clicked_explore', i < 10 ? null : clamp(0.05 + 0.04 * t + 0.04 * wob(i, 19)), i < 10 ? 0 : 6 + (i % 5)],
        ['attn.sounds', Math.max(0, Math.round(5 - 2.5 * t + 2.5 * wob(i, 26))), 140 + ((i * 17) % 60)],
        ['attn.sounds_computer_hour', Math.max(0, 0.3 - 0.15 * t + 0.1 * wob(i, 27)), 4 + (i % 5)],
        ['attn.stale', clamp(0.08 - 0.03 * t + 0.02 * wob(i, 28)), 140 + ((i * 17) % 60)],
        ['attn.stale_shown', Math.max(0, Math.round(3 - t + wob(i, 29))), 10 + (i % 6)],
        ['attn.checks', Math.max(0, Math.round(6 - 2 * t + 2 * wob(i, 30))), 14 + (i % 7)],
        ['people.wait', Math.max(0.1, 4.4 - 1.3 * t + 0.8 * wob(i, 31)), 6 + (i % 5)],
        ['people.wait_p90', Math.max(1, 20 - 4 * t + 5 * wob(i, 32)), 6 + (i % 5)],
        ['people.owed_3d', Math.max(0, Math.round(3 - t + wob(i, 33))), 9 + (i % 4)],
        ['people.breadth', 24 + Math.round(2 * wob(i, 34) - 2 * t), 24],
        ['people.breadth_before', 26 + Math.round(wob(i, 35)), 26],
        // The loudness scale: asked from the second week, its shadow from the start.
        ['foryou.worth', i < 7 ? null : clamp(0.55 + 0.1 * t + 0.1 * wob(i, 26)), i < 7 ? 0 : 1],
        ['attn.worth', i < 7 ? null : clamp(0.6 + 0.15 * t + 0.1 * wob(i, 27)), i < 7 ? 0 : 1 + (i % 2)],
        ['attn.worth_shadow', i < 7 ? null : clamp(0.65 + 0.15 * t + 0.1 * wob(i, 28)), i < 7 ? 0 : 1],
        ['attn.could_wait', i < 7 ? null : clamp(0.3 - 0.15 * t + 0.08 * wob(i, 29)), i < 7 ? 0 : 1 + (i % 2)],
        ['attn.shouldnt', i < 7 ? null : clamp(0.1 - 0.05 * t + 0.04 * wob(i, 30)), i < 7 ? 0 : 1 + (i % 2)],
        ['attn.missed', i < 7 ? null : clamp(0.12 - 0.04 * t + 0.05 * wob(i, 31)), i < 7 ? 0 : 1],
        ['attn.asked', i < 7 ? 0 : 2 + (i % 2), i < 7 ? 0 : 2 + (i % 2)],
        ['shadow.sounds', Math.max(0, Math.round(6 - 2 * t + 2 * wob(i, 32))), 900 + ((i * 37) % 300)],
        ['shadow.agree', clamp(0.8 + 0.03 * wob(i, 33)), 900 + ((i * 37) % 300)],
        ['shadow.quick_show', clamp(0.93 + 0.03 * wob(i, 34)), 20 + (i % 9)],
        ['shadow.quick_show_live', clamp(0.9 + 0.03 * wob(i, 35)), 20 + (i % 9)],
      ];
      for (const [m, value, n] of v) put.run(day, m, value, n, now);
    }
  })();
}
