/**
 * An in-memory mail server behind the MailBackend interface (docs/mail-design.md §12.2): the hub's mail tests run on
 * it, and a demo world (--demo) seeds one account with it. It behaves like either extractor, as asked:
 *
 *   ids        'imap': a message gets a new id when it moves (a new UID); 'proton': ids survive moves; 'gmail': one
 *              message sits in several mailboxes at once (Inbox, All Mail, a label), with an id in each ("Gmail" below);
 *              'gmail-web': Gmail through the signed-in browser, one id for the message in every mailbox ("Gmail on
 *              the web" below)
 *   threadIds  the server's thread on summaries (Gmail, Proton), or none (plain IMAP)
 *   refs       In-Reply-To, References and bulk headers on summaries (dither-accounts' §13 fields), or only from
 *              mail.get (Proton); the status's `details.summaryHeaders` says which, as the extractors' do
 *   state      one per mailbox (IMAP), or one for the whole account (Proton's event loop)
 *   events     mail.changed for the inbox only (IMAP IDLE), or for every mailbox (Proton's event loop)
 *   search     mail.search: each word in the sender, recipients, subject or text (IMAP; Gmail takes its own syntax,
 *              and here only its plain words count), or in the subject and addresses only (Proton). With `idsOnly`
 *              on an account whose details say `searchIds`, the ids only, paged by cursor (500 a page at most), with an
 *              estimate: the paged search dither-accounts proposed for keeping all mail (keep.ts)
 *   details    what the status's `details` say of the server (idPerMessage, sendCap, maxRecipients, provider), as
 *              dither-accounts' extractors say them: Proton's and Gmail on the web's; the imap extractor says none of
 *              these but `provider` (its gmail preset)
 *
 * Changes made "on the server" (deliver, move, setFlags, remove, rebuild) are what another mail client would do; they
 * reach the hub as events and through mail.changes. Calls can be made to fail (410, 503, 404, limited) or slow.
 *
 * mail.send (slice 5) checks From against the account's addresses (422, code 'from'), can refuse a recipient as
 * Proton's extractor does (422, code 'recipients': `refuseRecipient`), answers a dry run as the manager does, keeps
 * what it got in `sent` (with the files' bytes, read from a path or base64), and puts a copy in Sent that threads to
 * the original by In-Reply-To and References, which it marks answered.
 *
 * The hub's own writes (mail.flag, mail.move, mail.trash) change it as the extractors do: at most 1000 ids a call, 403
 * on a read grant, `{ dryRun: true }` and no change on a dry run (as the manager answers), mail.changed for every
 * mailbox they touched (an extractor reports this app's own changes), Proton's 501 for `answered`, and a move answering
 * the new ids (or nulls, as an IMAP server without UIDPLUS may). A write of a kind the status's `details.writes` leaves
 * out is 501 with no change, as dither-accounts answers. Ids a test made the server turn down or lose (`refuse`) do not
 * change: a 200 names them (`refused`, `unknown`; null in a move's ids), or, when none changed, 422 `refused` or 404.
 *
 * Gmail (`ids: 'gmail'`) is what dither-accounts' imap extractor sends for an account with the `gmail` preset
 * (extractors/imap/src/{imap,ids,config,smtp}.ts there). Gmail's labels are IMAP mailboxes, so one message is a copy in
 * each mailbox its labels put it in, each with its own `<mailbox>.<UIDVALIDITY>.<UID>` id (ids.ts), its flags shared
 * (they are the message's). Mailboxes are GMAIL_MAILBOXES, ids the base64url of their paths (ids.ts mailboxId), roles
 * from SPECIAL-USE as imapflow 2.11 reads them, and \Important (imap.ts roleOf): All Mail is 'all' and there is no
 * Archive; Spam is 'junk'; Starred is 'flagged'; Important is 'important'; the `[Gmail]` parent is \Noselect (no
 * counts, and listing it is 404). A summary's `emailId` is X-GM-MSGID, the same in every mailbox; its `labels` are
 * imap.ts labelsOf: Gmail's X-GM-LABELS as they come (`\Inbox`, `\Important`, `\Starred`, `\Sent`, user labels by
 * path), where Gmail never names \Trash, \Spam or All Mail, and leaves out the label of the mailbox the message was
 * listed from (Mozilla bug 798648, and Limilabs' "GmailLabels does not contain draft label"). `threadId` is
 * X-GM-THRID: a reply joins the thread its references name.
 * Gmail has no category labels over IMAP (Promotions and the rest are not exposed), so none come. Keeping up is
 * CONDSTORE (imap.ts changes, mode 'c'): a flag or label change shows as `changed` in every mailbox holding the
 * message. A move is Gmail's: the destination's label added, the source's removed, so moving out of Inbox into All
 * Mail is archiving and answers the All Mail id it already had; into Trash or Spam it leaves every other mailbox. Out
 * of All Mail the extractor COPYs instead (imap.ts copiesInstead: a MOVE out of All Mail Gmail takes as a delete, which
 * another client's `move` here still does): into Inbox or a label it puts that label on and stays in All Mail, and
 * answers the copy's id; into Trash or Spam it still moves. Starred is the \Flagged flag. Search is X-GM-RAW in All Mail
 * (imap.ts search), as much of Gmail's syntax as the hub sends. Sending leaves the copy in Sent to Gmail (config.ts
 * preset sentCopy 'server'): it shows in Sent Mail and All Mail with the original's thread, and `sentId` is it (smtp.ts
 * finds it by Message-ID).
 *
 * Gmail on the web (`ids: 'gmail-web'`) is dither-accounts' google kind: Gmail read through the signed-in browser,
 * where a label is a mailbox and a message has one id in all of them, as on Proton. Its status says `provider` 'Gmail'
 * and `idPerMessage`, and its address need not be Gmail's (a Workspace domain). Mailboxes are GMAIL_WEB_MAILBOXES, each
 * a label with a fixed id (Gmail's own: INBOX, SENT, DRAFT, TRASH, SPAM, IMPORTANT), All Mail made up from them (every
 * message not in Trash or Spam, role 'all'), and a user label each (`Label_<n>`, role null). One FakeMessage is the
 * message, its `gm` its own id, its labels in the account's `gm` (Gmail's system ones as the imap extractor names them,
 * `\Inbox` and the like, user labels by path); which mailboxes list it follows from them: in Trash or Spam it is there alone. A
 * summary's labels are all of them, from whichever mailbox, Gmail's categories among them (`Category/Promotions`,
 * `Category/Social`, `Category/Updates`, `Category/Forums`: labels, not mailboxes); its `emailId` is its id. As
 * dither-accounts reads Gmail's web protocol, its summaries carry no headers: no Message-ID, In-Reply-To, References or
 * list headers (summaryHeaders false), which mail.get has, as on Proton. A move is a label change by its
 * destination, since mail.move names no mailbox it comes from: the destination's label on, Inbox's off (as Gmail's
 * Move to does from the inbox, and archiving into All Mail), unless it goes to Inbox; Trash's and Spam's off, unless it
 * goes there; into Spam Inbox's off too. So out of All Mail a move only adds a label, and nothing is copied. A trashed
 * message keeps its labels for when it comes back. Flags are the message's; starring is \Flagged, no mailbox. State is
 * the account's, and every mailbox's changes are told (events 'all').
 */
import { readFileSync } from 'node:fs';
import type * as P from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { type Clock, realClock, sleep } from '../clock.ts';
import { MailCallError, type MailBackend, type MailBackendAccount, type MailBackendEvent } from './backend.ts';
import { htmlText } from './store.ts';

export interface FakeOpts {
  /** 'gmail' and 'gmail-web' bring Gmail's mailboxes, its threads and its search with them (the header above). */
  ids?: 'imap' | 'proton' | 'gmail' | 'gmail-web';
  threadIds?: boolean;
  refs?: boolean;
  state?: 'mailbox' | 'account';
  events?: 'inbox' | 'all';
  /** What mail.send would answer (slice 5). */
  send?: 'ok' | 501;
  /**
   * mail.send refuses this recipient (1-based: To, then Cc, then Bcc, each address once) with 422 'recipients', as
   * Proton's extractor does for one it can't send to safely; 0, or a number past the last, refuses none.
   */
  refuseRecipient?: number;
  latencyMs?: number;
  /** How many changes one mail.changes answers before saying `more`. */
  changesPage?: number;
  /** What mail.move answers for the moved messages: their new ids, or null (the server would not say). */
  moveIds?: 'new' | 'null';
  /** What mail.search looks in (slice 7); by default as `ids`. */
  search?: 'imap' | 'gmail' | 'proton';
  /** Whoever you write to answers this many ms later, into Inbox (a demo world: something to notify about); 0: never. */
  answer?: number;
  /** The status's `details.summaryHeaders`: as `refs` unless set; null leaves it out (an extractor from before it). */
  summaryHeaders?: boolean | null;
  /**
   * More of the status's `details`: by default PROTON_DETAILS on Proton, GMAIL_WEB_DETAILS on Gmail on the web, none
   * elsewhere; null says none of them (an extractor from before them).
   */
  details?: Record<string, unknown> | null;
}

const MB = 1024 * 1024;
/** What dither-accounts' Proton extractor says of its server: one id a message, 25 MB of files, 100 recipients. */
export const PROTON_DETAILS = { idPerMessage: true, sendCap: 25 * MB, maxRecipients: 100 };
/** And its google kind's: Gmail, one id a message, 25 MB of files, 100 recipients, every write but Spam. */
export const GMAIL_WEB_DETAILS = { provider: 'Gmail', idPerMessage: true, sendCap: 25 * MB, maxRecipients: 100, writes: ['seen', 'flagged', 'move', 'trash'] };

/** A message as the fake server keeps it. */
export interface FakeMessage extends Omit<M.MailMessage, 'mailboxId' | 'id'> {
  id: string;
  mailboxId: string;
  /** Attachments' bytes by attachment id, for mail.attachment (slice 3); one not here gets bytes made up to its size. */
  files?: Record<string, Uint8Array | string>;
  /** Gmail: the message this is a copy of (its X-GM-MSGID); its copies in other mailboxes share it. On the web: its id. */
  gm?: string;
}

/** A message the fake sent (slice 5): what it was given, and its files' bytes. */
export interface FakeSent {
  account: string;
  mail: M.OutgoingMail;
  files: { filename: string; mime: string; bytes: Uint8Array; by: 'path' | 'base64' }[];
  messageId: string;
}

/**
 * What a test or seed gives: anything left out gets a plain default. On Gmail, `labels` are Gmail's: user labels by
 * path (a mailbox is made for one it has not got) and system ones such as `\Important`; `mailboxId` adds its own.
 */
export type FakeInput = Partial<Omit<FakeMessage, 'flags'>> & { flags?: Partial<M.MailFlags> };

interface Account {
  view: MailBackendAccount;
  opts: Required<FakeOpts>;
  self: { email: string; displayName?: string; addresses?: M.MailAccountAddress[] };
  mailboxes: M.Mailbox[];
  messages: Map<string, FakeMessage>;
  /** What changed, in order: the mail.changes journal. */
  log: { seq: number; mailbox: string; kind: 'added' | 'changed' | 'removed'; id: string }[];
  seq: number;
  /** Bumped by a rebuild: states from before answer 410. Per mailbox, or '*' for an account-wide state. */
  epochs: Map<string, number>;
  nextUid: number;
  status: Record<string, unknown>;
  /** Each mailbox's messages, newest first, until something changes (a big mailbox lists fast). */
  sorted: Map<string, FakeMessage[]>;
  /** Gmail: each message's labels (X-GM-MSGID, or its id on the web → Gmail's labels, `\Inbox` and the like with their backslash). */
  gm: Map<string, Set<string>>;
  /** Mailboxes that only hold others (IMAP \Noselect: Gmail's `[Gmail]`). */
  noselect: Set<string>;
  /** Ids whose writes the server turns down (`refused`) or does not find (`unknown`): `refuse`. */
  refusals: Map<string, 'refused' | 'unknown'>;
}

/** A mailbox id as dither-accounts' imap extractor makes it (extractors/imap/src/ids.ts): base64url of its path. */
export const gmailBoxId = (path: string) => Buffer.from(path, 'utf8').toString('base64url');

/** A Gmail mailbox as the extractor lists it: its name is the last part of the path, its parent the path before. */
export function gmailBox(path: string, role: M.MailboxRole | null = null): M.Mailbox {
  const cut = path.lastIndexOf('/');
  return { id: gmailBoxId(path), name: path.slice(cut + 1), path, parentId: cut > 0 ? gmailBoxId(path.slice(0, cut)) : null, role, unread: null, total: null };
}

/** Gmail's mailboxes, by what they are. */
export const GMAIL = {
  inbox: gmailBoxId('INBOX'),
  /** `[Gmail]`: \Noselect, the parent of the rest. */
  parent: gmailBoxId('[Gmail]'),
  all: gmailBoxId('[Gmail]/All Mail'),
  drafts: gmailBoxId('[Gmail]/Drafts'),
  important: gmailBoxId('[Gmail]/Important'),
  sent: gmailBoxId('[Gmail]/Sent Mail'),
  spam: gmailBoxId('[Gmail]/Spam'),
  starred: gmailBoxId('[Gmail]/Starred'),
  trash: gmailBoxId('[Gmail]/Trash'),
};

/** What mail.mailboxes answers for a Gmail account with no labels of its own (imapflow's LIST, imap.ts mailboxes). */
export const GMAIL_MAILBOXES: M.Mailbox[] = [
  { ...gmailBox('INBOX', 'inbox'), name: 'INBOX' },
  gmailBox('[Gmail]'),
  gmailBox('[Gmail]/All Mail', 'all'),
  gmailBox('[Gmail]/Drafts', 'drafts'),
  // Gmail lists it \Important (RFC 8457), which the extractor's roleOf reads from its flags.
  gmailBox('[Gmail]/Important', 'important'),
  gmailBox('[Gmail]/Sent Mail', 'sent'),
  gmailBox('[Gmail]/Spam', 'junk'),
  gmailBox('[Gmail]/Starred', 'flagged'),
  gmailBox('[Gmail]/Trash', 'trash'),
];

/** Gmail's label for the messages in a mailbox, as X-GM-LABELS names it; null for All Mail and `[Gmail]`. */
function gmailLabelOf(b: M.Mailbox | undefined): string | null {
  if (!b) return null;
  const byRole: Partial<Record<M.MailboxRole, string>> = { inbox: '\\Inbox', sent: '\\Sent', drafts: '\\Draft', junk: '\\Spam', trash: '\\Trash', flagged: '\\Starred', important: '\\Important' };
  if (b.role) return byRole[b.role] ?? null;
  return b.path.startsWith('[Gmail]') ? null : b.path;
}

/** Gmail on the web's mailboxes, by what they are: its system labels' ids, and All Mail made up from them. */
export const GMAIL_WEB = { inbox: 'INBOX', all: 'ALL_MAIL', sent: 'SENT', drafts: 'DRAFT', important: 'IMPORTANT', spam: 'SPAM', trash: 'TRASH' };

const webBox = (id: string, name: string, role: M.MailboxRole | null): M.Mailbox => ({ id, name, path: name, parentId: null, role, unread: null, total: null });

/** What mail.mailboxes answers for Gmail on the web with no labels of its own. */
export const GMAIL_WEB_MAILBOXES: M.Mailbox[] = [
  webBox(GMAIL_WEB.inbox, 'Inbox', 'inbox'),
  webBox(GMAIL_WEB.all, 'All Mail', 'all'),
  webBox(GMAIL_WEB.sent, 'Sent', 'sent'),
  webBox(GMAIL_WEB.drafts, 'Drafts', 'drafts'),
  webBox(GMAIL_WEB.important, 'Important', 'important'),
  webBox(GMAIL_WEB.spam, 'Spam', 'junk'),
  webBox(GMAIL_WEB.trash, 'Trash', 'trash'),
];

/** Gmail on the web: the label a mailbox lists, as the message's labels name it; null for All Mail. */
function webLabelOf(b: M.Mailbox | undefined): string | null {
  if (!b) return null;
  const byRole: Partial<Record<M.MailboxRole, string>> = { inbox: '\\Inbox', sent: '\\Sent', drafts: '\\Draft', junk: '\\Spam', trash: '\\Trash', important: '\\Important' };
  if (b.role) return byRole[b.role] ?? null;
  return b.path;
}

const DEFAULT_MAILBOXES: M.Mailbox[] = [
  { id: 'INBOX', name: 'Inbox', path: 'INBOX', parentId: null, role: 'inbox', unread: null, total: null },
  { id: 'Sent', name: 'Sent', path: 'Sent', parentId: null, role: 'sent', unread: null, total: null },
  { id: 'Archive', name: 'Archive', path: 'Archive', parentId: null, role: 'archive', unread: null, total: null },
  { id: 'Drafts', name: 'Drafts', path: 'Drafts', parentId: null, role: 'drafts', unread: null, total: null },
  { id: 'Junk', name: 'Junk', path: 'Junk', parentId: null, role: 'junk', unread: null, total: null },
  { id: 'Trash', name: 'Trash', path: 'Trash', parentId: null, role: 'trash', unread: null, total: null },
];

type Failure = (input: Record<string, any>) => MailCallError | null;

export class FakeMailBackend implements MailBackend {
  connected = true;
  private accs = new Map<string, Account>();
  private state: P.MailAccess['state'] = 'granted';
  private fns = { accounts: [] as ((a: MailBackendAccount[]) => void)[], events: [] as ((a: string, e: MailBackendEvent[]) => void)[], gap: [] as ((a: string) => void)[], connection: [] as ((u: boolean) => void)[], access: [] as ((s: P.MailAccess['state']) => void)[] };
  private failures = new Map<string, Failure[]>();
  /** Every call made, for tests to count, with when it was made. */
  readonly calls: { account: string; op: string; input: Record<string, any>; at: number }[] = [];
  /** What mail.send sent. */
  readonly sent: FakeSent[] = [];
  /** As a manager on this machine: attachments may come as paths. */
  localFiles = true;
  /** When calls are made and answered: a test's clock runs the hub's pacing in no time. */
  clock: Clock = realClock;

  constructor(private defaults: FakeOpts = {}) {}

  // ---------------------------------------------------------- MailBackend

  access() {
    return this.state;
  }
  accountsList(): MailBackendAccount[] {
    return [...this.accs.values()].map((a) => ({ ...a.view }));
  }
  onAccounts(fn: (a: MailBackendAccount[]) => void) {
    this.fns.accounts.push(fn);
    fn(this.accountsList());
  }
  onEvents(fn: (a: string, e: MailBackendEvent[]) => void) {
    this.fns.events.push(fn);
    // As the manager does for a new app connection: each account's latest hello and status again.
    for (const [id, a] of this.accs) fn(id, [{ t: 'hello' }, a.status as MailBackendEvent]);
  }
  onGap(fn: (a: string) => void) {
    this.fns.gap.push(fn);
  }
  onConnection(fn: (u: boolean) => void) {
    this.fns.connection.push(fn);
  }
  onAccess(fn: (s: P.MailAccess['state']) => void) {
    this.fns.access.push(fn);
  }
  async askAgain() {
    this.setAccess('pending');
  }

  async call<T>(account: string, op: string, input: Record<string, any> = {}): Promise<T> {
    this.calls.push({ account, op, input, at: this.clock.now() });
    const a = this.accs.get(account);
    const latency = a?.opts.latencyMs ?? this.defaults.latencyMs ?? 0;
    // An answer comes back later, as over a socket: never in the same turn (on a test's clock, a timer of its own).
    if (latency || this.clock !== realClock) await sleep(this.clock, latency);
    else await new Promise((r) => setImmediate(r));
    if (!this.connected) throw new MailCallError('the manager is not reachable', 503, 'offline');
    if (!a) throw new MailCallError(`no account ${account}`, 404, 'unknown-account');
    const fs = this.failures.get(op) ?? [];
    for (const f of fs) {
      const e = f(input);
      if (e) {
        fs.splice(fs.indexOf(f), 1);
        throw e;
      }
    }
    return this.answer(a, op, input) as T;
  }

  // ---------------------------------------------------------- the server's side, for tests and the demo

  addAccount(id: string, o: { kind?: string; label?: string; email: string; name?: string; addresses?: M.MailAccountAddress[]; level?: 'read' | 'write'; dryRun?: boolean; mailboxes?: M.Mailbox[]; opts?: FakeOpts; online?: boolean }) {
    const ids = o.opts?.ids ?? this.defaults.ids;
    const gmail = ids === 'gmail';
    const web = ids === 'gmail-web';
    // Gmail on the web: no headers on summaries.
    const refs = o.opts?.refs ?? this.defaults.refs ?? !web;
    const opts: Required<FakeOpts> = {
      ids: 'imap',
      threadIds: gmail || web,
      refs,
      state: web ? 'account' : 'mailbox',
      events: web ? 'all' : 'inbox',
      send: 'ok',
      refuseRecipient: 0,
      latencyMs: 0,
      changesPage: 200,
      moveIds: 'new',
      search: ids === 'proton' ? 'proton' : gmail || web ? 'gmail' : 'imap',
      answer: 0,
      summaryHeaders: refs,
      details: ids === 'proton' ? PROTON_DETAILS : web ? GMAIL_WEB_DETAILS : {},
      ...this.defaults,
      ...o.opts,
    };
    const online = o.online ?? true;
    const a: Account = {
      view: { id, kind: o.kind ?? (opts.ids === 'proton' ? 'proton' : opts.ids === 'gmail-web' ? 'google' : 'imap'), label: o.label ?? o.email, level: o.level ?? 'write', dryRun: !!o.dryRun, online },
      opts,
      self: { email: o.email, ...(o.name ? { displayName: o.name } : {}), ...(o.addresses ? { addresses: o.addresses } : {}) },
      mailboxes: (o.mailboxes ?? (gmail ? GMAIL_MAILBOXES : web ? GMAIL_WEB_MAILBOXES : DEFAULT_MAILBOXES)).map((b) => ({ ...b })),
      messages: new Map(),
      log: [],
      seq: 1,
      epochs: new Map(),
      nextUid: 1,
      status: {},
      sorted: new Map(),
      gm: new Map(),
      noselect: new Set(gmail ? [GMAIL.parent] : []),
      refusals: new Map(),
    };
    a.status = this.statusOf(a, online);
    this.accs.set(id, a);
    this.listChanged();
    this.emit(id, [{ t: 'hello' }, a.status as MailBackendEvent]);
    return a;
  }

  removeAccount(id: string) {
    this.accs.delete(id);
    this.listChanged();
  }

  /** A mailbox made on the server (the hub sees it at its next mail.mailboxes). */
  addMailbox(id: string, box: M.Mailbox) {
    this.accs.get(id)!.mailboxes.push({ ...box });
  }

  /** Changes how the account's server behaves from now on (a test making it slow, say). */
  setOpts(id: string, opts: FakeOpts) {
    Object.assign(this.accs.get(id)!.opts, opts);
  }

  /** The account goes offline or comes back, as its status says. */
  setOnline(id: string, online: boolean) {
    const a = this.accs.get(id)!;
    a.view.online = online;
    a.status = this.statusOf(a, online);
    this.listChanged();
    this.emit(id, [a.status as MailBackendEvent]);
  }

  setStatus(id: string, status: Record<string, unknown>) {
    const a = this.accs.get(id)!;
    a.status = { t: 'status', ...status };
    this.emit(id, [a.status as MailBackendEvent]);
  }

  /** The grant changed on the manager's page: read or write, dry run or not. */
  setGrant(id: string, g: { level?: 'read' | 'write'; dryRun?: boolean }) {
    const a = this.accs.get(id)!;
    if (g.level) a.view.level = g.level;
    if (g.dryRun !== undefined) a.view.dryRun = g.dryRun;
    this.listChanged();
  }

  setAccess(state: P.MailAccess['state']) {
    this.state = state;
    for (const f of this.fns.access) f(state);
  }

  /** The manager going away and coming back: calls fail meanwhile and events are lost. */
  setConnected(up: boolean) {
    this.connected = up;
    for (const f of this.fns.connection) f(up);
    if (up) this.listChanged();
  }

  /** The manager dropped events for this account (a gap). */
  gap(id: string) {
    for (const f of this.fns.gap) f(id);
  }

  /**
   * From now on, writes on these ids are turned down by the server (`refused`) or find no message (`unknown`): the rest
   * of the call still changes and the answer names them (the google kind's partial answers). Null lets them be again.
   */
  refuse(account: string, ids: string[], how: 'refused' | 'unknown' | null) {
    const r = this.accs.get(account)!.refusals;
    for (const id of ids) if (how) r.set(id, how);
    else r.delete(id);
  }

  /** `op` fails once with this error (or each time `when` says so, once per call it matches). */
  fail(op: string, e: MailCallError, when: Failure = () => e) {
    const list = this.failures.get(op) ?? [];
    list.push((input) => (when(input) ? e : null));
    this.failures.set(op, list);
  }

  /** Put a message on the server without telling anyone (a seed: listed by the first sync). On Gmail: its copy there. */
  put(account: string, input: FakeInput): FakeMessage {
    const a = this.accs.get(account)!;
    if (a.opts.ids === 'gmail') return this.gmPut(a, input);
    if (a.opts.ids === 'gmail-web') return this.webPut(a, input);
    const m = this.make(a, input);
    a.messages.set(m.id, m);
    this.journal(a, m.mailboxId, 'added', m.id);
    return m;
  }

  /** A new message arrives: mail.arrived and mail.changed, as the extractor sends them. */
  deliver(account: string, input: FakeInput): FakeMessage {
    const a = this.accs.get(account)!;
    const m = this.put(account, input);
    const evs: MailBackendEvent[] = [];
    // On the web it arrives in every mailbox its labels put it in at once.
    const seen = (a.opts.ids === 'gmail-web' ? [...this.webBoxes(a, m)] : [m.mailboxId]).filter((b) => this.watched(a, b));
    if (seen.length) evs.push({ t: 'mail.arrived', message: this.summary(a, m, seen[0]) }, ...seen.map((b): MailBackendEvent => ({ t: 'mail.changed', mailboxId: b, state: this.stateOf(a, b) })));
    this.emit(account, evs);
    return m;
  }

  /** Another client moved it: under IMAP it gets a new id there. Returns the new id. */
  move(account: string, id: string, to: string): string {
    const a = this.accs.get(account)!;
    if (a.opts.ids === 'gmail') {
      const r = this.gmMove(a, id, to);
      this.changedEvents(a, [...r.touched]);
      return r.id!;
    }
    if (a.opts.ids === 'gmail-web') {
      this.changedEvents(a, [...this.webMove(a, id, to)]);
      return id;
    }
    const m = a.messages.get(id)!;
    const from = m.mailboxId;
    a.messages.delete(id);
    this.journal(a, from, 'removed', id);
    const moved = { ...m, mailboxId: to, id: a.opts.ids === 'imap' ? this.uid(a, to) : id };
    a.messages.set(moved.id, moved);
    this.journal(a, to, 'added', moved.id);
    this.changedEvents(a, [from, to]);
    return moved.id;
  }

  setFlags(account: string, id: string, flags: Partial<M.MailFlags>) {
    const a = this.accs.get(account)!;
    if (a.opts.ids === 'gmail') return this.changedEvents(a, [...this.gmFlags(a, a.messages.get(id)!.gm!, flags)]);
    if (a.opts.ids === 'gmail-web') return this.changedEvents(a, [...this.webFlags(a, a.messages.get(id)!, flags)]);
    const m = a.messages.get(id)!;
    m.flags = { ...m.flags, ...flags };
    this.journal(a, m.mailboxId, 'changed', id);
    this.changedEvents(a, [m.mailboxId]);
  }

  /** Deleted for good (expunged, or emptied from the trash). */
  remove(account: string, id: string) {
    const a = this.accs.get(account)!;
    const m = a.messages.get(id);
    if (!m) return;
    if (a.opts.ids === 'gmail-web') {
      // Gone from every mailbox it was in.
      const boxes = [...this.webBoxes(a, m)];
      a.messages.delete(id);
      for (const b of boxes) this.journal(a, b, 'removed', id);
      a.gm.delete(id);
      return this.changedEvents(a, boxes);
    }
    if (m.gm) {
      // Gmail: the message goes, and with it every copy.
      const boxes: string[] = [];
      for (const c of this.gmCopies(a, m.gm)) {
        a.messages.delete(c.id);
        this.journal(a, c.mailboxId, 'removed', c.id);
        boxes.push(c.mailboxId);
      }
      a.gm.delete(m.gm);
      return this.changedEvents(a, boxes);
    }
    a.messages.delete(id);
    // Proton says so in every mailbox's changes, whether it was there or not.
    if (a.opts.state === 'account') for (const b of a.mailboxes) this.journal(a, b.id, 'removed', id);
    else this.journal(a, m.mailboxId, 'removed', id);
    this.changedEvents(a, [m.mailboxId]);
  }

  /** The mailbox was rebuilt (IMAP: a new UIDVALIDITY): every id in it changes and old states answer 410. */
  rebuild(account: string, mailbox: string) {
    const a = this.accs.get(account)!;
    const key = a.opts.state === 'account' ? '*' : mailbox;
    a.epochs.set(key, (a.epochs.get(key) ?? 0) + 1);
    if (key !== mailbox) a.epochs.set(mailbox, (a.epochs.get(mailbox) ?? 0) + 1);
    a.sorted.clear();
    // Proton's refresh keeps its ids, as Gmail on the web's; an IMAP server's new UIDVALIDITY gives each message a new one.
    for (const m of a.opts.ids !== 'proton' && a.opts.ids !== 'gmail-web' ? [...a.messages.values()] : []) {
      if (m.mailboxId !== mailbox) continue;
      a.messages.delete(m.id);
      const fresh = { ...m, id: this.uid(a, mailbox) };
      a.messages.set(fresh.id, fresh);
    }
    this.changedEvents(a, [mailbox]);
  }

  /** The messages on the server, or those a mailbox lists (on the web, a message is listed by every mailbox it is in). */
  messages(account: string, mailbox?: string): FakeMessage[] {
    const a = this.accs.get(account)!;
    return [...a.messages.values()].filter((m) => !mailbox || this.isIn(a, m, mailbox));
  }

  /** Gmail on the web: the mailboxes that list a message, as the server has them. */
  mailboxesOf(account: string, id: string): string[] {
    const a = this.accs.get(account)!;
    const m = a.messages.get(id);
    return m ? [...this.webBoxes(a, m)] : [];
  }

  /**
   * Gmail: another client (Gmail on the web, the phone app) adds or takes off labels, `\Inbox` among them: taking it
   * off archives. Its copies come and go with them.
   */
  label(account: string, id: string, change: { add?: string[]; remove?: string[] }) {
    const a = this.accs.get(account)!;
    if (a.opts.ids === 'gmail-web') return this.changedEvents(a, [...this.webRelabel(a, a.messages.get(id)!, change.add ?? [], change.remove ?? [])]);
    const gm = a.messages.get(id)!.gm!;
    this.changedEvents(a, [...this.gmRelabel(a, gm, change.add ?? [], change.remove ?? [])]);
  }

  /** Gmail: a message's labels as Gmail keeps them (not as a summary from one mailbox shows them). */
  labelsOnServer(account: string, id: string): string[] {
    const a = this.accs.get(account)!;
    return [...(a.gm.get(a.messages.get(id)?.gm ?? '') ?? [])].sort();
  }

  // ---------------------------------------------------------- inside

  private emit(account: string, events: MailBackendEvent[]) {
    if (!events.length || !this.connected) return;
    for (const f of this.fns.events) f(account, events);
  }

  private listChanged() {
    if (!this.connected) return;
    const list = this.accountsList();
    for (const f of this.fns.accounts) f(list);
  }

  private statusOf(a: Account, online: boolean): Record<string, unknown> {
    const sendOk = a.opts.send === 'ok';
    // The imap extractor's details (main.ts sendStatus) for its gmail preset.
    const gmail = a.opts.ids === 'gmail' ? { provider: 'Gmail', capabilities: 'IDLE MOVE UIDPLUS CONDSTORE SPECIAL-USE X-GM-EXT-1', 'sent copy': 'the server keeps it' } : {};
    return {
      t: 'status',
      status: online ? 'online' : 'offline',
      attention: null,
      self: a.self,
      details: {
        ...gmail,
        sync: a.opts.ids === 'gmail' ? 'CONDSTORE (UID list kept)' : a.opts.state === 'account' ? 'events' : 'QRESYNC',
        canSend: sendOk,
        sendNote: sendOk ? null : 'Sending is not supported here (the extractor answered 501).',
        ...(a.opts.summaryHeaders === null ? {} : { summaryHeaders: a.opts.summaryHeaders }),
        ...(a.opts.details ?? {}),
      },
      layers: [
        { name: 'server', state: online ? 'ok' : 'failed', ...(online ? {} : { note: 'not reachable' }) },
        { name: 'signed in', state: online ? 'ok' : 'waiting' },
        { name: 'inbox', state: online ? 'ok' : 'waiting' },
        { name: sendOk ? 'SMTP' : 'send path', state: sendOk ? 'ok' : 'failed', ...(sendOk ? {} : { note: 'not found' }) },
      ],
    };
  }

  private watched(a: Account, mailbox: string): boolean {
    return a.opts.events === 'all' || a.mailboxes.find((b) => b.id === mailbox)?.role === 'inbox';
  }

  /** `own`: the app's own writes, which the extractor reports in every mailbox they touched. */
  private changedEvents(a: Account, mailboxes: string[], own = false) {
    const evs: MailBackendEvent[] = [];
    for (const b of new Set(mailboxes)) if (own || this.watched(a, b)) evs.push({ t: 'mail.changed', mailboxId: b, state: this.stateOf(a, b) });
    this.emit(a.view.id, evs);
  }

  private uid(a: Account, mailbox: string): string {
    // Gmail on the web's: 16 hex digits, the message's in every mailbox.
    if (a.opts.ids === 'gmail-web') return (0x19a0_0000_0000_0000n + BigInt(a.nextUid++)).toString(16);
    // IMAP's shape: <mailbox>.<UIDVALIDITY>.<UID>
    return a.opts.ids !== 'proton' ? `${mailbox}.${100 + (a.epochs.get(mailbox) ?? 0)}.${a.nextUid++}` : `p${a.nextUid++}`;
  }

  /** Is it listed by this mailbox: where it is, or on the web, where its labels put it. */
  private isIn(a: Account, m: FakeMessage | undefined, box: string): boolean {
    if (!m) return false;
    return a.opts.ids === 'gmail-web' ? this.webBoxes(a, m).has(box) : m.mailboxId === box;
  }

  private make(a: Account, i: FakeInput): FakeMessage {
    const mailboxId = i.mailboxId ?? 'INBOX';
    const at = i.receivedAt ?? Date.now();
    return {
      id: i.id ?? this.uid(a, mailboxId),
      mailboxId,
      messageId: i.messageId === undefined ? `<${crypto.randomUUID()}@fake.example>` : i.messageId,
      threadId: i.threadId ?? null,
      from: i.from ?? [{ name: 'Someone', email: 'someone@example.net' }],
      to: i.to ?? [{ name: null, email: a.self.email }],
      cc: i.cc ?? [],
      bcc: i.bcc ?? [],
      replyTo: i.replyTo ?? [],
      subject: i.subject ?? '(no subject)',
      date: i.date ?? at,
      receivedAt: at,
      flags: { seen: false, flagged: false, answered: false, draft: false, ...i.flags },
      labels: i.labels ?? [],
      size: i.size ?? (i.text?.length ?? 0) + (i.html?.length ?? 0) + 500,
      preview: null,
      hasAttachments: i.hasAttachments ?? (i.attachments ?? []).some((x) => !x.inline),
      inReplyTo: i.inReplyTo ?? null,
      references: i.references ?? [],
      ...(i.bulk ? { bulk: i.bulk } : {}),
      text: i.text ?? null,
      html: i.html ?? null,
      attachments: i.attachments ?? [],
      ...(i.files ? { files: i.files } : {}),
    };
  }

  private journal(a: Account, mailbox: string, kind: 'added' | 'changed' | 'removed', id: string) {
    a.log.push({ seq: ++a.seq, mailbox, kind, id });
    if (kind !== 'changed') a.sorted.delete(mailbox);
  }

  private sortedOf(a: Account, box: string): FakeMessage[] {
    let list = a.sorted.get(box);
    if (!list) {
      list = [...a.messages.values()].filter((m) => this.isIn(a, m, box)).sort((x, y) => y.receivedAt - x.receivedAt || (x.id < y.id ? 1 : -1));
      a.sorted.set(box, list);
    }
    return list;
  }

  private stateOf(a: Account, mailbox: string): string {
    const key = a.opts.state === 'account' ? '*' : mailbox;
    return `${a.epochs.get(key) ?? 0}.${a.seq}`;
  }

  /** A summary of it, as `box` lists it (one message is listed by several on the web). */
  summary(a: Account, m: FakeMessage, box = m.mailboxId): M.MailSummary {
    const s: M.MailSummary = {
      id: m.id,
      mailboxId: box,
      // Gmail on the web: its Message-ID comes with mail.get alone.
      messageId: a.opts.ids === 'gmail-web' && !a.opts.refs ? null : m.messageId,
      threadId: a.opts.threadIds ? m.threadId ?? m.messageId : null,
      // Gmail's X-GM-MSGID: the same in every mailbox the message is in.
      ...(m.gm ? { emailId: m.gm } : {}),
      from: m.from,
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      date: m.date,
      receivedAt: m.receivedAt,
      flags: { ...m.flags },
      labels: this.labelsOf(a, m),
      size: m.size,
      // Neither extractor gives one: the hub makes previews from bodies.
      preview: null,
      hasAttachments: m.hasAttachments,
    };
    if (a.opts.refs) {
      s.inReplyTo = m.inReplyTo;
      s.references = m.references.length > 20 ? [m.references[0], ...m.references.slice(-19)] : [...m.references];
      if (m.bulk) s.bulk = m.bulk;
    }
    return s;
  }

  /**
   * A summary's labels. Gmail's are the extractor's labelsOf (imap.ts): X-GM-LABELS as Gmail gives them, which never
   * names \Trash, \Spam or All Mail, names \Starred for a flagged message, and leaves out the label of the mailbox the
   * message was listed from.
   */
  private labelsOf(a: Account, m: FakeMessage): string[] {
    if (!m.gm) return [...m.labels];
    // On the web: all of them, the same from every mailbox.
    if (a.opts.ids === 'gmail-web') return [...(a.gm.get(m.gm) ?? [])].sort();
    const own = gmailLabelOf(a.mailboxes.find((b) => b.id === m.mailboxId));
    const out = new Set([...(a.gm.get(m.gm) ?? [])].filter((l) => l !== '\\Trash' && l !== '\\Spam'));
    if (m.flags.flagged) out.add('\\Starred');
    if (own) out.delete(own);
    return [...out].sort();
  }

  // ---------------------------------------------------------- Gmail: one message, a copy in each of its mailboxes

  /** X-GM-MSGID and X-GM-THRID: Gmail's are 64-bit numbers, written in decimal. */
  private gmNext = 1n;
  private gmId = () => String(1_790_000_000_000_000_000n + this.gmNext++);

  private gmCopies(a: Account, gm: string): FakeMessage[] {
    return [...a.messages.values()].filter((m) => m.gm === gm);
  }

  /** A new message with Gmail's labels: its copies made, the one in the mailbox asked for returned. */
  private gmPut(a: Account, input: FakeInput): FakeMessage {
    const box = input.mailboxId ?? GMAIL.inbox;
    const base = this.make(a, { ...input, mailboxId: box, id: '' });
    const gm = this.gmId();
    // Gmail's thread: the one a message it refers to is in, else a new one.
    const refs = new Set([base.inReplyTo, ...base.references].filter(Boolean));
    base.threadId = input.threadId ?? [...a.messages.values()].find((m) => m.messageId && refs.has(m.messageId))?.threadId ?? this.gmId();
    base.labels = [];
    base.gm = gm;
    const labels = new Set(input.labels ?? []);
    const own = gmailLabelOf(a.mailboxes.find((b) => b.id === box));
    if (own === '\\Starred') base.flags.flagged = true;
    else if (own) labels.add(own);
    // A label is a mailbox on Gmail's IMAP: one the account has not got yet is made with it.
    for (const l of labels) if (!l.startsWith('\\') && !a.mailboxes.some((b) => b.path === l)) a.mailboxes.push(gmailBox(l));
    a.gm.set(gm, labels);
    this.gmPlace(a, gm, base);
    const copies = this.gmCopies(a, gm);
    return copies.find((c) => c.mailboxId === box) ?? copies[0];
  }

  /**
   * Its copies made to match its labels: in Trash or Spam it is there alone; otherwise in All Mail, each label's
   * mailbox, and Starred while flagged. Returns the mailboxes that gained or lost a copy.
   */
  private gmPlace(a: Account, gm: string, base?: FakeMessage): Set<string> {
    const labels = a.gm.get(gm)!;
    const copies = this.gmCopies(a, gm);
    const proto = base ?? copies[0];
    const boxOf = (l: string) => a.mailboxes.find((b) => gmailLabelOf(b) === l)?.id;
    const want = new Set<string>();
    if (labels.has('\\Trash')) want.add(GMAIL.trash);
    else if (labels.has('\\Spam')) want.add(GMAIL.spam);
    else {
      want.add(GMAIL.all);
      for (const l of labels) {
        const b = boxOf(l);
        if (b) want.add(b);
      }
      if (proto.flags.flagged) want.add(GMAIL.starred);
    }
    const touched = new Set<string>();
    for (const c of copies) {
      if (want.has(c.mailboxId)) continue;
      a.messages.delete(c.id);
      this.journal(a, c.mailboxId, 'removed', c.id);
      touched.add(c.mailboxId);
    }
    for (const b of want) {
      if (copies.some((c) => c.mailboxId === b)) continue;
      const c: FakeMessage = { ...proto, flags: { ...proto.flags }, id: this.uid(a, b), mailboxId: b, gm };
      a.messages.set(c.id, c);
      this.journal(a, b, 'added', c.id);
      touched.add(b);
    }
    return touched;
  }

  /** Flags on every copy (they are the message's); Starred follows \Flagged. Returns the mailboxes it changed in. */
  private gmFlags(a: Account, gm: string, set: Partial<M.MailFlags>): Set<string> {
    const touched = new Set<string>();
    for (const c of this.gmCopies(a, gm)) {
      c.flags = { ...c.flags, ...set };
      this.journal(a, c.mailboxId, 'changed', c.id);
      touched.add(c.mailboxId);
    }
    for (const b of this.gmPlace(a, gm)) touched.add(b);
    return touched;
  }

  /** Labels added and taken off; every copy that stays sees it (its modseq moved), copies come and go. */
  private gmRelabel(a: Account, gm: string, add: string[], remove: string[]): Set<string> {
    const labels = a.gm.get(gm)!;
    for (const l of remove) labels.delete(l);
    for (const l of add) labels.add(l);
    for (const l of add) if (!l.startsWith('\\') && !a.mailboxes.some((b) => b.path === l)) a.mailboxes.push(gmailBox(l));
    const before = this.gmCopies(a, gm);
    const touched = this.gmPlace(a, gm);
    for (const c of before) {
      if (!a.messages.has(c.id)) continue;
      this.journal(a, c.mailboxId, 'changed', c.id);
      touched.add(c.mailboxId);
    }
    return touched;
  }

  /**
   * Gmail's MOVE: the destination's label on, the source's off. Into All Mail adds nothing (archiving); into Trash or
   * Spam it shows only there; into Starred stars it, out of it unstars it; out of All Mail Gmail takes as a delete,
   * into the Trash (another client's MOVE: the extractor copies instead, gmCopy). Returns its id in the destination
   * (the one it had there, if it was there already).
   */
  private gmMove(a: Account, id: string, to: string): { id: string | null; touched: Set<string> } {
    const m = a.messages.get(id);
    if (!m) return { id: null, touched: new Set() };
    if (m.mailboxId === to) return { id, touched: new Set() };
    const gm = m.gm!;
    const box = (x: string) => a.mailboxes.find((b) => b.id === x);
    const into = gmailLabelOf(box(to));
    const source = box(m.mailboxId);
    const from = gmailLabelOf(source);
    const add: string[] = [];
    const remove: string[] = [];
    const touched = new Set<string>();
    if (into === '\\Starred') for (const b of this.gmFlags(a, gm, { flagged: true })) touched.add(b);
    else if (into) add.push(into);
    if (into === '\\Trash') remove.push('\\Spam');
    if (into === '\\Spam') remove.push('\\Trash');
    if (source?.role === 'all') add.push('\\Trash');
    else if (from === '\\Starred') for (const b of this.gmFlags(a, gm, { flagged: false })) touched.add(b);
    else if (from) remove.push(from);
    for (const b of this.gmRelabel(a, gm, add, remove)) touched.add(b);
    return { id: this.gmCopies(a, gm).find((c) => c.mailboxId === to)?.id ?? null, touched };
  }

  /**
   * Gmail's COPY: the destination's label on, nothing taken off (into Starred stars it). Returns its id in the
   * destination: a new copy's, or the one it had there already.
   */
  private gmCopy(a: Account, id: string, to: string): { id: string | null; touched: Set<string> } {
    const m = a.messages.get(id);
    if (!m) return { id: null, touched: new Set() };
    if (m.mailboxId === to) return { id, touched: new Set() };
    const gm = m.gm!;
    const into = gmailLabelOf(a.mailboxes.find((b) => b.id === to));
    const touched = into === '\\Starred' ? this.gmFlags(a, gm, { flagged: true }) : into ? this.gmRelabel(a, gm, [into], []) : new Set<string>();
    return { id: this.gmCopies(a, gm).find((c) => c.mailboxId === to)?.id ?? null, touched };
  }

  // ---------------------------------------------------------- Gmail on the web: one message, one id, its labels its mailboxes

  /** A new message: its labels are those asked for and the mailbox's it was put in. */
  private webPut(a: Account, input: FakeInput): FakeMessage {
    const box = input.mailboxId ?? GMAIL_WEB.inbox;
    const m = this.make(a, { ...input, mailboxId: box, id: input.id ?? this.uid(a, box) });
    const refs = new Set([m.inReplyTo, ...m.references].filter(Boolean));
    m.threadId = input.threadId ?? [...a.messages.values()].find((x) => x.messageId && refs.has(x.messageId))?.threadId ?? this.gmId();
    m.labels = [];
    m.gm = m.id;
    const labels = new Set(input.labels ?? []);
    const own = webLabelOf(a.mailboxes.find((b) => b.id === box));
    if (own) labels.add(own);
    this.webLabelBoxes(a, labels);
    a.gm.set(m.id, labels);
    a.messages.set(m.id, m);
    for (const b of this.webBoxes(a, m)) this.journal(a, b, 'added', m.id);
    return m;
  }

  /** A mailbox for each user label it has not got yet (Gmail's ids for them: `Label_<n>`); categories are labels only. */
  private webLabelBoxes(a: Account, labels: Iterable<string>) {
    for (const l of labels) {
      if (l.startsWith('\\') || /^Category\//.test(l) || a.mailboxes.some((b) => b.path === l)) continue;
      const n = a.mailboxes.filter((b) => b.id.startsWith('Label_')).length + 1;
      a.mailboxes.push({ ...webBox(`Label_${n}`, l.slice(l.lastIndexOf('/') + 1), null), path: l });
    }
  }

  /** The mailboxes that list it: Trash or Spam alone, else All Mail and each of its labels'. */
  private webBoxes(a: Account, m: FakeMessage): Set<string> {
    const labels = a.gm.get(m.id) ?? new Set<string>();
    const only = labels.has('\\Trash') ? 'trash' : labels.has('\\Spam') ? 'junk' : null;
    const out = new Set<string>();
    for (const b of a.mailboxes) {
      if (only ? b.role === only : b.role === 'all' || (webLabelOf(b) !== null && labels.has(webLabelOf(b)!))) out.add(b.id);
    }
    return out;
  }

  /**
   * A change to it (`fn`): mailboxes it left and came to say so, those it stays in say it changed (its modseq moved).
   * Returns them all.
   */
  private webChange(a: Account, m: FakeMessage, fn: () => void): Set<string> {
    const before = this.webBoxes(a, m);
    fn();
    const after = this.webBoxes(a, m);
    for (const b of before) this.journal(a, b, after.has(b) ? 'changed' : 'removed', m.id);
    for (const b of after) if (!before.has(b)) this.journal(a, b, 'added', m.id);
    return new Set([...before, ...after]);
  }

  /** mail.move on the web: a label change by the destination alone (the header above). */
  private webMove(a: Account, id: string, to: string): Set<string> {
    const m = a.messages.get(id);
    if (!m) return new Set();
    const dest = a.mailboxes.find((b) => b.id === to);
    const labels = a.gm.get(id)!;
    return this.webChange(a, m, () => {
      if (dest?.role === 'trash') {
        labels.delete('\\Spam');
        labels.add('\\Trash');
        return;
      }
      labels.delete('\\Trash');
      labels.delete('\\Spam');
      if (dest?.role !== 'inbox') labels.delete('\\Inbox');
      const into = webLabelOf(dest);
      if (into) labels.add(into);
    });
  }

  private webFlags(a: Account, m: FakeMessage, set: Partial<M.MailFlags>): Set<string> {
    return this.webChange(a, m, () => {
      m.flags = { ...m.flags, ...set };
    });
  }

  private webRelabel(a: Account, m: FakeMessage, add: string[], remove: string[]): Set<string> {
    const labels = a.gm.get(m.id)!;
    this.webLabelBoxes(a, add);
    return this.webChange(a, m, () => {
      for (const l of remove) labels.delete(l);
      for (const l of add) labels.add(l);
    });
  }

  /** mail.changed for this app's own change: the mailboxes the extractor names, and Inbox when IDLE saw it change. */
  private gmEvents(a: Account, own: string[], touched: Set<string>) {
    const evs: MailBackendEvent[] = [];
    for (const b of new Set([...own, ...[...touched].filter((b) => this.watched(a, b))])) evs.push({ t: 'mail.changed', mailboxId: b, state: this.stateOf(a, b) });
    this.emit(a.view.id, evs);
  }

  private answer(a: Account, op: string, input: Record<string, any>): unknown {
    switch (op) {
      case 'mail.mailboxes':
        return {
          mailboxes: a.mailboxes.map((b) => {
            // A \Noselect mailbox has no STATUS: imap.ts gives it no counts.
            if (a.noselect.has(b.id)) return { ...b, total: null, unread: null };
            const ms = this.sortedOf(a, b.id);
            return { ...b, total: ms.length, unread: ms.filter((m) => !m.flags.seen).length };
          }),
        };
      case 'mail.list': {
        const box = String(input.mailboxId);
        // The extractor's SELECT of a \Noselect mailbox fails as NONEXISTENT: 404 (imap.ts callError).
        if (!a.mailboxes.some((b) => b.id === box) || a.noselect.has(box)) throw new MailCallError(`no such mailbox ${box}`, 404);
        const all = this.sortedOf(a, box);
        const from = input.before ? Number(String(input.before).split(':')[0]) : 0;
        const limit = Math.max(1, Math.min(Number(input.limit) || 50, 500));
        const page = all.slice(from, from + limit);
        return { messages: page.map((m) => this.summary(a, m, box)), next: from + limit < all.length ? `${from + limit}:${page[page.length - 1]?.id}` : null };
      }
      case 'mail.get': {
        // As the extractors read it: `id`, or `message` when the manager put its own call id in `id`.
        const m = a.messages.get(String(input.id)) ?? a.messages.get(String(input.message));
        if (!m) throw new MailCallError('no such message', 404);
        const { mailboxId, id, files: _files, gm: _gm, ...rest } = m;
        return { ...this.summary(a, m), ...rest, labels: this.labelsOf(a, m), mailboxId, id, preview: null, text: m.text ?? (m.html ? htmlText(m.html) : null) } satisfies M.MailMessage;
      }
      case 'mail.changes':
        return this.changes(a, String(input.mailboxId), input.state as string | undefined, Number(input.limit) || a.opts.changesPage);
      case 'mail.flag': {
        if (this.writeIds(a, input) && a.view.dryRun) return { dryRun: true };
        this.writable(a, op, input);
        const { go, part } = this.partial(a, this.writeIds(a, input));
        return { ...this.flag(a, { ...input, ids: go }), ...part };
      }
      case 'mail.move': {
        const ids = this.writeIds(a, input);
        if (a.view.dryRun) return { dryRun: true };
        this.writable(a, op, input);
        const { go, part } = this.partial(a, ids);
        const moved = this.moveTo(a, go, String(input.mailboxId)).ids;
        // In the order asked: null where it did not move.
        const to = new Map(go.map((id, i) => [id, moved[i]]));
        return { ids: ids.map((id) => to.get(id) ?? null), ...part };
      }
      case 'mail.trash': {
        const all = this.writeIds(a, input);
        if (a.view.dryRun) return { dryRun: true };
        this.writable(a, op, input);
        const { go: ids, part } = this.partial(a, all);
        const trash = a.mailboxes.find((b) => b.role === 'trash')?.id;
        // Already in the trash, or there is none: deleted outright.
        for (const id of ids) {
          const m = a.messages.get(id);
          if (!m) continue;
          if (!trash || this.isIn(a, m, trash)) this.remove(a.view.id, id);
          else this.moveTo(a, [id], trash);
        }
        return part;
      }
      case 'mail.search':
        if (input.idsOnly && (a.status.details as Record<string, unknown> | undefined)?.searchIds) return this.searchIds(a, String(input.query ?? ''), input.mailboxId as string | undefined, Number(input.limit) || 500, input.cursor as string | undefined);
        return { messages: this.search(a, String(input.query ?? ''), input.mailboxId as string | undefined, Number(input.limit) || 50) };
      case 'mail.send':
        return this.send(a, input as M.OutgoingMail);
      case 'mail.attachment': {
        const m = a.messages.get(String(input.id)) ?? a.messages.get(String(input.message));
        const att = m?.attachments.find((x) => x.id === input.attachmentId);
        if (!m || !att) throw new MailCallError('no such attachment', 404);
        // The bytes a test or the demo gave (slice 3), else made up to its size.
        const given = m.files?.[att.id];
        return { filename: att.filename, mime: att.mime, base64: Buffer.from(given ?? fakeBytes(att)).toString('base64') };
      }
      default:
        throw new MailCallError(`the fake does not do ${op}`, 501, 'unknown-op');
    }
  }

  /** As the manager and an extractor answer mail.send. */
  private send(a: Account, mail: M.OutgoingMail): { messageId: string; sentId: string | null } | { dryRun: true } {
    // The manager: a read grant may not write; a dry run answers without reaching the account.
    if (a.view.level !== 'write') throw new MailCallError('this app may only read this account', 403, 'denied');
    if (a.view.dryRun) return { dryRun: true };
    if (a.opts.send === 501) throw new MailCallError("Proton's send path was not found in the page", 501, 'failed');
    const own = a.self.addresses ?? [{ email: a.self.email, name: a.self.displayName ?? null }];
    const from = mail.from === undefined ? own[0] : own.find((x) => x.email.toLowerCase() === String(mail.from).trim().toLowerCase());
    if (!from) throw new MailCallError("from is not one of this account's addresses (its status's self.addresses)", 422, 'from');
    if (!mail.to?.length && !mail.cc?.length && !mail.bcc?.length) throw new MailCallError('to whom?', 400);
    // Numbered as the extractor numbers them: To, then Cc, then Bcc, an address counted once whatever its case.
    const everyone = new Set([...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])].map((x) => x.email.trim().toLowerCase()));
    const n = a.opts.refuseRecipient;
    if (n > 0 && n <= everyone.size) throw new MailCallError(`Recipient ${n} has a pinned key in your Proton contacts, so send this one from Proton.`, 422, 'recipients');
    const files = (mail.attachments ?? []).map((f) => {
      if (typeof f.path === 'string') {
        if (!this.localFiles) throw new MailCallError('attachments by path only on the same machine', 400);
        return { filename: f.filename, mime: f.mime, bytes: new Uint8Array(readFileSync(f.path)), by: 'path' as const };
      }
      return { filename: f.filename, mime: f.mime, bytes: new Uint8Array(Buffer.from(f.base64 ?? '', 'base64')), by: 'base64' as const };
    });
    const original = mail.replyTo ? a.messages.get(mail.replyTo) : undefined;
    if (mail.replyTo && !original) throw new MailCallError('no such message to reply to', 404);
    const messageId = `<${crypto.randomUUID()}@${from.email.split('@')[1] ?? 'fake.example'}>`;
    const sent = a.mailboxes.find((b) => b.role === 'sent')?.id ?? 'Sent';
    const copy = this.put(a.view.id, {
      mailboxId: sent,
      messageId,
      threadId: original?.threadId ?? (a.opts.threadIds ? original?.messageId ?? null : null),
      from: [{ name: from.name ?? null, email: from.email }],
      to: mail.to,
      cc: mail.cc ?? [],
      bcc: mail.bcc ?? [],
      subject: mail.subject,
      text: mail.text ?? null,
      html: mail.html ?? null,
      inReplyTo: original?.messageId ?? null,
      references: original ? [...original.references, ...(original.messageId ? [original.messageId] : [])] : [],
      flags: { seen: true },
      attachments: files.map((f, i) => ({ id: `out-${i}`, filename: f.filename, mime: f.mime, size: f.bytes.length, inline: false, contentId: null })),
    });
    if (original) this.setFlags(a.view.id, original.id, { answered: true });
    this.sent.push({ account: a.view.id, mail, files, messageId });
    if (a.opts.answer) this.answerLater(a, copy);
    return { messageId, sentId: copy.id };
  }

  /** The first one it went to writes back (opts.answer). */
  private answerLater(a: Account, sent: FakeMessage) {
    const own = new Set((a.self.addresses ?? [{ email: a.self.email }]).map((x) => x.email.toLowerCase()));
    const to = [...sent.to, ...sent.cc].find((x) => x.email && !own.has(x.email.toLowerCase()));
    if (!to) return;
    const t = setTimeout(() => {
      if (this.accs.get(a.view.id) !== a) return;
      const subject = /^re:/i.test(sent.subject) ? sent.subject : `Re: ${sent.subject}`;
      const first = (to.name ?? to.email).split(/\s/)[0];
      this.deliver(a.view.id, {
        from: [to],
        to: sent.from,
        subject,
        threadId: sent.threadId,
        inReplyTo: sent.messageId,
        references: [...sent.references, ...(sent.messageId ? [sent.messageId] : [])],
        text: `Thanks, got it. Talk soon!\n\n${first}`,
      });
    }, a.opts.answer);
    t.unref?.();
  }

  /** A write's ids, as the manager checks them; a read grant may not write. */
  private writeIds(a: Account, input: Record<string, any>): string[] {
    if (a.view.level !== 'write') throw new MailCallError('dither-chat may read this account, not change it', 403, 'denied');
    const ids = input.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some((x) => typeof x !== 'string')) throw new MailCallError('ids: 1 to 1000 strings', 400, 'invalid');
    return ids;
  }

  /** A write of a kind the status's `details.writes` leaves out: 501 before the server hears of it (dither-accounts). */
  private writable(a: Account, op: string, input: Record<string, any>) {
    const writes = (a.opts.details as Record<string, unknown> | null)?.writes;
    if (!Array.isArray(writes)) return;
    const role = op === 'mail.move' ? a.mailboxes.find((b) => b.id === input.mailboxId)?.role : null;
    const kinds = op === 'mail.flag' ? (['seen', 'flagged'] as const).filter((k) => typeof input[k] === 'boolean') : [op === 'mail.trash' || role === 'trash' ? 'trash' : role === 'junk' ? 'junk' : 'move'];
    const no = kinds.find((k) => !writes.includes(k));
    if (no) throw new MailCallError(`this account does not make ${no} writes`, 501, 'unsupported');
  }

  /**
   * A write's ids the server changes (`go`), and the answer's `refused` and `unknown` for the rest (`refuse`). None to
   * change: 422 `refused` when it turned some down, else 404, as the interface's codes say.
   */
  private partial(a: Account, ids: string[]): { go: string[]; part: { refused?: string[]; unknown?: string[] } } {
    const refused = ids.filter((id) => a.refusals.get(id) === 'refused');
    const unknown = ids.filter((id) => a.refusals.get(id) === 'unknown');
    const go = ids.filter((id) => !a.refusals.has(id));
    if (!go.length && refused.length) throw new MailCallError('the server turned every change down', 422, 'refused');
    if (!go.length) throw new MailCallError('none of these is a message the server knows', 404);
    return { go, part: { ...(refused.length ? { refused } : {}), ...(unknown.length ? { unknown } : {}) } };
  }

  private flag(a: Account, input: Record<string, any>): Record<string, never> {
    const ids = this.writeIds(a, input);
    if (a.opts.ids === 'proton' && input.answered !== undefined) throw new MailCallError('Proton marks a message answered itself when you reply to it; mail.flag cannot set or clear that', 501);
    const set: Partial<M.MailFlags> = {};
    for (const k of ['seen', 'flagged', 'answered'] as const) if (typeof input[k] === 'boolean') set[k] = input[k];
    if (a.opts.ids === 'gmail') {
      // Flags are the message's: every copy changes, and Starred gains or loses one. The extractor says mail.changed
      // for the mailbox of each id it stored to (imap.ts flag), and IDLE for Inbox when it changed there.
      const own: string[] = [];
      const touched = new Set<string>();
      for (const id of ids) {
        const m = a.messages.get(id);
        if (!m) continue;
        own.push(m.mailboxId);
        for (const b of this.gmFlags(a, m.gm!, set)) touched.add(b);
      }
      this.gmEvents(a, own, touched);
      return {};
    }
    if (a.opts.ids === 'gmail-web') {
      // The message's flags: every mailbox listing it says it changed.
      const touched = new Set<string>();
      for (const id of ids) {
        const m = a.messages.get(id);
        if (m) for (const b of this.webFlags(a, m, set)) touched.add(b);
      }
      this.changedEvents(a, [...touched], true);
      return {};
    }
    const touched: string[] = [];
    let missing = 0;
    for (const id of ids) {
      const m = a.messages.get(id);
      if (!m) {
        missing++;
        continue;
      }
      m.flags = { ...m.flags, ...set };
      this.journal(a, m.mailboxId, 'changed', id);
      touched.push(m.mailboxId);
    }
    this.changedEvents(a, touched, true);
    // IMAP lets a STORE on a UID that is gone pass; Proton refuses those ids (404 when it found none of them).
    if (missing && a.opts.ids === 'proton') throw new MailCallError(`Proton would not change ${missing} of them (code 2501)`, 404);
    return {};
  }

  private moveTo(a: Account, ids: string[], to: string): { ids: (string | null)[] } {
    if (!a.mailboxes.some((b) => b.id === to) || a.noselect.has(to)) throw new MailCallError(`no mailbox ${to}`, 404);
    if (a.opts.ids === 'gmail') {
      // The extractor says mail.changed for the source and the destination (imap.ts move), IDLE for Inbox. Out of All
      // Mail into anything but Trash or Spam it COPYs (imap.ts copiesInstead): a MOVE there would delete it.
      const own = [to];
      const touched = new Set<string>();
      const dest = a.mailboxes.find((b) => b.id === to)!;
      const out = ids.map((id) => {
        const m = a.messages.get(id);
        if (!m) return null;
        own.push(m.mailboxId);
        const fromAll = a.mailboxes.find((b) => b.id === m.mailboxId)?.role === 'all';
        const r = fromAll && dest.role !== 'trash' && dest.role !== 'junk' ? this.gmCopy(a, id, to) : this.gmMove(a, id, to);
        for (const b of r.touched) touched.add(b);
        return a.opts.moveIds === 'null' ? null : r.id;
      });
      this.gmEvents(a, own, touched);
      return { ids: out };
    }
    if (a.opts.ids === 'gmail-web') {
      // A label change; the id stays the message's.
      const touched = new Set<string>([to]);
      const out = ids.map((id) => {
        if (!a.messages.has(id)) return null;
        for (const b of this.webMove(a, id, to)) touched.add(b);
        return a.opts.moveIds === 'null' ? null : id;
      });
      this.changedEvents(a, [...touched], true);
      return { ids: out };
    }
    const touched: string[] = [to];
    const out = ids.map((id) => {
      const m = a.messages.get(id);
      if (!m) return null;
      if (m.mailboxId === to) return id;
      touched.push(m.mailboxId);
      a.messages.delete(id);
      this.journal(a, m.mailboxId, 'removed', id);
      const moved = { ...m, mailboxId: to, id: a.opts.ids === 'imap' ? this.uid(a, to) : id };
      a.messages.set(moved.id, moved);
      this.journal(a, to, 'added', moved.id);
      return a.opts.moveIds === 'null' ? null : moved.id;
    });
    this.changedEvents(a, touched, true);
    return { ids: out };
  }

  /** The ids-only search: every match's id in the mailbox searched, newest first, a page at a time; Gmail's estimate is the count. */
  private searchIds(a: Account, query: string, mailbox: string | undefined, limit: number, cursor: string | undefined): { ids: string[]; next: string | null; estimate: number | null } {
    const all = this.search(a, query, mailbox, Infinity);
    const from = Number(cursor ?? 0) || 0;
    const page = all.slice(from, from + Math.max(1, Math.min(limit, 500)));
    return { ids: page.map((m) => m.id), next: from + page.length < all.length ? String(from + page.length) : null, estimate: all.length };
  }

  private search(a: Account, query: string, mailbox: string | undefined, limit: number): M.MailSummary[] {
    if (!query.trim()) throw new MailCallError('search for what?', 400);
    if (mailbox && a.noselect.has(mailbox)) throw new MailCallError(`no such mailbox ${mailbox}`, 404);
    const people = (m: FakeMessage) => [...m.from, ...m.to, ...m.cc].map((x) => `${x.name ?? ''} ${x.email}`).join(' ');
    const text = (m: FakeMessage) => (a.opts.search === 'proton' ? `${m.subject} ${people(m)}` : `${m.subject} ${people(m)} ${m.text ?? (m.html ? htmlText(m.html) : '')}`).toLowerCase();
    let match: (m: FakeMessage) => boolean;
    if (a.opts.search === 'gmail') match = gmailQuery(query, (m) => ({ text: text(m), labels: [...(m.gm ? (a.gm.get(m.gm) ?? []) : m.labels)] }));
    else {
      const words = query.split(/\s+/).filter(Boolean).map((w) => w.replace(/"/g, '').toLowerCase());
      match = (m) => words.every((w) => text(m).includes(w));
    }
    // Without a mailbox: All Mail where there is one (Gmail), else every mailbox but Trash and Junk (imap.ts search).
    const all = a.mailboxes.find((b) => b.role === 'all')?.id;
    const inAll = !!all && (a.opts.ids === 'gmail' || a.opts.ids === 'gmail-web');
    const skip = new Set(a.mailboxes.filter((b) => b.role === 'junk' || b.role === 'trash').map((b) => b.id));
    const within = (m: FakeMessage) => (mailbox ? this.isIn(a, m, mailbox) : inAll ? this.isIn(a, m, all!) : !skip.has(m.mailboxId));
    return [...a.messages.values()]
      .filter((m) => within(m) && match(m))
      .sort((x, y) => y.receivedAt - x.receivedAt)
      .slice(0, limit === Infinity ? undefined : Math.max(1, Math.min(limit, 200)))
      .map((m) => this.summary(a, m, mailbox ?? (inAll ? all : m.mailboxId)));
  }

  private changes(a: Account, box: string, state: string | undefined, limit: number): M.MailChanges {
    if (!a.mailboxes.some((b) => b.id === box) || a.noselect.has(box)) throw new MailCallError(`no such mailbox ${box}`, 404);
    const key = a.opts.state === 'account' ? '*' : box;
    const epoch = a.epochs.get(key) ?? 0;
    if (!state) return { state: this.stateOf(a, box), added: [], changed: [], removed: [], more: false };
    const [e, s] = state.split('.').map(Number);
    if (e !== epoch || !Number.isFinite(s)) throw new MailCallError('the state is too old: list again', 410);
    const entries = a.log.filter((x) => x.seq > s && x.mailbox === box);
    const take = entries.slice(0, limit);
    const more = entries.length > take.length;
    const upTo = more ? take[take.length - 1].seq : a.seq;
    const added = new Set<string>();
    const changed = new Set<string>();
    const removed = new Set<string>();
    for (const x of take) {
      if (x.kind === 'removed') {
        removed.add(x.id);
        added.delete(x.id);
        changed.delete(x.id);
      } else if (x.kind === 'added') {
        added.add(x.id);
        removed.delete(x.id);
      } else if (!added.has(x.id)) changed.add(x.id);
    }
    const here = (id: string) => this.isIn(a, a.messages.get(id), box);
    return {
      state: `${epoch}.${upTo}`,
      added: [...added].filter(here).map((id) => this.summary(a, a.messages.get(id)!, box)),
      changed: [...changed].filter(here).map((id) => ({ id, flags: { ...a.messages.get(id)!.flags }, labels: this.labelsOf(a, a.messages.get(id)!) })),
      removed: [...removed],
      more,
    };
  }
}

/**
 * Gmail's search (X-GM-RAW), as much of it as the hub sends (search.ts serverQuery): words and "phrases" anywhere in
 * the sender, recipients, subject or text, `-` before one, `{a b}` for any of them, and from:, to:, cc:, subject:,
 * label:, in:, is:, has:attachment, filename:, after: and before: (YYYY/MM/DD, or seconds since the epoch, as Gmail takes
 * them too: after: from then on, before: up to it). category: matches nothing: the fake has no Gmail categories. Other
 * operators are left to Gmail, so they match everything here.
 */
export function gmailQuery(query: string, extra: (m: FakeMessage) => { text: string; labels: string[] }): (m: FakeMessage) => boolean {
  const tokens = query.match(/-?\{[^}]*\}|-?[\w.-]+:"[^"]*"|-?"[^"]*"|\S+/g) ?? [];
  const norm = (s: string) => s.toLowerCase().replace(/[\s/]+/g, '-');
  const day = (v: string) => {
    if (/^\d{9,}$/.test(v)) return Number(v) * 1000;
    const [y, mo, d] = v.split('/').map(Number);
    return new Date(y, (mo || 1) - 1, d || 1).getTime();
  };
  const term = (t: string): ((m: FakeMessage) => boolean) => {
    if (t.startsWith('-')) {
      const inner = term(t.slice(1));
      return (m) => !inner(m);
    }
    if (t.startsWith('{')) {
      const any = (t.slice(1, -1).match(/[\w.-]+:"[^"]*"|"[^"]*"|\S+/g) ?? []).map(term);
      return (m) => any.some((f) => f(m));
    }
    const op = t.match(/^([a-z]+):(.*)$/i);
    const raw = (op ? op[2] : t).replace(/^"|"$/g, '');
    const v = raw.toLowerCase();
    const who = (l: M.MailAddress[]) => l.some((x) => `${x.name ?? ''} ${x.email}`.toLowerCase().includes(v));
    const has = (m: FakeMessage, l: string) => extra(m).labels.some((x) => norm(x) === norm(l));
    if (!op) return (m) => extra(m).text.includes(v);
    switch (op[1].toLowerCase()) {
      case 'from':
        return (m) => who(m.from);
      case 'to':
        return (m) => who(m.to);
      case 'cc':
        return (m) => who(m.cc);
      case 'subject':
        return (m) => m.subject.toLowerCase().includes(v);
      case 'label':
        return (m) => has(m, raw);
      case 'in': {
        const sys: Record<string, string> = { inbox: '\\Inbox', sent: '\\Sent', spam: '\\Spam', trash: '\\Trash', drafts: '\\Draft', important: '\\Important' };
        if (v === 'anywhere') return () => true;
        if (v === 'starred') return (m) => m.flags.flagged;
        return (m) => has(m, sys[v] ?? raw);
      }
      case 'is':
        if (v === 'unread') return (m) => !m.flags.seen;
        if (v === 'read') return (m) => m.flags.seen;
        if (v === 'starred') return (m) => m.flags.flagged;
        if (v === 'important') return (m) => has(m, '\\Important');
        return () => true;
      case 'has':
        return v === 'attachment' ? (m) => m.hasAttachments : () => true;
      case 'filename':
        return (m) => m.attachments.some((x) => (x.filename ?? '').toLowerCase().includes(v));
      case 'after':
        return (m) => m.receivedAt >= day(v);
      case 'before':
        return (m) => m.receivedAt < day(v);
      case 'category':
        return () => false;
      default:
        return () => true;
    }
  };
  const all = tokens.map(term);
  return (m) => all.every((f) => f(m));
}

/** An attachment's bytes on the fake server: its id over and over, as long as it says it is. */
export function fakeBytes(att: { id: string; size: number }): Uint8Array {
  const unit = new TextEncoder().encode(`${att.id};`);
  const out = new Uint8Array(Math.max(0, att.size));
  for (let i = 0; i < out.length; i++) out[i] = unit[i % unit.length];
  return out;
}

/**
 * A big mailbox, for the load tests and a big demo world (DITHER_DEMO_MAIL_BIG): `n` plain messages in `mailbox`,
 * spread evenly from `newest` back to `oldest`, newest first, in threads of three from 300 people; a tenth unread.
 * In Sent, you wrote them.
 */
export function fillMailbox(fake: FakeMailBackend, account: string, mailbox: string, n: number, o: { newest: number; oldest: number; self: string; tag?: string; text?: (i: number) => string }) {
  const tag = o.tag ?? mailbox.toLowerCase();
  const span = o.newest - o.oldest;
  for (let i = 0; i < n; i++) {
    const t = Math.floor(i / 3);
    const who = { name: `Person ${t % 300}`, email: `person${t % 300}@big.example` };
    const mine = mailbox === 'Sent';
    fake.put(account, {
      mailboxId: mailbox,
      messageId: `<${tag}${i}@big.example>`,
      inReplyTo: i % 3 ? `<${tag}${i - 1}@big.example>` : null,
      references: i % 3 ? [`<${tag}${t * 3}@big.example>`] : [],
      from: [mine ? { name: null, email: o.self } : who],
      to: [mine ? who : { name: null, email: o.self }],
      subject: `${mailbox} topic ${t}`,
      receivedAt: o.newest - Math.floor((i * span) / n),
      flags: { seen: i % 10 !== 0 },
      ...(o.text ? { text: o.text(i) } : {}),
    });
  }
}
