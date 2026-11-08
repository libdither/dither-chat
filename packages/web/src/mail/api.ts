/**
 * What the Mail screens ask the hub for (docs/mail.md): pages of a list, a thread with its messages, a body, and
 * telling it a thread was read here. The answers go into `db.mail` (lists, threads) or the maps below (what the reader
 * has open), and move `mailRev`.
 */
import type * as P from '@dither-chat/protocol';
import { api, db, eventHooks } from '../state.ts';
import { mailChanged } from '../versions.ts';
import { cursorOf, mergePage, newList } from './model.ts';

import { bodies, bodyState, details } from './held.ts';

export { bodies, bodyState, details } from './held.ts';

/**
 * A list's first page (again), or the next one. Past what the hub holds it asks the server (slice 2), which can take a
 * while: a `pending` answer is asked again a moment later, while its threads arrive as `mail.threads`.
 */
export async function loadList(key: string, more = false): Promise<void> {
  const s = db.mail;
  const l = s.lists.get(key) ?? newList(key);
  const last = l.ids.length ? s.threads.get(l.ids[l.ids.length - 1]) : undefined;
  const before = more ? (l.next ?? (last && !l.complete ? cursorOf(last) : null)) : null;
  if (l.loading || (more && (!before || !l.loaded))) return;
  s.lists.set(key, { ...l, loading: true, error: null });
  mailChanged();
  try {
    const page = await api<P.MailThreadPage>(`/api/mail/threads?list=${encodeURIComponent(key)}&limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    mergePage(s, key, page, more);
    if (page.pending)
      setTimeout(() => {
        const now = s.lists.get(key);
        if (now?.pending) void loadList(key, now.ids.length > 0);
      }, 1_500);
  } catch (e) {
    const now = s.lists.get(key) ?? l;
    s.lists.set(key, { ...now, loading: false, error: (e as Error).message });
  } finally {
    mailChanged();
  }
}

/** A thread and its messages. Kept, so going back to it shows it at once while it loads again. */
export async function loadThread(id: string): Promise<void> {
  const had = details.get(id);
  if (had?.loading) return;
  if (had) details.set(id, { ...had, loading: true });
  mailChanged();
  try {
    const d = await api<P.MailThreadDetail>(`/api/mail/threads/${encodeURIComponent(id)}`);
    db.mail.threads.set(d.thread.id, d.thread);
    details.set(id, d);
  } catch (e) {
    const prev = details.get(id);
    details.set(id, { thread: prev?.thread ?? db.mail.threads.get(id)!, messages: prev?.messages ?? [], error: (e as Error).message });
  } finally {
    mailChanged();
  }
}

/** A message's body; the hub fetches it from the server when it does not have it (up to a minute). */
export async function loadBody(messageId: string): Promise<void> {
  if (bodies.has(messageId) || bodyState.get(messageId)?.loading) return;
  bodyState.set(messageId, { loading: true, error: null });
  mailChanged();
  try {
    bodies.set(messageId, await api<P.MailBodyView>(`/api/mail/messages/${encodeURIComponent(messageId)}/body`));
    bodyState.delete(messageId);
  } catch (e) {
    bodyState.set(messageId, { loading: false, error: (e as Error).message });
  } finally {
    mailChanged();
  }
}

export function retryBody(messageId: string) {
  bodyState.delete(messageId);
  return loadBody(messageId);
}

/** Read here, once the thread has been in view a moment (the hub keeps it; slice 4 tells the server too). */
export function markThreadRead(id: string) {
  const t = db.mail.threads.get(id);
  if (!t?.unread) return;
  db.mail.threads.set(id, { ...t, unread: 0 });
  mailChanged();
  api(`/api/mail/threads/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} }).catch(() => {});
}

/** Pull to refresh: what changed on the servers, now. */
export function refreshMail(accountId?: string) {
  return api(`/api/mail/refresh${accountId ? `/${encodeURIComponent(accountId)}` : ''}`, { method: 'POST', body: {} });
}

/** "Delete now", for an account whose access ended. */
export function deleteMailAccount(id: string) {
  return api(`/api/mail/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** "Ask again" after mail access was declined. */
export function askMailAgain() {
  return api<{ access: P.MailAccess }>('/api/mail/access', { method: 'POST', body: {} });
}

/** The lists' and the reader's copies follow the threads the hub sends. */
export function mailThreadsChanged(ev: Extract<P.ClientEvent, { t: 'mail.threads' }>) {
  for (const id of ev.removed) details.delete(id);
  // An open thread whose messages changed loads again; one only read or flagged keeps its messages.
  for (const t of ev.threads) {
    const d = details.get(t.id);
    if (d && !d.loading && (d.thread.count !== t.count || d.thread.lastAt !== t.lastAt)) void loadThread(t.id);
    else if (d) details.set(t.id, { ...d, thread: t });
  }
}

eventHooks.add((ev) => {
  if (ev.t === 'mail.threads') mailThreadsChanged(ev);
});
