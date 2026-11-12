/**
 * Your marks on whether a message needs a reply (docs/inbox.md, "Marks"): "No reply needed" settles what you owed up to
 * the message, "Reply needed" holds the chat near the top until you answer (it never notifies). On a message (its
 * menu's Marks group), or on an inbox row that shows a reply you owe (its menu, under "Why it's here"). The ↩ goes at
 * once; the hub's fold catches up a few seconds later. A toast offers Undo, and picking the ticked mark again takes it
 * back.
 */
import type * as P from '@dither-chat/protocol';
import { deviceId } from './activity.ts';
import { api, applyEvents, db, toast } from './state.ts';

export const REPLY_MARK_LABEL: Record<P.ReplyMark, string> = { none: 'No reply needed', needs: 'Reply needed' };

/**
 * The ↩ off these rows now, as the hub will have it once it has folded the mark. Returns the views as they were, to
 * put back on Undo or a failure: undone within seconds, the hub's view never changed, so no event would restore it.
 */
function hideOwed(ids: string[]): P.AttentionView[] {
  const items = ids.map((id) => db.attention.get(id)).filter((a): a is P.AttentionView => !!a && (a.owedSince !== null || !!a.replyMark));
  if (items.length) applyEvents([{ t: 'attention', items: items.map(({ replyMark: _, ...a }) => ({ ...a, owedSince: null })), removed: [] }]);
  return items;
}

/** Put back views hidden here, unless the hub has sent newer ones since. */
function restore(was: P.AttentionView[]) {
  const items = was.filter((a) => (db.attention.get(a.id)?.at ?? 0) <= a.at);
  if (items.length) applyEvents([{ t: 'attention', items, removed: [] }]);
}

const path = (kind: 'message' | 'mail', id: string) => `/api/${kind === 'mail' ? 'mail/' : ''}messages/${encodeURIComponent(id)}/reply-mark`;

function failed(e: unknown, was: P.AttentionView[] = []) {
  restore(was);
  toast({ kind: 'error', title: 'Could not mark it', body: (e as Error)?.message ?? String(e) });
}

/** Take marks back, by the messages they are on, and the ↩ they hid. */
async function undo(kind: 'message' | 'mail', ids: string[], was: P.AttentionView[]) {
  restore(was);
  try {
    for (const id of ids) await api(path(kind, id), { body: { mark: null, device: deviceId() } });
  } catch (e) {
    failed(e);
  }
}

function undoToast(mark: P.ReplyMark, kind: 'message' | 'mail', ids: string[], was: P.AttentionView[]) {
  if (!ids.length) return;
  toast({
    kind: 'info',
    title: REPLY_MARK_LABEL[mark],
    body: mark === 'none' ? 'It no longer waits on you.' : 'It stays near the top until you answer, for a week at most.',
    actionLabel: 'Undo',
    action: () => void undo(kind, ids, was),
  }, 10_000);
}

/**
 * Mark a message from someone else. The mark it already has, picked again, takes it back. In a chat of several
 * routes, "No reply needed" also settles the other routes up to then (the hub does that).
 */
export async function markMessage(m: Pick<P.MessageView, 'id' | 'conversationId' | 'replyMark'>, mark: P.ReplyMark, kind: 'message' | 'mail' = 'message') {
  const next = m.replyMark === mark ? null : mark;
  const was = next === 'none' ? hideOwed([m.conversationId]) : [];
  try {
    const r = await api<{ marked: string[] }>(path(kind, m.id), { body: { mark: next, surface: 'message', device: deviceId() } });
    if (next) undoToast(next, kind, [m.id], was);
    return r;
  } catch (e) {
    failed(e, was);
    return null;
  }
}

/**
 * Mark an inbox row: a conversation, each route of a chat of several, or a mail thread. "No reply needed" marks the
 * newest message from them in each route's open turn; "Reply needed" the newest of them all. On a row already held
 * ("Reply needed" ticked), picking it again takes the hold back.
 */
export async function markRow(kind: 'conversation' | 'mail', ids: string[], mark: P.ReplyMark, held: boolean) {
  const msgKind = kind === 'mail' ? 'mail' : 'message';
  const was = mark === 'none' ? hideOwed(ids) : [];
  try {
    if (mark === 'needs' && held) {
      // Picked again: the hold on the row's open turn goes, wherever in the turn it is.
      await api('/api/reply-mark', { body: { targetKind: kind, ids, mark: null, device: deviceId() } });
      return;
    }
    const r = await api<{ marked: string[] }>('/api/reply-mark', { body: { targetKind: kind, ids, mark, device: deviceId() } });
    if (!r.marked.length) {
      restore(was);
      return toast({ kind: 'info', title: 'Nothing to mark', body: 'No message from them waits on you here.' });
    }
    undoToast(mark, msgKind, r.marked, was);
  } catch (e) {
    failed(e, was);
  }
}

/** The two marks as a row's or message's menu shows them: ticked when set. */
export function replyMarkEntries(current: P.ReplyMark | null | undefined, run: (mark: P.ReplyMark) => void, only?: P.ReplyMark[]) {
  return (only ?? (['none', 'needs'] as P.ReplyMark[])).map((mark) => ({
    label: REPLY_MARK_LABEL[mark],
    icon: mark === 'none' ? 'check' : 'reply',
    checked: current === mark,
    track: mark === 'none' ? 'mark no reply needed' : 'mark reply needed',
    run: () => run(mark),
  }));
}
