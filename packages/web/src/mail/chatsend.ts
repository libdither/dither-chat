/**
 * What a chat box sends as mail (docs/mail.md "Mail as chats", "Writing from a chat"): in the mail chunk with the rest
 * of sending, loaded when a chat with mail opens its box.
 */
import type * as P from '@dither-chat/protocol';
import { api } from '../api.ts';
import { db } from '../state.ts';
import { mailChanged } from '../versions.ts';
import { chatSends, isEmailRoute, mailThread } from './chats.ts';
import { send as sendDraft, timeZone } from './drafts.ts';

/**
 * What a chat box sends as mail. In a person's chat, an email route goes to that person only: in the thread
 * `threadId` (the subject chip's pick) as a reply to its newest message, or, with `subject`, as a new thread. In a
 * thread's own chat, everyone on it (reply all). `replyTo`: a message picked with Reply, answered in its thread.
 */
interface ChatMail {
  place: string;
  text: string;
  /** A new thread's subject (an email route only). */
  subject?: string | null;
  /** The thread an email route's message goes into; the latest when not said. */
  threadId?: string | null;
  replyTo?: P.MessageView | null;
  /** The newest message of the thread it goes into, from the timeline. */
  latest?: P.MessageView | null;
  /** A thread's own chat: only these of it (the box's "Only Alice"), not everyone. */
  only?: P.MailAddressView[] | null;
}

export async function sendFromChat(o: ChatMail): Promise<{ ok: true } | { ok: false; error: string }> {
  const clientId = 'chat-' + Math.random().toString(36).slice(2);
  const answer = o.replyTo?.mail ? o.replyTo : o.latest?.mail ? o.latest : null;
  let draft: P.MailDraft;
  if (isEmailRoute(o.place)) {
    const ch = db.mail.chats.get(o.place);
    if (!ch) return { ok: false, error: 'This email route is gone.' };
    const to = [{ name: db.persons.get(ch.personId)?.name ?? null, email: ch.address }];
    if ((o.subject !== null && o.subject !== undefined) || !answer) {
      draft = blank(ch.accountId, 'new', null, to, o.subject?.trim() || '(no subject)', o.text);
    } else {
      const start = await api<P.MailComposeStart>(`/api/mail/compose?${new URLSearchParams({ kind: 'reply', message: answer.id, ...(timeZone() ? { tz: timeZone()! } : {}) })}`).catch((e) => e as Error);
      if (start instanceof Error) return { ok: false, error: start.message };
      // Only them: the box's audience is the place it is in.
      draft = { ...start.draft, to, cc: [], bcc: [], text: o.text, quote: false, html: null, files: [], forwardParts: [] };
    }
  } else {
    if (!mailThread(o.place) && !answer) return { ok: false, error: 'This thread is not loaded yet.' };
    const at = answer ?? null;
    if (!at) return { ok: false, error: 'Open the thread once its messages have loaded.' };
    const start = await api<P.MailComposeStart>(`/api/mail/compose?${new URLSearchParams({ kind: 'replyAll', message: at.id, ...(timeZone() ? { tz: timeZone()! } : {}) })}`).catch((e) => e as Error);
    if (start instanceof Error) return { ok: false, error: start.message };
    draft = { ...start.draft, text: o.text, quote: false, html: null, files: [], forwardParts: [] };
    // "Only Alice": the reply all, to her alone; the thread then marks it "to Alice only" (the hub's MessageMailView.only).
    if (o.only?.length) draft = { ...draft, to: o.only.map((a) => ({ name: a.name, email: a.email })), cc: [], bcc: [] };
  }
  const first = (a: P.MailAddressView) => (a.name || a.email.split('@')[0]).split(/\s+/)[0];
  chatSends.set(clientId, { place: o.place, text: o.text, subject: draft.subject, ts: Date.now(), ...(o.only?.length ? { only: o.only.map(first) } : {}) });
  mailChanged();
  const r = await sendDraft(`chat:${clientId}`, draft, clientId);
  if (!r.ok) {
    chatSends.delete(clientId);
    mailChanged();
    return { ok: false, error: r.error };
  }
  return { ok: true };
}

function blank(accountId: string, kind: P.MailComposeKind, replyTo: string | null, to: P.MailAddressView[], subject: string, text: string): P.MailDraft {
  return { accountId, kind, replyTo, from: null, to, cc: [], bcc: [], subject, text, quote: false, files: [], forwardParts: [], html: null };
}
