/**
 * How much you have had to do with each person, month by month (the people graph's closeness, docs/people-graph.md
 * "Who matters"): what the page sizes people by, and what its time slider replays. Counts only, never message text.
 *
 * A month's weight for someone is the sum of:
 *  - every message in your direct chat with them, theirs and yours (1 each);
 *  - their messages in a group chat you are in, less the bigger the group (2 / people in it, groups up to 50);
 *  - a reply between you and them in a server's channel, either way (1.5), and their mentions of you there (1).
 * And the time you spent in your direct chat with them (1 a minute). Plus, per identity, how many friends a fetched
 * profile says you share (mutualFriends). Bots are left out: a bot's direct chat can send thousands of messages a month.
 *
 * The same for each place the graph shows (a server, counting its channels and threads, or a group chat): your own
 * messages there (1 each) and the time you spent in it (1 a minute). Time comes from the hub's record of visits
 * (`visit`), so it only goes back as far as that does.
 *
 * And ties between two people, neither of them you (the graph's circles): replies between them, reactions to each
 * other's messages, and turns one right after the other in a small group chat, by month; and the friends a fetched
 * profile says they have in common with you, who are their friends too.
 *
 * Worked out on a thread of its own (closeness-worker.ts) on a read-only connection, kept for a while, and asked for
 * by the page apart from the graph, so the graph opens at once.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { communities } from './graph.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

interface ClosenessRun {
  /** Months as year × 12 + month (0-based), UTC. */
  from: number;
  to: number;
  /** Identity id → flat [month, weight × 10] pairs, months ascending. */
  byIdentity: Record<string, number[]>;
  /** A graph place's id → flat [month, weight × 10] pairs: your messages and time there. */
  byPlace: Record<string, number[]>;
  /** Identity id → friends you share, as their profile said. */
  mutual: Record<string, number>;
  /** Ties between two identities, neither you: "a b" (a < b) → flat [month, weight × 10] pairs, months ascending. */
  ties: Record<string, number[]>;
  /** Pairs of identities a profile says are friends: flat [a, b]. */
  friendPairs: string[];
  ms: number;
}

const MONTH = `(CAST(strftime('%Y', m.ts / 1000, 'unixepoch') AS INTEGER) * 12 + CAST(strftime('%m', m.ts / 1000, 'unixepoch') AS INTEGER) - 1)`;
const ME = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL UNION SELECT i.id FROM identity i JOIN person p ON p.id = i.person_id WHERE p.is_self = 1)`;
const GROUP_MAX = 50;
/** Ties: what each counts for, and how close in time and how small a group turns must be. */
const TIE = { reply: 1, reaction: 0.3, turn: 0.5 };
const TURN_MS = 5 * 60_000;
const TURN_GROUP_MAX = 60;

export function closeness(db: Database): ClosenessRun {
  const t0 = performance.now();
  const acc = new Map<string, Map<number, number>>();
  const bots = new Set((db.query('SELECT id FROM identity WHERE is_bot = 1').all() as Row[]).map((r) => r.id as string));
  const add = (who: string, mo: number, w: number) => {
    if (bots.has(who)) return;
    let m = acc.get(who);
    if (!m) acc.set(who, (m = new Map()));
    m.set(mo, (m.get(mo) ?? 0) + w);
  };
  // Direct chats: every message, either way, counts for the other side.
  for (const r of db
    .query(
      `SELECT p.identity_id AS who, ${MONTH} AS mo, count(*) AS n FROM message m
       JOIN conversation c ON c.id = m.conversation_id AND c.shape = 'direct'
       JOIN participant p ON p.conversation_id = c.id AND p.identity_id NOT IN ${ME}
       GROUP BY who, mo`,
    )
    .all() as Row[])
    add(r.who, r.mo, r.n);
  // Group chats: their messages, worth less the more people are in it.
  const size = new Map<string, number>();
  for (const r of db.query(`SELECT p.conversation_id AS id, count(*) AS n FROM participant p JOIN conversation c ON c.id = p.conversation_id AND c.shape = 'group' GROUP BY p.conversation_id`).all() as Row[])
    size.set(r.id, r.n);
  for (const r of db
    .query(
      `SELECT m.author_id AS who, m.conversation_id AS conv, ${MONTH} AS mo, count(*) AS n FROM message m
       JOIN conversation c ON c.id = m.conversation_id AND c.shape = 'group'
       WHERE m.author_id IS NOT NULL AND m.author_id NOT IN ${ME}
       GROUP BY who, conv, mo`,
    )
    .all() as Row[]) {
    const n = size.get(r.conv) ?? 2;
    if (n <= GROUP_MAX) add(r.who, r.mo, (r.n * 2) / Math.max(2, n));
  }
  // Servers: replies between you and them, either way, and their mentions of you.
  for (const r of db
    .query(
      `SELECT CASE WHEN m.author_id IN ${ME} THEN r.author_id ELSE m.author_id END AS who, ${MONTH} AS mo, count(*) AS n
       FROM message m JOIN message r ON r.id = m.reply_to_id
       JOIN conversation c ON c.id = m.conversation_id AND c.shape IN ('channel', 'thread')
       WHERE m.author_id IS NOT NULL AND r.author_id IS NOT NULL AND (m.author_id IN ${ME}) <> (r.author_id IN ${ME})
       GROUP BY who, mo`,
    )
    .all() as Row[])
    add(r.who, r.mo, r.n * 1.5);
  for (const r of db
    .query(
      `SELECT m.author_id AS who, ${MONTH} AS mo, count(*) AS n FROM message m
       JOIN conversation c ON c.id = m.conversation_id AND c.shape IN ('channel', 'thread')
       WHERE m.mentions_self = 1 AND m.mentions_all = 0 AND m.author_id IS NOT NULL AND m.author_id NOT IN ${ME}
       GROUP BY who, mo`,
    )
    .all() as Row[])
    add(r.who, r.mo, r.n);

  // Places: your own messages, in a server's channels and threads or a group chat.
  const { community, convSpace } = communities(db);
  const conv = new Map<string, Row>((db.query(`SELECT id, shape, parent_id FROM conversation WHERE shape IN ('direct', 'group', 'channel', 'thread')`).all() as Row[]).map((r) => [r.id, r]));
  const placeOf = (id: string | null): string | null => {
    const c = id ? conv.get(id) : undefined;
    if (!c) return null;
    if (c.shape === 'group') return c.id;
    if (c.shape === 'channel') return convSpace.get(c.id) ?? null;
    if (c.shape === 'thread') return convSpace.get(c.parent_id) ?? convSpace.get(c.id) ?? null;
    return null;
  };
  const places = new Map<string, Map<number, number>>();
  const addPlace = (id: string | null, mo: number, w: number) => {
    if (!id) return;
    let m = places.get(id);
    if (!m) places.set(id, (m = new Map()));
    m.set(mo, (m.get(mo) ?? 0) + w);
  };
  for (const r of db
    .query(
      `SELECT m.conversation_id AS conv, ${MONTH} AS mo, count(*) AS n FROM message m
       JOIN conversation c ON c.id = m.conversation_id AND c.shape IN ('group', 'channel', 'thread')
       WHERE m.author_id IN ${ME} GROUP BY conv, mo`,
    )
    .all() as Row[])
    addPlace(placeOf(r.conv), r.mo, r.n);
  // Time spent: in a place (a chat in it, or the server's own page), or in a direct chat with someone.
  const other = new Map<string, string>();
  for (const r of db.query(`SELECT p.conversation_id AS c, p.identity_id AS i FROM participant p JOIN conversation c ON c.id = p.conversation_id AND c.shape = 'direct' WHERE p.identity_id NOT IN ${ME}`).all() as Row[]) other.set(r.c, r.i);
  for (const r of db.query('SELECT conversation_id AS conv, space_id AS space, start_at AS at, active FROM visit WHERE active > 0').all() as Row[]) {
    const d = new Date(r.at);
    const mo = d.getUTCFullYear() * 12 + d.getUTCMonth();
    const w = r.active / 60;
    const dm = r.conv ? other.get(r.conv) : undefined;
    if (dm) add(dm, mo, w);
    else addPlace(placeOf(r.conv) ?? (r.space ? community(r.space) : null), mo, w);
  }

  // Ties between two people, neither of them you, nor a bot.
  const self = new Set((db.query(`SELECT id FROM identity WHERE id IN ${ME}`).all() as Row[]).map((r) => r.id as string));
  const tieAcc = new Map<string, Map<number, number>>();
  const tie = (a: string | null, b: string | null, mo: number, w: number) => {
    if (!a || !b || a === b || self.has(a) || self.has(b) || bots.has(a) || bots.has(b)) return;
    const key = a < b ? `${a} ${b}` : `${b} ${a}`;
    let m = tieAcc.get(key);
    if (!m) tieAcc.set(key, (m = new Map()));
    m.set(mo, (m.get(mo) ?? 0) + w);
  };
  // Row by row, the month worked out here: three times quicker than grouping by month in SQL on a big history.
  const monthOf = (ts: number) => {
    const d = new Date(ts);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };
  for (const [a, b, ts] of db
    .query(`SELECT m.author_id, r.author_id, m.ts FROM message m JOIN message r ON r.id = m.reply_to_id WHERE m.author_id IS NOT NULL AND r.author_id IS NOT NULL AND m.author_id <> r.author_id`)
    .values() as [string, string, number][])
    tie(a, b, monthOf(ts), TIE.reply);
  for (const [a, b, ts] of db
    .query(`SELECT x.identity_id, m.author_id, m.ts FROM reaction x JOIN message m ON m.id = x.message_id WHERE m.author_id IS NOT NULL AND x.identity_id <> m.author_id`)
    .values() as [string, string, number][])
    tie(a, b, monthOf(ts), TIE.reaction);
  // Turns: a message right after someone else's, within five minutes, in a group chat small enough to be a conversation.
  const small = [...size].filter(([, n]) => n <= TURN_GROUP_MAX).map(([id]) => id);
  if (small.length) {
    const turns = db.query(
      `SELECT author_id AS a, prev AS b, ${MONTH} AS mo, count(*) AS n FROM (
         SELECT m.author_id, m.ts, lag(m.author_id) OVER w AS prev, lag(m.ts) OVER w AS prev_ts FROM message m
         WHERE m.conversation_id = ? AND m.author_id IS NOT NULL WINDOW w AS (ORDER BY m.ts)
       ) m WHERE prev IS NOT NULL AND prev <> author_id AND ts - prev_ts < ${TURN_MS} GROUP BY a, b, mo`,
    );
    for (const id of small) for (const r of turns.all(id) as Row[]) tie(r.a, r.b, r.mo, r.n * TIE.turn);
  }
  // Friends: a profile's friends in common with you are its person's friends too.
  const friendPairs: string[] = [];
  const identOf = db.query('SELECT id FROM identity WHERE network = ? AND native_id = ?');
  for (const r of db.query(`SELECT a.target_id AS t, i.network AS net, j.value AS f FROM about a JOIN identity i ON i.id = a.target_id, json_each(a.data, '$.mutualFriends') j WHERE json_valid(a.data)`).all() as Row[]) {
    const o = (identOf.get(r.net, String(r.f)) as Row | null)?.id as string | undefined;
    if (o && o !== r.t && !self.has(o) && !self.has(r.t)) friendPairs.push(r.t, o);
  }

  let from = Infinity;
  let to = -Infinity;
  const flatten = (acc: Map<string, Map<number, number>>) => {
    const out: Record<string, number[]> = {};
    for (const [who, months] of acc) {
      const flat: number[] = [];
      for (const mo of [...months.keys()].sort((a, b) => a - b)) {
        const w = Math.round(months.get(mo)! * 10);
        if (!w) continue;
        flat.push(mo, w);
        from = Math.min(from, mo);
        to = Math.max(to, mo);
      }
      if (flat.length) out[who] = flat;
    }
    return out;
  };
  const byIdentity = flatten(acc);
  const byPlace = flatten(places);
  const ties = flatten(tieAcc);
  // Friends in common, as profiles said.
  const mutual: Record<string, number> = {};
  for (const r of db.query(`SELECT target_id, json_array_length(data, '$.mutualFriends') AS n FROM about WHERE json_valid(data) AND json_type(data, '$.mutualFriends') = 'array'`).all() as Row[])
    if (r.n > 0) mutual[r.target_id] = r.n;
  const now = new Date();
  const thisMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return { from: Number.isFinite(from) ? from : thisMonth, to: Math.max(Number.isFinite(to) ? to : thisMonth, thisMonth), byIdentity, byPlace, mutual, ties, friendPairs, ms: Math.round(performance.now() - t0) };
}

/** Each person's months, summed over their identities: what GET /api/graph/activity answers, keyed as the graph is. */
export function activityView(store: Store, run: ClosenessRun): P.GraphActivity {
  const people: Record<string, number[]> = {};
  const mutual: Record<string, number> = {};
  const merged = new Map<string, Map<number, number>>();
  for (const r of store.db.query('SELECT id, person_id FROM identity').all() as Row[]) {
    const key = r.person_id ?? r.id;
    const flat = run.byIdentity[r.id];
    if (flat) {
      let m = merged.get(key);
      if (!m) merged.set(key, (m = new Map()));
      for (let i = 0; i < flat.length; i += 2) m.set(flat[i], (m.get(flat[i]) ?? 0) + flat[i + 1]);
    }
    const f = run.mutual[r.id];
    if (f) mutual[key] = Math.max(mutual[key] ?? 0, f);
  }
  for (const [key, m] of merged) people[key] = [...m.keys()].sort((a, b) => a - b).flatMap((mo) => [mo, m.get(mo)!]);
  return { from: run.from, to: run.to, people, mutual, places: run.byPlace, ties: tiesView(store, run) };
}

/** Pairs under this much in all (weight × 10) are left out: a reply or two between strangers in a busy server. */
const TIE_MIN = 20;

/** Ties keyed as the graph is: each identity as its person, pairs inside one person dropped, small ones left out. */
function tiesView(store: Store, run: ClosenessRun): P.GraphTies {
  const keyOf = new Map<string, string>();
  for (const r of store.db.query('SELECT id, person_id FROM identity').all() as Row[]) keyOf.set(r.id, r.person_id ?? r.id);
  const pair = new Map<string, Map<number, number>>();
  for (const [k, flat] of Object.entries(run.ties)) {
    const [x, y] = k.split(' ');
    const a = keyOf.get(x) ?? x;
    const b = keyOf.get(y) ?? y;
    if (a === b) continue;
    const pk = a < b ? `${a} ${b}` : `${b} ${a}`;
    let m = pair.get(pk);
    if (!m) pair.set(pk, (m = new Map()));
    for (let i = 0; i < flat.length; i += 2) m.set(flat[i], (m.get(flat[i]) ?? 0) + flat[i + 1]);
  }
  const ids: string[] = [];
  const at = new Map<string, number>();
  const ix = (id: string) => at.get(id) ?? (at.set(id, ids.length), ids.push(id), ids.length - 1);
  const links: number[] = [];
  for (const [pk, m] of pair) {
    let total = 0;
    for (const w of m.values()) total += w;
    if (total < TIE_MIN) continue;
    const [a, b] = pk.split(' ');
    const months = [...m.keys()].sort((p, q) => p - q);
    links.push(ix(a), ix(b), months.length);
    for (const mo of months) links.push(mo, m.get(mo)!);
  }
  const friends: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < run.friendPairs.length; i += 2) {
    const a = keyOf.get(run.friendPairs[i]) ?? run.friendPairs[i];
    const b = keyOf.get(run.friendPairs[i + 1]) ?? run.friendPairs[i + 1];
    const pk = a < b ? `${a} ${b}` : `${b} ${a}`;
    if (a === b || seen.has(pk)) continue;
    seen.add(pk);
    friends.push(ix(a), ix(b));
  }
  return { ids, links, friends };
}

const KEEP_MS = 30 * 60_000;

/** Runs closeness() on its worker when asked and nothing recent is kept; one run at a time. */
export class Closeness {
  private last: ClosenessRun | null = null;
  private at = 0;
  private running: Promise<ClosenessRun> | null = null;
  private worker: Worker | null = null;

  constructor(private d: { store: Store; file: string | null; log?: (line: string) => void }) {}

  async get(): Promise<ClosenessRun> {
    if (this.last && Date.now() - this.at < KEEP_MS) return this.last;
    this.running ??= this.compute()
      .then((r) => {
        this.last = r;
        this.at = Date.now();
        this.d.log?.(`closeness: ${Object.keys(r.byIdentity).length} people in ${r.ms} ms`);
        return r;
      })
      .finally(() => (this.running = null));
    // Something kept, if a little old, answers now; the new run replaces it for the next ask.
    return this.last ?? this.running;
  }

  private compute(): Promise<ClosenessRun> {
    if (!this.d.file) return Promise.resolve(closeness(this.d.store.db));
    this.worker ??= this.startWorker();
    const w = this.worker;
    return new Promise((resolve, reject) => {
      w.onmessage = (e: MessageEvent<{ t: 'done'; run: ClosenessRun } | { t: 'failed'; error: string }>) => (e.data.t === 'done' ? resolve(e.data.run) : reject(new Error(e.data.error)));
      w.onerror = (e) => {
        this.worker = null;
        reject(new Error(e.message));
      };
      w.postMessage({ file: this.d.file });
    });
  }

  private startWorker(): Worker {
    const w = new Worker(new URL('./closeness-worker.ts', import.meta.url).href);
    (w as { unref?: () => void }).unref?.();
    return w;
  }
}
