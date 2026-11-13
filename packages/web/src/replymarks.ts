/**
 * Your marks on whether a message needs a reply (docs/inbox.md, "Marks"): "No reply needed" settles what you owed up to
 * the message, "Reply needed" holds the chat near the top until you answer (it never notifies). Made on an inbox row,
 * by its ↩ on a computer or a swipe left on a phone (ui/ReplyMark.tsx). The ↩ goes, or comes, at once; the hub's fold
 * catches up a few seconds later. A toast offers Undo.
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

/**
 * The ↩ on these rows now, held, as the hub will have it once it has folded a "Reply needed": so a second swipe
 * takes it off rather than marking it again. Returns the views as they were, as hideOwed does.
 */
function showHeld(ids: string[]): P.AttentionView[] {
  const items = ids.map((id) => db.attention.get(id)).filter((a): a is P.AttentionView => !!a && a.owedSince === null);
  if (items.length) applyEvents([{ t: 'attention', items: items.map((a) => ({ ...a, needs: true, owedSince: Date.now(), replyMark: 'needs' as const })), removed: [] }]);
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
 * Mark an inbox row: a conversation, each route of a chat of several, or a mail thread. "No reply needed" marks the
 * newest message from them in each route's open turn (on a held row that lets the hold go too); "Reply needed" the
 * newest of them all. A row whose open turn was not meant for you (a group's chatter) has none to mark: "Reply needed"
 * then goes on `latest`, the row's newest message from someone else, which makes a turn of its own.
 */
export async function markRow(kind: 'conversation' | 'mail', ids: string[], mark: P.ReplyMark, latest?: string) {
  const msgKind = kind === 'mail' ? 'mail' : 'message';
  const was = mark === 'none' ? hideOwed(ids) : showHeld(ids);
  try {
    let r = await api<{ marked: string[] }>('/api/reply-mark', { body: { targetKind: kind, ids, mark, device: deviceId() } });
    if (!r.marked.length && mark === 'needs' && latest) r = await api<{ marked: string[] }>(path(msgKind, latest), { body: { mark, surface: 'row', device: deviceId() } });
    if (!r.marked.length) {
      restore(was);
      return toast({ kind: 'info', title: 'Nothing to mark', body: 'No message from them waits on you here.' });
    }
    undoToast(mark, msgKind, r.marked, was);
  } catch (e) {
    failed(e, was);
  }
}
