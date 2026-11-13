/**
 * Writes (docs/mail-design.md §2.4, §3.7): read and unread, star, archive, move, junk and trash.
 *
 * Each is made here first. A flag's column changes at once and `pending` keeps what the server had; a move only
 * records where it goes and which mailboxes it leaves, so the locations stay the server's while lists and threads
 * already show it moved (store.ts MOVED_OUT). Then the change waits in mail_op, batched per account, op and value, up
 * to 1000 messages, and goes out on the account's queue at P0, one write call per 220 ms at most (the manager allows
 * 5/s). A move takes the locations current when it is sent, so a move made elsewhere meanwhile is not undone. Only a
 * message's latest change goes: one undone before it was sent never leaves the hub.
 *
 * Each call sends `threadIds` beside `ids`, in the same order: each message's thread as its summary gave it
 * (mail_message.native_thread, null when none). The google kind changes mail by thread; IMAP and Proton ignore it.
 *
 * Answers (§3.7): a dry run's answer undoes it (nothing reached the account); success clears `pending`, so the server's
 * flags win again; a move puts the message where the answer says, or with a null id leaves that to the next changes
 * pass. A 200 may apply in part: ids it lists in `refused` (the server turned them down) or `unknown` (it could not find
 * them) are undone here alone, with `undone` for their threads and a line saying why, while the rest stands; a move's
 * null for one of these means it stayed. Any `unknown` also asks what changed, as the hub's ids may be stale. 404 drops
 * the change and asks what changed. 403 undoes every change waiting for the account and makes it read-only. 422 (none
 * of it applied) undoes it. 501 undoes it and remembers its kind as unsupported, so it is refused at once next time
 * (Proton's `answered`). 410 catches up and tries again. Anything else is tried again from 2 s, doubling, ten times,
 * then undone. While the manager or the account is away, changes wait, through a restart too; when it is back, a
 * changes pass goes first (§3.6).
 *
 * Kinds of write: `seen`, `flagged`, `move` (archive, Inbox, a folder or label), `trash` and `junk` (a move into
 * them). An account whose status lists the kinds it makes (`details.writes`, kept in mail_account.writes; Gmail's,
 * one kind at a time) is refused the others here, at once and with no call ("Gmail can't archive from here yet"); a
 * change already waiting when a status drops its kind is undone without a call. A status that lists a kind clears
 * that kind's 501. With no list (IMAP, Proton) every kind is tried, as before.
 *
 * Read state (§14 Q3): a thread a page read (MailHub's `read`: a second in view) is marked read on the server as well,
 * unless the setting says "only when I mark it", or the account does not mark mail read from here (a 501, or `seen`
 * not listed). An account with a read grant keeps read state here only (slice 1's seen_local) and refuses every other
 * write.
 *
 * MailHub gains an event here, `filed`: what this hub changed, as it shows, and `undone` when the server refused it.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import type { MailWriteKind } from '@dither-chat/protocol/mail-iface';
import { sleep, unref } from '../clock.ts';
import { asMailError, MailCallError } from './backend.ts';
import type { MailHub } from './index.ts';
import { P0 } from './queue.ts';
import type { MailRouter } from './routes.ts';
import { unsupportedOp } from './store.ts';
import type { AccountSync } from './sync.ts';
import { jobFailed } from '../errors.ts';

declare module './index.ts' {
  interface MailHubEvents {
    /**
     * A write made here (ops.ts), as it shows before the server confirms it; `undone` when the server refused it and
     * the threads are back as they were. Read in view comes as `read` first, then as `filed` read when it goes to the
     * server.
     */
    filed: { accountId: string; threadIds: string[]; action: MailAction; undone?: boolean };
  }
}

export type MailAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'inbox' | 'trash' | 'junk' | 'move';

type Row = Record<string, any>;
type Bit = 0 | 1;
type FlagKey = 'seen' | 'flagged';
/** A message in a write call: its id there, the mailbox a move takes it from, and its thread there (`threadIds`). */
type Item = { mid: string; native: string; from: string; copy?: boolean; thread: string | null };

/** mail_message.pending: changes made here the server has not confirmed. */
export interface Pending {
  seen?: { v: Bit; was: Bit; op: string };
  flagged?: { v: Bit; was: Bit; op: string };
  /**
   * Where it goes, and the mailboxes it leaves. `copy`: Gmail's All Mail, which it stays in while the destination's
   * label goes on (copyFrom: over IMAP the extractor copies it from there, on the web it only adds the label); `hide`
   * is empty then.
   */
  move?: { to: string; hide: string[]; op: string; copy?: string };
}

const MAX_IDS = 1000;
const GAP_MS = 220;
const MAX_ATTEMPTS = 10;
/** Roles a message is not filed under: what you sent and drafts stay, and All mail and the flag views are not folders. */
const NOT_FOLDER = new Set(['sent', 'drafts', 'all', 'flagged', 'important']);
const STAYS = new Set(['sent', 'drafts']);
const ROLE_NAMES: Record<string, string> = { archive: 'Archive', inbox: 'Inbox', trash: 'Trash', junk: 'Junk' };

/** A move's kind of write by where it goes: into the trash, into junk, or anywhere else. */
const moveKind = (dest: Row | null | undefined): MailWriteKind => (dest?.role === 'trash' ? 'trash' : dest?.role === 'junk' ? 'junk' : 'move');
/** An answer's `refused` or `unknown`: the ids in it. */
const idSet = (x: unknown) => new Set(Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);

const json = <T>(s: string | null | undefined, d: T): T => {
  if (!s) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

const instances = new WeakMap<MailHub, MailOps>();
/** The hub's writes (the router below makes them, once per hub). */
export const mailOps = (hub: MailHub): MailOps => instances.get(hub)!;

export class MailOps {
  /** How long a change waits for others to join its call. */
  coalesceMs = 250;
  /**
   * How long an archive on Gmail over IMAP waits before it goes: the 7 s the page offers Undo for (web mail/ops.ts),
   * and a little, so an Undo calls it off and Gmail never hears of either. An archive that went is undone by a copy
   * from All Mail back into Inbox (copyFrom), a new id there. Gmail on the web (one id for the message) takes Inbox's
   * label off and puts it back on, and is not held.
   */
  gmailArchiveHoldMs = 7_500;
  /** While changes wait for the manager or an account, how often to look again. */
  pollMs = 2000;
  private timer: unknown = null;
  private timerAt = Infinity;
  private busy = new Set<string>();
  private lastCall = new Map<string, number>();
  private catchUpFirst = new Set<string>();
  private errors = new Map<string, { message: string; at: number }>();
  private clients = new Map<string, P.MailOpResult>();

  constructor(private hub: MailHub) {
    instances.set(hub, this);
    hub.store.opsOf = (id) => this.view(id);
    // Calls that were out when the hub stopped go again: flags are idempotent, and a move finds its message anew.
    this.db.query('UPDATE mail_op SET sent_at = NULL WHERE sent_at IS NOT NULL').run();
    const waiting = this.waitingAccounts();
    for (const a of waiting) this.catchUpFirst.add(a);
    hub.on('read', (e) => this.readInView(e.threadIds));
    hub.on('account', (e) => {
      const a = this.hub.store.account(e.accountId);
      if (e.state === 'ended') this.dropAccount(e.accountId, 'dither-chat no longer has access to this account');
      else if (e.state === 'changed' && a?.level === 'read') this.dropAccount(e.accountId, 'dither-accounts lets dither-chat read this account now, not change it');
      if (this.waitingAccounts().includes(e.accountId)) this.kick(0);
    });
    hub.backend?.onConnection((up) => {
      if (!up) return;
      // Back: what changed meanwhile first, then the changes made here (§3.6).
      for (const a of this.waitingAccounts()) this.catchUpFirst.add(a);
      this.kick(0);
    });
    if (waiting.length) this.kick(0);
  }

  private now() {
    return this.hub.clock.now();
  }
  private get db(): Database {
    return this.hub.store.db;
  }
  private one<T = Row>(sql: string, ...args: any[]): T | null {
    return this.hub.store.one<T>(sql, ...args);
  }
  private all<T = Row>(sql: string, ...args: any[]): T[] {
    return this.hub.store.all<T>(sql, ...args);
  }
  private run(sql: string, ...args: any[]) {
    return this.db.query(sql).run(...args);
  }

  // ---------------------------------------------------------- settings

  settings(): P.MailSettings {
    const v = this.one<{ value: string }>(`SELECT value FROM mail_setting WHERE key = 'markRead'`)?.value;
    return { markRead: v === 'manual' ? 'manual' : 'view' };
  }

  setSettings(s: Partial<P.MailSettings>): P.MailSettings {
    if (s.markRead !== undefined) {
      if (s.markRead !== 'view' && s.markRead !== 'manual') throw new MailCallError('markRead: view or manual', 400);
      this.run(`INSERT INTO mail_setting (key, value) VALUES ('markRead', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, s.markRead);
    }
    return this.settings();
  }

  // ---------------------------------------------------------- what the account view says

  view(accountId: string): P.MailOpsView {
    return {
      waiting: this.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message WHERE account_id = ? AND pending IS NOT NULL', accountId)?.n ?? 0,
      error: this.errors.get(accountId) ?? null,
      unsupported: this.all<{ op: string }>('SELECT op FROM mail_unsupported WHERE account_id = ? ORDER BY op', accountId).map((r) => r.op),
    };
  }

  /** Accounts with changes waiting. */
  waitingAccounts(): string[] {
    return this.all<{ account_id: string }>('SELECT DISTINCT account_id FROM mail_op').map((r) => r.account_id);
  }

  // ---------------------------------------------------------- making changes

  /** The same change sent again by a page that lost its connection is made once. */
  once(clientId: unknown, fn: () => P.MailOpResult): P.MailOpResult {
    if (typeof clientId !== 'string' || !clientId) return fn();
    const had = this.clients.get(clientId);
    if (had) return had;
    const r = fn();
    this.clients.set(clientId, r);
    if (this.clients.size > 500) this.clients.delete(this.clients.keys().next().value!);
    return r;
  }

  /**
   * Read, unread, star, unstar. For threads: read marks every message read, unread the latest one not from you, star
   * the latest (unless one is starred already), unstar every starred one. For messages: those.
   */
  flag(req: P.MailFlagRequest): P.MailOpResult {
    const k: FlagKey | null = typeof req.seen === 'boolean' ? 'seen' : typeof req.flagged === 'boolean' ? 'flagged' : null;
    if (!k || (typeof req.seen === 'boolean' && typeof req.flagged === 'boolean')) throw new MailCallError('one of seen and flagged', 400);
    const v: Bit = (k === 'seen' ? req.seen : req.flagged) ? 1 : 0;
    const groups = this.targets(req.threadIds, req.messageIds);
    const picked = new Map<string, Row[]>();
    for (const [accountId, g] of groups) {
      const acc = this.checkAccount(accountId, k === 'seen' ? 'read' : 'write');
      this.checkWrite(acc, k, k === 'seen' ? (v ? 'read' : 'unread') : v ? 'star' : 'unstar');
      const out: Row[] = [];
      for (const ms of g.threads.values()) {
        const mine = (m: Row) => m.addressed === 'self';
        if (k === 'seen' && v === 1) out.push(...ms.filter((m) => this.flagOf(m, 'seen') === 0));
        else if (k === 'seen') out.push([...ms].reverse().find((m) => !mine(m)) ?? ms[ms.length - 1]);
        else if (v === 1) {
          if (!ms.some((m) => this.flagOf(m, 'flagged'))) out.push(ms[ms.length - 1]);
        } else out.push(...ms.filter((m) => this.flagOf(m, 'flagged')));
      }
      out.push(...g.messages);
      picked.set(acc.id, out);
    }
    let threads = 0;
    let messages = 0;
    for (const [accountId, ms] of picked) {
      const r = this.applyFlag(accountId, ms, k, v);
      threads += r.threads;
      messages += r.messages;
    }
    return { ok: true, threads, messages };
  }

  /** Archive, back to Inbox, trash, junk, or a mailbox of the same account. */
  move(req: P.MailMoveRequest): P.MailOpResult {
    if (typeof req.to !== 'string' || !req.to) throw new MailCallError('to: a mailbox, or archive, inbox, trash or junk', 400);
    const groups = this.targets(req.threadIds, req.messageIds);
    const plans: { accountId: string; dest: Row; action: MailAction; ms: Row[] }[] = [];
    // Every account is checked before anything changes.
    for (const [accountId, g] of groups) {
      const acc = this.checkAccount(accountId, 'write');
      const dest = this.destination(acc, req.to);
      const action: MailAction = req.to in ROLE_NAMES ? (req.to as MailAction) : 'move';
      this.checkWrite(acc, moveKind(dest), action);
      plans.push({ accountId, dest, action, ms: [...[...g.threads.values()].flat(), ...g.messages] });
    }
    let threads = 0;
    let messages = 0;
    for (const p of plans) {
      const r = this.applyMove(p.accountId, p.ms, p.dest, p.action);
      threads += r.threads;
      messages += r.messages;
    }
    return { ok: true, threads, messages };
  }

  /**
   * The page read these threads (a second in view): read on the server too, unless you mark it yourself, or the
   * account does not mark mail read from here (a 501, or its status's writes leave out `seen`): then only here.
   */
  readInView(threadIds: string[]) {
    if (this.settings().markRead !== 'view' || !threadIds.length) return;
    const groups = this.targets(threadIds, []);
    for (const [accountId, g] of groups) {
      const a = this.hub.store.account(accountId);
      if (!a || a.level !== 'write' || a.gone_at || this.refusal(a, 'seen')) continue;
      const ms = [...g.threads.values()].flat().filter((m) => this.flagOf(m, 'seen') === 0);
      if (ms.length) this.applyFlag(accountId, ms, 'seen', 1);
    }
  }

  // ---------------------------------------------------------- inside: choosing

  /** The messages asked for, by account: whole threads (oldest first), and single messages. */
  private targets(threadIds: string[] = [], messageIds: string[] = []): Map<string, { threads: Map<string, Row[]>; messages: Row[] }> {
    if (!threadIds.length && !messageIds.length) throw new MailCallError('threadIds or messageIds', 400);
    const cols = 'id, account_id, thread_id, seen, flagged, seen_local, pending, addressed, received_at';
    const out = new Map<string, { threads: Map<string, Row[]>; messages: Row[] }>();
    const group = (a: string) => out.get(a) ?? out.set(a, { threads: new Map(), messages: [] }).get(a)!;
    for (const m of this.all(`SELECT ${cols} FROM mail_message WHERE thread_id IN (SELECT value FROM json_each(?)) ORDER BY received_at, id`, JSON.stringify(threadIds))) {
      const g = group(m.account_id).threads;
      g.set(m.thread_id, [...(g.get(m.thread_id) ?? []), m]);
    }
    for (const m of this.all(`SELECT ${cols} FROM mail_message WHERE id IN (SELECT value FROM json_each(?)) ORDER BY received_at, id`, JSON.stringify(messageIds))) {
      if (!out.get(m.account_id)?.threads.has(m.thread_id)) group(m.account_id).messages.push(m);
    }
    if (!out.size) throw new MailCallError(threadIds.length ? 'no such thread' : 'no such message', 404);
    return out;
  }

  /** May this account take the change? `need`: read is enough for marking read (here only, with a read grant). */
  private checkAccount(accountId: string, need: 'read' | 'write'): Row {
    const a = this.hub.store.account(accountId);
    if (!a) throw new MailCallError('no such mail account', 404);
    if (!a.level || a.gone_at) throw new MailCallError('dither-chat no longer has access to this account', 410);
    if (need === 'write' && a.level !== 'write') throw new MailCallError('dither-accounts lets dither-chat read this account, not change it', 403);
    return a;
  }

  /** Does the account make this kind of write? Refused at once (501) when it does not, before anything changes. */
  private checkWrite(acc: Row, kind: MailWriteKind, action: MailAction) {
    if (acc.level !== 'write') return;
    const why = this.refusal(acc, kind, action);
    if (why) throw new MailCallError(why, 501);
  }

  /**
   * Why the account would refuse this kind of write, or null: its status lists the writes it makes and this is not
   * one, or it answered 501 to it before (mail_unsupported). Before kinds were told apart a move into the trash or
   * junk was refused as `move`; while the status says nothing of writes, such a row still holds for them.
   */
  private refusal(acc: Row, kind: MailWriteKind, action?: MailAction): string | null {
    const writes = this.hub.store.writes(acc.id);
    if (writes && !writes.includes(kind)) return this.notWritten(acc, kind, action);
    const ops = [unsupportedOp(kind), ...(!writes && (kind === 'trash' || kind === 'junk') ? ['move'] : [])];
    const u = this.one<{ why: string | null }>('SELECT why FROM mail_unsupported WHERE account_id = ? AND op IN (SELECT value FROM json_each(?)) LIMIT 1', acc.id, JSON.stringify(ops));
    return u ? (u.why ?? `${acc.label} does not support this`) : null;
  }

  /** A write the account's status does not list, in a sentence: "Gmail can't archive from here yet". */
  private notWritten(acc: Row, kind: MailWriteKind, action?: MailAction): string {
    const what =
      kind === 'seen'
        ? 'mark mail read or unread'
        : kind === 'flagged'
          ? 'star mail'
          : kind === 'trash'
            ? 'move mail to the trash'
            : kind === 'junk'
              ? 'mark mail as junk'
              : action === 'archive'
                ? 'archive'
                : action === 'inbox'
                  ? 'move mail back to Inbox'
                  : 'move mail into folders or labels';
    return `${acc.provider ?? (acc.kind === 'google' ? 'Gmail' : 'This account')} can't ${what} from here yet`;
  }

  /** Where `to` is in this account. Archive is All mail where there is no Archive (Gmail: out of Inbox). */
  private destination(acc: Row, to: string): Row {
    let b: Row | null;
    if (to === 'archive') b = this.one(`SELECT * FROM mailbox WHERE account_id = ? AND role = 'archive'`, acc.id) ?? this.one(`SELECT * FROM mailbox WHERE account_id = ? AND role = 'all'`, acc.id);
    else if (to in ROLE_NAMES) b = this.one('SELECT * FROM mailbox WHERE account_id = ? AND role = ?', acc.id, to);
    else {
      b = this.hub.store.mailbox(to);
      if (b && b.account_id !== acc.id) throw new MailCallError('that mailbox is in another account', 400);
      if (!b) throw new MailCallError('no such mailbox', 404);
    }
    if (!b) throw new MailCallError(`${acc.address ?? acc.label} has no ${ROLE_NAMES[to]} mailbox`, 409);
    return b;
  }

  /** A flag as it shows here: the change waiting, else the server's. */
  private flagOf(m: Row, k: FlagKey): Bit {
    const p = json<Pending>(m.pending, {});
    return (p[k]?.v ?? m[k]) ? 1 : 0;
  }

  /** The message's locations on the server, with their mailboxes' roles. */
  private locations(messageId: string): { mailbox_id: string; native_id: string; role: string | null }[] {
    return this.all('SELECT l.mailbox_id, l.native_id, b.role FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = ?', messageId);
  }

  /**
   * The mailboxes a move takes the message out of, from where the server has it: empty when it is where it should be
   * already (then a move waiting for it is called off). Archive leaves Inbox; the others leave every folder, and what
   * you sent stays. `byId`: the account's ids are the message's (store.ts idPerMessage).
   */
  private leaves(m: Row, dest: Row, action: MailAction, gmail: boolean, byId: boolean): string[] {
    const locs = this.locations(m.id);
    if (!locs.length || locs.every((l) => STAYS.has(l.role ?? ''))) return [];
    if (action === 'archive') return locs.filter((l) => l.role === 'inbox').map((l) => l.mailbox_id);
    // On Gmail, what you sent is one message in Sent and All Mail at once, and moving it to the trash takes it out of
    // Sent too (over IMAP by either copy, on the web by its one id): it stays where it is.
    if (gmail && (action === 'trash' || action === 'junk') && locs.some((l) => STAYS.has(l.role ?? ''))) return [];
    if (action === 'trash' || action === 'junk') return locs.filter((l) => !STAYS.has(l.role ?? '') && l.mailbox_id !== dest.id).map((l) => l.mailbox_id);
    // Into Inbox or a folder: out of the folders it is in, unless it is there already. Gmail on the web's mail.move
    // names no mailbox it comes from, so it takes off Inbox (and Trash and Spam) and leaves the labels it has: they
    // are not folders it leaves here either.
    if (locs.some((l) => l.mailbox_id === dest.id)) return [];
    const folders = locs.filter((l) => l.mailbox_id !== dest.id && !NOT_FOLDER.has(l.role ?? '') && !(gmail && byId && !l.role)).map((l) => l.mailbox_id);
    if (folders.length) return folders;
    // Only in All mail: where ids are the message's (Proton), it moves from there by its id. Gmail keeps it in All Mail
    // and only puts the label on (copyFrom; over IMAP a MOVE out of All Mail would delete it, so the extractor copies),
    // and another IMAP server's All mail is never emptied from here.
    return byId && !gmail ? locs.filter((l) => l.role === 'all').map((l) => l.mailbox_id) : [];
  }

  /**
   * Gmail: the All Mail a move leaves it in while the destination's label goes on, or null. Over IMAP dither-accounts
   * COPYs out of All Mail into anything but Trash or Spam (a MOVE out of it would delete it on Gmail); on the web its
   * one id gets the label. Either way the rest of its labels stay. Into Inbox it is always this, so its labels stay
   * (and an archive that went is undone as it was); into a label, when it is in no folder to move it from (only in All
   * Mail). What you sent stays where it is.
   */
  private copyFrom(m: Row, dest: Row, action: MailAction): string | null {
    if ((action !== 'inbox' && action !== 'move') || NOT_FOLDER.has(dest.role ?? '')) return null;
    const locs = this.locations(m.id);
    if (locs.some((l) => l.mailbox_id === dest.id || STAYS.has(l.role ?? ''))) return null;
    return locs.find((l) => l.role === 'all')?.mailbox_id ?? null;
  }

  // ---------------------------------------------------------- inside: applying

  private applyFlag(accountId: string, ms: Row[], k: FlagKey, v: Bit): { threads: number; messages: number } {
    const acc = this.hub.store.account(accountId)!;
    const touched = new Set<string>();
    const local = acc.level !== 'write';
    let queued = 0;
    this.db.transaction(() => {
      if (local) {
        // A read grant: read state here only.
        for (const m of ms) {
          if (k !== 'seen') continue;
          if (this.run('UPDATE mail_message SET seen_local = ? WHERE id = ? AND seen_local != ?', v, m.id, v).changes) touched.add(m.thread_id);
        }
        return;
      }
      const todo: Row[] = [];
      for (const m of ms) {
        const p = json<Pending>(m.pending, {});
        // Unread here, though the server never had it read: nothing to tell it.
        if (k === 'seen' && v === 0 && m.seen_local && !p.seen && !m.seen) {
          this.run('UPDATE mail_message SET seen_local = 0 WHERE id = ?', m.id);
          touched.add(m.thread_id);
          continue;
        }
        if (!p[k] && (m[k] ? 1 : 0) === v) {
          if (k === 'seen' && v === 0 && m.seen_local) {
            this.run('UPDATE mail_message SET seen_local = 0 WHERE id = ?', m.id);
            touched.add(m.thread_id);
          }
          continue;
        }
        todo.push(m);
      }
      const ops = this.enqueue(accountId, 'flag', { [k]: v }, todo.map((m) => m.id));
      for (const m of todo) {
        const p = json<Pending>(m.pending, {});
        p[k] = { v, was: p[k]?.was ?? (m[k] ? 1 : 0), op: ops.get(m.id)! };
        this.run(`UPDATE mail_message SET ${k} = ?, pending = ?${k === 'seen' && v === 0 ? ', seen_local = 0' : ''} WHERE id = ?`, v, JSON.stringify(p), m.id);
        touched.add(m.thread_id);
      }
      queued = todo.length;
    })();
    this.settled(accountId, touched, k === 'seen' ? (v ? 'read' : 'unread') : v ? 'star' : 'unstar');
    if (queued) this.kick(this.coalesceMs);
    return { threads: touched.size, messages: queued };
  }

  private applyMove(accountId: string, ms: Row[], dest: Row, action: MailAction): { threads: number; messages: number } {
    const gmail = this.hub.store.gmail(accountId);
    const byId = this.hub.store.idPerMessage(accountId);
    const touched = new Set<string>();
    let queued = 0;
    this.db.transaction(() => {
      const todo: { m: Row; hide: string[]; copy: string | null }[] = [];
      for (const m of ms) {
        const p = json<Pending>(m.pending, {});
        const left = this.leaves(m, dest, action, gmail, byId);
        const copy = gmail && (action === 'inbox' || !left.length) ? this.copyFrom(m, dest, action) : null;
        const hide = copy ? [] : left;
        if (hide.length || copy) todo.push({ m, hide, copy });
        else if (p.move) {
          // Already where it should be on the server: the move waiting for it is called off.
          delete p.move;
          this.run('UPDATE mail_message SET pending = ? WHERE id = ?', Object.keys(p).length ? JSON.stringify(p) : null, m.id);
          touched.add(m.thread_id);
        }
      }
      // Gmail over IMAP: held for the page's Undo (gmailArchiveHoldMs).
      const hold = gmail && !byId && action === 'archive' ? Math.max(this.coalesceMs, this.gmailArchiveHoldMs) : this.coalesceMs;
      const ops = this.enqueue(accountId, 'move', { to: dest.id }, todo.map((x) => x.m.id), hold);
      for (const { m, hide, copy } of todo) {
        const p = json<Pending>(m.pending, {});
        p.move = { to: dest.id, hide, op: ops.get(m.id)!, ...(copy ? { copy } : {}) };
        this.run('UPDATE mail_message SET pending = ? WHERE id = ?', JSON.stringify(p), m.id);
        touched.add(m.thread_id);
      }
      queued = todo.length;
    })();
    this.settled(accountId, touched, action);
    if (queued) this.kick(this.coalesceMs);
    return { threads: touched.size, messages: queued };
  }

  /** Threads changed here: their rows again, the account's count, and `filed`. */
  private settled(accountId: string, touched: Set<string>, action: MailAction, undone = false) {
    if (!touched.size) return;
    this.db.transaction(() => {
      for (const t of touched) this.hub.store.recompute(t);
    })();
    this.hub.store.dirty.accounts.add(accountId);
    this.hub.emit('filed', { accountId, threadIds: [...touched], action, ...(undone ? { undone } : {}) });
  }

  /**
   * Into mail_op: each message joins a call not sent yet for the same account, op and value, while it has room for
   * 1000; the rest start new ones. Returns each message's op.
   */
  private enqueue(accountId: string, op: 'flag' | 'move', args: Record<string, unknown>, mids: string[], holdMs = this.coalesceMs): Map<string, string> {
    const out = new Map<string, string>();
    if (!mids.length) return out;
    const key = JSON.stringify(args);
    const open = this.all('SELECT id, message_ids FROM mail_op WHERE account_id = ? AND op = ? AND args = ? AND sent_at IS NULL AND attempts = 0 ORDER BY created_at, rowid', accountId, op, key).map((r) => ({
      id: r.id as string,
      ids: json<string[]>(r.message_ids, []),
      dirty: false,
    }));
    for (const r of open) for (const id of r.ids) out.set(id, r.id);
    const rest = mids.filter((id) => !out.has(id));
    const now = this.now();
    for (const id of rest) {
      let r = open.find((x) => x.ids.length < MAX_IDS);
      if (!r) {
        r = { id: `mop_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`, ids: [], dirty: true };
        this.run('INSERT INTO mail_op (id, account_id, op, args, message_ids, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', r.id, accountId, op, key, '[]', now + holdMs, now);
        open.push(r);
      }
      r.ids.push(id);
      r.dirty = true;
      out.set(id, r.id);
    }
    for (const r of open) if (r.dirty) this.run('UPDATE mail_op SET message_ids = ? WHERE id = ?', JSON.stringify(r.ids), r.id);
    return new Map(mids.map((id) => [id, out.get(id)!]));
  }

  // ---------------------------------------------------------- inside: sending

  /** Sends what is due, on accounts that can take it; looks again later for the rest. */
  async pump(): Promise<void> {
    const now = this.now();
    const rows = this.all<{ account_id: string; next: number }>('SELECT account_id, MIN(next_at) AS next FROM mail_op WHERE sent_at IS NULL GROUP BY account_id');
    let later = Infinity;
    const runs: Promise<void>[] = [];
    for (const r of rows) {
      if (this.busy.has(r.account_id)) continue;
      if (r.next > now) later = Math.min(later, r.next - now);
      else if (!this.workable(r.account_id)) later = Math.min(later, this.pollMs);
      else runs.push(this.runAccount(r.account_id));
    }
    if (later < Infinity) this.kick(later);
    await Promise.all(runs);
  }

  /** Resolves once nothing is out and nothing waiting could go within a second (tests and scripts). */
  async idle(ms = 5000): Promise<void> {
    const end = this.now() + ms;
    while (this.now() < end) {
      await this.pump();
      const soon = this.now() + 1000;
      const left = this.all<{ account_id: string; next_at: number }>('SELECT account_id, next_at FROM mail_op');
      if (!this.busy.size && left.every((r) => r.next_at > soon || !this.workable(r.account_id))) return;
      await sleep(this.hub.clock, 10);
    }
  }

  private kick(ms: number) {
    const at = this.now() + ms;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) this.hub.clock.clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = this.hub.clock.setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.pump().catch((e) => {
        // A hub whose database closed under it (its tests) has nothing left to send.
        if (!/closed database/.test(String((e as Error)?.message))) {
          console.warn(`mail: ops: ${(e as Error)?.message ?? e}`);
          jobFailed('mail: ops', e);
        }
      });
    }, Math.max(0, ms));
    unref(this.timer);
  }

  private workable(accountId: string): boolean {
    const a = this.hub.store.account(accountId);
    return !!this.hub.backend?.connected && !!a?.online && a.level === 'write' && !a.gone_at && !!this.hub.sync(accountId);
  }

  private async runAccount(accountId: string) {
    this.busy.add(accountId);
    try {
      const sync = this.hub.sync(accountId)!;
      if (this.catchUpFirst.delete(accountId)) await sync.catchUp().catch(() => {});
      for (;;) {
        if (!this.workable(accountId)) break;
        const op = this.one('SELECT * FROM mail_op WHERE account_id = ? AND sent_at IS NULL AND next_at <= ? ORDER BY created_at, rowid LIMIT 1', accountId, this.now());
        if (!op) break;
        const wait = (this.lastCall.get(accountId) ?? 0) + GAP_MS - this.now();
        if (wait > 0) await sleep(this.hub.clock, wait);
        await this.send(op, sync);
      }
    } finally {
      this.busy.delete(accountId);
      this.kick(0);
    }
  }

  private async send(op: Row, sync: AccountSync) {
    const args = json<Record<string, any>>(op.args, {});
    const k: FlagKey = 'seen' in args ? 'seen' : 'flagged';
    const dest = op.op === 'move' ? this.hub.store.mailbox(args.to) : null;
    if (op.op === 'move' && !dest) return this.undo(op, 'that mailbox is gone');
    // A status since it was made says the account does not make this write: undone, with no call.
    const kind = this.writeKind(op);
    const writes = this.hub.store.writes(op.account_id);
    if (writes && !writes.includes(kind)) return this.undo(op, this.notWritten(this.hub.store.account(op.account_id) ?? {}, kind, this.actionOf(op)));
    const items: Item[] = [];
    const nothing: string[] = [];
    // Out of Gmail's All Mail into anything but Trash or Spam it stays there: dither-accounts' imap extractor copies
    // (imap.ts copiesInstead), Gmail on the web only adds the label. Either way its place in All Mail is kept.
    const copies = op.op === 'move' && dest!.role !== 'trash' && dest!.role !== 'junk' && this.hub.store.gmail(op.account_id);
    for (const mid of json<string[]>(op.message_ids, [])) {
      const m = this.one<{ pending: string | null; native_thread: string | null }>('SELECT pending, native_thread FROM mail_message WHERE id = ?', mid);
      const p = json<Pending>(m?.pending, {});
      const thread = m?.native_thread ?? null;
      if (op.op === 'flag') {
        if (p[k]?.op !== op.id) continue;
        const at = this.hub.store.nativeOf(mid);
        if (at) items.push({ mid, native: at.id, from: '', thread });
        else nothing.push(mid);
      } else {
        const mv = p.move;
        if (!mv || mv.op !== op.id) continue;
        const locs = this.locations(mid);
        // A copy: from All Mail, unless it is in the destination already (then there is nothing left to do).
        const from = mv.copy
          ? locs.find((l) => l.mailbox_id === mv.copy && !locs.some((x) => x.mailbox_id === dest!.id))
          : locs.filter((l) => l.mailbox_id !== dest!.id && mv.hide.includes(l.mailbox_id)).sort((a, b) => Number(NOT_FOLDER.has(a.role ?? '')) - Number(NOT_FOLDER.has(b.role ?? '')))[0];
        if (from) items.push({ mid, native: from.native_id, from: from.mailbox_id, copy: copies && from.role === 'all', thread });
        else nothing.push(mid);
      }
    }
    // Nowhere left to change it (gone, or moved where it was going): its change is over.
    if (nothing.length) this.forget(op.account_id, nothing, op.id);
    if (!items.length) {
      this.run('DELETE FROM mail_op WHERE id = ?', op.id);
      return;
    }
    this.run('UPDATE mail_op SET sent_at = ? WHERE id = ?', this.now(), op.id);
    this.lastCall.set(op.account_id, this.now());
    // Each id's thread beside it, for an extractor that changes mail by thread (the google kind); the others ignore it.
    const ids = { ids: items.map((i) => i.native), threadIds: items.map((i) => i.thread) };
    const input = op.op === 'flag' ? { ...ids, [k]: !!args[k] } : { ...ids, mailboxId: dest!.native_id };
    let res: unknown;
    try {
      res = await sync.queue.run(P0, null, () => this.hub.backend!.call(op.account_id, `mail.${op.op}`, input));
    } catch (e) {
      return this.failed(op, asMailError(e), sync);
    }
    // A dry run grant: the manager answered without reaching the account, so nothing changed there.
    if ((res as { dryRun?: boolean } | null)?.dryRun === true) return this.undo(op, 'a dry run: nothing reaches the account');
    this.acked(op, items, dest, res, sync);
  }

  private acked(op: Row, items: Item[], dest: Row | null, res: unknown, sync: AccountSync) {
    const touched = new Set<string>();
    const moved: string[] = [];
    let lost = false;
    const answer = (res ?? {}) as { ids?: (string | null)[]; refused?: unknown; unknown?: unknown };
    const newIds = answer.ids;
    // Part of it: what the server turned down (refused) or could not find (unknown) did not change, so it is undone
    // here; the rest stands. A move's null for one of these means it stayed where it was.
    const refused = idSet(answer.refused);
    const unknown = idSet(answer.unknown);
    const listed = (it: Item) => refused.has(it.native) || unknown.has(it.native);
    const back = items.filter(listed);
    if (back.length) this.revert(op.account_id, back.map((it) => it.mid), op.id, this.actionOf(op));
    // Gmail shows a message in Trash or Spam there alone, over IMAP and on the web: All Mail and its labels lost it with
    // this move.
    const alone = !!dest && (dest.role === 'trash' || dest.role === 'junk') && this.hub.store.gmail(op.account_id);
    this.db.transaction(() => {
      items.forEach((it, i) => {
        if (listed(it)) return;
        const m = this.one('SELECT thread_id, pending FROM mail_message WHERE id = ?', it.mid);
        if (!m) return;
        const p = json<Pending>(m.pending, {});
        if (op.op === 'flag') {
          for (const k of ['seen', 'flagged'] as const) if (p[k]?.op === op.id) delete p[k];
        } else {
          if (p.move?.op === op.id) delete p.move;
          const nid = Array.isArray(newIds) ? newIds[i] : null;
          if (nid) {
            // A copy (Gmail, out of All Mail) leaves it where it was.
            if (!it.copy) this.run('DELETE FROM mail_location WHERE mailbox_id = ? AND native_id = ?', it.from, it.native);
            this.run(
              'INSERT INTO mail_location (mailbox_id, native_id, message_id, seen_gen) VALUES (?, ?, ?, ?) ON CONFLICT (mailbox_id, native_id) DO UPDATE SET message_id = excluded.message_id',
              dest!.id,
              nid,
              it.mid,
              dest!.relist_gen ?? 0,
            );
            if (alone) this.run('DELETE FROM mail_location WHERE message_id = ? AND mailbox_id != ?', it.mid, dest!.id);
          } else lost = true;
          moved.push(it.mid);
        }
        this.run('UPDATE mail_message SET pending = ? WHERE id = ?', Object.keys(p).length ? JSON.stringify(p) : null, it.mid);
        touched.add(m.thread_id);
      });
      for (const t of touched) this.hub.store.recompute(t);
      this.run('DELETE FROM mail_op WHERE id = ?', op.id);
    })();
    if (back.length) this.errors.set(op.account_id, { message: `${this.describe(op, back.length)}: ${this.partly(op.account_id, back, refused)}`, at: this.now() });
    else this.errors.delete(op.account_id);
    this.hub.store.dirty.accounts.add(op.account_id);
    this.sweep(op.account_id, moved);
    // The server would not say where they went, or could not find some (the hub's ids may be stale): the next changes
    // pass finds them.
    if (lost || unknown.size) void sync.catchUp();
  }

  /** Why part of a write did not happen, in a sentence: "Gmail turned them down", "the server turned 2 down and could not find 1". */
  private partly(accountId: string, back: Item[], refused: Set<string>): string {
    const a = this.hub.store.account(accountId);
    const who = a?.provider ?? (a?.kind === 'google' ? 'Gmail' : 'the server');
    const r = back.filter((it) => refused.has(it.native)).length;
    const u = back.length - r;
    const them = back.length === 1 ? 'it' : 'them';
    if (!u) return `${who} turned ${them} down`;
    if (!r) return `${who} could not find ${them}`;
    return `${who} turned ${r} down and could not find ${u}`;
  }

  private failed(op: Row, e: MailCallError, sync: AccountSync) {
    const s = e.status;
    if (s === 404) {
      this.undo(op, e.message);
      void sync.catchUp();
    } else if (s === 403) {
      this.dropAccount(op.account_id, e.message);
      if (this.run(`UPDATE mail_account SET level = 'read' WHERE id = ? AND level = 'write'`, op.account_id).changes) this.hub.store.dirty.accounts.add(op.account_id);
    } else if (s === 501) {
      this.run('INSERT OR REPLACE INTO mail_unsupported (account_id, op, why, at) VALUES (?, ?, ?, ?)', op.account_id, this.kindOf(op), e.message, this.now());
      this.undo(op, e.message);
    } else if (s === 400 || s === 422) {
      this.undo(op, e.message);
    } else {
      const attempts = (op.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) return this.undo(op, e.message);
      // 410: the mailbox was rebuilt; the catch-up lists it again and the ids are looked up anew.
      if (s === 410) void sync.catchUp();
      const backoff = Math.min(300_000, 2_000 * 2 ** (attempts - 1));
      this.run('UPDATE mail_op SET sent_at = NULL, attempts = ?, error = ?, next_at = ? WHERE id = ?', attempts, e.message, this.now() + backoff, op.id);
      this.hub.store.dirty.accounts.add(op.account_id);
    }
  }

  /** The op's kind of write (`details.writes`): a move into the trash is `trash`, into junk `junk`. */
  private writeKind(op: Row): MailWriteKind {
    const args = json<Row>(op.args, {});
    return op.op === 'flag' ? ('seen' in args ? 'seen' : 'flagged') : moveKind(this.hub.store.mailbox(args.to));
  }

  /** What mail_unsupported keeps an op's 501 as: `flag.seen`, `flag.flagged`, `move`, `trash` or `junk`. */
  private kindOf(op: Row): string {
    return unsupportedOp(this.writeKind(op));
  }

  /** What the op was, for its error line: "Could not archive 3 messages". `count`: of its messages, when only some. */
  private describe(op: Row, count?: number): string {
    const args = json<Record<string, any>>(op.args, {});
    const n = count ?? json<string[]>(op.message_ids, []).length;
    const what = n === 1 ? 'a message' : `${n} messages`;
    if (op.op === 'flag') return 'seen' in args ? `Could not mark ${what} ${args.seen ? 'read' : 'unread'}` : `Could not ${args.flagged ? 'star' : 'unstar'} ${what}`;
    const b = this.hub.store.mailbox(args.to);
    if (b?.role === 'trash') return `Could not move ${what} to the trash`;
    if (b?.role === 'junk') return `Could not mark ${what} as junk`;
    if (b?.role === 'archive' || b?.role === 'all') return `Could not archive ${what}`;
    return `Could not move ${what} to ${b?.name ?? 'that mailbox'}`;
  }

  // ---------------------------------------------------------- inside: undoing

  /** The server refused it: the messages show what the server has again. */
  private undo(op: Row, why: string | null) {
    if (why) this.errors.set(op.account_id, { message: `${this.describe(op)}: ${why}`, at: this.now() });
    const ids = json<string[]>(op.message_ids, []);
    this.revert(op.account_id, ids, op.id, this.actionOf(op));
    this.run('DELETE FROM mail_op WHERE id = ?', op.id);
    this.hub.store.dirty.accounts.add(op.account_id);
  }

  /** Every change waiting for an account, undone: its access ended, narrowed, or the manager said no (403). */
  private dropAccount(accountId: string, why: string) {
    const ops = this.all('SELECT * FROM mail_op WHERE account_id = ?', accountId);
    if (!ops.length) return;
    for (const op of ops) this.undo(op, null);
    this.errors.set(accountId, { message: `${ops.length === 1 ? 'A change' : `${ops.length} changes`} could not be made: ${why}`, at: this.now() });
  }

  private actionOf(op: Row): MailAction {
    const args = json<Record<string, any>>(op.args, {});
    if (op.op === 'flag') return 'seen' in args ? (args.seen ? 'read' : 'unread') : args.flagged ? 'star' : 'unstar';
    const role = this.hub.store.mailbox(args.to)?.role;
    return role === 'all' ? 'archive' : role && role in ROLE_NAMES ? (role as MailAction) : 'move';
  }

  /** `op`'s changes on these messages, back to what the server had. */
  private revert(accountId: string, ids: string[], opId: string, action: MailAction) {
    const touched = new Set<string>();
    const moved: string[] = [];
    this.db.transaction(() => {
      for (const mid of ids) {
        const m = this.one('SELECT thread_id, pending FROM mail_message WHERE id = ?', mid);
        if (!m?.pending) continue;
        const p = json<Pending>(m.pending, {});
        const set: string[] = [];
        const args: unknown[] = [];
        for (const k of ['seen', 'flagged'] as const) {
          if (p[k]?.op !== opId) continue;
          set.push(`${k} = ?`);
          args.push(p[k]!.was);
          delete p[k];
        }
        if (p.move?.op === opId) {
          delete p.move;
          moved.push(mid);
        }
        if (!set.length && !moved.includes(mid)) continue;
        set.push('pending = ?');
        args.push(Object.keys(p).length ? JSON.stringify(p) : null);
        this.run(`UPDATE mail_message SET ${set.join(', ')} WHERE id = ?`, ...args, mid);
        touched.add(m.thread_id);
      }
    })();
    this.settled(accountId, touched, action, true);
    this.sweep(accountId, moved);
  }

  /** Changes on messages there is nothing left to send for: their pending entries for `opId` go, values kept. */
  private forget(accountId: string, ids: string[], opId: string) {
    const touched = new Set<string>();
    this.db.transaction(() => {
      for (const mid of ids) {
        const m = this.one('SELECT thread_id, pending FROM mail_message WHERE id = ?', mid);
        if (!m?.pending) continue;
        const p = json<Pending>(m.pending, {});
        for (const k of ['seen', 'flagged', 'move'] as const) if (p[k]?.op === opId) delete p[k];
        this.run('UPDATE mail_message SET pending = ? WHERE id = ?', Object.keys(p).length ? JSON.stringify(p) : null, mid);
        touched.add(m.thread_id);
      }
      for (const t of touched) this.hub.store.recompute(t);
    })();
    this.hub.store.dirty.accounts.add(accountId);
    this.sweep(accountId, ids);
  }

  /** Messages a move of ours was keeping (store.ts deleteOrphans waits for it) that are nowhere now. */
  private sweep(accountId: string, ids: string[]) {
    if (!ids.length) return;
    const gone = this.hub.store.deleteOrphans(ids);
    if (gone.length) this.hub.emit('deleted', { accountId, messageIds: gone });
  }
}

// ------------------------------------------------------------------ routes

const ok = (x: unknown) => Response.json(x);

const ids = (x: unknown, what: string): string[] | undefined => {
  if (x === undefined || x === null) return undefined;
  if (!Array.isArray(x) || x.length > 10_000 || x.some((v) => typeof v !== 'string')) throw new MailCallError(`${what}: a list of ids`, 400);
  return x as string[];
};
const bool = (x: unknown, what: string): boolean | undefined => {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== 'boolean') throw new MailCallError(`${what}: true or false`, 400);
  return x;
};

/** Slice 4: flags, moves and the read setting. */
export const opsRoutes: MailRouter = (hub) => {
  const ops = new MailOps(hub);
  return [
    {
      method: 'POST',
      path: /^\/api\/mail\/flag$/,
      handle: async (r) => {
        const b = await r.body<P.MailFlagRequest>();
        const req: P.MailFlagRequest = { threadIds: ids(b.threadIds, 'threadIds'), messageIds: ids(b.messageIds, 'messageIds'), seen: bool(b.seen, 'seen'), flagged: bool(b.flagged, 'flagged') };
        return ok(ops.once(b.clientId, () => ops.flag(req)) satisfies P.MailOpResult);
      },
    },
    {
      method: 'POST',
      path: /^\/api\/mail\/move$/,
      handle: async (r) => {
        const b = await r.body<P.MailMoveRequest>();
        const req: P.MailMoveRequest = { threadIds: ids(b.threadIds, 'threadIds'), messageIds: ids(b.messageIds, 'messageIds'), to: b.to };
        return ok(ops.once(b.clientId, () => ops.move(req)) satisfies P.MailOpResult);
      },
    },
    { method: 'GET', path: /^\/api\/mail\/settings$/, handle: () => ok(ops.settings() satisfies P.MailSettings) },
    {
      method: 'PUT',
      path: /^\/api\/mail\/settings$/,
      handle: async (r) => ok(ops.setSettings(await r.body<Partial<P.MailSettings>>()) satisfies P.MailSettings),
    },
  ];
};
