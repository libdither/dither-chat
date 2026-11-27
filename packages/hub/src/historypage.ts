/**
 * One page of a chat's history, read the one way every reader reads it: the index jobs (jobs.ts), the catch-up
 * (catchup.ts) and the gap fill (imports/gapfill.ts). docs/indexing.md "History, and why a repeat is cheap".
 *
 * The page's messages are known exactly, not guessed from row counts: the store records what backfill stores for that
 * account and chat while the page is out (Store.tap), and the reader waits until every event the account sent before
 * its answer is applied and committed (Supervisor.settled). An adapter sends a page's messages before its answer, and
 * dither-accounts' manager passes a call's events on before its result, so once that wait is over the page is in.
 *
 * Only then is anything recorded whole (history_span): from the page's oldest message to where it started, or to the
 * chat's start when the network says the page reached it. A page whose messages did not come with its answer records
 * nothing, so a crash, a locked database or an adapter that answers first can never leave a stretch marked whole that
 * the hub does not hold.
 */
import type * as P from '@dither-chat/protocol';
import { addSpan, spanAt } from './historyspan.ts';
import type { Store } from './store.ts';

/** Messages a page: what Discord's client loads when you scroll up. */
export const PAGE = 50;
/** A page whose messages had not come with its answer is asked again after this long. */
export const LAND_AGAIN_MS = 30_000;
/** Times a page is asked again for that; then the chat fails, saying so. */
export const LAND_RETRIES = 3;
export const NOT_LANDED = "The page's messages did not come with its answer, so nothing of it was recorded";

type Row = Record<string, any>;

export type Command = (accountId: string, cmd: any, timeoutMs?: number) => Promise<any>;

/** How a reader reaches an account: its commands, and the wait until what the account sent is applied. */
export interface Pager {
  command: Command;
  /**
   * Resolves true once every event the account sent so far is applied (Supervisor.settled); false when that did not
   * happen in time. Without it (a test's adapter that stores its page before answering), at once.
   */
  settled?: (accountId: string) => Promise<boolean>;
}

type Page =
  /** The adapter cannot read just now: ask again after this long. Nothing was fetched. */
  | { kind: 'defer'; deferMs: number }
  /** Its messages did not come with the answer (or did not commit in time): nothing recorded; ask again later. */
  | { kind: 'unlanded'; count: number }
  /** A page the network cannot give by time (newer messages than asked for): the walk cannot go on. */
  | { kind: 'failed'; count: number; fresh: number[]; error: string }
  | {
      kind: 'page';
      count: number;
      /** The times of the page's messages the hub did not hold before. */
      fresh: number[];
      /** `start`: the chat's start was reached, recorded whole below. `empty`: the network sent nothing more (not recorded). */
      end: 'start' | 'empty' | null;
      /** Where the next page starts (its oldest message); null with an end. */
      oldest: number | null;
      /** The network's own cursor for that place (HistoryResult.next). */
      next?: string;
    };

/** The cursor moved down over what is known whole; 0 when that reaches the chat's start. */
export function skipWhole(store: Store, cid: string, cursor: number): number {
  for (let s = spanAt(store, cid, cursor); s; s = spanAt(store, cid, cursor)) {
    if (s.from_ts === 0) return 0;
    cursor = s.from_ts;
  }
  return cursor;
}

/**
 * Asks for the PAGE messages of `cid` (native `native`) before `beforeTs` through the account, waits until they are
 * in, records what it can tell is whole, and says what came.
 */
export async function readPage(store: Store, pager: Pager, o: { accountId: string; cid: string; native: string; beforeTs: number; cursor?: string; timeoutMs?: number }): Promise<Page> {
  const tap = store.tap(o.accountId, o.native);
  let r: P.HistoryResult | null;
  let landed: boolean;
  try {
    const cmd = { t: 'history' as const, conversation: o.native, beforeTs: o.beforeTs, limit: PAGE, pace: 'read' as const, ...(o.cursor ? { cursor: o.cursor } : {}) };
    r = (await pager.command(o.accountId, cmd, o.timeoutMs ?? 180_000)) as P.HistoryResult | null;
    if (r?.deferMs && !r.count) return { kind: 'defer', deferMs: r.deferMs };
    landed = pager.settled ? await pager.settled(o.accountId) : true;
  } finally {
    store.untap(tap);
  }
  const count = r?.count ?? 0;
  const seen = [...tap.seen.values()];
  // An answer that says it sent messages none of which came before it: they come later or never. Nothing is recorded.
  if (!landed || (count > 0 && !seen.length)) return { kind: 'unlanded', count };
  const fresh = seen.filter((m) => m.fresh).map((m) => m.ts);
  const below = seen.map((m) => m.ts).filter((ts) => ts < o.beforeTs).sort((a, b) => b - a);
  let oldest: number | null = typeof r?.oldest === 'number' && Number.isFinite(r.oldest) ? r.oldest : null;
  if (oldest === null && below.length) {
    // The page is the `count` newest before the cursor: its count-th newest message is where it ended. (Another
    // reader's page of the same chat landing meanwhile only adds older ones below that; fewer than `count` came when
    // the network sent some the hub does not keep, and the oldest that came is a bound as safe.)
    oldest = below[Math.min(count, below.length) - 1];
  }
  if (count > 0 && (oldest === null || oldest >= o.beforeTs)) return { kind: 'failed', count, fresh, error: 'The network sent newer messages than asked for: it cannot fetch by time here' };
  if (r?.done) {
    // The chat's start: whole below the cursor, unless the network says there is nothing where the hub holds messages
    // (it could not read the chat, and said so as an empty last page).
    const held = !count && !!store.one<Row>('SELECT 1 FROM message WHERE conversation_id = ? AND ts < ? LIMIT 1', o.cid, o.beforeTs);
    if (!held) addSpan(store, o.cid, 0, o.beforeTs);
    return { kind: 'page', count, fresh, end: held ? 'empty' : 'start', oldest: null };
  }
  if (!r || !count) {
    // A page of things that are not this chat's messages (reactions, edits, thread replies kept in their threads) says
    // where it reached: nothing was missed down to there, and the walk goes on below it. Without that, the network
    // sent nothing more.
    if (r && oldest !== null && oldest < o.beforeTs) {
      addSpan(store, o.cid, oldest, o.beforeTs);
      return { kind: 'page', count, fresh, end: null, oldest, ...(typeof r.next === 'string' && r.next ? { next: r.next } : {}) };
    }
    return { kind: 'page', count, fresh, end: 'empty', oldest: null };
  }
  addSpan(store, o.cid, oldest!, o.beforeTs);
  return { kind: 'page', count, fresh, end: null, oldest, ...(typeof r.next === 'string' && r.next ? { next: r.next } : {}) };
}
