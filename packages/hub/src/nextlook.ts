/**
 * The next look (docs/notifications.md, "One scale"): what can wait an hour or more is held, and arrives together the
 * next time you look anyway: when you open the app, unlock the phone (the Android app says so), or at the times you
 * set. Nothing is dropped; it is moved. Only while the loudness decides (DITHER_ATTENTION=on).
 */
import type * as P from '@dither-chat/protocol';
import type { Store } from './store.ts';

type Row = Record<string, any>;

/** A set time counts as due for this long after it, so a minute's tick never misses it. */
const TIMES_SLACK = 10 * 60_000;

interface Bundle {
  title: string;
  body: string;
  count: number;
  chats: { conversationId: string; title: string; count: number }[];
}

export class NextLook {
  private lastTimes: string | null = null;

  constructor(private store: Store) {}

  hold(messageId: string, conversationId: string, quiet: boolean, now = Date.now()) {
    this.store.db.query('INSERT OR IGNORE INTO next_look (message_id, conversation_id, held_at, quiet) VALUES (?, ?, ?, ?)').run(messageId, conversationId, now, quiet ? 1 : 0);
  }

  count(): number {
    return (this.store.db.query('SELECT COUNT(*) AS n FROM next_look').get() as Row).n;
  }

  /** A set time has come (and not been flushed for yet today). */
  dueAt(prefs: P.AttentionPrefs, now: number): boolean {
    if (prefs.nextLook === 'open') return false;
    const d = new Date(now);
    for (const t of prefs.times) {
      const [h, m] = t.split(':').map(Number);
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
      const key = `${d.toDateString()} ${t}`;
      if (now >= at && now - at < TIMES_SLACK && this.lastTimes !== key) {
        this.lastTimes = key;
        return this.count() > 0;
      }
    }
    return false;
  }

  /**
   * Let go of what was held, as one bundle: the chats it is in (read ones left out) and how many each. Null when
   * nothing unread is held.
   */
  flush(_why: 'open' | 'unlock' | 'times'): Bundle | null {
    const db = this.store.db;
    const rows = db
      .query(
        `SELECT n.conversation_id AS cid, COUNT(*) AS n, MAX(m.ts) AS ts FROM next_look n JOIN message m ON m.id = n.message_id
         WHERE m.ts > COALESCE((SELECT MAX(last_read_ts) FROM vantage WHERE target_kind = 'conversation' AND target_id = n.conversation_id), 0)
         GROUP BY n.conversation_id ORDER BY ts DESC`,
      )
      .all() as Row[];
    db.exec('DELETE FROM next_look');
    if (!rows.length) return null;
    const chats = rows.map((r) => ({ conversationId: r.cid as string, title: (db.query('SELECT name, shape FROM conversation WHERE id = ?').get(r.cid) as Row | null)?.name ?? 'A chat', count: r.n as number }));
    const count = chats.reduce((s, c) => s + c.count, 0);
    const names = chats.slice(0, 3).map((c) => c.title);
    return {
      title: `Next look · ${count} waiting`,
      body: `${names.join(', ')}${chats.length > 3 ? ` and ${chats.length - 3} more` : ''}`,
      count,
      chats: chats.slice(0, 8),
    };
  }
}
