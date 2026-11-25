/**
 * The numbers at the top of the Notification calibration page (docs/notifications.md, "Asking, without nagging"):
 * `GET /api/loudness/calibration`. Sounds a day and the honest shares come from the scorecard's days (scorecard.ts:
 * attn.sounds, attn.worth, attn.missed), as "Your attention" reads them; the counts, the answer delays and the
 * model's calibration (its chance you wanted it, against what you answered) are read from the check-ins themselves.
 * No budget: the sounds are shown as they are.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { brier, reliability } from './calibration.ts';
import { dayOf } from './scorecard.ts';

type Row = Record<string, any>;
const DAY = 86_400_000;
const SPAN = 30 * DAY;
/** Bins of the calibration table: few, the answers are few. */
const BINS = 5;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const hasTable = (db: Database, name: string) => !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

export function calibrationStats(db: Database, now = Date.now()): P.CalibrationStats {
  const from = dayOf(now - SPAN);
  const scored = hasTable(db, 'model_score')
    ? (db.query(`SELECT day, metric, value, n FROM model_score WHERE day >= ? AND metric IN ('attn.sounds', 'attn.worth', 'attn.missed') ORDER BY day`).all(from) as Row[])
    : [];
  const soundDays = scored.filter((r) => r.metric === 'attn.sounds').map((r) => ({ day: r.day as string, n: r.value as number | null }));
  const known = soundDays.filter((d) => d.n !== null).map((d) => d.n as number);
  // The n-weighted mean of a share over the days scored: each day's value stands for its n answers.
  const share = (metric: string) => {
    const rs = scored.filter((r) => r.metric === metric && r.value !== null && r.n > 0);
    const n = rs.reduce((a, r) => a + r.n, 0);
    return { value: n ? Math.round((rs.reduce((a, r) => a + r.value * r.n, 0) / n) * 1000) / 1000 : null, n };
  };
  const rows = hasTable(db, 'checkin')
    ? (db.query(`SELECT c.*, m.ts AS message_ts FROM checkin c LEFT JOIN message m ON m.id = c.message_id WHERE c.created_at >= ? LIMIT 5000`).all(now - SPAN) as Row[])
    : [];
  const answered = rows.filter((r) => r.answer && r.answered_at);
  const count = (a: string) => answered.filter((r) => r.answer === a).length;
  const pending = hasTable(db, 'checkin') ? ((db.query(`SELECT COUNT(*) AS n FROM checkin WHERE answer IS NULL AND skipped = 0 AND expired_at IS NULL`).get() as Row).n as number) : 0;
  // The model's chance you wanted it (want), against your answer: worth it for a sound, wish I'd known sooner for a quiet one.
  const preds = hasTable(db, 'checkin')
    ? (
        db
          .query(
            `SELECT c.answer, json_extract(t.loud_view, '$.parts.want') AS want FROM checkin c JOIN triage t ON t.message_id = c.message_id
             WHERE c.side IN ('sounded', 'quiet') AND c.answer IS NOT NULL ORDER BY c.answered_at DESC LIMIT 2000`,
          )
          .all() as Row[]
      )
        .filter((r) => typeof r.want === 'number')
        .map((r) => ({ p: Math.min(1, Math.max(0, r.want as number)), y: r.answer === 'worth' || r.answer === 'sooner' }))
    : [];
  return {
    sounds: { last7: mean(known.slice(-7)), last30: mean(known), days: soundDays },
    worth: share('attn.worth'),
    missed: share('attn.missed'),
    answers: { worth: count('worth'), couldWait: count('could_wait'), shouldnt: count('shouldnt'), sooner: count('sooner'), fine: count('fine'), glad: count('glad'), not: count('not') },
    pending,
    answered: answered.length,
    skipped: rows.filter((r) => r.skipped).length,
    expired: rows.filter((r) => r.expired_at).length,
    delay: { mean: mean(answered.map((r) => r.answered_at - r.created_at)), median: median(answered.map((r) => r.answered_at - r.created_at)) },
    age: { mean: mean(answered.filter((r) => typeof r.message_ts === 'number').map((r) => r.answered_at - r.message_ts)) },
    calibration: {
      bins: reliability(preds, BINS)
        .filter((b) => b.n)
        .map((b) => ({ lo: b.lo, hi: b.hi, predicted: Math.round(b.predicted * 1000) / 1000, observed: Math.round(b.actual * 1000) / 1000, n: b.n })),
      brier: preds.length ? Math.round(brier(preds) * 1000) / 1000 : null,
      n: preds.length,
    },
  };
}
