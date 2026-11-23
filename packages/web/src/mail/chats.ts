/**
 * Mail as chats (docs/mail.md "Mail as chats"). There is no Mail page: a thread between you and one other person is
 * part of that person's chat, by an email route (`email:<account>:<address>`, one per account of yours and address of
 * theirs), and a thread with more people, or from someone who is not a person yet, is a chat of its own, its thread id
 * (`mth_…`). The page draws both with the chat's own panes; this file makes the conversation each of them is
 * (`convById`), says which timelines hold mail, and sends what the chat box writes as a mail.
 *
 * The hub decides where a thread belongs (hub mail/places.ts); the page only follows `MessageMailView.place`.
 */
import type * as P from '@dither-chat/protocol';
import { bareSubject } from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { api } from '../api.ts';
import { db } from '../store.ts';
import { mailChanged } from '../versions.ts';
import { details } from './held.ts';
import { rungKey, threadName } from './model.ts';

export const isEmailRoute = (id: string | null | undefined): id is string => !!id && id.startsWith('email:');
export const isMailThread = (id: string | null | undefined): id is string => !!id && id.startsWith('mth_');
/** A chat place that is mail: an email route of a person's chat, or a thread as a chat of its own. */
export const isMailPlace = (id: string | null | undefined): id is string => isEmailRoute(id) || isMailThread(id);

const routeConvs = new WeakMap<P.MailChatView, P.ConversationView>();
/** An email route as the conversation a person's chat lists among its routes (model.ts directsOf). */
function routeConv(ch: P.MailChatView): P.ConversationView {
  let c = routeConvs.get(ch);
  if (!c) {
    c = {
      id: ch.id,
      network: 'email',
      nativeId: ch.address,
      shape: 'direct',
      variant: 'text',
      name: null,
      topic: bareSubject(ch.subject ?? '') || null,
      avatar: null,
      encrypted: false,
      archived: false,
      parentId: null,
      spaceIds: [],
      participantIds: [ch.identityId],
      peerPersonId: ch.personId,
      vantages: [{ accountId: ch.accountId, unread: ch.unread, mentions: 0, lastReadTs: null }],
      lastMessage: ch.preview === null ? null : { id: `${ch.id}:last`, authorId: ch.lastFromMe ? null : ch.identityId, ts: ch.lastAt, kind: 'text', text: ch.preview },
      lastMessageAt: ch.lastAt,
      nativeMute: null,
    };
    routeConvs.set(ch, c);
  }
  return c;
}

const threadConvs = new WeakMap<P.MailThreadView, P.ConversationView>();
/** A thread as a chat of its own: a group of everyone on it, named by its subject without Re: (threadName). */
function threadConv(t: P.MailThreadView): P.ConversationView {
  let c = threadConvs.get(t);
  if (!c) {
    const ids = [...new Set(t.from.filter((f) => !f.self && f.identityId).map((f) => f.identityId!))];
    c = {
      id: t.id,
      network: 'email',
      nativeId: t.id,
      shape: 'group',
      variant: 'text',
      name: threadName(t),
      topic: null,
      avatar: null,
      encrypted: false,
      archived: !t.roles.includes('inbox'),
      parentId: null,
      spaceIds: [],
      participantIds: ids,
      peerPersonId: null,
      vantages: [{ accountId: t.accountId, unread: t.unread, mentions: 0, lastReadTs: null }],
      lastMessage: t.preview === null ? null : { id: `${t.id}:last`, authorId: t.lastFromMe ? null : (t.from[t.from.length - 1]?.identityId ?? null), ts: t.lastAt, kind: 'text', text: t.preview },
      lastMessageAt: t.lastAt,
      nativeMute: null,
    };
    threadConvs.set(t, c);
  }
  return c;
}

/** The thread the page holds: in the bootstrap's window, or loaded (mail/api.ts loadThread). */
export const mailThread = (id: string): P.MailThreadView | undefined => db.mail.threads.get(id) ?? details.get(id)?.thread;

/** A conversation by id: a chat's, an email route's or a thread's. */
export function convById(id: string | null | undefined): P.ConversationView | undefined {
  if (!id) return undefined;
  const c = db.conversations.get(id);
  if (c) return c;
  if (isEmailRoute(id)) {
    const ch = db.mail.chats.get(id);
    return ch ? routeConv(ch) : undefined;
  }
  if (isMailThread(id)) {
    const t = mailThread(id);
    return t ? threadConv(t) : undefined;
  }
  return undefined;
}

/** Each person's email routes, newest first: what model.ts adds to their directs. */
export function routesByPerson(): Map<string, P.ConversationView[]> {
  const m = new Map<string, P.ConversationView[]>();
  for (const ch of db.mail.chats.values()) {
    if (!db.mail.accounts.has(ch.accountId)) continue;
    const l = m.get(ch.personId);
    if (l) l.push(routeConv(ch));
    else m.set(ch.personId, [routeConv(ch)]);
  }
  return m;
}

/** Whether a timeline holds mail: the hub's sync of timelines knows only chat, so these are always asked for again. */
export function holdsMail(key: string): boolean {
  const id = key.slice(2);
  if (key.startsWith('c:')) return isMailPlace(id);
  if (!key.startsWith('p:')) return false;
  for (const ch of db.mail.chats.values()) if (ch.personId === id) return true;
  return false;
}

/** Where a mail timeline's pages come from. */
export const mailPageUrl = (id: string) => `/api/mail/chats/${encodeURIComponent(id)}/messages`;

// ------------------------------------------------------------------ rungs

/** The rung you chose for a place in a view, if any (hub rungs.ts has the defaults). */
export const chosenRung = (view: string, place: string): P.Rung | null => db.mail.rungs.get(rungKey(view, place))?.rung ?? null;

export async function chooseRung(view: string, place: string, rung: P.Rung | null) {
  const k = rungKey(view, place);
  const was = db.mail.rungs.get(k);
  if (rung) db.mail.rungs.set(k, { view, place, rung, setAt: Date.now() });
  else db.mail.rungs.delete(k);
  mailChanged();
  try {
    await api('/api/rungs', { method: 'PUT', body: { view, place, rung } });
  } catch (e) {
    if (was) db.mail.rungs.set(k, was);
    else db.mail.rungs.delete(k);
    mailChanged();
    throw e;
  }
}

// ------------------------------------------------------------------ sends on their way

/** What chat sends are on their way, by clientId: the outbox has no text, so the chat shows them from here. */
export const chatSends = new Map<string, { place: string; text: string; subject: string; ts: number }>();

/**
 * Words a chat send's Undo gives back to the box of their place (an email route or a thread): the box takes them when
 * it is empty (ui/Timeline.tsx Composer), as the network's own Undo leaves what you wrote.
 */
export const refill = signal<{ place: string; text: string; seq: number } | null>(null);

/** The sends of this page still in the outbox for a place, oldest first (the chat shows them under its messages). */
export function sendsIn(places: string[]): { item: P.MailOutboxView; text: string; subject: string }[] {
  const out: { item: P.MailOutboxView; text: string; subject: string; ts: number }[] = [];
  for (const item of db.mail.outbox.values()) {
    const s = chatSends.get(item.clientId);
    if (!s || !places.includes(s.place)) continue;
    out.push({ item, text: s.text, subject: s.subject, ts: s.ts });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Threads on their way (loadMailThread). */
const threadsLoading = new Set<string>();
/** Threads that would not load, with why: the chat says so instead of loading forever. */
export const threadsFailed = new Map<string, string>();
/** A thread the page does not hold, for its chat (mail/api.ts loadThread does the same for the mail chunk). */
export async function loadMailThread(id: string): Promise<void> {
  if (threadsLoading.has(id)) return;
  threadsLoading.add(id);
  threadsFailed.delete(id);
  try {
    const d = await api<P.MailThreadDetail>(`/api/mail/threads/${encodeURIComponent(id)}`);
    details.set(id, d);
  } catch (e) {
    threadsFailed.set(id, e instanceof Error ? e.message : String(e));
  } finally {
    threadsLoading.delete(id);
    mailChanged();
  }
}
