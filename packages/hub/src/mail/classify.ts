/**
 * "From a person" (docs/mail.md, docs/mail-design.md §4): each message gets a class by the first rule that matches,
 * and the rule is kept as `class_why`. A thread is personal if any message in it is, else bulk if any is, else yours.
 *
 *   1  your override, for the thread or the sender         as set   thread / sender
 *   2  sent from one of your addresses                     self     self
 *   3  the thread holds a message you sent                 personal mine
 *   4  you have written to this address                    personal wrote
 *   5  their person is someone you know otherwise           personal merged
 *      (a chat identity you merged them with, another address you write to)
 *   6  in a junk mailbox                                   bulk     junk
 *   7  list or machine headers (List-Id, List-Unsubscribe, bulk     list
 *      Precedence bulk/list/junk, Auto-Submitted but `no`)
 *   8  a category label (Gmail's CATEGORY_PROMOTIONS,     bulk     category
 *      Proton's Category/Newsletters, …)
 *   9  an automated local part (no-reply, notifications, …) bulk    automated
 *  10  more than 10 recipients, you in none of To and Cc   bulk     crowd
 *  11  anything else: someone who looks human              personal unknown
 *
 * Rules 3–5 come before the bulk rules, so a newsletter's author you write to still counts as a person. Everything here
 * is metadata; triage (slice 9) adds what the text says. A thread personal only by rule 11 is `unknown`: it stays in
 * Mail, and reaches the one-list inbox only when triage rates it Active or above (§14 Q4; mail/attention.ts
 * `MailAttention.triage` is where that rating plugs in).
 *
 * MailStore.recomputed classifies a thread's messages as the thread is worked out, in the same transaction, so views
 * and the inbox read the class at once. What one thread changes about a sender (you wrote to them) reaches their other
 * threads a moment later (`recheck`). Your overrides go through `override`.
 */
import type * as P from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { unref } from '../clock.ts';
import type { Store } from '../store.ts';
import type { MailHub } from './index.ts';
import { mailPeople, type MailSender } from './people.ts';
import type { MailRouter } from './routes.ts';

type Row = Record<string, any>;

declare module './index.ts' {
  interface MailHubEvents {
    /** You said a thread or a sender is a person or not (null: the rules decide again). "Not a person" is a vote down (slice 9). */
    override: { threadId: string | null; address: string | null; class: 'personal' | 'bulk' | null };
  }
}

export type MailClass = 'personal' | 'bulk' | 'self';
export type ClassWhy = 'thread' | 'sender' | 'self' | 'mine' | 'wrote' | 'merged' | 'junk' | 'list' | 'category' | 'automated' | 'crowd' | 'unknown';
export type Override = 'personal' | 'bulk';

/** The rules whose answer a sender you come to know overturns (rules 4 and 5 come before them). */
export const SENDER_MAY_CHANGE: ClassWhy[] = ['junk', 'list', 'category', 'automated', 'crowd', 'unknown'];

/** What one message's class is decided from. */
export interface ClassifyFacts {
  addressed: 'to' | 'cc' | 'hidden' | 'self';
  fromAddr: string | null;
  /** In To and Cc. */
  recipients: number;
  bulk: M.MailBulk | null;
  labels: string[];
  inJunk: boolean;
  /** The thread holds a message you sent (not a draft). */
  threadMine: boolean;
  threadOverride: Override | null;
  senderOverride: Override | null;
  /** mailPeople(hub).sender(from); asked only when rules 1–3 did not decide. */
  sender: () => Pick<MailSender, 'wroteTo' | 'tookPart' | 'chat' | 'known'> | null;
}

/** Local parts that send for a machine, not a person (rule 9). */
const AUTOMATED = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|alerts?|news(?:letters?)?|mailer-daemon|postmaster|bounces?|marketing|updates?|digest)(?:$|[-_.+])/i;
/**
 * Category labels: Gmail's (CATEGORY_PROMOTIONS, …), and Proton's own sorting, which its extractor spells
 * `Category/Social`, `Category/Promotions`, `Category/Updates`, `Category/Newsletters` and `Category/Transactions`
 * (receipts and sign-in codes: a machine's mail, not a person's).
 */
const CATEGORY = /^\\?(?:category[_/ :-]?)(?:promotions|social|updates|forums|newsletters?|transactions?)$/i;
const PRECEDENCE = /^(?:bulk|list|junk)$/i;

export function automatedAddress(address: string | null | undefined): boolean {
  const local = (address ?? '').split('@')[0] ?? '';
  return !!local && AUTOMATED.test(local);
}

export function bulkHeaders(b: M.MailBulk | null | undefined): boolean {
  if (!b) return false;
  if (b.listId || b.unsubscribe) return true;
  if (b.precedence && PRECEDENCE.test(b.precedence.trim())) return true;
  return !!b.autoSubmitted && b.autoSubmitted.trim().toLowerCase() !== 'no';
}

/** §4's rules, in order: the first that matches decides. Pure. */
export function classify(f: ClassifyFacts): { class: MailClass; why: ClassWhy } {
  if (f.threadOverride) return { class: f.threadOverride, why: 'thread' };
  if (f.senderOverride && f.addressed !== 'self') return { class: f.senderOverride, why: 'sender' };
  if (f.addressed === 'self') return { class: 'self', why: 'self' };
  if (f.threadMine) return { class: 'personal', why: 'mine' };
  const s = f.fromAddr ? f.sender() : null;
  if (s && (s.wroteTo > 0 || s.tookPart)) return { class: 'personal', why: 'wrote' };
  if (s && (s.chat || s.known)) return { class: 'personal', why: 'merged' };
  if (f.inJunk) return { class: 'bulk', why: 'junk' };
  if (bulkHeaders(f.bulk)) return { class: 'bulk', why: 'list' };
  if (f.labels.some((l) => CATEGORY.test(l))) return { class: 'bulk', why: 'category' };
  if (automatedAddress(f.fromAddr)) return { class: 'bulk', why: 'automated' };
  if (f.recipients > 10 && f.addressed === 'hidden') return { class: 'bulk', why: 'crowd' };
  return { class: 'personal', why: 'unknown' };
}

/** A thread's class from its messages', and whether it is personal only by rule 11. */
export function threadClass(ms: { class: MailClass; why: ClassWhy }[]): { class: MailClass; unknown: boolean } {
  const personal = ms.filter((m) => m.class === 'personal');
  if (personal.length) return { class: 'personal', unknown: personal.every((m) => m.why === 'unknown') };
  return { class: ms.some((m) => m.class === 'bulk') ? 'bulk' : 'self', unknown: false };
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

/** Threads per background step. */
const STEP = 300;

export interface ClassChange {
  threadId: string;
  class: MailClass | null;
  unknown: boolean;
}

export class MailClassifier {
  /** Senders as mailPeople says, for one synchronous run of ingest (cleared after it). */
  private senders = new Map<string, MailSender>();
  private clearing = false;
  /** Addresses you just wrote to: their other threads may now be from a person. */
  private recheck = new Set<string>();
  /** Threads from before this existed, to classify in the background. */
  private backlog: string[] = [];
  private timer: unknown = null;
  /** After a thread's class or `unknown` changed (mail/attention.ts listens). */
  readonly changed: ((c: ClassChange) => void)[] = [];

  /** Nothing waits for a background step. */
  get idle(): boolean {
    return !this.timer && !this.recheck.size && !this.backlog.length;
  }

  constructor(private hub: MailHub) {
    hub.store.recomputed.push((id, ms) => this.recomputed(id, ms));
    hub.store.threadExtras.push((r, v) => {
      if (v.class === 'personal') v.unknown = this.unknownOf(r.id);
    });
    // Mail stored before classification existed (or before its rules last changed): once, in the background.
    this.backlog = hub.store.all<{ id: string }>(`SELECT DISTINCT thread_id AS id FROM mail_message WHERE class IS NULL OR class_why IS NULL`).map((r) => r.id);
    this.schedule();
  }

  /** A merge or a split moves who is known (rule 5): those people's addresses are looked at again. */
  connect(chat: Store) {
    const prev = chat.personsChanged;
    chat.personsChanged = (ids) => {
      prev?.(ids);
      const rows = this.hub.store.all<{ native_id: string }>(`SELECT native_id FROM identity WHERE network = 'email' AND person_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
      for (const r of rows) this.recheck.add(r.native_id);
      this.schedule();
    };
  }

  stop() {
    if (this.timer) this.hub.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private unknownOf(threadId: string): boolean {
    return !!this.hub.store.one<{ unknown: number }>('SELECT unknown FROM mail_feature WHERE thread_id = ?', threadId)?.unknown;
  }

  private sender(address: string): MailSender | null {
    const people = mailPeople(this.hub);
    if (!people) return null;
    let s = this.senders.get(address);
    if (!s) {
      this.senders.set(address, (s = people.sender(address)));
      if (!this.clearing) {
        this.clearing = true;
        // The rest of this ingest shares what it found; anything after it asks again.
        queueMicrotask(() => {
          this.senders.clear();
          this.clearing = false;
        });
      }
    }
    return s;
  }

  /** MailStore.recompute's hook: the thread's messages as they are now (none: it went). */
  private recomputed(threadId: string, ms: Row[]) {
    if (!ms.length) {
      this.hub.store.db.query('DELETE FROM mail_override WHERE scope = ? AND key = ?').run('thread', threadId);
      return;
    }
    this.classifyRows(threadId, ms);
  }

  /** Classify one thread again, from the database (after an override, a sender you came to know). */
  classifyThread(threadId: string): boolean {
    const ms = this.hub.store.all('SELECT * FROM mail_message WHERE thread_id = ? ORDER BY received_at, id', threadId);
    if (!ms.length) return false;
    return this.classifyRows(threadId, ms);
  }

  /** Each message's class, then the thread's. Returns whether the thread's changed. */
  private classifyRows(threadId: string, ms: Row[]): boolean {
    const st = this.hub.store;
    const db = st.db;
    const mine = ms.some((m) => m.addressed === 'self' && !m.draft);
    const froms = [...new Set(ms.map((m) => lc(m.from_addr)).filter(Boolean))];
    const overrides = new Map(
      st.all<{ scope: string; key: string; class: Override }>(
        `SELECT scope, key, class FROM mail_override WHERE (scope = 'thread' AND key = ?) OR (scope = 'sender' AND key IN (SELECT value FROM json_each(?)))`,
        threadId,
        JSON.stringify(froms),
      ).map((o) => [`${o.scope}:${o.key}`, o.class]),
    );
    const junk = new Set(
      st.all<{ id: string }>(`SELECT DISTINCT l.message_id AS id FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id JOIN mail_message m ON m.id = l.message_id WHERE m.thread_id = ? AND b.role = 'junk'`, threadId).map((r) => r.id),
    );
    const out: { class: MailClass; why: ClassWhy }[] = [];
    const set = db.query('UPDATE mail_message SET class = ?, class_why = ? WHERE id = ?');
    for (const m of ms) {
      const from = lc(m.from_addr) || null;
      const c = classify({
        addressed: m.addressed,
        fromAddr: from,
        recipients: json<unknown[]>(m.to_json, []).length + json<unknown[]>(m.cc_json, []).length,
        bulk: json<M.MailBulk | null>(m.bulk, null),
        labels: json<string[]>(m.labels, []),
        inJunk: junk.has(m.id),
        threadMine: mine,
        threadOverride: overrides.get(`thread:${threadId}`) ?? null,
        senderOverride: (from && overrides.get(`sender:${from}`)) || null,
        sender: () => (from ? this.sender(from) : null),
      });
      out.push(c);
      if (m.class !== c.class || m.class_why !== c.why) {
        set.run(c.class, c.why, m.id);
        m.class = c.class;
        m.class_why = c.why;
      }
      // You wrote to them: their mail elsewhere may be from a person now (rule 4).
      if (m.addressed === 'self' && !m.draft) for (const a of [...json<M.MailAddress[]>(m.to_json, []), ...json<M.MailAddress[]>(m.cc_json, [])]) if (a?.email) this.recheck.add(lc(a.email));
    }
    if (mine) for (const m of ms) if (m.addressed !== 'self' && m.from_addr) this.recheck.add(lc(m.from_addr));
    for (const e of st.selfAddresses(ms[0].account_id)) this.recheck.delete(e);
    if (this.recheck.size) this.schedule();
    const t = threadClass(out);
    const was = st.one<{ class: string | null }>('SELECT class FROM mail_thread WHERE id = ?', threadId);
    const unknownWas = this.unknownOf(threadId);
    if (was?.class === t.class && unknownWas === t.unknown) return false;
    db.query('UPDATE mail_thread SET class = ? WHERE id = ?').run(t.class, threadId);
    db.query('INSERT INTO mail_feature (thread_id, unknown) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET unknown = excluded.unknown').run(threadId, t.unknown ? 1 : 0);
    st.dirty.threads.add(threadId);
    for (const f of this.changed) f({ threadId, class: t.class, unknown: t.unknown });
    return true;
  }

  private schedule() {
    if (this.timer) return;
    this.timer = this.hub.clock.setTimeout(() => this.drain(), 0);
    unref(this.timer);
  }

  /** In the background: senders whose standing moved, then mail from before, a step at a time. */
  private drain() {
    this.timer = null;
    const st = this.hub.store;
    const touched: string[] = [];
    try {
      if (this.recheck.size) {
        // A step of at most STEP threads: one sender can have many. Those it did not reach are asked again next time
        // (the ones it reached no longer match).
        const addrs = [...this.recheck].slice(0, STEP);
        const ids = st
          .all<{ id: string }>(
            `SELECT DISTINCT thread_id AS id FROM mail_message WHERE from_addr IN (SELECT value FROM json_each(?)) AND (class_why IS NULL OR class_why IN (SELECT value FROM json_each(?))) LIMIT ?`,
            JSON.stringify(addrs),
            JSON.stringify(SENDER_MAY_CHANGE),
            STEP,
          )
          .map((r) => r.id);
        st.db.transaction(() => {
          for (const id of ids) if (this.classifyThread(id)) touched.push(id);
        })();
        // All reached, or nothing moved (they would come back the same): these senders are done.
        if (ids.length < STEP || !touched.length) for (const a of addrs) this.recheck.delete(a);
      } else if (this.backlog.length) {
        const step = this.backlog.splice(0, STEP);
        st.db.transaction(() => {
          for (const id of step) if (this.classifyThread(id)) touched.push(id);
        })();
      }
    } catch (e) {
      // A closed database (the hub stopping): the rest waits for the next change.
      console.warn(`mail classify: ${(e as Error)?.message ?? e}`);
      return;
    }
    // Senders of mail now personal get their identity (slice 6).
    if (touched.length) mailPeople(this.hub)?.settle(touched);
    if (this.recheck.size || this.backlog.length) this.schedule();
  }

  // ---------------------------------------------------------- your overrides (rule 1)

  /** "This is a person" / "Not a person" for a sender (null: decide by the rules again). */
  setSender(address: string, value: Override | null): string[] {
    const a = lc(address);
    if (!a) return [];
    this.put('sender', a, value);
    const ids = this.hub.store.all<{ id: string }>('SELECT DISTINCT thread_id AS id FROM mail_message WHERE from_addr = ?', a).map((r) => r.id);
    return this.again(ids);
  }

  /** The same for one thread. */
  setThread(threadId: string, value: Override | null): string[] {
    this.put('thread', threadId, value);
    return this.again([threadId]);
  }

  /**
   * A row's "Not a person" (false), "This is a person" (true), or back to the rules (null): the thread, and its latest
   * sender who is not you. Returns that sender.
   */
  person(threadId: string, person: boolean | null): string | null {
    const t = this.hub.store.thread(threadId);
    if (!t) return null;
    const self = this.hub.store.selfAddresses(t.account_id);
    const from = this.hub.store.one<{ a: string }>(`SELECT from_addr AS a FROM mail_message WHERE thread_id = ? AND from_addr IS NOT NULL AND addressed != 'self' ORDER BY received_at DESC, id DESC LIMIT 1`, threadId)?.a ?? null;
    const sender = from && !self.has(lc(from)) ? lc(from) : null;
    const value: Override | null = person === null ? null : person ? 'personal' : 'bulk';
    this.hub.store.db.transaction(() => {
      // "This is a person" needs no thread override: the sender's is enough, and a thread you marked bulk is let go.
      this.put('thread', threadId, value === 'bulk' ? 'bulk' : null);
      if (sender) this.put('sender', sender, value);
    })();
    const ids = sender ? this.hub.store.all<{ id: string }>('SELECT DISTINCT thread_id AS id FROM mail_message WHERE from_addr = ?', sender).map((r) => r.id) : [];
    this.again([...new Set([threadId, ...ids])]);
    this.hub.emit('override', { threadId, address: sender, class: value });
    return sender;
  }

  /** What you set for a sender, if anything. */
  overrideOf(scope: 'sender' | 'thread', key: string): Override | null {
    return this.hub.store.one<{ class: Override }>('SELECT class FROM mail_override WHERE scope = ? AND key = ?', scope, scope === 'sender' ? lc(key) : key)?.class ?? null;
  }

  private put(scope: 'sender' | 'thread', key: string, value: Override | null) {
    const db = this.hub.store.db;
    if (value) db.query('INSERT INTO mail_override (scope, key, class, at) VALUES (?, ?, ?, ?) ON CONFLICT (scope, key) DO UPDATE SET class = excluded.class, at = excluded.at').run(scope, key, value, Date.now());
    else db.query('DELETE FROM mail_override WHERE scope = ? AND key = ?').run(scope, key);
  }

  private again(ids: string[]): string[] {
    const changed: string[] = [];
    this.hub.store.db.transaction(() => {
      for (const id of ids) if (this.classifyThread(id)) changed.push(id);
    })();
    for (const id of ids) this.hub.store.dirty.threads.add(id);
    if (changed.length) mailPeople(this.hub)?.settle(changed);
    return changed;
  }
}

const CLASSIFIERS = new WeakMap<MailHub, MailClassifier>();

/** The hub's classifier; null on a hub made without this router. */
export function mailClassifier(hub: MailHub | null | undefined): MailClassifier | null {
  return (hub && CLASSIFIERS.get(hub)) ?? null;
}

const ok = (x: unknown = { ok: true }) => Response.json(x);
const bad = (error: string, status = 400) => Response.json({ error }, { status });
const overrideOf = (v: unknown): Override | null | undefined => (v === 'person' || v === 'personal' ? 'personal' : v === 'bulk' ? 'bulk' : v === null ? null : undefined);

/** Slice 8's classification: your overrides. */
export const classifyRoutes: MailRouter = (hub) => {
  const c = new MailClassifier(hub);
  CLASSIFIERS.set(hub, c);
  hub.stopping.push(() => c.stop());
  return [
    {
      // "This is a person" / "Not a person" for a sender, or null to let the rules decide (§5).
      method: 'PUT',
      path: /^\/api\/mail\/senders\/([^/]+)$/,
      handle: async ({ params, body }) => {
        const b = await body<{ override?: unknown }>();
        const v = overrideOf(b.override);
        if (v === undefined) return bad('override is person, bulk or null');
        if (!params[0].includes('@')) return bad('not an address');
        c.setSender(params[0], v);
        return ok({ ok: true, override: v });
      },
    },
    {
      // A thread row's "This is a person" (true), "Not a person" (false), or the rules again (null).
      method: 'PUT',
      path: /^\/api\/mail\/threads\/([\w-]+)\/person$/,
      handle: async ({ params, body }) => {
        if (!hub.store.thread(params[0])) return bad('no such thread', 404);
        const b = await body<{ person?: unknown }>();
        if (b.person !== true && b.person !== false && b.person !== null) return bad('person is true, false or null');
        const sender = c.person(params[0], b.person);
        const t = hub.store.thread(params[0]);
        return ok({ ok: true, sender, thread: t ? (hub.store.threadView(t) satisfies P.MailThreadView) : null });
      },
    },
  ];
};
