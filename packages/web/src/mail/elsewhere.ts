/**
 * What a person wrote elsewhere, as their chat draws it (docs/mail.md "Mail as chats", "What they wrote elsewhere";
 * ui/MailChat.tsx ElsewhereRows): one row per thread at their newest message there, and whether a row is open. Pure, so
 * tests can import it.
 */
import type * as P from '@dither-chat/protocol';

/** One row: a thread, at its newest message of theirs. */
export interface ElsewhereRow {
  place: string;
  /** Their newest message there: its time, subject and text are the row's. */
  e: P.ElsewhereView;
  ts: number;
  /** One of their messages there awaits you. */
  waits: boolean;
}

/** What a person wrote elsewhere as rows, one per thread at its newest message, oldest first. */
export function threadRows(items: P.ElsewhereView[]): ElsewhereRow[] {
  const by = new Map<string, ElsewhereRow>();
  for (const e of items) {
    const had = by.get(e.place);
    const waits = e.awaits || !!had?.waits;
    by.set(e.place, !had || e.ts >= had.ts ? { place: e.place, e, ts: e.ts, waits } : { ...had, waits });
  }
  return [...by.values()].sort((a, b) => a.ts - b.ts || (a.e.messageId < b.e.messageId ? -1 : 1));
}

/**
 * Whether a row shows its text: as you left it (`chosen`, PUT /api/rungs), else open while it waits on you. A choice
 * made before newer mail came to the thread was for the row it was then, so the new row starts as rows do.
 */
export function rowOpen(chosen: P.PlaceRungView | null, r: ElsewhereRow): boolean {
  return chosen && chosen.rung !== 'hidden' && chosen.setAt >= r.ts ? chosen.rung === 'open' : r.waits;
}

/** What a click on a row's header line chooses: the other state, or nothing when that is how it would show anyway. */
export const toggled = (open: boolean, r: ElsewhereRow): P.Rung | null => (!open === r.waits ? null : !open ? 'open' : 'closed');
