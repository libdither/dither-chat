/**
 * Mark Unread from a message on (a message's menu): the read point moves back to just before it on every account
 * that sees its conversation, the unread and mentions after it are counted again, and each network that can is told
 * the same way its own client says it (capability 'markUnread': Discord's manual ack). A network marked unread in its
 * own app comes the other way, as a `read` event with `manual` (store.ts).
 */
import type * as P from '@dither-chat/protocol';
import { requestHeld } from './add.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

interface Link {
  online(accountId: string): boolean;
  command(accountId: string, cmd: { t: 'markUnread'; conversation: string; from: string }, timeoutMs?: number): Promise<unknown>;
}

/** Unread from this message on, here at once and on the networks soon. Null: no such message. */
export function markUnreadFrom(store: Store, link: Link, messageId: string): { conversationId: string; told: string[] } | null {
  const db = store.db;
  const m = db.query('SELECT conversation_id, ts, native_id FROM message WHERE id = ?').get(messageId) as Row | null;
  if (!m) return null;
  const upTo = (m.ts as number) - 1;
  const vs = db.query(`SELECT v.account_id, a.self_identity, a.capabilities FROM vantage v JOIN account a ON a.id = v.account_id WHERE v.target_kind = 'conversation' AND v.target_id = ?`).all(m.conversation_id) as Row[];
  for (const v of vs) {
    const c = db
      .query(
        `SELECT COUNT(*) AS unread, COALESCE(SUM(m.mentions_self), 0) AS mentions FROM message m
         JOIN message_seen s ON s.message_id = m.id AND s.account_id = ?
         WHERE m.conversation_id = ? AND m.ts > ? AND m.deleted = 0 AND (m.author_id IS NULL OR m.author_id != ?)`,
      )
      .get(v.account_id, m.conversation_id, upTo, v.self_identity ?? '') as Row;
    db.query(`UPDATE vantage SET last_read_ts = ?, unread = ?, mentions = ? WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`).run(upTo, c.unread, c.mentions, v.account_id, m.conversation_id);
  }
  store.dirty.conversations.add(m.conversation_id);
  const conv = store.nativeOf('conversation', m.conversation_id);
  const told: string[] = [];
  // An open message request tells the sender nothing until it is accepted (add.ts).
  if (conv && !requestHeld(db, m.conversation_id))
    for (const v of vs) {
      let caps: P.Capability[] = [];
      try {
        caps = JSON.parse(v.capabilities ?? '[]');
      } catch {}
      if (!caps.includes('markUnread') || !link.online(v.account_id)) continue;
      told.push(v.account_id);
      link.command(v.account_id, { t: 'markUnread', conversation: conv.nativeId, from: m.native_id }).catch(() => {});
    }
  return { conversationId: m.conversation_id, told };
}
