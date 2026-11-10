/**
 * Sending mail (docs/mail.md, docs/mail-design.md §8): the hub's outbox and drafts.
 *
 * `POST /api/mail/send` checks the message and keeps it (once per `clientId`), `held` for MAIL_LIMITS.holdMs (10 s),
 * when Undo puts it back in the drafts. Then it is `queued`: its files are copied out of the uploads into the outbox's
 * folder (an upload left an hour goes), and it goes to `mail.send` ahead of background work. The answers:
 *
 *   success           `sent`, with the Message-ID it went out with; Sent is asked what changed, so its copy shows
 *   dry run           `sent`, marked as a dry run: nothing reached the account
 *   503, limited      tried again later (2 s, doubling to 15 min), for up to a day
 *   timeout (504)     `failed`, "may have been sent": look in Sent before sending it again
 *   501               `failed`, and sending is off for the account with the extractor's words (Proton today)
 *   422 from          `failed`, "That From is not one of this account's addresses" (also with no code)
 *   422, other codes  `failed` with the extractor's sentence, each "recipient N" in it the address; sending stays on
 *   403, other        `failed` with why (a read grant; the extractor's words)
 *
 * Whatever fails goes back to the drafts, files and all: a failed send is never a lost message. A send the hub stopped
 * in the middle of may have gone, and says so.
 *
 * Drafts live here too (`mail_draft`): dither-accounts has no drafts op. Keys are `t:<thread>` for a reply or forward
 * and `new:<uuid>` for a new message.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import type * as M from '@dither-chat/protocol/mail-iface';
import { asMailError, MailCallError } from './backend.ts';
import { dedupe, forwardSubject, messageHtml, messageText, replyAllDiffers, replyFrom, replyRecipients, replySubject, tail, validEmail, type ComposeOriginal } from './compose.ts';
import type { MailHub } from './index.ts';
import { MAIL_LIMITS } from './limits.ts';
import { P0 } from './queue.ts';
import type { MailRouter } from './routes.ts';

type Row = Record<string, any>;

/** The hub's uploads (uploads.ts), as the outbox uses them. */
export interface MailFiles {
  get(ids: string[]): { path: string; name: string; mime: string; size: number }[] | null;
  put(bytes: Uint8Array, name: string, mime: string): P.UploadView;
  remove(ids: string[]): void;
}

export interface OutboxOpts {
  /** Where accepted files wait until they are sent (`<data>/mail-outbox`). Without it, no files. */
  dir?: string | null;
  holdMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

const MB = 1024 * 1024;
/** dither-accounts' limits: 25 MB a file; 35 MB together (imap), 25 MB (proton). */
export const FILE_CAP = 25 * MB;
const totalCap = (kind: string) => (kind === 'proton' ? 25 * MB : 35 * MB);
const maxRecipients = (kind: string) => (kind === 'proton' ? 100 : 500);
/** A sent item stays in the list this long. */
export const SHOW_SENT_MS = 10 * 60_000;
/** Waiting for the account is given up after this long. */
export const GIVE_UP_MS = 24 * 3_600_000;
export const RETRY_MS = [2_000, 5_000, 15_000, 60_000, 300_000, 900_000];

export const READ_ONLY = 'dither-accounts lets dither-chat read this account, not send from it.';
export const FROM_REFUSED = "That From is not one of this account's addresses.";
export const MAYBE_SENT = 'The account did not answer in time: it may have been sent. Look in Sent before sending it again.';
export const STOPPED_SENDING = 'The hub stopped while sending this: it may have been sent. Look in Sent before sending it again.';

const KINDS = new Set<P.MailComposeKind>(['new', 'reply', 'replyAll', 'forward']);
const DRAFT_KEY = /^(?:t:mth_[\w-]{4,40}|new:[\w-]{8,64})$/;
export const validDraftKey = (k: string) => DRAFT_KEY.test(k);

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const bad = (msg: string, status = 400) => new MailCallError(msg, status);
/** A message as one sentence: a capital first, one full stop at the end. */
const sentence = (msg: string) => {
  const m = msg.replace(/[.\s]+$/, '');
  return `${m[0]?.toUpperCase() ?? ''}${m.slice(1)}.`;
};

/**
 * An extractor's refusal (422) as one sentence, each "recipient N" in it replaced by that address: N counts To, then
 * Cc, then Bcc, an address once whatever its case, from 1. A number past the last stays as it was.
 */
export function recipientsRefused(msg: string, out: Partial<Pick<M.OutgoingMail, 'to' | 'cc' | 'bcc'>>): string {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const a of [...(out.to ?? []), ...(out.cc ?? []), ...(out.bcc ?? [])]) {
    const e = lc(a?.email);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    list.push(a.email.trim());
  }
  // A sentence first, so an address that now starts it keeps its case.
  return sentence(msg).replace(/\b[Rr]ecipient (\d+)\b/g, (all, n: string) => list[Number(n) - 1] ?? all);
}
/** A type the extractors take (`type/subtype`), else the generic one. */
const cleanMime = (m: unknown) => (typeof m === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(m) ? m : 'application/octet-stream');

/** Addresses as the page sent them: valid ones, each once; a bad one is refused by name. */
function cleanList(list: unknown, what: string): M.MailAddress[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad(`${what} is a list of addresses`);
  for (const a of list) {
    if (!a || typeof a !== 'object' || typeof a.email !== 'string' || !validEmail(a.email)) throw bad(`${what}: “${String(a?.email ?? a).slice(0, 80)}” is not an email address`);
    if (a.name != null && typeof a.name !== 'string') throw bad(`${what}: a name is text`);
  }
  return dedupe(list as M.MailAddress[]).map((a) => ({ name: a.name?.trim().slice(0, 200) || null, email: a.email }));
}

/** A draft as the page gave it, in its shape (lenient: it is your text being kept). */
export function cleanDraft(d: any): P.MailDraft {
  const addrs = (l: unknown) => (Array.isArray(l) ? l : []).filter((a: any) => a && typeof a.email === 'string').slice(0, 500).map((a: any) => ({ name: typeof a.name === 'string' ? a.name.slice(0, 200) : null, email: a.email.slice(0, 320) }));
  return {
    accountId: String(d?.accountId ?? ''),
    kind: KINDS.has(d?.kind) ? d.kind : 'new',
    replyTo: typeof d?.replyTo === 'string' ? d.replyTo : null,
    from: typeof d?.from === 'string' && d.from ? d.from : null,
    to: addrs(d?.to),
    cc: addrs(d?.cc),
    bcc: addrs(d?.bcc),
    subject: typeof d?.subject === 'string' ? d.subject.slice(0, 2000) : '',
    text: typeof d?.text === 'string' ? d.text.slice(0, 2 * MB) : '',
    quote: d?.quote !== false,
    files: (Array.isArray(d?.files) ? d.files : [])
      .filter((f: any) => f && typeof f.uploadId === 'string')
      .slice(0, 50)
      .map((f: any) => ({ uploadId: f.uploadId, name: String(f.name ?? 'file').slice(0, 255), mime: cleanMime(f.mime), size: Number(f.size) || 0 })),
    forwardParts: (Array.isArray(d?.forwardParts) ? d.forwardParts : [])
      .filter((f: any) => f && typeof f.messageId === 'string' && typeof f.attachmentId === 'string')
      .slice(0, 100)
      .map((f: any) => ({ messageId: f.messageId, attachmentId: f.attachmentId, name: typeof f.name === 'string' ? f.name : null, mime: cleanMime(f.mime), size: Number(f.size) || 0 })),
  };
}

export class MailOutbox {
  /** The hub's uploads: set by the server, which owns them. */
  files: MailFiles | null = null;
  /** Waits between tries while the account cannot be reached (tests make them short). */
  retryMs = RETRY_MS;
  private dirty = false;
  private timer: Timer | null = null;
  private running = new Set<string>();
  private started = false;
  private log: (msg: string) => void;

  constructor(
    private hub: MailHub,
    private opts: OutboxOpts = {},
  ) {
    this.log = opts.log ?? ((m) => console.warn(`mail: ${m}`));
  }

  private get store() {
    return this.hub.store;
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }
  private get holdMs() {
    return this.opts.holdMs ?? MAIL_LIMITS.holdMs;
  }
  private run(sql: string, ...args: any[]) {
    return this.store.db.query(sql).run(...args);
  }
  private row(id: string): Row | null {
    return this.store.one('SELECT * FROM mail_outbox WHERE id = ?', id);
  }

  start() {
    if (this.started) return;
    this.started = true;
    // Sends the hub stopped in the middle of: they may have gone.
    for (const r of this.store.all('SELECT * FROM mail_outbox WHERE state = ?', 'sending')) this.fail(r, STOPPED_SENDING, { unsure: true });
    this.hub.backend?.onConnection((up) => up && this.kick());
    this.hub.on('account', (e) => (e.state === 'deleted' ? this.forget(e.accountId) : this.kick()));
    this.pump();
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Queued sends try again now (the manager or the account came back). */
  kick() {
    this.run(`UPDATE mail_outbox SET next_at = NULL WHERE state = 'queued'`);
    this.pump();
  }

  // ---------------------------------------------------------- the account

  /** The addresses an account sends as (status.self.addresses), else the one it receives at. */
  fromChoices(acc: Row): { email: string; name: string | null }[] {
    const list = json<{ email: string; name: string | null }[]>(acc.addresses, []).filter((a) => a && typeof a.email === 'string');
    if (list.length) return list.map((a) => ({ email: a.email, name: a.name ?? null }));
    return acc.address ? [{ email: acc.address, name: acc.display_name ?? null }] : [];
  }

  /** Whether and why not the hub may send from it now. */
  private sendable(acc: Row | null): void {
    if (!acc) throw bad('no such mail account', 404);
    if (!acc.level || acc.gone_at) throw bad('dither-chat no longer has access to this account', 410);
    if (acc.level !== 'write') throw bad(READ_ONLY, 403);
    const send = json<{ ok: boolean | null; why: string | null }>(acc.send, { ok: null, why: null });
    if (send.ok === false) throw bad(`${acc.address ?? acc.label} can't send from here: ${send.why ?? 'sending is off'}`, 409);
  }

  /** Sending works again, or not (a 501 turns it off until you ask again). */
  private setSend(accountId: string, send: { ok: boolean | null; why: string | null; refused?: boolean }) {
    this.run('UPDATE mail_account SET send = ? WHERE id = ?', JSON.stringify({ ...send, at: this.now() }), accountId);
    this.store.dirty.accounts.add(accountId);
  }

  /** "Try again" after a 501: sending is offered again until the next refusal. */
  sendingAgain(accountId: string) {
    const acc = this.store.account(accountId);
    if (!acc) throw bad('no such mail account', 404);
    const send = json<{ ok: boolean | null; refused?: boolean }>(acc.send, { ok: null });
    if (send.ok === false && send.refused) this.setSend(accountId, { ok: null, why: null });
  }

  // ---------------------------------------------------------- the original

  /** The message answered or forwarded, with its body (fetched when the hub does not have it). */
  private async original(messageId: string, accountId?: string): Promise<{ m: Row; o: ComposeOriginal; parts: M.MailAttachment[]; error: string | null }> {
    const m = this.store.one('SELECT * FROM mail_message WHERE id = ?', messageId);
    if (!m || (accountId && m.account_id !== accountId)) throw bad('the message answered is not here any more', 404);
    let error: string | null = null;
    try {
      await this.hub.body(messageId);
    } catch (e) {
      error = asMailError(e).message;
    }
    const b = this.store.body(messageId);
    const o: ComposeOriginal = {
      from: { name: m.from_name ?? null, email: m.from_addr ?? '' },
      to: json(m.to_json, []),
      cc: json(m.cc_json, []),
      replyTo: json(b?.reply_to, []),
      subject: m.subject ?? '',
      date: m.date,
      text: b?.text ?? null,
      html: b?.html ?? null,
    };
    return { m, o, parts: json(b?.parts, []), error: b ? null : error };
  }

  /** GET /api/mail/compose: a reply, reply all or forward filled in; or a new message. */
  async compose(kind: P.MailComposeKind, messageId: string | null, accountId: string | null, tz?: string): Promise<P.MailComposeStart> {
    if (!KINDS.has(kind)) throw bad('kind is new, reply, replyAll or forward');
    const writable = this.store.accounts().filter((a) => a.level === 'write' && !a.gone_at && !a.hidden);
    const choices = (accs: Row[]) => accs.flatMap((a) => this.fromChoices(a).map((c) => ({ accountId: a.id, ...c })));
    const blank = (acc: string): P.MailDraft => ({ accountId: acc, kind, replyTo: null, from: null, to: [], cc: [], bcc: [], subject: '', text: '', quote: true, files: [], forwardParts: [] });
    if (kind === 'new' || !messageId) {
      const acc = accountId ? writable.find((a) => a.id === accountId) : writable[0];
      if (!acc) throw bad(this.store.accounts().some((a) => a.level === 'read') ? READ_ONLY : 'no mail account can send from here', 409);
      return { draft: { ...blank(acc.id), kind: 'new' }, draftKey: `new:${crypto.randomUUID()}`, fromChoices: choices([acc, ...writable.filter((a) => a !== acc)]), quote: null, quoteError: null, replyAllDiffers: false };
    }
    const { m, o, parts, error } = await this.original(messageId);
    const acc = this.store.account(m.account_id);
    if (!acc || acc.level !== 'write' || acc.gone_at) throw bad(acc && !acc.gone_at && acc.level ? READ_ONLY : 'dither-chat no longer has access to this account', acc?.level === 'read' ? 403 : 410);
    const self = this.store.selfAddresses(acc.id);
    const r = kind === 'forward' ? { to: [], cc: [] } : replyRecipients(o, self, kind === 'replyAll');
    const from = replyFrom(o, this.fromChoices(acc));
    const forwardParts = kind === 'forward' ? parts.filter((p) => !p.inline).map((p) => ({ messageId, attachmentId: p.id, name: p.filename, mime: p.mime, size: p.size })) : [];
    return {
      draft: { ...blank(acc.id), replyTo: messageId, from, to: r.to, cc: r.cc, subject: kind === 'forward' ? forwardSubject(o.subject) : replySubject(o.subject), forwardParts },
      draftKey: `t:${m.thread_id}`,
      fromChoices: choices([acc]),
      quote: error && !o.text ? null : tail(kind, o, true, tz),
      quoteError: error,
      replyAllDiffers: kind !== 'forward' && replyAllDiffers(o, self),
    };
  }

  // ---------------------------------------------------------- accepting a send

  /** POST /api/mail/send: checked, kept, held. The same clientId again answers the item it made. */
  async accept(req: P.MailSendRequest): Promise<{ outboxId: string; state: string }> {
    const clientId = String(req?.clientId ?? '');
    if (!/^[\w.:-]{8,100}$/.test(clientId)) throw bad('a clientId, please');
    const had = this.store.one('SELECT id, state FROM mail_outbox WHERE client_id = ?', clientId);
    if (had) return { outboxId: had.id, state: had.state };
    const acc = this.store.account(String(req.accountId ?? ''));
    this.sendable(acc);
    const kind = req.kind;
    if (!KINDS.has(kind)) throw bad('kind is new, reply, replyAll or forward');
    const to = cleanList(req.to, 'To');
    const cc = cleanList(req.cc, 'Cc');
    const bcc = cleanList(req.bcc, 'Bcc');
    const n = to.length + cc.length + bcc.length;
    if (!n) throw bad('Who is it to? Add a recipient.');
    if (n > maxRecipients(acc!.kind)) throw bad(`At most ${maxRecipients(acc!.kind)} recipients on one message from this account.`);
    if (typeof req.subject !== 'string' || req.subject.length > 2000) throw bad('the subject is text');
    if (typeof req.text !== 'string' || req.text.length > 2 * MB) throw bad('the text is text, up to 2 MB');
    let from: string | null = null;
    if (req.from) {
      const hit = this.fromChoices(acc!).find((a) => lc(a.email) === lc(req.from));
      // §13: anything else is refused by the extractor (422); refused here first, before it is held.
      if (!hit) throw bad(FROM_REFUSED, 422);
      from = hit.email;
    }
    const draftKey = req.draftKey && validDraftKey(req.draftKey) ? req.draftKey : null;
    // The original, for the quote, the forwarded block and its files.
    let o: ComposeOriginal | null = null;
    let threadId: string | null = null;
    let replyTo: string | null = null;
    let parts: M.MailAttachment[] = [];
    if (kind !== 'new') {
      if (typeof req.replyTo !== 'string') throw bad('which message does it answer?');
      const got = await this.original(req.replyTo, acc!.id);
      if (got.error && !got.o.text && (kind === 'forward' || req.quote)) throw bad(`The original could not be fetched to ${kind === 'forward' ? 'forward' : 'quote'} it: ${got.error}`, 503);
      o = got.o;
      threadId = got.m.thread_id;
      replyTo = got.m.id;
      parts = got.parts;
    }
    // Files: uploads that are all there, and the original's own for a forward.
    const draft = cleanDraft({ ...req, from, kind, replyTo });
    let total = 0;
    for (const f of draft.files) {
      const have = this.files?.get([f.uploadId]);
      if (!have?.length) throw bad(`${f.name} is no longer on the hub: attach it again`, 410);
      if (have[0].size > FILE_CAP) throw bad(`${f.name} is over 25 MB`, 413);
      total += have[0].size;
    }
    if (draft.files.length && !this.opts.dir) throw bad('this hub keeps no files for mail', 400);
    const forwardParts: P.MailForwardPart[] = [];
    for (const f of kind === 'forward' ? draft.forwardParts : []) {
      const p = parts.find((x) => x.id === f.attachmentId);
      if (!p || f.messageId !== replyTo) continue;
      if (p.size > FILE_CAP) throw bad(`${p.filename ?? 'An attachment'} is over 25 MB`, 413);
      total += p.size;
      forwardParts.push({ messageId: replyTo!, attachmentId: p.id, name: p.filename, mime: cleanMime(p.mime), size: p.size });
    }
    if (total > totalCap(acc!.kind)) throw bad(`The files are ${(total / MB).toFixed(1)} MB together; this account takes ${totalCap(acc!.kind) / MB} MB on one message.`, 413);
    draft.forwardParts = forwardParts;
    draft.to = to;
    draft.cc = cc;
    draft.bcc = bcc;
    const t = tail(kind, o, draft.quote, req.tz);
    const outgoing: Omit<M.OutgoingMail, 'attachments' | 'replyTo'> = {
      ...(from ? { from } : {}),
      to,
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      subject: req.subject,
      text: messageText(req.text, t),
      html: messageHtml(kind, req.text, o, draft.quote, req.tz),
    };
    const id = mailId('mob', acc!.id, clientId);
    const now = this.now();
    this.store.db.transaction(() => {
      this.run(
        `INSERT INTO mail_outbox (id, client_id, account_id, kind, reply_to, thread_id, draft, draft_key, outgoing, state, hold_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)`,
        id,
        clientId,
        acc!.id,
        kind,
        replyTo,
        threadId,
        JSON.stringify(draft),
        draftKey,
        JSON.stringify(outgoing),
        now + this.holdMs,
        now,
        now,
      );
      // The draft became this send; it comes back if the send does not go out.
      if (draftKey) this.run('DELETE FROM mail_draft WHERE key = ?', draftKey);
    })();
    this.dirty = true;
    this.pump();
    return { outboxId: id, state: 'held' };
  }

  /** Undo while it is held: it goes back to the drafts. */
  undo(id: string): { draftKey: string; draft: P.MailDraft } {
    const r = this.row(id);
    if (!r || r.state === 'undone') throw bad('no such send', 404);
    if (r.state !== 'held') throw bad(r.state === 'sent' ? 'It was sent already.' : 'It has gone to the account already.', 409);
    this.run(`UPDATE mail_outbox SET state = 'undone', updated_at = ? WHERE id = ?`, this.now(), id);
    const back = this.restore(r);
    this.dirty = true;
    this.pump();
    return back;
  }

  /** A failed or sent item is not shown any more. */
  dismiss(id: string) {
    const r = this.row(id);
    if (!r) throw bad('no such send', 404);
    if (r.state === 'held' || r.state === 'queued' || r.state === 'sending') throw bad('it is still on its way', 409);
    this.run('UPDATE mail_outbox SET dismissed = 1 WHERE id = ?', id);
    this.dirty = true;
  }

  // ---------------------------------------------------------- going out

  private pump() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    const now = this.now();
    let next = Infinity;
    for (const r of this.store.all(`SELECT * FROM mail_outbox WHERE state IN ('held', 'queued') ORDER BY created_at`)) {
      if (r.state === 'held') {
        if (r.hold_until > now) {
          next = Math.min(next, r.hold_until);
          continue;
        }
        if (!this.release(r)) continue;
        r.state = 'queued';
        r.next_at = null;
      }
      if (this.running.has(r.id)) continue;
      if (r.next_at && r.next_at > now) {
        next = Math.min(next, r.next_at);
        continue;
      }
      void this.attempt(r.id);
    }
    if (next < Infinity) this.timer = setTimeout(() => this.pump(), Math.max(10, next - now));
  }

  private folder(id: string) {
    return join(this.opts.dir!, id);
  }

  /** Held no more: its files leave the uploads (which go after an hour unused) for the outbox's folder. */
  private release(r: Row): boolean {
    const draft = json<P.MailDraft>(r.draft, cleanDraft({}));
    const files: { name: string; mime: string; size: number; path: string }[] = [];
    if (draft.files.length) {
      const have = this.files?.get(draft.files.map((f) => f.uploadId));
      if (!have || !this.opts.dir) {
        this.fail(r, 'A file was no longer on the hub: attach it again.');
        return false;
      }
      mkdirSync(this.folder(r.id), { recursive: true, mode: 0o700 });
      have.forEach((f, i) => {
        const path = join(this.folder(r.id), `${i}`);
        copyFileSync(f.path, path);
        files.push({ name: draft.files[i].name || f.name, mime: cleanMime(draft.files[i].mime || f.mime), size: f.size, path });
      });
      this.files!.remove(draft.files.map((f) => f.uploadId));
    }
    this.run(`UPDATE mail_outbox SET state = 'queued', files = ?, next_at = NULL, updated_at = ? WHERE id = ?`, JSON.stringify(files), this.now(), r.id);
    this.dirty = true;
    return true;
  }

  private async attempt(id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const r = this.row(id);
      if (!r || r.state !== 'queued') return;
      const acc = this.store.account(r.account_id);
      if (!acc || !acc.level || acc.gone_at) return this.fail(r, 'dither-chat no longer has access to this account.');
      if (acc.level !== 'write') return this.fail(r, READ_ONLY);
      const sync = this.hub.sync(r.account_id);
      if (!this.hub.backend?.connected || !sync) return this.later(r, 'dither-accounts is not reachable');
      this.run(`UPDATE mail_outbox SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?`, this.now(), id);
      this.dirty = true;
      let res: { messageId?: string; sentId?: string | null; dryRun?: boolean };
      try {
        res = await sync.queue.run(P0, `send:${id}`, async () => {
          const out: M.OutgoingMail = json(r.outgoing, {} as M.OutgoingMail);
          // Where the original is now (an IMAP move changes its id).
          if (r.reply_to) {
            const at = this.store.nativeOf(r.reply_to);
            if (at) out.replyTo = at.id;
          }
          const files = await this.attachments(r);
          if (files.length) out.attachments = files;
          return this.hub.backend!.call<{ messageId?: string; sentId?: string | null; dryRun?: boolean }>(r.account_id, 'mail.send', out as unknown as Record<string, unknown>, 120_000);
        });
      } catch (e) {
        return this.refused(this.row(id) ?? r, asMailError(e));
      }
      this.sent(this.row(id) ?? r, res ?? {});
    } catch (e) {
      this.log(`[outbox ${id}] ${asMailError(e).message}`);
    } finally {
      this.running.delete(id);
      this.pump();
    }
  }

  /** The files: by path when the manager reads this machine's files, else the bytes. A forward's come from the server once. */
  private async attachments(r: Row): Promise<M.OutgoingFile[]> {
    const local = !!this.hub.backend?.localFiles;
    const out: M.OutgoingFile[] = [];
    const add = (name: string, mime: string, path: string) => out.push(local ? { filename: name, mime, path } : { filename: name, mime, base64: readFileSync(path).toString('base64') });
    for (const f of json<{ name: string; mime: string; path: string }[]>(r.files, [])) add(f.name, f.mime, f.path);
    const draft = json<P.MailDraft>(r.draft, cleanDraft({}));
    for (const [i, p] of draft.forwardParts.entries()) {
      if (!this.opts.dir) throw bad('this hub keeps no files for mail', 400);
      const path = join(this.folder(r.id), `fwd-${i}`);
      if (!existsSync(path)) {
        const at = this.store.nativeOf(p.messageId);
        if (!at) throw bad(`${p.name ?? 'An attachment'} of the forwarded message is not on the server any more`, 404);
        const got = await this.hub.backend!.call<{ filename: string | null; mime: string; base64: string }>(r.account_id, 'mail.attachment', { id: at.id, attachmentId: p.attachmentId }, 120_000);
        mkdirSync(this.folder(r.id), { recursive: true, mode: 0o700 });
        writeFileSync(path, Buffer.from(got.base64 ?? '', 'base64'), { mode: 0o600 });
      }
      add(p.name || 'attachment', cleanMime(p.mime), path);
    }
    return out;
  }

  private sent(r: Row, res: { messageId?: string; sentId?: string | null; dryRun?: boolean }) {
    const dry = !!res.dryRun;
    this.run(
      `UPDATE mail_outbox SET state = 'sent', error = NULL, dry_run = ?, sent_message_id = ?, sent_native = ?, files = '[]', updated_at = ? WHERE id = ?`,
      dry ? 1 : 0,
      res.messageId ?? null,
      res.sentId ?? null,
      this.now(),
      r.id,
    );
    this.dirty = true;
    this.clean(r.id);
    if (!dry) {
      const acc = this.store.account(r.account_id);
      if (acc && json<{ ok: boolean | null }>(acc.send, { ok: null }).ok !== true) this.setSend(r.account_id, { ok: true, why: null });
      // Its copy in Sent, and the original marked answered: what changed, now.
      void this.hub.sync(r.account_id)?.catchUp();
    }
    this.hub.emit('sent', { accountId: r.account_id, outboxId: r.id, messageId: res.messageId ?? null, replyTo: r.reply_to ?? null, threadId: r.thread_id ?? null, dryRun: dry });
  }

  /** What an answer other than success means. */
  private refused(r: Row, e: MailCallError) {
    const s = e.status;
    const msg = e.message.replace(/[.\s]+$/, '');
    if (s === 422) {
      // A From that is not the account's: 'from', or no code at all (an older extractor).
      if (!e.code || e.code === 'from') return this.fail(r, FROM_REFUSED);
      // Anything else is the extractor's sentence for a person: 'recipients', 'settings', or 'failed' while the manager
      // does not pass an extractor's code on. This message only, so sending stays on for the account.
      return this.fail(r, recipientsRefused(e.message, json(r.outgoing, {})));
    }
    if (s === 501) {
      // Not supported by the extractor (Proton today): off for the account, until you ask again.
      this.setSend(r.account_id, { ok: false, why: e.message, refused: true });
      return this.fail(r, `Sending is off for this account: ${msg}.`);
    }
    if (s === 403 || e.code === 'denied') return this.fail(r, READ_ONLY);
    if (s === 504 || e.code === 'timeout') return this.fail(r, MAYBE_SENT, { unsure: true });
    if (!s || s === 503 || s === 429 || e.code === 'limited' || e.code === 'offline') return this.later(r, msg);
    return this.fail(r, sentence(msg));
  }

  /** Not now: again a little later, then less often, for up to a day. */
  private later(r: Row, why: string) {
    const now = this.now();
    if (now - r.created_at > GIVE_UP_MS) return this.fail(r, `Could not reach the account for a day: ${why}.`);
    const wait = this.retryMs[Math.min(Math.max(0, (r.attempts ?? 1) - 1), this.retryMs.length - 1)];
    this.run(`UPDATE mail_outbox SET state = 'queued', next_at = ?, error = ?, updated_at = ? WHERE id = ?`, now + wait, `Waiting: ${why}`, now, r.id);
    this.dirty = true;
  }

  private fail(r: Row, why: string, o: { unsure?: boolean } = {}) {
    this.run(`UPDATE mail_outbox SET state = 'failed', error = ?, unsure = ?, updated_at = ? WHERE id = ?`, why, o.unsure ? 1 : 0, this.now(), r.id);
    this.restore(r);
    this.clean(r.id);
    this.dirty = true;
  }

  /** The send back in the drafts, its files on the hub again. */
  private restore(r: Row): { draftKey: string; draft: P.MailDraft } {
    const draft = json<P.MailDraft>(r.draft, cleanDraft({}));
    const kept = json<{ name: string; mime: string; size: number; path: string }[]>(r.files, []);
    if (kept.length && this.files) {
      // They left the uploads when it was released: uploads again.
      draft.files = kept.flatMap((f) => {
        try {
          const u = this.files!.put(readFileSync(f.path), f.name, f.mime);
          return [{ uploadId: u.id, name: f.name, mime: f.mime, size: f.size }];
        } catch {
          return [];
        }
      });
    }
    const key = r.draft_key && validDraftKey(r.draft_key) ? r.draft_key : r.thread_id ? `t:${r.thread_id}` : `new:${crypto.randomUUID()}`;
    this.putDraft(key, draft);
    this.run(`UPDATE mail_outbox SET draft_key = ?, files = '[]' WHERE id = ?`, key, r.id);
    return { draftKey: key, draft };
  }

  private clean(id: string) {
    if (this.opts.dir) rmSync(this.folder(id), { recursive: true, force: true });
  }

  /** An account deleted from the hub: its sends and drafts go too. */
  private forget(accountId: string) {
    for (const r of this.store.all<{ id: string }>('SELECT id FROM mail_outbox WHERE account_id = ?', accountId)) this.clean(r.id);
    this.run('DELETE FROM mail_outbox WHERE account_id = ?', accountId);
    this.run('DELETE FROM mail_draft WHERE account_id = ?', accountId);
    this.dirty = true;
  }

  // ---------------------------------------------------------- views

  view(r: Row): P.MailOutboxView {
    const d = json<P.MailDraft>(r.draft, cleanDraft({}));
    return {
      id: r.id,
      clientId: r.client_id,
      accountId: r.account_id,
      subject: json<{ subject?: string }>(r.outgoing, {}).subject ?? d.subject,
      state: r.state,
      holdUntil: r.state === 'held' ? r.hold_until : null,
      error: r.error ?? null,
      kind: r.kind,
      threadId: r.thread_id ?? null,
      to: [...d.to, ...d.cc].slice(0, 20),
      draftKey: r.draft_key ?? null,
      unsure: !!r.unsure,
      sentMessageId: r.sent_message_id ?? null,
      dryRun: !!r.dry_run,
      createdAt: r.created_at,
    };
  }

  /** What the outbox still shows: on its way, failed, or sent a little while ago. */
  views(): P.MailOutboxView[] {
    return this.store
      .all(`SELECT * FROM mail_outbox WHERE dismissed = 0 AND (state IN ('held', 'queued', 'sending', 'failed') OR (state = 'sent' AND updated_at > ?)) ORDER BY created_at`, this.now() - SHOW_SENT_MS)
      .map((r) => this.view(r));
  }

  item(id: string): P.MailOutboxView | null {
    const r = this.row(id);
    return r ? this.view(r) : null;
  }

  flush(): P.ClientEvent[] {
    if (!this.dirty) return [];
    this.dirty = false;
    return [{ t: 'mail.outbox', items: this.views() }];
  }

  // ---------------------------------------------------------- drafts

  drafts(): P.MailDraftView[] {
    return this.store
      .all('SELECT d.* FROM mail_draft d JOIN mail_account a ON a.id = d.account_id WHERE a.gone_at IS NULL ORDER BY d.updated_at DESC')
      .map((r) => ({ key: r.key, draft: cleanDraft(json(r.data, {})), updatedAt: r.updated_at }));
  }

  draft(key: string): P.MailDraftView | null {
    const r = this.store.one('SELECT * FROM mail_draft WHERE key = ?', key);
    if (!r) return null;
    const draft = cleanDraft(json(r.data, {}));
    // Opened: its files are in use, so the hour they wait starts again.
    if (draft.files.length) this.files?.get(draft.files.map((f) => f.uploadId));
    return { key: r.key, draft, updatedAt: r.updated_at };
  }

  putDraft(key: string, data: unknown): P.MailDraftView {
    if (!validDraftKey(key)) throw bad('a draft key is t:<thread> or new:<uuid>');
    const draft = cleanDraft(data);
    if (!this.store.account(draft.accountId)) throw bad('no such mail account', 404);
    const now = this.now();
    this.run('INSERT INTO mail_draft (key, account_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET account_id = excluded.account_id, data = excluded.data, updated_at = excluded.updated_at', key, draft.accountId, JSON.stringify(draft), now);
    if (draft.files.length) this.files?.get(draft.files.map((f) => f.uploadId));
    return { key, draft, updatedAt: now };
  }

  deleteDraft(key: string) {
    this.run('DELETE FROM mail_draft WHERE key = ?', key);
  }

  /** Recipients as you type: addresses in your mail, those you wrote to first. */
  addresses(q: string, limit = 8): P.MailAddressHit[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const self = new Set(this.store.accounts().flatMap((a) => [...this.store.selfAddresses(a.id)]));
    const rows = this.store.all<{ e: string; n: string | null; w: number; c: number }>(
      `SELECT e, MAX(n) AS n, SUM(w) AS w, COUNT(*) AS c FROM (
         SELECT lower(json_extract(j.value, '$.email')) AS e, json_extract(j.value, '$.name') AS n, m.addressed = 'self' AS w FROM mail_message m, json_each(m.to_json) j
         UNION ALL SELECT lower(json_extract(j.value, '$.email')), json_extract(j.value, '$.name'), m.addressed = 'self' FROM mail_message m, json_each(m.cc_json) j
         UNION ALL SELECT from_addr, from_name, 0 FROM mail_message WHERE from_addr IS NOT NULL
       ) WHERE e LIKE ? ESCAPE '\\' OR lower(n) LIKE ? ESCAPE '\\' GROUP BY e ORDER BY w > 0 DESC, c DESC LIMIT ?`,
      like,
      like,
      limit + self.size,
    );
    return rows
      .filter((r) => r.e && !self.has(r.e) && validEmail(r.e))
      .slice(0, limit)
      .map((r) => ({ name: r.n ?? null, email: r.e, wroteTo: r.w > 0, count: r.c }));
  }
}

// ------------------------------------------------------------------ routes

const ok = (x: unknown = { ok: true }) => Response.json(x);

/** Slice 5: composing, sending, Undo, drafts. */
export const sendRoutes: MailRouter = (hub) => {
  const box = hub.outbox;
  const draftKey = (raw: string) => {
    if (!validDraftKey(raw)) throw bad('a draft key is t:<thread> or new:<uuid>');
    return raw;
  };
  return [
    {
      // ?kind=reply|replyAll|forward&message=<mml>, or ?kind=new[&account=<id>]; &tz= for the quote's date.
      method: 'GET',
      path: /^\/api\/mail\/compose$/,
      handle: async ({ url }) => {
        const q = url.searchParams;
        return ok((await box.compose((q.get('kind') ?? 'new') as P.MailComposeKind, q.get('message'), q.get('account'), q.get('tz') ?? undefined)) satisfies P.MailComposeStart);
      },
    },
    {
      method: 'POST',
      path: /^\/api\/mail\/send$/,
      handle: async ({ body }) => {
        const r = await box.accept(await body<P.MailSendRequest>());
        return ok({ ok: true, ...r, item: box.item(r.outboxId) });
      },
    },
    { method: 'GET', path: /^\/api\/mail\/outbox$/, handle: () => ok({ items: box.views() }) },
    {
      // Undo, while it is held.
      method: 'DELETE',
      path: /^\/api\/mail\/outbox\/([\w-]+)$/,
      handle: ({ params }) => ok({ ok: true, ...box.undo(params[0]) }),
    },
    {
      method: 'POST',
      path: /^\/api\/mail\/outbox\/([\w-]+)\/dismiss$/,
      handle: ({ params }) => (box.dismiss(params[0]), ok()),
    },
    {
      // Every draft; ?key= for one, when there is one (none is not an error: most threads have no draft).
      method: 'GET',
      path: /^\/api\/mail\/drafts$/,
      handle: ({ url }) => {
        const k = url.searchParams.get('key');
        if (k === null) return ok({ drafts: box.drafts() });
        const d = validDraftKey(k) ? box.draft(k) : null;
        return ok({ drafts: d ? [d] : [] });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/mail\/drafts\/([^/]+)$/,
      handle: ({ params }) => {
        const d = box.draft(draftKey(params[0]));
        return d ? ok(d satisfies P.MailDraftView) : Response.json({ error: 'no such draft' }, { status: 404 });
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/mail\/drafts\/([^/]+)$/,
      handle: async ({ params, body }) => ok(box.putDraft(draftKey(params[0]), await body())),
    },
    {
      method: 'DELETE',
      path: /^\/api\/mail\/drafts\/([^/]+)$/,
      handle: ({ params }) => (box.deleteDraft(draftKey(params[0])), ok()),
    },
    {
      method: 'GET',
      path: /^\/api\/mail\/addresses$/,
      handle: ({ url }) => ok({ addresses: box.addresses(url.searchParams.get('q') ?? '', Math.min(20, Number(url.searchParams.get('limit')) || 8)) }),
    },
    {
      // "Try again" after the account answered 501: sending is offered again.
      method: 'POST',
      path: /^\/api\/mail\/accounts\/([\w-]+)\/sending$/,
      handle: ({ params }) => (box.sendingAgain(params[0]), ok()),
    },
  ];
};
