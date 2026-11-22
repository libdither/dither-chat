/**
 * One message's history as one list (docs/history.md "A message's history"): its edits, reactions made and taken
 * back, pins, and for your own who got and read it, oldest first so the latest is at the bottom, as in a chat. Opened
 * on all of it, or on only its edits (from "(edited)" and the words an edit put in) or only its reactions (a long
 * press on one, on a phone), with a way from either to all of it. On its own, not in ui/MessageHistory.tsx, so the
 * chat and the reaction pills can open it without importing the list (docs/testing.md "Import cycles"); its rows are
 * in historyRows.ts, loaded with the list.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';

export type HistoryFocus = 'all' | 'edits' | 'reactions';

/** The history open now: whose, on what, and on a computer what it hangs from (none: the middle of the window). */
export const historyOf = signal<{ m: P.MessageView; focus: HistoryFocus; anchor?: DOMRect } | null>(null);

export function openHistory(m: P.MessageView, focus: HistoryFocus = 'all', anchor?: DOMRect) {
  historyOf.value = { m, focus, anchor };
}

/** Whether there is anything to show beyond the message itself: a reaction with a time counts. */
export const hasHistory = (m: P.MessageView) => !!(m.edits || m.events || m.receipts || m.reactions.some((r) => r.at || r.seenAt));
