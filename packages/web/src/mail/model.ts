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
import { MAIL_PLATFORM_NAMES, mailPlatform, parseMailList, parseWithList, platformScope, viewList } from '@dither-chat/protocol';
import { inboxView, type Ranked } from '../ordering.ts';

interface MailList {
  key: string;
  ids: string[];
  next: string | null;
  complete: boolean;
  /** A page has come from the hub. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The hub is fetching the next page from the server: its threads come as `mail.threads` (slice 2). */
  pending: boolean;
  /** The hub changed it without sending each thread (`mail.lists`): it loads again when it next shows. */
  stale: boolean;
  /** The last page asked for brought nothing new: no more is asked for by itself until the list loads again. */
  dry: boolean;
}

interface MailState {
  access: P.MailAccess;
  accounts: Map<string, P.MailAccountView>;
  mailboxes: Map<string, P.MailboxView>;
  threads: Map<string, P.MailThreadView>;
  lists: Map<string, MailList>;
  /** What the hub's outbox still shows (slice 5): held, on its way, failed, or just sent. */
  outbox: Map<string, P.MailOutboxView>;
}

const OFF: P.MailAccess = { state: 'off', managerUrl: null };

export function emptyMail(): MailState {
  return { access: OFF, accounts: new Map(), mailboxes: new Map(), threads: new Map(), lists: new Map(), outbox: new Map() };
}

/** Newest first; ties by id, as the hub pages them. */
const threadOrder = (a: P.MailThreadView, b: P.MailThreadView) => b.lastAt - a.lastAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The page's mail accounts, for a platform's list (set where the state lives, so inList stays a plain function). */
export const scopeAccounts = { of: (_id: string): P.MailAccountView | null => null };

/** Whether a thread belongs in a list. */
export function inList(key: string, t: P.MailThreadView): boolean {
  // Everything with someone (slice 6): the hub's page says which; a changed thread joins by its people.
  const who = parseWithList(key);
  if (who !== null) return t.personIds.includes(who) || t.from.some((f) => !f.self && (f.personId === who || f.identityId === who || f.email === who.toLowerCase()));
  const l = parseMailList(key);
  if (!l) return false;
  if ('mailbox' in l) return t.mailboxIds.includes(l.mailbox);
  if (l.accountId && t.accountId !== l.accountId) return false;
  if (l.platform) {
    const a = scopeAccounts.of(t.accountId);
    if (!a || mailPlatform(a) !== l.platform) return false;
  }
  switch (l.view) {
    case 'inbox':
      // Mail not from a person folds into Updates (slice 8); an unclassified thread stays.
      return t.roles.includes('inbox') && t.class !== 'bulk';
    case 'all':
      return t.roles.includes('inbox');
    case 'people':
      return t.roles.includes('inbox') && t.class === 'personal';
    case 'updates':
      return t.roles.includes('inbox') && t.class === 'bulk';
    case 'sent':
      return t.roles.includes('sent');
    case 'unread':
      return t.unread > 0 && t.roles.length > 0 && !t.roles.some((r) => r === 'junk' || r === 'trash');
    case 'starred':
      return t.flagged;
    default:
      return false;
  }
}

/** A mail thread the one-list inbox lists, with the hub's say on it (slice 8; model.ts InboxRow). */
interface MailInboxScore {
  key: string;
  thread: P.MailThreadView;
  score: number;
  needs: boolean;
  reasons: string[];
  owedSince: number | null;
}

/**
 * The mail rows of the one-list inbox: each `kind: 'mail'` attention view whose thread the page holds, of an account
 * it shows. A view whose thread has not come yet waits for the next mail event.
 */
export function mailInboxRows(attention: Iterable<P.AttentionView>, s: MailState): MailInboxScore[] {
  const out: MailInboxScore[] = [];
  if (!s.accounts.size) return out;
  for (const a of attention) {
    if (a.kind !== 'mail') continue;
    const t = s.threads.get(a.id);
    if (!t || !s.accounts.has(t.accountId)) continue;
    out.push({ key: t.id, thread: t, score: a.score, needs: a.needs, reasons: a.reasons, owedSince: a.owedSince });
  }
  return out;
}

/** Inbox's Updates row: how many of its threads are new, and from whom, newest first (slice 8). */
export interface UpdatesFold {
  key: string;
  count: number;
  unread: number;
  names: string[];
  lastAt: number;
}

/** The Updates row for an Inbox list (null for any other list, or when Updates is empty). */
export function updatesFold(s: MailState, key: string): UpdatesFold | null {
  const l = parseMailList(key);
  if (!l || 'mailbox' in l || l.view !== 'inbox') return null;
  const ukey = viewList('updates', l.platform ? platformScope(l.platform) : l.accountId);
  const ts = listThreads(s, ukey);
  if (!ts.length) return null;
  const names: string[] = [];
  for (const t of ts) {
    const f = [...t.from].reverse().find((x) => !x.self);
    const n = f ? (f.name ?? f.email.split('@')[0]) : null;
    if (n && !names.includes(n)) names.push(n);
    if (names.length >= 4) break;
  }
  return { key: ukey, count: ts.length, unread: ts.filter((t) => t.unread > 0).length, names, lastAt: ts[0].lastAt };
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
      // Lists the hub changed without sending each thread (a backfill, mostly) load again when they next show.
      for (const k of ev.stale) {
        // `w:*`: every list of mail with someone.
        for (const [key, l] of k === 'w:*' ? [...s.lists].filter(([x]) => x.startsWith('w:')) : [[k, s.lists.get(k)] as const]) if (l?.loaded) s.lists.set(key, { ...l, stale: true });
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

/**
 * A page from GET /api/mail/threads: the first replaces the list, the next ones go on its end. A pending page leaves
 * `next` empty, so the threads the hub sends meanwhile go in wherever they sort.
 */
export function mergePage(s: MailState, key: string, page: P.MailThreadPage, more: boolean) {
  for (const t of page.threads) s.threads.set(t.id, t);
  const l = s.lists.get(key) ?? newList(key);
  let ids = page.threads.map((t) => t.id);
  let dry = false;
  if (more) {
    const have = new Set(l.ids);
    const fresh = ids.filter((id) => !have.has(id));
    dry = !fresh.length && !page.pending;
    ids = [...l.ids, ...fresh];
    // Threads placed while the page was on its way may sit among these.
    ids = ids.map((id) => s.threads.get(id)).filter((t): t is P.MailThreadView => !!t).sort(threadOrder).map((t) => t.id);
  }
  s.lists.set(key, { ...l, ids, next: page.next, complete: page.complete, pending: page.pending, loaded: true, loading: false, error: null, stale: false, dry });
}

export const newList = (key: string): MailList => ({ key, ids: [], next: null, complete: false, loaded: false, loading: false, error: null, pending: false, stale: false, dry: false });

/** Where the page after a list's last thread starts (the hub's cursor). */
export const cursorOf = (t: P.MailThreadView) => `${t.lastAt}:${t.id}`;

/** Whether a list can go further down: the hub has more, or the server may. */
export function hasMore(l: MailList | undefined): boolean {
  return !!l?.loaded && !l.dry && (!!l.next || (!l.complete && !l.pending && l.ids.length > 0));
}

/** Whether a list key sorts by rank when this device ranks: Inbox, of any scope. Everything else is by date. */
export function rankable(key: string): boolean {
  const l = parseMailList(key);
  return !!l && !('mailbox' in l) && l.view === 'inbox';
}

/**
 * Inbox ranked (docs/mail.md "Ranked"): first the threads in it the hub scores for the one-list inbox (each mail
 * `AttentionView`), in the inbox's own snapshot order (`snap`, inbox.ts), so a row moves only when the inbox's rows
 * would, never under the pointer; then the rest, newest first, as the hub pages them. `head`: how many are ranked.
 */
export function rankedThreads(s: MailState, key: string, attention: Iterable<P.AttentionView>, snap: { keys: string[] } | null): { threads: P.MailThreadView[]; head: number } {
  const dated = listThreads(s, key);
  const scored: Ranked[] = [];
  const byId = new Map<string, P.MailThreadView>();
  for (const a of attention) {
    if (a.kind !== 'mail') continue;
    const t = s.threads.get(a.id);
    if (!t || !s.accounts.has(t.accountId) || !inList(key, t)) continue;
    scored.push({ key: t.id, score: a.score, last: t.lastAt, muted: t.muted });
    byId.set(t.id, t);
  }
  const head = inboxView(snap, scored).map((id) => byId.get(id)!);
  return { threads: [...head, ...dated.filter((t) => !byId.has(t.id))], head: head.length };
}

/** What a list shows: the loaded pages, or before they come, what the threads at hand say of it. */
export function listThreads(s: MailState, key: string): P.MailThreadView[] {
  const l = s.lists.get(key);
  if (l?.loaded) return l.ids.map((id) => s.threads.get(id)).filter((t): t is P.MailThreadView => !!t);
  return [...s.threads.values()].filter((t) => inList(key, t)).sort(threadOrder);
}

/** Unread threads in Inbox from people (or not classified yet), for the rail's dot. */
export function unreadInbox(s: MailState): number {
  let n = 0;
  for (const t of s.threads.values()) if (t.unread > 0 && t.roles.includes('inbox') && (t.class === 'personal' || t.class === null) && s.accounts.has(t.accountId)) n++;
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
  const names: Record<string, string> = { inbox: 'Inbox', all: 'Everything', unread: 'Unread', starred: 'Starred', sent: 'Sent', people: 'People', updates: 'Updates' };
  const acc = l.accountId ? s.accounts.get(l.accountId) : null;
  if (l.platform) return `${names[l.view]} · ${MAIL_PLATFORM_NAMES[l.platform] ?? l.platform}`;
  return acc ? `${names[l.view]} · ${acc.address ?? acc.label}` : names[l.view];
}

/**
 * The Mail section's chips: Inbox, ranked or newest first (its label follows `prefs.mailOrder`), the whole of Inbox, and its
 * mail not from a person, which is also Inbox's folded row (slice 8).
 */
export const MAIL_VIEWS: { view: P.MailView; label: string }[] = [
  { view: 'inbox', label: 'Ranked' },
  { view: 'all', label: 'Everything' },
  { view: 'updates', label: 'Updates' },
];
/** Views in the folder menu, above each account's mailboxes: newest first, of the scope in use. */
export const MAIL_FOLDER_VIEWS: { view: P.MailView; label: string }[] = [
  { view: 'starred', label: 'Starred' },
  { view: 'sent', label: 'Sent' },
];

export const DEFAULT_LIST = viewList('inbox');

/**
 * A mailbox that only holds others (IMAP \Noselect, Gmail's `[Gmail]`): it has no counts and has mailboxes in it. The
 * server cannot list it, so menus leave it out; the paths of those in it still say where they are.
 */
export const holdsOnlyMailboxes = (b: P.MailboxView, all: Iterable<P.MailboxView>) => b.total === null && b.unread === null && [...all].some((c) => c.parentId === b.id);

/** "3 Mar", or "3 Mar 2025" before this year. */
function day(t: number, now: number): string {
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}

/**
 * An account whose mail has not been brought up to date for a while (its followed mailboxes' last pass that worked,
 * `sync.stateAt`): "Hasn't synced in 3 h: <the last failure>". Past half an hour when passes are failing, past an hour
 * when none failed (a big mailbox's timer may wait half an hour); null while it keeps up, before a first sync that has
 * not failed, and without access.
 */
export function staleSync(a: P.MailAccountView, now = Date.now()): string | null {
  if (a.level === null) return null;
  const { stateAt, error, failures = 0 } = a.sync;
  const why = error ? `: ${error}` : '';
  if (stateAt == null) return failures > 0 ? `Hasn't synced yet${why}` : null;
  const age = now - stateAt;
  if (age < (failures > 0 ? 30 : 60) * 60_000) return null;
  const mins = Math.floor(age / 60_000);
  const span = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.floor(mins / 60)} h` : `${Math.floor(mins / 1440)} days`;
  return `Hasn't synced in ${span}${why}`;
}

/** One line under the list: the first sync, the backfill going back, a refresh after the server lost track. */
export function syncLine(accounts: P.MailAccountView[], now = Date.now()): string | null {
  const busy = accounts.filter((a) => a.sync.phase !== 'idle');
  if (!busy.length) return null;
  const n = busy.reduce((x, a) => x + a.sync.synced, 0).toLocaleString();
  if (busy.some((a) => a.sync.phase === 'first')) return `Syncing · ${n}`;
  if (busy.some((a) => a.sync.phase === 'relist')) return 'Refreshing…';
  const oldest = Math.min(...busy.map((a) => a.sync.oldest ?? Infinity));
  return `Syncing older mail · ${n}${Number.isFinite(oldest) ? `, back to ${day(oldest, now)}` : ''}`;
}

/** A problem is left unsaid this long: most come and go (a page loading, a restart signing in again). */
export const PROBLEM_GRACE_MS = 10_000;

/**
 * What to say about an account that is not working, or null while there is nothing to say yet: access ended, or a
 * problem that has lasted PROBLEM_GRACE_MS. `at`: when a
 * problem kept quiet now becomes one to say (null when that is already so, or never).
 */
export function accountTrouble(a: P.MailAccountView, now = Date.now()): { message: string; at: null } | { message: null; at: number | null } {
  if (a.level === null) return { message: 'dither-chat no longer has access to it.', at: null };
  const p = a.problem;
  if (!p) return { message: null, at: null };
  if (p.since != null && now - p.since < PROBLEM_GRACE_MS) return { message: null, at: p.since + PROBLEM_GRACE_MS };
  return { message: p.message, at: null };
}

/** An account's Inbox unread count, when its server says. */
export function inboxUnread(s: { mailboxes: Map<string, P.MailboxView> }, accountId: string): number | null {
  for (const b of s.mailboxes.values()) if (b.accountId === accountId && b.role === 'inbox') return b.unread;
  return null;
}
