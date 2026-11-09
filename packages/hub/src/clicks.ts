/**
 * Button counts (docs/button-counts.md): which of the app's controls get pressed, per day, page and kind of
 * device, for devices that switched it on. Devices send batches; the hub only adds them up. Keys are strings
 * from the app's code: nothing here names a person, a place or what was said.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { CLICK_BATCH_MAX, cleanClick, localDay } from '@dither-chat/protocol';

const DAY = 86_400_000;
/** Days kept, so the table stays small however long it is left on. */
const KEEP_DAYS = 400;

type Row = Record<string, any>;

export class ClickCounts {
  constructor(private db: Database) {}

  /** Adds one device's batch. A batch id seen before is ignored, so resending after a lost answer is safe. */
  apply(batch: string | undefined, counts: unknown[], now = Date.now()): number {
    let n = 0;
    this.db.transaction(() => {
      if (batch) {
        if (this.db.query('SELECT 1 FROM click_batch WHERE id = ?').get(batch)) return;
        this.db.query('INSERT INTO click_batch (id, at) VALUES (?, ?)').run(batch, now);
      }
      const add = this.db.query('INSERT INTO click_count (day, key, page, device, n) VALUES (?, ?, ?, ?, ?) ON CONFLICT (day, key, page, device) DO UPDATE SET n = n + excluded.n');
      for (const raw of counts.slice(0, CLICK_BATCH_MAX)) {
        const c = cleanClick(raw as Partial<P.ClickCount>, now);
        if (!c) continue;
        add.run(c.day, c.key, c.page, c.device, c.n);
        n++;
      }
      this.db.query('DELETE FROM click_batch WHERE at < ?').run(now - 7 * DAY);
      this.db.query('DELETE FROM click_count WHERE day < ?').run(localDay(now - KEEP_DAYS * DAY));
    })();
    return n;
  }

  /** Totals over the last `days` days (today included), most pressed first; split by device or by page if asked. */
  totals(days: number, by: 'device' | 'page' | null = null, limit = 200, now = Date.now()): P.ClicksView {
    const since = localDay(now - (days - 1) * DAY);
    const total = ((this.db.query('SELECT SUM(n) AS n FROM click_count WHERE day >= ?').get(since) as Row | null)?.n as number) ?? 0;
    let keys: P.ClickTotal[];
    if (by === 'page') {
      keys = this.db.query('SELECT key, page, SUM(n) AS n FROM click_count WHERE day >= ? GROUP BY key, page ORDER BY n DESC, key, page LIMIT ?').all(since, limit) as P.ClickTotal[];
    } else if (by === 'device') {
      keys = (
        this.db
          .query(
            `SELECT key, SUM(n) AS n, SUM(CASE WHEN device = 'phone' THEN n ELSE 0 END) AS phone, SUM(CASE WHEN device = 'desktop' THEN n ELSE 0 END) AS desktop
             FROM click_count WHERE day >= ? GROUP BY key ORDER BY n DESC, key LIMIT ?`,
          )
          .all(since, limit) as Row[]
      ).map((r) => ({ key: r.key, n: r.n, phone: r.phone, desktop: r.desktop }));
    } else {
      keys = this.db.query('SELECT key, SUM(n) AS n FROM click_count WHERE day >= ? GROUP BY key ORDER BY n DESC, key LIMIT ?').all(since, limit) as P.ClickTotal[];
    }
    return { days, since, total, keys };
  }

  forget() {
    this.db.exec('DELETE FROM click_count; DELETE FROM click_batch;');
  }
}
