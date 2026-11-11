/**
 * Which tier triage put each message in this week, and every count shown from that: How it sorts
 * (ui/HowItSorts.tsx), its numbers, and the badge on the inbox button and the phone's Catch up tab. One place, so
 * they cannot disagree (docs/notifications.md). Pure: model.ts and the page hand it what they know.
 *
 * A message is listed by what was decided. Your marks on it (marks.ts) teach the next decision; they do not move this
 * one, and neither does a vote from before the tiers.
 */
import type * as P from '@dither-chat/protocol';

/** Alerts, Conversations and the list cover the last week, as the hub's inbox does. */
export const BOARD_DAYS = 7;
/** Below the list covers the last two days (the hub sends those only), the most important first. */
export const BELOW_DAYS = 2;
export const BELOW_SHOWN = 40;

/** A chat message, or a mail message triage decided on (slice 9): both are listed by the same tiers. */
export type BoardItem = P.MessageView | P.MailTriageItem;
export const isMailItem = (m: BoardItem): m is P.MailTriageItem => (m as P.MailTriageItem).kind === 'mail';

export interface Board<T extends { id: string; ts: number; triage?: P.TriageView | null } = BoardItem> {
  alerts: T[];
  conversations: T[];
  list: T[];
  below: T[];
  /** Alerts you have not read, and Conversation messages you have not read: together, the badge. */
  alertsUnread: number;
  conversationsUnread: number;
}

export function triageBoard<T extends { id: string; ts: number; triage?: P.TriageView | null }>(items: T[], o: { now: number; shown: (m: T) => boolean; unread: (m: T) => boolean }): Board<T> {
  const week = o.now - BOARD_DAYS * 86_400_000;
  const recent = items.filter((m) => m.triage && m.triage.decision !== 'silent' && m.ts > week && o.shown(m));
  const at = (d: P.TriageDecision) => recent.filter((m) => m.triage!.decision === d);
  // Two that came at once keep one order, whichever of them the hub sent last: a mark must not make a line jump.
  const newest = (a: T, b: T) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // The most important first, as the model sees it; then the newest.
  const byImportance = (a: T, b: T) => (b.triage!.score ?? 0) - (a.triage!.score ?? 0) || newest(a, b);
  const alerts = at('push').sort(newest);
  const conversations = at('quiet').sort(newest);
  const twoDays = o.now - BELOW_DAYS * 86_400_000;
  return {
    alerts,
    conversations,
    list: at('digest').sort(byImportance),
    below: at('drop')
      .filter((m) => m.ts > twoDays)
      .sort(byImportance)
      .slice(0, BELOW_SHOWN),
    alertsUnread: alerts.filter(o.unread).length,
    conversationsUnread: conversations.filter(o.unread).length,
  };
}

/** One line of How it sorts: a conversation's (or a mail thread's) messages in one tier. */
export interface BoardLine<T extends { ts: number } = BoardItem> {
  key: string;
  /** In the list's order. */
  items: T[];
  /** The newest of them: the line's marks are on it. */
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

/** The highest importance among these messages, 0 to 1; null when none has one. */
export function topImportance(items: { triage?: P.TriageView | null }[]): number | null {
  let best: number | null = null;
  for (const m of items) if (typeof m.triage?.score === 'number' && (best === null || m.triage.score > best)) best = m.triage.score;
  return best;
}

/** The highest tier among these messages; null for none. */
export function topTier(items: { triage?: P.TriageView | null }[]): P.NotifyTier | null {
  const order: P.TriageDecision[] = ['drop', 'digest', 'quiet', 'push'];
  let best = -1;
  for (const m of items) if (m.triage && m.triage.decision !== 'silent') best = Math.max(best, order.indexOf(m.triage.decision));
  return best < 0 ? null : (order[best] as P.NotifyTier);
}

/**
 * "about 17 chats a day at this level (last week)": what the list would have held at a level, from the hub's preview
 * (one row for each tenth). Whole numbers, and one decimal under three a day; null when the hub has no row for it.
 */
export function listPreview(preview: P.TriagePolicyView['preview'], level: number): string | null {
  const step = Math.round(level * 10);
  const n = preview.find((x) => Math.round(x.level * 10) === step)?.perDay;
  return n === undefined ? null : `about ${n < 3 ? n : Math.round(n)} ${n === 1 ? 'chat' : 'chats'} a day at this level (last week)`;
}
