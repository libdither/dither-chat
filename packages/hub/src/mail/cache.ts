/**
 * The body cache and the search text (docs/mail-design.md §2.5).
 *
 * Bodies (mail_body): MAIL_LIMITS.cacheMb in all; past it, the least recently read go first, down to 90% of it. Starred
 * mail stays, and so does a body marked `keep = 1` (slice 5: mail an outbox item needs). A body over
 * MAIL_LIMITS.bodyMaxBytes is not cached: it is marked `keep = -1` and goes once nobody has read it for BIG_BODY_MS.
 * An evicted body is fetched again when it is opened; the message keeps its preview.
 *
 * Search text (mail_text): the first MAIL_LIMITS.textBytes of each fetched body's text, written with the body, and kept
 * after the body goes. MAIL_LIMITS.indexMb in all; past it, the oldest mail's go first. Slice 7 indexes it: a row is
 * there by the time MailHub's `body` event fires for its message.
 */
import type * as M from '@dither-chat/protocol/mail-iface';
import { MAIL_LIMITS } from './limits.ts';
import type { MailStore } from './store.ts';

const MB = 1024 * 1024;
/** How long a body too big to cache stays after it was last read. */
export const BIG_BODY_MS = 10 * 60_000;

/** mail.get's answer kept: the body (MailStore.putBody), its search text; one too big to cache marked to go soon. */
export function storeBody(store: MailStore, messageId: string, msg: M.MailMessage) {
  store.putBody(messageId, msg);
  const b = store.one<{ text: string | null; bytes: number }>('SELECT text, bytes FROM mail_body WHERE message_id = ?', messageId);
  if (!b) return;
  if (b.bytes > MAIL_LIMITS.bodyMaxBytes) store.db.query('UPDATE mail_body SET keep = -1 WHERE message_id = ? AND keep = 0').run(messageId);
  putText(store, messageId, b.text);
}

/** The search text of a message (slice 7): the start of its body's text, or null when none was fetched. */
export function searchText(store: MailStore, messageId: string): string | null {
  return store.one<{ text: string }>('SELECT text FROM mail_text WHERE message_id = ?', messageId)?.text ?? null;
}

function putText(store: MailStore, messageId: string, text: string | null) {
  if (!text) return;
  const t = text.length > MAIL_LIMITS.textBytes ? text.slice(0, MAIL_LIMITS.textBytes) : text;
  store.db
    .query(
      `INSERT INTO mail_text (message_id, text, bytes, received_at) SELECT id, ?, ?, received_at FROM mail_message WHERE id = ?
       ON CONFLICT (message_id) DO UPDATE SET text = excluded.text, bytes = excluded.bytes`,
    )
    .run(t, Buffer.byteLength(t), messageId);
}

export class BodyCache {
  private timer: Timer | null = null;

  constructor(
    private store: MailStore,
    private now: () => number = Date.now,
  ) {}

  /** Bytes held: bodies, search text. */
  sizes(): { bodies: number; text: number } {
    const b = this.store.one<{ n: number | null }>('SELECT SUM(bytes) AS n FROM mail_body');
    const t = this.store.one<{ n: number | null }>('SELECT SUM(bytes) AS n FROM mail_text');
    return { bodies: b?.n ?? 0, text: t?.n ?? 0 };
  }

  /** A body came: the caps are checked a few seconds later, once for a run of them. */
  stored() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sweep();
    }, 5_000);
    this.timer.unref?.();
  }

  sweep(): { bodies: string[]; text: number } {
    return { bodies: this.evict(), text: this.trimText() };
  }

  /** Bodies past the cap go, least recently read first. Returns the messages whose body went. */
  evict(cap = MAIL_LIMITS.cacheMb * MB): string[] {
    const st = this.store;
    const out: string[] = [];
    st.db.transaction(() => {
      for (const r of st.all<{ message_id: string }>('SELECT message_id FROM mail_body WHERE keep = -1 AND used_at < ?', this.now() - BIG_BODY_MS)) out.push(r.message_id);
      st.db.query('DELETE FROM mail_body WHERE keep = -1 AND used_at < ?').run(this.now() - BIG_BODY_MS);
      let total = st.one<{ n: number | null }>('SELECT SUM(bytes) AS n FROM mail_body')?.n ?? 0;
      if (total <= cap) return;
      const target = cap * 0.9;
      const del = st.db.query('DELETE FROM mail_body WHERE message_id = ?');
      while (total > target) {
        const batch = st.all<{ message_id: string; bytes: number }>(
          `SELECT b.message_id, b.bytes FROM mail_body b JOIN mail_message m ON m.id = b.message_id
           WHERE b.keep <= 0 AND m.flagged = 0 ORDER BY b.used_at, b.message_id LIMIT 500`,
        );
        if (!batch.length) break;
        for (const b of batch) {
          if (total <= target) break;
          del.run(b.message_id);
          total -= b.bytes;
          out.push(b.message_id);
        }
      }
    })();
    return out;
  }

  /** Search text past its cap goes, oldest mail first. Returns how many went. */
  trimText(cap = MAIL_LIMITS.indexMb * MB): number {
    const st = this.store;
    let total = st.one<{ n: number | null }>('SELECT SUM(bytes) AS n FROM mail_text')?.n ?? 0;
    if (total <= cap) return 0;
    const target = cap * 0.9;
    let n = 0;
    st.db.transaction(() => {
      const del = st.db.query('DELETE FROM mail_text WHERE message_id = ?');
      while (total > target) {
        const batch = st.all<{ message_id: string; bytes: number }>('SELECT message_id, bytes FROM mail_text ORDER BY received_at, message_id LIMIT 500');
        if (!batch.length) break;
        for (const t of batch) {
          if (total <= target) break;
          del.run(t.message_id);
          total -= t.bytes;
          n++;
        }
      }
    })();
    return n;
  }
}
