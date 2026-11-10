/**
 * Shadow mode and safe exploration (docs/notifications.md, docs/research/notification-design.md §4 and §6).
 *
 * Shadow: a candidate model (votes.ts) predicts next to the live one for every decision, and its chances are kept
 * (`triage.shadow`); it never decides. How it sorts (the web app's model page) says what it would have done differently.
 *
 * Exploration, behind DITHER_TRIAGE_EXPLORE=1 and only ever silent:
 *  - up: with probability 2%, at most 3 a day, a Digest or Not-interesting message whose Active chance is just under
 *    the threshold becomes Active (a silent notification), asking whether it was worth it. The live model or the
 *    shadow's chance may put it there: the live one, learned from a handful of votes, puts almost nothing there;
 *    the replay found none a day with it, about nine with the shadow (docs/triage-replay.md);
 *  - down: in a conversation with 10 or more pings a day, 5% of Important ones become Active, at most once there a
 *    day, to measure what the buzz itself is worth.
 * Each logs `explore` and the chance of what was done (`propensity`), so off-policy estimates are possible later.
 * Never in a place set to Nothing, during quiet hours, for starred people or keywords, for a mention of you or a
 * reply to you, or for a DM's first message after a lull.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { THRESHOLDS, type Facts, type Level } from './learn.ts';
import { LULL } from './labels.ts';
import { SELF_SQL } from './interact.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const EXPLORE = {
  /** Chance of trying one up, when it may be. */
  up: 0.02,
  upPerDay: 3,
  /** Active chance from which a message below the threshold may be tried as Active. */
  upBand: 0.25,
  /** Chance of holding an Important one to Active, where it may be. */
  down: 0.05,
  /** Pings a day a conversation needs before one is held. */
  downBusy: 10,
};

export const EXPLORE_UP_REASON = 'Trying this one as Active: worth it? Vote it up or down';
export const EXPLORE_DOWN_REASON = 'Held to a silent notification this once, to learn what the buzz is worth';

export interface ExploreContext {
  level: Level;
  probs: P.TriageProbs;
  /** The shadow model's chances, if it ran. */
  shadow?: P.TriageProbs;
  facts: Facts;
  /** From a starred person, or matched a keyword. */
  starred: boolean;
  keyword: boolean;
  quietHours: boolean;
  /** A DM's first message after a lull. */
  dmAfterLull: boolean;
  /** Only ever upward (DITHER_TRIAGE_EXPLORE=up): no Important message is held to Active. */
  upOnly?: boolean;
  /** Tried up in the last day, anywhere. */
  upToday: number;
  /** Pings in this conversation in the last day, and whether one was already held here. */
  pingsHere: number;
  heldHere: boolean;
}

export interface Explored {
  level: Level;
  explore: 'up' | 'down' | null;
  /** The chance of what was done, when it was a draw; null when nothing was drawn. */
  propensity: number | null;
}

/** May this message be explored at all? */
export function explorable(c: Pick<ExploreContext, 'facts' | 'starred' | 'keyword' | 'quietHours' | 'dmAfterLull'>): boolean {
  return !c.quietHours && !c.starred && !c.keyword && !c.facts.mention && !c.facts.reply && !c.dmAfterLull;
}

/** The draw: what to do with one decision, and with what chance. `rng` is Math.random but for tests. */
export function explore(c: ExploreContext, rng: () => number = Math.random): Explored {
  const none: Explored = { level: c.level, explore: null, propensity: null };
  if (!explorable(c)) return none;
  const near = (p?: P.TriageProbs) => !!p && p.active >= EXPLORE.upBand && p.active < THRESHOLDS.active;
  if ((c.level === 'digest' || c.level === 'drop') && (near(c.probs) || near(c.shadow)) && c.upToday < EXPLORE.upPerDay) {
    return rng() < EXPLORE.up ? { level: 'quiet', explore: 'up', propensity: EXPLORE.up } : { level: c.level, explore: null, propensity: 1 - EXPLORE.up };
  }
  if (c.level === 'push' && !c.upOnly && c.pingsHere >= EXPLORE.downBusy && !c.heldHere) {
    return rng() < EXPLORE.down ? { level: 'quiet', explore: 'down', propensity: EXPLORE.down } : { level: c.level, explore: null, propensity: 1 - EXPLORE.down };
  }
  return none;
}

/** What exploration needs from the database about a message about to be decided. */
export function exploreCounts(db: Database, conversationId: string, shape: string, ts: number, now: number) {
  const upToday = (db.query(`SELECT COUNT(*) AS n FROM triage WHERE explore = 'up' AND created_at > ?`).get(now - DAY) as { n: number }).n;
  const here = db
    .query(
      `SELECT SUM(t.decision = 'push') AS pings, SUM(t.explore = 'down') AS held FROM message m JOIN triage t ON t.message_id = m.id
       WHERE m.conversation_id = ? AND m.ts > ? AND m.ts <= ?`,
    )
    .get(conversationId, ts - DAY, ts) as { pings: number | null; held: number | null };
  const dmAfterLull = shape === 'direct' && !db.query('SELECT 1 FROM message WHERE conversation_id = ? AND ts < ? AND ts >= ? LIMIT 1').get(conversationId, ts, ts - LULL);
  return { upToday, pingsHere: here.pings ?? 0, heldHere: (here.held ?? 0) > 0, dmAfterLull };
}

// ------------------------------------------------------------------ what the shadow would have done

/** What the shadow model would have done over the last `days`, against what was done (P.TriageShadowView). */
export function shadowSummary(db: Database, now = Date.now(), days = 7): P.TriageShadowView {
  const since = now - days * DAY;
  const QUICK = 15 * MIN;
  const row = db
    .query(
      `SELECT COUNT(*) AS decided,
              SUM(live) AS live, SUM(shadow) AS shadow, SUM(liveQuiet) AS liveQuiet, SUM(shadowQuiet) AS shadowQuiet,
              SUM(CASE WHEN live AND NOT shadow THEN answered END) AS missed,
              SUM(CASE WHEN shadow AND NOT live THEN answered END) AS gained,
              SUM(CASE WHEN live AND shadow THEN answered END) AS both,
              MIN(created_at) AS since,
              SUM(explore = 'up') AS up, SUM(explore = 'down') AS down
       FROM (
         SELECT t.created_at, t.explore,
                t.decision = 'push' AS live, json_extract(t.shadow, '$.ping') >= ? AS shadow,
                t.decision = 'quiet' AS liveQuiet, json_extract(t.shadow, '$.ping') < ? AND json_extract(t.shadow, '$.active') >= ? AS shadowQuiet,
                CASE WHEN t.decision = 'push' OR json_extract(t.shadow, '$.ping') >= ? THEN EXISTS (
                  SELECT 1 FROM message o WHERE o.conversation_id = m.conversation_id AND o.ts > m.ts AND o.ts <= m.ts + ${QUICK} AND o.author_id IN ${SELF_SQL}) END AS answered
         FROM triage t JOIN message m ON m.id = t.message_id
         WHERE t.created_at > ? AND t.shadow IS NOT NULL)`,
    )
    .get(THRESHOLDS.ping, THRESHOLDS.ping, THRESHOLDS.active, THRESHOLDS.ping, since) as Record<string, number | null>;
  const n = (k: string) => row[k] ?? 0;
  return {
    days,
    since: row.since ?? null,
    decided: n('decided'),
    live: { ping: n('live'), active: n('liveQuiet') },
    shadow: { ping: n('shadow'), active: n('shadowQuiet') },
    answered: { both: n('both'), missed: n('missed'), gained: n('gained') },
    explored: { up: n('up'), down: n('down') },
  };
}
