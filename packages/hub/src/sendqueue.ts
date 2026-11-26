/**
 * The send queue (docs/sync.md "The send queue"): every chat send kept in the hub, by the app's id for it, until the
 * network has it, so that a restart, a lost answer or a second tab never sends one twice, and the sends of one chat go
 * out in the order the hub took them.
 *
 * - A send is a row in `send_queue`, written in one transaction when it comes (`accept`). The app's copy can go once
 *   the hub answers (one tick). A repeat of the same id, from any tab or device, any time later, is the same row:
 *   answered with what it is now, never sent again. Only a refused one (nothing went out) goes again on a repeat.
 * - One worker per conversation sends the oldest open row and nothing behind it until that one is sent, failed or
 *   cancelled. A held or in-doubt one blocks the rows behind it: they wait with it.
 * - Held: the newest message you could see when you pressed Send (`seen_ts`) is no longer the newest in the chat, and
 *   what came after it is not this device's own earlier sends there. Checked when the row comes and right before it
 *   goes. It waits for you (Send, Edit, Cancel); while some device shows the chat at its newest, it counts down
 *   (`hold_until`, the setting's seconds) and goes by itself at the end; nobody watching, no countdown, and you are
 *   told. Nothing held goes out unwatched.
 * - A restart: a row left `sending` may be out, so it is in doubt (`unsure`), never sent again by itself; `queued`
 *   ones go; a countdown carries on from its `hold_until`.
 */
import type * as P from '@dither-chat/protocol';
import { HOLD_SECONDS_DEFAULT, HOLD_SECONDS_MAX } from '@dither-chat/protocol';
import { type Clock, realClock, unref } from './clock.ts';
import { unknownOutcome } from './outcome.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

/** What the hub's send takes (server.ts SendBody). */
export interface QueuedSend {
  body?: string;
  accountId?: string;
  replyTo?: string;
  attachments?: string[];
  clientId?: string;
  sticker?: string;
  voice?: P.VoiceOut;
  viewOnce?: boolean;
  gif?: boolean;
  silent?: boolean;
  mentionReplied?: boolean;
}
export type QueueBody = QueuedSend & P.SendQueueFields;

interface SendQueueDeps {
  /** The hub's send (server.ts sendNow): its answer, or a throw when the account failed it. */
  send: (conversationId: string, b: QueuedSend) => Promise<Response>;
  /** A device shows this chat at its newest message now, phones too. */
  watched: (conversationId: string) => boolean;
  broadcast: (events: P.ClientEvent[]) => void;
  /** Upload ids to their file names, or null when any is gone. */
  files: (ids: string[]) => string[] | null;
  dropFiles: (ids: string[]) => void;
  /** A send waits for you and no device shows its chat: tell you (a notification), once per send. */
  told?: (row: P.SendRow) => void;
  clock?: Clock;
}

/** Sent ones stay in the list this long, so a device shows two ticks until the message itself comes. */
const SENT_SHOWN_MS = 2 * 60_000;
/** At most this many messages that came since are named in a hold. */
const HOLD_IDS = 20;
const BODY_MAX = 20_000;

const refuse = (message: string, status = 400) => Object.assign(new Error(message), { status });

export class SendQueue {
  private clock: Clock;
  /** Conversations whose worker is running, and the ones asked to look again when it ends. */
  private running = new Set<string>();
  private again = new Set<string>();
  /** Countdown timers by client id. */
  private timers = new Map<string, unknown>();
  /** Callers waiting for a row to settle (old callers: no `ack: 'hub'`). */
  private waiters = new Set<() => void>();
  private stopped = false;

  constructor(
    private store: Store,
    private d: SendQueueDeps,
  ) {
    this.clock = d.clock ?? realClock;
    // Cut off mid-send by a restart: it may be out, so it is in doubt and waits for you.
    store.db
      .query(`UPDATE send_queue SET state = 'unsure', error = ?, updated_at = ? WHERE state = 'sending'`)
      .run('The hub restarted while sending it. It may have been sent: look in the chat before sending it again.', this.clock.now());
  }

  /** Picks up what waits: queued rows go, countdowns carry on. */
  start() {
    this.stopped = false;
    for (const r of this.db.query(`SELECT client_id, hold_until FROM send_queue WHERE state = 'held' AND hold_until IS NOT NULL`).all() as Row[]) this.arm(r.client_id, r.hold_until);
    for (const r of this.db.query(`SELECT DISTINCT conversation_id FROM send_queue WHERE state = 'queued'`).all() as Row[]) this.kick(r.conversation_id);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) this.clock.clearTimeout(t);
    this.timers.clear();
  }

  private get db() {
    return this.store.db;
  }

  settings(): P.SendSettings {
    const s = this.store.metaValue<Partial<P.SendSettings>>('send_settings');
    const n = s?.holdSeconds;
    return { holdSeconds: typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= HOLD_SECONDS_MAX ? n : HOLD_SECONDS_DEFAULT };
  }

  setSettings(s: Partial<P.SendSettings>): P.SendSettings {
    const n = s.holdSeconds;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > HOLD_SECONDS_MAX) throw refuse(`holdSeconds: a whole number from 0 to ${HOLD_SECONDS_MAX}`);
    this.store.setMetaValue('send_settings', { holdSeconds: n });
    return this.settings();
  }

  /**
   * What the sender could see, as sent: its time, or, with only an id (a reply from a notification names the message it
   * answers), that message's time here. Neither: an old caller, never held.
   */
  private seenOf(conversationId: string, s: P.SeenUpTo | undefined): { ts: number; id?: string } | null {
    if (!s || typeof s !== 'object') return null;
    const id = typeof s.id === 'string' && s.id ? s.id : undefined;
    if (typeof s.ts === 'number' && Number.isFinite(s.ts)) return { ts: s.ts, ...(id ? { id } : {}) };
    if (!id) return null;
    const m = this.db.query(`SELECT ts FROM message WHERE id = ? AND conversation_id = ?`).get(id, conversationId) as { ts: number } | null;
    return m ? { ts: m.ts, id } : null;
  }

  /** Upload ids rows still need: the upload sweep keeps them. */
  heldUploads(): Set<string> {
    const out = new Set<string>();
    for (const r of this.db.query(`SELECT attachments FROM send_queue WHERE state NOT IN ('sent', 'cancelled')`).all() as Row[]) for (const id of JSON.parse(r.attachments) as string[]) out.add(id);
    return out;
  }

  /** The list every device holds: open rows, and the ones sent lately. */
  rows(): P.SendRow[] {
    const since = this.clock.now() - SENT_SHOWN_MS;
    return (
      this.db
        .query(`SELECT * FROM send_queue WHERE state IN ('queued', 'sending', 'held', 'unsure', 'failed') UNION ALL SELECT * FROM send_queue WHERE state = 'sent' AND updated_at >= ? ORDER BY seq`)
        .all(since) as Row[]
    ).map(view);
  }

  event(): Extract<P.ClientEvent, { t: 'sends' }> {
    return { t: 'sends', rows: this.rows(), now: this.clock.now() };
  }

  get(clientId: string): P.SendRow | null {
    const r = this.row(clientId);
    return r ? view(r) : null;
  }

  /**
   * A send comes: its row, new or the one it repeats. Throws a refusal (with `status`) for one that cannot be a row at
   * all: empty, too long, files the hub no longer has. A repeat of a refused one is taken again (nothing went out).
   */
  accept(conversationId: string, b: QueueBody): P.SendRow {
    const clientId = typeof b.clientId === 'string' && b.clientId ? b.clientId.slice(0, 64) : `hub-${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')}`;
    const had = this.row(clientId);
    if (had && had.conversation_id !== conversationId) throw refuse('that send id belongs to another chat', 409);
    if (had && had.state !== 'failed') return view(had);
    const body = typeof b.body === 'string' ? b.body : '';
    const ids = Array.isArray(b.attachments) ? b.attachments.filter((a): a is string => typeof a === 'string') : [];
    const sticker = typeof b.sticker === 'string' && b.sticker ? b.sticker.slice(0, 128) : null;
    if (!body.trim() && !ids.length && !sticker) throw refuse('empty message');
    if (body.length > BODY_MAX) throw refuse('That is too long to send');
    const names = ids.length ? this.d.files(ids) : [];
    if (!names) throw refuse('that upload has expired, attach the file again', 410);
    const now = this.clock.now();
    const seen = this.seenOf(conversationId, b.seenUpTo);
    const fields = {
      account_id: typeof b.accountId === 'string' ? b.accountId : null,
      device: typeof b.device === 'string' && b.device ? b.device.slice(0, 64) : null,
      body,
      reply_to: typeof b.replyTo === 'string' ? b.replyTo : null,
      attachments: JSON.stringify(ids),
      files: JSON.stringify(names),
      sticker,
      voice: b.voice ? JSON.stringify(b.voice) : null,
      gif: b.gif === true ? 1 : 0,
      view_once: b.viewOnce === true ? 1 : 0,
      silent: b.silent === true ? 1 : 0,
      mention_replied: typeof b.mentionReplied === 'boolean' ? (b.mentionReplied ? 1 : 0) : null,
      seen_ts: seen ? Math.floor(seen.ts) : null,
      seen_id: seen && typeof seen.id === 'string' ? seen.id : null,
      pressed_at: typeof b.pressedAt === 'number' && Number.isFinite(b.pressedAt) ? Math.floor(b.pressedAt) : now,
    };
    this.db.transaction(() => {
      if (had) {
        // Refused before: nothing went out, so it goes again, as asked now, at the end of its chat's queue.
        this.db
          .query(
            `UPDATE send_queue SET seq = ?, account_id = ?, device = ?, body = ?, reply_to = ?, attachments = ?, files = ?, sticker = ?, voice = ?, gif = ?, view_once = ?, silent = ?,
               mention_replied = ?, seen_ts = ?, seen_id = ?, pressed_at = ?, state = 'queued', error = NULL, status = NULL, hold_reason = NULL, hold_until = NULL, confirmed = 0, told = 0, updated_at = ?
             WHERE client_id = ?`,
          )
          .run(this.nextSeq(), ...Object.values(fields), now, clientId);
      } else {
        this.db
          .query(
            `INSERT INTO send_queue (client_id, seq, conversation_id, account_id, device, body, reply_to, attachments, files, sticker, voice, gif, view_once, silent, mention_replied, seen_ts, seen_id, pressed_at, state, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
          )
          .run(clientId, this.nextSeq(), conversationId, ...Object.values(fields), now);
      }
      // Already behind what you saw: held from the start.
      this.holdIfMoved(this.row(clientId)!);
    })();
    this.afterHold(clientId);
    // As committed: the worker may take it on at once.
    const row = this.get(clientId)!;
    this.changed();
    this.kick(conversationId);
    return row;
  }

  /**
   * Waits until the row is through for a caller that waits for the network (no `ack: 'hub'`): sent, failed, in doubt,
   * cancelled, held, or queued behind one that waits for you.
   */
  async settled(clientId: string): Promise<P.SendRow> {
    for (;;) {
      const r = this.get(clientId);
      if (!r) throw refuse('no such send', 404);
      if (r.state !== 'queued' && r.state !== 'sending') return r;
      if (r.state === 'queued' && this.blockedBy(r.conversationId, r.seq)) return r;
      await new Promise<void>((resolve) => {
        const w = () => (this.waiters.delete(w), resolve());
        this.waiters.add(w);
      });
    }
  }

  /** What a caller that waited is answered: as POST /send answered before the queue. */
  async answer(clientId: string): Promise<Response> {
    const r = await this.settled(clientId);
    const raw = this.row(clientId)!;
    return answerOf(r, raw.status ?? null, raw.native_id ?? null);
  }

  /** The open row before this one in its chat that waits for you (held or in doubt), if any. */
  blockedBy(conversationId: string, seq: number): P.SendRow | null {
    const r = this.db.query(`SELECT * FROM send_queue WHERE conversation_id = ? AND seq < ? AND state IN ('held', 'unsure') ORDER BY seq LIMIT 1`).get(conversationId, seq) as Row | null;
    return r ? view(r) : null;
  }

  /**
   * You pressed something on a send: Send (a held one, one in doubt, a refused one: it goes now, unchecked), Cancel, or
   * Edit (cancelled, and its text is yours to change in the box: the answer carries it).
   */
  act(clientId: string, action: P.SendAction['action']): P.SendRow {
    const r = this.row(clientId);
    if (!r) throw refuse('no such send', 404);
    if (r.state === 'sending') throw refuse('It is being sent now', 409);
    if (r.state === 'sent') throw refuse('That was sent already', 409);
    if (action === 'send') {
      if (r.state === 'cancelled') throw refuse('That was cancelled', 409);
      if (r.state !== 'queued') this.set(clientId, `state = 'queued', confirmed = 1, error = NULL, status = NULL, hold_until = NULL`);
      else this.set(clientId, 'confirmed = 1');
      this.disarm(clientId);
      this.changed();
      this.kick(r.conversation_id);
    } else if (action === 'cancel' || action === 'edit') {
      if (r.state !== 'cancelled') {
        this.set(clientId, `state = 'cancelled', hold_until = NULL`);
        this.disarm(clientId);
        this.d.dropFiles(JSON.parse(r.attachments));
        this.changed();
        // What waited behind it goes now.
        this.kick(r.conversation_id);
      }
    } else throw refuse('action: send, cancel or edit');
    return this.get(clientId)!;
  }

  /** What the devices show changed: a held send's countdown starts where a device shows its chat, and stops where none does. */
  watchChanged() {
    // Stopping closes every socket: that is a restart, not the devices looking away, so countdowns stay as they are.
    if (this.stopped) return;
    const s = this.settings().holdSeconds;
    let changed = false;
    for (const r of this.db.query(`SELECT * FROM send_queue WHERE state = 'held'`).all() as Row[]) {
      const watched = this.d.watched(r.conversation_id);
      if (watched && r.hold_until === null && s > 0) {
        const until = this.clock.now() + s * 1000;
        this.set(r.client_id, 'hold_until = ?', until);
        this.arm(r.client_id, until);
        changed = true;
      } else if (!watched && r.hold_until !== null) {
        this.set(r.client_id, 'hold_until = NULL');
        this.disarm(r.client_id);
        this.tell(r.client_id);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  // ------------------------------------------------------------------ the worker

  /** The conversation's worker: sends its head, then the next, until one waits or none is left. */
  private kick(conversationId: string) {
    if (this.stopped) return;
    if (this.running.has(conversationId)) return void this.again.add(conversationId);
    this.running.add(conversationId);
    void this.work(conversationId).finally(() => {
      this.running.delete(conversationId);
      if (this.again.delete(conversationId)) this.kick(conversationId);
    });
  }

  private async work(conversationId: string) {
    for (;;) {
      if (this.stopped) return;
      this.again.delete(conversationId);
      const head = this.db.query(`SELECT * FROM send_queue WHERE conversation_id = ? AND state IN ('queued', 'sending', 'held', 'unsure') ORDER BY seq LIMIT 1`).get(conversationId) as Row | null;
      if (!head || head.state !== 'queued') return;
      // Right before it goes: did the chat move on while it waited?
      if (!head.confirmed && this.db.transaction(() => this.holdIfMoved(head))()) {
        this.afterHold(head.client_id);
        this.changed();
        return;
      }
      this.set(head.client_id, `state = 'sending', tries = tries + 1, confirmed = 0, hold_reason = NULL`);
      this.changed();
      await this.deliver(head);
    }
  }

  private async deliver(r: Row) {
    const send: QueuedSend = {
      clientId: r.client_id,
      body: r.body,
      ...(r.account_id ? { accountId: r.account_id } : {}),
      ...(r.reply_to ? { replyTo: r.reply_to } : {}),
      ...(JSON.parse(r.attachments).length ? { attachments: JSON.parse(r.attachments) } : {}),
      ...(r.sticker ? { sticker: r.sticker } : {}),
      ...(r.voice ? { voice: JSON.parse(r.voice) } : {}),
      ...(r.gif ? { gif: true } : {}),
      ...(r.view_once ? { viewOnce: true } : {}),
      ...(r.silent ? { silent: true } : {}),
      ...(r.mention_replied !== null ? { mentionReplied: r.mention_replied === 1 } : {}),
    };
    try {
      const res = await this.d.send(r.conversation_id, send);
      // Stopped meanwhile: the next start finds it `sending` and puts it in doubt, as after a crash.
      if (this.stopped) return;
      const answer = (await res.json().catch(() => ({}))) as { error?: string; messageId?: string; accountId?: string; result?: { nativeId?: unknown } };
      if (res.ok) {
        const native = typeof answer.result?.nativeId === 'string' ? answer.result.nativeId : null;
        this.set(r.client_id, `state = 'sent', message_id = ?, native_id = ?, sent_by = ?, error = NULL`, answer.messageId ?? null, native, answer.accountId ?? null);
      } else this.set(r.client_id, `state = 'failed', error = ?, status = ?`, answer.error || `The send failed (${res.status})`, res.status);
    } catch (e) {
      if (this.stopped) return;
      if (unknownOutcome(e)) this.set(r.client_id, `state = 'unsure', error = ?`, 'The hub lost track of this send: it may have been sent. Look in the chat before sending it again.');
      // The account said no (not connected, not allowed): nothing went out.
      else this.set(r.client_id, `state = 'failed', error = ?, status = 500`, (e as Error)?.message || String(e));
    }
    this.changed();
  }

  // ------------------------------------------------------------------ holding

  /**
   * Holds the row if messages came into its chat after what you saw when you pressed Send, other than the ones this
   * device's earlier sends there became. True when it did.
   */
  private holdIfMoved(r: Row): boolean {
    if (r.seen_ts === null || r.confirmed) return false;
    const news = this.cameSince(r);
    if (!news.length) return false;
    const hold: P.SendHold = { count: news.length, ids: news.slice(0, HOLD_IDS) };
    this.set(r.client_id, `state = 'held', hold_reason = ?, hold_until = NULL`, JSON.stringify(hold));
    return true;
  }

  /** After a hold: the countdown where a device shows the chat, else you are told. */
  private afterHold(clientId: string) {
    const r = this.row(clientId);
    if (!r || r.state !== 'held' || r.hold_until !== null) return;
    const s = this.settings().holdSeconds;
    if (s > 0 && this.d.watched(r.conversation_id)) {
      const until = this.clock.now() + s * 1000;
      this.set(clientId, 'hold_until = ?', until);
      this.arm(clientId, until);
    } else if (!this.d.watched(r.conversation_id)) this.tell(clientId);
  }

  /** Message ids in the row's chat newer than what you saw, that are not this device's own earlier sends there. */
  private cameSince(r: Row): string[] {
    // Newer than what you saw, and stored after it when the hub has it: a message the hub already held that only got a
    // later time (a demo world dated again at its start) is not news.
    const msgs = this.db
      .query(
        `SELECT id, body, author_id FROM message WHERE conversation_id = ? AND ts > ? AND deleted = 0 AND id IS NOT ?
           AND rowid > COALESCE((SELECT rowid FROM message WHERE id = ?), -1) ORDER BY ts LIMIT 200`,
      )
      .all(r.conversation_id, r.seen_ts, r.seen_id, r.seen_id) as Row[];
    if (!msgs.length) return [];
    const mine = r.device
      ? (this.db.query(`SELECT message_id, body FROM send_queue WHERE conversation_id = ? AND device = ? AND seq < ? AND state = 'sent'`).all(r.conversation_id, r.device, r.seq) as Row[])
      : [];
    const expected = new Set(mine.map((m) => m.message_id).filter(Boolean));
    // A network that named no message for a send: its echo is the oldest message of ours with the same text.
    const unnamed = mine.filter((m) => !m.message_id).map((m) => String(m.body).trim());
    const out: string[] = [];
    for (const m of msgs) {
      if (expected.has(m.id)) continue;
      const k = unnamed.indexOf(String(m.body).trim());
      if (k >= 0 && m.author_id && this.selfAuthor(m.author_id)) {
        unnamed.splice(k, 1);
        continue;
      }
      out.push(m.id);
    }
    return out;
  }

  private selfAuthor(identityId: string): boolean {
    return !!this.db.query('SELECT 1 FROM account WHERE self_identity = ?').get(identityId);
  }

  private arm(clientId: string, at: number) {
    this.disarm(clientId);
    const t = this.clock.setTimeout(() => this.countdownEnded(clientId), Math.max(0, at - this.clock.now()));
    unref(t);
    this.timers.set(clientId, t);
  }

  private disarm(clientId: string) {
    const t = this.timers.get(clientId);
    if (t !== undefined) this.clock.clearTimeout(t);
    this.timers.delete(clientId);
  }

  /** The countdown ran out: it goes, if a device still shows its chat; else it stops, and waits for you. */
  private countdownEnded(clientId: string) {
    this.timers.delete(clientId);
    const r = this.row(clientId);
    if (!r || r.state !== 'held' || r.hold_until === null) return;
    if (r.hold_until > this.clock.now()) return this.arm(clientId, r.hold_until);
    if (!this.d.watched(r.conversation_id)) {
      this.set(clientId, 'hold_until = NULL');
      this.tell(clientId);
    } else this.set(clientId, `state = 'queued', confirmed = 1, hold_until = NULL`);
    this.changed();
    this.kick(r.conversation_id);
  }

  /** Once per send: you are told that it waits for you. */
  private tell(clientId: string) {
    const r = this.row(clientId);
    if (!r || r.told || !this.d.told) return;
    this.set(clientId, 'told = 1');
    this.d.told(view(r));
  }

  // ------------------------------------------------------------------ rows

  private nextSeq(): number {
    return ((this.db.query('SELECT MAX(seq) AS n FROM send_queue').get() as Row).n ?? 0) + 1;
  }

  private row(clientId: string): Row | null {
    return this.db.query('SELECT * FROM send_queue WHERE client_id = ?').get(clientId) as Row | null;
  }

  private set(clientId: string, assign: string, ...args: (string | number | null)[]) {
    this.db.query(`UPDATE send_queue SET ${assign}, updated_at = ? WHERE client_id = ?`).run(...args, this.clock.now(), clientId);
  }

  private changed() {
    this.d.broadcast([this.event()]);
    for (const w of [...this.waiters]) w();
  }
}

function view(r: Row): P.SendRow {
  return {
    clientId: r.client_id,
    conversationId: r.conversation_id,
    accountId: r.sent_by ?? r.account_id ?? null,
    body: r.body,
    files: JSON.parse(r.files),
    replyTo: r.reply_to ?? null,
    state: r.state,
    pressedAt: r.pressed_at,
    updatedAt: r.updated_at,
    messageId: r.message_id ?? null,
    error: r.error ?? null,
    hold: r.hold_reason ? JSON.parse(r.hold_reason) : null,
    holdUntil: r.hold_until ?? null,
    seq: r.seq,
  };
}

/** A row as today's answer to a caller that waited (no `ack: 'hub'`): what POST /send answered before the queue. */
function answerOf(r: P.SendRow, status: number | null, nativeId: string | null): Response {
  switch (r.state) {
    case 'sent':
      return Response.json({ ok: true, accountId: r.accountId ?? '', result: { nativeId }, ...(r.messageId ? { messageId: r.messageId } : {}) } satisfies P.SendResult);
    case 'failed':
      return Response.json({ error: r.error ?? 'The send failed' }, { status: status ?? 500 });
    case 'unsure':
      return Response.json({ error: r.error ?? 'It may have been sent.', unknown: true, code: 'unsure' } satisfies P.SendUnsure, { status: 504 });
    case 'cancelled':
      return Response.json({ error: 'That send was cancelled' }, { status: 409 });
    default:
      // Held, or waiting behind one that waits for you: the hub has it, and it goes when you say.
      return Response.json({ ok: true, queued: true, row: r } satisfies P.SendAccepted, { status: 202 });
  }
}
