/**
 * Mail's tables (schema.sql) in the hub's database: accounts, mailboxes, messages and where they are, threads, bodies.
 * Ingest, the views the page gets, and dirty sets the server flushes with the chat store's (server.ts flush).
 *
 * A message is keyed by (account, Message-ID), or without one by the server's emailId (`identify`), so the extractor's
 * ids, which change when IMAP moves a message, are only its locations: a move keeps the hub message, its thread and its
 * cached body, and Gmail's copies in Inbox, All Mail and a label are one message. A message with no location left is
 * deleted by whoever removed the last one (sync.ts, once a move had its chance to show up elsewhere).
 */
import type { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import type * as P from '@dither-chat/protocol';
import { mailPreview, parseMailList, parseWithList, quoteStart } from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import type * as M from '@dither-chat/protocol/mail-iface';
import { ACCOUNT_COLORS } from '../store.ts';
import { MAIL_LIMITS } from './limits.ts';
import { normalizeSubject, placeMessage, type ThreadInfo, type ThreadLookup } from './thread.ts';

type Row = Record<string, any>;

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * A location (`l`) its message (`m`) is being moved out of here, before the server confirms it: ops.ts's
 * `pending.move` = { to, hide }, where `hide` lists the mailboxes it leaves (null: every one). Lists and threads show
 * the message in `to` instead.
 */
const MOVED_OUT = `(json_type(m.pending, '$.move') IS 'object' AND (json_type(m.pending, '$.move.hide') IS NOT 'array' OR l.mailbox_id IN (SELECT value FROM json_each(m.pending, '$.move.hide'))))`;

/** Inbox, Sent, and All mail where there is one, else Archive: kept up by the hub on its own (§3.3). */
export function followedRoles(mailboxes: { role: string | null }[]): Set<string> {
  const roles = new Set(['inbox', 'sent']);
  roles.add(mailboxes.some((b) => b.role === 'all') ? 'all' : 'archive');
  return roles;
}

/**
 * Labels for the views: Gmail's own (`\Inbox`, `\Important`, `\Starred`, `\Sent`) say where a message is, its importance
 * and its star, which the views show otherwise. Those a person gave stay.
 */
export const shownLabels = (labels: string[]) => labels.filter((l) => !l.startsWith('\\'));

/** Text from HTML when a message has no text part (the extractors make it themselves; this is for when one did not). */
export function htmlText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article|header|footer|ul|ol|pre)\s*>/gi, '\n')
    .replace(/<(p|div|tr|h[1-6]|table|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, a, b, c, inner) => {
      const href = (a ?? b ?? c ?? '').trim();
      const text = inner.replace(/<[^>]*>/g, '').trim();
      return /^https?:/i.test(href) && text && !href.includes(text) ? `${text} [${href}]` : text || href;
    })
    .replace(/<[^>]*>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16) || 32))
    .replace(/&amp;/gi, '&');
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface MailDirty {
  access: boolean;
  accounts: Set<string>;
  /** Accounts whose mailboxes changed. */
  mailboxes: Set<string>;
  threads: Set<string>;
  threadsRemoved: Set<string>;
  /** Accounts whose sync progress moved (slice 2): `mail.progress`, not journaled. */
  progress: Set<string>;
}

export interface MailAccountInput {
  id: string;
  kind: string;
  label: string;
  level: 'read' | 'write';
  dryRun: boolean;
  online?: boolean;
}

/** What an ingest did: messages new to the hub, and threads it touched. */
export interface Ingested {
  added: string[];
  threads: Set<string>;
  /** Messages that lost a location to this ingest (a server that reused an id) and may have none left. */
  orphans: string[];
}

export class MailStore {
  readonly dirty: MailDirty = { access: false, accounts: new Set(), mailboxes: new Set(), threads: new Set(), threadsRemoved: new Set(), progress: new Set() };
  /** The account on the manager's page: set by MailHub. */
  managedUrl: (accountId: string) => string | null = () => null;
  /** Where an account's sync is (sync.ts): set by MailHub. */
  syncOf: (accountId: string) => P.MailAccountView['sync']['phase'] = () => 'idle';
  /** After a thread is worked out from its messages (none: it went). mail/people.ts keeps who is on it. */
  readonly recomputed: ((threadId: string, messages: Row[]) => void)[] = [];
  /** The identity and person behind each address, for the views: set by mail/people.ts. */
  whoIs: (addresses: string[]) => Map<string, { identityId: string; personId: string | null }> = () => new Map();
  /** The addresses a `w:` list is with (a person's, an identity's): set by mail/people.ts; else the address itself. */
  addressesOf: (who: string) => string[] = (who) => (who.includes('@') ? [lc(who)] : []);
  /** An account's writes waiting for the server (ops.ts sets it). */
  opsOf: (accountId: string) => P.MailAccountView['ops'] = () => undefined;
  /** What later slices add to a body's view (slice 3: the HTML, files, warnings), from the mail_body row. */
  readonly bodyExtras: ((messageId: string, body: Row) => Partial<P.MailBodyView>)[] = [];
  /** Of the threads that changed, those held back from `mail.threads` and the lists that makes stale (slice 2's live window). */
  window: ((ids: string[]) => { held: Set<string>; stale: string[] }) | null = null;
  /** What later slices add to a thread's view from their own tables (slice 8: `unknown`, `owedSince`). */
  readonly threadExtras: ((row: Row, view: P.MailThreadView) => void)[] = [];
  /** What later slices add to a message's view (slice 9: its triage), from its mail_message row. */
  readonly messageExtras: ((row: Row, view: P.MailMessageView) => void)[] = [];
  private selfCache = new Map<string, Set<string>>();

  constructor(
    readonly db: Database,
    private now: () => number = Date.now,
  ) {
    this.db.transaction(() => {
      for (const sql of mailSchemas()) this.db.exec(sql);
      // Before summary_headers: bulk was only ever stored from summaries, so an account with some had headers there.
      if (this.addColumns('mail_account', { summary_headers: 'INTEGER', headers_seen: 'INTEGER' }).includes('headers_seen')) {
        this.run('UPDATE mail_account SET headers_seen = 1 WHERE id IN (SELECT DISTINCT account_id FROM mail_message WHERE bulk IS NOT NULL)');
      }
      // What the extractor's status says of the account (setStatus): empty until it says, and from one that never does.
      this.addColumns('mail_account', { id_per_message: 'INTEGER', send_cap: 'INTEGER', max_recipients: 'INTEGER', provider: 'TEXT' });
      // The server's emailId (Gmail's X-GM-MSGID): empty on rows from before it, and on Proton's, which have none.
      this.addColumns('mail_message', { email_id: 'TEXT' });
      this.db.exec('CREATE INDEX IF NOT EXISTS mail_message_email ON mail_message(account_id, email_id) WHERE email_id IS NOT NULL');
      // Keeping all mail (keep.ts): what the status says of background reads and of the account's storage.
      this.addColumns('mail_account', { background_lane: 'INTEGER', search_ids: 'INTEGER', background_stopped: 'TEXT', storage: 'TEXT' });
      // Search text from before `cut`: what was as long as the cap then was cut to it.
      if (this.addColumns('mail_text', { cut: 'INTEGER NOT NULL DEFAULT 0' }).length) this.run('UPDATE mail_text SET cut = ?1 WHERE length(text) >= ?1', MAIL_LIMITS.textBytes);
      searchFiles(this);
    })();
  }

  /** Columns added since a table was first made (new databases have them from the schema). Returns those it added. */
  addColumns(table: string, cols: Record<string, string>): string[] {
    const have = this.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    const added = Object.keys(cols).filter((c) => !have.includes(c));
    for (const c of added) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${cols[c]}`);
    return added;
  }

  one<T = Row>(sql: string, ...args: any[]): T | null {
    return (this.db.query(sql).get(...args) as T | null) ?? null;
  }
  all<T = Row>(sql: string, ...args: any[]): T[] {
    return this.db.query(sql).all(...args) as T[];
  }
  private run(sql: string, ...args: any[]) {
    return this.db.query(sql).run(...args);
  }

  // ------------------------------------------------------------ accounts

  accounts(): Row[] {
    return this.all('SELECT * FROM mail_account ORDER BY created_at, id');
  }
  account(id: string): Row | null {
    return this.one('SELECT * FROM mail_account WHERE id = ?', id);
  }

  /** The manager lists it for the hub with a mail grant. 'added' the first time, 'changed' when anything did. */
  upsertAccount(a: MailAccountInput): 'added' | 'changed' | null {
    const was = this.account(a.id);
    if (!was) {
      const used = new Set(this.accounts().map((x) => x.color));
      const color = ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[this.accounts().length % ACCOUNT_COLORS.length];
      this.run(
        `INSERT INTO mail_account (id, kind, label, color, level, dry_run, online, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        a.kind,
        a.label,
        color,
        a.level,
        a.dryRun ? 1 : 0,
        a.online ? 1 : 0,
        this.now(),
      );
      this.dirty.accounts.add(a.id);
      return 'added';
    }
    const online = a.online === undefined ? was.online : a.online ? 1 : 0;
    if (was.kind === a.kind && was.label === a.label && was.level === a.level && !!was.dry_run === a.dryRun && was.online === online && was.gone_at === null) return null;
    this.run('UPDATE mail_account SET kind = ?, label = ?, level = ?, dry_run = ?, online = ?, gone_at = NULL WHERE id = ?', a.kind, a.label, a.level, a.dryRun ? 1 : 0, online, a.id);
    this.dirty.accounts.add(a.id);
    return 'changed';
  }

  /** It left the manager's list, or the grant went: its mail stays until MAIL_LIMITS.goneMs later. */
  accessEnded(id: string, at = this.now()): boolean {
    const r = this.run('UPDATE mail_account SET level = NULL, online = 0, gone_at = ? WHERE id = ? AND gone_at IS NULL', at, id);
    if (r.changes) this.dirty.accounts.add(id);
    return r.changes > 0;
  }

  /**
   * Its summaries carry no threading or bulk headers (Proton: only mail.get has them), so a message's class and thread
   * may change once its body comes. The extractor's status says so (`details.summaryHeaders`); when it does not, no
   * summary of the account has carried In-Reply-To, References or bulk headers yet.
   */
  headerless(accountId: string): boolean {
    const a = this.account(accountId);
    if (!a) return false;
    return a.summary_headers === null || a.summary_headers === undefined ? !a.headers_seen : !a.summary_headers;
  }

  /** Accounts whose access ended before `t`. */
  goneBefore(t: number): string[] {
    return this.all<{ id: string }>('SELECT id FROM mail_account WHERE gone_at IS NOT NULL AND gone_at <= ?', t).map((r) => r.id);
  }

  setOnline(id: string, online: boolean) {
    const r = this.run('UPDATE mail_account SET online = ? WHERE id = ? AND online != ?', online ? 1 : 0, id, online ? 1 : 0);
    if (r.changes) this.dirty.accounts.add(id);
  }

  /**
   * The extractor's `status` event: online or not, what is wrong, its own addresses, how it syncs, whether it can
   * send (details.canSend, else a failed layer named like sending), and what its server is (idPerMessage, sendCap,
   * maxRecipients, provider: a status without one keeps what an earlier one said). Returns whether its addresses
   * changed.
   */
  setStatus(id: string, st: Record<string, any>): boolean {
    const was = this.account(id);
    if (!was) return false;
    const layers: { name: string; state: string; note?: string }[] = Array.isArray(st.layers) ? st.layers : [];
    const bad = layers.find((l) => l.state !== 'ok');
    const failed = layers.find((l) => l.state === 'failed');
    const att = st.attention as { message?: string } | null | undefined;
    const problem = st.status === 'online' && !att ? null : att?.message ? { layer: failed?.name ?? bad?.name ?? null, message: att.message } : bad ? { layer: bad.name, message: bad.note ? `${bad.name}: ${bad.note}` : `${bad.name}: ${bad.state}` } : null;
    const details = (st.details ?? {}) as Record<string, unknown>;
    const sendLayer = layers.find((l) => /send path|smtp/i.test(l.name));
    const prevSend = json<{ ok: boolean | null; why: string | null; at?: number; refused?: boolean }>(was.send, { ok: null, why: null });
    const send =
      typeof details.canSend === 'boolean'
        ? // A send it answered 501 stays off while it still says it can (slice 5's outbox; "Try again" clears it).
          details.canSend && prevSend.ok === false && prevSend.refused
          ? prevSend
          : { ok: details.canSend, why: details.canSend ? null : (details.sendNote as string | null) ?? null }
        : sendLayer?.state === 'failed'
          ? { ok: false, why: sendLayer.note ?? `${sendLayer.name} failed` }
          : prevSend.ok === false && prevSend.at
            ? prevSend
            : { ok: prevSend.ok === true ? true : null, why: null };
    const self = (st.self ?? {}) as { email?: string; displayName?: string; addresses?: { email: string; name: string | null }[] };
    const address = self.email ?? was.address ?? null;
    const name = self.displayName ?? was.display_name ?? null;
    const addresses = Array.isArray(self.addresses) ? JSON.stringify(self.addresses) : was.addresses;
    const online = st.status === 'online' ? 1 : 0;
    const syncMode = typeof details.sync === 'string' ? details.sync : was.sync_mode;
    const bit = (v: unknown, had: number | null | undefined) => (typeof v === 'boolean' ? (v ? 1 : 0) : (had ?? null));
    const count = (v: unknown, had: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : (had ?? null));
    const headers = bit(details.summaryHeaders, was.summary_headers);
    const perMessage = bit(details.idPerMessage, was.id_per_message);
    const sendCap = count(details.sendCap, was.send_cap);
    const maxRecipients = count(details.maxRecipients, was.max_recipients);
    const provider = typeof details.provider === 'string' && details.provider.trim() ? details.provider.trim() : (was.provider ?? null);
    // Keeping all mail (keep.ts): the lane for background reads and the ids-only search, kept as the others are;
    // background reads stopped only while a status says so; the storage the account uses, when it says.
    const lane = bit(details[DETAILS.backgroundLane], was.background_lane);
    const searchIds = bit(details[DETAILS.searchIds], was.search_ids);
    const stopped = typeof details[DETAILS.backgroundStopped] === 'string' && details[DETAILS.backgroundStopped] ? String(details[DETAILS.backgroundStopped]) : null;
    const storage = storageOf(details) ?? was.storage ?? null;
    const next = [JSON.stringify(problem), JSON.stringify(send), address, name, addresses, online, syncMode, headers, perMessage, sendCap, maxRecipients, provider, lane, searchIds, stopped, storage];
    const prev = [was.problem, was.send, was.address, was.display_name, was.addresses, was.online, was.sync_mode, was.summary_headers ?? null, was.id_per_message ?? null, was.send_cap ?? null, was.max_recipients ?? null, was.provider ?? null, was.background_lane ?? null, was.search_ids ?? null, was.background_stopped ?? null, was.storage ?? null];
    if (next.every((v, i) => v === prev[i])) return false;
    this.run(
      'UPDATE mail_account SET problem = ?, send = ?, address = ?, display_name = ?, addresses = ?, online = ?, sync_mode = ?, summary_headers = ?, id_per_message = ?, send_cap = ?, max_recipients = ?, provider = ?, background_lane = ?, search_ids = ?, background_stopped = ?, storage = ? WHERE id = ?',
      ...next,
      id,
    );
    this.dirty.accounts.add(id);
    const selfChanged = address !== was.address || addresses !== was.addresses;
    if (selfChanged) this.selfChanged(id);
    return selfChanged;
  }

  // ------------------------------------------------------------ keeping all mail (keep.ts)

  /**
   * Whether an account keeps all its mail unless set otherwise for it (mail_keep): MailHub's `keepAll`, on in the hub
   * main.ts runs, off in a bare MailHub (the older tests' year of mail).
   */
  keepAll = false;

  /** It keeps all of its mail (keep.ts): as set for it, else `keepAll`. */
  kept(accountId: string): boolean {
    return this.keepState(accountId).keep;
  }

  /** The accounts that keep all their mail, as SQL: `account_id IN (${store.keptSql})`. */
  get keptSql(): string {
    return this.keepAll ? `SELECT id FROM mail_account WHERE id NOT IN (SELECT account_id FROM mail_keep WHERE keep = 0)` : `SELECT account_id FROM mail_keep WHERE keep = 1`;
  }

  /** Keeping all mail for it, and whether that is paused here. */
  keepState(accountId: string): { keep: boolean; paused: boolean } {
    const r = this.one<{ keep: number; paused: number }>('SELECT keep, paused FROM mail_keep WHERE account_id = ?', accountId);
    return { keep: r ? r.keep === 1 : this.keepAll, paused: !!r?.paused };
  }

  /** Keep all of it or not, pause or resume (PUT /api/mail/keep/:id). */
  setKeep(accountId: string, change: { keep?: boolean; paused?: boolean }) {
    const now = this.keepState(accountId);
    const keep = change.keep ?? now.keep;
    const paused = change.paused ?? now.paused;
    this.run('INSERT INTO mail_keep (account_id, keep, paused) VALUES (?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET keep = excluded.keep, paused = excluded.paused', accountId, keep ? 1 : 0, paused ? 1 : 0);
  }

  /** Its status says background reads have a lane of their own (`details.backgroundLane`): the archive's calls say `background: true`. */
  backgroundLane(accountId: string): boolean {
    return !!this.account(accountId)?.background_lane;
  }

  /** Background reads are stopped (`details.backgroundStopped`, or a background call's 503 `paused`): why, else null. */
  backgroundStopped(accountId: string): string | null {
    return this.account(accountId)?.background_stopped ?? null;
  }

  /** A background call answered 503 `paused`: stopped until a status no longer says so. */
  stopBackground(accountId: string, why: string) {
    const r = this.run('UPDATE mail_account SET background_stopped = ? WHERE id = ? AND background_stopped IS NOT ?', why, accountId, why);
    if (r.changes) this.dirty.accounts.add(accountId);
  }

  /** The addresses an account sends as, lower-cased. */
  selfAddresses(accountId: string): Set<string> {
    const hit = this.selfCache.get(accountId);
    if (hit) return hit;
    const a = this.account(accountId);
    const out = new Set<string>();
    if (a?.address) out.add(lc(a.address));
    for (const x of json<{ email: string }[]>(a?.addresses, [])) if (x?.email) out.add(lc(x.email));
    this.selfCache.set(accountId, out);
    return out;
  }

  /** Its addresses became known: who each message was addressed to, and whose threads end with you, again. */
  private selfChanged(accountId: string) {
    this.selfCache.delete(accountId);
    const self = this.selfAddresses(accountId);
    this.db.transaction(() => {
      const set = this.db.query('UPDATE mail_message SET addressed = ? WHERE id = ?');
      for (const m of this.all('SELECT id, from_addr, to_json, cc_json FROM mail_message WHERE account_id = ?', accountId)) set.run(addressedOf(self, m.from_addr, json(m.to_json, []), json(m.cc_json, [])), m.id);
      for (const t of this.all<{ id: string }>('SELECT id FROM mail_thread WHERE account_id = ?', accountId)) this.recompute(t.id);
    })();
  }

  /** Everything of an account: its mail, mailboxes, threads. */
  deleteAccount(id: string) {
    const threads = this.all<{ id: string }>('SELECT id FROM mail_thread WHERE account_id = ?', id).map((r) => r.id);
    this.db.transaction(() => {
      this.run('DELETE FROM mail_body WHERE message_id IN (SELECT id FROM mail_message WHERE account_id = ?)', id);
      this.run('DELETE FROM mail_location WHERE message_id IN (SELECT id FROM mail_message WHERE account_id = ?)', id);
      this.run('DELETE FROM mail_message WHERE account_id = ?', id);
      this.run('DELETE FROM mail_ref WHERE account_id = ?', id);
      this.run('DELETE FROM mail_thread WHERE account_id = ?', id);
      this.run('DELETE FROM mailbox WHERE account_id = ?', id);
      for (const t of ['mail_keep', 'mail_search_measure', 'mail_audit']) this.run(`DELETE FROM ${t} WHERE account_id = ?`, id);
      this.run('DELETE FROM mail_account WHERE id = ?', id);
    })();
    this.selfCache.delete(id);
    for (const t of threads) {
      this.dirty.threads.delete(t);
      this.dirty.threadsRemoved.add(t);
    }
    this.dirty.accounts.add(id);
    this.dirty.mailboxes.add(id);
  }

  /**
   * A Gmail account (docs/mail.md "Gmail"): the extractor says so (`details.provider` 'Gmail': the imap extractor's
   * gmail preset, and dither-accounts' google kind), its address is Gmail's, or its mailboxes sit under `[Gmail]`
   * (`[Google Mail]` in some countries; a Workspace address says nothing). On Gmail a label is a mailbox, so one message
   * is in several at once, and a move takes a label off and puts one on. What is Gmail the server's holds whichever way
   * the extractor reaches it: its search syntax, a move out of All Mail that only adds a label, a sent message in Sent
   * and All Mail at once, Trash and Spam holding a message alone. What comes of an id per mailbox is gmailPerMailbox's.
   */
  gmail(accountId: string): boolean {
    const a = this.account(accountId);
    if (lc(a?.provider) === 'gmail') return true;
    if (/@(gmail|googlemail)\.com$/i.test(a?.address ?? '')) return true;
    return !!this.one(`SELECT 1 FROM mailbox WHERE account_id = ? AND (path LIKE '[Gmail]%' OR path LIKE '[Google Mail]%')`, accountId);
  }

  /**
   * A message has one id in every mailbox it is in, so a move keeps it (Proton; Gmail on the web, dither-accounts'
   * google kind), rather than an id per mailbox (IMAP, Gmail over IMAP among them). The extractor's status says so
   * (`details.idPerMessage`); until it does, Proton's ids are the message's and every other kind's are per mailbox.
   */
  idPerMessage(accountId: string): boolean {
    const a = this.account(accountId);
    if (!a) return false;
    return a.id_per_message === null || a.id_per_message === undefined ? a.kind === 'proton' : !!a.id_per_message;
  }

  /**
   * Gmail with an id per mailbox (over IMAP): a message is a copy in each mailbox its labels put it in, each with an id
   * of its own. Its labels come without the one of the mailbox that listed it (ownLabel), and an archive waits for the
   * page's Undo (ops.ts gmailArchiveHoldMs). Gmail on the web has neither.
   */
  gmailPerMailbox(accountId: string): boolean {
    return this.gmail(accountId) && !this.idPerMessage(accountId);
  }

  /**
   * Gmail over IMAP leaves the label of the mailbox a message was listed from out of its labels (X-GM-LABELS): listed
   * from Work it has no `Work`, from Inbox no `\Inbox`. That label, to put back, so a message's labels are the same
   * whichever mailbox listed it last. All Mail, Trash, Spam and the other mailboxes under `[Gmail]` have none. Gmail on
   * the web gives a message's labels whole, the same from every mailbox: nothing to put back.
   */
  private ownLabel(accountId: string, b: Row): string | null {
    if (!this.gmailPerMailbox(accountId)) return null;
    const byRole: Record<string, string> = { inbox: '\\Inbox', sent: '\\Sent', drafts: '\\Draft', flagged: '\\Starred', important: '\\Important' };
    if (b.role) return byRole[b.role] ?? null;
    return /^\[(gmail|google mail)\]/i.test(b.path) ? null : b.path;
  }

  markSynced(id: string) {
    this.run('UPDATE mail_account SET synced_at = ? WHERE id = ?', this.now(), id);
    this.dirty.accounts.add(id);
  }

  // ------------------------------------------------------------ mailboxes

  mailboxes(accountId: string): Row[] {
    return this.all('SELECT * FROM mailbox WHERE account_id = ? ORDER BY path', accountId);
  }
  mailbox(id: string): Row | null {
    return this.one('SELECT * FROM mailbox WHERE id = ?', id);
  }
  mailboxByNative(accountId: string, nativeId: string): Row | null {
    return this.one('SELECT * FROM mailbox WHERE account_id = ? AND native_id = ?', accountId, nativeId);
  }
  followed(accountId: string): Row[] {
    // Inbox first: the screen fills from it.
    return this.all(`SELECT * FROM mailbox WHERE account_id = ? AND follow IS NOT NULL ORDER BY role = 'inbox' DESC, role = 'sent' DESC, path`, accountId);
  }

  /** mail.mailboxes' answer. Mailboxes gone from it go, with their locations; returns the messages left with none. */
  putMailboxes(accountId: string, list: M.Mailbox[]): string[] {
    const follow = followedRoles(list);
    const ids = new Set<string>();
    let orphans: string[] = [];
    this.db.transaction(() => {
      for (const b of list) {
        const id = mailId('mbx', accountId, b.id);
        ids.add(id);
        const parent = b.parentId ? mailId('mbx', accountId, b.parentId) : null;
        const f = b.role && follow.has(b.role) ? 'always' : null;
        this.run(
          `INSERT INTO mailbox (id, account_id, native_id, name, path, parent_id, role, unread, total, follow) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, path = excluded.path, parent_id = excluded.parent_id, role = excluded.role,
             unread = excluded.unread, total = excluded.total, follow = CASE WHEN excluded.follow IS NOT NULL THEN excluded.follow WHEN mailbox.follow = 'always' THEN NULL ELSE mailbox.follow END`,
          id,
          accountId,
          b.id,
          b.name,
          b.path,
          parent,
          b.role,
          b.unread,
          b.total,
          f,
        );
      }
      for (const old of this.mailboxes(accountId)) {
        if (ids.has(old.id)) continue;
        orphans.push(...this.dropLocations(old.id, this.all<{ native_id: string }>('SELECT native_id FROM mail_location WHERE mailbox_id = ?', old.id).map((r) => r.native_id)));
        this.run('DELETE FROM mailbox WHERE id = ?', old.id);
      }
    })();
    this.dirty.mailboxes.add(accountId);
    return orphans;
  }

  setState(mailboxId: string, state: string | null) {
    this.run('UPDATE mailbox SET state = ?, state_at = ? WHERE id = ?', state, this.now(), mailboxId);
  }

  /** How far down the list from the top has come. Each cursor is kept with the oldest above it (schema-big.sql). */
  setListed(mailboxId: string, l: { next: string | null; horizon: number | null; complete: boolean }) {
    this.run('UPDATE mailbox SET list_next = ?, horizon = ?, complete = ? WHERE id = ?', l.next, l.horizon, l.complete ? 1 : 0, mailboxId);
    if (l.next && l.horizon !== null) this.run('INSERT OR REPLACE INTO mail_page (mailbox_id, cursor, above) VALUES (?, ?, ?)', mailboxId, l.next, l.horizon);
  }

  bumpRelist(mailboxId: string): number {
    this.run('UPDATE mailbox SET relist_gen = relist_gen + 1 WHERE id = ?', mailboxId);
    this.run('DELETE FROM mail_page WHERE mailbox_id = ?', mailboxId);
    return this.mailbox(mailboxId)?.relist_gen ?? 0;
  }

  /** How many messages it holds, and the oldest. */
  mailboxHeld(mailboxId: string): { n: number; oldest: number | null } {
    const r = this.one<{ n: number; oldest: number | null }>('SELECT COUNT(*) AS n, MIN(m.received_at) AS oldest FROM mail_location l JOIN mail_message m ON m.id = l.message_id WHERE l.mailbox_id = ?', mailboxId);
    return { n: r?.n ?? 0, oldest: r?.oldest ?? null };
  }

  // ------------------------------------------------------------ ingest

  private lookup(accountId: string): ThreadLookup {
    const self = this.selfAddresses(accountId);
    const info = (r: Row | null): ThreadInfo | null =>
      r
        ? {
            id: r.id,
            firstAt: r.first_at,
            lastAt: r.last_at,
            native: !!r.native_thread,
            others: json<{ e: string }[]>(r.participants, [])
              .map((p) => p.e)
              .filter((e) => !self.has(e)),
          }
        : null;
    return {
      byRef: (ref) => this.one<{ thread_id: string }>('SELECT thread_id FROM mail_ref WHERE account_id = ? AND ref = ?', accountId, ref)?.thread_id ?? null,
      info: (id) => info(this.one('SELECT id, first_at, last_at, native_thread, participants FROM mail_thread WHERE id = ?', id)),
      bySubject: (key, at, gap) =>
        this.all('SELECT id, first_at, last_at, native_thread, participants FROM mail_thread WHERE account_id = ? AND subject_key = ? AND last_at >= ? AND first_at <= ?', accountId, key, at - gap, at + gap).map((r) => info(r)!),
    };
  }

  /**
   * Summaries listed in (or arrived to) one mailbox: new messages are threaded and stored, known ones gain the
   * location and take the server's flags. `gen`: the relist this listing is part of.
   */
  ingest(accountId: string, mailbox: Row, list: M.MailSummary[], gen?: number): Ingested {
    const out: Ingested = { added: [], threads: new Set(), orphans: [] };
    if (!list.length) return out;
    const own = this.ownLabel(accountId, mailbox);
    if (own) list = list.map((s) => (s.labels && !s.labels.includes(own) ? { ...s, labels: [...s.labels, own].sort() } : s));
    const self = this.selfAddresses(accountId);
    this.db.transaction(() => {
      if (list.some((s) => s.bulk || s.inReplyTo || s.references?.length)) this.run('UPDATE mail_account SET headers_seen = 1 WHERE id = ? AND headers_seen IS NULL', accountId);
      for (const s of list) {
        const { id, key } = this.identify(accountId, mailbox, s);
        const at = this.one<{ message_id: string }>('SELECT message_id FROM mail_location WHERE mailbox_id = ? AND native_id = ?', mailbox.id, s.id);
        if (at && at.message_id !== id) out.orphans.push(at.message_id);
        const known = this.one('SELECT id, thread_id, thread_by, in_reply_to, refs, pending, seen, email_id FROM mail_message WHERE id = ?', id);
        if (known) {
          if (s.emailId && !known.email_id) this.run('UPDATE mail_message SET email_id = ? WHERE id = ?', s.emailId, id);
          this.applyFlags(known, s.flags, s.labels);
          // The extractor gives threading headers on summaries now (§13): a provisional thread may be wrong.
          if ((s.inReplyTo || s.references?.length) && !known.in_reply_to && !json<string[]>(known.refs, []).length) {
            this.run('UPDATE mail_message SET in_reply_to = ?, refs = ? WHERE id = ?', s.inReplyTo ?? null, JSON.stringify(s.references ?? []), id);
            this.rethread(accountId, id, out.threads);
          }
          out.threads.add(this.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', id)!.thread_id);
        } else {
          this.insertMessage(accountId, id, key, s, self, out);
        }
        this.run(
          'INSERT INTO mail_location (mailbox_id, native_id, message_id, seen_gen) VALUES (?, ?, ?, ?) ON CONFLICT (mailbox_id, native_id) DO UPDATE SET message_id = excluded.message_id, seen_gen = excluded.seen_gen',
          mailbox.id,
          s.id,
          id,
          gen ?? mailbox.relist_gen ?? 0,
        );
      }
      for (const t of out.threads) this.recompute(t);
    })();
    return out;
  }

  /**
   * Which message a summary is. With a Message-ID header: `m:<Message-ID>`, as always. Without one, the server's emailId
   * (Gmail's X-GM-MSGID, the same in every mailbox): the message that has it already; else the one at this very place
   * from before emailIds came (it takes the emailId and keeps its id, body and state); else a new one, `e:<emailId>`.
   * With neither: `x:<mailbox>/<id>`, the place itself, so each mailbox's copy is a message of its own.
   */
  private identify(accountId: string, mailbox: Row, s: M.MailSummary): { id: string; key: string } {
    const keyed = (key: string) => ({ id: mailId('mml', accountId, key), key });
    if (s.messageId) return keyed(`m:${s.messageId}`);
    if (!s.emailId) return keyed(`x:${mailbox.native_id}/${s.id}`);
    const key = `e:${s.emailId}`;
    const had = this.one<{ id: string }>('SELECT id FROM mail_message WHERE account_id = ? AND email_id = ?', accountId, s.emailId);
    if (had) return { id: had.id, key };
    const here = this.one<{ id: string }>(
      'SELECT m.id FROM mail_location l JOIN mail_message m ON m.id = l.message_id WHERE l.mailbox_id = ? AND l.native_id = ? AND m.message_id_hdr IS NULL AND m.email_id IS NULL',
      mailbox.id,
      s.id,
    );
    if (here) {
      this.run('UPDATE mail_message SET email_id = ? WHERE id = ?', s.emailId, here.id);
      return { id: here.id, key };
    }
    return keyed(key);
  }

  private insertMessage(accountId: string, id: string, key: string, s: M.MailSummary, self: Set<string>, out: Ingested) {
    const from = s.from[0] ?? null;
    const others = [...new Set([...s.from, ...s.to, ...s.cc].map((a) => lc(a.email)).filter((e) => e && !self.has(e)))];
    const place = placeMessage(
      { accountId, key, messageId: s.messageId, threadId: s.threadId, inReplyTo: s.inReplyTo ?? null, references: s.references ?? [], subject: s.subject, at: s.receivedAt, others },
      this.lookup(accountId),
    );
    this.ensureThread(accountId, place.threadId, s, place.by === 'native' ? s.threadId : null);
    for (const t of place.merge) this.mergeThread(t, place.threadId, out.threads);
    this.run(
      `INSERT INTO mail_message (id, account_id, thread_id, thread_by, message_id_hdr, native_thread, in_reply_to, refs, from_addr, from_name, to_json, cc_json, subject,
         date, received_at, size, has_attachments, preview, seen, flagged, answered, draft, labels, bulk, addressed, email_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      accountId,
      place.threadId,
      place.by,
      s.messageId,
      s.threadId,
      s.inReplyTo ?? null,
      JSON.stringify(s.references ?? []),
      from ? lc(from.email) : null,
      from?.name ?? null,
      JSON.stringify(s.to),
      JSON.stringify(s.cc),
      s.subject ?? '',
      s.date || s.receivedAt,
      s.receivedAt,
      s.size ?? 0,
      s.hasAttachments ? 1 : 0,
      s.preview ? s.preview.slice(0, 200) : null,
      s.flags.seen ? 1 : 0,
      s.flags.flagged ? 1 : 0,
      s.flags.answered ? 1 : 0,
      s.flags.draft ? 1 : 0,
      JSON.stringify(s.labels ?? []),
      s.bulk ? JSON.stringify(s.bulk) : null,
      addressedOf(self, from?.email ?? null, s.to, s.cc),
      s.emailId ?? null,
    );
    this.putRefs(accountId, place.threadId, [s.messageId, s.inReplyTo ?? null, ...(s.references ?? [])]);
    out.added.push(id);
    out.threads.add(place.threadId);
    // Later messages in the same batch thread against it as it now is.
    this.recompute(place.threadId);
  }

  /** The thread's row, until recompute fills it in from its messages. */
  private ensureThread(accountId: string, id: string, s: M.MailSummary, native: string | null) {
    this.run(
      `INSERT OR IGNORE INTO mail_thread (id, account_id, native_thread, subject_key, subject, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      accountId,
      native,
      normalizeSubject(s.subject),
      s.subject ?? '',
      s.receivedAt,
      s.receivedAt,
    );
  }

  private putRefs(accountId: string, threadId: string, refs: (string | null)[]) {
    const put = this.db.query('INSERT INTO mail_ref (account_id, ref, thread_id) VALUES (?, ?, ?) ON CONFLICT (account_id, ref) DO UPDATE SET thread_id = excluded.thread_id');
    for (const r of new Set(refs)) if (r) put.run(accountId, r, threadId);
  }

  /** `from` joins `into`: its messages and references move, it goes. */
  private mergeThread(from: string, into: string, touched: Set<string>) {
    if (from === into) return;
    const was = this.one('SELECT opened_at, opened_ms, muted FROM mail_thread WHERE id = ?', from);
    this.run('UPDATE mail_message SET thread_id = ? WHERE thread_id = ?', into, from);
    this.run('UPDATE mail_ref SET thread_id = ? WHERE thread_id = ?', into, from);
    if (was) this.run('UPDATE mail_thread SET opened_at = MAX(COALESCE(opened_at, 0), ?), opened_ms = opened_ms + ?, muted = MAX(muted, ?) WHERE id = ?', was.opened_at ?? 0, was.opened_ms ?? 0, was.muted ?? 0, into);
    this.run('DELETE FROM mail_thread WHERE id = ?', from);
    touched.delete(from);
    touched.add(into);
    this.dirty.threads.delete(from);
    this.dirty.threadsRemoved.add(from);
  }

  /**
   * A message that came without threading headers (plain IMAP) got them from mail.get: if it was threaded by subject
   * or started its own, it moves to the thread its references name.
   */
  private rethread(accountId: string, id: string, touched: Set<string>) {
    const m = this.one('SELECT * FROM mail_message WHERE id = ?', id);
    if (!m) return;
    const refs = json<string[]>(m.refs, []);
    let thread: string = m.thread_id;
    if (m.thread_by === 'subject' || m.thread_by === 'new') {
      const look = this.lookup(accountId);
      // Its own thread does not count: that is where it is now.
      const to = [m.in_reply_to, ...[...refs].reverse()]
        .filter((r): r is string => !!r)
        .map((r) => look.byRef(r))
        .find((t) => !!t && t !== thread);
      if (to) {
        this.run(`UPDATE mail_message SET thread_id = ?, thread_by = 'ref' WHERE id = ?`, to, id);
        if (m.message_id_hdr) this.putRefs(accountId, to, [m.message_id_hdr]);
        touched.add(thread);
        touched.add(to);
        thread = to;
      }
    }
    // What it refers to that no thread has yet points at its thread.
    const put = this.db.query('INSERT OR IGNORE INTO mail_ref (account_id, ref, thread_id) VALUES (?, ?, ?)');
    for (const r of [m.in_reply_to, ...refs]) if (r) put.run(accountId, r, thread);
  }

  /** The server's flags win, except those with a change of ours it has not confirmed (slice 4 writes `pending`). */
  private applyFlags(m: Row, flags: M.MailFlags, labels: string[] | undefined) {
    const pending = json<Record<string, unknown>>(m.pending, {});
    const set: string[] = [];
    const args: unknown[] = [];
    for (const k of ['seen', 'flagged', 'answered', 'draft'] as const) {
      if (k in pending) continue;
      set.push(`${k} = ?`);
      args.push(flags[k] ? 1 : 0);
    }
    // Marked unread elsewhere after you read it here: unread here too.
    if (!('seen' in pending) && m.seen && !flags.seen) set.push('seen_local = 0');
    if (labels) {
      set.push('labels = ?');
      args.push(JSON.stringify(labels));
    }
    if (set.length) this.run(`UPDATE mail_message SET ${set.join(', ')} WHERE id = ?`, ...args, m.id);
  }

  /** mail.changes' `changed`: flags and labels, by the extractor's ids in this mailbox. Returns the threads touched. */
  changeFlags(mailboxId: string, changed: M.MailChanges['changed']): Set<string> {
    const touched = new Set<string>();
    const b = this.mailbox(mailboxId);
    const own = b ? this.ownLabel(b.account_id, b) : null;
    this.db.transaction(() => {
      for (const c of changed) {
        const m = this.one('SELECT m.id, m.thread_id, m.pending, m.seen FROM mail_location l JOIN mail_message m ON m.id = l.message_id WHERE l.mailbox_id = ? AND l.native_id = ?', mailboxId, c.id);
        if (!m) continue;
        this.applyFlags(m, c.flags, own && c.labels && !c.labels.includes(own) ? [...c.labels, own].sort() : c.labels);
        touched.add(m.thread_id);
      }
      for (const t of touched) this.recompute(t);
    })();
    return touched;
  }

  /** Locations gone from a mailbox (unknown ids are ignored). Returns the messages left with no location. */
  dropLocations(mailboxId: string, nativeIds: string[]): string[] {
    const orphans: string[] = [];
    const touched = new Set<string>();
    this.db.transaction(() => {
      for (const nid of nativeIds) {
        const l = this.one<{ message_id: string }>('SELECT message_id FROM mail_location WHERE mailbox_id = ? AND native_id = ?', mailboxId, nid);
        if (!l) continue;
        this.run('DELETE FROM mail_location WHERE mailbox_id = ? AND native_id = ?', mailboxId, nid);
        if (!this.one('SELECT 1 FROM mail_location WHERE message_id = ?', l.message_id)) orphans.push(l.message_id);
        const t = this.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', l.message_id);
        if (t) touched.add(t.thread_id);
      }
      for (const t of touched) this.recompute(t);
    })();
    return orphans;
  }

  /**
   * After a relist: locations it did not see go, of messages received since `since` (where the listing stopped; null:
   * it reached the end). Returns the messages left with none.
   */
  dropUnseen(mailboxId: string, gen: number, since: number | null = null): string[] {
    const ids = this.all<{ native_id: string }>(
      'SELECT l.native_id FROM mail_location l JOIN mail_message m ON m.id = l.message_id WHERE l.mailbox_id = ? AND l.seen_gen != ? AND m.received_at >= ?',
      mailboxId,
      gen,
      since ?? Number.MIN_SAFE_INTEGER,
    ).map((r) => r.native_id);
    return this.dropLocations(mailboxId, ids);
  }

  /** Messages that still have no location are deleted: their bodies too, and threads left empty. */
  deleteOrphans(ids: string[]): string[] {
    const gone: string[] = [];
    const touched = new Set<string>();
    this.db.transaction(() => {
      for (const id of new Set(ids)) {
        if (this.one('SELECT 1 FROM mail_location WHERE message_id = ?', id)) continue;
        // A move of ours is on its way: its answer says where it went (ops.ts).
        if (this.one(`SELECT 1 FROM mail_message WHERE id = ? AND json_type(pending, '$.move') IS 'object'`, id)) continue;
        const m = this.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', id);
        if (!m) continue;
        this.run('DELETE FROM mail_body WHERE message_id = ?', id);
        this.run('DELETE FROM mail_message WHERE id = ?', id);
        touched.add(m.thread_id);
        gone.push(id);
      }
      for (const t of touched) this.recompute(t);
    })();
    return gone;
  }

  /** Where to ask for it: a location's mailbox and id, Inbox first. */
  nativeOf(messageId: string): { accountId: string; mailbox: string; id: string } | null {
    const r = this.one(
      `SELECT m.account_id, b.native_id AS mailbox, l.native_id AS id FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id JOIN mail_message m ON m.id = l.message_id
       WHERE l.message_id = ? ORDER BY b.role = 'inbox' DESC, b.follow IS NOT NULL DESC LIMIT 1`,
      messageId,
    );
    return r ? { accountId: r.account_id, mailbox: r.mailbox, id: r.id } : null;
  }

  // ------------------------------------------------------------ threads

  /** A thread's counts, times, people and places, from its messages; a thread left with none goes. */
  recompute(threadId: string) {
    const ms = this.all('SELECT * FROM mail_message WHERE thread_id = ? ORDER BY received_at, id', threadId);
    if (!ms.length) {
      for (const f of this.recomputed) f(threadId, ms);
      if (this.run('DELETE FROM mail_thread WHERE id = ?', threadId).changes) {
        this.run('DELETE FROM mail_ref WHERE thread_id = ?', threadId);
        this.dirty.threads.delete(threadId);
        this.dirty.threadsRemoved.add(threadId);
      }
      return;
    }
    const last = ms[ms.length - 1];
    const parts = new Map<string, { e: string; n: string | null; f: number; l: number }>();
    const add = (email: string | null, name: string | null, from: boolean, at: number) => {
      const e = lc(email);
      if (!e) return;
      const p = parts.get(e) ?? { e, n: null, f: 0, l: 0 };
      if (name) p.n = name;
      if (from) {
        p.f++;
        p.l = Math.max(p.l, at);
      }
      parts.set(e, p);
    };
    const labels = new Set<string>();
    for (const m of ms) {
      add(m.from_addr, m.from_name, true, m.received_at);
      for (const a of [...json<M.MailAddress[]>(m.to_json, []), ...json<M.MailAddress[]>(m.cc_json, [])]) add(a.email, a.name, false, 0);
      for (const l of json<string[]>(m.labels, [])) labels.add(l);
    }
    // Where its messages are, with moves made here and not confirmed yet already made.
    const boxes = this.all<{ id: string; role: string | null }>(
      `SELECT b.id, b.role FROM mailbox b WHERE b.id IN (
         SELECT l.mailbox_id FROM mail_location l JOIN mail_message m ON m.id = l.message_id WHERE m.thread_id = ? AND NOT ${MOVED_OUT}
         UNION SELECT json_extract(m.pending, '$.move.to') FROM mail_message m WHERE m.thread_id = ? AND m.pending IS NOT NULL) ORDER BY b.path`,
      threadId,
      threadId,
    );
    const subject = last.subject || [...ms].reverse().find((m) => m.subject)?.subject || '';
    const preview = [...ms].reverse().find((m) => m.preview)?.preview ?? null;
    this.run(
      `UPDATE mail_thread SET subject = ?, first_at = ?, last_at = ?, last_message_id = ?, count = ?, unread = ?, flagged = ?, attachments = ?, participants = ?,
         roles = ?, mailboxes = ?, labels = ?, preview = ?, last_from_me = ? WHERE id = ?`,
      subject,
      ms[0].received_at,
      last.received_at,
      last.id,
      ms.length,
      ms.filter((m) => !m.seen && !m.seen_local).length,
      ms.some((m) => m.flagged) ? 1 : 0,
      ms.some((m) => m.has_attachments) ? 1 : 0,
      JSON.stringify([...parts.values()]),
      JSON.stringify([...new Set(boxes.map((b) => b.role).filter(Boolean))]),
      JSON.stringify(boxes.map((b) => b.id)),
      JSON.stringify([...labels]),
      preview,
      last.addressed === 'self' ? 1 : 0,
      threadId,
    );
    for (const f of this.recomputed) f(threadId, ms);
    this.dirty.threads.add(threadId);
  }

  thread(id: string): Row | null {
    return this.one('SELECT * FROM mail_thread WHERE id = ?', id);
  }

  /** Read here (slice 1 keeps read state on the hub only; slice 4 tells the server). Returns the threads it changed. */
  markReadHere(threadIds: string[]): string[] {
    const changed: string[] = [];
    this.db.transaction(() => {
      for (const t of threadIds) {
        if (this.run('UPDATE mail_message SET seen_local = 1 WHERE thread_id = ? AND seen = 0 AND seen_local = 0', t).changes) {
          this.recompute(t);
          changed.push(t);
        }
      }
    })();
    return changed;
  }

  /** You opened it ("you were here", for the inbox's attention: slice 8). */
  opened(threadId: string, at = this.now()) {
    this.run('UPDATE mail_thread SET opened_at = ? WHERE id = ?', at, threadId);
  }

  // ------------------------------------------------------------ bodies

  body(messageId: string): Row | null {
    return this.one('SELECT * FROM mail_body WHERE message_id = ?', messageId);
  }

  /**
   * mail.get's answer: the body kept, the preview made, threading and bulk headers filled in (the thread fixed, and
   * classified again: Proton's summaries have neither, so a newsletter is known as one only from its body).
   */
  putBody(messageId: string, msg: M.MailMessage) {
    const m = this.one('SELECT * FROM mail_message WHERE id = ?', messageId);
    if (!m) return;
    // Line ends as the page splits them: IMAP gives CRLF.
    const raw = msg.text ?? (msg.html ? htmlText(msg.html) : null);
    const text = raw === null ? null : raw.replace(/\r\n?/g, '\n');
    const now = this.now();
    const touched = new Set<string>([m.thread_id]);
    this.db.transaction(() => {
      this.run(
        `INSERT INTO mail_body (message_id, text, html, parts, reply_to, bcc, bytes, fetched_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (message_id) DO UPDATE SET text = excluded.text, html = excluded.html, parts = excluded.parts, reply_to = excluded.reply_to, bcc = excluded.bcc,
           bytes = excluded.bytes, fetched_at = excluded.fetched_at, used_at = excluded.used_at`,
        messageId,
        text,
        msg.html,
        JSON.stringify(msg.attachments ?? []),
        JSON.stringify(msg.replyTo ?? []),
        JSON.stringify(msg.bcc ?? []),
        (text?.length ?? 0) + (msg.html?.length ?? 0),
        now,
        now,
      );
      const hasFiles = (msg.attachments ?? []).some((a) => !a.inline) ? 1 : m.has_attachments;
      this.run('UPDATE mail_message SET preview = ?, has_attachments = ? WHERE id = ?', mailPreview(text) ?? m.preview, hasFiles, messageId);
      const bulk = msg.bulk ? JSON.stringify(msg.bulk) : null;
      if (bulk && bulk !== m.bulk) this.run('UPDATE mail_message SET bulk = ? WHERE id = ?', bulk, messageId);
      const refs = msg.references ?? [];
      if ((msg.inReplyTo && msg.inReplyTo !== m.in_reply_to) || refs.length > json<string[]>(m.refs, []).length) {
        this.run('UPDATE mail_message SET in_reply_to = ?, refs = ? WHERE id = ?', msg.inReplyTo ?? m.in_reply_to, JSON.stringify(refs.length ? refs : json(m.refs, [])), messageId);
        this.rethread(m.account_id, messageId, touched);
      }
      for (const t of touched) this.recompute(t);
    })();
  }

  touchBody(messageId: string) {
    this.run('UPDATE mail_body SET used_at = ? WHERE message_id = ?', this.now(), messageId);
  }

  // ------------------------------------------------------------ views

  accountView(r: Row): P.MailAccountView {
    const held = this.one<{ n: number; oldest: number | null }>('SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM mail_message WHERE account_id = ?', r.id);
    const send = json<{ ok: boolean | null; why: string | null; refused?: boolean }>(r.send, { ok: null, why: null });
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      address: r.address ?? null,
      name: r.display_name ?? null,
      color: r.color,
      level: r.level ?? null,
      dryRun: !!r.dry_run,
      online: !!r.online,
      problem: json(r.problem, null),
      send: { ok: send.ok ?? null, why: send.why ?? null, ...(send.ok === false && send.refused ? { refused: true } : {}) },
      sync: { phase: this.syncOf(r.id), synced: held?.n ?? 0, oldest: held?.oldest ?? null },
      managedUrl: this.managedUrl(r.id),
      deleteAt: r.gone_at ? r.gone_at + MAIL_LIMITS.goneMs : null,
      ops: this.opsOf(r.id),
      sendCap: sendCapOf(r),
      maxRecipients: maxRecipientsOf(r),
    };
  }

  mailboxView(r: Row): P.MailboxView {
    return { id: r.id, accountId: r.account_id, name: r.name, path: r.path, parentId: r.parent_id ?? null, role: r.role ?? null, unread: r.unread ?? null, total: r.total ?? null, followed: r.follow === 'always' };
  }

  threadView(r: Row): P.MailThreadView {
    const self = this.selfAddresses(r.account_id);
    const parts = json<{ e: string; n: string | null; f: number; l: number }[]>(r.participants, []);
    const who = this.whoIs(parts.map((p) => p.e).filter((e) => !self.has(e)));
    const from = parts
      .filter((p) => p.f > 0)
      .sort((a, b) => a.l - b.l)
      .map((p) => ({ name: p.n, email: p.e, ...(self.has(p.e) ? { self: true } : {}), ...whoView(who.get(p.e)) }));
    const view: P.MailThreadView = {
      id: r.id,
      accountId: r.account_id,
      subject: r.subject,
      firstAt: r.first_at,
      lastAt: r.last_at,
      count: r.count,
      unread: r.unread,
      flagged: !!r.flagged,
      attachments: !!r.attachments,
      from,
      participants: parts.length,
      preview: r.preview ?? null,
      mailboxIds: json(r.mailboxes, []),
      roles: json(r.roles, []),
      labels: shownLabels(json(r.labels, [])),
      class: r.class ?? null,
      unknown: false,
      personIds: [...new Set([...who.values()].map((w) => w.personId).filter((x): x is string => !!x))],
      lastFromMe: !!r.last_from_me,
      owedSince: null,
      muted: !!r.muted,
      pending: !!this.one('SELECT 1 FROM mail_message WHERE thread_id = ? AND pending IS NOT NULL', r.id),
    };
    for (const f of this.threadExtras) f(r, view);
    return view;
  }

  threadViews(ids: string[]): P.MailThreadView[] {
    if (!ids.length) return [];
    return this.all('SELECT * FROM mail_thread WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)).map((r) => this.threadView(r));
  }

  messageViews(threadId: string): P.MailMessageView[] {
    const rows = this.all(
      `SELECT m.*, (SELECT json_group_array(mailbox_id) FROM mail_location WHERE message_id = m.id) AS boxes, EXISTS (SELECT 1 FROM mail_body WHERE message_id = m.id) AS cached
       FROM mail_message m WHERE m.thread_id = ? ORDER BY m.received_at, m.id`,
      threadId,
    );
    const who = this.whoIs([...new Set(rows.flatMap((m) => [m.from_addr, ...json<M.MailAddress[]>(m.to_json, []).map((a) => a.email), ...json<M.MailAddress[]>(m.cc_json, []).map((a) => a.email)].map(lc)))]);
    const addr = (a: M.MailAddress) => ({ name: a.name ?? null, email: a.email, ...whoView(who.get(lc(a.email))) });
    return rows.map((m) => {
      const v: P.MailMessageView = {
        id: m.id,
        threadId: m.thread_id,
        accountId: m.account_id,
        messageId: m.message_id_hdr ?? null,
        from: { name: m.from_name ?? null, email: m.from_addr ?? '', ...whoView(who.get(lc(m.from_addr))) },
        to: json<M.MailAddress[]>(m.to_json, []).map(addr),
        cc: json<M.MailAddress[]>(m.cc_json, []).map(addr),
        subject: m.subject,
        date: m.date,
        receivedAt: m.received_at,
        flags: { seen: !!m.seen, flagged: !!m.flagged, answered: !!m.answered, draft: !!m.draft },
        seenHere: !!m.seen_local,
        pending: !!m.pending,
        labels: shownLabels(json(m.labels, [])),
        mailboxIds: json(m.boxes, []),
        hasAttachments: !!m.has_attachments,
        preview: m.preview ?? null,
        addressed: m.addressed,
        body: m.cached ? 'cached' : 'none',
      };
      for (const f of this.messageExtras) f(m, v);
      return v;
    });
  }

  bodyView(messageId: string): P.MailBodyView | null {
    const b = this.body(messageId);
    if (!b) return null;
    const text: string | null = b.text ?? null;
    const addr = (xs: M.MailAddress[]) => xs.map((a) => ({ name: a.name ?? null, email: a.email }));
    const v: P.MailBodyView = {
      messageId,
      text,
      quoteAt: text ? quoteStart(text) : null,
      // bodyExtras fill these (slice 3: the sanitised HTML, files, warnings).
      html: null,
      bcc: addr(json(b.bcc, [])),
      replyTo: addr(json(b.reply_to, [])),
      attachments: [],
      warnings: [],
    };
    for (const f of this.bodyExtras) Object.assign(v, f(messageId, b));
    return v;
  }

  /**
   * A page of a list, newest first. `before`: the cursor a page gave (`<lastAt>:<id>`). Inbox leaves out mail that is
   * not from a person (its Updates row is the `updates` view); People is the rest of Inbox from people (slice 8).
   */
  listThreads(key: string, before: string | null, limit: number): P.MailThreadPage | null {
    const list = parseMailList(key);
    const withWho = list ? null : parseWithList(key);
    if (!list && withWho === null) return null;
    const where: string[] = [];
    const args: unknown[] = [];
    let scope: { accounts: string | null; role: string | null; mailbox: string | null };
    if (withWho !== null) {
      // Everything with someone (slice 6): any mailbox, any account.
      where.push('t.id IN (SELECT thread_id FROM mail_party WHERE address IN (SELECT value FROM json_each(?)))');
      args.push(JSON.stringify(this.addressesOf(withWho)));
      scope = { accounts: null, role: null, mailbox: null };
    } else if (!list) {
      return null;
    } else if ('mailbox' in list) {
      const b = this.mailbox(list.mailbox);
      if (!b) return null;
      where.push(
        `t.id IN (SELECT m.thread_id FROM mail_location l JOIN mail_message m ON m.id = l.message_id WHERE l.mailbox_id = ? AND NOT ${MOVED_OUT}
          UNION SELECT m.thread_id FROM mail_message m WHERE m.pending IS NOT NULL AND json_extract(m.pending, '$.move.to') = ?)`,
      );
      args.push(b.id, b.id);
      scope = { accounts: b.account_id, role: null, mailbox: b.id };
    } else {
      if (list.accountId) {
        where.push('t.account_id = ?');
        args.push(list.accountId);
      }
      const role = list.view === 'sent' ? 'sent' : 'inbox';
      if (list.view === 'inbox' || list.view === 'sent' || list.view === 'people' || list.view === 'updates') where.push(`EXISTS (SELECT 1 FROM json_each(t.roles) WHERE value = '${role}')`);
      // Classification (slice 8, classify.ts): an unclassified thread stays in Inbox.
      if (list.view === 'inbox') where.push(`(t.class IS NULL OR t.class != 'bulk')`);
      if (list.view === 'people') where.push(`t.class = 'personal'`);
      if (list.view === 'updates') where.push(`t.class = 'bulk'`);
      if (list.view === 'unread') where.push(`t.unread > 0 AND NOT EXISTS (SELECT 1 FROM json_each(t.roles) WHERE value IN ('junk', 'trash')) AND json_array_length(t.roles) > 0`);
      if (list.view === 'starred') where.push('t.flagged = 1');
      scope = { accounts: list.accountId, role: list.view === 'sent' ? 'sent' : 'inbox', mailbox: null };
    }
    where.push('t.account_id IN (SELECT id FROM mail_account WHERE hidden = 0)');
    const cur = before?.match(/^(\d+):([\w-]+)$/);
    if (cur) {
      where.push('(t.last_at < ? OR (t.last_at = ? AND t.id < ?))');
      args.push(Number(cur[1]), Number(cur[1]), cur[2]);
    }
    const n = Math.max(1, Math.min(limit, 200));
    const rows = this.all(`SELECT t.* FROM mail_thread t WHERE ${where.join(' AND ')} ORDER BY t.last_at DESC, t.id DESC LIMIT ?`, ...args, n + 1);
    const page = rows.slice(0, n);
    const more = rows.length > n;
    const boxes = scope.mailbox
      ? [this.mailbox(scope.mailbox)!]
      : this.all(`SELECT complete FROM mailbox WHERE role = ? ${scope.accounts ? 'AND account_id = ?' : ''}`, scope.role, ...(scope.accounts ? [scope.accounts] : []));
    return {
      threads: page.map((r) => this.threadView(r)),
      next: more ? `${page[page.length - 1].last_at}:${page[page.length - 1].id}` : null,
      complete: !more && boxes.every((b) => !!b?.complete),
      pending: false,
    };
  }

  /**
   * What the bootstrap carries: the threads the one-list inbox lists (slice 8), and each account's newest Inbox page,
   * at most MAIL_LIMITS.windowMax in all.
   */
  liveWindow(): P.MailThreadView[] {
    const listed: Row[] = this.all(`SELECT t.* FROM mail_thread t WHERE t.listed = 1 AND t.account_id IN (SELECT id FROM mail_account WHERE hidden = 0) ORDER BY t.last_at DESC LIMIT ?`, MAIL_LIMITS.windowMax);
    const have = new Set(listed.map((r) => r.id));
    const out: Row[] = [];
    for (const a of this.accounts()) {
      if (a.hidden) continue;
      out.push(
        ...this.all(
          `SELECT * FROM mail_thread t WHERE t.account_id = ? AND EXISTS (SELECT 1 FROM json_each(t.roles) WHERE value = 'inbox') ORDER BY t.last_at DESC LIMIT ?`,
          a.id,
          MAIL_LIMITS.windowPerAccount,
        ).filter((r) => !have.has(r.id)),
      );
    }
    return [...listed, ...out.sort((a, b) => b.last_at - a.last_at)]
      .slice(0, MAIL_LIMITS.windowMax)
      .sort((a, b) => b.last_at - a.last_at)
      .map((r) => this.threadView(r));
  }

  bootstrap(access: P.MailAccess): P.MailBootstrap {
    const accounts = this.accounts().filter((a) => !a.hidden);
    return {
      access,
      accounts: accounts.map((a) => this.accountView(a)),
      mailboxes: accounts.flatMap((a) => this.mailboxes(a.id).map((b) => this.mailboxView(b))),
      threads: this.liveWindow(),
    };
  }

  /** What changed since the last flush, as the page's events. */
  flush(access: () => P.MailAccess): P.ClientEvent[] {
    const d = this.dirty;
    if (!d.access && !d.accounts.size && !d.mailboxes.size && !d.threads.size && !d.threadsRemoved.size && !d.progress.size) return [];
    const out: P.ClientEvent[] = [];
    if (d.access) out.push({ t: 'mail.access', access: access() });
    const removedAccounts: P.ClientEvent[] = [];
    for (const id of d.accounts) {
      const a = this.account(id);
      if (a && !a.hidden) out.push({ t: 'mail.account', account: this.accountView(a) });
      else removedAccounts.push({ t: 'mail.account.removed', id });
    }
    for (const id of d.mailboxes) if (this.account(id)) out.push({ t: 'mail.mailboxes', accountId: id, mailboxes: this.mailboxes(id).map((b) => this.mailboxView(b)) });
    if (d.threads.size || d.threadsRemoved.size) {
      const w = this.window?.([...d.threads]) ?? null;
      const views = this.threadViews([...d.threads].filter((id) => !w?.held.has(id)));
      const have = new Set(views.map((v) => v.id));
      const removed = [...new Set([...d.threadsRemoved, ...[...d.threads].filter((id) => !have.has(id) && !w?.held.has(id))])].filter((id) => !have.has(id));
      if (views.length || removed.length) out.push({ t: 'mail.threads', threads: views, removed });
      if (w?.stale.length) out.push({ t: 'mail.lists', stale: w.stale });
    }
    for (const id of d.progress) {
      const a = d.accounts.has(id) ? null : this.account(id);
      if (a && !a.hidden) out.push({ t: 'mail.progress', accountId: id, sync: this.accountView(a).sync });
    }
    out.push(...removedAccounts);
    d.access = false;
    d.accounts.clear();
    d.mailboxes.clear();
    d.threads.clear();
    d.threadsRemoved.clear();
    d.progress.clear();
    return out;
  }
}

const MB = 1024 * 1024;

/**
 * The most bytes of files (attachments, together) one message from this account may carry: its extractor's
 * `details.sendCap`, else dither-accounts' limits before it said, 25 MB on Proton and 35 MB elsewhere.
 */
export const sendCapOf = (a: Row | null | undefined): number => a?.send_cap ?? (a?.kind === 'proton' ? 25 * MB : 35 * MB);

/** The most recipients, To, Cc and Bcc together, on one message: `details.maxRecipients`, else 100 on Proton and 500 elsewhere. */
export const maxRecipientsOf = (a: Row | null | undefined): number => a?.max_recipients ?? (a?.kind === 'proton' ? 100 : 500);

const whoView = (w: { identityId: string; personId: string | null } | undefined) => (w ? { identityId: w.identityId, ...(w.personId ? { personId: w.personId } : {}) } : {});

/** How a message reached you: you sent it, you are in To or Cc, or neither (Bcc, a list). */
export function addressedOf(self: Set<string>, from: string | null, to: M.MailAddress[], cc: M.MailAddress[]): 'to' | 'cc' | 'hidden' | 'self' {
  if (from && self.has(lc(from))) return 'self';
  if (to.some((a) => self.has(lc(a.email)))) return 'to';
  if (cc.some((a) => self.has(lc(a.email)))) return 'cc';
  return 'hidden';
}

/**
 * The names of the status's `details` that keeping all mail reads (dither-accounts, as agreed; keep.ts): a lane for
 * background reads, an ids-only paged mail.search, why background reads stopped, and the account's storage.
 */
export const DETAILS = {
  backgroundLane: 'backgroundLane',
  searchIds: 'searchIds',
  backgroundStopped: 'backgroundStopped',
  storage: 'storage',
  storageUsed: 'storageUsed',
  storageTotal: 'storageTotal',
} as const;

/** The storage the status says the account uses, as JSON {text, used, total}; null when it says nothing of it. */
function storageOf(details: Record<string, unknown>): string | null {
  const text = typeof details[DETAILS.storage] === 'string' && (details[DETAILS.storage] as string).trim() ? (details[DETAILS.storage] as string).trim() : null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const used = n(details[DETAILS.storageUsed]);
  const total = n(details[DETAILS.storageTotal]);
  return text === null && used === null && total === null ? null : JSON.stringify({ text, used, total });
}

/**
 * A database from before attachments' names were searchable: mail_search gets `files`, filled from the bodies held,
 * and the full-text index is made again with it (its triggers too). Once; a few seconds on a big mailbox.
 */
function searchFiles(store: MailStore) {
  const cols = store.all<{ name: string }>('PRAGMA table_info(mail_search)').map((c) => c.name);
  if (!cols.length || cols.includes('files')) return;
  const db = store.db;
  db.exec(`ALTER TABLE mail_search ADD COLUMN files TEXT NOT NULL DEFAULT ''`);
  for (const t of ['mail_search_insert', 'mail_search_delete', 'mail_search_update']) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  db.exec('DROP TABLE IF EXISTS mail_fts_vocab');
  db.exec('DROP TABLE IF EXISTS mail_fts');
  db.exec(`UPDATE mail_search SET files = COALESCE((SELECT group_concat(json_extract(j.value, '$.filename'), ' ') FROM mail_body b, json_each(b.parts) j WHERE b.message_id = mail_search.message_id AND json_extract(j.value, '$.filename') IS NOT NULL), '')`);
  db.exec(readFileSync(new URL('./schema-search.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO mail_fts (mail_fts) VALUES ('rebuild')`);
}

/** schema.sql, then each slice's schema-*.sql in name order. */
export function mailSchemas(): string[] {
  const dir = new URL('.', import.meta.url).pathname;
  const extra = readdirSync(dir)
    .filter((f) => /^schema-[\w-]+\.sql$/.test(f))
    .sort();
  return ['schema.sql', ...extra].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
}
