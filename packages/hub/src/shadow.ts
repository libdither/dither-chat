/**
 * Shadow mode (docs/notifications.md): a candidate model (votes.ts) predicts next to the live one for every decision,
 * and its chances are kept (`triage.shadow`); it never decides. How it sorts (the web app's model page) says what it
 * would have done differently.
 *
 * It differs from the live model in what it weighs, not in what it learns from: the interaction features (how often
 * you answer here, how long since you looked) and the content features (embeddings.ts) on top of the rest. So what
 * it would have changed is the list: which messages outside the Conversation tier are important enough for it.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';

const DAY = 24 * 60 * 60_000;

/**
 * What the shadow model would have put on the list over the last `days`, against what was put there, at the list's
 * `level` of importance (P.TriageShadowView). Alerts and Conversations are left out: the shadow has no say in them.
 */
export function shadowSummary(db: Database, level: number, now = Date.now(), days = 7): P.TriageShadowView {
  const row = db
    .query(
      `SELECT COUNT(*) AS decided, SUM(live) AS live, SUM(shadow) AS shadow, SUM(live AND shadow) AS both, MIN(created_at) AS since
       FROM (
         SELECT t.created_at, t.decision = 'digest' AS live, json_extract(t.shadow, '$.important') >= ? AS shadow
         FROM triage t
         WHERE t.created_at > ? AND t.decision IN ('digest', 'drop') AND json_extract(t.shadow, '$.important') IS NOT NULL)`,
    )
    .get(level, now - days * DAY) as Record<string, number | null>;
  const n = (k: string) => row[k] ?? 0;
  return { days, since: row.since ?? null, decided: n('decided'), live: n('live'), shadow: n('shadow'), both: n('both') };
}
