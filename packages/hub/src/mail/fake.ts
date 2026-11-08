/**
 * An in-memory mail server behind the MailBackend interface (docs/mail-design.md §12.2): the hub's mail tests run on
 * it, and a demo world (--demo) seeds one account with it. It behaves like either extractor, as asked:
 *
 *   ids        'imap': a message gets a new id when it moves (a new UID); 'proton': ids survive moves
 *   threadIds  the server's thread on summaries (Gmail, Proton), or none (plain IMAP)
 *   refs       In-Reply-To and References on summaries (dither-accounts' §13 fields), or only from mail.get
 *   state      one per mailbox (IMAP), or one for the whole account (Proton's event loop)
 *   events     mail.changed for the inbox only (IMAP IDLE), or for every mailbox (Proton's event loop)
 *
 * Changes made "on the server" (deliver, move, setFlags, remove, rebuild) are what another mail client would do; they
 * reach the hub as events and through mail.changes. Calls can be made to fail (410, 503, 404, limited) or slow.
 */
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
}

/** A message as the fake server keeps it. */
export interface FakeMessage extends Omit<M.MailMessage, 'mailboxId' | 'id'> {
  id: string;
  mailboxId: string;
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
  /** Every call made, for tests to count. */
  readonly calls: { account: string; op: string; input: Record<string, any> }[] = [];

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
    this.calls.push({ account, op, input });
    const a = this.accs.get(account);
    const latency = a?.opts.latencyMs ?? this.defaults.latencyMs ?? 0;
    if (latency) await Bun.sleep(latency);
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

  addAccount(id: string, o: { kind?: string; label?: string; email: string; name?: string; addresses?: M.MailAccountAddress[]; level?: 'read' | 'write'; mailboxes?: M.Mailbox[]; opts?: FakeOpts; online?: boolean }) {
    const opts: Required<FakeOpts> = { ids: 'imap', threadIds: false, refs: true, state: 'mailbox', events: 'inbox', send: 'ok', latencyMs: 0, changesPage: 200, ...this.defaults, ...o.opts };
    const online = o.online ?? true;
    const a: Account = {
      view: { id, kind: o.kind ?? (opts.ids === 'proton' ? 'proton' : 'imap'), label: o.label ?? o.email, level: o.level ?? 'write', dryRun: false, online },
      opts,
      self: { email: o.email, ...(o.name ? { displayName: o.name } : {}), ...(o.addresses ? { addresses: o.addresses } : {}) },
      mailboxes: (o.mailboxes ?? DEFAULT_MAILBOXES).map((b) => ({ ...b })),
      messages: new Map(),
      log: [],
      seq: 1,
      epochs: new Map(),
      nextUid: 1,
      status: {},
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

  private changedEvents(a: Account, mailboxes: string[]) {
    const evs: MailBackendEvent[] = [];
    for (const b of new Set(mailboxes)) if (this.watched(a, b)) evs.push({ t: 'mail.changed', mailboxId: b, state: this.stateOf(a, b) });
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
    };
  }

  private journal(a: Account, mailbox: string, kind: 'added' | 'changed' | 'removed', id: string) {
    a.log.push({ seq: ++a.seq, mailbox, kind, id });
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
            const ms = [...a.messages.values()].filter((m) => m.mailboxId === b.id);
            return { ...b, total: ms.length, unread: ms.filter((m) => !m.flags.seen).length };
          }),
        };
      case 'mail.list': {
        const box = String(input.mailboxId);
        if (!a.mailboxes.some((b) => b.id === box)) throw new MailCallError(`no mailbox ${box}`, 404);
        const all = [...a.messages.values()].filter((m) => m.mailboxId === box).sort((x, y) => y.receivedAt - x.receivedAt || (x.id < y.id ? 1 : -1));
        const from = input.before ? Number(String(input.before).split(':')[0]) : 0;
        const limit = Math.max(1, Math.min(Number(input.limit) || 50, 500));
        const page = all.slice(from, from + limit);
        return { messages: page.map((m) => this.summary(a, m)), next: from + limit < all.length ? `${from + limit}:${page[page.length - 1]?.id}` : null };
      }
      case 'mail.get': {
        // As the extractors read it: `id`, or `message` when the manager put its own call id in `id`.
        const m = a.messages.get(String(input.id)) ?? a.messages.get(String(input.message));
        if (!m) throw new MailCallError('no such message', 404);
        const { mailboxId, id, ...rest } = m;
        return { ...this.summary(a, m), ...rest, mailboxId, id, preview: null, text: m.text ?? (m.html ? htmlText(m.html) : null) } satisfies M.MailMessage;
      }
      case 'mail.changes':
        return this.changes(a, String(input.mailboxId), input.state as string | undefined, Number(input.limit) || a.opts.changesPage);
      case 'mail.send':
        if (a.opts.send === 501) throw new MailCallError("sending is not supported here", 501, 'failed');
        throw new MailCallError('the fake does not send yet (slice 5)', 501, 'failed');
      default:
        throw new MailCallError(`the fake does not do ${op}`, 501, 'unknown-op');
    }
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
