/**
 * A copy of the message a push is about, carried in the push itself (docs/notifications.md, "A copy in the push"), so a
 * device that opens from the notification shows it at once, before it reaches the hub, offline too. Only what fits:
 * a push's encrypted record is at most 4096 bytes, and the notification's own fields come first.
 */
import type * as P from '@dither-chat/protocol';

/**
 * The payload's JSON, in bytes, that a push may carry with its copy: 4096 less the encryption's header (86) and tag
 * (16) and padding delimiter (1) is 3993; the rest leaves room for the device id each push names.
 */
export const PUSH_BYTES = 3900;
/** A cut body keeps at least this many characters, or no copy goes. */
const MIN_BODY = 40;

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** The copy for a message, from the store: the message without what a push has no room for. */
export function arrivedCopy(store: { messageView(id: string): P.MessageView | null; conversationView(id: string): P.ConversationView | null }, conversationId: string, messageId: string): P.PushArrived | null {
  const m = store.messageView(messageId);
  const c = store.conversationView(conversationId);
  if (!m || !c || m.conversationId !== conversationId || m.deleted) return null;
  const message: P.MessageView = {
    id: m.id,
    conversationId: m.conversationId,
    network: m.network,
    nativeId: m.nativeId,
    authorId: m.authorId,
    ts: m.ts,
    editedTs: m.editedTs,
    kind: m.kind,
    body: m.body,
    replyToId: m.replyToId,
    threadId: m.threadId,
    mentionsSelf: m.mentionsSelf,
    deleted: false,
    attachments: m.attachments,
    embeds: [],
    reactions: [],
    seenVia: m.seenVia,
    triage: m.triage,
  };
  return { message, lastMessage: c.lastMessage, lastMessageAt: c.lastMessageAt, vantages: c.vantages };
}

/**
 * The copy that fits beside `payload` (everything else the push carries) within PUSH_BYTES: whole, else without its
 * attachments, else with its body and the preview's text cut to fit; null when even that does not fit.
 */
export function fitArrived(payload: object, copy: P.PushArrived, limit = PUSH_BYTES): P.PushArrived | null {
  const size = (a: P.PushArrived) => bytes({ ...payload, arrived: a });
  if (size(copy) <= limit) return copy;
  const a: P.PushArrived = { ...copy, message: { ...copy.message, attachments: [] } };
  if (size(a) <= limit) return a;
  // The longest body that fits, found by halving.
  const body = copy.message.body;
  const preview = copy.lastMessage?.id === copy.message.id ? copy.lastMessage : null;
  const cutTo = (n: number): P.PushArrived => {
    const text = cutAt(body, n);
    return {
      ...a,
      cut: true,
      message: { ...a.message, body: text },
      // The list's preview is the same message: no longer than its body.
      ...(preview && preview.text.length > text.length ? { lastMessage: { ...preview, text: cutAt(preview.text, text.length) } } : {}),
    };
  };
  let lo = MIN_BODY;
  let hi = body.length - 1;
  if (hi < lo || size(cutTo(lo)) > limit) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(cutTo(mid)) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return cutTo(lo);
}

/** The first `n` characters, not splitting a surrogate pair. */
function cutAt(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}
