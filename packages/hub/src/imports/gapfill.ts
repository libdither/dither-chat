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
 */
import type * as P from '@dither-chat/protocol';
import type { Store } from '../store.ts';

const PAGE = 100;
/** Between pages, on top of the extractor's own pacing. */
const PAUSE_MS = 1500;

type Row = Record<string, any>;

export interface GapFillOptions {
  /** Server channels too, not only the ones an import reached. */
  allChannels?: boolean;
}

export class GapFill {
  private running = new Map<string, { stop: boolean; current: string | null }>();

  constructor(
    private store: Store,
    private command: (accountId: string, cmd: { t: 'history'; conversation: string; beforeTs?: number; limit: number }) => Promise<{ count: number; done: boolean } | null>,
    private log: (msg: string) => void = () => {},
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
        this.start(r.key.slice('gapfill:'.length), JSON.parse(r.value));
      } catch (e: any) {
        this.log(`gap fill resume: ${e?.message ?? e}`);
      }
    }
  }

  stopAll() {
    for (const r of this.running.values()) r.stop = true;
  }

  start(accountId: string, o: GapFillOptions = {}): P.GapFillView {
    if (this.running.has(accountId)) return this.status(accountId);
    const acc = this.store.account(accountId);
    if (!acc || acc.network !== 'discord') throw new Error('gap filling is for Discord accounts');
    this.plan(accountId, o);
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
    const imported = (cid: string) =>
      this.store.db.query('SELECT MAX(m.ts) AS t FROM message m WHERE m.conversation_id = ? AND EXISTS (SELECT 1 FROM import_origin o WHERE o.message_id = m.id)').get(cid) as Row;
    for (const c of convs) {
      const gapEnd = (imported(c.id)?.t as number | null) ?? null;
      if ((c.shape === 'channel' || c.shape === 'thread') && gapEnd === null && !o.allChannels) continue;
      this.store.db
        .query(`INSERT INTO gap_fill (account_id, conversation_id, gap_end, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET gap_end = MAX(COALESCE(gap_end, 0), COALESCE(excluded.gap_end, 0))`)
        .run(accountId, c.id, gapEnd, Date.now());
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
      let cursor = this.top(g.conversation_id, gapEnd) ?? Date.now();
      let pages = g.pages as number;
      let fetched = g.fetched as number;
      const save = (patch: { done?: boolean; error?: string | null }) =>
        this.store.db
          .query('UPDATE gap_fill SET pages = ?, fetched = ?, done = ?, error = ?, updated_at = ? WHERE account_id = ? AND conversation_id = ?')
          .run(pages, fetched, patch.done ? 1 : 0, patch.error ?? null, Date.now(), accountId, g.conversation_id);
      try {
        for (;;) {
          if (state.stop) return save({});
          const count = () => (this.store.db.query('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?').get(g.conversation_id) as Row).n as number;
          const before = count();
          const r = await this.command(accountId, { t: 'history', conversation: native, beforeTs: cursor, limit: PAGE });
          pages++;
          // The page's messages may land just after the answer (remote accounts): give them a moment.
          let next = this.top(g.conversation_id, gapEnd);
          for (let i = 0; i < 6 && r && r.count && (next === null || next >= cursor); i++) {
            await Bun.sleep(500);
            next = this.top(g.conversation_id, gapEnd);
          }
          fetched += Math.max(0, count() - before);
          // Done: the start of the conversation, or a page that brought nothing above the gap.
          if (!r || r.done || !r.count || next === null || next >= cursor) {
            save({ done: true });
            break;
          }
          cursor = next;
          save({});
          await Bun.sleep(PAUSE_MS);
        }
      } catch (e: any) {
        this.log(`gap fill ${accountId} ${g.conversation_id}: ${e?.message ?? e}`);
        save({ done: true, error: String(e?.message ?? e).slice(0, 300) });
      }
    }
    state.current = null;
    this.store.db.query('DELETE FROM meta WHERE key = ?').run(`gapfill:${accountId}`);
  }
}
