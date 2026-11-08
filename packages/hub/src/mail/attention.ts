/**
 * Mail in the one-list inbox (docs/mail.md, docs/mail-design.md §10): which threads it lists, and how much each needs
 * you, by the chat inbox's own formula (attention.ts), so "Sam wrote to you; not answered yet" and "you usually reply
 * to Sam within an hour" read the same for mail as for a chat.
 *
 * **Listed** (mail_thread.listed): a thread from a person (classify.ts), not muted, in Inbox, and unread, or you owe a
 * reply, or its last message is under a week old, or you opened it in the last two days (MAIL_INBOX). A thread from a
 * sender nobody knows (§4's rule 11) also needs triage to rate it Active or above (§14 Q4): `MailAttention.triage`,
 * which says no until slice 9 plugs its rating in. Archiving it (it leaves Inbox) takes it out.
 *
 * **The score**: each listed thread's messages fold with attention.ts's `foldMessage` (you and one other is `direct`,
 * else a `group` of everyone on it; you in To is a mention; a reply to one of yours replies to you), and
 * `scoreConversation` scores it. How you answer the author is their mail and chat tallies summed. The views go out as
 * `AttentionView`s with `kind: 'mail'` in the same `attention` events as the chats', through `Attention.sources`. Until
 * the learned order is trained with mail (slice 10), a mail row keeps its formula points.
 *
 * Folding is from the start each time a thread changes: threads are short, and it keeps nothing to go stale.
 */
import type * as P from '@dither-chat/protocol';
import { decayed } from '@dither-chat/protocol';
import { emptyTally, foldMessage, freshState, scoreConversation, sumTallies, type Attention, type AttentionSource, type ConvState, type FoldMessage, type Place, type ScoreInput, type Scored, type Tally } from '../attention.ts';
import type { Store } from '../store.ts';
import { mailClassifier } from './classify.ts';
import type { MailHub } from './index.ts';
import type { MailRouter } from './routes.ts';

type Row = Record<string, any>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** When a thread from a person is in the one-list inbox (§10). */
export const MAIL_INBOX = {
  /** Its last message is newer than this. */
  recent: 7 * DAY,
  /** You opened it this recently. */
  opened: 2 * DAY,
  /** You owe a reply to a message no older than this (after that, owing weighs nothing: attention.ts owedCurve). */
  owed: 14 * DAY,
  /** Unread, with its last message no older than this: a year of synced mail is not a year of inbox. */
  unread: 30 * DAY,
};
/** A send from here (the `sent` event) counts until Sent's copy, made about when it went, has come. */
const SENT_SLACK = 10 * MIN;
/** Time per flush for scoring what changed; the rest waits for the next. */
const BUDGET_MS = 15;

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const has = (roles: string, role: string) => json<string[]>(roles, []).includes(role);

/** What triage (slice 9) knows of a message, for the fold: it pushed it, or its reasons say it asks a question. */
export interface MailTriageFacts {
  pushed: boolean;
  question: boolean;
  /** Its first reason, for "Pinged you: …". */
  reason?: string | null;
}

export class MailAttention implements AttentionSource {
  private views = new Map<string, P.AttentionView>();
  /** Threads whose messages changed: fold again, then score. */
  private refold = new Set<string>();
  /** Threads to score again. */
  private pending = new Set<string>();
  private chat: Store | null = null;
  private now: () => number = Date.now;
  /** Whether any mail tally exists: chat's scoring asks nothing of mail until one does. */
  private tallies = false;
  /** The background fold's next step. */
  private timer: Timer | null = null;

  /**
   * Slice 9's seam for §14 Q4: whether triage rates this thread (its latest message from someone else) Active or
   * above. A thread from a sender nobody knows reaches the one-list inbox only then. Until triage is built: no.
   */
  triage: (threadId: string) => boolean = () => false;
  /** Slice 9's seam for the fold: what triage decided on these messages (pushes, questions). */
  triageFacts: (messageIds: string[]) => Map<string, MailTriageFacts> = () => new Map();

  constructor(private hub: MailHub) {
    const s = hub.store;
    s.recomputed.push((id) => this.touch(id, true));
    hub.on('opened', (e) => this.touch(e.threadId, false));
    hub.on('read', (e) => e.threadIds.forEach((id) => this.touch(id, false)));
    // You answered from here: what you owed is paid now, before Sent's copy comes (a dry run reached nobody).
    hub.on('sent', (e) => {
      if (e.dryRun || !e.threadId || !s.thread(e.threadId)) return;
      s.db.query('INSERT INTO mail_feature (thread_id, sent_at) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET sent_at = excluded.sent_at').run(e.threadId, this.now());
      this.touch(e.threadId, true);
    });
    hub.on('account', () => {
      for (const id of this.views.keys()) this.pending.add(id);
    });
    hub.on('override', (e) => e.threadId && this.touch(e.threadId, true));
    this.tallies = !!s.one('SELECT 1 FROM mail_author_feature LIMIT 1');
    s.threadExtras.push((r, v) => {
      if (r.class === 'personal') v.owedSince = s.one<{ o: number | null }>('SELECT owed_since AS o FROM mail_feature WHERE thread_id = ?', r.id)?.o ?? null;
    });
  }

  /** Into the chat inbox: listed and sent with the conversations, author tallies summed both ways. */
  connect(chat: Store, attention: Attention, now: () => number = Date.now) {
    this.chat = chat;
    this.now = now;
    if (!attention.sources.includes(this)) attention.sources.push(this);
    attention.otherTallies = (key) => this.mailTallies(key);
    mailClassifier(this.hub)?.connect(chat);
    mailClassifier(this.hub)?.changed.push((c) => this.touch(c.threadId, true));
    this.later(1000);
  }

  private later(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.backfill();
    }, ms);
    this.timer.unref?.();
  }

  /** The hub stopped (MailHub.stopping). */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Threads from a person folded before this existed (or never): in the background, so tallies cover all your mail. */
  private backfill() {
    let ids: string[];
    try {
      ids = this.hub.store.all<{ id: string }>(`SELECT t.id FROM mail_thread t LEFT JOIN mail_feature f ON f.thread_id = t.id WHERE t.class = 'personal' AND f.state IS NULL LIMIT 300`).map((r) => r.id);
      if (!ids.length) return;
      this.hub.store.db.transaction(() => ids.forEach((id) => this.fold(id)))();
    } catch (e) {
      // A closed database (the hub stopping).
      console.warn(`mail attention: ${(e as Error)?.message ?? e}`);
      return;
    }
    // Their tallies may move what the listed rows say.
    for (const id of [...ids, ...this.views.keys()]) this.pending.add(id);
    if (ids.length === 300) this.later(20);
  }

  private touch(threadId: string, refold: boolean) {
    if (refold) this.refold.add(threadId);
    this.pending.add(threadId);
  }

  // ---------------------------------------------------------- the fold

  /** Who is on it besides you: you and one other is a direct conversation. */
  private place(t: Row): Place {
    const self = this.hub.store.selfAddresses(t.account_id);
    const others = json<{ e: string }[]>(t.participants, []).filter((p) => p.e && !self.has(p.e)).length;
    return others <= 1 ? { shape: 'direct', members: 2 } : { shape: 'group', members: others + 1 };
  }

  /** Fold a thread's messages from the start; only a thread from a person is folded. */
  fold(threadId: string): ConvState | null {
    const db = this.hub.store.db;
    const t = this.hub.store.thread(threadId);
    if (!t || t.class !== 'personal') {
      if (t) db.query('UPDATE mail_feature SET state = NULL, owed_since = NULL WHERE thread_id = ?').run(threadId);
      db.query('DELETE FROM mail_author_feature WHERE thread_id = ?').run(threadId);
      return null;
    }
    const ms = this.hub.store.all(`SELECT id, received_at, from_addr, addressed, draft, in_reply_to, message_id_hdr, class FROM mail_message WHERE thread_id = ? ORDER BY received_at, id`, threadId);
    const feature = this.hub.store.one<{ sent_at: number | null }>('SELECT sent_at FROM mail_feature WHERE thread_id = ?', threadId);
    const mine = ms.filter((m) => m.addressed === 'self' && !m.draft);
    const mineIds = new Set(mine.map((m) => m.message_id_hdr).filter(Boolean));
    const facts = this.triageFacts(ms.map((m) => m.id));
    const list: FoldMessage[] = ms
      .filter((m) => !m.draft)
      .map((m) => ({
        id: m.id,
        ts: m.received_at,
        author: lc(m.from_addr) || null,
        authorKey: lc(m.from_addr) || null,
        mine: m.addressed === 'self',
        // Mail from a machine in a thread from a person (an auto-reply) owes nothing.
        bot: m.class === 'bulk',
        mentionsMe: m.addressed === 'to',
        repliesToMe: !!m.in_reply_to && mineIds.has(m.in_reply_to),
        question: !!facts.get(m.id)?.question,
        pushed: !!facts.get(m.id)?.pushed,
        ignore: false,
      }));
    const sentAt = feature?.sent_at ?? null;
    if (sentAt && !mine.some((m) => m.received_at >= sentAt - SENT_SLACK)) {
      list.push({ id: `sent:${threadId}`, ts: sentAt, author: null, authorKey: null, mine: true, bot: false, mentionsMe: false, repliesToMe: false, question: false, pushed: false, ignore: false });
      list.sort((a, b) => a.ts - b.ts);
    }
    const place = this.place(t);
    const s = freshState();
    const authors = new Map<string, Tally>();
    const tallyOf = (key: string) => authors.get(key) ?? authors.set(key, emptyTally()).get(key)!;
    for (const m of list) foldMessage(s, tallyOf, m, place);
    const owed = s.turn?.addressed ?? null;
    db.transaction(() => {
      db.query('INSERT INTO mail_feature (thread_id, state, owed_since) VALUES (?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET state = excluded.state, owed_since = excluded.owed_since').run(threadId, JSON.stringify(s), owed);
      db.query('DELETE FROM mail_author_feature WHERE thread_id = ?').run(threadId);
      const put = db.query('INSERT INTO mail_author_feature (thread_id, author_key, tally) VALUES (?, ?, ?)');
      for (const [key, tally] of authors) put.run(threadId, key, JSON.stringify(tally));
    })();
    if (authors.size) this.tallies = true;
    return s;
  }

  // ---------------------------------------------------------- tallies, both ways

  /** The email identities of a person (or the address itself): whose mail tallies count for them. */
  private addressesOfPerson(personId: string): string[] {
    return this.hub.store.all<{ native_id: string }>(`SELECT native_id FROM identity WHERE person_id = ? AND network = 'email'`, personId).map((r) => r.native_id);
  }

  /** For chat's scoring: how you answer this person by mail (attention.ts otherTallies). */
  private mailTallies(authorKey: string): Tally[] {
    if (!this.tallies || !authorKey.startsWith('per_')) return [];
    const addrs = this.addressesOfPerson(authorKey);
    if (!addrs.length) return [];
    return this.hub.store.all<{ tally: string }>('SELECT tally FROM mail_author_feature WHERE author_key IN (SELECT value FROM json_each(?))', JSON.stringify(addrs)).map((r) => JSON.parse(r.tally));
  }

  /** The person behind an address, if any, and their name. */
  private who(address: string): { personId: string | null; name: string | null } {
    if (!this.chat) return { personId: null, name: null };
    const r = this.hub.store.one<{ person_id: string | null; name: string | null }>(
      `SELECT i.person_id, COALESCE(p.name, i.display_name) AS name FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.network = 'email' AND i.native_id = ?`,
      address,
    );
    return { personId: r?.person_id ?? null, name: r?.name ?? null };
  }

  /** How you answer this correspondent: every thread of theirs by mail, and their chats once you merged them. */
  private authorTally(address: string, now: number): Tally {
    const { personId } = this.who(address);
    const addrs = personId ? [...new Set([address, ...this.addressesOfPerson(personId)])] : [address];
    const mail = this.hub.store.all<{ tally: string }>('SELECT tally FROM mail_author_feature WHERE author_key IN (SELECT value FROM json_each(?))', JSON.stringify(addrs)).map((r) => JSON.parse(r.tally) as Tally);
    let chat: Tally[] = [];
    if (personId && this.chat) {
      // Chat keys its tallies by the author's person, else the identity (attention.ts fold).
      const keys = [personId, ...this.hub.store.all<{ id: string }>(`SELECT id FROM identity WHERE person_id = ? AND network != 'email'`, personId).map((r) => r.id)];
      chat = this.hub.store.all<{ tally: string }>('SELECT tally FROM conv_author_feature WHERE author_key IN (SELECT value FROM json_each(?))', JSON.stringify(keys)).map((r) => JSON.parse(r.tally));
    }
    return sumTallies([...mail, ...chat], now);
  }

  private nameOf(address: string | null, t: Row): string | null {
    if (!address) return null;
    const w = this.who(address);
    if (w.name) return w.name;
    const p = json<{ e: string; n: string | null }[]>(t.participants, []).find((x) => x.e === address);
    return p?.n ?? address;
  }

  // ---------------------------------------------------------- listing and the score

  /** Whether the one-list inbox lists it (§10), as of `now`. */
  isListed(t: Row, owedSince: number | null, unknown: boolean, now: number): boolean {
    if (t.class !== 'personal' || t.muted || !has(t.roles, 'inbox')) return false;
    if (unknown && !this.triage(t.id)) return false;
    const acc = this.hub.store.account(t.account_id);
    if (!acc || acc.hidden) return false;
    const W = MAIL_INBOX;
    return (t.unread > 0 && now - t.last_at <= W.unread) || (owedSince !== null && now - owedSince <= W.owed) || now - t.last_at <= W.recent || (!!t.opened_at && now - t.opened_at <= W.opened);
  }

  /** The formula's input for a thread, or null when it is not listed. */
  input(threadId: string, now: number): (ScoreInput & { listed: true; thread: Row }) | null {
    const t = this.hub.store.thread(threadId);
    if (!t) return null;
    let f = this.hub.store.one<{ state: string | null; owed_since: number | null; unknown: number }>('SELECT state, owed_since, unknown FROM mail_feature WHERE thread_id = ?', threadId);
    if (t.class === 'personal' && !f?.state) {
      this.fold(threadId);
      f = this.hub.store.one('SELECT state, owed_since, unknown FROM mail_feature WHERE thread_id = ?', threadId);
    }
    if (!this.isListed(t, f?.owed_since ?? null, !!f?.unknown, now)) return null;
    const state: ConvState = f?.state ? JSON.parse(f.state) : freshState();
    const place = this.place(t);
    const unread = this.hub.store.all<{ addressed: string; id: string }>(`SELECT id, addressed FROM mail_message WHERE thread_id = ? AND seen = 0 AND seen_local = 0 AND draft = 0 AND addressed != 'self'`, threadId);
    const turn = state.turn?.addressed != null ? state.turn : null;
    const other = turn?.author ?? this.lastOther(threadId);
    // Triage pushed a message you have not read (slice 9).
    const push = state.lastPush && unread.some((m) => m.id === state.lastPush!.id) ? this.triageFacts([state.lastPush.id]).get(state.lastPush.id) : null;
    return {
      listed: true,
      thread: t,
      now,
      shape: place.shape,
      members: place.members,
      lastMessageAt: t.last_at,
      state,
      author: turn?.authorKey ? this.authorTally(turn.authorKey, now) : null,
      authorName: this.nameOf(other, t),
      unread: unread.length,
      mentions: unread.filter((m) => m.addressed === 'to').length,
      pinged: push?.pushed ? (push.reason ?? 'a message you have not read') : null,
      muted: null,
      // You were here: opened_at (MailStore.opened), and the time spent there once something counts it.
      usage: t.opened_at ? { score: (t.opened_ms ?? 0) / 1000, visitScore: 1, at: t.opened_at, lastVisit: t.opened_at } : null,
      judged: null,
    };
  }

  private lastOther(threadId: string): string | null {
    return this.hub.store.one<{ a: string }>(`SELECT from_addr AS a FROM mail_message WHERE thread_id = ? AND addressed != 'self' AND from_addr IS NOT NULL ORDER BY received_at DESC, id DESC LIMIT 1`, threadId)?.a ?? null;
  }

  private compute(threadId: string, now: number): P.AttentionView | null {
    const x = this.input(threadId, now);
    if (!x) return null;
    const s = scoreConversation(x);
    return { id: threadId, kind: 'mail', score: s.score, needs: s.needs, reasons: s.reasons, owedSince: s.owedSince, at: now };
  }

  /** Threads that may be listed now: the SQL side of isListed, so a year of mail is not read every few minutes. */
  private candidates(now: number): string[] {
    const W = MAIL_INBOX;
    return this.hub.store
      .all<{ id: string }>(
        `SELECT t.id FROM mail_thread t LEFT JOIN mail_feature f ON f.thread_id = t.id
         WHERE t.class = 'personal' AND t.muted = 0 AND ((t.unread > 0 AND t.last_at >= ?) OR t.last_at >= ? OR t.opened_at >= ? OR f.owed_since >= ?)
           AND EXISTS (SELECT 1 FROM json_each(t.roles) WHERE value = 'inbox')`,
        now - W.unread,
        now - W.recent,
        now - W.opened,
        now - W.owed,
      )
      .map((r) => r.id);
  }

  // ---------------------------------------------------------- AttentionSource

  rescore(now: number, all: boolean): { items: P.AttentionView[]; removed: string[] } {
    const items: P.AttentionView[] = [];
    const removed: string[] = [];
    if (!all && !this.pending.size && !this.refold.size) return { items, removed };
    const ids = all ? new Set([...this.views.keys(), ...this.candidates(now), ...this.pending, ...this.refold]) : new Set([...this.pending, ...this.refold]);
    const start = performance.now();
    const listed = new Map<string, boolean>();
    // Folded first: how you answer someone counts every thread of theirs, so none is scored on tallies not made yet.
    let refolded = false;
    for (const id of ids) {
      if (!this.refold.has(id)) continue;
      if (!all && performance.now() - start > BUDGET_MS) break;
      this.refold.delete(id);
      this.fold(id);
      refolded = true;
    }
    for (const id of ids) {
      if (this.refold.has(id)) continue;
      if (!all && performance.now() - start > BUDGET_MS) break;
      this.pending.delete(id);
      const v = this.compute(id, now);
      const prev = this.views.get(id);
      listed.set(id, !!v);
      if (!v) {
        if (prev) {
          this.views.delete(id);
          removed.push(id);
        }
        continue;
      }
      if (prev && Math.abs(prev.score - v.score) < 0.5 && prev.needs === v.needs && prev.owedSince === v.owedSince && prev.reasons.join('\n') === v.reasons.join('\n')) continue;
      this.views.set(id, v);
      items.push(v);
    }
    // A thread merged into another goes without a recompute of its own.
    if (refolded && this.views.size) {
      const gone = this.hub.store.all<{ id: string }>('SELECT value AS id FROM json_each(?) WHERE value NOT IN (SELECT id FROM mail_thread)', JSON.stringify([...this.views.keys()]));
      for (const g of gone) if (this.views.delete(g.id)) removed.push(g.id);
    }
    this.keepListed(listed);
    return { items, removed };
  }

  /** mail_thread.listed follows, so the bootstrap's window carries every listed thread. */
  private keepListed(listed: Map<string, boolean>) {
    if (!listed.size) return;
    const st = this.hub.store;
    const was = new Map(st.all<{ id: string; listed: number }>('SELECT id, listed FROM mail_thread WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify([...listed.keys()])).map((r) => [r.id, !!r.listed]));
    const set = st.db.query('UPDATE mail_thread SET listed = ? WHERE id = ?');
    st.db.transaction(() => {
      for (const [id, on] of listed) {
        if (!was.has(id) || was.get(id) === on) continue;
        set.run(on ? 1 : 0, id);
        // Newly listed: its view goes out, in case the page's window does not hold it.
        if (on) st.dirty.threads.add(id);
      }
    })();
  }

  view(id: string): P.AttentionView | undefined {
    return this.views.get(id);
  }

  list(): P.AttentionView[] {
    return [...this.views.values()];
  }

  /** GET /api/attention/:id for a mail thread. */
  explain(id: string, now: number) {
    if (!id.startsWith('mth_')) return null;
    const x = this.input(id, now);
    if (!x) return null;
    const s: Scored = scoreConversation(x);
    const f = x.state;
    return {
      ...s,
      kind: 'mail' as const,
      listed: true,
      features: { received: f.totalReceived, sent: f.totalSent, lastReceived: f.lastReceived, lastSent: f.lastSent, owedKind: f.turn?.kind ?? null, shape: x.shape, members: x.members, opened: x.thread.opened_at ?? null },
      visited: x.usage ? decayed(x.usage.visitScore, x.usage.at, now) : 0,
    };
  }
}

const ATTENTION = new WeakMap<MailHub, MailAttention>();

/** The hub's mail rows of the inbox; null on a hub made without this router. */
export function mailAttention(hub: MailHub | null | undefined): MailAttention | null {
  return (hub && ATTENTION.get(hub)) ?? null;
}

/** Slice 8's inbox: no routes of its own (the inbox is GET /api/attention and the `attention` events). */
export const attentionRoutes: MailRouter = (hub) => {
  const a = new MailAttention(hub);
  ATTENTION.set(hub, a);
  hub.stopping.push(() => a.stop());
  return [];
};
