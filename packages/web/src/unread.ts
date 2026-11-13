/**
 * Mark Unread from a message on (the message menu; hub unread.ts): the hub moves the read point back on every account
 * that sees the chat and tells each network that can. The page goes back to the inbox, as the chat open would read it
 * again as soon as its newest message is on screen.
 */
import type * as P from '@dither-chat/protocol';
import { api, go, toast } from './state.ts';

/** Whose message it can be: someone else's that is still there. */
export const canMarkUnread = (m: Pick<P.MessageView, 'deleted' | 'kind'>, self: boolean) => !self && !m.deleted && m.kind !== 'system';

export async function markUnreadFrom(m: Pick<P.MessageView, 'id'>) {
  try {
    await api(`/api/messages/${m.id}/unread`, { body: {} });
    go({ view: 'inbox' });
    toast({ title: 'Marked unread', body: 'From that message on.', kind: 'info' }, 3000);
  } catch (e) {
    toast({ title: 'Could not mark it unread', body: (e as Error).message, kind: 'error' });
  }
}
