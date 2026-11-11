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
 * there by the time MailHub's `body` event fires for its message. Its attachments' names go to the index too.
 *
 * An account that keeps all its mail (keep.ts) is outside both caps, by a rule per account (MailStore.keptSql), not a
 * `keep` value on each body: its bodies are never evicted and do not count against MAIL_LIMITS.cacheMb, and its search
 * text holds up to MAIL_LIMITS.keepTextBytes of each body, never trimmed. Turning keeping off puts both back under the
 * caps as they are, with nothing to rewrite. A body over MAIL_LIMITS.bodyMaxBytes still goes after it is read: its text
 * stays in the search text, and the original will come from mail.raw (a later PR).
 */
import type * as M from '@dither-chat/protocol/mail-iface';
import { MAIL_LIMITS } from './limits.ts';
import type { MailStore } from './store.ts';

const MB = 1024 * 1024;
/** How long a body too big to cache stays after it was last read. */
export const BIG_BODY_MS = 10 * 60_000;

/** mail.get's answer kept: the body (MailStore.putBody), its search text and its files' names; one too big to cache marked to go soon. */
export function storeBody(store: MailStore, messageId: string, msg: M.MailMessage) {
  store.putBody(messageId, msg);
  const b = store.one<{ text: string | null; bytes: number; account_id: string }>('SELECT b.text, b.bytes, m.account_id FROM mail_body b JOIN mail_message m ON m.id = b.message_id WHERE b.message_id = ?', messageId);
  if (!b) return;
  if (b.bytes > MAIL_LIMITS.bodyMaxBytes) store.db.query('UPDATE mail_body SET keep = -1 WHERE message_id = ? AND keep = 0').run(messageId);
  putText(store, messageId, b.text, store.kept(b.account_id));
  const files = (msg.attachments ?? []).map((a) => a.filename?.trim()).filter(Boolean).join(' ');
  if (files) store.db.query('UPDATE mail_search SET files = ? WHERE message_id = ? AND files IS NOT ?').run(files, messageId, files);
}

/** The search text of a message (slice 7): the start of its body's text, or null when none was fetched. */
export function searchText(store: MailStore, messageId: string): string | null {
  return store.one<{ text: string }>('SELECT text FROM mail_text WHERE message_id = ?', messageId)?.text ?? null;
}

/**
 * A body's text into the search text: its first MAIL_LIMITS.textBytes, or for a kept account all of it up to
 * MAIL_LIMITS.keepTextBytes, with `cut` saying where it was cut (0: whole). A kept account's message with no text at
 * all gets an empty row too, so it counts as done.
 */
export function putText(store: MailStore, messageId: string, text: string | null, kept = false) {
  if (!text && !kept) return;
  const cap = kept ? MAIL_LIMITS.keepTextBytes : MAIL_LIMITS.textBytes;
  const all = text ?? '';
  const t = all.length > cap ? all.slice(0, cap) : all;
  store.db
    .query(
      `INSERT INTO mail_text (message_id, text, bytes, received_at, cut) SELECT id, ?, ?, received_at, ? FROM mail_message WHERE id = ?
       ON CONFLICT (message_id) DO UPDATE SET text = excluded.text, bytes = excluded.bytes, cut = excluded.cut`,
    )
    .run(t, Buffer.byteLength(t), t.length < all.length ? cap : 0, messageId);
}

/** As SQL over mail_text `t`: its text is all a kept account keeps of the body (whole, or cut only at the kept cap). */
export const TEXT_KEPT = `(t.cut = 0 OR t.cut >= ${MAIL_LIMITS.keepTextBytes})`;

export class BodyCache {
  private timer: Timer | null = null;

  constructor(
    private store: MailStore,
    private now: () => number = Date.now,
  ) {}

  /** Bytes held under the caps (accounts that do not keep all their mail): bodies, search text. */
  sizes(): { bodies: number; text: number } {
    return { bodies: this.capped('mail_body'), text: this.capped('mail_text') };
  }

  /** Bytes in a table that count against its cap: those of messages of accounts that do not keep all their mail. */
  private capped(table: 'mail_body' | 'mail_text'): number {
    return this.store.one<{ n: number | null }>(`SELECT SUM(x.bytes) AS n FROM ${table} x JOIN mail_message m ON m.id = x.message_id WHERE m.account_id NOT IN (${this.store.keptSql})`)?.n ?? 0;
  }

  /** A body came: the caps are checked a few seconds later, once for a run of them. */
  stored() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.sweep();
      } catch {
        // The database closed: the hub is stopping.
      }
    }, 5_000);
    this.timer.unref?.();
  }

  /** The hub stopped (MailHub.stopping). */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
      let total = this.capped('mail_body');
      if (total <= cap) return;
      const target = cap * 0.9;
      const del = st.db.query('DELETE FROM mail_body WHERE message_id = ?');
      while (total > target) {
        const batch = st.all<{ message_id: string; bytes: number }>(
          `SELECT b.message_id, b.bytes FROM mail_body b JOIN mail_message m ON m.id = b.message_id
           WHERE b.keep <= 0 AND m.flagged = 0 AND m.account_id NOT IN (${st.keptSql}) ORDER BY b.used_at, b.message_id LIMIT 500`,
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
    let total = this.capped('mail_text');
    if (total <= cap) return 0;
    const target = cap * 0.9;
    let n = 0;
    st.db.transaction(() => {
      const del = st.db.query('DELETE FROM mail_text WHERE message_id = ?');
      while (total > target) {
        const batch = st.all<{ message_id: string; bytes: number }>(
          `SELECT t.message_id, t.bytes FROM mail_text t JOIN mail_message m ON m.id = t.message_id WHERE m.account_id NOT IN (${st.keptSql}) ORDER BY t.received_at, t.message_id LIMIT 500`,
        );
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
