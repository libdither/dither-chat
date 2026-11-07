/**
 * Mark many conversations read. The hub's own state changes at once; telling each network follows
 * one read at a time, because every read is a request and Discord rate-limits them.
 *
 * The queue is a table, so a restart picks up where it left off. An offline account just waits. A failed
 * read backs off and tries again a few times, and holds up the rest of that account so a rate limit is respected.
 */

import type * as P from '@dither-chat/protocol';
import type { Store } from './store.ts';

/** Time between reads on one account, in ms. */
export const READ_PACE: Record<P.Network, number> = { discord: 1500, matrix: 300, signal: 300, whatsapp: 1000, telegram: 500, gmessages: 500 };
const MAX_ATTEMPTS = 5;
const BACKOFF = 30_000;

interface Link {
  online(accountId: string): boolean;
  command(accountId: string, cmd: { t: 'markRead'; conversation: string; upTo: string }, timeoutMs?: number): Promise<unknown>;
}

type Row = { account_id: string; conversation_id: string; up_to: string; attempts: number };

export class ReadQueue {
  private busy = new Set<string>();
  private notBefore = new Map<string, number>();
  private failed = 0;
  private timer?: Timer;

  constructor(
    private store: Store,
    private link: Link,
    private pace: Record<P.Network, number> = READ_PACE,
  ) {}

  start(everyMs = 250) {
    this.timer = setInterval(() => void this.tick(), everyMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  pending(): number {
    return this.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM read_queue')!.n;
  }

  /** Read here at once, on the networks soon. Returns how many conversations had anything unread. */
  add(conversationIds: string[], now = Date.now()): number {
    const s = this.store;
    let marked = 0;
    for (const id of new Set(conversationIds)) {
      if (!s.one(`SELECT 1 FROM vantage WHERE target_kind = 'conversation' AND target_id = ? AND (unread > 0 OR mentions > 0)`, id)) continue;
      marked++;
      for (const t of s.markRead(id, now)) {
        if (!t.upTo) continue; // nothing stored here to point at, so the network keeps its own idea
        s.db
          .query(
            `INSERT INTO read_queue (account_id, conversation_id, up_to, attempts, next_at, created_at) VALUES (?, ?, ?, 0, 0, ?)
             ON CONFLICT (account_id, conversation_id) DO UPDATE SET up_to = excluded.up_to, attempts = 0, next_at = 0`,
          )
          .run(t.accountId, id, t.upTo, now);
      }
    }
    if (marked) this.failed = 0;
    this.report();
    return marked;
  }

  /** One read per account that is due. Returns when they have all answered, for tests. */
  async tick(now = Date.now()): Promise<void> {
    const accounts = this.store.raw<{ account_id: string }>('SELECT DISTINCT account_id FROM read_queue');
    const runs: Promise<void>[] = [];
    for (const { account_id: id } of accounts) {
      if (this.busy.has(id) || (this.notBefore.get(id) ?? 0) > now || !this.link.online(id)) continue;
      const row = this.store.one<Row>('SELECT * FROM read_queue WHERE account_id = ? AND next_at <= ? ORDER BY rowid LIMIT 1', id, now);
      if (row) runs.push(this.send(row, now));
    }
    await Promise.all(runs);
  }

  private async send(row: Row, now: number) {
    const s = this.store;
    const conv = s.nativeOf('conversation', row.conversation_id);
    const acc = s.account(row.account_id);
    const del = () => s.db.query('DELETE FROM read_queue WHERE account_id = ? AND conversation_id = ?').run(row.account_id, row.conversation_id);
    if (!conv || !acc) {
      del();
      return this.report();
    }
    this.busy.add(acc.id);
    this.notBefore.set(acc.id, now + this.pace[acc.network]);
    try {
      await this.link.command(acc.id, { t: 'markRead', conversation: conv.nativeId, upTo: row.up_to }, 20_000);
      del();
    } catch (e) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        console.warn(`read queue: giving up on ${row.conversation_id} for ${acc.id}: ${(e as Error).message}`);
        del();
        this.failed++;
      } else {
        const wait = BACKOFF * 2 ** (attempts - 1);
        s.db.query('UPDATE read_queue SET attempts = ?, next_at = ? WHERE account_id = ? AND conversation_id = ?').run(attempts, now + wait, row.account_id, row.conversation_id);
        this.notBefore.set(acc.id, now + wait);
      }
    } finally {
      this.busy.delete(acc.id);
    }
    this.report();
  }

  private report() {
    this.store.dirty.extra.push({ t: 'readProgress', pending: this.pending(), failed: this.failed });
  }
}
