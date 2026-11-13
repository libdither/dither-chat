/**
 * Polls (docs/polls.md, protocol poll.ts): a poll's votes as they come, tallied, and the routes that vote, make a
 * poll and end one early.
 *
 * A poll itself is its message's extra.poll, kept as it came. What changed since lives here:
 *  - poll_state: the counts, your options and the voter count as the network last said them (Discord), and whether
 *    it ended. A message fact that brings counts of its own is newer than these and clears them.
 *  - poll_vote: each voter's latest whole vote, by its number (Signal's voteCount: the highest wins, as Signal's apps
 *    count). Signal shows every member who voted for what, so these keep who; Discord's voters are never asked for.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { POLL_RULES, pollDraftProblem, pollVoteProblem } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { AccountRow, Store } from './store.ts';
import { requestHeld } from './add.ts';

type Row = Record<string, any>;

const made = new WeakSet<Database>();

export function pollTables(db: Database) {
  if (made.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS poll_state (
    message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
    counts     TEXT,
    voters     INTEGER,
    mine       TEXT,
    ended      INTEGER NOT NULL DEFAULT 0,
    at         INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS poll_vote (
    message_id  TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    identity_id TEXT NOT NULL,
    options     TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    at          INTEGER NOT NULL,
    PRIMARY KEY (message_id, identity_id)
  )`);
  made.add(db);
}

const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const json = <T>(s: string | null | undefined, d: T): T => {
  if (!s) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

/**
 * A message's extra.poll as a PollFact, or null when it is not one. Also reads the shape older Signal adapters wrote
 * ({ question, options: string[], allowMultiple }), whose options are their positions.
 */
export function pollFact(x: unknown): P.PollFact | null {
  if (!x || typeof x !== 'object') return null;
  const p = x as Record<string, any>;
  const question = typeof p.question === 'string' ? p.question : p.question === null ? 'Poll' : null;
  if (question === null || !Array.isArray(p.options)) return null;
  const options: P.PollOptionFact[] = [];
  p.options.forEach((o: unknown, i: number) => {
    if (typeof o === 'string') options.push({ id: String(i), text: o });
    else if (o && typeof o === 'object' && str((o as any).id) && typeof (o as any).text === 'string')
      options.push({ id: (o as any).id, text: (o as any).text, ...(str((o as any).emoji) ? { emoji: (o as any).emoji } : {}) });
  });
  if (!options.length) return null;
  const counts = p.counts && typeof p.counts === 'object' ? numbers(p.counts) : undefined;
  return {
    question: question || 'Poll',
    options,
    ...(p.multi === true || p.allowMultiple === true ? { multi: true } : {}),
    ...(typeof p.expires === 'number' ? { expires: p.expires } : {}),
    ...(p.ended === true ? { ended: true } : {}),
    ...(counts ? { counts } : {}),
    ...(typeof p.voters === 'number' ? { voters: p.voters } : {}),
    ...(Array.isArray(p.mine) ? { mine: p.mine.filter((m: unknown) => typeof m === 'string') } : {}),
  };
}

function numbers(o: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(0, Math.round(v));
  return out;
}

/** A message fact with a poll came: counts it brings are newer than what updates left here. */
export function pollSeen(db: Database, messageId: string, extra: Record<string, unknown> | undefined) {
  const f = pollFact(extra?.poll);
  if (!f?.counts) return;
  pollTables(db);
  db.query('UPDATE poll_state SET counts = NULL, voters = NULL, mine = NULL WHERE message_id = ?').run(messageId);
}

/** Apply one pollUpdate. False when the poll's message is not stored (as with a reaction to one). */
export function applyPollUpdate(db: Database, network: P.Network, voterId: (native: string) => string, ev: P.PollUpdate): boolean {
  pollTables(db);
  const mid = hubId('msg', network, ev.message);
  const msg = db.query('SELECT extra FROM message WHERE id = ?').get(mid) as Row | null;
  if (!msg) return false;
  const now = ev.ts ?? Date.now();
  const cur = (db.query('SELECT * FROM poll_state WHERE message_id = ?').get(mid) as Row | null) ?? null;
  let counts = json<Record<string, number> | null>(cur?.counts, null);
  let voters: number | null = cur?.voters ?? null;
  let mine = json<string[] | null>(cur?.mine, null);
  let ended = !!cur?.ended;
  if (ev.counts) counts = numbers(ev.counts);
  if (ev.add) {
    const base = counts ?? { ...(pollFact(json<Row>(msg.extra, {}).poll)?.counts ?? {}) };
    for (const [k, v] of Object.entries(ev.add)) if (typeof v === 'number') base[k] = Math.max(0, (base[k] ?? 0) + v);
    counts = base;
  }
  if (typeof ev.voters === 'number') voters = ev.voters;
  if (Array.isArray(ev.mine)) mine = ev.mine.filter((x) => typeof x === 'string');
  if (ev.ended) ended = true;
  db.query(
    `INSERT INTO poll_state (message_id, counts, voters, mine, ended, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (message_id) DO UPDATE SET counts = excluded.counts, voters = excluded.voters, mine = excluded.mine, ended = excluded.ended, at = excluded.at`,
  ).run(mid, counts ? JSON.stringify(counts) : null, voters, mine ? JSON.stringify(mine) : null, ended ? 1 : 0, now);
  const v = ev.vote;
  if (v && typeof v.voter === 'string' && Array.isArray(v.options) && typeof v.seq === 'number') {
    const who = voterId(v.voter);
    const opts = [...new Set(v.options.filter((o) => typeof o === 'string'))];
    // The latest vote wins: by its number, and between two of the same number, the one heard later.
    db.query(
      `INSERT INTO poll_vote (message_id, identity_id, options, seq, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (message_id, identity_id) DO UPDATE SET options = excluded.options, seq = excluded.seq, at = excluded.at WHERE excluded.seq >= poll_vote.seq`,
    ).run(mid, who, JSON.stringify(opts), v.seq, v.ts ?? now);
  }
  return true;
}

/** Polls of these messages as the web shows them; messages without one are absent. */
export function pollViews(db: Database, rows: Row[], isSelf: (identityId: string) => boolean, now = Date.now()): Map<string, P.PollView> {
  const out = new Map<string, P.PollView>();
  const facts = new Map<string, P.PollFact>();
  for (const r of rows) {
    if (!r.extra || !String(r.extra).includes('"poll"')) continue;
    const f = pollFact(json<Row>(r.extra, {}).poll);
    if (f) facts.set(r.id, f);
  }
  if (!facts.size) return out;
  pollTables(db);
  const ids = [...facts.keys()];
  const ph = ids.map(() => '?').join(',');
  const states = new Map((db.query(`SELECT * FROM poll_state WHERE message_id IN (${ph})`).all(...ids) as Row[]).map((s) => [s.message_id as string, s]));
  const votes = new Map<string, Row[]>();
  for (const v of db.query(`SELECT * FROM poll_vote WHERE message_id IN (${ph}) ORDER BY at`).all(...ids) as Row[]) (votes.get(v.message_id) ?? votes.set(v.message_id, []).get(v.message_id)!).push(v);
  for (const [id, f] of facts) out.set(id, pollView(f, states.get(id) ?? null, votes.get(id) ?? [], isSelf, now));
  return out;
}

/** One poll: by its voters where they are known (Signal), else by the counts the network said. */
export function pollView(f: P.PollFact, state: Row | null, votes: Row[], isSelf: (identityId: string) => boolean, now = Date.now()): P.PollView {
  const ended = !!f.ended || !!state?.ended || (typeof f.expires === 'number' && f.expires <= now);
  const base = { question: f.question, multi: !!f.multi, expires: f.expires ?? null, ended };
  if (votes.length) {
    const by = new Map<string, string[]>();
    let mine: string[] = [];
    let seq: number | undefined;
    let voters = 0;
    for (const v of votes) {
      const opts = json<string[]>(v.options, []);
      if (isSelf(v.identity_id)) {
        mine = opts;
        seq = Math.max(seq ?? 0, v.seq);
      }
      if (opts.length) voters++;
      for (const o of opts) (by.get(o) ?? by.set(o, []).get(o)!).push(v.identity_id);
    }
    return {
      ...base,
      options: f.options.map((o) => ({ ...o, count: by.get(o.id)?.length ?? 0, mine: mine.includes(o.id), voters: by.get(o.id) ?? [] })),
      voters,
      counted: true,
      ...(seq !== undefined ? { seq } : {}),
    };
  }
  const counts = json<Record<string, number> | null>(state?.counts, null) ?? f.counts ?? null;
  const mine = json<string[] | null>(state?.mine, null) ?? f.mine ?? [];
  const voters = state?.voters ?? f.voters ?? null;
  return {
    ...base,
    options: f.options.map((o) => ({ ...o, count: counts?.[o.id] ?? 0, mine: mine.includes(o.id) })),
    voters,
    counted: !!counts,
  };
}

// ------------------------------------------------------------------ routes

export interface PollRouteDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T = unknown>(accountId: string, cmd: any, timeoutMs?: number) => Promise<T>;
  pickAccount: (conversationId: string, requested?: string) => string | null;
  flush: () => void;
}

function caps(acc: Pick<AccountRow, 'capabilities'> | null | undefined): P.Capability[] {
  try {
    return JSON.parse(acc?.capabilities || '[]');
  } catch {
    return [];
  }
}

export const handlesPolls = (path: string) => /^\/api\/messages\/[\w-]+\/(vote|end-poll)$/.test(path) || /^\/api\/conversations\/[\w-]+\/polls$/.test(path);

/**
 * POST /api/messages/:id/vote { options: string[] } ([] takes the vote back), POST /api/messages/:id/end-poll,
 * POST /api/conversations/:id/polls { question, options, multi, hours?, accountId? }. Null for any other path.
 */
export async function pollRoute(d: PollRouteDeps, req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST' || !handlesPolls(path)) return null;
  const ok = (v: unknown = { ok: true }) => Response.json(v);
  const bad = (error: string, status = 400) => Response.json({ error }, { status });
  const s = d.store;
  const body = async <T>() => ((await req.json().catch(() => ({}))) ?? {}) as T;
  const failed = (e: unknown, what: string) => bad(`The network refused to ${what}: ${String((e as Error)?.message ?? e)}`, 502);
  let m: RegExpMatchArray | null;

  if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/polls$/))) {
    const b = await body<Partial<P.PollDraft> & { accountId?: string }>();
    const conv = s.nativeOf('conversation', m[1]);
    if (!conv) return bad('No such conversation', 404);
    const draft: P.PollDraft = {
      question: String(b.question ?? '').trim(),
      options: Array.isArray(b.options) ? b.options.map((o) => String(o ?? '').trim()) : [],
      multi: b.multi === true,
      ...(typeof b.hours === 'number' ? { hours: b.hours } : POLL_RULES[conv.network]?.defaultHours ? { hours: POLL_RULES[conv.network]!.defaultHours } : {}),
    };
    const problem = pollDraftProblem(conv.network, draft);
    if (problem) return bad(problem);
    const accountId = d.pickAccount(m[1], b.accountId);
    const acc = accountId ? s.account(accountId) : null;
    if (!acc || !caps(acc).includes('pollCreate')) return bad('No account here can make polls', 409);
    if (!d.online(acc.id)) return bad(`${acc.label} is not connected`, 409);
    if (requestHeld(s.db, m[1])) return bad('Accept this message request first');
    try {
      const r = await d.command<{ nativeId?: string }>(acc.id, { t: 'pollCreate', conversation: conv.nativeId, poll: draft }, 60_000);
      d.flush();
      return ok({ ok: true, accountId: acc.id, ...(r?.nativeId ? { messageId: hubId('msg', conv.network, r.nativeId) } : {}) });
    } catch (e) {
      return failed(e, 'make the poll');
    }
  }

  m = path.match(/^\/api\/messages\/([\w-]+)\/(vote|end-poll)$/)!;
  const msg = s.one<Row>('SELECT id, conversation_id, native_id, author_id, extra FROM message WHERE id = ?', m[1]);
  if (!msg) return bad('No such message', 404);
  const fact = pollFact(json<Row>(msg.extra, {}).poll);
  if (!fact) return bad('This message is not a poll');
  const conv = s.nativeOf('conversation', msg.conversation_id)!;
  const view = pollViews(s.db, [msg], (id) => s.isSelf(id)).get(msg.id)!;

  if (m[2] === 'end-poll') {
    // Only its author ends a poll: the account that made it.
    const acc = s.accounts().find((a) => a.self_identity === msg.author_id);
    if (!acc) return bad('Only whoever made a poll can end it', 403);
    if (!caps(acc).includes('pollEnd')) return bad('Polls cannot be ended from here on this network', 409);
    if (view.ended) return ok({ ok: true, poll: view });
    if (!d.online(acc.id)) return bad(`${acc.label} is not connected`, 409);
    try {
      await d.command(acc.id, { t: 'pollEnd', conversation: conv.nativeId, message: msg.native_id }, 45_000);
    } catch (e) {
      return failed(e, 'end the poll');
    }
    applyPollUpdate(s.db, conv.network, (n) => n, { conversation: conv.nativeId, message: msg.native_id, ended: true });
    s.dirty.messages.set(msg.id, s.dirty.messages.get(msg.id) ?? false);
    d.flush();
    return ok({ ok: true });
  }

  const b = await body<{ options?: unknown; accountId?: string }>();
  const options = Array.isArray(b.options) ? b.options.map(String) : null;
  if (!options) return bad('which options?');
  const problem = pollVoteProblem(view, options);
  if (problem) return bad(problem);
  if (requestHeld(s.db, msg.conversation_id)) return bad('Accept this message request first');
  const accountId = d.pickAccount(msg.conversation_id, b.accountId);
  const acc = accountId ? s.account(accountId) : null;
  if (!acc || !caps(acc).includes('pollVote')) return bad('No account here can vote in polls', 409);
  if (!d.online(acc.id)) return bad(`${acc.label} is not connected`, 409);
  try {
    await d.command(acc.id, { t: 'pollVote', conversation: conv.nativeId, message: msg.native_id, options, ...(view.seq !== undefined ? { seq: view.seq } : {}) }, 45_000);
  } catch (e) {
    return failed(e, options.length ? 'take your vote' : 'take your vote back');
  }
  d.flush();
  return ok({ ok: true, accountId: acc.id });
}
