/**
 * Time in voice channels, from the voice log (callstate.ts, adversarial `voice` only; docs/people-graph.md "Ties and
 * circles", docs/profile.md "Voice"): each person's stretches in a channel, from the join to the leave, and who was in
 * the same channel at the same time, for how long. Counts and times only.
 *
 * A stretch ends at the person's next logged move (a leave, or a join elsewhere), or now while they are still in the
 * channel. One with no end heard (the log was cleared, or logging was off in between) is left out, and none counts for
 * more than MAX_MS: someone whose leave was missed while the account was away is not in voice for days.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';

type Row = Record<string, any>;

export interface VoiceStretch {
  identityId: string;
  conversationId: string;
  from: number;
  to: number;
  /** Still in the channel (as last heard). */
  open: boolean;
}

/** The longest a stretch counts for. */
export const MAX_MS = 12 * 3600_000;
/** Two people together for less than this, in one go, are not counted: someone passing through. */
const MIN_TOGETHER_MS = 5 * 60_000;
/** A channel with more people in it than this is a crowd, not company (a stage, a big event). */
const CROWD = 25;

/** Whether the voice log is kept: the adversarial switch and the `voice` one (store.retention). */
export function voiceLogged(db: Database): boolean {
  const r = db.query(`SELECT value FROM meta WHERE key = 'retention'`).get() as Row | null;
  if (!r) return false;
  try {
    const v = JSON.parse(r.value);
    return !!v?.adversarial && !!v?.voice;
  } catch {
    return false;
  }
}

const hasTable = (db: Database, name: string) => !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

/**
 * Every stretch in voice that ends after `since`, oldest first. `who`: only these identities' stretches (a profile);
 * otherwise everyone's.
 */
export function voiceStretches(db: Database, now = Date.now(), since = 0, who?: string[]): VoiceStretch[] {
  if (who && !who.length) return [];
  const only = who ? ` AND target_id IN (${who.map(() => '?').join(', ')})` : '';
  const rows = db.query(`SELECT target_id AS i, new, at FROM change_log WHERE target_kind = 'identity' AND field = 'voice'${only} ORDER BY target_id, at, id`).all(...(who ?? [])) as Row[];
  const still = new Set<string>();
  if (hasTable(db, 'voice_member')) for (const r of db.query('SELECT identity_id AS i, conversation_id AS c FROM voice_member').all() as Row[]) still.add(`${r.i} ${r.c}`);
  const out: VoiceStretch[] = [];
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (r.new === null) continue;
    let conv: unknown;
    try {
      conv = JSON.parse(r.new);
    } catch {
      continue;
    }
    if (typeof conv !== 'string') continue;
    const next = rows[k + 1]?.i === r.i ? rows[k + 1] : null;
    const open = !next && still.has(`${r.i} ${conv}`);
    const end = next ? next.at : open ? now : null;
    if (end === null || end <= r.at) continue;
    const to = Math.min(end, r.at + MAX_MS);
    if (to <= since) continue;
    out.push({
      identityId: r.i,
      conversationId: conv,
      from: r.at,
      to,
      open: open && to === end,
    });
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * Each time two people were in a channel together for MIN_TOGETHER_MS or more: who, from when, for how long, and that
 * time shared out over the others in the channel (each moment divided by the people then less one: two alone count it
 * all, a group of five a quarter). Moments with more than CROWD in the channel count for nothing.
 */
export function together(stretches: VoiceStretch[], visit: (a: string, b: string, from: number, ms: number, sharedMs: number) => void) {
  const byConv = new Map<string, VoiceStretch[]>();
  for (const s of stretches) {
    let l = byConv.get(s.conversationId);
    if (!l) byConv.set(s.conversationId, (l = []));
    l.push(s);
  }
  for (const list of byConv.values()) {
    const shared = sharing(list);
    // Sorted by start (voiceStretches); each against the ones still going when it starts.
    const live: VoiceStretch[] = [];
    for (const s of list) {
      for (let k = live.length - 1; k >= 0; k--) if (live[k].to <= s.from) live.splice(k, 1);
      for (const o of live) {
        if (o.identityId === s.identityId) continue;
        // o started first, so their time together starts with s.
        const to = Math.min(o.to, s.to);
        if (to - s.from < MIN_TOGETHER_MS) continue;
        const w = shared(to) - shared(s.from);
        if (w > 0) visit(o.identityId, s.identityId, s.from, to - s.from, w);
      }
      live.push(s);
    }
  }
}

/**
 * A channel's time shared out, added up from its first stretch to `t`: each moment divided by the people in it then
 * less one, crowded moments left out. The difference between two times is what a pair there between them shares.
 */
function sharing(list: VoiceStretch[]): (t: number) => number {
  const ev: [number, number][] = [];
  for (const x of list) ev.push([x.from, 1], [x.to, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const at: number[] = [];
  const sum: number[] = [];
  const per: number[] = [];
  let people = 0;
  let total = 0;
  for (let k = 0; k < ev.length; k++) {
    people += ev[k][1];
    if (k + 1 < ev.length && ev[k + 1][0] === ev[k][0]) continue;
    // From here to the next change, `people` are in it.
    const rate = people >= 2 && people <= CROWD ? 1 / (people - 1) : 0;
    at.push(ev[k][0]);
    sum.push(total);
    per.push(rate);
    if (k + 1 < ev.length) total += (ev[k + 1][0] - ev[k][0]) * rate;
  }
  return (t) => {
    // The last change at or before t.
    let lo = 0;
    let hi = at.length - 1;
    if (hi < 0 || t < at[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (at[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return sum[lo] + (t - at[lo]) * per[lo];
  };
}

const DAY = 86_400_000;

/**
 * A person's voice for their profile (GET /api/persons/:id/voice): their latest stretches, their minutes this month,
 * in the past 30 days and in all, and who they were in voice with most in the past 90 days. Null with the log off.
 */
export function personVoice(db: Database, ids: string[], keyOf: (identityId: string) => string, now = Date.now()): P.PersonVoiceView | null {
  if (!voiceLogged(db) || !ids.length) return null;
  const mine = voiceStretches(db, now, 0, ids);
  const first = mine[0]?.from ?? null;
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const minutes = { month: 0, days30: 0, total: 0 };
  const part = (s: VoiceStretch, from: number) => Math.max(0, s.to - Math.max(s.from, from)) / 60_000;
  for (const s of mine) {
    minutes.total += part(s, 0);
    minutes.month += part(s, monthStart);
    minutes.days30 += part(s, now - 30 * DAY);
  }
  for (const k of ['month', 'days30', 'total'] as const) minutes[k] = Math.round(minutes[k]);
  // Who with: everyone's stretches in the channels they were in, over the past 90 days.
  const since = now - 90 * DAY;
  const convs = new Set(mine.filter((s) => s.to > since).map((s) => s.conversationId));
  const self = new Set(ids);
  const mineKey = new Set(ids.map(keyOf));
  const withMs = new Map<string, { identityId: string; ms: number }>();
  if (convs.size) {
    const all = voiceStretches(db, now, since).filter((s) => convs.has(s.conversationId));
    together(all, (a, b, _from, ms) => {
      const other = self.has(a) && !self.has(b) ? b : self.has(b) && !self.has(a) ? a : null;
      if (!other) return;
      const key = keyOf(other);
      if (mineKey.has(key)) return;
      const w = withMs.get(key);
      if (w) w.ms += ms;
      else withMs.set(key, { identityId: other, ms });
    });
  }
  const withList = [...withMs.entries()]
    .map(([key, w]) => ({
      key,
      identityId: w.identityId,
      minutes: Math.round(w.ms / 60_000),
    }))
    .sort((a, b) => b.minutes - a.minutes || a.key.localeCompare(b.key))
    .slice(0, 8);
  const sessions = mine
    .slice(-20)
    .reverse()
    .map((s) => ({
      conversationId: s.conversationId,
      from: s.from,
      to: s.open ? null : s.to,
    }));
  return { since: first, minutes, sessions, with: withList };
}
