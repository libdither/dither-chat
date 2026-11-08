/**
 * The page's copy of mail (docs/mail.md): access, accounts, mailboxes, the threads it has seen, and the lists it has
 * loaded page by page. Pure, like syncmodel.ts: no signals, no DOM, no network (web/test/mail-model.test.ts).
 *
 * The bootstrap carries a window of threads (each account's newest Inbox page). A list the page has not loaded yet
 * shows what the window has of it at once; once loaded, `mail.threads` events keep it in order: a thread that now
 * belongs in it goes in where it sorts (unless it is older than everything loaded and more is to come), one that no
 * longer does comes out.
 */
import type * as P from '@dither-chat/protocol';
import { parseMailList, parseWithList, viewList } from '@dither-chat/protocol';

export interface MailList {
  key: string;
  ids: string[];
  next: string | null;
  complete: boolean;
  /** A page has come from the hub. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export interface MailState {
  access: P.MailAccess;
  accounts: Map<string, P.MailAccountView>;
  mailboxes: Map<string, P.MailboxView>;
  threads: Map<string, P.MailThreadView>;
  lists: Map<string, MailList>;
  /** What the hub's outbox still shows (slice 5): held, on its way, failed, or just sent. */
  outbox: Map<string, P.MailOutboxView>;
}

export const OFF: P.MailAccess = { state: 'off', managerUrl: null };

export function emptyMail(): MailState {
  return { access: OFF, accounts: new Map(), mailboxes: new Map(), threads: new Map(), lists: new Map(), outbox: new Map() };
}

/** Newest first; ties by id, as the hub pages them. */
export const threadOrder = (a: P.MailThreadView, b: P.MailThreadView) => b.lastAt - a.lastAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Whether a thread belongs in a list. */
export function inList(key: string, t: P.MailThreadView): boolean {
  // Everything with someone (slice 6): the hub's page says which; a changed thread joins by its people.
  const who = parseWithList(key);
  if (who !== null) return t.personIds.includes(who) || t.from.some((f) => !f.self && (f.personId === who || f.identityId === who || f.email === who.toLowerCase()));
  const l = parseMailList(key);
  if (!l) return false;
  if ('mailbox' in l) return t.mailboxIds.includes(l.mailbox);
  if (l.accountId && t.accountId !== l.accountId) return false;
  switch (l.view) {
    case 'inbox':
      return t.roles.includes('inbox');
    case 'sent':
      return t.roles.includes('sent');
    case 'unread':
      return t.unread > 0 && t.roles.length > 0 && !t.roles.some((r) => r === 'junk' || r === 'trash');
    case 'starred':
      return t.flagged;
    default:
      // People and Updates come with classification (slice 8).
      return false;
  }
}

export function applyMailBootstrap(s: MailState, b: P.MailBootstrap | undefined) {
  s.access = b?.access ?? OFF;
  s.accounts = new Map((b?.accounts ?? []).map((a) => [a.id, a]));
  s.mailboxes = new Map((b?.mailboxes ?? []).map((m) => [m.id, m]));
  s.threads = new Map((b?.threads ?? []).map((t) => [t.id, t]));
  s.outbox = new Map((b?.outbox ?? []).map((o) => [o.id, o]));
  // Loaded lists may be behind what the hub has now: each loads again when shown.
  s.lists = new Map();
}

/** Applies a mail event; false for any other event. */
export function applyMailEvent(s: MailState, ev: P.ClientEvent): boolean {
  switch (ev.t) {
    case 'mail.access':
      s.access = ev.access;
      return true;
    case 'mail.account':
      s.accounts.set(ev.account.id, ev.account);
      return true;
    case 'mail.account.removed': {
      s.accounts.delete(ev.id);
      for (const [id, m] of s.mailboxes) if (m.accountId === ev.id) s.mailboxes.delete(id);
      const gone = [...s.threads.values()].filter((t) => t.accountId === ev.id).map((t) => t.id);
      removeThreads(s, gone);
      return true;
    }
    case 'mail.mailboxes':
      for (const [id, m] of s.mailboxes) if (m.accountId === ev.accountId) s.mailboxes.delete(id);
      for (const m of ev.mailboxes) s.mailboxes.set(m.id, m);
      return true;
    case 'mail.threads':
      for (const t of ev.threads) s.threads.set(t.id, t);
      removeThreads(s, ev.removed);
      for (const l of s.lists.values()) if (l.loaded) placeInList(s, l, ev.threads);
      return true;
    case 'mail.lists':
      // Slice 2: lists the hub changed without sending each thread load again when shown.
      for (const k of ev.stale) {
        const l = s.lists.get(k);
        if (l) l.loaded = false;
      }
      return true;
    case 'mail.progress': {
      const a = s.accounts.get(ev.accountId);
      if (a) s.accounts.set(a.id, { ...a, sync: ev.sync });
      return true;
    }
    case 'mail.outbox':
      // The whole list, each time.
      s.outbox = new Map(ev.items.map((o) => [o.id, o]));
      return true;
    default:
      return false;
  }
}

function removeThreads(s: MailState, ids: string[]) {
  if (!ids.length) return;
  const gone = new Set(ids);
  for (const id of ids) s.threads.delete(id);
  for (const l of s.lists.values()) l.ids = l.ids.filter((id) => !gone.has(id));
}

/** New and changed threads, in or out of a loaded list. */
function placeInList(s: MailState, l: MailList, changed: P.MailThreadView[]) {
  const ids = l.ids.filter((id) => !changed.some((t) => t.id === id));
  const oldest = l.ids.length ? s.threads.get(l.ids[l.ids.length - 1]) : undefined;
  const reach = (t: P.MailThreadView) => l.complete || !l.next || !oldest || threadOrder(t, oldest) <= 0;
  const keep = new Set(ids);
  for (const t of changed) if (inList(l.key, t) && (l.ids.includes(t.id) || reach(t))) keep.add(t.id);
  l.ids = [...keep].map((id) => s.threads.get(id)).filter((t): t is P.MailThreadView => !!t).sort(threadOrder).map((t) => t.id);
}

/** A page from GET /api/mail/threads: the first replaces the list, the next ones go on its end. */
export function mergePage(s: MailState, key: string, page: P.MailThreadPage, more: boolean) {
  for (const t of page.threads) s.threads.set(t.id, t);
  const l = s.lists.get(key) ?? newList(key);
  const ids = more ? [...l.ids, ...page.threads.map((t) => t.id).filter((id) => !l.ids.includes(id))] : page.threads.map((t) => t.id);
  s.lists.set(key, { ...l, ids, next: page.next, complete: page.complete, loaded: true, loading: false, error: null });
}

export const newList = (key: string): MailList => ({ key, ids: [], next: null, complete: false, loaded: false, loading: false, error: null });

/** What a list shows: the loaded pages, or before they come, what the threads at hand say of it. */
export function listThreads(s: MailState, key: string): P.MailThreadView[] {
  const l = s.lists.get(key);
  if (l?.loaded) return l.ids.map((id) => s.threads.get(id)).filter((t): t is P.MailThreadView => !!t);
  return [...s.threads.values()].filter((t) => inList(key, t)).sort(threadOrder);
}

/** Unread threads in Inbox, for the rail's dot (slice 8 narrows it to mail from people). */
export function unreadInbox(s: MailState): number {
  let n = 0;
  for (const t of s.threads.values()) if (t.unread > 0 && t.roles.includes('inbox') && s.accounts.has(t.accountId)) n++;
  return n;
}

/** "Sam Lee", "Alex, Jo, me": who wrote, latest last, your own messages as "me". */
export function senderLine(t: P.MailThreadView, max = 3): string {
  const names = t.from.map((f) => (f.self ? 'me' : firstName(f.name ?? f.email, t.from.length > 1)));
  const uniq = [...new Set(names)];
  if (!uniq.length) return '(nobody)';
  const shown = uniq.length > max ? [...uniq.slice(0, 1), '…', ...uniq.slice(-(max - 1))] : uniq;
  return shown.join(', ');
}

/** A name for a list row: the whole name alone, the first name among several. */
function firstName(n: string, several: boolean): string {
  if (!several) return n;
  if (n.includes('@')) return n.split('@')[0];
  return n.split(/\s+/)[0] ?? n;
}

/** Who a `w:` list is with, by person or identity id: set by the page's people model (web model.ts). */
export const mailNames = { of: (_who: string): string | null => null };

/** The list a mailbox or view key names, for headings. */
export function listTitle(s: MailState, key: string): string {
  const who = parseWithList(key);
  if (who !== null) return `Mail with ${mailNames.of(who) ?? who}`;
  const l = parseMailList(key);
  if (!l) return 'Mail';
  if ('mailbox' in l) return s.mailboxes.get(l.mailbox)?.name ?? 'Mailbox';
  const names: Record<string, string> = { inbox: 'Inbox', unread: 'Unread', starred: 'Starred', sent: 'Sent', people: 'People', updates: 'Updates' };
  const acc = l.accountId ? s.accounts.get(l.accountId) : null;
  return acc ? `${names[l.view]} · ${acc.address ?? acc.label}` : names[l.view];
}

/** The views the Mail section offers now. People and Updates come with slice 8. */
export const MAIL_VIEWS: { view: 'inbox' | 'unread' | 'starred' | 'sent'; label: string }[] = [
  { view: 'inbox', label: 'Inbox' },
  { view: 'unread', label: 'Unread' },
  { view: 'starred', label: 'Starred' },
  { view: 'sent', label: 'Sent' },
];

export const DEFAULT_LIST = viewList('inbox');
