/**
 * Reply habits as decayed counts (docs/inbox.md): turns addressed to you, how many you answered in time, how fast.
 * Its own module, so the owed table (owed.ts) and the inbox's score (attention.ts) both build on it without importing
 * each other (docs/testing.md "Import cycles"); attention.ts re-exports it.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Message rates and reply habits lose half their weight in a month: what you do now, with enough history to mean it. */
export const FEATURE_HALF_LIFE = 30 * DAY;
/** A reply later than this did not answer the message; it counts as unanswered. */
export const REPLY_WINDOW = 3 * DAY;
/** Reply latency histogram: bucket i counts replies within LATENCY_EDGES[i] and after the edge before it. */
export const LATENCY_EDGES = [5 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR, DAY, 2 * DAY, REPLY_WINDOW];

/** Turns addressed to you, how many you answered in time, and how fast. Decayed sums as of `at`. */
export interface Tally {
  at: number;
  addressed: number;
  replied: number;
  latency: number[];
  /** Turns you marked "No reply needed": not addressed, not answered, counted apart (replymarks.ts). */
  dismissed?: number;
}
export const emptyTally = (): Tally => ({ at: 0, addressed: 0, replied: 0, latency: LATENCY_EDGES.map(() => 0) });

export const toward = (from: number, to: number) => 2 ** (-(to - from) / FEATURE_HALF_LIFE);

const bucketOf = (latency: number) => {
  const i = LATENCY_EDGES.findIndex((e) => latency <= e);
  return i < 0 ? LATENCY_EDGES.length - 1 : i;
};

/**
 * Count one addressed turn, answered after `latency` or (null) not at all. Order-independent, like usage.ts. An
 * answer of unknown speed (a reaction, which carries no time) counts as answered but not in the latency histogram.
 * `window`: an answer later than this did not answer (mail's is two weeks: mail/attention.ts); one past the last
 * latency edge counts in the last bucket.
 */
export function record(t: Tally, when: number, latency: number | null, timed = true, window = REPLY_WINDOW) {
  let w = 1;
  if (when >= t.at) decayTo(t, when);
  else w = toward(when, t.at);
  t.addressed += w;
  if (latency !== null && latency <= window) {
    t.replied += w;
    if (timed) t.latency[bucketOf(Math.max(0, latency))] += w;
  }
}

function decayTo(t: Tally, when: number) {
  const f = toward(t.at, when);
  t.addressed *= f;
  t.replied *= f;
  t.latency = t.latency.map((x) => x * f);
  if (t.dismissed) t.dismissed *= f;
  t.at = when;
}

/** Count one turn you marked "No reply needed", at `when`: apart from addressed and answered. */
export function recordDismissed(t: Tally, when: number) {
  if (when >= t.at) {
    decayTo(t, when);
    t.dismissed = (t.dismissed ?? 0) + 1;
  } else t.dismissed = (t.dismissed ?? 0) + toward(when, t.at);
}

/** A tally as seen from `now`. */
export function tallyAt(t: Tally, now: number): Tally {
  const f = toward(t.at, Math.max(now, t.at));
  return { at: Math.max(now, t.at), addressed: t.addressed * f, replied: t.replied * f, latency: t.latency.map((x) => x * f), ...(t.dismissed ? { dismissed: t.dismissed * f } : {}) };
}

export function sumTallies(ts: Tally[], now: number): Tally {
  const out = emptyTally();
  out.at = now;
  for (const t of ts.map((x) => tallyAt(x, now))) {
    out.addressed += t.addressed;
    out.replied += t.replied;
    if (t.dismissed) out.dismissed = (out.dismissed ?? 0) + t.dismissed;
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
