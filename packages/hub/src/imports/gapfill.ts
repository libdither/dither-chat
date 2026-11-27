/**
 * The exporter's second half (docs/import-discord.md, "Gaps"): what neither the export nor live sync has, fetched
 * through the account itself, the way DiscordChatExporter pages a channel, but with the adapter's own paced
 * `history` command (the extractor spaces pages out and backs off on a 429). Messages arrive as ordinary backfill,
 * so they are the network's own version and replace an imported copy where they overlap.
 *
 * For each Discord conversation of the account: the gap runs from the oldest message the hub has above the newest
 * imported one, down to that imported one (or to the start of the conversation, when nothing was imported). Pages
 * go back from the top of the gap until a page brings nothing above it. Progress is kept in gap_fill, so a restart
 * carries on. Direct and group chats always; server channels only where an import reached, unless asked.
 *
 * At a person's reading pace (readingpace.ts), shared with the index jobs: one reader per account at a time. Pages are
 * read through historypage.ts, as the index jobs and the catch-up read them, and what they cover is recorded whole.
 */
import type * as P from '@dither-chat/protocol';
import { type Clock, realClock, sleep } from '../clock.ts';
import { LAND_AGAIN_MS, LAND_RETRIES, NOT_LANDED, type Pager, readPage, skipWhole } from '../historypage.ts';
import { READING, ReadingPace } from '../readingpace.ts';
import type { Store } from '../store.ts';

/** The pace's name for this reader. */
const READER = 'gapfill';
/** A wait for the pace is slept in steps this long at most, so a stop tells soon. */
const REST_STEP_MS = 60_000;
/** An extractor that cannot read just now (deferMs) is asked again after at most this long. */
const DEFER_MAX_MS = 10 * 60_000;

type Row = Record<string, any>;

interface GapFillOptions {
  /** Server channels too, not only the ones an import reached. */
  allChannels?: boolean;
}

export class GapFill {
  private running = new Map<string, { stop: boolean; current: string | null }>();

  constructor(
    private store: Store,
    private command: (accountId: string, cmd: { t: 'history'; conversation: string; beforeTs?: number; limit: number; cursor?: string; pace?: 'read' }) => Promise<P.HistoryResult | null>,
    private log: (msg: string) => void = () => {},
    private clock: Clock = realClock,
    private pace: ReadingPace = new ReadingPace(store, READING, clock),
    /** Until what the account sent is applied (Supervisor.settled): historypage.ts. */
    private settled?: Pager['settled'],
  ) {}

  /** Conversations still to do, and done, for an account. */
  status(accountId: string): P.GapFillView {
    const rows = this.store.db.query('SELECT * FROM gap_fill WHERE account_id = ?').all(accountId) as Row[];
    const r = this.running.get(accountId);
    return {
      accountId,
      running: !!r,
      current: r?.current ?? null,
      conversations: rows.length,
      done: rows.filter((x) => x.done).length,
      failed: rows.filter((x) => x.error).length,
      pages: rows.reduce((n, x) => n + x.pages, 0),
      fetched: rows.reduce((n, x) => n + x.fetched, 0),
    };
  }

  stop(accountId: string) {
    const r = this.running.get(accountId);
    if (r) r.stop = true;
    this.store.db.query('DELETE FROM meta WHERE key = ?').run(`gapfill:${accountId}`);
  }

  /** Carry on after a restart with whatever was running. */
  resume() {
    for (const r of this.store.db.query(`SELECT key, value FROM meta WHERE key LIKE 'gapfill:%'`).all() as Row[]) {
      try {
        this.start(r.key.slice('gapfill:'.length), JSON.parse(r.value), true);
      } catch (e: any) {
        this.log(`gap fill resume: ${e?.message ?? e}`);
      }
    }
  }

  stopAll() {
    for (const r of this.running.values()) r.stop = true;
  }

  start(accountId: string, o: GapFillOptions = {}, resuming = false): P.GapFillView {
    if (this.running.has(accountId)) return this.status(accountId);
    const acc = this.store.account(accountId);
    if (!acc || acc.network !== 'discord') throw new Error('gap filling is for Discord accounts');
    // Carrying on after a restart keeps the plan it had; starting again looks for conversations added since.
    if (!resuming) this.plan(accountId, o);
    this.store.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`gapfill:${accountId}`, JSON.stringify(o));
    const state = { stop: false, current: null as string | null };
    this.running.set(accountId, state);
    void this.go(accountId, state).finally(() => this.running.delete(accountId));
    return this.status(accountId);
  }

  /** One row per conversation to look at; existing rows keep their progress. */
  private plan(accountId: string, o: GapFillOptions) {
    const convs = this.store.db
      .query(
        `SELECT c.id, c.shape, c.native_id FROM conversation c JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = c.id AND v.account_id = ?
         WHERE c.network = 'discord' AND c.shape IN ('direct', 'group', 'channel', 'thread')`,
      )
      .all(accountId) as Row[];
    // The newest message an import inserted: back along the (conversation, ts) index from the newest message.
    const newestImported = this.store.db.query('SELECT ts FROM message WHERE conversation_id = ? AND imported = 1 ORDER BY ts DESC LIMIT 1');
    for (const c of convs) {
      const gapEnd = ((newestImported.get(c.id) as Row | null)?.ts as number | undefined) ?? null;
      if ((c.shape === 'channel' || c.shape === 'thread') && gapEnd === null && !o.allChannels) continue;
      this.store.db
        .query(`INSERT INTO gap_fill (account_id, conversation_id, gap_end, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET gap_end = MAX(COALESCE(gap_end, 0), COALESCE(excluded.gap_end, 0))`)
        .run(accountId, c.id, gapEnd, this.clock.now());
    }
  }

  /** The oldest message above the gap: where the next page starts. */
  private top(cid: string, gapEnd: number): number | null {
    return ((this.store.db.query('SELECT MIN(ts) AS t FROM message WHERE conversation_id = ? AND ts > ?').get(cid, gapEnd) as Row)?.t as number | null) ?? null;
  }

  private async go(accountId: string, state: { stop: boolean; current: string | null }) {
    const todo = this.store.db.query('SELECT * FROM gap_fill WHERE account_id = ? AND done = 0 ORDER BY conversation_id').all(accountId) as Row[];
    for (const g of todo) {
      if (state.stop) return;
      state.current = g.conversation_id;
      const native = this.store.nativeOf('conversation', g.conversation_id)?.nativeId;
      if (!native) continue;
      const gapEnd = (g.gap_end as number | null) ?? 0;
      let cursor = this.top(g.conversation_id, gapEnd) ?? this.clock.now();
      // The extractor's own cursor for where its last page ended, while the cursor is still there.
      let mark: { next: string; at: number } | null = null;
      let pages = g.pages as number;
      let fetched = g.fetched as number;
      const save = (patch: { done?: boolean; error?: string | null }) =>
        this.store.db
          .query('UPDATE gap_fill SET pages = ?, fetched = ?, done = ?, error = ?, updated_at = ? WHERE account_id = ? AND conversation_id = ?')
          .run(pages, fetched, patch.done ? 1 : 0, patch.error ?? null, this.clock.now(), accountId, g.conversation_id);
      try {
        let tries = 0;
        for (;;) {
          if (!(await this.turn(accountId, state))) return save({});
          // Over what is known whole: reaching the gap's end (or the start) ends it.
          cursor = skipWhole(this.store, g.conversation_id, cursor);
          if (cursor <= gapEnd) {
            save({ done: true });
            break;
          }
          const p = await readPage(this.store, { command: this.command, settled: this.settled }, { accountId, cid: g.conversation_id, native, beforeTs: cursor, cursor: mark && mark.at === cursor ? mark.next : undefined });
          if (p.kind === 'defer') {
            await sleep(this.clock, Math.min(Math.max(p.deferMs, 1000), DEFER_MAX_MS));
            continue;
          }
          pages++;
          if (p.kind === 'unlanded') {
            // Its messages did not come with the answer: nothing recorded, the same page again a little later.
            if (++tries > LAND_RETRIES) throw new Error(NOT_LANDED);
            await sleep(this.clock, Math.max(LAND_AGAIN_MS, this.pace.read(accountId, READER, p.count, false)));
            continue;
          }
          tries = 0;
          fetched += p.fresh.length;
          if (p.kind === 'failed') throw new Error(p.error);
          // Done: the start of the conversation, a page that brought nothing, or one that reached the gap's end.
          if (p.end || p.oldest === null || p.oldest <= gapEnd) {
            save({ done: true });
            await sleep(this.clock, this.pace.read(accountId, READER, p.count, true));
            break;
          }
          cursor = p.oldest;
          mark = p.next ? { next: p.next, at: p.oldest } : null;
          save({});
          await sleep(this.clock, this.pace.read(accountId, READER, p.count, false));
        }
      } catch (e: any) {
        this.log(`gap fill ${accountId} ${g.conversation_id}: ${e?.message ?? e}`);
        save({ done: true, error: String(e?.message ?? e).slice(0, 300) });
      }
    }
    state.current = null;
    this.pace.release(accountId, READER);
    this.store.db.query('DELETE FROM meta WHERE key = ?').run(`gapfill:${accountId}`);
  }

  /** Waits until the pace lets the account read; false when stopped first. */
  private async turn(accountId: string, state: { stop: boolean }): Promise<boolean> {
    for (;;) {
      if (state.stop) return false;
      const rest = this.pace.wait(accountId, READER);
      if (rest <= 0) return true;
      await sleep(this.clock, Math.min(rest, REST_STEP_MS));
    }
  }
}
