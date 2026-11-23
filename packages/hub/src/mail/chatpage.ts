/**
 * Mail drawn as chat messages (docs/mail.md "Mail as chats"): mail_message rows as `MessageView`s with `mail` set, a
 * page of them by the chats' `(ts, id)` cursor, a person's chat as their chat timeline and their mail together, and what
 * they wrote in threads with others in the page's range (`elsewhere`).
 *
 * `ts` is when the mail reached the server (`received_at`), as mail sorts. One mail that reached two of your accounts
 * is two rows with one Message-ID: a person's chat shows it once, as its earliest copy, with both accounts in seenVia.
 */
import * as P from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { hubId } from '@dither-chat/protocol/ids';
import type { Store } from '../store.ts';
import { parseCursor } from '../chats.ts';
import { AWAITS_MS, excerptOf } from '../rungs.ts';
import type { MailHub } from './index.ts';
import type { MailPlaces, Placed } from './places.ts';

type Row = Record<string, any>;
type Cursor = { ts: number; id: string | null };

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
/** Newest first by (ts, id), as the chats' pages go. */
const newer = (a: { ts: number; id: string }, b: { ts: number; id: string }) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** A page of mail rows among these threads, newest first, before the cursor. Drafts are not shown. */
function mailRows(hub: MailHub, threads: string[], before: Cursor | null, limit: number, collapse: boolean): { rows: Row[]; via: Map<string, string[]>; hasMore: boolean } {
  const db = hub.store.db;
  const set = JSON.stringify(threads);
  const via = new Map<string, string[]>();
  const rows: Row[] = [];
  if (!threads.length) return { rows, via, hasMore: false };
  const copies = db.query(`SELECT id, account_id FROM mail_message WHERE message_id_hdr = ? AND draft = 0 AND thread_id IN (SELECT value FROM json_each(?)) ORDER BY received_at, id`);
  let at = before;
  const batch = Math.max(limit + 1, 32);
  for (;;) {
    const got = (
      at?.id
        ? db
            .query(`SELECT * FROM mail_message WHERE thread_id IN (SELECT value FROM json_each(?)) AND draft = 0 AND (received_at < ? OR (received_at = ? AND id < ?)) ORDER BY received_at DESC, id DESC LIMIT ?`)
            .all(set, at.ts, at.ts, at.id, batch)
        : db.query(`SELECT * FROM mail_message WHERE thread_id IN (SELECT value FROM json_each(?)) AND draft = 0 AND received_at < ? ORDER BY received_at DESC, id DESC LIMIT ?`).all(set, at?.ts ?? Number.MAX_SAFE_INTEGER, batch)
    ) as Row[];
    for (const r of got) {
      if (collapse && r.message_id_hdr) {
        // Shown once, as its earliest copy: a later copy is passed over wherever the page falls.
        const cs = copies.all(r.message_id_hdr, set) as Row[];
        if (cs.length > 1) {
          if (cs[0].id !== r.id) continue;
          via.set(r.id, [...new Set(cs.map((c) => c.account_id as string))]);
        }
      }
      rows.push(r);
      if (rows.length > limit) return { rows: rows.slice(0, limit), via, hasMore: true };
    }
    if (got.length < batch) return { rows, via, hasMore: false };
    const last = got[got.length - 1];
    at = { ts: last.received_at, id: last.id };
  }
}

/** Who each address is, for views: its identity (made for your own addresses), else one shown only in the page. */
class Who {
  private map = new Map<string, P.IdentityView>();
  constructor(
    chat: Store,
    places: MailPlaces,
    addresses: Iterable<string>,
    names: Map<string, string | null>,
  ) {
    const own = places.ownAddresses();
    const list = [...new Set([...addresses].map(lc).filter(Boolean))];
    if (list.some((a) => own.has(a))) places.ensureOwn();
    const rows = chat.db.query(`SELECT * FROM identity WHERE network = 'email' AND native_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(list)) as Row[];
    for (const r of rows) this.map.set(r.native_id, chat.identityView(r));
    for (const a of list) {
      if (this.map.has(a)) continue;
      // Someone mail gave no identity (a newsletter, a stranger): a view in this page only, by the same id one would get.
      this.map.set(a, { id: hubId('idn', 'email', a), network: 'email', nativeId: a, handle: a, displayName: names.get(a) ?? null, avatar: null, isBot: false, personId: null });
    }
  }
  of(address: string | null | undefined): P.IdentityView | undefined {
    return this.map.get(lc(address));
  }
  address(a: M.MailAddress): P.MailAddressView {
    const i = this.of(a.email);
    return { name: a.name ?? null, email: a.email, ...(i ? { identityId: i.id, ...(i.personId ? { personId: i.personId } : {}) } : {}) };
  }
  views(): P.IdentityView[] {
    return [...this.map.values()];
  }
}

/** The words above the quote, and whether there is a quote, from a body here; null when none is. */
function aboveQuote(text: string | null | undefined): { text: string; quoted: boolean } | null {
  if (!text?.trim()) return null;
  const q = P.quoteStart(text);
  return { text: (q === null ? text : text.slice(0, q)).trimEnd(), quoted: q !== null };
}

/** Mail rows as chat messages: `places` says where each thread is shown (absent: the thread itself). */
function mailViews(hub: MailHub, places: MailPlaces, chat: Store, rows: Row[], placed: Map<string, Placed>, via: Map<string, string[]>): { messages: P.MessageView[]; identities: P.IdentityView[] } {
  if (!rows.length) return { messages: [], identities: [] };
  const db = hub.store.db;
  const ids = JSON.stringify(rows.map((r) => r.id));
  const cached = new Set((db.query('SELECT message_id FROM mail_body WHERE message_id IN (SELECT value FROM json_each(?))').all(ids) as Row[]).map((r) => r.message_id as string));
  const addrs: string[] = [];
  const names = new Map<string, string | null>();
  for (const r of rows) {
    addrs.push(r.from_addr);
    if (r.from_name && r.from_addr) names.set(lc(r.from_addr), r.from_name);
    for (const a of [...json<M.MailAddress[]>(r.to_json, []), ...json<M.MailAddress[]>(r.cc_json, [])]) {
      addrs.push(a.email);
      if (a.name && !names.has(lc(a.email))) names.set(lc(a.email), a.name);
    }
  }
  const who = new Who(chat, places, addrs, names);
  // The first message of each thread: the chat shows the subject on it.
  const first = new Map<string, string>();
  const firstOf = db.query('SELECT id FROM mail_message WHERE thread_id = ? AND draft = 0 ORDER BY received_at, id LIMIT 1');
  for (const t of new Set(rows.map((r) => r.thread_id as string))) first.set(t, ((firstOf.get(t) as Row | null)?.id as string) ?? '');
  // A mail of yours in a thread with others that went to fewer of them than are on it: who it went to ("to Alice only").
  const own = places.ownAddresses();
  const partsOf = db.query('SELECT participants FROM mail_thread WHERE id = ?');
  const others = new Map<string, Set<string>>();
  const onlyOf = (r: Row): P.MailAddressView[] | undefined => {
    if (placed.has(r.thread_id) || !own.has(lc(r.from_addr))) return undefined;
    let all = others.get(r.thread_id);
    if (!all) {
      all = new Set(json<{ e: string }[]>((partsOf.get(r.thread_id) as Row | null)?.participants, []).map((p) => lc(p.e)).filter((e) => e && !own.has(e)));
      others.set(r.thread_id, all);
    }
    const to = [...json<M.MailAddress[]>(r.to_json, []), ...json<M.MailAddress[]>(r.cc_json, [])].filter((a) => !own.has(lc(a.email)));
    const went = new Set(to.map((a) => lc(a.email)));
    if (!went.size || went.size >= all.size || [...went].some((e) => !all.has(e))) return undefined;
    return to.filter((a, i) => to.findIndex((b) => lc(b.email) === lc(a.email)) === i).map((a) => who.address(a));
  };
  const messages = rows.map((r): P.MessageView => {
    const p = placed.get(r.thread_id);
    const body = cached.has(r.id) ? hub.store.bodyView(r.id) : null;
    const above = aboveQuote(body?.text);
    const html = body?.html ?? null;
    const files = (body?.attachments ?? []).map((a): P.AttachmentView => ({ id: a.id, kind: P.attachmentKind(a.mime), mime: a.mime, name: a.name, size: a.size, width: null, height: null, url: a.url, ...(a.info ? { info: a.info } : {}) }));
    const author = who.of(r.from_addr);
    const mail: P.MessageMailView = {
      threadId: r.thread_id,
      accountId: r.account_id,
      subject: r.subject ?? '',
      place: p ? `person:${p.personId}` : r.thread_id,
      messageId: r.message_id_hdr ?? null,
      inReplyTo: r.in_reply_to ?? null,
      from: who.address({ name: r.from_name ?? null, email: r.from_addr ?? '' }),
      to: json<M.MailAddress[]>(r.to_json, []).map((a) => who.address(a)),
      cc: json<M.MailAddress[]>(r.cc_json, []).map((a) => who.address(a)),
      date: r.date,
      receivedAt: r.received_at,
      seen: !!r.seen || !!r.seen_local,
      flagged: !!r.flagged,
      hasAttachments: !!r.has_attachments,
      bodyState: body ? 'cached' : 'none',
      // As the reader's BODY_RENDERERS decide: HTML that is not plain, or plain but formatted.
      rich: !!html && (!html.plain || !!html.formatted),
      quoted: !!above?.quoted,
      opens: first.get(r.thread_id) === r.id,
    };
    const only = onlyOf(r);
    if (only) mail.only = only;
    return {
      id: r.id,
      conversationId: p ? p.routeId : r.thread_id,
      network: 'email',
      nativeId: r.message_id_hdr ?? r.id,
      authorId: author?.id ?? null,
      ts: r.received_at,
      editedTs: null,
      kind: 'text',
      body: above?.text || r.preview || '',
      replyToId: null,
      threadId: null,
      mentionsSelf: false,
      deleted: false,
      attachments: files,
      embeds: [],
      reactions: [],
      seenVia: via.get(r.id) ?? [r.account_id],
      // Triage's tier and your marks, as the reader had them (mail/triage.ts adds them to a message's view).
      triage: triageOf(hub, r),
      mail,
    };
  });
  return { messages, identities: who.views() };
}

/** What the mail store's extras add to a message's view, of which a chat message takes the triage. */
function triageOf(hub: MailHub, r: Row): P.TriageView | null {
  const v = {} as P.MailMessageView;
  for (const f of hub.store.messageExtras) f(r, v);
  return v.triage ?? null;
}

/** Threads as one chat (a route by email, or a thread on its own): a page, oldest first, as a chat's pages are. */
export function chatMailPage(hub: MailHub, places: MailPlaces, chat: Store, threads: string[], before: string | null, limit: number, o: { collapse: boolean }): P.MessagePage {
  const page = mailRows(hub, threads, parseCursor(before), limit, o.collapse);
  const placed = places.placed({ threads: [...new Set(page.rows.map((r) => r.thread_id as string))] });
  const v = mailViews(hub, places, chat, page.rows.reverse(), placed, page.via);
  return { messages: v.messages, identities: v.identities, hasMore: page.hasMore };
}

/**
 * A person's chat (GET /api/chats/person:<id>/messages): their chat timeline and their mail with you alone, merged by
 * `(ts, id)` under one cursor, `limit` over both; and what they wrote in threads with others in the page's range.
 */
export function personPage(hub: MailHub, places: MailPlaces, chat: Store, personId: string, before: Cursor | null, limit: number, now = Date.now()): P.MessagePage {
  const chats = chat.personTimeline(personId, before, limit);
  const threads = places.personThreads(personId);
  const page = mailRows(hub, threads, before, limit, true);
  const placed = places.placed({ threads: [...new Set(page.rows.map((r) => r.thread_id as string))] });
  const mail = mailViews(hub, places, chat, page.rows, placed, page.via);
  const all = [...chats.messages, ...mail.messages].sort(newer);
  const messages = all.slice(0, limit).reverse();
  const hasMore = chats.hasMore || page.hasMore || all.length > limit;
  const identities = new Map<string, P.IdentityView>();
  for (const i of [...chats.identities, ...mail.identities]) if (!identities.has(i.id)) identities.set(i.id, i);
  // The range this page stands for: from its oldest message (the start, on the last page) up to where the newer page
  // began (now, on the newest), so the pages' ranges meet without a gap or an overlap.
  const lo = hasMore && messages.length ? messages[0].ts : 0;
  const hi = before ? before.ts : Number.MAX_SAFE_INTEGER;
  const elsewhere = elsewhereIn(hub, places, chat, personId, new Set(threads), lo, hi, now);
  for (const i of elsewhere.identities) if (!identities.has(i.id)) identities.set(i.id, i);
  return { ...chats, messages, identities: [...identities.values()], hasMore, elsewhere: elsewhere.items };
}

/** At most this many items of `elsewhere` in one page. */
const ELSEWHERE_MAX = 200;

/**
 * What a person wrote in mail threads with others (threads whose place is the thread) in [lo, hi): theirs, to you (To
 * or Cc), oldest first, each with whether it awaits you and its excerpt. Threads you hid in their chat are sent too:
 * the chat counts them ("1 hidden thread · Show"); how each shows is the chat's to draw (rungs.ts).
 */
function elsewhereIn(hub: MailHub, places: MailPlaces, chat: Store, personId: string, personThreads: Set<string>, lo: number, hi: number, now: number): { items: P.ElsewhereView[]; identities: P.IdentityView[] } {
  const db = hub.store.db;
  const addrs = (chat.db.query(`SELECT native_id FROM identity WHERE person_id = ? AND network = 'email'`).all(personId) as Row[]).map((r) => r.native_id as string);
  if (!addrs.length) return { items: [], identities: [] };
  const hidden = new Set(hub.store.accounts().filter((a) => a.hidden).map((a) => a.id as string));
  const rows = (
    db
      .query(
        `SELECT m.*, t.subject AS t_subject, t.participants AS t_participants, t.opened_at AS t_opened
         FROM mail_message m JOIN mail_thread t ON t.id = m.thread_id
         WHERE m.from_addr IN (SELECT value FROM json_each(?)) AND m.received_at >= ? AND m.received_at < ? AND m.draft = 0 AND m.addressed IN ('to', 'cc')
         ORDER BY m.received_at DESC, m.id DESC LIMIT ?`,
      )
      .all(JSON.stringify(addrs), lo, hi, ELSEWHERE_MAX * 2) as Row[]
  ).filter((r) => !personThreads.has(r.thread_id) && !hidden.has(r.account_id));
  // One mail to two of your accounts: once, its earliest copy.
  const byHdr = new Map<string, Row>();
  const kept: Row[] = [];
  for (const r of rows) {
    if (!r.message_id_hdr) kept.push(r);
    else {
      const o = byHdr.get(r.message_id_hdr);
      if (!o) {
        byHdr.set(r.message_id_hdr, r);
        kept.push(r);
      } else if (r.received_at < o.received_at || (r.received_at === o.received_at && r.id < o.id)) {
        kept[kept.indexOf(o)] = r;
        byHdr.set(r.message_id_hdr, r);
      }
    }
  }
  const own = places.ownAddresses();
  const theirs = new Set(addrs);
  const myNames = selfNames(hub);
  const texts = new Map((db.query('SELECT message_id, text FROM mail_body WHERE message_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(kept.map((r) => r.id))) as Row[]).map((b) => [b.message_id as string, b.text as string | null]));
  const answered = db.query(`SELECT 1 FROM mail_message WHERE thread_id = ? AND addressed = 'self' AND draft = 0 AND received_at > ? LIMIT 1`);
  const owed = db.query('SELECT owed_since FROM mail_feature WHERE thread_id = ? AND state IS NOT NULL');
  const items: P.ElsewhereView[] = [];
  for (const r of kept.slice(0, ELSEWHERE_MAX)) {
    const words = aboveQuote(texts.get(r.id))?.text || r.preview || '';
    const toYou = r.addressed === 'to' || namesYou(words, myNames);
    // Awaits you: to you, under a week old, and you have neither written in nor opened the thread since. Where mail's
    // attention has folded the thread (attention.ts: reply marks, auto-replies), the turn it says you owe must cover it.
    let awaits = toYou && now - r.received_at < AWAITS_MS && !(r.t_opened && r.t_opened >= r.received_at) && !answered.get(r.thread_id, r.received_at);
    if (awaits) {
      const f = owed.get(r.thread_id) as Row | null;
      if (f) awaits = f.owed_since !== null && r.received_at >= f.owed_since;
    }
    const others = json<{ e: string; n: string | null }[]>(r.t_participants, [])
      .filter((p) => p.e && !own.has(p.e) && !theirs.has(p.e))
      .map((p) => p.n || p.e);
    const excerpt = excerptOf(words, r.from_name);
    items.push({
      place: r.thread_id,
      placeKind: 'mail-thread',
      title: r.t_subject ?? r.subject ?? '',
      others,
      messageId: r.id,
      ts: r.received_at,
      unread: !r.seen && !r.seen_local,
      awaits,
      ...(excerpt ? { excerpt } : {}),
    });
  }
  const ids = chat.identitiesByIds(addrs.map((a) => hubId('idn', 'email', a)));
  return { items: items.reverse(), identities: ids };
}

/** Your names, as mail would name you in its words: each account's display name's first word, of three letters or more. */
function selfNames(hub: MailHub): string[] {
  const out = new Set<string>();
  for (const a of hub.store.accounts()) {
    const first = String(a.display_name ?? '').trim().split(/\s+/)[0];
    if (first && first.length >= 3) out.add(first.toLowerCase());
  }
  return [...out];
}

function namesYou(text: string, names: string[]): boolean {
  if (!text || !names.length) return false;
  const t = text.toLowerCase();
  return names.some((n) => new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u').test(t));
}
