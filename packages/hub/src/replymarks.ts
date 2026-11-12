/**
 * Your marks on whether a message needs a reply (docs/inbox.md, "Marks"): "No reply needed" (`none`) and "Reply
 * needed" (`needs`). The observed reply is what the owed table learns from (owed.ts); a mark says outright what you
 * want, and overrides it:
 *
 * - `none` on a message settles what was owed up to it, as a reaction would, but counts as dismissed, not answered.
 * - `needs` keeps the turn owed in full for NEEDS_HOLD, until you answer. It moves the row, and never notifies.
 *
 * A mark is on a message. It covers the whole chat as you see it: `none` on a DM also settles each other route of the
 * same person up to that time (rows that point at the mark you made, `origin_id`), and undoing it undoes them. The
 * fold reads marks with the messages (attention.ts FOLD_SQL, mail/attention.ts), and a change folds the conversation
 * again, as your reactions do. Marks are not part of the activity log: deleting the log keeps them.
 */
import type * as P from '@dither-chat/protocol';
import type { Store } from './store.ts';

type Row = Record<string, any>;

const DAY = 24 * 60 * 60_000;
/** "Reply needed" holds the turn this long after the mark, unless you answer first. */
export const NEEDS_HOLD = 7 * DAY;

export type ReplyMark = P.ReplyMark;
export const REPLY_MARKS: readonly ReplyMark[] = ['none', 'needs'];
/** Where the mark was made: an inbox row's menu, a message's menu, or (later) a notification. */
export type MarkSurface = 'row' | 'message' | 'notification';
const SURFACES: readonly MarkSurface[] = ['row', 'message', 'notification'];

export interface MarkOptions {
  surface?: string | null;
  device?: string | null;
  now?: number;
}

/** Identities that are you (rankhistory.ts SELF_SQL). */
const SELF = `(SELECT self_identity FROM account WHERE self_identity IS NOT NULL UNION SELECT i.id FROM person p CROSS JOIN identity i ON i.person_id = p.id WHERE p.is_self = 1)`;
/** A message from someone else, not deleted, not a system line. */
const FROM_OTHERS = `m.deleted = 0 AND m.kind != 'system' AND (m.author_id IS NULL OR m.author_id NOT IN ${SELF})`;

export class ReplyMarks {
  constructor(private store: Store) {}

  private get db() {
    return this.store.db;
  }

  /** The live mark on a message, if any. */
  markOf(messageId: string): ReplyMark | null {
    return ((this.db.query('SELECT mark FROM reply_mark WHERE message_id = ? AND undone_at IS NULL').get(messageId) as Row | null)?.mark as ReplyMark) ?? null;
  }

  /** The open turn of a conversation, as the fold has it: from when, and since its first message for you. */
  private turnOf(cid: string): { since: number; addressed: number | null } | null {
    const r = this.db.query(`SELECT json_extract(state, '$.turn.since') AS since, json_extract(state, '$.turn.addressed') AS addressed FROM conv_feature WHERE conversation_id = ?`).get(cid) as Row | null;
    return r?.since != null ? { since: r.since, addressed: r.addressed ?? null } : null;
  }

  /** The newest message from someone else in a conversation, from `from` up to `to`. */
  private newestFromOthers(cid: string, from: number, to = Number.MAX_SAFE_INTEGER): string | null {
    return ((this.db.query(`SELECT m.id FROM message m WHERE m.conversation_id = ? AND m.ts >= ? AND m.ts <= ? AND ${FROM_OTHERS} ORDER BY m.ts DESC, m.rowid DESC LIMIT 1`).get(cid, from, to) as Row | null)?.id as string) ?? null;
  }

  /** The other routes of a DM's chat: the person's other DMs (one chat per person, docs/chats.md). */
  routesOf(cid: string): string[] {
    const peer = this.db
      .query(
        `SELECT i.person_id FROM participant pa JOIN identity i ON i.id = pa.identity_id JOIN conversation c ON c.id = pa.conversation_id
         LEFT JOIN person p ON p.id = i.person_id
         WHERE pa.conversation_id = ? AND c.shape = 'direct' AND i.person_id IS NOT NULL AND COALESCE(p.is_self, 0) = 0 AND i.id NOT IN ${SELF} LIMIT 1`,
      )
      .get(cid) as Row | null;
    if (!peer) return [cid];
    const all = (this.db.query(`SELECT DISTINCT c.id FROM conversation c JOIN participant pa ON pa.conversation_id = c.id JOIN identity i ON i.id = pa.identity_id WHERE c.shape = 'direct' AND i.person_id = ?`).all(peer.person_id) as Row[]).map((r) => r.id as string);
    return [cid, ...all.filter((x) => x !== cid)];
  }

  private put(messageId: string, kind: 'message' | 'mail', cid: string, mark: ReplyMark, o: MarkOptions, origin: string | null, replace: boolean) {
    const surface = SURFACES.includes(o.surface as MarkSurface) ? (o.surface as MarkSurface) : null;
    const device = typeof o.device === 'string' && o.device.length <= 64 ? o.device : null;
    this.db
      .query(
        `INSERT INTO reply_mark (message_id, target_kind, conversation_id, mark, at, surface, device, undone_at, origin_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (message_id) DO UPDATE SET mark = excluded.mark, at = excluded.at, surface = excluded.surface, device = excluded.device, undone_at = NULL, origin_id = excluded.origin_id
         WHERE ? OR reply_mark.undone_at IS NOT NULL`,
      )
      .run(messageId, kind, cid, mark, o.now ?? Date.now(), surface, device, origin, replace ? 1 : 0);
  }

  /** Undo a mark and the rows it made on other routes; returns the messages and conversations it touched. */
  private undo(messageId: string, now: number): { messages: string[]; conversations: string[] } {
    const rows = this.db.query('SELECT message_id, conversation_id FROM reply_mark WHERE (message_id = ? OR origin_id = ?) AND undone_at IS NULL').all(messageId, messageId) as Row[];
    this.db.query('UPDATE reply_mark SET undone_at = ? WHERE (message_id = ? OR origin_id = ?) AND undone_at IS NULL').run(now, messageId, messageId);
    return { messages: rows.map((r) => r.message_id), conversations: rows.map((r) => r.conversation_id) };
  }

  /**
   * Mark a chat message (null takes the mark back). `none` also settles each other route of the chat whose open turn
   * began by then, up to the newest message from them there at or before this one. Returns the messages marked or
   * unmarked, or null when there is no such message from someone else.
   */
  setMessage(messageId: string, mark: ReplyMark | null, o: MarkOptions = {}): { marked: string[]; conversations: string[] } | null {
    const now = o.now ?? Date.now();
    const m = this.db.query(`SELECT m.id, m.conversation_id AS cid, m.ts FROM message m WHERE m.id = ? AND ${FROM_OTHERS}`).get(messageId) as Row | null;
    if (!m) return null;
    const touched = { marked: [] as string[], conversations: new Set<string>([m.cid]) };
    this.db.transaction(() => {
      const was = this.undo(messageId, now);
      touched.marked.push(...was.messages);
      was.conversations.forEach((c) => touched.conversations.add(c));
      if (!mark) return;
      this.put(messageId, 'message', m.cid, mark, o, null, true);
      touched.marked.push(messageId);
      if (mark !== 'none') return;
      for (const r of this.routesOf(m.cid).slice(1)) {
        const t = this.turnOf(r);
        if (t?.addressed == null || t.addressed > m.ts) continue;
        const other = this.newestFromOthers(r, t.since, m.ts);
        if (!other) continue;
        this.put(other, 'message', r, 'none', o, messageId, false);
        touched.marked.push(other);
        touched.conversations.add(r);
      }
    })();
    this.changed(touched.marked, [...touched.conversations]);
    return { marked: [...new Set(touched.marked)], conversations: [...touched.conversations] };
  }

  /**
   * Mark an inbox row: a conversation, or each route of a chat of several. `none` marks the newest message from
   * someone else in each route's open turn; `needs` the newest such message of them all. Returns the messages marked,
   * for an undo.
   */
  setRow(conversationIds: string[], mark: ReplyMark | null, o: MarkOptions = {}): { marked: string[] } {
    const routes = [...new Set(conversationIds.flatMap((c) => this.routesOf(c)))];
    if (mark === null) return this.unholdRow(routes, o.now ?? Date.now());
    const open = routes
      .map((cid) => ({ cid, t: this.turnOf(cid) }))
      .filter((x): x is { cid: string; t: { since: number; addressed: number } } => x.t?.addressed != null)
      .map((x) => ({ ...x, id: this.newestFromOthers(x.cid, x.t.since) }))
      .filter((x): x is typeof x & { id: string } => !!x.id);
    if (!open.length) return { marked: [] };
    const ts = (id: string) => (this.db.query('SELECT ts FROM message WHERE id = ?').get(id) as Row).ts as number;
    const targets = mark === 'needs' ? [open.reduce((a, b) => (ts(b.id) > ts(a.id) ? b : a))] : open;
    const marked: string[] = [];
    this.db.transaction(() => {
      for (const x of targets) {
        this.undo(x.id, o.now ?? Date.now());
        this.put(x.id, 'message', x.cid, mark, o, null, true);
        marked.push(x.id);
      }
    })();
    this.changed(marked, targets.map((x) => x.cid));
    return { marked };
  }

  /** Take back "Reply needed" on the open turns of these routes: the hold on a row, wherever in the turn it is. */
  private unholdRow(routes: string[], now: number): { marked: string[] } {
    const marked: string[] = [];
    const touched: string[] = [];
    this.db.transaction(() => {
      for (const cid of routes) {
        const t = this.turnOf(cid);
        if (!t) continue;
        const ids = (this.db.query(`SELECT rm.message_id FROM reply_mark rm JOIN message m ON m.id = rm.message_id WHERE rm.conversation_id = ? AND rm.mark = 'needs' AND rm.undone_at IS NULL AND m.ts >= ?`).all(cid, t.since) as Row[]).map((r) => r.message_id as string);
        for (const id of ids) marked.push(...this.undo(id, now).messages);
        if (ids.length) touched.push(cid);
      }
    })();
    this.changed(marked, touched);
    return { marked };
  }

  /** A message changed: the views say so, and the conversation folds again (attention.ts, as for your reactions). */
  private changed(messageIds: string[], conversations: string[]) {
    for (const id of messageIds) this.store.dirty.messages.set(id, true);
    for (const c of conversations) this.store.selfReacted.add(c);
  }

  // ---------------------------------------------------------------- mail

  /** Mark a mail message from someone else (null takes it back). Returns its thread, or null when there is no such message. */
  setMail(messageId: string, mark: ReplyMark | null, o: MarkOptions = {}): { threadId: string } | null {
    const m = this.db.query(`SELECT id, thread_id FROM mail_message WHERE id = ? AND addressed != 'self' AND draft = 0`).get(messageId) as Row | null;
    if (!m) return null;
    this.db.transaction(() => {
      this.undo(messageId, o.now ?? Date.now());
      if (mark) this.put(messageId, 'mail', m.thread_id, mark, o, null, true);
    })();
    return { threadId: m.thread_id };
  }

  /** Mark a mail thread's row: its newest message from someone else since the reply you owe began. */
  setMailRow(threadId: string, mark: ReplyMark | null, o: MarkOptions = {}): { marked: string[] } {
    const since = (this.db.query('SELECT owed_since FROM mail_feature WHERE thread_id = ?').get(threadId) as Row | null)?.owed_since;
    if (since == null) return { marked: [] };
    if (mark === null) {
      const ids = (this.db.query(`SELECT rm.message_id FROM reply_mark rm JOIN mail_message mm ON mm.id = rm.message_id WHERE rm.conversation_id = ? AND rm.mark = 'needs' AND rm.undone_at IS NULL AND mm.received_at >= ?`).all(threadId, since) as Row[]).map((r) => r.message_id as string);
      for (const id of ids) this.undo(id, o.now ?? Date.now());
      return { marked: ids };
    }
    const id = (this.db.query(`SELECT id FROM mail_message WHERE thread_id = ? AND addressed != 'self' AND draft = 0 AND received_at >= ? ORDER BY received_at DESC, id DESC LIMIT 1`).get(threadId, since) as Row | null)?.id;
    if (!id) return { marked: [] };
    this.setMail(id, mark, o);
    return { marked: [id] };
  }

  /** Live marks on these mail messages, for the mail fold. */
  mailMarks(ids: string[]): Map<string, { mark: ReplyMark; at: number }> {
    if (!ids.length) return new Map();
    const rows = this.db.query(`SELECT message_id, mark, at FROM reply_mark WHERE target_kind = 'mail' AND undone_at IS NULL AND message_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as Row[];
    return new Map(rows.map((r) => [r.message_id, { mark: r.mark, at: r.at }]));
  }
}

/** A mark as the fold reads it (`mark:at`, FOLD_SQL): `none` clears, `needs` holds from its time. */
export function foldMark(v: unknown): { clearedByMe?: boolean; neededByMe?: number } {
  if (typeof v !== 'string') return {};
  const [mark, at] = v.split(':');
  if (mark === 'none') return { clearedByMe: true };
  if (mark === 'needs' && Number.isFinite(Number(at))) return { neededByMe: Number(at) };
  return {};
}
