/**
 * An in-memory mail server behind the MailBackend interface (docs/mail-design.md §12.2): the hub's mail tests run on
 * it, and a demo world (--demo) seeds one account with it. It behaves like either extractor, as asked:
 *
 *   ids        'imap': a message gets a new id when it moves (a new UID); 'proton': ids survive moves
 *   threadIds  the server's thread on summaries (Gmail, Proton), or none (plain IMAP)
 *   refs       In-Reply-To and References on summaries (dither-accounts' §13 fields), or only from mail.get
 *   state      one per mailbox (IMAP), or one for the whole account (Proton's event loop)
 *   events     mail.changed for the inbox only (IMAP IDLE), or for every mailbox (Proton's event loop)
 *   search     mail.search: each word in the sender, recipients, subject or text (IMAP; Gmail takes its own syntax,
 *              and here only its plain words count), or in the subject and addresses only (Proton)
 *
 * Changes made "on the server" (deliver, move, setFlags, remove, rebuild) are what another mail client would do; they
 * reach the hub as events and through mail.changes. Calls can be made to fail (410, 503, 404, limited) or slow.
 *
 * mail.send (slice 5) checks From against the account's addresses (422), answers a dry run as the manager does, keeps
 * what it got in `sent` (with the files' bytes, read from a path or base64), and puts a copy in Sent that threads to
 * the original by In-Reply-To and References, which it marks answered.
 *
 * The hub's own writes (mail.flag, mail.move, mail.trash) change it as the extractors do: at most 1000 ids a call, 403
 * on a read grant, `{ dryRun: true }` and no change on a dry run (as the manager answers), mail.changed for every
 * mailbox they touched (an extractor reports this app's own changes), Proton's 501 for `answered`, and a move answering
 * the new ids (or nulls, as an IMAP server without UIDPLUS may).
 */
import { readFileSync } from 'node:fs';
import type * as P from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { MailCallError, type MailBackend, type MailBackendAccount, type MailBackendEvent } from './backend.ts';
import { htmlText } from './store.ts';

export interface FakeOpts {
  ids?: 'imap' | 'proton';
  threadIds?: boolean;
  refs?: boolean;
  state?: 'mailbox' | 'account';
  events?: 'inbox' | 'all';
  /** What mail.send would answer (slice 5). */
  send?: 'ok' | 501;
  latencyMs?: number;
  /** How many changes one mail.changes answers before saying `more`. */
  changesPage?: number;
  /** What mail.move answers for the moved messages: their new ids, or null (the server would not say). */
  moveIds?: 'new' | 'null';
  /** What mail.search looks in (slice 7); by default as `ids`. */
  search?: 'imap' | 'gmail' | 'proton';
}

/** A message as the fake server keeps it. */
export interface FakeMessage extends Omit<M.MailMessage, 'mailboxId' | 'id'> {
  id: string;
  mailboxId: string;
  /** Attachments' bytes by attachment id, for mail.attachment (slice 3); one not here gets bytes made up to its size. */
  files?: Record<string, Uint8Array | string>;
}

/** A message the fake sent (slice 5): what it was given, and its files' bytes. */
export interface FakeSent {
  account: string;
  mail: M.OutgoingMail;
  files: { filename: string; mime: string; bytes: Uint8Array; by: 'path' | 'base64' }[];
  messageId: string;
}

/** What a test or seed gives: anything left out gets a plain default. */
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
    this.calls.push({ account, op, input, at: Date.now() });
    const a = this.accs.get(account);
    const latency = a?.opts.latencyMs ?? this.defaults.latencyMs ?? 0;
    // An answer comes back later, as over a socket: never in the same turn.
    if (latency) await Bun.sleep(latency);
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
    const opts: Required<FakeOpts> = { ids: 'imap', threadIds: false, refs: true, state: 'mailbox', events: 'inbox', send: 'ok', latencyMs: 0, changesPage: 200, moveIds: 'new', search: (o.opts?.ids ?? this.defaults.ids) === 'proton' ? 'proton' : 'imap', ...this.defaults, ...o.opts };
    const online = o.online ?? true;
    const a: Account = {
      view: { id, kind: o.kind ?? (opts.ids === 'proton' ? 'proton' : 'imap'), label: o.label ?? o.email, level: o.level ?? 'write', dryRun: !!o.dryRun, online },
      opts,
      self: { email: o.email, ...(o.name ? { displayName: o.name } : {}), ...(o.addresses ? { addresses: o.addresses } : {}) },
      mailboxes: (o.mailboxes ?? DEFAULT_MAILBOXES).map((b) => ({ ...b })),
      messages: new Map(),
      log: [],
      seq: 1,
      epochs: new Map(),
      nextUid: 1,
      status: {},
      sorted: new Map(),
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

  /** `op` fails once with this error (or each time `when` says so, once per call it matches). */
  fail(op: string, e: MailCallError, when: Failure = () => e) {
    const list = this.failures.get(op) ?? [];
    list.push((input) => (when(input) ? e : null));
    this.failures.set(op, list);
  }

  /** Put a message on the server without telling anyone (a seed: listed by the first sync). */
  put(account: string, input: FakeInput): FakeMessage {
    const a = this.accs.get(account)!;
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
    if (this.watched(a, m.mailboxId)) evs.push({ t: 'mail.arrived', message: this.summary(a, m) }, { t: 'mail.changed', mailboxId: m.mailboxId, state: this.stateOf(a, m.mailboxId) });
    this.emit(account, evs);
    return m;
  }

  /** Another client moved it: under IMAP it gets a new id there. Returns the new id. */
  move(account: string, id: string, to: string): string {
    const a = this.accs.get(account)!;
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
    // Proton's refresh keeps its ids; an IMAP server's new UIDVALIDITY gives each message a new one.
    for (const m of a.opts.ids === 'imap' ? [...a.messages.values()] : []) {
      if (m.mailboxId !== mailbox) continue;
      a.messages.delete(m.id);
      const fresh = { ...m, id: this.uid(a, mailbox) };
      a.messages.set(fresh.id, fresh);
    }
    this.changedEvents(a, [mailbox]);
  }

  messages(account: string, mailbox?: string): FakeMessage[] {
    return [...this.accs.get(account)!.messages.values()].filter((m) => !mailbox || m.mailboxId === mailbox);
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
    return {
      t: 'status',
      status: online ? 'online' : 'offline',
      attention: null,
      self: a.self,
      details: { sync: a.opts.state === 'account' ? 'events' : 'QRESYNC', canSend: sendOk, sendNote: sendOk ? null : "Sending is not supported here (the extractor answered 501)." },
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
    // IMAP's shape: <mailbox>.<UIDVALIDITY>.<UID>
    return a.opts.ids === 'imap' ? `${mailbox}.${100 + (a.epochs.get(mailbox) ?? 0)}.${a.nextUid++}` : `p${a.nextUid++}`;
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
      list = [...a.messages.values()].filter((m) => m.mailboxId === box).sort((x, y) => y.receivedAt - x.receivedAt || (x.id < y.id ? 1 : -1));
      a.sorted.set(box, list);
    }
    return list;
  }

  private stateOf(a: Account, mailbox: string): string {
    const key = a.opts.state === 'account' ? '*' : mailbox;
    return `${a.epochs.get(key) ?? 0}.${a.seq}`;
  }

  summary(a: Account, m: FakeMessage): M.MailSummary {
    const s: M.MailSummary = {
      id: m.id,
      mailboxId: m.mailboxId,
      messageId: m.messageId,
      threadId: a.opts.threadIds ? m.threadId ?? m.messageId : null,
      from: m.from,
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      date: m.date,
      receivedAt: m.receivedAt,
      flags: { ...m.flags },
      labels: [...m.labels],
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

  private answer(a: Account, op: string, input: Record<string, any>): unknown {
    switch (op) {
      case 'mail.mailboxes':
        return {
          mailboxes: a.mailboxes.map((b) => {
            const ms = this.sortedOf(a, b.id);
            return { ...b, total: ms.length, unread: ms.filter((m) => !m.flags.seen).length };
          }),
        };
      case 'mail.list': {
        const box = String(input.mailboxId);
        if (!a.mailboxes.some((b) => b.id === box)) throw new MailCallError(`no mailbox ${box}`, 404);
        const all = this.sortedOf(a, box);
        const from = input.before ? Number(String(input.before).split(':')[0]) : 0;
        const limit = Math.max(1, Math.min(Number(input.limit) || 50, 500));
        const page = all.slice(from, from + limit);
        return { messages: page.map((m) => this.summary(a, m)), next: from + limit < all.length ? `${from + limit}:${page[page.length - 1]?.id}` : null };
      }
      case 'mail.get': {
        // As the extractors read it: `id`, or `message` when the manager put its own call id in `id`.
        const m = a.messages.get(String(input.id)) ?? a.messages.get(String(input.message));
        if (!m) throw new MailCallError('no such message', 404);
        const { mailboxId, id, files: _files, ...rest } = m;
        return { ...this.summary(a, m), ...rest, mailboxId, id, preview: null, text: m.text ?? (m.html ? htmlText(m.html) : null) } satisfies M.MailMessage;
      }
      case 'mail.changes':
        return this.changes(a, String(input.mailboxId), input.state as string | undefined, Number(input.limit) || a.opts.changesPage);
      case 'mail.flag':
        if (this.writeIds(a, input) && a.view.dryRun) return { dryRun: true };
        return this.flag(a, input);
      case 'mail.move':
        if (this.writeIds(a, input) && a.view.dryRun) return { dryRun: true };
        return this.moveTo(a, this.writeIds(a, input), String(input.mailboxId));
      case 'mail.trash': {
        const ids = this.writeIds(a, input);
        if (a.view.dryRun) return { dryRun: true };
        const trash = a.mailboxes.find((b) => b.role === 'trash')?.id;
        // Already in the trash, or there is none: deleted outright.
        for (const id of ids) {
          const m = a.messages.get(id);
          if (!m) continue;
          if (!trash || m.mailboxId === trash) this.remove(a.view.id, id);
          else this.moveTo(a, [id], trash);
        }
        return {};
      }
      case 'mail.search':
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
    if (!from) throw new MailCallError("from is not one of this account's addresses (its status's self.addresses)", 422);
    if (!mail.to?.length && !mail.cc?.length && !mail.bcc?.length) throw new MailCallError('to whom?', 400);
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
    return { messageId, sentId: copy.id };
  }

  /** A write's ids, as the manager checks them; a read grant may not write. */
  private writeIds(a: Account, input: Record<string, any>): string[] {
    if (a.view.level !== 'write') throw new MailCallError('dither-chat may read this account, not change it', 403, 'denied');
    const ids = input.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some((x) => typeof x !== 'string')) throw new MailCallError('ids: 1 to 1000 strings', 400, 'invalid');
    return ids;
  }

  private flag(a: Account, input: Record<string, any>): Record<string, never> {
    const ids = this.writeIds(a, input);
    if (a.opts.ids === 'proton' && input.answered !== undefined) throw new MailCallError('Proton marks a message answered itself when you reply to it; mail.flag cannot set or clear that', 501);
    const set: Partial<M.MailFlags> = {};
    for (const k of ['seen', 'flagged', 'answered'] as const) if (typeof input[k] === 'boolean') set[k] = input[k];
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
    if (!a.mailboxes.some((b) => b.id === to)) throw new MailCallError(`no mailbox ${to}`, 404);
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

  private search(a: Account, query: string, mailbox: string | undefined, limit: number): M.MailSummary[] {
    // Gmail's operators are its own business: here only its plain words count.
    const words = query.split(/\s+/).filter((w) => w && (a.opts.search !== 'gmail' || !/^-|:|^\{/.test(w))).map((w) => w.replace(/"/g, '').toLowerCase());
    if (!words.length) throw new MailCallError('search for what?', 400);
    const skip = new Set(a.mailboxes.filter((b) => b.role === 'junk' || b.role === 'trash').map((b) => b.id));
    const people = (m: FakeMessage) => [...m.from, ...m.to, ...m.cc].map((x) => `${x.name ?? ''} ${x.email}`).join(' ');
    const text = (m: FakeMessage) => (a.opts.search === 'proton' ? `${m.subject} ${people(m)}` : `${m.subject} ${people(m)} ${m.text ?? (m.html ? htmlText(m.html) : '')}`).toLowerCase();
    return [...a.messages.values()]
      .filter((m) => (mailbox ? m.mailboxId === mailbox : !skip.has(m.mailboxId)) && words.every((w) => text(m).includes(w)))
      .sort((x, y) => y.receivedAt - x.receivedAt)
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((m) => this.summary(a, m));
  }

  private changes(a: Account, box: string, state: string | undefined, limit: number): M.MailChanges {
    if (!a.mailboxes.some((b) => b.id === box)) throw new MailCallError(`no mailbox ${box}`, 404);
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
    const here = (id: string) => a.messages.get(id)?.mailboxId === box;
    return {
      state: `${epoch}.${upTo}`,
      added: [...added].filter(here).map((id) => this.summary(a, a.messages.get(id)!)),
      changed: [...changed].filter(here).map((id) => ({ id, flags: { ...a.messages.get(id)!.flags }, labels: [...a.messages.get(id)!.labels] })),
      removed: [...removed],
      more,
    };
  }
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
