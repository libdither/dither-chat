/**
 * Email, hub <-> client (docs/mail.md, docs/mail-design.md §5). Mail comes from dither-accounts' `mail` interface
 * (mail-iface.ts) and is kept in the hub's own mail tables; these are the views the page gets of it.
 *
 * Ids are hub ids (ids.ts mailId): `mbx_` mailboxes, `mml_` messages, `mth_` threads, `mob_` outbox items. Mail
 * accounts keep the manager's account id. Times are ms since the epoch.
 *
 * Built in slices (docs/mail-design.md §12). Fields a later slice fills are here already, with the value they have
 * until then: a seam, not a promise. Each says which slice fills it.
 */
import type { IdentityView } from './api.ts';
import type { MailboxRole } from './mail-iface.ts';

export type { MailboxRole } from './mail-iface.ts';

/**
 * Whether this hub may read your mail: `off` without DITHER_ACCOUNTS_URL, `unreachable` while the manager does not
 * answer, `pending` until you approve the hub's request on the manager's page, `denied` if you declined it.
 */
export interface MailAccess {
  state: 'off' | 'unreachable' | 'pending' | 'denied' | 'granted';
  /** The manager's page, where you approve the request and add mail accounts (DITHER_ACCOUNTS_PUBLIC_URL). */
  managerUrl: string | null;
}

export interface MailAccountView {
  /** The manager's account id. */
  id: string;
  /** dither-accounts' kind: `imap`, `proton`. */
  kind: string;
  label: string;
  /** The address it receives at, once the account has said. */
  address: string | null;
  name: string | null;
  color: string;
  /** What the hub's grant lets it do; null once access to the account has ended. */
  level: 'read' | 'write' | null;
  /** Writes are answered without reaching the account. */
  dryRun: boolean;
  online: boolean;
  /** Why it cannot work now: the account's attention, else its first layer that is not ok. */
  problem: { layer: string | null; message: string } | null;
  /** Whether sending works: false with why, true after a send, null before anyone knows (slice 5 sends). */
  send: { ok: boolean | null; why: string | null };
  sync: { phase: 'first' | 'backfill' | 'idle' | 'relist'; synced: number; oldest: number | null };
  /** The account on the manager's page, when the hub knows the page's address. */
  managedUrl: string | null;
  /** Access ended (it left the manager's list, or the grant went): its mail here is deleted at this time. */
  deleteAt: number | null;
}

export interface MailboxView {
  id: string;
  accountId: string;
  name: string;
  path: string;
  parentId: string | null;
  role: MailboxRole | null;
  unread: number | null;
  total: number | null;
  /** The hub keeps this mailbox up to date by itself (Inbox, Sent, All or Archive). */
  followed: boolean;
}

export interface MailAddressView {
  name: string | null;
  email: string;
  /** The person and identity behind the address (slice 6). */
  identityId?: string;
  personId?: string;
}

export interface MailThreadView {
  id: string;
  accountId: string;
  subject: string;
  firstAt: number;
  lastAt: number;
  count: number;
  unread: number;
  flagged: boolean;
  attachments: boolean;
  /** Who wrote in it, latest last; your own messages have `self`. */
  from: (MailAddressView & { self?: boolean })[];
  participants: number;
  preview: string | null;
  mailboxIds: string[];
  roles: MailboxRole[];
  labels: string[];
  /** From a person, bulk, or yours (slice 8; null until then). */
  class: 'personal' | 'bulk' | 'self' | null;
  unknown: boolean;
  personIds: string[];
  lastFromMe: boolean;
  /** When the first message you have not answered came (slice 8). */
  owedSince: number | null;
  muted: boolean;
}

export interface MailMessageView {
  id: string;
  threadId: string;
  accountId: string;
  /** The Message-ID header, `<abc@example.com>`. */
  messageId: string | null;
  from: MailAddressView;
  to: MailAddressView[];
  cc: MailAddressView[];
  subject: string;
  date: number;
  receivedAt: number;
  flags: { seen: boolean; flagged: boolean; answered: boolean; draft: boolean };
  /** Read here only (a read grant, or before marking on the server: slice 4). */
  seenHere: boolean;
  /** A change made here the server has not confirmed yet (slice 4). */
  pending: boolean;
  labels: string[];
  mailboxIds: string[];
  hasAttachments: boolean;
  preview: string | null;
  addressed: 'to' | 'cc' | 'hidden' | 'self';
  body: 'cached' | 'none' | 'loading' | 'failed';
}

export interface MailBodyView {
  messageId: string;
  /** The text part, or text made from the HTML when there is none. */
  text: string | null;
  /** Where quoted text starts in `text` (quoteStart). */
  quoteAt: number | null;
  /** The sanitised HTML (slice 3; null until then). */
  html: { url: string; remoteImages: number; trackers: number; imagesShown: boolean } | null;
  bcc: MailAddressView[];
  replyTo: MailAddressView[];
  /** Slice 3. */
  attachments: MailAttachmentView[];
  /** Display-name spoofing, Reply-To elsewhere, links whose text names another site (slice 3). */
  warnings: string[];
}

export interface MailAttachmentView {
  id: string;
  name: string | null;
  mime: string;
  size: number;
  inline: boolean;
  url: string;
  infoUrl: string;
}

/** Slice 5. */
export interface MailOutboxView {
  id: string;
  clientId: string;
  accountId: string;
  subject: string;
  state: 'held' | 'queued' | 'sending' | 'sent' | 'failed';
  holdUntil: number | null;
  error: string | null;
}

/** What the bootstrap carries of mail: the live window of threads, at most 300. */
export interface MailBootstrap {
  access: MailAccess;
  accounts: MailAccountView[];
  mailboxes: MailboxView[];
  threads: MailThreadView[];
}

/** GET /api/mail/threads: a page of a list, newest first. */
export interface MailThreadPage {
  threads: MailThreadView[];
  /** The cursor for the next page, or null at the end of what the hub holds. */
  next: string | null;
  /** The hub holds the whole list (else older mail is on the server only, for now). */
  complete: boolean;
  /** The page is being fetched from the server; a `mail.threads` event brings it (slice 2). */
  pending: boolean;
}

/** GET /api/mail/threads/:id */
export interface MailThreadDetail {
  thread: MailThreadView;
  messages: MailMessageView[];
  /** The email identities of the people on it (slice 6). */
  identities?: IdentityView[];
}

// ------------------------------------------------------------------ lists

/** The views a list key can name. `people` and `updates` come with classification (slice 8). */
export type MailView = 'inbox' | 'unread' | 'starred' | 'sent' | 'people' | 'updates';

/**
 * A list of threads: `mb:<mailbox id>`, or `v:<view>:<account id or *>`. The page keeps lists by these keys, and
 * `mail.lists` names them when they are stale (slice 2).
 */
export type MailListKey = string;

export const mailboxList = (mailboxId: string): MailListKey => `mb:${mailboxId}`;
export const viewList = (view: MailView, accountId: string | null = null): MailListKey => `v:${view}:${accountId ?? '*'}`;

export function parseMailList(key: string): { mailbox: string } | { view: MailView; accountId: string | null } | null {
  const m = key.match(/^mb:([\w-]+)$/);
  if (m) return { mailbox: m[1] };
  const v = key.match(/^v:(inbox|unread|starred|sent|people|updates):([\w-]+|\*)$/);
  return v ? { view: v[1] as MailView, accountId: v[2] === '*' ? null : v[2] } : null;
}

// ------------------------------------------------------------------ text

const ATTRIBUTION = [
  /^On\b.{4,200}\bwrote:\s*$/i,
  /^Am\b.{4,200}\bschrieb\b.{0,40}:\s*$/i,
  /^Le\b.{4,200}\ba écrit\s*:\s*$/i,
  /^El\b.{4,200}\bescribió:\s*$/i,
  /^.{2,120} <[^<>\s]+@[^<>\s]+> (?:wrote|schrieb|a écrit|escribió):\s*$/i,
];
const FORWARD_HEAD = /^\s*(-{2,}\s*(Original Message|Forwarded message|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}|_{20,})\s*$/i;

/**
 * Where the quoted part of a plain-text mail starts: the last block of `>` lines that runs to the end (with the
 * "On … wrote:" line before it, even when a client wrapped it over two lines), or an Outlook-style "Original Message"
 * header and everything after it. Null when there is none, or nothing would be left above it to show.
 */
export function quoteStart(text: string): number | null {
  const lines = text.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  let cut: number | null = null;
  // A forwarded or Outlook-quoted original: from its header line on.
  for (let i = 0; i < lines.length; i++) {
    if (FORWARD_HEAD.test(lines[i]) && lines.slice(i + 1, i + 4).some((l) => /^\s*(From|Von|De):/i.test(l))) {
      cut = i;
      break;
    }
  }
  // The trailing `>` block: blank lines may sit between quoted ones, and after it.
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  let first = -1;
  for (let i = end; i >= 0; i--) {
    const l = lines[i];
    if (/^\s*>/.test(l)) first = i;
    else if (!l.trim() && first >= 0) continue;
    else break;
  }
  if (first >= 0) {
    let i = first;
    while (i > 0 && !lines[i - 1].trim()) i--;
    const one = lines[i - 1] ?? '';
    const two = `${lines[i - 2] ?? ''} ${one}`.trim();
    if (ATTRIBUTION.some((r) => r.test(one))) i -= 1;
    else if (i >= 2 && ATTRIBUTION.some((r) => r.test(two))) i -= 2;
    cut = cut === null ? i : Math.min(cut, i);
  }
  if (cut === null) return null;
  // Something must be left to show above it.
  if (!lines.slice(0, cut).some((l) => l.trim())) return null;
  return starts[cut];
}

/** A list row's line from a body: 200 characters, without the quoted part or the signature. */
export function mailPreview(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const q = quoteStart(text);
  let t = q === null ? text : text.slice(0, q);
  const sig = t.search(/^-- ?$/m);
  if (sig > 0) t = t.slice(0, sig);
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** `Name <a@b>` or the address alone. */
export function mailAddressText(a: { name: string | null; email: string }): string {
  return a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email;
}
