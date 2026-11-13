/**
 * People in mail (docs/mail.md, docs/mail-design.md §9): addresses become identities on the `email` network, and the
 * ones you correspond with become persons, so mail joins the people the hub already knows.
 *
 * - **An identity** for everyone you wrote to, everyone who wrote in a thread you took part in, and any other sender
 *   whose mail is classed personal (`mail_message.class`, slice 8). Bulk senders never get one.
 * - **A person** for the first two, as a DM partner gets one: their own. It joins anyone else only by your merge,
 *   never by name; the profile's "same name elsewhere" hint suggests it.
 * - **The name** is the one on their latest From, else the one you wrote to them under.
 * - When an account's mail is deleted (24 h after access ended), identities with no mail left go too, unless their
 *   person is one you named or merged.
 *
 * mail_party (schema-people.sql) says who is on each thread and how. MailStore.recompute's hook keeps it, inside the
 * same transaction, so `sender()` is right as soon as an ingest returns. Identities and persons follow each ingest at
 * once; a big change (an account's own addresses becoming known, a first start with old mail) goes a few hundred
 * threads at a time in the background.
 *
 * Slice 8 asks `mailPeople(hub).sender(address)` whether a sender is someone you know.
 */
import type * as P from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import type { Store } from '../store.ts';
import type { MailHub } from './index.ts';
import type { MailRouter } from './routes.ts';
import { jobFailed } from '../errors.ts';

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

/** What the hub knows of one address as a correspondent (§4's rules 4 and 5 read this). */
export interface MailSender {
  address: string;
  identityId: string | null;
  personId: string | null;
  /** Messages of yours to them, in To or Cc (drafts not counted). */
  wroteTo: number;
  /** Messages from them. */
  wroteYou: number;
  /** They wrote in a thread you wrote in. */
  tookPart: boolean;
  /** Their person also holds an identity on a chat network: you merged them. */
  chat: boolean;
  /**
   * Someone you correspond with: you wrote to them, they wrote in a thread you took part in, or their person is known
   * that way through another address or a chat identity.
   */
  known: boolean;
}

/** Threads per background step. */
const STEP = 300;

export class MailPeople {
  private chat: Store | null = null;
  /** Threads whose people may have changed. */
  private pending = new Set<string>();
  /** Threads to work out mail_party for, from before it existed. */
  private rebuild: string[] = [];
  private timer: unknown = null;

  /** Nothing waits for a background step. */
  get idle(): boolean {
    return !this.timer && !this.rebuild.length && !this.pending.size;
  }

  constructor(private hub: MailHub) {
    const s = hub.store;
    s.recomputed.push((id, ms) => this.party(id, ms));
    s.whoIs = (addrs) => this.whoIs(addrs);
    s.addressesOf = (who) => this.addressesOf(who);
    hub.on('ingested', (e) => this.ingested(e.messageIds));
    hub.on('account', (e) => {
      if (e.state === 'deleted') this.forget();
    });
  }

  /** The chat store, where identities and persons live. Until then mail_party is kept, and nobody is made. */
  connect(chat: Store) {
    this.chat = chat;
    chat.personsChanged = (ids) => this.personsChanged(ids);
    const db = this.hub.store.db;
    // Mail stored before this existed: who is on each of its threads, once.
    this.rebuild = (db.query('SELECT id FROM mail_thread t WHERE NOT EXISTS (SELECT 1 FROM mail_party p WHERE p.thread_id = t.id)').all() as Row[]).map((r) => r.id);
    this.schedule();
  }

  stop() {
    if (this.timer) this.hub.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------- mail_party

  /** A thread was worked out again (MailStore.recompute): who is on it, and how. */
  private party(threadId: string, ms: Row[]) {
    const db = this.hub.store.db;
    db.query('DELETE FROM mail_party WHERE thread_id = ?').run(threadId);
    this.pending.add(threadId);
    this.schedule();
    if (!ms.length) return;
    const accountId: string = ms[0].account_id;
    const self = this.hub.store.selfAddresses(accountId);
    const mine = ms.some((m) => m.addressed === 'self' && !m.draft);
    const lastAt = Math.max(...ms.map((m) => m.received_at));
    const rows = new Map<string, { sent: number; got: number; name: string | null; from: number; at: number }>();
    const row = (email: string | null | undefined) => {
      const e = lc(email);
      if (!e || self.has(e)) return null;
      let r = rows.get(e);
      if (!r) rows.set(e, (r = { sent: 0, got: 0, name: null, from: 0, at: 0 }));
      return r;
    };
    const named = (name: string | null | undefined, email: string) => {
      const n = (name ?? '').trim();
      return n && lc(n) !== lc(email) ? n : null;
    };
    for (const m of ms) {
      const f = row(m.from_addr);
      if (f) {
        f.sent++;
        const n = named(m.from_name, m.from_addr);
        if (n && (!f.from || m.received_at >= f.at)) Object.assign(f, { name: n, from: 1, at: m.received_at });
      }
      const own = m.addressed === 'self' && !m.draft;
      for (const a of [...json<M.MailAddress[]>(m.to_json, []), ...json<M.MailAddress[]>(m.cc_json, [])]) {
        const r = row(a.email);
        if (!r) continue;
        if (own) r.got++;
        const n = named(a.name, a.email);
        if (n && !r.from && m.received_at >= r.at) Object.assign(r, { name: n, at: m.received_at });
      }
    }
    const put = db.query('INSERT INTO mail_party (address, thread_id, account_id, sent, got, mine, name, name_from, name_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [e, r] of rows) put.run(e, threadId, accountId, r.sent, r.got, mine ? 1 : 0, r.name, r.from, r.at, lastAt);
  }

  // ---------------------------------------------------------- identities and persons

  private schedule() {
    if (this.timer || !this.chat) return;
    this.timer = this.hub.clock.setTimeout(() => this.drain(), 0);
  }

  /** In the background: old threads' rows first, then the people of threads that changed, a step at a time. */
  private drain() {
    this.timer = null;
    if (!this.chat) return;
    const db = this.hub.store.db;
    try {
      if (this.rebuild.length) {
        const step = this.rebuild.splice(0, STEP);
        db.transaction(() => {
          for (const id of step) this.party(id, db.query('SELECT * FROM mail_message WHERE thread_id = ? ORDER BY received_at, id').all(id) as Row[]);
        })();
      } else this.settle([...this.pending].slice(0, STEP));
    } catch (e) {
      // A closed database (the hub stopping) or a bad row: the rest waits for the next change.
      console.warn(`mail people: ${(e as Error)?.message ?? e}`);
      jobFailed('mail: people', e);
      return;
    }
    if (this.rebuild.length || this.pending.size) this.schedule();
  }

  /** New messages: their people now, so whatever runs after an ingest finds them. */
  private ingested(messageIds: string[]) {
    if (!this.chat || !messageIds.length) return;
    const threads = (this.hub.store.db.query('SELECT DISTINCT thread_id FROM mail_message WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(messageIds)) as Row[]).map((r) => r.thread_id as string);
    this.settle(threads);
  }

  /** The people of these threads (all pending ones without an argument): identities, persons and names. */
  settle(threadIds?: Iterable<string>) {
    const chat = this.chat;
    if (!chat) return;
    const ids = [...(threadIds ?? this.pending)];
    for (const t of ids) this.pending.delete(t);
    if (!ids.length) return;
    const db = this.hub.store.db;
    const addrs = (db.query('SELECT DISTINCT address FROM mail_party WHERE thread_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as Row[]).map((r) => r.address as string);
    const self = this.selfAddresses();
    db.transaction(() => {
      for (const a of addrs) if (!self.has(a)) this.place(chat, a);
    })();
  }

  /** One address: an identity if it has earned one, a person if you correspond. */
  private place(chat: Store, address: string) {
    const st = this.standing(address);
    const corresponds = st.got > 0 || st.took;
    const has = !!this.identityRow(address);
    if (!corresponds && !has && !this.personal(address)) return;
    const id = chat.emailIdentity(address, this.nameOf(address));
    if (corresponds) chat.ensurePerson(id);
  }

  private standing(address: string): { got: number; sent: number; took: boolean } {
    const r = this.hub.store.db
      .query('SELECT COALESCE(SUM(p.got), 0) AS got, COALESCE(SUM(p.sent), 0) AS sent, COALESCE(MAX(p.sent > 0 AND p.mine), 0) AS took FROM mail_party p JOIN mail_thread t ON t.id = p.thread_id WHERE p.address = ?')
      .get(address) as Row;
    return { got: r.got, sent: r.sent, took: !!r.took };
  }

  /** Mail from them that classification (slice 8) called personal. */
  private personal(address: string): boolean {
    return !!this.hub.store.db.query(`SELECT 1 FROM mail_message WHERE from_addr = ? AND class = 'personal' LIMIT 1`).get(address);
  }

  /** The name on their latest From, else the latest you wrote to them under. */
  private nameOf(address: string): string | null {
    const r = this.hub.store.db.query('SELECT p.name FROM mail_party p JOIN mail_thread t ON t.id = p.thread_id WHERE p.address = ? AND p.name IS NOT NULL ORDER BY p.name_from DESC, p.name_at DESC LIMIT 1').get(address) as Row | null;
    return r?.name ?? null;
  }

  private identityRow(address: string): Row | null {
    if (!this.chat) return null;
    return (this.hub.store.db.query(`SELECT id, person_id FROM identity WHERE network = 'email' AND native_id = ?`).get(lc(address)) as Row | null) ?? null;
  }

  /** Every mail account's own addresses: never anyone's identity here. */
  private selfAddresses(): Set<string> {
    const out = new Set<string>();
    for (const a of this.hub.store.accounts()) for (const e of this.hub.store.selfAddresses(a.id)) out.add(e);
    return out;
  }

  /** Merged, split or new: the threads of these people's addresses go out again, with the person as it is now. */
  private personsChanged(personIds: string[]) {
    const rows = this.hub.store.db
      .query(`SELECT DISTINCT p.thread_id FROM identity i JOIN mail_party p ON p.address = i.native_id WHERE i.network = 'email' AND i.person_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(personIds)) as Row[];
    for (const r of rows) this.hub.store.dirty.threads.add(r.thread_id);
  }

  /** An account's mail was deleted: the identities it alone held go (Q6: everything of it goes). */
  private forget() {
    const chat = this.chat;
    const db = this.hub.store.db;
    db.query('DELETE FROM mail_party WHERE thread_id NOT IN (SELECT id FROM mail_thread)').run();
    if (!chat) return;
    const gone = (db.query(`SELECT id FROM identity i WHERE network = 'email' AND NOT EXISTS (SELECT 1 FROM mail_party p WHERE p.address = i.native_id)`).all() as Row[]).map((r) => r.id as string);
    if (gone.length) chat.dropEmailIdentities(gone);
  }

  // ---------------------------------------------------------- for the views and the profile

  /** The identity and person behind each address, for the mail views. */
  private whoIs(addrs: string[]): Map<string, { identityId: string; personId: string | null }> {
    const out = new Map<string, { identityId: string; personId: string | null }>();
    const list = [...new Set(addrs.map(lc).filter(Boolean))];
    if (!this.chat || !list.length) return out;
    const rows = this.hub.store.db.query(`SELECT id, native_id, person_id FROM identity WHERE network = 'email' AND native_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(list)) as Row[];
    for (const r of rows) out.set(r.native_id, { identityId: r.id, personId: r.person_id ?? null });
    return out;
  }

  /** The addresses a `w:` list is with: a person's email identities as they are now, an identity's, or an address. */
  addressesOf(who: string): string[] {
    if (who.includes('@')) return [lc(who)];
    if (!this.chat) return [];
    const db = this.hub.store.db;
    const q = who.startsWith('per_') ? `SELECT native_id FROM identity WHERE person_id = ? AND network = 'email'` : `SELECT native_id FROM identity WHERE id = ? AND network = 'email'`;
    return (db.query(q).all(who) as Row[]).map((r) => r.native_id as string);
  }

  /** The profile's Mail card: newest threads with any of these identities' addresses, and how many there are. */
  profile(identityIds: string[], limit = 5): P.ProfileView['mail'] {
    if (!this.chat || !identityIds.length) return undefined;
    const db = this.hub.store.db;
    const addrs = (db.query(`SELECT native_id FROM identity WHERE network = 'email' AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(identityIds)) as Row[]).map((r) => r.native_id as string);
    if (!addrs.length) return undefined;
    const where = `t.id IN (SELECT thread_id FROM mail_party WHERE address IN (SELECT value FROM json_each(?))) AND t.account_id IN (SELECT id FROM mail_account WHERE hidden = 0)`;
    const a = JSON.stringify(addrs);
    const total = (db.query(`SELECT COUNT(*) AS n FROM mail_thread t WHERE ${where}`).get(a) as Row).n as number;
    const rows = db.query(`SELECT t.* FROM mail_thread t WHERE ${where} ORDER BY t.last_at DESC, t.id DESC LIMIT ?`).all(a, limit) as Row[];
    return { threads: rows.map((r) => this.hub.store.threadView(r)), total };
  }

  /**
   * What the hub knows of a sender, by address: whether you correspond, and the identity and person behind it. For
   * classification (slice 8: §4's rules 4 and 5) and triage. Read from mail_party, so it is current as soon as an
   * ingest returns, before any listener of `ingested` runs.
   */
  sender(address: string): MailSender {
    const e = lc(address);
    const st = this.standing(e);
    const idn = this.identityRow(e);
    const personId: string | null = idn?.person_id ?? null;
    let chat = false;
    let viaPerson = false;
    if (personId) {
      const db = this.hub.store.db;
      chat = !!db.query(`SELECT 1 FROM identity WHERE person_id = ? AND network != 'email' LIMIT 1`).get(personId);
      const others = (db.query(`SELECT native_id FROM identity WHERE person_id = ? AND network = 'email' AND native_id != ?`).all(personId, e) as Row[]).map((r) => r.native_id as string);
      viaPerson = others.some((o) => {
        const s = this.standing(o);
        return s.got > 0 || s.took;
      });
    }
    return { address: e, identityId: idn?.id ?? null, personId, wroteTo: st.got, wroteYou: st.sent, tookPart: st.took, chat, known: st.got > 0 || st.took || chat || viaPerson };
  }
}

const PEOPLE = new WeakMap<MailHub, MailPeople>();

/** The hub's people in mail; null on a hub made without this router. */
export function mailPeople(hub: MailHub | null | undefined): MailPeople | null {
  return (hub && PEOPLE.get(hub)) ?? null;
}

/** Slice 6: no routes of its own (the profile and the merge search are the chat server's); it listens and fills in. */
export const peopleRoutes: MailRouter = (hub) => {
  PEOPLE.set(hub, new MailPeople(hub));
  return [];
};
