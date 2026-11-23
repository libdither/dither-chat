/**
 * Rungs (docs/mail.md "Mail as chats", "What they wrote elsewhere"): how a place shows in a view, when you chose
 * (protocol RUNGS: hidden, its row closed, its row open; place_rung, PUT /api/rungs). Without a choice the view decides:
 * a person's chat opens the row of a thread that awaits you (`AWAITS_MS`, mail/chatpage.ts) and closes the rest.
 *
 * For now the one view that uses them is a person's chat, and the one kind of place a mail thread with others in it.
 */
import type { Database } from 'bun:sqlite';
import { RUNGS, type PlaceRungView, type Rung } from '@dither-chat/protocol';

/** How long a message to you can still await you: a week. */
export const AWAITS_MS = 7 * 24 * 3_600_000;
/** An excerpt: the text above the quote, at most this many lines and characters. */
const EXCERPT_LINES = 3;
const EXCERPT_CHARS = 280;

export const isRung = (x: unknown): x is Rung => typeof x === 'string' && (RUNGS as readonly string[]).includes(x);

/**
 * The text an excerpt shows: up to EXCERPT_LINES non-blank lines, cut at EXCERPT_CHARS, without what is certainly not
 * the message (docs/mail.md "Mail as chats"): a signature after a "-- " line, and a last line that is only the
 * sender's name (`name`, first or full), which their row already says.
 */
export function excerptOf(text: string | null | undefined, name?: string | null): string | undefined {
  if (!text) return undefined;
  let all = text.split('\n').map((l) => l.trimEnd());
  const sig = all.findIndex((l) => l === '--');
  if (sig >= 0) all = all.slice(0, sig);
  const names = new Set([name?.trim(), name?.trim().split(/\s+/)[0]].filter(Boolean).map((n) => n!.toLowerCase()));
  all = all.filter((l) => l.trim());
  if (all.length > 1 && names.has(all[all.length - 1].trim().replace(/[.,!]$/, '').toLowerCase())) all.pop();
  let t = all.slice(0, EXCERPT_LINES).join('\n').trim();
  if (!t) return undefined;
  if (t.length > EXCERPT_CHARS) t = t.slice(0, EXCERPT_CHARS - 1).trimEnd() + '…';
  return t;
}

type Row = Record<string, any>;

/** Every choice you made; for one view only with `view`. Rows of a rung no longer known are left out. */
export function placeRungs(db: Database, view?: string): PlaceRungView[] {
  const rows = (view ? db.query('SELECT * FROM place_rung WHERE view_id = ?').all(view) : db.query('SELECT * FROM place_rung').all()) as Row[];
  return rows.filter((r) => isRung(r.rung)).map((r) => ({ view: r.view_id, place: r.place_id, rung: r.rung as Rung, setAt: r.set_at }));
}

/** Choose how a place shows in a view, or (null) take the choice back. */
export function setPlaceRung(db: Database, view: string, place: string, rung: Rung | null, now = Date.now()) {
  if (rung === null) db.query('DELETE FROM place_rung WHERE view_id = ? AND place_id = ?').run(view, place);
  else
    db.query(
      `INSERT INTO place_rung (view_id, place_id, rung, set_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (view_id, place_id) DO UPDATE SET rung = excluded.rung, set_at = excluded.set_at`,
    ).run(view, place, rung, now);
}
