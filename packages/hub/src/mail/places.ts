/**
 * Mail as chats (docs/mail.md "Mail as chats"): where each mail thread is shown, and a person's chat routes by email.
 *
 * - **A thread's place** (`placeOf`) is the chat of the one person it is with: `person:<id>` when the thread is not bulk
 *   and every other address on it (mail_party, less every account's own) is an email identity of that same person, and
 *   that person is not you. Anything else (more people, a sender with no person, a note to yourself, a newsletter) is a
 *   chat of its own, keyed by the thread's id. Worked out from who is on it each time, never stored: one rule, in
 *   `placed`, that every caller goes through.
 * - **A route by email** is one of your mail accounts and one address of theirs: `email:<account>:<address>`. A thread
 *   with two of their addresses goes on the route of the one that wrote last.
 * - **Your own addresses** are email identities of the self person (Store.ownEmailIdentity), so mail you sent reads as
 *   yours wherever an identity's person is checked.
 *
 * Ids stay mail's own (`mth_` threads, `mml_` messages): mail is read with the chat at read time (chatpage.ts), never
 * copied into the message table.
 */
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { Store } from '../store.ts';
import { placeRungs } from '../rungs.ts';
import type { MailHub } from './index.ts';
import { mailPeople } from './people.ts';
import type { MailRouter } from './routes.ts';
import { chatMailPage } from './chatpage.ts';

type Row = Record<string, any>;

/** A thread placed in a person's chat: whose, through which of your accounts, and which address of theirs. */
export interface Placed {
  personId: string;
  accountId: string;
  address: string;
  routeId: string;
  row: Row;
}

const emailRouteId = (accountId: string, address: string) => `email:${accountId}:${address.trim().toLowerCase()}`;

/** `email:<account>:<address>` apart; null for anything else. */
function parseEmailRoute(id: string): { accountId: string; address: string } | null {
  const m = id.match(/^email:([^:]+):(.+@.+)$/);
  return m ? { accountId: m[1], address: m[2].toLowerCase() } : null;
}

/** Which threads to place: all of them, those of some persons' addresses, or these. */
type Among = { all: true } | { persons: string[] } | { threads: string[] };

export class MailPlaces {
  /** What the last `mail.chats` said: each person's route ids and threads, so a thread that left a person is told. */
  private routesOf = new Map<string, Set<string>>();
  private threadsOf = new Map<string, Set<string>>();
  private personOf = new Map<string, string>();
  private primed = false;
  private ownSig = '';

  constructor(private hub: MailHub) {
    hub.chats = { touched: (ids) => this.touched(ids), boot: () => this.boot() };
  }

  /** The chat store, where identities and persons live; null until mail/people.ts is connected. */
  get chat(): Store | null {
    return mailPeople(this.hub)?.chatStore ?? null;
  }

  connected(chat: Store) {
    chat.mailRoutes = (personId) => this.chatsOf(personId).map(routeOf);
    this.ensureOwn();
  }

  // ---------------------------------------------------------- your own addresses

  /** Every mail account's own addresses, lower-cased. */
  ownAddresses(): Set<string> {
    const out = new Set<string>();
    for (const a of this.hub.store.accounts()) for (const e of this.hub.store.selfAddresses(a.id)) out.add(e);
    return out;
  }

  /** Each own address an email identity of the self person (Store.ownEmailIdentity), once per set of addresses. */
  ensureOwn() {
    const chat = this.chat;
    if (!chat) return;
    const accounts = this.hub.store.accounts();
    const sig = accounts.map((a) => `${a.id}=${[...this.hub.store.selfAddresses(a.id)].join(',')}`).join(';');
    if (sig === this.ownSig) return;
    this.ownSig = sig;
    chat.db.transaction(() => {
      for (const a of accounts) for (const e of this.hub.store.selfAddresses(a.id)) chat.ownEmailIdentity(e, a.display_name ?? null);
    })();
  }

  /** The self person's id, if there is one. */
  selfPersonId(): string | null {
    return (this.hub.store.db.query('SELECT id FROM person WHERE is_self = 1').get() as Row | null)?.id ?? null;
  }

  // ---------------------------------------------------------- the rule

  /**
   * The threads among `among` whose place is a person, with the route each is on. One query: per thread, the persons
   * behind its other addresses; a thread with exactly one, and no address without a person, is that person's.
   */
  placed(among: Among): Map<string, Placed> {
    const db = this.hub.store.db;
    const own = JSON.stringify([...this.ownAddresses()]);
    let cand: string;
    let arg: string | null = null;
    if ('all' in among) cand = '';
    else if ('persons' in among) {
      if (!among.persons.length) return new Map();
      cand = `AND p.thread_id IN (SELECT q.thread_id FROM identity j JOIN mail_party q ON q.address = j.native_id WHERE j.network = 'email' AND j.person_id IN (SELECT value FROM json_each(?2)))`;
      arg = JSON.stringify(among.persons);
    } else {
      if (!among.threads.length) return new Map();
      cand = 'AND p.thread_id IN (SELECT value FROM json_each(?2))';
      arg = JSON.stringify(among.threads);
    }
    const self = this.selfPersonId();
    const rows = db
      .query(
        `SELECT p.thread_id, MIN(i.person_id) AS pid, COUNT(DISTINCT i.person_id) AS n, SUM(i.person_id IS NULL) AS loose
         FROM mail_party p JOIN mail_thread t ON t.id = p.thread_id
         LEFT JOIN identity i ON i.network = 'email' AND i.native_id = p.address
         WHERE p.address NOT IN (SELECT value FROM json_each(?1)) AND COALESCE(t.class, '') != 'bulk' ${cand}
         GROUP BY p.thread_id HAVING n = 1 AND loose = 0`,
      )
      .all(...(arg === null ? [own] : [own, arg])) as Row[];
    const mine = rows.filter((r) => r.pid && r.pid !== self);
    const out = new Map<string, Placed>();
    if (!mine.length) return out;
    const ids = JSON.stringify(mine.map((r) => r.thread_id));
    const threads = new Map((db.query('SELECT * FROM mail_thread WHERE id IN (SELECT value FROM json_each(?))').all(ids) as Row[]).map((t) => [t.id as string, t]));
    // The address on each: the one of theirs that wrote last, else the one you wrote to last.
    const best = new Map<string, Row>();
    const ownSet = this.ownAddresses();
    for (const p of db.query('SELECT thread_id, address, sent, name_at FROM mail_party WHERE thread_id IN (SELECT value FROM json_each(?)) ORDER BY address').all(ids) as Row[]) {
      if (ownSet.has(p.address)) continue;
      const b = best.get(p.thread_id);
      if (!b || (p.sent > 0 ? 1 : 0) > (b.sent > 0 ? 1 : 0) || ((p.sent > 0) === (b.sent > 0) && p.name_at > b.name_at)) best.set(p.thread_id, p);
    }
    for (const r of mine) {
      const t = threads.get(r.thread_id);
      const a = best.get(r.thread_id);
      if (!t || !a) continue;
      out.set(r.thread_id, { personId: r.pid, accountId: t.account_id, address: a.address, routeId: emailRouteId(t.account_id, a.address), row: t });
    }
    return out;
  }

  /** Where a thread is shown: `person:<id>`, or the thread itself. */
  placeOf(threadId: string): string {
    const p = this.placed({ threads: [threadId] }).get(threadId);
    return p ? `person:${p.personId}` : threadId;
  }

  /** The threads whose place is this person, newest first. */
  personThreads(personId: string): string[] {
    return [...this.placed({ persons: [personId] }).values()]
      .filter((p) => p.personId === personId)
      .sort((a, b) => b.row.last_at - a.row.last_at)
      .map((p) => p.row.id);
  }

  /** A person's routes by email, the latest first. */
  chatsOf(personId: string): P.MailChatView[] {
    return this.views([...this.placed({ persons: [personId] }).values()].filter((p) => p.personId === personId));
  }

  /** Every person's routes by email. */
  allChats(): P.MailChatView[] {
    return this.views([...this.placed({ all: true }).values()]);
  }

  /** Placed threads as routes: one per (account, address), threads newest first. Hidden accounts' are left out. */
  private views(placed: Placed[]): P.MailChatView[] {
    const hidden = new Set(this.hub.store.accounts().filter((a) => a.hidden).map((a) => a.id as string));
    const by = new Map<string, Placed[]>();
    for (const p of placed) if (!hidden.has(p.accountId)) (by.get(p.routeId) ?? by.set(p.routeId, []).get(p.routeId)!).push(p);
    const out: P.MailChatView[] = [];
    for (const [id, ps] of by) {
      ps.sort((a, b) => b.row.last_at - a.row.last_at || (a.row.id < b.row.id ? 1 : -1));
      const top = ps[0];
      out.push({
        id,
        personId: top.personId,
        identityId: hubId('idn', 'email', top.address),
        accountId: top.accountId,
        address: top.address,
        threadIds: ps.map((p) => p.row.id),
        subject: top.row.subject,
        lastAt: top.row.last_at,
        preview: top.row.preview ?? null,
        lastFromMe: !!top.row.last_from_me,
        unread: ps.reduce((n, p) => n + (p.row.unread ?? 0), 0),
      });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt || (a.id < b.id ? -1 : 1));
  }

  // ---------------------------------------------------------- events

  /** Every route, and what each person had, so a later change can say which went. */
  private prime(): P.MailChatView[] {
    const all = this.allChats();
    if (!this.primed) {
      this.primed = true;
      this.remember(new Set(all.map((c) => c.personId)), all);
    }
    return all;
  }

  private remember(persons: Set<string>, chats: P.MailChatView[]) {
    for (const pid of persons) {
      for (const t of this.threadsOf.get(pid) ?? []) if (this.personOf.get(t) === pid) this.personOf.delete(t);
      this.threadsOf.delete(pid);
      this.routesOf.delete(pid);
    }
    for (const c of chats) {
      (this.routesOf.get(c.personId) ?? this.routesOf.set(c.personId, new Set()).get(c.personId)!).add(c.id);
      const ts = this.threadsOf.get(c.personId) ?? this.threadsOf.set(c.personId, new Set()).get(c.personId)!;
      for (const t of c.threadIds) {
        ts.add(t);
        this.personOf.set(t, c.personId);
      }
    }
  }

  /** Threads changed (new mail, a read, who is on it, a merge of persons): the routes of everyone they touch. */
  touched(threadIds: string[]): P.ClientEvent[] {
    const chat = this.chat;
    if (!chat || !threadIds.length) return [];
    this.ensureOwn();
    this.prime();
    const persons = new Set<string>();
    for (const t of threadIds) {
      const pid = this.personOf.get(t);
      if (pid) persons.add(pid);
    }
    const now = this.hub.store.db
      .query(
        `SELECT DISTINCT i.person_id FROM mail_party p JOIN identity i ON i.network = 'email' AND i.native_id = p.address
         WHERE p.thread_id IN (SELECT value FROM json_each(?)) AND i.person_id IS NOT NULL`,
      )
      .all(JSON.stringify(threadIds)) as Row[];
    for (const r of now) persons.add(r.person_id);
    if (!persons.size) return [];
    const list = [...persons];
    const chats = this.views([...this.placed({ persons: list }).values()].filter((p) => persons.has(p.personId)));
    const had = new Set(list.flatMap((pid) => [...(this.routesOf.get(pid) ?? [])]));
    this.remember(persons, chats);
    const have = new Set(chats.map((c) => c.id));
    const removed = [...had].filter((id) => !have.has(id));
    return chats.length || removed.length ? [{ t: 'mail.chats', chats, removed }] : [];
  }

  boot(): Pick<P.MailBootstrap, 'chats' | 'rungs'> {
    if (!this.chat) return {};
    this.ensureOwn();
    const chats = this.prime();
    return { chats, rungs: placeRungs(this.hub.store.db) };
  }
}

/** A route by email as a chat's route (chats.ts chatRoutes). */
const routeOf = (c: P.MailChatView): P.ChatRoute => ({
  conversationId: c.id,
  accountId: c.accountId,
  network: 'email',
  theirIdentityId: c.identityId,
  myIdentityId: null,
  lastTs: c.lastAt,
  unread: c.unread,
  mentions: 0,
});

const PLACES = new WeakMap<MailHub, MailPlaces>();

/** The hub's mail places; null on a hub made without this router. */
export function mailPlaces(hub: MailHub | null | undefined): MailPlaces | null {
  return (hub && PLACES.get(hub)) ?? null;
}

const ok = (x: unknown) => Response.json(x);
const bad = (error: string, status = 400) => Response.json({ error }, { status });

/**
 * GET /api/mail/chats?person=<id>: a person's routes by email. GET /api/mail/chats/:id/messages?before=&limit=: a
 * route by email (`email:<account>:<address>`, its threads only) or one thread (`mth_…`, of any class) as a chat.
 * A person's chat itself is GET /api/chats/person:<id>/messages (server.ts), chat and mail together.
 */
export const placesRoutes: MailRouter = (hub) => {
  const places = new MailPlaces(hub);
  PLACES.set(hub, places);
  mailPeople(hub)?.connected.push((chat) => places.connected(chat));
  return [
    {
      method: 'GET',
      path: /^\/api\/mail\/chats$/,
      handle: ({ url }) => {
        const person = url.searchParams.get('person');
        if (!person) return bad('person: a person id');
        if (!places.chat) return ok([]);
        return ok(places.chatsOf(person) satisfies P.MailChatView[]);
      },
    },
    {
      method: 'GET',
      path: /^\/api\/mail\/chats\/([^/]+)\/messages$/,
      handle: ({ params, url }) => {
        const chat = places.chat;
        if (!chat) return bad('mail is not connected to the chats yet', 503);
        const id = params[0];
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 200);
        const before = url.searchParams.get('before');
        let threads: string[];
        const route = parseEmailRoute(id);
        if (route) {
          const pid = (chat.db.query(`SELECT person_id FROM identity WHERE network = 'email' AND native_id = ?`).get(route.address) as Row | null)?.person_id as string | undefined;
          const c = pid ? places.chatsOf(pid).find((x) => x.id === id) : undefined;
          if (!c) return bad('no such mail chat', 404);
          threads = c.threadIds;
        } else if (hub.store.thread(id)) threads = [id];
        else return bad('no such mail chat', 404);
        return ok(chatMailPage(hub, places, chat, threads, before, limit, { collapse: false }) satisfies P.MessagePage);
      },
    },
  ];
};
