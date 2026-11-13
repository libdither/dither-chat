/**
 * Messages you saved on a network, and the reminders you set there (docs/sending.md "Saved on Discord"). The network
 * keeps them; the hub keeps what it last heard, so the message menu knows Save from Remove without asking, and asks
 * the network afresh only when you open the list (capability 'savedMessages').
 *
 * They are not the hub's own marks: a saved message is not "Reply needed", and a reminder is not Catch up's Later
 * (which lasts a session). Each side keeps its own; nothing here changes the other. A reminder that comes due on the
 * network notifies like an alert (server.ts `onSavedReminder`), held quiet in quiet hours.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { AccountRow, Store } from './store.ts';

type Row = Record<string, any>;

const made = new WeakSet<Database>();
export function savedTables(db: Database) {
  if (made.has(db)) return;
  db.run(`CREATE TABLE IF NOT EXISTS saved_message (
    account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    message_id      TEXT NOT NULL,
    conversation_id TEXT,
    saved_at        INTEGER NOT NULL,
    due_at          INTEGER,
    note            TEXT,
    summary         TEXT,
    PRIMARY KEY (account_id, message_id)
  )`);
  made.add(db);
}

/** A reminder that came due, in hub ids, for whoever notifies. */
export interface DueReminder {
  accountId: string;
  messageId: string;
  conversationId: string | null;
  dueAt: number | null;
  summary: P.SavedFact['summary'] | null;
}

const isFact = (x: unknown): x is P.SavedFact => {
  const f = x as P.SavedFact;
  return !!f && typeof f === 'object' && typeof f.message === 'string' && !!f.message && typeof f.savedAt === 'number' && Number.isFinite(f.savedAt);
};

function put(db: Database, acc: AccountRow, f: P.SavedFact) {
  const net = acc.network as P.Network;
  db.query(
    `INSERT INTO saved_message (account_id, message_id, conversation_id, saved_at, due_at, note, summary) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, message_id) DO UPDATE SET conversation_id = COALESCE(excluded.conversation_id, conversation_id),
       saved_at = excluded.saved_at, due_at = excluded.due_at, note = excluded.note, summary = COALESCE(excluded.summary, summary)`,
  ).run(
    acc.id,
    hubId('msg', net, f.message),
    f.conversation ? hubId('cnv', net, f.conversation) : null,
    f.savedAt,
    typeof f.dueAt === 'number' && Number.isFinite(f.dueAt) ? f.dueAt : null,
    typeof f.note === 'string' && f.note ? f.note.slice(0, 2000) : null,
    f.summary && typeof f.summary === 'object' ? JSON.stringify(f.summary) : null,
  );
}

/** Keep what a savedList answered: these, and (`complete`) only these. */
export function keepSaved(db: Database, acc: AccountRow, saved: P.SavedFact[], complete: boolean) {
  savedTables(db);
  if (complete) db.query('DELETE FROM saved_message WHERE account_id = ?').run(acc.id);
  for (const f of saved) if (isFact(f)) put(db, acc, f);
}

/** An adapter's saved, unsaved and reminderDue events (store.ts ingest). A due reminder goes to `due`. */
export function ingestSaved(store: Store, acc: AccountRow, ev: P.AdapterEvent, due: (r: DueReminder) => void) {
  const db = store.db;
  savedTables(db);
  const net = acc.network as P.Network;
  switch (ev.t) {
    case 'saved':
      keepSaved(db, acc, Array.isArray(ev.saved) ? ev.saved : [], ev.complete === true);
      break;
    case 'unsaved':
      if (typeof ev.message === 'string') db.query('DELETE FROM saved_message WHERE account_id = ? AND message_id = ?').run(acc.id, hubId('msg', net, ev.message));
      break;
    case 'reminderDue': {
      if (!isFact(ev.saved)) break;
      put(db, acc, ev.saved);
      due({
        accountId: acc.id,
        messageId: hubId('msg', net, ev.saved.message),
        conversationId: ev.saved.conversation ? hubId('cnv', net, ev.saved.conversation) : null,
        dueAt: ev.saved.dueAt ?? null,
        summary: ev.saved.summary ?? null,
      });
      break;
    }
  }
}

/** What the hub last heard, newest saved first; reminders due soonest come first. */
export function savedViews(db: Database, accountIds?: string[]): P.SavedView[] {
  savedTables(db);
  const rows = db.query('SELECT * FROM saved_message ORDER BY due_at IS NULL, due_at, saved_at DESC').all() as Row[];
  return rows
    .filter((r) => !accountIds || accountIds.includes(r.account_id))
    .map((r) => ({
      accountId: r.account_id,
      messageId: r.message_id,
      conversationId: r.conversation_id ?? (db.query('SELECT conversation_id FROM message WHERE id = ?').get(r.message_id) as Row | null)?.conversation_id ?? null,
      savedAt: r.saved_at,
      dueAt: r.due_at ?? null,
      note: r.note ?? null,
      summary: r.summary ? JSON.parse(r.summary) : null,
    }));
}

/** The words of a due reminder's notification: who wrote it and what, from the stored message or the network's summary. */
export function reminderWords(db: Database, r: DueReminder): { title: string; body: string; conversationId: string | null } {
  const m = db
    .query(`SELECT m.body, m.conversation_id, COALESCE(i.display_name, i.handle) AS who FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.id = ?`)
    .get(r.messageId) as Row | null;
  const who = m?.who ?? r.summary?.author ?? null;
  const text = (m?.body ?? r.summary?.text ?? '').trim();
  return {
    title: who ? `Reminder: ${who}` : 'Reminder',
    body: text ? (text.length > 200 ? `${text.slice(0, 199)}…` : text) : 'A message you asked Discord to remind you about',
    conversationId: m?.conversation_id ?? r.conversationId,
  };
}
