/**
 * The Triage board's lists, and every count shown from them: the board's own numbers and the badge on the inbox
 * button and the phone's Triage tab. One place, so they cannot disagree (docs/notifications.md#voting). Pure:
 * model.ts and ui/Inbox.tsx hand it what they know.
 */
import type * as P from '@dither-chat/protocol';

/** Where a message is now: your vote, else the decision. */
export const levelOf = (t: P.TriageView): P.TriageDecision => t.feedback ?? t.decision;

/** Important, Active and Digest cover the last week, as the hub's inbox does. */
export const BOARD_DAYS = 7;
/** Not interesting covers the last two days (the hub sends those only), the closest first. */
export const BELOW_DAYS = 2;
export const BELOW_SHOWN = 30;

/** A chat message, or a mail message triage decided on (slice 9): the board lists both by the same levels. */
export type BoardItem = P.MessageView | P.MailTriageItem;
export const isMailItem = (m: BoardItem): m is P.MailTriageItem => (m as P.MailTriageItem).kind === 'mail';

export interface Board<T extends { ts: number; triage?: P.TriageView | null } = BoardItem> {
  important: T[];
  active: T[];
  digest: T[];
  below: T[];
  /** Important messages you have not read: the badge. */
  importantUnread: number;
}

export function triageBoard<T extends { ts: number; triage?: P.TriageView | null }>(items: T[], o: { now: number; shown: (m: T) => boolean; unread: (m: T) => boolean }): Board<T> {
  const week = o.now - BOARD_DAYS * 86_400_000;
  const recent = items.filter((m) => m.triage && m.triage.decision !== 'silent' && m.ts > week && o.shown(m));
  const at = (l: P.TriageDecision) => recent.filter((m) => levelOf(m.triage!) === l);
  const newest = (a: T, b: T) => b.ts - a.ts;
  // What matters most first, as the model sees it; then the newest.
  const byScore = (a: T, b: T) => (b.triage!.score ?? 0) - (a.triage!.score ?? 0) || b.ts - a.ts;
  const important = at('push').sort(newest);
  const twoDays = o.now - BELOW_DAYS * 86_400_000;
  return {
    important,
    active: at('quiet').sort(newest),
    digest: at('digest').sort(byScore),
    below: at('drop')
      .filter((m) => m.ts > twoDays)
      .sort(byScore)
      .slice(0, BELOW_SHOWN),
    importantUnread: important.filter(o.unread).length,
  };
}
