/**
 * The inbox replay (docs/inbox.md): replays the activity log in time order and asks, at every moment you opened a
 * conversation, where each ordering would have put the one you opened. Numbers only.
 *
 *   bun scripts/inbox-replay.ts --live ~/path/.data/hub.sqlite --out <scratch dir> [--holdout 2]
 *   bun scripts/inbox-replay.ts --db <scratch dir>/hub-copy.sqlite --out <scratch dir>   (reuse a copy)
 *   bun scripts/inbox-replay.ts ... --grid      (also: the "you were here" weight and half-life)
 *
 * It never opens the live database for writing: it copies it with VACUUM INTO (read-only) and works on the copy. It
 * writes `inbox-replay.md` and `inbox-replay.json` to --out: counts, ranks and rates, never message text, names or ids.
 *
 * The world at each moment is rebuilt from the copy: every listed conversation's features folded up to then
 * (attention.ts's fold), what was unread (messages from others since you last wrote or stayed there), where you had
 * been (the visit log), and the mutes as they are now. Days split in two: the earlier ones for choosing, the last
 * `--holdout` days to report.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decayed, USAGE_HALF_LIFE } from '@dither-chat/protocol';
import { emptyTally, foldMessage, freshState, scoreConversation, sumTallies, WEIGHTS, type ConvState, type ScoreInput, type Tally } from '../packages/hub/src/attention.ts';
import { Store } from '../packages/hub/src/store.ts';
import { Triage } from '../packages/hub/src/triage.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------ options

const argv = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name: string) => argv.includes(`--${name}`);
const outDir = resolve(opt('out', join(import.meta.dir, '..', '.replay'))!);
const holdoutDays = Number(opt('holdout', '2'));
const tzOffset = Number(opt('tz', String(-new Date().getTimezoneOffset() / 60))) * HOUR;
const dayOf = (ts: number) => Math.floor((ts + tzOffset) / DAY);

/** Ids that are you: the accounts' own, and the identities of the person marked as you. */
const SELF_SQL = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL UNION SELECT i.id FROM identity i JOIN person p ON p.id = i.person_id WHERE p.is_self = 1)`;
/** What the inbox always lists (attention.ts LISTED). */
const LISTED = `(c.shape IN ('direct', 'group', 'self') OR (c.shape = 'channel' AND NOT EXISTS (
  SELECT 1 FROM space_edge e WHERE e.child_kind = 'conversation' AND e.child_id = c.id)))`;

function copyLive(): string {
  const given = opt('db');
  if (given) return resolve(given);
  const live = resolve(opt('live', join(import.meta.dir, '..', '.data', 'hub.sqlite'))!);
  if (!existsSync(live)) throw new Error(`no database at ${live}: pass --live <hub.sqlite> or --db <copy>`);
  mkdirSync(outDir, { recursive: true });
  const copy = join(outDir, `hub-copy-${Date.now()}.sqlite`);
  const src = new Database(live, { readonly: true });
  src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  src.close();
  return copy;
}

// ------------------------------------------------------------------ the world, rebuilt

/** One conversation the inbox may list. Never written out. */
export interface Conv {
  id: string;
  shape: ScoreInput['shape'];
  members: number;
  /** Always listed (a DM, group, notes, a room outside a space); else only while it has an unread mention or push. */
  listed: boolean;
  /** The usage key: the person for a DM, else the conversation. */
  usageKey: string;
  muted: string | null;
  state: ConvState;
  lastMessageAt: number | null;
  /** Messages from others, in order: when, a mention of you, pushed. */
  incoming: { ts: number; mention: boolean; pushed: boolean }[];
  /** When you wrote, in order. */
  own: number[];
}

/** One stay in a conversation or with a person, from the log. */
export interface Stay {
  start: number;
  end: number;
  active: number;
  source: string;
  /** Its inbox row's position then, from an inbox row. */
  rank: number | null;
  sent: number;
  /** The usage key it counts for, and the conversations it opens. */
  key: string;
  targets: string[];
}

/** Where you had been by `t`: per usage key, decayed seconds and visits and when you were last there. */
export function usageAt(stays: Stay[], t: number): Map<string, NonNullable<ScoreInput['usage']>> {
  const out = new Map<string, NonNullable<ScoreInput['usage']>>();
  for (const s of stays) {
    if (s.start >= t) break;
    const end = Math.min(s.end, t);
    const seconds = Math.min(s.active, (end - s.start) / 1000 + 60);
    const counted = s.active >= 3;
    const u = out.get(s.key) ?? { score: 0, visitScore: 0, at: end, lastVisit: null };
    const at = Math.max(u.at, end);
    out.set(s.key, {
      score: decayed(u.score, u.at, at) + decayed(seconds, end, at),
      visitScore: decayed(u.visitScore, u.at, at) + (counted ? decayed(1, end, at) : 0),
      at,
      lastVisit: counted ? Math.max(u.lastVisit ?? 0, s.start + 3000) : u.lastVisit,
    });
  }
  return out;
}

/** Everything a policy may look at for one conversation at one moment. */
export interface Seen {
  conv: Conv;
  input: ScoreInput;
  /** When you were last there (from the log), or null. */
  lastThere: number | null;
}

export interface World {
  convs: Map<string, Conv>;
  stays: Stay[];
  /** The first stay in the log: before it, nobody knows where you were. */
  logStart: number;
  /** Tallies per (conversation, author). */
  tallies: Map<string, Map<string, Tally>>;
}

/** The candidates at `t`, as the inbox would have scored them, with everything folded up to `t`. */
export function seenAt(w: World, t: number, usage: Map<string, NonNullable<ScoreInput['usage']>>): Seen[] {
  const out: Seen[] = [];
  for (const c of w.convs.values()) {
    // Folded up to `t` only: a conversation with no messages yet is not in the inbox.
    if (c.lastMessageAt === null) continue;
    const u = usage.get(c.usageKey) ?? null;
    const lastOwn = c.own.length ? c.own[c.own.length - 1] : null;
    const there = u ? Math.max(u.at, u.lastVisit ?? 0) : null;
    // Read up to: your last message, your last stay, or the start of the log (before it, assume caught up).
    const read = Math.max(lastOwn ?? 0, there ?? 0, w.logStart);
    let unread = 0;
    let mentions = 0;
    let pushedUnread = false;
    for (let i = c.incoming.length - 1; i >= 0 && c.incoming[i].ts > read; i--) {
      unread++;
      if (c.incoming[i].mention) mentions++;
      if (c.incoming[i].pushed) pushedUnread = true;
    }
    if (!c.listed && !mentions && !pushedUnread) continue;
    if (!c.listed && c.muted) continue;
    const turn = c.state.turn?.addressed != null ? c.state.turn : null;
    const author = turn?.authorKey ? sumTallies([...(w.tallies.get(turn.authorKey)?.values() ?? [])], t) : null;
    out.push({
      conv: c,
      lastThere: there,
      input: {
        now: t,
        shape: c.shape,
        members: c.members,
        lastMessageAt: c.lastMessageAt,
        state: c.state,
        author,
        authorName: null,
        unread,
        mentions,
        pinged: pushedUnread ? 'a push' : null,
        muted: c.muted,
        usage: u,
      },
    });
  }
  return out;
}

function load(path: string) {
  const store = new Store(path, () => null);
  const db = store.db;
  const triage = new Triage(store);
  const self = new Set((db.query(`SELECT * FROM ${SELF_SQL}`).all() as Row[]).map((r) => Object.values(r)[0] as string));
  const selfPerson = (db.query('SELECT id FROM person WHERE is_self = 1').get() as Row | null)?.id ?? null;

  const stays: Stay[] = [];
  const peerOf = new Map<string, string | null>();
  const dmsOf = new Map<string, string[]>();
  const peers = db
    .query(
      `SELECT c.id, i.person_id FROM conversation c JOIN participant pa ON pa.conversation_id = c.id JOIN identity i ON i.id = pa.identity_id
       LEFT JOIN person p ON p.id = i.person_id WHERE c.shape = 'direct' AND i.person_id IS NOT NULL AND COALESCE(p.is_self, 0) = 0 AND i.id NOT IN ${SELF_SQL}`,
    )
    .all() as Row[];
  for (const r of peers) {
    if (peerOf.has(r.id)) continue;
    peerOf.set(r.id, r.person_id);
    dmsOf.set(r.person_id, [...(dmsOf.get(r.person_id) ?? []), r.id]);
  }

  // Candidates: what the inbox always lists, and anything that ever mentioned you or was pushed.
  const rows = db
    .query(
      `SELECT c.id, c.shape, ${LISTED} AS listed, (SELECT COUNT(*) FROM participant WHERE conversation_id = c.id) AS members FROM conversation c
       WHERE ${LISTED} OR EXISTS (SELECT 1 FROM message m WHERE m.conversation_id = c.id AND m.mentions_self = 1)
          OR EXISTS (SELECT 1 FROM message m JOIN triage t ON t.message_id = m.id WHERE m.conversation_id = c.id AND t.decision IN ('push', 'quiet'))`,
    )
    .all() as Row[];
  const convs = new Map<string, Conv>();
  for (const r of rows) {
    const eff = triage.effectiveLevel(r.id);
    const quiet = eff.level === 'none' || eff.level === 'digest';
    const peer = peerOf.get(r.id) ?? null;
    convs.set(r.id, {
      id: r.id,
      shape: r.shape,
      members: r.members,
      listed: !!r.listed,
      usageKey: r.shape === 'direct' && peer ? `person:${peer}` : `conversation:${r.id}`,
      muted: quiet && !(r.shape === 'self' && !eff.explicit) ? eff.source : null,
      state: freshState(),
      lastMessageAt: null,
      incoming: [],
      own: [],
    });
  }

  for (const v of db
    .query(`SELECT start_at, end_at, active, source, rank, sent, view, conversation_id, person_id FROM visit WHERE view IN ('conversation', 'person') ORDER BY start_at`)
    .all() as Row[]) {
    const c = v.conversation_id ? convs.get(v.conversation_id) : null;
    const person = v.view === 'person' ? v.person_id : c?.shape === 'direct' ? peerOf.get(c.id) : null;
    const key = person ? `person:${person}` : `conversation:${v.conversation_id}`;
    const targets = v.view === 'person' ? (dmsOf.get(v.person_id) ?? []) : v.conversation_id ? [v.conversation_id] : [];
    stays.push({ start: v.start_at, end: v.end_at, active: v.active, source: v.source, rank: v.rank, sent: v.sent, key, targets });
  }
  const logStart = stays[0]?.start ?? Infinity;
  return { store, db, convs, stays, logStart, self, selfPerson };
}

/**
 * Fold every candidate's messages in time order, stopping at each moment in `at` to call `visit` with the world as
 * it was then. Messages are what attention.ts folds: no text.
 */
function replay(l: ReturnType<typeof load>, at: number[], visit: (t: number, w: World) => void) {
  const tallies = new Map<string, Map<string, Tally>>();
  const w: World = { convs: l.convs, stays: l.stays, logStart: l.logStart, tallies };
  const ids = [...l.convs.keys()];
  const q = l.db.query(
    `SELECT m.id, m.ts, m.conversation_id AS cid, m.author_id, m.mentions_self, m.mentions_all, m.kind, m.deleted, i.is_bot, i.person_id,
            r.author_id AS reply_author,
            EXISTS (SELECT 1 FROM reaction x WHERE x.message_id = m.id AND x.identity_id IN ${SELF_SQL}) AS reacted,
            t.decision IN ('push', 'quiet') AS pushed, t.reasons LIKE '%asks a question%' AS question
     FROM message m LEFT JOIN identity i ON i.id = m.author_id LEFT JOIN message r ON r.id = m.reply_to_id LEFT JOIN triage t ON t.message_id = m.id
     WHERE m.conversation_id IN (SELECT value FROM json_each(?)) ORDER BY m.ts, m.rowid`,
  );
  const mine = (id: string | null, person: string | null) => (!!id && l.self.has(id)) || (!!person && person === l.selfPerson);
  let next = 0;
  for (const r of q.iterate(JSON.stringify(ids)) as Iterable<Row>) {
    while (next < at.length && at[next] < r.ts) visit(at[next++], w);
    const c = l.convs.get(r.cid)!;
    const me = mine(r.author_id, r.person_id);
    const ignore = !!r.deleted || r.kind === 'system';
    const key = r.person_id ?? r.author_id;
    foldMessage(
      c.state,
      (k) => {
        let m = tallies.get(k);
        if (!m) tallies.set(k, (m = new Map()));
        let t = m.get(c.id);
        if (!t) m.set(c.id, (t = emptyTally()));
        return t;
      },
      {
        id: r.id,
        ts: r.ts,
        author: r.author_id,
        authorKey: key,
        mine: me,
        bot: !!r.is_bot,
        mentionsMe: !!r.mentions_self && !r.mentions_all,
        repliesToMe: mine(r.reply_author, null),
        question: !!r.question,
        pushed: !!r.pushed,
        ignore,
        reactedByMe: !!r.reacted,
      },
      { shape: c.shape, members: c.members },
    );
    if (ignore) continue;
    c.lastMessageAt = Math.max(c.lastMessageAt ?? 0, r.ts);
    if (me) c.own.push(r.ts);
    else c.incoming.push({ ts: r.ts, mention: !!r.mentions_self, pushed: !!r.pushed });
  }
  while (next < at.length) visit(at[next++], w);
}

// ------------------------------------------------------------------ orderings

/** A policy turns the candidates at a moment into an order (best first), as conversation ids. */
export type Policy = { id: string; what: string; order: (seen: Seen[], t: number) => string[] };

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const scored = (s: Seen, visited = true) => {
  const r = scoreConversation(s.input);
  const v = r.parts.visited ?? 0;
  return { score: visited ? r.score : r.score - v, needs: r.needs, muted: !!s.input.muted && s.conv.shape !== 'self' };
};

/** Before one list: what needs you by score, then the latest message, muted last (the "caught up" line between). */
const twoLists: Policy = {
  id: 'two-lists',
  what: 'needs you by score, then "caught up" by the latest message (before one list)',
  order: (seen) =>
    seen
      .map((s) => ({ id: s.conv.id, last: s.input.lastMessageAt ?? 0, ...scored(s, false) }))
      .sort((a, b) => Number(b.needs) - Number(a.needs) || (a.needs ? 0 : Number(a.muted) - Number(b.muted) || b.last - a.last) || b.score - a.score || byKey(a.id, b.id))
      .map((x) => x.id),
};

/** One list by the hub's score with "you were here" (ordering.ts rank), weights as given. */
const oneList = (id = 'one-list', weights?: { visited: number; visitedHalfLife: number }): Policy => ({
  id,
  what: weights ? `one list, "you were here" ${weights.visited} halving every ${weights.visitedHalfLife / HOUR} h` : 'one list by the score, with "you were here" (ordering.ts)',
  order: (seen) => {
    const saved = { visited: WEIGHTS.visited, visitedHalfLife: WEIGHTS.visitedHalfLife };
    if (weights) Object.assign(WEIGHTS, weights);
    try {
      return seen
        .map((s) => ({ id: s.conv.id, last: s.input.lastMessageAt ?? 0, ...scored(s) }))
        .sort((a, b) => Number(a.muted) - Number(b.muted) || b.score - a.score || b.last - a.last || byKey(a.id, b.id))
        .map((x) => x.id);
    } finally {
      Object.assign(WEIGHTS, saved);
    }
  },
});

const latest: Policy = {
  id: 'latest',
  what: 'the latest message first, as a chat app',
  order: (seen) => [...seen].sort((a, b) => (b.input.lastMessageAt ?? 0) - (a.input.lastMessageAt ?? 0) || byKey(a.conv.id, b.conv.id)).map((s) => s.conv.id),
};

const lastVisited: Policy = {
  id: 'last-visited',
  what: 'where you were last first, then the latest message',
  order: (seen) =>
    [...seen].sort((a, b) => (b.lastThere ?? 0) - (a.lastThere ?? 0) || (b.input.lastMessageAt ?? 0) - (a.input.lastMessageAt ?? 0) || byKey(a.conv.id, b.conv.id)).map((s) => s.conv.id),
};

// ------------------------------------------------------------------ measuring

/** One open: where each policy put it (0 = top), and what it was. */
export interface Open {
  t: number;
  day: number;
  source: string;
  listLength: number;
  /** You had been there within the last 2 hours: going back to a chat you were just in. */
  back: boolean;
  ranks: Record<string, number>;
}

/** Opens worth asking about: a choice you made, of something the inbox lists. App start and resuming are not. */
const isChoice = (s: Stay) => s.source !== 'start' && s.source !== 'resume' && (s.active >= 3 || s.source === 'notification' || s.source === 'toast');

export interface Summary {
  n: number;
  mrr: number;
  recall5: number;
  recall10: number;
  medianRank: number;
}

export function summarize(ranks: number[]): Summary {
  const n = ranks.length;
  if (!n) return { n, mrr: 0, recall5: 0, recall10: 0, medianRank: 0 };
  const s = [...ranks].sort((a, b) => a - b);
  const median = n % 2 ? s[n >> 1] : (s[(n >> 1) - 1] + s[n >> 1]) / 2;
  return {
    n,
    mrr: ranks.reduce((a, r) => a + 1 / (r + 1), 0) / n,
    recall5: ranks.filter((r) => r < 5).length / n,
    recall10: ranks.filter((r) => r < 10).length / n,
    medianRank: median + 1,
  };
}

/** Replay `policies` over every open; the rank of what you opened, under each. */
function measure(l: ReturnType<typeof load>, policies: Policy[]): { opens: Open[]; skipped: Record<string, number> } {
  const choices = l.stays.filter(isChoice);
  const opens: Open[] = [];
  const skipped: Record<string, number> = { notListed: 0, noTarget: 0 };
  let i = 0;
  replay(
    l,
    choices.map((s) => s.start),
    (t, w) => {
      const stay = choices[i++];
      if (!stay.targets.length) return void skipped.noTarget++;
      // Where you had been until just before this open; the stay itself is not yet known.
      const seen = seenAt(w, t, usageAt(w.stays, t));
      const ids = new Set(seen.map((s) => s.conv.id));
      if (!stay.targets.some((x) => ids.has(x))) return void skipped.notListed++;
      const ranks: Record<string, number> = {};
      for (const p of policies) {
        const order = p.order(seen, t);
        ranks[p.id] = Math.min(...stay.targets.map((x) => order.indexOf(x)).filter((r) => r >= 0));
      }
      const back = seen.some((s) => stay.targets.includes(s.conv.id) && s.lastThere !== null && t - s.lastThere <= 2 * HOUR);
      opens.push({ t, day: dayOf(t), source: stay.source, listLength: seen.length, back, ranks });
    },
  );
  return { opens, skipped };
}

// ------------------------------------------------------------------ the report

const fmt = (x: number) => x.toFixed(3);

function table(title: string, policies: Policy[], groups: [string, Open[]][]): string {
  const lines = [`### ${title}`, '', `| ordering | ${groups.map(([g, o]) => `${g} (n=${o.length}) MRR · R@5 · R@10 · median`).join(' | ')} |`, `|---|${groups.map(() => '---').join('|')}|`];
  for (const p of policies) {
    const cells = groups.map(([, o]) => {
      const s = summarize(o.map((x) => x.ranks[p.id]));
      return `${fmt(s.mrr)} · ${fmt(s.recall5)} · ${fmt(s.recall10)} · ${s.medianRank}`;
    });
    lines.push(`| ${p.id} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const path = copyLive();
  mkdirSync(outDir, { recursive: true });
  const t0 = performance.now();
  const l = load(path);
  const policies: Policy[] = [twoLists, oneList(), latest, lastVisited];
  if (flag('grid'))
    for (const v of [15, 30, 45, 60]) for (const h of [1, 2, 4]) policies.push(oneList(`here-${v}-${h}h`, { visited: v, visitedHalfLife: h * HOUR }));
  const { opens, skipped } = measure(l, policies);
  const days = [...new Set(opens.map((o) => o.day))].sort((a, b) => a - b);
  const holdout = new Set(days.slice(-holdoutDays));
  const val = opens.filter((o) => !holdout.has(o.day));
  const hold = opens.filter((o) => holdout.has(o.day));
  const fromInbox = (o: Open) => o.source === 'inbox';
  const report = [
    '# Inbox replay',
    '',
    `${opens.length} opens of a listed conversation over ${days.length} days (${val.length} for choosing, ${hold.length} held out: the last ${holdout.size} days). Skipped: ${skipped.notListed} not in the inbox then, ${skipped.noTarget} with no conversation. Median list length ${summarize(opens.map((o) => o.listLength)).medianRank - 1}.`,
    '',
    'Positions count from 1 at the top. MRR is the mean of 1/position; R@k the share opened from the first k rows; the median is a position.',
    '"From the inbox" opens were clicks on an inbox row, so they favour the order that was on screen then; "elsewhere" are taps on a notification, the switcher, search, the rail and lists.',
    '',
    '"Back" are opens of a conversation you had been in within the last 2 hours.',
    '',
    table('Choosing days', policies, [['all', val], ['from the inbox', val.filter(fromInbox)], ['elsewhere', val.filter((o) => !fromInbox(o))], ['back', val.filter((o) => o.back)]]),
    '',
    table('Held-out days', policies, [['all', hold], ['from the inbox', hold.filter(fromInbox)], ['elsewhere', hold.filter((o) => !fromInbox(o))], ['back', hold.filter((o) => o.back)]]),
    '',
    'Orderings:',
    ...policies.map((p) => `- \`${p.id}\`: ${p.what}`),
    '',
    `Took ${Math.round((performance.now() - t0) / 1000)} s.`,
  ].join('\n');
  writeFileSync(join(outDir, 'inbox-replay.md'), report + '\n');
  const agg = (o: Open[]) => Object.fromEntries(policies.map((p) => [p.id, summarize(o.map((x) => x.ranks[p.id]))]));
  writeFileSync(join(outDir, 'inbox-replay.json'), JSON.stringify({ opens: opens.length, skipped, days: days.length, holdoutDays: holdout.size, choosing: agg(val), holdout: agg(hold) }, null, 2));
  console.log(report);
}
