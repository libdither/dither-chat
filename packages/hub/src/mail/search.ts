/**
 * Mail search (docs/mail.md, docs/mail-design.md §11): the hub's own index first, then the servers'.
 *
 * Local: FTS5 over mail_fts (subject, people, the first 16 KB of each fetched body, else the preview), kept current
 * by schema-search.sql's triggers. The query language is chat's (protocol search.ts) with mail's operators
 * (parseSearch(…, 'mail')). Hits are threads, newest matching message first, paged by cursor. Nothing found as whole
 * words: inside words (LIKE); still nothing: misspelt words corrected from mail_fts_vocab, as chat search does.
 *
 * Server: with server=1, or server=auto when a first page has under 20 hits, mail.search on each account at P0. The
 * hits are stored like any listed summary (so they open like any other), filtered by the query's operators, and given
 * after the hub's own: only threads the hub's search did not find, marked `server`. Gmail takes the query in its own
 * syntax (X-GM-RAW); other IMAP servers and Proton take words. Proton's server matches subjects and addresses only,
 * and the answer says so.
 *
 * from:, to: and with: know people (slice 6): a name finds the addresses of everyone it names, across networks.
 *
 * A body's text comes from slice 2's mail_text (cache.ts), which holds its first 16 KB (all of it, up to 1 MB, on an
 * account that keeps all its mail), outlives the body cache and has the one cap on search text; schema-search.sql's
 * triggers follow it. Attachments' names are indexed too (`files`): filename: looks only there, plain words there as well.
 *
 * Keeping all mail (keep.ts): each server search is measured per account (mail_search_measure: its hits, how many the
 * hub held before, how many with text here, how many its own search found). server=auto leaves out an account that is
 * searched locally (state `local`); server=1 asks it all the same, and measures.
 */
import type * as P from '@dither-chat/protocol';
import { parseSearch } from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { editDistance } from '../store.ts';
import { asMailError, MailCallError } from './backend.ts';
import type { MailHub } from './index.ts';
import { keepOf, LOCAL_SEARCHES, MEASURE_DAYS } from './keep.ts';
import { P0 } from './queue.ts';
import type { MailRouter } from './routes.ts';

type Row = Record<string, any>;

/** server=auto asks the servers when a first page has fewer hits than this. */
export const SERVER_UNDER = 20;
/** Messages asked of each server. */
export const SERVER_LIMIT = 50;
/** How long a page waits for the servers. */
export const SERVER_WAIT_MS = 20_000;

export const PROTON_NOTE = "Proton's server searches subjects and addresses only, not the text of messages. Text is searched here, in the mail this hub has fetched.";
export const LOCAL_NOTE = 'Searched here: this hub holds all of its mail.';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const like = (s: string) => `%${likeEscape(s)}%`;
const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
const ROLE_NAMES: Record<string, string> = { inbox: 'inbox', sent: 'sent', drafts: 'drafts', draft: 'drafts', trash: 'trash', bin: 'trash', junk: 'junk', spam: 'junk', archive: 'archive', archived: 'archive', all: 'all', 'all mail': 'all' };

/**
 * The words as the index matched them, for marking them in a body: from a word's start (the whole word: the last one
 * typed is a prefix), any case, accents folded; run over NFD text. `inside`: anywhere, as the LIKE fallback matched.
 */
export function wordsPattern(texts: string[], inside: boolean): RegExp | null {
  const letters = (w: string) => [...w].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\p{M}*').join('');
  const alts = texts
    .map((t) => t.normalize('NFD').replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean))
    .filter((ws) => ws.length)
    .map((ws) => ws.map(letters).join('[^\\p{L}\\p{N}]+') + (inside ? '' : '[\\p{L}\\p{N}\\p{M}]*'));
  if (!alts.length) return null;
  return new RegExp(`${inside ? '' : '(?<![\\p{L}\\p{N}\\p{M}])'}(?:${alts.join('|')})`, 'giu');
}

/** A body's text around its first match, each match between \u0001 and \u0002; null when nothing in it matches. */
export function snippetOf(body: string, re: RegExp): string | null {
  const text = body.normalize('NFD');
  re.lastIndex = 0;
  const m = re.exec(text);
  if (!m) return null;
  let start = Math.max(0, m.index - 60);
  // From a word's start.
  if (start > 0) start = Math.min(m.index, (text.slice(start, m.index).search(/\s/) + 1 || 0) + start);
  const end = Math.min(text.length, start + 220);
  const piece = text.slice(start, end).replace(re, (x) => `\u0001${x}\u0002`);
  return ((start ? '…' : '') + piece + (end < text.length ? '…' : '')).replace(/\s+/g, ' ').trim().normalize('NFC');
}

type Mode = P.MailSearchPage['mode'];

interface Found {
  tid: string;
  at: number;
  mid: string;
  n: number;
}

interface ServerAnswer extends P.MailServerSearch {
  /** The hub's ids of the messages it answered with, and of those among them new to the hub. */
  ids: string[];
  added: string[];
}

/** How to put a query to an account's server. */
export type ServerForm = 'gmail' | 'imap' | 'proton';

export class MailSearch {
  constructor(private hub: MailHub) {}

  private get store() {
    return this.hub.store;
  }
  private get db() {
    return this.hub.store.db;
  }

  /** Messages missing from the index (a database from before it): indexed once. */
  backfill(): number {
    const missing = this.store.one<{ n: number }>('SELECT (SELECT COUNT(*) FROM mail_message) - (SELECT COUNT(*) FROM mail_search) AS n')?.n ?? 0;
    if (missing <= 0) return 0;
    const people = (j: string) => `COALESCE((SELECT group_concat(COALESCE(json_extract(value, '$.name'), '') || ' ' || COALESCE(json_extract(value, '$.email'), ''), ' ') FROM json_each(${j})), '')`;
    this.db.transaction(() => {
      const r = this.db
        .query(
          `INSERT INTO mail_search (message_id, account_id, thread_id, at, shut, subject, people, body)
           SELECT m.id, m.account_id, m.thread_id, m.received_at,
             NOT EXISTS (SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = m.id AND (b.role IS NULL OR b.role NOT IN ('junk', 'trash'))),
             m.subject, trim(COALESCE(m.from_name, '') || ' ' || COALESCE(m.from_addr, '') || ' ' || ${people('m.to_json')} || ' ' || ${people('m.cc_json')}), COALESCE(m.preview, '')
           FROM mail_message m WHERE NOT EXISTS (SELECT 1 FROM mail_search s WHERE s.message_id = m.id)`,
        )
        .run();
      // Text slice 2 already holds: what the triggers would have put there.
      this.db.query('UPDATE mail_search SET body = t.text, full = 1 FROM mail_text t WHERE t.message_id = mail_search.message_id AND mail_search.full = 0').run();
      return r.changes;
    })();
    return missing;
  }

  // ---------------------------------------------------------- local

  /** Quoted for FTS5, so what people type is never a syntax error; subject: and filename: as column filters. Null: no words. */
  private ftsQuery(q: P.SearchQuery): string | null {
    const parts = [...q.phrases.map(quote), ...q.terms.map((t, i) => quote(t) + (i === q.terms.length - 1 ? '*' : '')), ...q.subject.map((s) => `subject : ${quote(s)}*`), ...q.filename.map((f) => `files : ${quote(f)}*`)];
    if (!parts.length) return null;
    return parts.join(' ') + q.not.map((t) => ` NOT ${quote(t)}`).join('');
  }

  /**
   * Who a name in from:, to: or with: is, as addresses (people.ts, slice 6): a person or identity id (a profile's
   * link), or the people whose name, or any of whose identities' names, has it in it: their email identities. A
   * person you merged across networks is found by any of their names. On top of the names and addresses as text.
   */
  private resolve(name: string): string[] {
    if (/^(per|idn)_/.test(name)) return this.store.addressesOf(name).map((a) => a.toLowerCase());
    if (!this.hasPeople) return [];
    const rows = this.store.all<{ a: string }>(
      `SELECT DISTINCT e.native_id AS a FROM identity e WHERE e.network = 'email' AND e.person_id IN (
         SELECT id FROM person WHERE name LIKE ?1 ESCAPE '\\'
         UNION SELECT person_id FROM identity WHERE person_id IS NOT NULL AND (display_name LIKE ?1 ESCAPE '\\' OR handle LIKE ?1 ESCAPE '\\'))`,
      like(name),
    );
    return rows.map((r) => r.a.toLowerCase());
  }

  /** The chat tables are in this database (not in a bare mail test's). */
  private get hasPeople(): boolean {
    return (this.peopleKnown ??= !!this.store.one(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'person'`));
  }
  private peopleKnown: boolean | undefined;

  /** Mailboxes `in:` names: an id, a role (inbox, sent, spam…), or a name or path, any case. */
  private mailboxesNamed(name: string): string[] {
    if (/^mbx_/.test(name)) return [name];
    const role = ROLE_NAMES[name.toLowerCase()];
    return this.store
      .all<{ id: string }>('SELECT id FROM mailbox WHERE role = ?1 OR name = ?2 COLLATE NOCASE OR path = ?2 COLLATE NOCASE OR (?1 = \'archive\' AND role = \'all\')', role ?? '', name)
      .map((r) => r.id);
  }

  /** Mail accounts `account:` names: an id, a label, an address, or a kind (proton, imap). */
  private accountsNamed(name: string): string[] {
    return this.store.all<{ id: string }>('SELECT id FROM mail_account WHERE id = ?1 OR label = ?1 COLLATE NOCASE OR address = ?1 COLLATE NOCASE OR kind = ?1 COLLATE NOCASE', name).map((r) => r.id);
  }

  /**
   * The operators as SQL, words aside: over `s` (mail_search: account, thread, time, shut) where they can be, else
   * over `m` (mail_message), which `needsM` then says the query must join.
   */
  private filters(q: P.SearchQuery): { where: string[]; args: unknown[]; needsM: boolean } {
    const where: string[] = ['s.account_id IN (SELECT id FROM mail_account WHERE hidden = 0)'];
    const args: unknown[] = [];
    const within = (sql: string, ids: string[]) => {
      where.push(sql);
      args.push(JSON.stringify(ids));
    };
    // One side of a message: its sender, or its To and Cc; a name or address as text, or as people know it.
    const side = (who: 'from' | 'to' | 'with', v: string) => {
      const known = JSON.stringify(this.resolve(v));
      const from = `(m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\' OR m.from_addr IN (SELECT value FROM json_each(?)))`;
      const list = (col: string) =>
        `EXISTS (SELECT 1 FROM json_each(${col}) j WHERE json_extract(j.value, '$.email') LIKE ? ESCAPE '\\' OR json_extract(j.value, '$.name') LIKE ? ESCAPE '\\' OR lower(json_extract(j.value, '$.email')) IN (SELECT value FROM json_each(?)))`;
      const to = `(${list('m.to_json')} OR ${list('m.cc_json')})`;
      const three = [like(v), like(v), known];
      if (who === 'from') {
        where.push(from);
        args.push(...three);
      } else if (who === 'to') {
        where.push(to);
        args.push(...three, ...three);
      } else {
        where.push(`(${from} OR ${to})`);
        args.push(...three, ...three, ...three);
      }
    };
    for (const v of q.from) side('from', v);
    for (const v of q.to) side('to', v);
    for (const v of q.with) side('with', v);
    for (const a of q.account) within('s.account_id IN (SELECT value FROM json_each(?))', this.accountsNamed(a));
    for (const v of q.in) {
      if (['anywhere', 'any', '*'].includes(v.toLowerCase())) continue;
      if (ROLE_NAMES[v.toLowerCase()] === 'archive') {
        // Archived: in Archive, or where an account has none (Gmail), in All mail and not in Inbox, Sent or Drafts.
        where.push(
          `EXISTS (SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = s.message_id AND (b.role = 'archive' OR (b.role = 'all'
             AND NOT EXISTS (SELECT 1 FROM mailbox x WHERE x.account_id = b.account_id AND x.role = 'archive')
             AND NOT EXISTS (SELECT 1 FROM mail_location i JOIN mailbox ib ON ib.id = i.mailbox_id WHERE i.message_id = s.message_id AND ib.role IN ('inbox', 'sent', 'drafts')))))`,
        );
        continue;
      }
      within('EXISTS (SELECT 1 FROM mail_location l WHERE l.message_id = s.message_id AND l.mailbox_id IN (SELECT value FROM json_each(?)))', this.mailboxesNamed(v));
    }
    // Junk and Trash only when asked for, as mail apps do.
    if (!q.in.length) where.push('s.shut = 0');
    for (const v of q.label) {
      where.push(`(EXISTS (SELECT 1 FROM json_each(m.labels) WHERE lower(value) = lower(?)) OR EXISTS (SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = s.message_id AND (b.name = ? COLLATE NOCASE OR b.path = ? COLLATE NOCASE)))`);
      args.push(v, v, v);
    }
    if (q.has.includes('attachment')) where.push('m.has_attachments = 1');
    for (const v of q.is) {
      if (v === 'unread') where.push('m.seen = 0 AND m.seen_local = 0');
      else if (v === 'read') where.push('(m.seen = 1 OR m.seen_local = 1)');
      else if (v === 'starred') where.push('m.flagged = 1');
    }
    if (q.after !== null) (where.push('s.at >= ?'), args.push(q.after));
    if (q.before !== null) (where.push('s.at < ?'), args.push(q.before));
    const needsM = !!(q.from.length || q.to.length || q.with.length || q.label.length || q.has.length || q.is.length);
    return { where, args, needsM };
  }

  /** Whether the query asks anything at all. */
  private asks(q: P.SearchQuery): boolean {
    return !!(q.terms.length || q.phrases.length || q.subject.length || q.filename.length || q.not.length || q.from.length || q.to.length || q.with.length || q.account.length || q.in.length || q.label.length || q.has.length || q.is.length || q.after !== null || q.before !== null);
  }

  /**
   * Threads matching, newest matching message first. `among`: only these threads (no paging). Substring mode matches
   * the words inside words, with LIKE.
   */
  private find(q: P.SearchQuery, mode: Mode, o: { cursor?: string | null; limit?: number; among?: string[]; ids?: string[]; notIds?: string[]; byMessage?: boolean } = {}): Found[] {
    const { where, args, needsM } = this.filters(q);
    const fts = mode === 'fulltext' ? this.ftsQuery(q) : null;
    const m = needsM ? ' CROSS JOIN mail_message m ON m.id = s.message_id' : '';
    // Only filters on messages: through those first, then their text's row. Otherwise through the text first.
    let from = needsM ? 'mail_message m CROSS JOIN mail_search s ON s.message_id = m.id' : 'mail_search s';
    const pre: unknown[] = [];
    const texts = [...q.phrases, ...q.terms];
    if (fts) {
      from = `mail_fts CROSS JOIN mail_search s ON s.n = mail_fts.rowid${m}`;
      where.unshift('mail_fts MATCH ?');
      pre.push(fts);
    } else if (mode === 'substring' || q.not.length) {
      from = `mail_search s${m}`;
      if (mode === 'substring') {
        for (const t of texts) (where.push(`(s.subject LIKE ? ESCAPE '\\' OR s.people LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\' OR s.files LIKE ? ESCAPE '\\')`), args.push(like(t), like(t), like(t), like(t)));
        for (const t of q.subject) (where.push(`s.subject LIKE ? ESCAPE '\\'`), args.push(like(t)));
        for (const t of q.filename) (where.push(`s.files LIKE ? ESCAPE '\\'`), args.push(like(t)));
      }
      for (const t of q.not) (where.push(`NOT (s.subject LIKE ? ESCAPE '\\' OR s.people LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\')`), args.push(like(t), like(t), like(t)));
    }
    if (o.among) (where.push('s.thread_id IN (SELECT value FROM json_each(?))'), args.push(JSON.stringify(o.among)));
    if (o.ids) (where.push('s.message_id IN (SELECT value FROM json_each(?))'), args.push(JSON.stringify(o.ids)));
    if (o.notIds?.length) (where.push('s.message_id NOT IN (SELECT value FROM json_each(?))'), args.push(JSON.stringify(o.notIds)));
    const oldest = q.oldest;
    const agg = oldest ? 'MIN' : 'MAX';
    const dir = oldest ? 'ASC' : 'DESC';
    let having = '';
    const hargs: unknown[] = [];
    const cur = o.cursor?.match(/^(-?\d+):([\w-]+)/);
    if (cur) {
      having = `HAVING at ${oldest ? '>' : '<'} ? OR (at = ? AND tid ${oldest ? '>' : '<'} ?)`;
      hargs.push(Number(cur[1]), Number(cur[1]), cur[2]);
    }
    const limit = o.limit ? 'LIMIT ?' : '';
    return this.store.all<Found>(
      `SELECT s.thread_id AS tid, ${agg}(s.at) AS at, s.message_id AS mid, COUNT(*) AS n FROM ${from} WHERE ${where.join(' AND ')} GROUP BY ${o.byMessage ? '+s.message_id' : '+s.thread_id'} ${having} ORDER BY at ${dir}, tid ${dir} ${limit}`,
      ...pre,
      ...args,
      ...hargs,
      ...(o.limit ? [o.limit] : []),
    );
  }

  /**
   * The matched words around each hit, from its text here; null when its text did not match (its subject or people
   * did). Marked here rather than by FTS5's snippet(), which costs more than the search itself for a common word.
   */
  private snippets(q: P.SearchQuery, mode: Mode, ids: string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    const re = mode === 'filters' ? null : wordsPattern([...q.phrases, ...q.terms], mode === 'substring');
    if (!re || !ids.length) return out;
    const body = this.db.query('SELECT body FROM mail_search WHERE message_id = ?');
    for (const id of ids) {
      const b = (body.get(id) as Row | null)?.body as string | undefined;
      out.set(id, b ? snippetOf(b, re) : null);
    }
    return out;
  }

  private hits(found: Found[], snips: Map<string, string | null>, server = false): P.MailSearchHit[] {
    const views = new Map(this.store.threadViews(found.map((f) => f.tid)).map((t) => [t.id, t]));
    return found.filter((f) => views.has(f.tid)).map((f) => ({ thread: views.get(f.tid)!, messageId: f.mid, at: f.at, snippet: snips.get(f.mid) ?? null, matches: f.n, ...(server ? { server: true } : {}) }));
  }

  /** The hub's own hits: a page, as typed; else inside words; else with misspelt words corrected. */
  local(input: string, limit = 50, cursor: string | null = null): P.MailSearchPage {
    const page = this.localOnce(input, limit, cursor);
    if (page.hits.length || cursor) return page;
    const fixed = this.spellFix(input);
    const alt = fixed ? this.localOnce(fixed, limit, null) : null;
    return alt?.hits.length ? { ...alt, corrected: fixed! } : page;
  }

  private localOnce(input: string, limit: number, cursor: string | null): P.MailSearchPage {
    const q = parseSearch(input, new Date(), 'mail');
    if (!this.asks(q)) return { hits: [], next: null, mode: 'filters' };
    const n = Math.max(1, Math.min(limit, 200));
    const words = this.ftsQuery(q);
    const texts = [...q.phrases, ...q.terms];
    // Tokens miss the middle of a word, and unspaced CJK text is one long token.
    let mode: Mode = !words ? 'filters' : cursor?.endsWith(':s') || texts.some((t) => CJK.test(t)) ? 'substring' : 'fulltext';
    let rows = this.find(q, mode, { cursor, limit: n + 1 });
    if (!rows.length && mode === 'fulltext' && !cursor) {
      mode = 'substring';
      rows = this.find(q, mode, { limit: n + 1 });
    }
    const page = rows.slice(0, n);
    const last = page[page.length - 1];
    return {
      hits: this.hits(page, this.snippets(q, mode, page.map((f) => f.mid))),
      next: rows.length > n ? `${last.at}:${last.tid}${mode === 'substring' ? ':s' : ''}` : null,
      mode,
    };
  }

  /** Each word the index lacks swapped for the nearest it has (as chat's spellFix); null when nothing changes. */
  private spellFix(input: string): string | null {
    const q = parseSearch(input, new Date(), 'mail');
    let out = input;
    q.terms.forEach((t, i) => {
      const w = t.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
      if (w.length < 4 || w.length > 30 || !/^\p{L}+$/u.test(w) || CJK.test(w)) return;
      const known = i === q.terms.length - 1 ? 'term >= ?1 AND term < ?1 || char(1114111)' : 'term = ?1';
      if (this.db.query(`SELECT 1 FROM mail_fts_vocab WHERE ${known} LIMIT 1`).get(w)) return;
      const max = w.length < 7 ? 1 : 2;
      let best: { term: string; d: number; doc: number } | null = null;
      for (const r of this.db.query(`SELECT term, doc FROM mail_fts_vocab WHERE term >= ?1 AND term < ?1 || char(1114111)`).iterate(w[0]) as Iterable<Row>) {
        if (Math.abs(r.term.length - w.length) > max) continue;
        const d = editDistance(w, r.term, max);
        if (d <= max && (!best || d < best.d || (d === best.d && r.doc > best.doc))) best = { term: r.term, d, doc: r.doc };
      }
      if (best) out = out.replace(new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), `$1${best.term}`);
    });
    return out === input ? null : out;
  }

  // ---------------------------------------------------------- servers

  /**
   * The hub's hits, then (when asked, or `auto` and a first page under SERVER_UNDER) the servers'. `auto` leaves out
   * the accounts searched locally (keep.ts).
   */
  async search(input: string, o: { limit?: number; cursor?: string | null; server?: boolean | 'auto' } = {}): Promise<P.MailSearchPage> {
    const page = this.local(input, o.limit ?? 50, o.cursor ?? null);
    const ask = o.server === true || (o.server === 'auto' && !o.cursor && page.hits.length < SERVER_UNDER);
    if (!ask) return page;
    return { ...page, server: await this.servers(input, { auto: o.server === 'auto' }) };
  }

  /**
   * Each account's server, at once. Their hits are stored, then kept when they pass the query's operators and their
   * thread is not one the hub's own search found (with what it held before they came). Each answer is measured
   * (keep.ts). `auto`: an account searched locally is not asked.
   */
  async servers(input: string, o: { auto?: boolean } = {}): Promise<NonNullable<P.MailSearchPage['server']>> {
    const q = parseSearch(input, new Date(), 'mail');
    if (!this.asks(q)) return { hits: [], accounts: [] };
    let accounts = this.store.accounts().filter((a) => !a.hidden);
    if (q.account.length) {
      const named = new Set(q.account.flatMap((a) => this.accountsNamed(a)));
      accounts = accounts.filter((a) => named.has(a.id));
    }
    const keep = keepOf(this.hub);
    const answers = await Promise.all(
      accounts.map((a) =>
        o.auto && keep?.searchedLocally(a.id) ? Promise.resolve<ServerAnswer>({ accountId: a.id, state: 'local', found: 0, error: null, note: LOCAL_NOTE, ids: [], added: [] }) : this.askServer(a, q),
      ),
    );
    for (const a of answers) if (a.state === 'done') this.measure(a, q);
    const ids = [...new Set(answers.flatMap((a) => a.ids))];
    const added = answers.flatMap((a) => a.added);
    // The words matched on the server; the rest of the query is checked here.
    const ops = { ...q, terms: [], phrases: [], subject: [], filename: [], not: [] };
    const passed = ids.length ? this.find(ops, 'filters', { ids }) : [];
    const mine = new Set(passed.length ? this.findAll(q, passed.map((f) => f.tid), added) : []);
    const fresh = passed.filter((f) => !mine.has(f.tid)).map((f) => ({ ...f, n: 1 }));
    return { hits: this.hits(fresh, new Map(), true), accounts: answers.map(({ ids: _i, added: _a, ...a }) => a) };
  }

  /**
   * One account's server answer measured (keep.ts, mail_search_measure): its hits, those the hub held before this
   * search stored them, those of them with body text here, and those its own search for the query found. The query is
   * not kept. Rows older than the measure's 30 days go, but never an account's last LOCAL_SEARCHES.
   */
  private measure(a: ServerAnswer, q: P.SearchQuery) {
    const hits = [...new Set(a.ids)];
    const added = new Set(a.added);
    const held = hits.filter((id) => !added.has(id));
    const json = JSON.stringify(held);
    const bodies = held.length ? this.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_text WHERE message_id IN (SELECT value FROM json_each(?))', json)!.n : 0;
    const local = new Set<string>();
    if (held.length) for (const mode of this.ftsQuery(q) ? (['fulltext', 'substring'] as const) : (['filters'] as const)) for (const f of this.find(q, mode, { ids: held, byMessage: true })) local.add(f.mid);
    const now = this.hub.clock.now();
    this.db.query('INSERT INTO mail_search_measure (account_id, at, found, held, bodies, local, full) VALUES (?, ?, ?, ?, ?, ?, ?)').run(a.accountId, now, hits.length, held.length, bodies, local.size, a.found >= SERVER_LIMIT ? 1 : 0);
    this.db
      .query('DELETE FROM mail_search_measure WHERE account_id = ?1 AND at < ?2 AND n NOT IN (SELECT n FROM mail_search_measure WHERE account_id = ?1 ORDER BY n DESC LIMIT ?3)')
      .run(a.accountId, now - MEASURE_DAYS * 86_400_000, LOCAL_SEARCHES);
  }

  /** Of these threads, those the hub's own search finds (whole words or inside them), leaving out `without`. */
  private findAll(q: P.SearchQuery, among: string[], without: string[]): string[] {
    const out = new Set<string>();
    for (const mode of this.ftsQuery(q) ? (['fulltext', 'substring'] as const) : (['filters'] as const)) for (const f of this.find(q, mode, { among, notIds: without })) out.add(f.tid);
    return [...out];
  }

  /**
   * How this account's server takes a query: Proton's search by its kind (what its server searches, not how its ids
   * are), Gmail's syntax on Gmail over IMAP (X-GM-RAW) and on the web alike, words elsewhere.
   */
  serverForm(a: Row): ServerForm {
    if (a.kind === 'proton') return 'proton';
    return this.store.gmail(a.id) ? 'gmail' : 'imap';
  }

  private async askServer(a: Row, q: P.SearchQuery): Promise<ServerAnswer> {
    const form = this.serverForm(a);
    const note = form === 'proton' ? PROTON_NOTE : null;
    const base = { accountId: a.id as string, found: 0, error: null, note, ids: [] as string[], added: [] as string[] };
    const query = serverQuery(q, form);
    if (!query || a.gone_at || !a.level) return { ...base, state: 'skipped' };
    const sync = this.hub.sync(a.id);
    const backend = this.hub.backend;
    if (!backend?.connected || !sync) return { ...base, state: 'offline', error: 'dither-accounts is not reachable' };
    if (!a.online) return { ...base, state: 'offline', error: JSON.parse(a.problem ?? 'null')?.message ?? 'the account is offline' };
    // One mailbox named: the server searches only there.
    const boxes = q.in.length === 1 ? this.mailboxesNamed(q.in[0]).map((id) => this.store.mailbox(id)).filter((b) => b?.account_id === a.id) : [];
    const mailboxId = boxes.length === 1 ? boxes[0]!.native_id : undefined;
    try {
      const call = sync.queue.run(P0, `search:${mailboxId ?? ''}:${query}`, () => backend.call<{ messages: M.MailSummary[] }>(a.id, 'mail.search', { query, limit: SERVER_LIMIT, ...(mailboxId ? { mailboxId } : {}) }, SERVER_WAIT_MS + 5_000));
      let timer: Timer | undefined;
      const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new MailCallError(`the server did not answer in ${SERVER_WAIT_MS / 1000} s`, 504)), SERVER_WAIT_MS)));
      const res = await Promise.race([call, late]).finally(() => clearTimeout(timer));
      const list = Array.isArray(res?.messages) ? res.messages : [];
      return { ...base, state: 'done', found: list.length, ...(await this.keep(a.id, list)) };
    } catch (e) {
      return { ...base, state: 'failed', error: asMailError(e).message };
    }
  }

  /** A server's hits stored as listed summaries: their hub ids, and those new to the hub. */
  private async keep(accountId: string, list: M.MailSummary[]): Promise<{ ids: string[]; added: string[] }> {
    const byBox = new Map<string, M.MailSummary[]>();
    for (const s of list) byBox.set(s.mailboxId, [...(byBox.get(s.mailboxId) ?? []), s]);
    // A mailbox the hub has not heard of yet: the list again, once.
    if ([...byBox.keys()].some((b) => !this.store.mailboxByNative(accountId, b))) await this.hub.sync(accountId)?.refreshMailboxes().catch(() => {});
    const ids: string[] = [];
    const added: string[] = [];
    const at = this.db.query('SELECT message_id FROM mail_location WHERE mailbox_id = ? AND native_id = ?');
    for (const [native, ss] of byBox) {
      const box = this.store.mailboxByNative(accountId, native);
      if (!box) continue;
      added.push(...this.store.ingest(accountId, box, ss).added);
      for (const s of ss) {
        const r = at.get(box.id, s.id) as Row | null;
        if (r) ids.push(r.message_id);
      }
    }
    if (added.length) this.hub.emit('ingested', { accountId, messageIds: added, live: false });
    return { ids, added };
  }
}

/** Gmail's dates: 2026/01/15. */
const gmailDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};
const gmailValue = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

/**
 * The query as a server takes it: Gmail's own syntax (X-GM-RAW); words for other IMAP servers (each in the sender,
 * recipients, subject or text) and Proton (subjects and addresses). Empty: nothing a server can look for.
 */
export function serverQuery(q: P.SearchQuery, form: ServerForm): string {
  if (form === 'gmail') {
    const out: string[] = [...q.terms.map(gmailValue), ...q.phrases.map((p) => `"${p.replace(/"/g, '')}"`), ...q.not.map((t) => `-${gmailValue(t)}`)];
    for (const v of q.from) out.push(`from:${gmailValue(v)}`);
    for (const v of q.to) out.push(`to:${gmailValue(v)}`);
    for (const v of q.with) out.push(`{from:${gmailValue(v)} to:${gmailValue(v)} cc:${gmailValue(v)}}`);
    for (const v of q.subject) out.push(`subject:${gmailValue(v)}`);
    for (const v of q.filename) out.push(`filename:${gmailValue(v)}`);
    for (const v of q.label) out.push(`label:${gmailValue(v)}`);
    for (const v of q.in) {
      const role = ROLE_NAMES[v.toLowerCase()];
      if (['anywhere', 'any', '*'].includes(v.toLowerCase())) out.push('in:anywhere');
      else if (role === 'archive') out.push('-in:inbox -in:sent -in:drafts');
      else if (role === 'junk') out.push('in:spam');
      else if (role && role !== 'all' && role !== 'archive') out.push(`in:${role}`);
      else if (!role) out.push(`label:${gmailValue(v)}`);
    }
    if (q.has.includes('attachment')) out.push('has:attachment');
    for (const v of q.is) out.push(v === 'starred' ? 'is:starred' : `is:${v}`);
    if (q.after !== null) out.push(`after:${gmailDay(q.after)}`);
    if (q.before !== null) out.push(`before:${gmailDay(q.before)}`);
    return out.join(' ');
  }
  const words = [...q.terms, ...q.phrases, ...q.from, ...q.to, ...q.with, ...q.subject, ...q.filename].flatMap((v) => v.split(/\s+/)).filter(Boolean);
  return [...new Set(words)].slice(0, 10).join(' ');
}

/** Slice 7: GET /api/mail/search?q=&cursor=&limit=&server=0|1|auto */
export const searchRoutes: MailRouter = (hub) => {
  const s = new MailSearch(hub);
  searches.set(hub, s);
  s.backfill();
  return [
    {
      method: 'GET',
      path: /^\/api\/mail\/search$/,
      handle: async ({ url }) => {
        const p = url.searchParams;
        const server = p.get('server');
        const page = await s.search(p.get('q') ?? '', { limit: Number(p.get('limit')) || 50, cursor: p.get('cursor'), server: server === '1' ? true : server === 'auto' ? 'auto' : false });
        return Response.json(page satisfies P.MailSearchPage);
      },
    },
  ];
};

const searches = new WeakMap<MailHub, MailSearch>();
/** The hub's MailSearch, as its router made it. */
export const mailSearchOf = (hub: MailHub) => searches.get(hub) ?? null;
