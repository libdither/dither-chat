/**
 * Where triage put each message this week, and every count shown from that: How it sorts (ui/HowItSorts.tsx), its
 * numbers, and the badge on the inbox button and the phone's Catch up tab. One place, so they cannot disagree
 * (docs/notifications.md#voting). Pure: model.ts and the page hand it what they know.
 */
import type * as P from '@dither-chat/protocol';

/** Where a message is now: your vote, else the decision. */
export const levelOf = (t: P.TriageView): P.TriageDecision => t.feedback ?? t.decision;

/** Important, Active and Digest cover the last week, as the hub's inbox does. */
export const BOARD_DAYS = 7;
/** Not interesting covers the last two days (the hub sends those only), the closest first. */
export const BELOW_DAYS = 2;
export const BELOW_SHOWN = 30;

/** A chat message, or a mail message triage decided on (slice 9): both are listed by the same levels. */
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

/** One line of How it sorts: a conversation's (or a mail thread's) messages at one level. */
export interface BoardLine<T extends { ts: number } = BoardItem> {
  key: string;
  /** In the list's order. */
  items: T[];
  /** The newest of them: the line's vote is on it. */
  newest: T;
}

/** A list's messages, one line per conversation, each where its first message in the list is. */
export function linesOf<T extends { ts: number }>(items: T[], keyOf: (m: T) => string): BoardLine<T>[] {
  const by = new Map<string, BoardLine<T>>();
  for (const m of items) {
    const k = keyOf(m);
    const l = by.get(k);
    if (!l) by.set(k, { key: k, items: [m], newest: m });
    else {
      l.items.push(m);
      if (m.ts > l.newest.ts) l.newest = m;
    }
  }
  return [...by.values()];
}

/** Where a board item belongs: its conversation, or its mail thread. */
export const lineKey = (m: BoardItem) => (isMailItem(m) ? m.threadId : m.conversationId);

/** A line's reasons, each once, with how many of its messages gave it: the commonest first, then as they came. */
export function reasonsOf(items: { triage?: P.TriageView | null }[]): { text: string; n: number }[] {
  const out = new Map<string, number>();
  for (const m of items) for (const r of new Set(m.triage?.reasons ?? [])) out.set(r, (out.get(r) ?? 0) + 1);
  return [...out].map(([text, n]) => ({ text, n })).sort((a, b) => b.n - a.n);
}

/** The highest level among these messages, by where each is now; null for none. */
export function topLevel(items: { triage?: P.TriageView | null }[]): P.NotifyTier | null {
  const order: P.TriageDecision[] = ['drop', 'digest', 'quiet', 'push'];
  let best = -1;
  for (const m of items) if (m.triage && m.triage.decision !== 'silent') best = Math.max(best, order.indexOf(levelOf(m.triage)));
  return best < 0 ? null : (order[best] as P.NotifyTier);
}
