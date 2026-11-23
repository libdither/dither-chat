/**
 * Rungs (docs/mail.md "Mail as chats"): how much of something a view shows, from left out to a notification
 * (protocol RUNGS). A view gives each thing a default rung (`defaultRung`); a rung you chose for a place in a view
 * (place_rung, PUT /api/rungs) stands over the default for everything from that place.
 *
 * For now the one view that uses them is a person's chat, and the one kind of thing is what they wrote in a mail thread
 * with others (mail/places.ts `elsewhere`).
 */
import type { Database } from 'bun:sqlite';
import { RUNGS, type PlaceRungView, type Rung } from '@dither-chat/protocol';

/** How long a message to you can still await you: a week. */
export const AWAITS_MS = 7 * 24 * 3_600_000;
/** An excerpt: the text above the quote, at most this many lines and characters. */
const EXCERPT_LINES = 3;
const EXCERPT_CHARS = 280;
/** Excerpts by default between two of the chat's own messages; the rest of that gap's are links. */
export const EXCERPTS_PER_GAP = 2;

/** What a view decides by itself about one thing in it. */
interface RungItem {
  /** It is to you, under AWAITS_MS old, and you have neither answered nor opened its place since. */
  awaits: boolean;
}

/** The rung a thing gets in a view when you chose none for its place, and why. */
export function defaultRung(_view: string, item: RungItem): { rung: Rung; why: 'awaits' | 'elsewhere' } {
  return item.awaits ? { rung: 'excerpt', why: 'awaits' } : { rung: 'link', why: 'elsewhere' };
}

export const isRung = (x: unknown): x is Rung => typeof x === 'string' && (RUNGS as readonly string[]).includes(x);

/** The text an excerpt shows: up to EXCERPT_LINES non-blank lines, cut at EXCERPT_CHARS. */
export function excerptOf(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, EXCERPT_LINES);
  let t = lines.join('\n').trim();
  if (!t) return undefined;
  if (t.length > EXCERPT_CHARS) t = t.slice(0, EXCERPT_CHARS - 1).trimEnd() + '…';
  return t;
}

type Row = Record<string, any>;

/** Every rung you chose; for one view only with `view`. */
export function placeRungs(db: Database, view?: string): PlaceRungView[] {
  const rows = (view ? db.query('SELECT * FROM place_rung WHERE view_id = ?').all(view) : db.query('SELECT * FROM place_rung').all()) as Row[];
  return rows.filter((r) => isRung(r.rung)).map((r) => ({ view: r.view_id, place: r.place_id, rung: r.rung as Rung, setAt: r.set_at }));
}

/** Choose a rung for a place in a view, or (null) take the choice back. */
export function setPlaceRung(db: Database, view: string, place: string, rung: Rung | null, now = Date.now()) {
  if (rung === null) db.query('DELETE FROM place_rung WHERE view_id = ? AND place_id = ?').run(view, place);
  else
    db.query(
      `INSERT INTO place_rung (view_id, place_id, rung, set_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (view_id, place_id) DO UPDATE SET rung = excluded.rung, set_at = excluded.set_at`,
    ).run(view, place, rung, now);
}
