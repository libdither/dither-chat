/**
 * The weekly report of what attention cost (docs/scorecard.md, "The weekly report"): `GET /api/attention/report`, the
 * page "Your attention". Sounds a day, pushes and looks that came to nothing, and the people side: who waits on you,
 * how long they wait, how many people you talk with, and at most one person a week you are drifting from. The days
 * come from the scorecard's rows (scorecard.ts); the waits, what is owed now and the drifting person are read live.
 * No budget: the counts are shown as they are. Ids for the app to name; no names, no text.
 */
import type { Database } from 'bun:sqlite';
import type { AttentionReport, Pair } from '@dither-chat/protocol/scorecard';
import { dayBounds, dayOf, MATURE_AFTER, OWED_LOOKBACK, PEOPLE_SQL, quantile } from './scorecard.ts';

type Row = Record<string, any>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Days drawn. */
const REPORT_DAYS = 14;
/** People waiting on you, listed. */
const WAITING_SHOWN = 8;
/** Drifting: no word in this many weeks, after writing to them in at least DRIFT_WEEKS of the DRIFT_BEFORE weeks before. */
const DRIFT_QUIET = 4;
const DRIFT_BEFORE = 12;
const DRIFT_WEEKS = 4;

/** What the report needs from the inbox: the replies owed now (attention.ts). */
interface ReportDeps {
  owed(): { id: string; kind?: 'mail'; owedSince: number | null; needsReply?: number }[];
  self(): string[];
}

/** Local midnight of the Monday of `t`'s week: the drifting person is chosen from there, once a week. */
export function weekStart(t: number): number {
  const d = new Date(t);
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number | null, k = 100) => (x === null ? null : Math.round(x * k) / k);

export function attentionReport(db: Database, deps: ReportDeps, now = Date.now()): AttentionReport {
  // The scorecard's days: the last REPORT_DAYS scored.
  const rows = db
    .query(
      `SELECT day, metric, value, n FROM model_score WHERE day >= ? AND metric IN ('attn.sounds', 'attn.sounds_computer_hour', 'attn.stale', 'attn.checks', 'attn.stale_shown', 'people.owed_3d', 'people.breadth', 'people.breadth_before') ORDER BY day`,
    )
    .all(dayOf(now - (REPORT_DAYS + 3) * DAY)) as Row[];
  const days = [...new Set(rows.map((r) => r.day as string))].sort().slice(-REPORT_DAYS);
  const at = new Map(days.map((d, i) => [d, i]));
  const series = (metric: string) => {
    const v: (number | null)[] = days.map(() => null);
    const n: number[] = days.map(() => 0);
    for (const r of rows) {
      const i = at.get(r.day);
      if (r.metric !== metric || i === undefined) continue;
      v[i] = r.value;
      n[i] = r.n;
    }
    return { v, n };
  };
  const half = (s: { v: (number | null)[]; n: number[] }, how: 'mean' | 'sum' | 'share'): Pair => {
    const part = (lo: number, hi: number) => {
      const idx = [...Array(days.length).keys()].filter((i) => i >= lo && i < hi && s.v[i] !== null);
      if (!idx.length) return null;
      if (how === 'sum') return idx.reduce((a, i) => a + s.v[i]!, 0);
      if (how === 'mean') return mean(idx.map((i) => s.v[i]!));
      const w = idx.reduce((a, i) => a + s.n[i], 0);
      return w ? idx.reduce((a, i) => a + s.v[i]! * s.n[i], 0) / w : null;
    };
    const end = days.length;
    return { recent: round(part(end - 7, end), 1000), before: round(part(end - 14, end - 7), 1000) };
  };
  const sounds = series('attn.sounds');
  const owed = series('people.owed_3d');
  const lastOf = (s: { v: (number | null)[] }, back = 0) => s.v[days.length - 1 - back] ?? null;
  const breadth = series('people.breadth');
  const breadthBefore = series('people.breadth_before');

  // How long people waited for your replies, this week and the week before, read live: medians do not add up by day.
  const waits = (a: number, b: number) =>
    (
      db
        .query(
          `SELECT o.answered_at - o.addressed AS w FROM owed_turn o JOIN conversation c ON c.id = o.conversation_id
           WHERE o.answered_at >= ? AND o.answered_at < ? AND o.timed = 1 AND o.dismissed = 0 AND ${PEOPLE_SQL('c')} LIMIT 20000`,
        )
        .all(a, b) as Row[]
    )
      .map((r) => Math.max(0, r.w) / HOUR)
      .sort((x, y) => x - y);
  const thisWeek = waits(now - WEEK, now);
  const lastWeek = waits(now - 2 * WEEK, now - WEEK);

  // Who waits on you now: people only, begun in the last 30 days (older turns ran out long since), the longest waiting first.
  const isPeople = db.query(`SELECT 1 FROM conversation c WHERE c.id = ? AND ${PEOPLE_SQL('c')}`);
  const waiting = deps
    .owed()
    .filter((a) => a.kind !== 'mail' && a.owedSince !== null && a.owedSince >= now - OWED_LOOKBACK && isPeople.get(a.id))
    .sort((a, b) => a.owedSince! - b.owedSince!)
    .map((a) => ({ conversationId: a.id, since: a.owedSince!, needs: a.needsReply ?? null }));

  return {
    days,
    pending: pendingDay(now),
    sounds: sounds.v,
    soundsComputerHour: series('attn.sounds_computer_hour').v.map((x) => round(x)),
    week: {
      sounds: half(sounds, 'mean'),
      stale: half(series('attn.stale'), 'share'),
      checks: half(series('attn.checks'), 'sum'),
      staleShown: half(series('attn.stale_shown'), 'sum'),
      wait: { recent: round(quantile(thisWeek, 0.5)), before: round(quantile(lastWeek, 0.5)) },
      waitP90: { recent: round(quantile(thisWeek, 0.9)), before: round(quantile(lastWeek, 0.9)) },
      owed3d: { recent: lastOf(owed), before: days.length > 7 ? lastOf(owed, 7) : null },
      breadth: { recent: lastOf(breadth), before: lastOf(breadthBefore) },
    },
    waiting: waiting.slice(0, WAITING_SHOWN),
    waitingTotal: waiting.length,
    drifting: drifting(db, deps.self(), weekStart(now)),
  };
}

/** The newest day whose end has passed but whose outcomes are not all in yet (scorecard.ts view), or null. */
function pendingDay(now: number): string | null {
  const last = dayOf(now - DAY);
  return dayBounds(last)[1] + MATURE_AFTER > now ? last : null;
}

/**
 * At most one person you are drifting from, chosen from the week's Monday so it stays the same all week: someone you
 * wrote to (in a DM or a group of six or fewer) in at least 4 of the 12 weeks before the last 4, with no message either
 * way in any of those conversations since. The one with the most such weeks, then the most recent.
 */
export function drifting(db: Database, self: readonly string[], anchor: number): AttentionReport['drifting'] {
  if (!self.length) return null;
  const from = anchor - (DRIFT_QUIET + DRIFT_BEFORE) * WEEK;
  const quietFrom = anchor - DRIFT_QUIET * WEEK;
  const weeksByConv = new Map<string, Set<number>>();
  const mine = db.query(`SELECT conversation_id AS conv, ts FROM message WHERE author_id = ? AND ts >= ? AND ts < ? LIMIT 50000`);
  for (const id of self)
    for (const r of mine.all(id, from, quietFrom) as Row[]) {
      const w = Math.floor((r.ts - from) / WEEK);
      const s = weeksByConv.get(r.conv);
      if (s) s.add(w);
      else weeksByConv.set(r.conv, new Set([w]));
    }
  const selfSet = new Set(self);
  const people = db.query(
    `SELECT i.id, i.person_id AS person, c.shape, c.last_message_at AS last FROM conversation c JOIN participant p ON p.conversation_id = c.id JOIN identity i ON i.id = p.identity_id
     WHERE c.id = ? AND i.is_bot = 0 AND ${PEOPLE_SQL('c')}`,
  );
  const selfPerson = db.query(`SELECT 1 FROM person WHERE id = ? AND is_self = 1`);
  const by = new Map<string, { personId: string | null; identityId: string; weeks: Set<number>; last: number; dm: string | null; convs: string[] }>();
  for (const [conv, weeks] of weeksByConv)
    for (const r of people.all(conv) as Row[]) {
      if (selfSet.has(r.id) || (r.person && selfPerson.get(r.person))) continue;
      const key = r.person ?? r.id;
      const p = by.get(key) ?? { personId: r.person ?? null, identityId: r.id, weeks: new Set<number>(), last: 0, dm: null, convs: [] as string[] };
      for (const w of weeks) p.weeks.add(w);
      p.last = Math.max(p.last, r.last ?? 0);
      if (r.shape === 'direct') p.dm = conv;
      p.convs.push(conv);
      by.set(key, p);
    }
  let best: { personId: string | null; identityId: string; conversationId: string | null; lastAt: number; weeks: number } | null = null;
  for (const p of by.values()) {
    if (p.weeks.size < DRIFT_WEEKS || p.last >= quietFrom) continue;
    if (!best || p.weeks.size > best.weeks || (p.weeks.size === best.weeks && p.last > best.lastAt)) best = { personId: p.personId, identityId: p.identityId, conversationId: p.dm ?? p.convs[0] ?? null, lastAt: p.last, weeks: p.weeks.size };
  }
  return best;
}
