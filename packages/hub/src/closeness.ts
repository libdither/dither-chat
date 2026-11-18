/**
 * How much you have had to do with each person, month by month (the people graph's closeness, docs/people-graph.md
 * "Who matters"): what the page sizes people by, and what its time slider replays. Counts only, never message text.
 *
 * A month's weight for someone is the sum of:
 *  - every message in your direct chat with them, theirs and yours (1 each);
 *  - their messages in a group chat you are in, less the bigger the group (2 / people in it, groups up to 50);
 *  - a reply between you and them in a server's channel, either way (1.5), and their mentions of you there (1).
 * Plus, per identity, how many friends a fetched profile says you share (mutualFriends). Bots are left out: a bot's
 * direct chat can send thousands of messages a month.
 *
 * Worked out on a thread of its own (closeness-worker.ts) on a read-only connection, kept for a while, and asked for
 * by the page apart from the graph, so the graph opens at once.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import type { Store } from './store.ts';

type Row = Record<string, any>;

interface ClosenessRun {
  /** Months as year × 12 + month (0-based), UTC. */
  from: number;
  to: number;
  /** Identity id → flat [month, weight × 10] pairs, months ascending. */
  byIdentity: Record<string, number[]>;
  /** Identity id → friends you share, as their profile said. */
  mutual: Record<string, number>;
  ms: number;
}

const MONTH = `(CAST(strftime('%Y', m.ts / 1000, 'unixepoch') AS INTEGER) * 12 + CAST(strftime('%m', m.ts / 1000, 'unixepoch') AS INTEGER) - 1)`;
const ME = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL UNION SELECT i.id FROM identity i JOIN person p ON p.id = i.person_id WHERE p.is_self = 1)`;
const GROUP_MAX = 50;

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

  let from = Infinity;
  let to = -Infinity;
  const byIdentity: Record<string, number[]> = {};
  for (const [who, months] of acc) {
    const flat: number[] = [];
    for (const mo of [...months.keys()].sort((a, b) => a - b)) {
      const w = Math.round(months.get(mo)! * 10);
      if (!w) continue;
      flat.push(mo, w);
      from = Math.min(from, mo);
      to = Math.max(to, mo);
    }
    if (flat.length) byIdentity[who] = flat;
  }
  // Friends in common, as profiles said.
  const mutual: Record<string, number> = {};
  for (const r of db.query(`SELECT target_id, json_array_length(data, '$.mutualFriends') AS n FROM about WHERE json_valid(data) AND json_type(data, '$.mutualFriends') = 'array'`).all() as Row[])
    if (r.n > 0) mutual[r.target_id] = r.n;
  const now = new Date();
  const thisMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return { from: Number.isFinite(from) ? from : thisMonth, to: Math.max(Number.isFinite(to) ? to : thisMonth, thisMonth), byIdentity, mutual, ms: Math.round(performance.now() - t0) };
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
  return { from: run.from, to: run.to, people, mutual };
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
