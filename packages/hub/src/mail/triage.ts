/**
 * Triage of mail (docs/mail.md "Triage and notifications", docs/mail-design.md §10): each new message from a person
 * gets one of chat's four levels from chat's own decision model (learn.ts), and Important and Active ones notify
 * through the same push path, one notification per thread (delivery.ts).
 *
 * **What is triaged**: mail that arrives live (`ingested` with `live`; never backfill or search hits), classed
 * personal (classify.ts), not yours and not a draft. Bulk is never triaged: no notification, no digest. Its body is
 * waited for (it is fetched on arrival, bodies.ts) at most MAIL_TRIAGE.bodyWaitMs; then the model reads the subject
 * and the start of the text.
 *
 * **Quietly, what a sync found** (`sweep`): a thread from a sender nobody knows that the one-list inbox could list
 * (MailAttention.candidates: its window, never a year of mail) but whose newest message was never rated, because it
 * came by a sync (it was there when the account was added). Its body first (fetched ahead, waited for at most
 * MAIL_TRIAGE.quietWaitMs), then the same facts and model as live mail, at most MAIL_TRIAGE.quietPerPass an account a
 * pass. Such a decision is `quiet`: it never notifies, is never held for quiet hours, and is never a line of another
 * notification; it only decides the listing (§14 Q4), and the board shows it with why. On an account whose summaries
 * carry no headers it waits for headerless.ts (`settled`), so a newsletter is not rated as a person.
 *
 * **The facts** are learn.ts's, from mail: network `email`, shape `mail`, the thread as the conversation, the mail
 * account as the space, the author (their person, else identity: the same feature chat uses, so a vote on Sam's mail
 * moves Sam on Signal too once you merged them), you in To as a mention, Cc or a list as `everyone`, a reply to one
 * of yours, a question or urgency in the subject or text, a link, an attachment, long. The prior: Important for
 * someone you correspond with who wrote to you (To), Active for one who Cc'd you, Digest for a sender nobody knows,
 * Important for a starred person. Fields with no meaning for mail (`native`, `notify`) are left out, so mail votes do
 * not move what chat learned about them.
 *
 * **Not a ping**: a message whose body warns of spoofing (a name that is another address, Reply-To elsewhere, a link
 * that says one site and goes to another: parts.ts) is held at Active at most. Late mail (a catch-up after the
 * manager was away), mail already read, mail not in Inbox and muted threads notify nobody; quiet hours hold Important
 * and Active as they hold chat.
 *
 * **Votes** (`POST /api/messages/:id/feedback` with a mail message id, or `POST /api/mail/triage/:id/vote`, from the
 * board, a notification or the reader) are kept here and join chat's in training (votes.ts `others`). "Not a person"
 * (classify.ts's `override` event) is a vote down.
 *
 * The rating lets a sender nobody knows into the one-list inbox at Active or above (§14 Q4, mail/attention.ts
 * `triage`), and tells the fold what was pushed (`triageFacts`).
 */
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { fit, type Grouped, type Line } from '../delivery.ts';
import { describeWeight, importance, isTier, levelFrom, predict, prior, STOOD, STOOD_PER_PLACE, TIER_NAME, tierDown, tierUp, voteWeight, words as wordsOf, type Example, type Facts, type Level } from '../learn.ts';
import type { Store } from '../store.ts';
import { inQuietHours, URGENT, type Triage } from '../triage.ts';
import type { OtherVotes, TriageVotes, Vote } from '../votes.ts';
import { mailAttention, type MailTriageFacts } from './attention.ts';
import { bigOf } from './backfill.ts';
import { settled } from './headerless.ts';
import type { MailHub } from './index.ts';
import { mailPeople, type MailSender } from './people.ts';
import { P1 } from './queue.ts';
import type { MailRouter } from './routes.ts';

type Row = Record<string, any>;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const MAIL_TRIAGE = {
  /** A new message's body is waited for this long (§3.4); then it is decided on what is there. */
  bodyWaitMs: 5_000,
  /** Mail that reached the server longer ago than this when it comes here (a catch-up) notifies nobody. */
  freshMs: 60 * MIN,
  /** The model reads the subject and this much of the text above any quote. */
  textChars: 2_048,
  /** Longer than this, above the quote, is `long`. */
  longChars: 1_500,
  /** What the board lists: the last week; what fell below the digest, the last two days. */
  boardDays: 7,
  belowDays: 2,
  /** Lines in a notification, as chat's. */
  lines: 6,
  /** Mail a sync found, rated quietly: at most this many an account a pass, its body waited for at most this long. */
  quietPerPass: 30,
  quietWaitMs: 60_000,
  /** How often the quiet pass looks again, besides after a sync brought mail. */
  quietEveryMs: 5 * MIN,
};

/** The reason a quiet decision gives. */
export const QUIET_REASON = 'Rated after a sync found it: no notification';

/** A notification main.ts sends (`deliverMail`). */
export interface MailNotice {
  messageId: string;
  threadId: string;
  accountId: string;
  /** The sender. */
  title: string;
  /** Subject — preview. */
  body: string;
  reasons: string[];
  level: 'push' | 'quiet';
  /** You in To, or a reply to you: what a device set to "Mentions only" still shows. */
  addressed: boolean;
  look: { network: 'email'; icon?: string };
}

export interface MailTriageDeps {
  /** The chat store: people, rules, quiet hours. */
  store: Store;
  /** The live model (votes.ts keeps it there) and its names. */
  triage: Triage;
  votes?: TriageVotes | null;
  deliver?: (n: MailNotice) => void;
}

interface Decided {
  decision: P.TriageDecision;
  level: Level | null;
  score: number | null;
  reasons: string[];
  decidedBy: 'rules' | 'learned';
  facts: Facts | null;
  words: string[];
  probs: P.TriageProbs | null;
  /** Why it must not notify at all, though rated to. */
  hold: string | null;
}

/** Mail rated after a sync found it (`sweep`): never notifies. */
interface DecideOpts {
  quiet?: boolean;
}

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const round = (x: number) => Math.round(x * 1000) / 1000;
const rounded = (p: P.TriageProbs): P.TriageProbs => ({ ping: round(p.ping), active: round(p.active), interesting: round(p.interesting) });
/** The subject without Re:, Fwd: and the like, for showing. */
export const bareSubject = (s: string | null | undefined) => (s ?? '').replace(/^(?:\s*(?:re|fwd?|aw|wg|sv|tr)\s*(?:\[\d+\])?\s*:\s*)+/i, '').trim() || '(no subject)';
/** An inline picture goes only when small (delivery.ts). */
const small = (icon: string | null | undefined) => !!icon && (!icon.startsWith('data:') || icon.length < 1500);

export class MailTriage {
  private deps: MailTriageDeps | null = null;
  /** New messages waiting for their body, at most bodyWaitMs. */
  private waiting = new Map<string, Timer>();
  private now: () => number = Date.now;
  /** How long a new message waits for its body (tests shorten it). */
  bodyWaitMs = MAIL_TRIAGE.bodyWaitMs;
  /** The quiet pass (`sweep`): messages whose body it asked for, and when. */
  private asked = new Map<string, number>();
  private sweepTimer: Timer | null = null;
  private sweepEvery: Timer | null = null;
  /** How long the quiet pass waits for a body (tests shorten it). */
  quietWaitMs = MAIL_TRIAGE.quietWaitMs;

  constructor(private hub: MailHub) {
    hub.store.addColumns('mail_triage', { quiet: 'INTEGER NOT NULL DEFAULT 0' });
    hub.on('ingested', (e) => {
      if (e.live) this.arrived(e.messageIds);
      else this.sweepSoon();
    });
    hub.on('body', (e) => this.bodyCame(e.messageId));
    hub.on('deleted', (e) => this.forget(e.messageIds));
    hub.on('account', (e) => {
      if (e.state === 'deleted') this.forgetAccount(e.accountId);
    });
    // "Not a person" is a vote down, on the newest decision in that thread.
    hub.on('override', (e) => {
      if (e.class !== 'bulk' || !e.threadId || !this.deps?.votes) return;
      const r = hub.store.one<{ id: string }>(
        `SELECT t.message_id AS id FROM mail_triage t JOIN mail_message m ON m.id = t.message_id WHERE m.thread_id = ? AND t.decision != 'silent' ORDER BY m.received_at DESC LIMIT 1`,
        e.threadId,
      );
      if (r) this.deps.votes.vote(r.id, 'down');
    });
    this.seams();
    // The thread's newest decision goes with its view (the board's mail rows), and each message's with its own.
    hub.store.threadExtras.push((r, v) => {
      const item = this.latest(r.id);
      if (item) v.triage = item;
    });
    hub.store.messageExtras.push((r, v) => {
      const t = hub.store.one<Row>('SELECT * FROM mail_triage WHERE message_id = ?', r.id);
      if (t) v.triage = view(t);
    });
  }

  /** Slice 8's seams: the rating lets a sender nobody knows into the inbox, and the fold hears what was pushed. */
  private seams() {
    const a = mailAttention(this.hub);
    if (!a) return;
    a.triage = (id) => this.rated(id);
    a.triageFacts = (ids) => this.factsOf(ids);
  }

  /** The chat side: its model, its votes, and how a notification goes out (main.ts). */
  connect(deps: MailTriageDeps, now: () => number = Date.now) {
    this.deps = deps;
    this.now = now;
    this.seams();
    const v: OtherVotes = {
      examples: (at) => this.examples(at),
      vote: (id, x, at) => this.vote(id, x, at),
      names: { conversation: (id) => this.threadName(id), space: (id) => this.accountName(id) },
    };
    deps.votes?.others.push(v);
    this.sweepSoon(5_000);
    if (!this.sweepEvery) {
      this.sweepEvery = setInterval(() => this.sweepSoon(0), MAIL_TRIAGE.quietEveryMs);
      this.sweepEvery.unref?.();
    }
  }

  /** The chat votes it learns with, once connected. */
  get votes(): TriageVotes | null {
    return this.deps?.votes ?? null;
  }

  stop() {
    for (const t of this.waiting.values()) clearTimeout(t);
    this.waiting.clear();
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    if (this.sweepEvery) clearInterval(this.sweepEvery);
    this.sweepTimer = this.sweepEvery = null;
  }

  // ---------------------------------------------------------- arrival

  private arrived(ids: string[]) {
    if (!this.deps || !ids.length) return;
    const rows = this.hub.store.all<{ id: string; account_id: string; received_at: number; cached: number }>(
      `SELECT m.id, m.account_id, m.received_at, EXISTS (SELECT 1 FROM mail_body WHERE message_id = m.id) AS cached FROM mail_message m
       WHERE m.id IN (SELECT value FROM json_each(?)) AND m.class = 'personal' AND m.addressed != 'self' AND m.draft = 0
         AND NOT EXISTS (SELECT 1 FROM mail_triage WHERE message_id = m.id)`,
      JSON.stringify(ids),
    );
    const now = this.now();
    for (const r of rows) {
      if (r.cached) {
        this.run(r.id);
        continue;
      }
      if (this.waiting.has(r.id)) continue;
      const t = setTimeout(() => {
        this.waiting.delete(r.id);
        this.run(r.id);
      }, this.bodyWaitMs);
      t.unref?.();
      this.waiting.set(r.id, t);
      // What may notify is fetched ahead of the background's budget (bodies.ts queued it already: this moves it up).
      if (now - r.received_at <= MAIL_TRIAGE.freshMs) {
        this.hub
          .sync(r.account_id)
          ?.fetchBody(r.id, P1)
          .then(
            () => this.bodyCame(r.id),
            () => {},
          );
      }
    }
  }

  private bodyCame(id: string) {
    if (this.asked.delete(id)) return this.run(id, { quiet: true });
    const t = this.waiting.get(id);
    if (!t) return;
    clearTimeout(t);
    this.waiting.delete(id);
    this.run(id);
  }

  private run(id: string, o: DecideOpts = {}) {
    try {
      this.decide(id, this.now(), o);
    } catch (e) {
      // A closed database (the hub stopping), or a message gone meanwhile.
      console.warn(`mail triage: ${(e as Error)?.message ?? e}`);
    }
  }

  // ---------------------------------------------------------- what a sync found, quietly

  /** The quiet pass, soon (once for a run of syncs). */
  sweepSoon(ms = 3_000) {
    if (this.sweepTimer || !this.deps) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      try {
        this.sweep();
      } catch (e) {
        // A closed database (the hub stopping).
        console.warn(`mail triage: ${(e as Error)?.message ?? e}`);
      }
    }, ms);
    this.sweepTimer.unref?.();
  }

  /**
   * Threads the one-list inbox could list, from a sender nobody knows, whose newest message (from someone else) was
   * never rated: rated now, quietly, once its body is here (asked for, and waited for at most quietWaitMs). At most
   * quietPerPass an account; the rest wait for the next pass. Returns how many it rated.
   */
  sweep(now = this.now()): number {
    const st = this.hub.store;
    const a = mailAttention(this.hub);
    if (!this.deps || !a) return 0;
    const threads = a.candidates(now);
    if (!threads.length) return 0;
    const rows = st.all<{ account_id: string; mid: string | null; cached: number }>(
      `SELECT x.account_id, x.mid, EXISTS (SELECT 1 FROM mail_body WHERE message_id = x.mid) AS cached FROM (
         SELECT t.account_id, t.last_at, (SELECT m.id FROM mail_message m WHERE m.thread_id = t.id AND m.class = 'personal' AND m.addressed != 'self' AND m.draft = 0
                                          ORDER BY m.received_at DESC, m.id DESC LIMIT 1) AS mid
         FROM mail_thread t JOIN mail_feature f ON f.thread_id = t.id
         WHERE t.id IN (SELECT value FROM json_each(?)) AND f.unknown = 1) x
       WHERE x.mid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mail_triage WHERE message_id = x.mid)
       ORDER BY x.last_at DESC`,
      JSON.stringify(threads),
    );
    const per = new Map<string, number>();
    const want: string[] = [];
    let rated = 0;
    let more = false;
    for (const r of rows) {
      if (!r.mid || this.waiting.has(r.mid)) continue;
      // Not before its labels and headers are in, and not on a subject alone while its body cannot come.
      if (!settled(st, r.account_id) || (!r.cached && !this.hub.sync(r.account_id)?.workable)) continue;
      const n = per.get(r.account_id) ?? 0;
      if (n >= MAIL_TRIAGE.quietPerPass) {
        more = true;
        continue;
      }
      per.set(r.account_id, n + 1);
      const asked = this.asked.get(r.mid);
      if (r.cached || (asked !== undefined && now - asked >= this.quietWaitMs)) {
        this.asked.delete(r.mid);
        if (this.decide(r.mid, now, { quiet: true })) rated++;
      } else if (asked === undefined) {
        this.asked.set(r.mid, now);
        want.push(r.mid);
        more = true;
      } else more = true;
    }
    if (want.length) bigOf(this.hub)?.prefetch(want);
    // What waits for its body (or a pass's cap) is looked at again a little after its wait.
    if (more) this.sweepSoon(Math.min(this.quietWaitMs, 30_000) + 100);
    return rated;
  }

  /** Decide on one message, keep it, and notify. Returns what was decided; null when it is not one to triage. */
  decide(id: string, now = this.now(), o: DecideOpts = {}): (Decided & { delivered: boolean }) | null {
    const d = this.deps;
    const st = this.hub.store;
    if (!d) return null;
    const m = st.one<Row>('SELECT * FROM mail_message WHERE id = ?', id);
    if (!m || m.class !== 'personal' || m.addressed === 'self' || m.draft || st.one('SELECT 1 FROM mail_triage WHERE message_id = ?', id)) return null;
    const t = st.thread(m.thread_id);
    if (!t) return null;
    const quiet = !!o.quiet;
    const x = this.judge(m, t, now, quiet);
    const ok = !quiet && x.hold === null && (x.decision === 'push' || x.decision === 'quiet');
    st.db
      .query(
        `INSERT INTO mail_triage (message_id, thread_id, account_id, address, decision, level, score, reasons, decided_by, facts, words, probs, delivered, quiet, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        m.thread_id,
        m.account_id,
        lc(m.from_addr) || null,
        x.decision,
        x.level,
        x.score,
        JSON.stringify(x.reasons),
        x.decidedBy,
        x.facts ? JSON.stringify(x.facts) : null,
        JSON.stringify(x.words),
        x.probs ? JSON.stringify(x.probs) : null,
        ok ? 1 : 0,
        quiet ? 1 : 0,
        now,
      );
    // The rating moves the listing (a sender nobody knows, at Active) and the fold (what was pushed).
    st.recompute(m.thread_id);
    if (ok && d.deliver) d.deliver(this.notice(m, x));
    return { ...x, delivered: ok };
  }

  /** The decision, from the facts and the live model, then what keeps it from notifying (`quiet`: everything). */
  private judge(m: Row, t: Row, now: number, quiet = false): Decided {
    const d = this.deps!;
    const st = this.hub.store;
    const from = lc(m.from_addr);
    const sender = from ? (mailPeople(this.hub)?.sender(from) ?? null) : null;
    const person = sender?.personId ? d.store.one<Row>('SELECT * FROM person WHERE id = ?', sender.personId) : null;
    const name = person?.name ?? m.from_name ?? from ?? 'Someone';
    const reasons: string[] = [];
    if (t.muted) {
      reasons.push('Silenced: you muted this thread');
      return { decision: 'silent', level: null, score: null, reasons, decidedBy: 'rules', facts: null, words: [], probs: null, hold: null };
    }
    const body = this.bodyOf(m.id);
    const text = body.text;
    const subject = bareSubject(m.subject);
    const all = `${subject}\n${text}`;
    const mine = st.all<{ received_at: number }>(`SELECT received_at FROM mail_message WHERE thread_id = ? AND addressed = 'self' AND draft = 0 AND received_at < ?`, m.thread_id, m.received_at);
    const reply = !!m.in_reply_to && !!st.one(
      `SELECT 1 FROM mail_message WHERE account_id = ? AND message_id_hdr = ? AND addressed = 'self' AND thread_id IN (SELECT thread_id FROM mail_ref WHERE account_id = ? AND ref = ?)`,
      m.account_id,
      m.in_reply_to,
      m.account_id,
      m.in_reply_to,
    );
    const known = !!sender?.known;
    const f: Omit<Facts, 'base'> = {
      network: 'email',
      shape: 'mail',
      conversation: m.thread_id,
      spaces: [m.account_id],
      author: authorOf(sender, from),
      bot: false,
      mention: m.addressed === 'to',
      everyone: m.addressed === 'cc' || m.addressed === 'hidden',
      reply,
      question: /\?\s*$|\?\s/.test(all),
      urgent: URGENT.test(all),
      active: mine.some((r) => r.received_at >= m.received_at - 30 * MIN),
      media: !!m.has_attachments,
      link: /https?:\/\//.test(text),
      long: text.length > MAIL_TRIAGE.longChars,
      known,
    };
    // How addressed to you it is: what decides whether a stranger's mail is worth the digest.
    let score = 0.15;
    const why: string[] = [];
    if (f.mention) (score += 0.2), why.push('to you');
    if (known) (score += 0.2), why.push('from someone you know');
    if (f.reply) (score += 0.4), why.push('replies to you');
    if (f.question) (score += 0.15), why.push('asks a question');
    if (f.urgent) (score += 0.15), why.push('sounds time-sensitive');
    if (body.spoof) (score -= 0.3), why.push('looks spoofed');
    score = Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;

    const personRule = person ? d.store.rules().find((r) => r.scope === 'person' && r.target === person.id) : null;
    const starred = !!person?.starred || personRule?.level === 'all';
    let base: Level;
    if (starred) (base = 'push'), reasons.push(`From ${name}, who is starred`);
    else if (known && f.mention) (base = 'push'), reasons.push(`${name} wrote to you`);
    else if (known && m.addressed === 'cc') (base = 'quiet'), reasons.push(`${name} copied you in`);
    else {
      // A list (or Bcc) from someone you know, or anything from someone nobody knows: the digest, if it says enough.
      base = 'digest';
      reasons.push(known ? `${name} wrote to a list you are on` : 'From someone you have not written to');
      if (why.length) reasons.push(`Interesting: ${why.join(', ')}`);
    }
    if (body.spoof && base === 'push') {
      base = 'quiet';
      reasons.push(`No buzz: ${body.spoof}`);
    }
    const facts: Facts = { ...f, base, score };
    const ws = wordsOf(all);
    const p = predict(d.triage.learned, facts, ws);
    let level = p.level;
    let decidedBy: Decided['decidedBy'] = 'rules';
    const before = levelFrom(prior(facts));
    if (level !== before) {
      const n = d.triage.namer;
      const words = n ? p.why.slice(0, 2).map((w) => describeWeight(w.feature, w.head, w.by, n)) : [];
      reasons.unshift(`${TIER_NAME[level]}, learned from your votes (was ${TIER_NAME[before]})`, ...words);
      decidedBy = 'learned';
    } else if (level === 'drop') reasons.unshift(`Not interesting enough for the digest (${Math.round(p.probs.interesting * 100)}%)`);
    // A spoofed-looking sender never buzzes, whatever was learned.
    if (body.spoof && level === 'push') {
      level = 'quiet';
      if (!reasons.some((r) => r.startsWith('No buzz:'))) reasons.unshift(`No buzz: ${body.spoof}`);
    }
    let decision: P.TriageDecision = level;
    let hold: string | null = null;
    if (quiet) {
      // Found by a sync: it decides the listing only, so quiet hours have nothing to hold.
      hold = QUIET_REASON;
      reasons.push(hold);
    } else if (level === 'push' || level === 'quiet') {
      const q = d.store.quietHours();
      if (inQuietHours(q, now) && !(q!.allowStarred && starred)) {
        decision = 'digest';
        reasons.unshift(`Held by quiet hours until ${q!.end}`);
        const held = d.store.quietHeld();
        d.store.setQuietHeld({ count: (held?.count ?? 0) + 1, conversationId: m.thread_id, messageId: m.id });
      } else if (m.seen || m.seen_local) hold = 'Already read: no notification';
      else if (now - m.received_at > MAIL_TRIAGE.freshMs) hold = 'Came in late: no notification';
      else if (!st.one(`SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = ? AND b.role = 'inbox'`, m.id)) hold = 'Not in Inbox: no notification';
      if (hold) reasons.push(hold);
    }
    return { decision, level, score: importance(p.probs), reasons, decidedBy, facts, words: ws, probs: rounded(p.probs), hold };
  }

  /** The text the model reads, above any quote, and what the body warns of (slice 3's warnings). */
  private bodyOf(id: string): { text: string; spoof: string | null } {
    let v: P.MailBodyView | null = null;
    try {
      v = this.hub.store.bodyView(id);
    } catch {}
    const raw = v?.text ?? '';
    const text = raw.slice(0, v?.quoteAt ?? raw.length).slice(0, MAIL_TRIAGE.textChars).trim();
    const spoof = v?.warnings.find((w) => /^(The name says|Replies go to|A link that shows)/.test(w)) ?? null;
    return { text, spoof };
  }

  /** What the notification says and shows. */
  private notice(m: Row, x: Decided): MailNotice {
    const from = lc(m.from_addr);
    const w = this.who(from);
    const subject = bareSubject(m.subject);
    const preview = (m.preview ?? '').trim();
    return {
      messageId: m.id,
      threadId: m.thread_id,
      accountId: m.account_id,
      title: w.name ?? m.from_name ?? from ?? 'Someone',
      body: preview ? `${subject} — ${preview}` : subject,
      reasons: x.reasons,
      level: x.decision as 'push' | 'quiet',
      addressed: !!x.facts?.mention || !!x.facts?.reply,
      look: { network: 'email', ...(w.icon ? { icon: w.icon } : {}) },
    };
  }

  /** The name and picture of an address's person (a picture only from a chat identity or one you set). */
  private who(address: string): { key: string; name: string | null; icon: string | null } {
    const chat = this.deps?.store;
    const r = this.hub.store.one<Row>(
      `SELECT i.id, i.person_id, i.display_name, p.name, p.avatar_url FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.network = 'email' AND i.native_id = ?`,
      address,
    );
    let icon: string | null = null;
    if (chat && r?.avatar_url) icon = chat.media(r.avatar_url, null);
    if (chat && !icon && r?.person_id) {
      const a = this.hub.store.one<Row>(`SELECT avatar_url, seen_via FROM identity WHERE person_id = ? AND avatar_url IS NOT NULL AND network != 'email' LIMIT 1`, r.person_id);
      if (a) icon = chat.media(a.avatar_url, a.seen_via ?? null);
    }
    return { key: r?.person_id ?? r?.id ?? address, name: r?.name ?? r?.display_name ?? null, icon: small(icon) ? icon : null };
  }

  // ---------------------------------------------------------- what the rest of mail asks

  /** §14 Q4: the thread's newest decision (from someone else) is Active or above, by your vote or the model's rating. */
  rated(threadId: string): boolean {
    const r = this.hub.store.one<Row>(
      `SELECT t.feedback, t.level, t.decision FROM mail_triage t JOIN mail_message m ON m.id = t.message_id WHERE m.thread_id = ? ORDER BY m.received_at DESC, m.id DESC LIMIT 1`,
      threadId,
    );
    const at = r ? (r.feedback ?? r.level ?? r.decision) : null;
    return at === 'push' || at === 'quiet';
  }

  /** For the fold (mail/attention.ts): pushed means a notification went out. */
  factsOf(ids: string[]): Map<string, MailTriageFacts> {
    const out = new Map<string, MailTriageFacts>();
    if (!ids.length) return out;
    for (const r of this.hub.store.all<Row>('SELECT message_id, delivered, facts, reasons FROM mail_triage WHERE message_id IN (SELECT value FROM json_each(?))', JSON.stringify(ids))) {
      out.set(r.message_id, { pushed: !!r.delivered, question: !!json<Partial<Facts>>(r.facts, {}).question, reason: json<string[]>(r.reasons, [])[0] ?? null });
    }
    return out;
  }

  /** A device rule's chain for a mail thread (devices.ts): the thread, its mail account, Email. Null: not a thread. */
  chain(threadId: string): string[] | null {
    if (!threadId.startsWith('mth_')) return null;
    const t = this.hub.store.one<{ account_id: string }>('SELECT account_id FROM mail_thread WHERE id = ?', threadId);
    return [`conversation:${threadId}`, ...(t ? [`account:${t.account_id}`] : []), 'network:email'];
  }

  // ---------------------------------------------------------- one notification per thread (delivery.ts)

  /**
   * Read since its notification: the first unread message from someone else came after `ts`, or you answered after
   * it. Returned as the time up to which it is read (delivery.ts compares it with the newest shown); null: not mail.
   */
  readTs(threadId: string): number | null {
    if (!threadId.startsWith('mth_')) return null;
    const st = this.hub.store;
    if (!st.thread(threadId)) return Number.MAX_SAFE_INTEGER;
    const r = st.one<{ unread: number | null; mine: number | null }>(
      `SELECT MIN(CASE WHEN addressed != 'self' AND seen = 0 AND seen_local = 0 THEN received_at END) AS unread,
              MAX(CASE WHEN addressed = 'self' THEN received_at END) AS mine
       FROM mail_message WHERE thread_id = ? AND draft = 0`,
      threadId,
    );
    const sent = st.one<{ s: number | null }>('SELECT sent_at AS s FROM mail_feature WHERE thread_id = ?', threadId)?.s ?? 0;
    return Math.max(r?.unread == null ? Number.MAX_SAFE_INTEGER : r.unread - 1, r?.mine ?? 0, sent);
  }

  /** The thread's unread lines from others, oldest first and ending with this one, as chat's (delivery.ts gather). */
  gather(threadId: string, messageId: string): Omit<Grouped, 'alert'> | null {
    if (!threadId.startsWith('mth_')) return null;
    const st = this.hub.store;
    const t = st.thread(threadId);
    const m = st.one<Row>('SELECT received_at FROM mail_message WHERE id = ?', messageId);
    if (!t || !m) return null;
    const rows = st.all<Row>(
      `SELECT m.id, m.received_at, m.from_addr, m.from_name, m.subject, m.preview, m.addressed, m.seen, m.seen_local, tr.decision, tr.quiet
       FROM mail_message m LEFT JOIN mail_triage tr ON tr.message_id = m.id
       WHERE m.thread_id = ? AND m.draft = 0 AND m.received_at <= ? ORDER BY m.received_at DESC, m.id DESC LIMIT 40`,
      threadId,
      m.received_at,
    );
    const lines: (Line & { subject: string })[] = [];
    const icons: Record<string, string> = {};
    let sender: Grouped['sender'] | null = null;
    let others = 0;
    for (const r of rows) {
      const own = r.id === messageId;
      if (!own && (r.addressed === 'self' || r.seen || r.seen_local)) break;
      others++;
      // What was rated quietly (a sync found it) is never a line.
      if (!own && (r.quiet || !['push', 'quiet', 'digest'].includes(r.decision))) continue;
      if (lines.length >= MAIL_TRIAGE.lines && !own) continue;
      const w = this.who(lc(r.from_addr));
      const author = w.name ?? r.from_name ?? r.from_addr ?? 'Someone';
      const subject = bareSubject(r.subject);
      lines.push({ author, key: w.key, body: (r.preview ?? '').trim().slice(0, 200) || subject, ts: r.received_at, subject });
      if (w.icon) icons[w.key] ??= w.icon;
      if (own) sender = { name: author, key: w.key, ...(icons[w.key] ? { icon: icons[w.key] } : {}) };
    }
    if (!sender) return null;
    lines.reverse();
    // The subject goes before the first line, and before any whose subject changed.
    const out: Line[] = lines.map((l, i) => ({ author: l.author, key: l.key, ts: l.ts, body: (i === 0 || l.subject !== lines[i - 1].subject) && l.body !== l.subject ? `${l.subject.slice(0, 80)} — ${l.body}` : l.body }));
    const self = st.selfAddresses(t.account_id);
    const people = json<{ e: string }[]>(t.participants, []).filter((p) => p.e && !self.has(p.e)).length;
    const shape = people <= 1 ? 'direct' : 'group';
    const g: Omit<Grouped, 'alert'> = {
      count: Math.max(t.unread ?? 0, others),
      conv: { title: shape === 'direct' ? sender.name : bareSubject(t.subject), shape, ...(shape === 'direct' && sender.icon ? { icon: sender.icon } : {}) },
      sender,
      lines: out,
      icons,
    };
    return fit(g);
  }

  // ---------------------------------------------------------- votes

  /** Up or down a level from where it is now, or to one; null takes it back. Undefined: not a mail message. */
  vote(id: string, v: Vote, now = this.now()): Level | null | undefined {
    if (!id.startsWith('mml_')) return undefined;
    const st = this.hub.store;
    const t = st.one<Row>('SELECT t.decision, t.feedback, m.thread_id FROM mail_triage t LEFT JOIN mail_message m ON m.id = t.message_id WHERE t.message_id = ?', id);
    if (!t) throw new Error('Triage never decided on this message');
    if (!isTier(t.decision)) throw new Error('This thread is muted: unmute it instead');
    const cur = (t.feedback ?? t.decision) as Level;
    const target = v === null ? null : v === 'up' ? tierUp(cur) : v === 'down' ? tierDown(cur) : v;
    if (target !== null && !isTier(target)) throw new Error('Unknown level');
    st.db.query('UPDATE mail_triage SET feedback = ?, feedback_at = ? WHERE message_id = ?').run(target, target === null ? null : now, id);
    if (t.thread_id) st.recompute(t.thread_id);
    return target;
  }

  /** Every vote on mail, and the newest notifications you let stand in each thread (votes.ts examples). */
  examples(now = this.now()): Example[] {
    const st = this.hub.store;
    const out: Example[] = [];
    const authors = new Map<string, string | null>();
    // The author as they are now: a merge since the vote counts (Sam's mail and Sam's chats are one person).
    const author = (address: string | null, f: Facts): Facts => {
      if (!address) return f;
      if (!authors.has(address)) authors.set(address, authorOf(mailPeople(this.hub)?.sender(address) ?? null, address));
      const a = authors.get(address);
      return a && a !== f.author ? { ...f, author: a } : f;
    };
    for (const r of st.all<Row>(`SELECT address, facts, words, feedback, feedback_at FROM mail_triage WHERE feedback IS NOT NULL AND facts IS NOT NULL ORDER BY feedback_at DESC LIMIT 5000`)) {
      out.push({ facts: author(r.address, JSON.parse(r.facts)), words: json<string[]>(r.words, []), label: r.feedback, weight: voteWeight(r.feedback_at ?? now, now), vote: true, at: r.feedback_at ?? 0 });
    }
    const stood = st.all<Row>(
      `SELECT address, decision, facts, created_at FROM (
         SELECT address, decision, facts, created_at, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC) AS n
         FROM mail_triage WHERE feedback IS NULL AND facts IS NOT NULL AND delivered = 1 AND decision IN ('push', 'quiet') AND created_at > ? AND created_at < ?)
       WHERE n <= ?`,
      now - 30 * DAY,
      now - DAY / 2,
      STOOD_PER_PLACE,
    );
    for (const r of stood) out.push({ facts: author(r.address, JSON.parse(r.facts)), words: [], label: r.decision, weight: STOOD, vote: false, at: r.created_at });
    return out;
  }

  // ---------------------------------------------------------- the board

  /** The board's mail: what was decided in the last week (what fell below the digest, two days), newest first. */
  items(since: number, now = this.now()): P.MailTriageItem[] {
    const below = Math.max(since, now - MAIL_TRIAGE.belowDays * DAY);
    const rows = this.hub.store.all<Row>(
      `SELECT t.*, m.thread_id AS tid, m.from_addr, m.from_name, m.subject, m.preview, m.received_at, m.seen, m.seen_local
       FROM mail_triage t JOIN mail_message m ON m.id = t.message_id
       WHERE t.decision != 'silent' AND t.created_at >= ? AND (COALESCE(t.feedback, t.decision) != 'drop' OR t.created_at >= ?)
       ORDER BY t.created_at DESC LIMIT 500`,
      since,
      below,
    );
    const who = this.hub.store.whoIs([...new Set(rows.map((r) => lc(r.from_addr)).filter(Boolean))]);
    return rows.map((r) => itemOf(r, who.get(lc(r.from_addr))));
  }

  /** A thread's newest decision, for its view. */
  private latest(threadId: string): P.MailTriageItem | null {
    const r = this.hub.store.one<Row>(
      `SELECT t.*, m.thread_id AS tid, m.from_addr, m.from_name, m.subject, m.preview, m.received_at, m.seen, m.seen_local
       FROM mail_triage t JOIN mail_message m ON m.id = t.message_id WHERE m.thread_id = ? AND t.decision != 'silent' ORDER BY m.received_at DESC, m.id DESC LIMIT 1`,
      threadId,
    );
    if (!r) return null;
    return itemOf(r, this.hub.store.whoIs([lc(r.from_addr)]).get(lc(r.from_addr)));
  }

  // ---------------------------------------------------------- names, for what was learned in words (votes.ts namer)

  private threadName(id: string): string | null {
    if (!id.startsWith('mth_')) return null;
    const t = this.hub.store.one<{ subject: string }>('SELECT subject FROM mail_thread WHERE id = ?', id);
    return t ? `the mail “${bareSubject(t.subject)}”` : 'a mail thread';
  }

  private accountName(id: string): string | null {
    const a = this.hub.store.account(id);
    return a ? `your mail at ${a.address ?? a.label}` : null;
  }

  // ---------------------------------------------------------- gone

  /** Messages the server no longer has: their decisions go, unless you voted on one (it is still learned from). */
  private forget(ids: string[]) {
    if (!ids.length) return;
    for (const id of ids) {
      const t = this.waiting.get(id);
      if (t) clearTimeout(t), this.waiting.delete(id);
    }
    this.hub.store.db.query('DELETE FROM mail_triage WHERE feedback IS NULL AND message_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
  }

  /** An account's mail went (§14 Q6): its decisions too; a vote keeps its facts, not its words. */
  private forgetAccount(accountId: string) {
    const db = this.hub.store.db;
    db.query('DELETE FROM mail_triage WHERE account_id = ? AND feedback IS NULL').run(accountId);
    db.query('UPDATE mail_triage SET words = NULL WHERE account_id = ?').run(accountId);
  }
}

/** Their person, else their identity, else the identity their address would have: as chat keys an author. */
function authorOf(s: Pick<MailSender, 'personId' | 'identityId'> | null, address: string | null): string | null {
  return s?.personId ?? s?.identityId ?? (address ? hubId('idn', 'email', address) : null);
}

function view(t: Row): P.TriageView {
  return { decision: t.decision, score: t.score ?? null, reasons: json<string[]>(t.reasons, []), decidedBy: t.decided_by, feedback: t.feedback ?? null, probs: json<P.TriageProbs | null>(t.probs, null) };
}

function itemOf(r: Row, who: { identityId: string; personId: string | null } | undefined): P.MailTriageItem {
  return {
    kind: 'mail',
    id: r.message_id,
    threadId: r.tid,
    accountId: r.account_id,
    from: { name: r.from_name ?? null, email: r.from_addr ?? '', ...(who ? { identityId: who.identityId, ...(who.personId ? { personId: who.personId } : {}) } : {}) },
    subject: r.subject ?? '',
    preview: r.preview ?? null,
    ts: r.received_at,
    unread: !r.seen && !r.seen_local,
    triage: view(r),
  };
}

const TRIAGES = new WeakMap<MailHub, MailTriage>();

/** The hub's mail triage; null on a hub made without this router. */
export function mailTriage(hub: MailHub | null | undefined): MailTriage | null {
  return (hub && TRIAGES.get(hub)) ?? null;
}

const ok = (x: unknown = { ok: true }) => Response.json(x);
const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** Slice 9: triage and notifications. */
export const triageRoutes: MailRouter = (hub) => {
  const t = new MailTriage(hub);
  TRIAGES.set(hub, t);
  hub.stopping.push(() => t.stop());
  return [
    {
      // The Triage board's mail (?since=<ms>, else the last week).
      method: 'GET',
      path: /^\/api\/mail\/triage$/,
      handle: ({ url }) => {
        const since = Number(url.searchParams.get('since')) || Date.now() - MAIL_TRIAGE.boardDays * DAY;
        return ok({ items: t.items(since) } satisfies P.MailTriagePage);
      },
    },
    {
      // { vote: up | down } or { level: push | quiet | digest | drop | null }, as /api/messages/:id/feedback takes.
      method: 'POST',
      path: /^\/api\/mail\/triage\/([\w-]+)\/vote$/,
      handle: async ({ params, body }) => {
        const b = await body<{ vote?: unknown; level?: unknown; feedback?: unknown }>();
        const lv = b.level !== undefined ? b.level : b.feedback;
        const v: Vote | undefined = b.vote === 'up' || b.vote === 'down' ? b.vote : lv === null || isTier(lv) ? (lv as Vote) : undefined;
        if (v === undefined) return bad('Say vote: up or down, or level: a level or null');
        const votes = t.votes;
        try {
          if (votes) return ok(votes.vote(params[0], v));
          return ok({ feedback: t.vote(params[0], v) ?? null });
        } catch (e) {
          return bad((e as Error).message, 409);
        }
      },
    },
  ];
};
