/**
 * Send later (docs/sending.md "Send later"): a message you wrote now, sent by the hub at the time you picked, on any
 * network, through the ordinary send path with all of its refusals.
 *
 * It waits in `send_later` with its files (uploads the sweep leaves alone while it waits). At its time, if its account
 * is connected, it goes out as a send would, under its own id as the send's clientId, so a retry never sends it twice.
 * If the account is not connected it waits and says so, and goes out once the account is back, unless that is more
 * than SEND_LATER_LATE_MS after its time: then it is held, and goes only when you say "Send now" (or you cancel it).
 * A refusal (the network said no, the place cannot be written in) leaves it failed with the reason, to edit and
 * pick a time again, send now, or cancel. Sent ones stay on the list a little while, then go. More files than the
 * network takes in one message go as several messages, in order, the words and the reply with the first; each has
 * its own clientId (the id, then id#1, id#2…), so a retry sends only the ones that did not go.
 *
 * A network's own scheduled messages (Discord's, capability 'nativeScheduled') are read beside these when the list is
 * opened, as `where: 'network'`, and can be cancelled; they are the network's to send, not the hub's.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS, fileBatches, NETWORK_META, SEND_LATER_LATE_MS, SEND_LATER_MAX, sendLaterProblem, splitsFiles } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { type Clock, realClock } from './clock.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

/** How often waiting messages are looked at. */
export const TICK_MS = 10_000;
/** How long a sent one stays on the list. */
export const SENT_KEEP_MS = 10 * 60_000;
/** The longest a message may be. Matches what a send takes in practice; the network still has its own limit. */
const BODY_MAX = 20_000;

const made = new WeakSet<Database>();
export function sendLaterTables(db: Database) {
  if (made.has(db)) return;
  db.run(`CREATE TABLE IF NOT EXISTS send_later (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    body            TEXT NOT NULL,
    reply_to        TEXT,
    attachments     TEXT NOT NULL DEFAULT '[]',
    files           TEXT NOT NULL DEFAULT '[]',
    silent          INTEGER NOT NULL DEFAULT 0,
    mention         INTEGER,
    due_at          INTEGER NOT NULL,
    state           TEXT NOT NULL,
    note            TEXT,
    message_id      TEXT,
    created_at      INTEGER NOT NULL,
    done_at         INTEGER
  )`);
  db.run('CREATE INDEX IF NOT EXISTS send_later_due ON send_later (state, due_at)');
  made.add(db);
}

/** What the hub's send takes (server.ts SendBody), as Send later fills it. */
export interface LaterSend {
  body: string;
  accountId: string;
  replyTo?: string;
  attachments?: string[];
  clientId: string;
  silent?: boolean;
  mentionReplied?: boolean;
}

export interface SendLaterDeps {
  /** The hub's own send (server.ts sendOnce): its answer as the app would get it. */
  send: (conversationId: string, b: LaterSend) => Promise<Response>;
  online: (accountId: string) => boolean;
  /** Upload ids to file names, or null when any is gone or not all there (uploads.ts). */
  files: (ids: string[]) => string[] | null;
  dropFiles: (ids: string[]) => void;
  /** To open pages. */
  broadcast: (events: P.ClientEvent[]) => void;
  clock?: Clock;
}

/** Where it goes and what it says, once the app's route is resolved (server.ts). */
export interface LaterInput {
  conversationId: string;
  accountId: string;
  body: string;
  replyTo?: string | null;
  attachments?: string[];
  silent?: boolean;
  mentionReplied?: boolean;
  dueAt: number;
}

const refuse = (message: string, status = 400) => Object.assign(new Error(message), { status });

export class SendLater {
  private clock: Clock;
  private timer: Timer | null = null;
  /** Ids going out now: a tick and a "Send now" never both send one. */
  private going = new Set<string>();

  constructor(
    private store: Store,
    private d: SendLaterDeps,
  ) {
    sendLaterTables(store.db);
    this.clock = d.clock ?? realClock;
    // Cut off mid-send by a restart: whether it went out is unknown, so it is not sent again by itself.
    store.db
      .query(`UPDATE send_later SET state = 'failed', note = ? WHERE state = 'sending'`)
      .run('The hub restarted while sending it. It may have been sent: look before sending it again.');
  }

  start() {
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Upload ids still waiting to go: the upload sweep keeps them. */
  heldUploads(): Set<string> {
    const out = new Set<string>();
    for (const r of this.store.db.query(`SELECT attachments FROM send_later WHERE state != 'sent'`).all() as Row[]) for (const id of JSON.parse(r.attachments) as string[]) out.add(id);
    return out;
  }

  /** The hub's list: everything not sent, and what was sent lately. */
  list(): P.ScheduledSendView[] {
    const now = this.clock.now();
    this.store.db.query(`DELETE FROM send_later WHERE state = 'sent' AND done_at < ?`).run(now - SENT_KEEP_MS);
    return (this.store.db.query('SELECT * FROM send_later ORDER BY due_at, created_at').all() as Row[]).map(view);
  }

  get(id: string): P.ScheduledSendView | null {
    const r = this.row(id);
    return r ? view(r) : null;
  }

  create(x: LaterInput): P.ScheduledSendView {
    const now = this.clock.now();
    const why = sendLaterProblem(x.dueAt, now);
    if (why) throw refuse(why);
    const body = typeof x.body === 'string' ? x.body : '';
    const ids = Array.isArray(x.attachments) ? x.attachments.filter((a) => typeof a === 'string') : [];
    if (!body.trim() && !ids.length) throw refuse('empty message');
    if (body.length > BODY_MAX) throw refuse('That is too long to send');
    const waiting = (this.store.db.query(`SELECT COUNT(*) AS n FROM send_later WHERE state != 'sent'`).get() as Row).n as number;
    if (waiting >= SEND_LATER_MAX) throw refuse(`At most ${SEND_LATER_MAX} messages can wait to be sent`, 409);
    const names = ids.length ? this.d.files(ids) : [];
    if (!names) throw refuse('that upload has expired, attach the file again', 410);
    const id = `sch_${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')}`;
    this.store.db
      .query(
        `INSERT INTO send_later (id, conversation_id, account_id, body, reply_to, attachments, files, silent, mention, due_at, state, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, ?)`,
      )
      .run(id, x.conversationId, x.accountId, body, x.replyTo ?? null, JSON.stringify(ids), JSON.stringify(names), x.silent ? 1 : 0, typeof x.mentionReplied === 'boolean' ? (x.mentionReplied ? 1 : 0) : null, x.dueAt, now);
    this.changed();
    return this.get(id)!;
  }

  /** A new text or time: it waits again, whatever it was (sent ones excepted). */
  edit(id: string, patch: { body?: unknown; dueAt?: unknown }): P.ScheduledSendView {
    const r = this.row(id);
    if (!r) throw refuse('no such message', 404);
    if (r.state === 'sent') throw refuse('That was sent already', 409);
    if (r.state === 'sending' || this.going.has(id)) throw refuse('It is being sent now', 409);
    const now = this.clock.now();
    const body = patch.body === undefined ? r.body : String(patch.body);
    if (!body.trim() && JSON.parse(r.attachments).length === 0) throw refuse('empty message');
    if (body.length > BODY_MAX) throw refuse('That is too long to send');
    let due = r.due_at as number;
    if (patch.dueAt !== undefined) {
      const why = sendLaterProblem(patch.dueAt, now);
      if (why) throw refuse(why);
      due = patch.dueAt as number;
    } else if (due < now + 60_000) {
      // Its time passed (held, failed): a new text alone does not send it at once; pick a time or Send now.
      throw refuse('Its time has passed: pick a new time, or send it now', 409);
    }
    this.store.db.query(`UPDATE send_later SET body = ?, due_at = ?, state = 'waiting', note = NULL WHERE id = ?`).run(body, due, id);
    this.changed();
    return this.get(id)!;
  }

  cancel(id: string) {
    const r = this.row(id);
    if (!r) throw refuse('no such message', 404);
    if (r.state === 'sending' || this.going.has(id)) throw refuse('It is being sent now', 409);
    this.store.db.query('DELETE FROM send_later WHERE id = ?').run(id);
    if (r.state !== 'sent') this.d.dropFiles(JSON.parse(r.attachments));
    this.changed();
  }

  /** Send it now, whatever its time and however late: you said so. */
  async sendNow(id: string): Promise<P.ScheduledSendView> {
    const r = this.row(id);
    if (!r) throw refuse('no such message', 404);
    if (r.state === 'sent') throw refuse('That was sent already', 409);
    if (r.state === 'sending' || this.going.has(id)) throw refuse('It is being sent now', 409);
    await this.fire(r);
    return this.get(id)!;
  }

  /** Waiting messages whose time has come: sent, still waiting for their account, or held when too late. */
  async tick() {
    const now = this.clock.now();
    const due = this.store.db.query(`SELECT * FROM send_later WHERE state = 'waiting' AND due_at <= ? ORDER BY due_at`).all(now) as Row[];
    let changed = false;
    for (const r of due) {
      if (this.going.has(r.id)) continue;
      if (now - r.due_at > SEND_LATER_LATE_MS) {
        this.setState(r.id, 'held', `It was due ${late(now - r.due_at)} ago and did not go out${this.d.online(r.account_id) ? '' : ` (${this.label(r.account_id)} was not connected)`}. Send it now, or cancel it.`);
        changed = true;
        continue;
      }
      if (!this.d.online(r.account_id)) {
        const note = `Waiting for ${this.label(r.account_id)} to connect`;
        if (r.note !== note) {
          this.setState(r.id, 'waiting', note);
          changed = true;
        }
        continue;
      }
      await this.fire(r, false);
      changed = true;
    }
    if (changed) this.changed();
  }

  private async fire(r: Row, announce = true) {
    this.going.add(r.id);
    this.setState(r.id, 'sending', null);
    if (announce) this.changed();
    try {
      const mention = r.mention === null ? undefined : r.mention === 1;
      const files = JSON.parse(r.attachments) as string[];
      const network = this.store.nativeOf('conversation', r.conversation_id)?.network;
      const runs = network && splitsFiles(network) ? fileBatches(files, ATTACHMENT_LIMITS[network].files) : [files];
      let res!: Response;
      let answer: { error?: string; messageId?: string; unknown?: boolean } = {};
      let first: string | undefined;
      for (let k = 0; k < runs.length; k++) {
        res = await this.d.send(r.conversation_id, {
          body: k ? '' : r.body,
          accountId: r.account_id,
          clientId: k ? `${r.id}#${k}` : r.id,
          ...(r.reply_to && !k ? { replyTo: r.reply_to } : {}),
          ...(runs[k].length ? { attachments: runs[k] } : {}),
          ...(r.silent ? { silent: true } : {}),
          ...(mention !== undefined && !k ? { mentionReplied: mention } : {}),
        });
        answer = (await res.json().catch(() => ({}))) as typeof answer;
        if (!res.ok) {
          if (k) answer.error = `${k} of ${runs.length} messages went; the rest did not: ${answer.error || `the send failed (${res.status})`}`;
          break;
        }
        first ??= answer.messageId;
      }
      if (res.ok) {
        answer.messageId = first;
        this.store.db.query(`UPDATE send_later SET state = 'sent', note = NULL, message_id = ?, done_at = ? WHERE id = ?`).run(answer.messageId ?? null, this.clock.now(), r.id);
      } else if (res.status === 409 && /no connected account/.test(answer.error ?? '')) {
        // Gone offline between the look and the send: it waits again, under the same late rule.
        this.setState(r.id, 'waiting', `Waiting for ${this.label(r.account_id)} to connect`);
      } else {
        this.setState(r.id, 'failed', answer.error || `The send failed (${res.status})`);
      }
    } catch (e) {
      this.setState(r.id, 'failed', `The send failed: ${(e as Error).message}. It may have been sent: look before sending it again.`);
    } finally {
      this.going.delete(r.id);
      this.changed();
    }
  }

  private row(id: string): Row | null {
    return this.store.db.query('SELECT * FROM send_later WHERE id = ?').get(id) as Row | null;
  }

  private setState(id: string, state: P.ScheduledState, note: string | null) {
    this.store.db.query('UPDATE send_later SET state = ?, note = ? WHERE id = ?').run(state, note, id);
  }

  private label(accountId: string): string {
    const a = this.store.account(accountId);
    return a ? `${NETWORK_META[a.network as P.Network]?.name ?? a.network} · ${a.label}` : 'its account';
  }

  private changed() {
    this.d.broadcast([{ t: 'scheduled', items: this.list() }]);
  }
}

function view(r: Row): P.ScheduledSendView {
  return {
    id: r.id,
    where: 'hub',
    conversationId: r.conversation_id,
    accountId: r.account_id,
    body: r.body,
    dueAt: r.due_at,
    state: r.state,
    note: r.note ?? null,
    replyTo: r.reply_to ?? null,
    files: JSON.parse(r.files),
    silent: r.silent === 1,
    mentionReplied: r.mention === null ? null : r.mention === 1,
    createdAt: r.created_at,
    messageId: r.message_id ?? null,
  };
}

/** "40 minutes", "3 hours", "2 days". */
export function late(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/** A network's own scheduled message, in hub ids, beside the hub's. */
export function nativeView(accountId: string, network: P.Network, f: P.NativeScheduledFact): P.ScheduledSendView {
  return {
    id: `nsch_${accountId}_${f.nativeId}`,
    where: 'network',
    conversationId: hubId('cnv', network, f.conversation),
    accountId,
    body: f.body,
    dueAt: f.dueAt,
    state: 'waiting',
    note: `Scheduled on ${NETWORK_META[network]?.name ?? network}: it sends it, even with the hub down`,
    replyTo: f.replyTo ? hubId('msg', network, f.replyTo) : null,
    files: [],
    silent: !!f.silent,
    mentionReplied: null,
    createdAt: 0,
    messageId: null,
    nativeId: f.nativeId,
  };
}
