/**
 * Mail search (mail/search.ts, docs/mail-design.md §11): mail's operators, the hub's own hits first and then the
 * servers', deduplication, and Proton's server that cannot search the text of messages.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { mailSearchable, parseSearch } from '@dither-chat/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubId, mailId } from '@dither-chat/protocol/ids';
import type * as M from '@dither-chat/protocol/mail-iface';
import { MailCallError } from '../src/mail/backend.ts';
import { BodyCache, storeBody } from '../src/mail/cache.ts';
import { FakeMailBackend, type FakeOpts } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { MAIL_LIMITS } from '../src/mail/limits.ts';
import { mailPeople } from '../src/mail/people.ts';
import { mailSearchOf, PROTON_NOTE, serverQuery, type MailSearch } from '../src/mail/search.ts';
import { Store } from '../src/store.ts';

const ACC = 'acc_searchTest1';
const ME = 'me@example.com';
const T0 = new Date(2026, 9, 1, 12).getTime();
const H = 3_600_000;
const D = 24 * H;

let hub: MailHub | null = null;
const saved = { ...MAIL_LIMITS };
afterEach(() => {
  hub?.stop();
  hub = null;
  Object.assign(MAIL_LIMITS, saved);
});

const flags = (f: Partial<M.MailFlags> = {}): M.MailFlags => ({ seen: false, flagged: false, answered: false, draft: false, ...f });
let uid = 1;
function summary(box: string, s: Partial<M.MailSummary> & { subject: string }): M.MailSummary {
  return {
    id: `${box}.1.${uid++}`,
    mailboxId: box,
    messageId: `<m${uid}@x>`,
    threadId: null,
    from: [{ name: 'Someone', email: 'someone@example.net' }],
    to: [{ name: null, email: ME }],
    cc: [],
    date: T0,
    receivedAt: T0,
    labels: [],
    size: 100,
    preview: null,
    hasAttachments: false,
    inReplyTo: null,
    references: [],
    ...s,
    flags: s.flags ?? flags(),
  };
}

const BOXES: M.Mailbox[] = ['INBOX:inbox', 'Sent:sent', 'Archive:archive', 'Junk:junk', 'Trash:trash', 'Work/Clients:'].map((x) => {
  const [id, role] = x.split(':');
  return { id, name: id.split('/').pop()!, path: id, parentId: null, role: (role || null) as M.MailboxRole | null, unread: null, total: null };
});

/** A hub with no server, its mail put straight into the store. */
function local() {
  const db = new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  hub = new MailHub({ db, backend: null, log: () => {} });
  const st = hub.store;
  st.upsertAccount({ id: ACC, kind: 'imap', label: 'Work mail', level: 'write', dryRun: false, online: true });
  st.setStatus(ACC, { status: 'online', self: { email: ME } });
  st.putMailboxes(ACC, BOXES);
  const put = (box: string, s: Partial<M.MailSummary> & { subject: string }, text?: string) => {
    const sum = summary(box, s);
    const id = st.ingest(ACC, st.mailboxByNative(ACC, box)!, [sum]).added[0] ?? mailId('mml', ACC, `m:${sum.messageId}`);
    if (text !== undefined) storeBody(st, id, { ...sum, text, html: null, attachments: [], bcc: [], replyTo: [], inReplyTo: sum.inReplyTo ?? null, references: sum.references ?? [] });
    return id;
  };
  return { st, put, s: mailSearchOf(hub)! };
}

const subjects = (p: P.MailSearchPage | P.MailSearchHit[]) => (Array.isArray(p) ? p : p.hits).map((h) => h.thread.subject);
const find = (s: MailSearch, q: string) => subjects(s.local(q));

describe('the query language', () => {
  test("mail's operators, in mail mode only", () => {
    const q = parseSearch('invoice from:sam to:jo cc:alex with:"Pat Lee" subject:"lease renewal" in:archive label:Work has:attachment is:unread is:flagged account:proton after:2026-01 -draft', new Date(2026, 4, 10), 'mail');
    expect(q).toMatchObject({ terms: ['invoice'], from: ['sam'], to: ['jo', 'alex'], with: ['Pat Lee'], subject: ['lease renewal'], in: ['archive'], label: ['Work'], has: ['attachment'], is: ['unread', 'starred'], account: ['proton'], not: ['draft'] });
    expect(q.after).toBe(new Date(2026, 1, 1).getTime());
    // Chat's operators that mail does not have are words there; mail's are words in chat.
    expect(parseSearch('mentions:me has:image is:pinned network:discord', new Date(), 'mail').terms).toEqual(['mentions:me', 'has:image', 'is:pinned', 'network:discord']);
    const chat = parseSearch('to:bob subject:x label:y with:z is:unread');
    expect(chat.terms).toEqual(['to:bob', 'subject:x', 'label:y', 'with:z', 'is:unread']);
    expect([chat.to, chat.with, chat.subject, chat.label]).toEqual([[], [], [], []]);
  });

  test("the app's search runs mail too, unless the query is about chats", () => {
    expect(mailSearchable('dinner')).toBe(true);
    expect(mailSearchable('from:sam has:attachment')).toBe(true);
    expect(mailSearchable('during:2026-01')).toBe(true);
    for (const q of ['dinner network:discord', 'mentions:me', 'in:cnv_abc dinner', 'is:pinned', 'has:image dinner', '-x', '']) expect(mailSearchable(q)).toBe(false);
  });

  test('each server gets the query its way', () => {
    const q = parseSearch('invoice "next week" from:sam with:jo subject:lease is:unread has:attachment in:spam after:2026-01-15 before:2026-02-01 -draft', new Date(), 'mail');
    expect(serverQuery(q, 'gmail')).toBe('invoice "next week" -draft from:sam {from:jo to:jo cc:jo} subject:lease in:spam has:attachment is:unread after:2026/01/16 before:2026/02/01');
    expect(serverQuery(q, 'imap')).toBe('invoice next week sam jo lease');
    expect(serverQuery(q, 'proton')).toBe('invoice next week sam jo lease');
    expect(serverQuery(parseSearch('is:starred', new Date(), 'mail'), 'imap')).toBe('');
    expect(serverQuery(parseSearch('is:starred', new Date(), 'mail'), 'gmail')).toBe('is:starred');
  });
});

describe('the hub’s own search', () => {
  test('words in the subject, the people and the text, as threads newest first', () => {
    const { put, s } = local();
    const a = put('INBOX', { subject: 'Dinner on Friday?', from: [{ name: 'Sam Lee', email: 'sam@lee.example' }], receivedAt: T0 + H }, 'Are you free after seven? The café on Main.');
    put('Sent', { subject: 'Re: Dinner on Friday?', from: [{ name: null, email: ME }], to: [{ name: 'Sam Lee', email: 'sam@lee.example' }], inReplyTo: `<m${uid}@x>`, receivedAt: T0 + 2 * H, flags: flags({ seen: true }) }, 'Yes, seven thirty works.\n\n> Are you free after seven?');
    put('INBOX', { subject: 'Lease renewal', from: [{ name: 'Alex Kim', email: 'alex@work.example' }], cc: [{ name: 'Jo', email: 'jo@q.net' }], receivedAt: T0 + 3 * H }, 'I signed page 2 of the lease.');
    expect(find(s, 'dinner')).toEqual(['Re: Dinner on Friday?']);
    expect(s.local('dinner').hits[0].matches).toBe(2);
    expect(find(s, 'seven')).toEqual(['Re: Dinner on Friday?']);
    // Accents fold, the last word is a prefix, people are words.
    expect(find(s, 'cafe')).toEqual(['Re: Dinner on Friday?']);
    expect(find(s, 'sign')).toEqual(['Lease renewal']);
    expect(find(s, 'jo')).toEqual(['Lease renewal']);
    expect(find(s, '"page 2"')).toEqual(['Lease renewal']);
    expect(find(s, 'lease -signed')).toEqual([]);
    // The body that matched, marked.
    expect(s.local('signed').hits[0].snippet).toContain('\u0001signed\u0002');
    expect(s.local('lease').hits[0].snippet).toContain('\u0001lease\u0002');
    expect(s.local('alex').hits[0].snippet).toBeNull();
    // Marked as the index matched: accents folded, the whole word a prefix starts.
    expect(s.local('cafe').hits[0].snippet).toContain('\u0001café\u0002');
    expect(s.local('sign').hits[0].snippet).toContain('\u0001signed\u0002');
    // The thread's newest message that matched: the reply, quoting it.
    expect(s.local('"free after"').hits[0].snippet).toBe('Yes, seven thirty works. > Are you \u0001free after\u0002 seven?');
    expect(a).toBeTruthy();
  });

  test('from:, to:, with:, subject:, in:, label:, has:, is:, account: and dates', () => {
    const { put, s } = local();
    put('INBOX', { subject: 'Dinner on Friday?', from: [{ name: 'Sam Lee', email: 'sam@lee.example' }], receivedAt: T0 + H });
    put('Sent', { subject: 'Plans', from: [{ name: null, email: ME }], to: [{ name: 'Sam Lee', email: 'sam@lee.example' }], receivedAt: T0 + 2 * H, flags: flags({ seen: true }) });
    put('INBOX', { subject: 'Lease renewal', from: [{ name: 'Alex Kim', email: 'alex@work.example' }], cc: [{ name: 'Jo', email: 'jo@q.net' }], hasAttachments: true, labels: ['Work'], receivedAt: T0 + 3 * H, flags: flags({ seen: true, flagged: true }) });
    put('Archive', { subject: 'Rust Weekly 500', from: [{ name: null, email: 'news@letters.example' }], receivedAt: T0 - 40 * D, flags: flags({ seen: true }) });
    put('Work/Clients', { subject: 'Quote for Acme', from: [{ name: 'Pat', email: 'pat@acme.example' }], receivedAt: T0 - 2 * D, flags: flags({ seen: true }) });
    put('Junk', { subject: 'Cheap dinner deals', from: [{ name: null, email: 'spam@x.example' }], receivedAt: T0 + 4 * H });
    put('Trash', { subject: 'Old dinner plans', from: [{ name: 'Sam Lee', email: 'sam@lee.example' }], receivedAt: T0 - D, flags: flags({ seen: true }) });

    expect(find(s, 'from:sam')).toEqual(['Dinner on Friday?']);
    expect(find(s, 'from:"Sam Lee"')).toEqual(['Dinner on Friday?']);
    expect(find(s, 'to:sam')).toEqual(['Plans']);
    expect(find(s, 'to:jo')).toEqual(['Lease renewal']);
    expect(find(s, 'with:sam@lee.example')).toEqual(['Plans', 'Dinner on Friday?']);
    expect(find(s, 'subject:lease')).toEqual(['Lease renewal']);
    expect(find(s, 'subject:renewal alex')).toEqual(['Lease renewal']);
    expect(find(s, 'subject:alex')).toEqual([]);
    expect(find(s, 'in:archive')).toEqual(['Rust Weekly 500']);
    expect(find(s, 'in:Clients')).toEqual(['Quote for Acme']);
    expect(find(s, 'in:sent')).toEqual(['Plans']);
    expect(find(s, 'label:work')).toEqual(['Lease renewal']);
    expect(find(s, 'label:clients')).toEqual(['Quote for Acme']);
    expect(find(s, 'has:attachment')).toEqual(['Lease renewal']);
    expect(find(s, 'is:starred')).toEqual(['Lease renewal']);
    expect(find(s, 'is:unread')).toEqual(['Dinner on Friday?']);
    expect(find(s, 'is:read from:sam')).toEqual([]);
    expect(find(s, 'account:"work mail" lease')).toEqual(['Lease renewal']);
    expect(find(s, 'account:imap lease')).toEqual(['Lease renewal']);
    expect(find(s, 'account:nobody lease')).toEqual([]);
    expect(find(s, `before:${new Date(T0 - 30 * D).toISOString().slice(0, 10)}`)).toEqual(['Rust Weekly 500']);
    expect(find(s, `during:${new Date(T0).toISOString().slice(0, 10)}`)).toEqual(['Lease renewal', 'Plans', 'Dinner on Friday?']);
    // Junk and Trash only when asked for.
    expect(find(s, 'dinner')).toEqual(['Dinner on Friday?']);
    expect(find(s, 'dinner in:junk')).toEqual(['Cheap dinner deals']);
    expect(find(s, 'dinner in:trash')).toEqual(['Old dinner plans']);
    expect(find(s, 'dinner in:anywhere')).toEqual(['Cheap dinner deals', 'Dinner on Friday?', 'Old dinner plans']);
    expect(find(s, 'sort:oldest from:sam in:anywhere')).toEqual(['Old dinner plans', 'Dinner on Friday?']);
  });

  test('a message moved to Junk leaves the search, and comes back with it; one that changes thread is found in its new one', () => {
    const { st, put, s } = local();
    const sum = summary('INBOX', { subject: 'Win a prize', messageId: '<prize@x>' });
    st.ingest(ACC, st.mailboxByNative(ACC, 'INBOX')!, [sum]);
    expect(find(s, 'prize')).toEqual(['Win a prize']);
    // An IMAP move: there under a new id, gone from here.
    st.ingest(ACC, st.mailboxByNative(ACC, 'Junk')!, [{ ...sum, id: 'Junk.1.900', mailboxId: 'Junk' }]);
    st.dropLocations(st.mailboxByNative(ACC, 'INBOX')!.id, [sum.id]);
    expect(find(s, 'prize')).toEqual([]);
    expect(find(s, 'prize in:junk')).toEqual(['Win a prize']);
    st.ingest(ACC, st.mailboxByNative(ACC, 'INBOX')!, [{ ...sum, id: 'INBOX.1.901' }]);
    expect(find(s, 'prize')).toEqual(['Win a prize']);

    // Threaded on its own until its body names its parent.
    const a = put('INBOX', { subject: 'Garden plan', messageId: '<plan@x>', receivedAt: T0 });
    const b = put('INBOX', { subject: 'Seeds', messageId: '<seeds@x>', receivedAt: T0 + H });
    const thread = (id: string) => st.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', id)!.thread_id;
    expect(thread(b)).not.toBe(thread(a));
    storeBody(st, b, { ...summary('INBOX', { subject: 'Seeds' }), text: 'Tomatoes and basil.', html: null, attachments: [], bcc: [], replyTo: [], inReplyTo: '<plan@x>', references: ['<plan@x>'] });
    expect(thread(b)).toBe(thread(a));
    expect(s.local('basil').hits.map((h) => h.thread.id)).toEqual([thread(a)]);
  });

  test('from:, to: and with: know people: a name finds everyone it names, by any of their names, or a profile’s id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dither-mail-search-'));
    const chat = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    const signal = chat.createAccount({ network: 'signal', label: 's', color: '#111', adapter: 'signal' });
    chat.ingest(signal, { t: 'identity', identity: { nativeId: '+15550100', displayName: 'Sammy', contact: true } });
    const fake = new FakeMailBackend();
    fake.addAccount(ACC, { email: ME });
    fake.put(ACC, { mailboxId: 'Sent', messageId: '<d1@x>', from: [{ name: null, email: ME }], to: [{ name: 'S. Rivera', email: 'sam@rivera.example' }], subject: 'Dinner?', receivedAt: T0 });
    fake.put(ACC, { messageId: '<d2@x>', inReplyTo: '<d1@x>', references: ['<d1@x>'], from: [{ name: 'S. Rivera', email: 'sam@rivera.example' }], to: [{ name: null, email: ME }], subject: 'Re: Dinner?', receivedAt: T0 + H });
    fake.put(ACC, { messageId: '<o1@x>', from: [{ name: 'Other', email: 'other@example.net' }], subject: 'Unrelated', receivedAt: T0 + 2 * H });
    const h = new MailHub({ db: chat.db, backend: fake, log: () => {} });
    hub = h;
    const people = mailPeople(h)!;
    people.connect(chat);
    h.start();
    try {
      await h.sync(ACC)!.whenSynced();
      people.settle();
      const s = mailSearchOf(h)!;
      expect(find(s, 'from:Sammy')).toEqual([]);
      const bySignal = chat.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', hubId('idn', 'signal', '+15550100'))!.person_id;
      const byMail = chat.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', hubId('idn', 'email', 'sam@rivera.example'))!.person_id;
      chat.mergePersons(bySignal, byMail);
      const sam = chat.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', hubId('idn', 'email', 'sam@rivera.example'))!.person_id;
      expect(find(s, 'from:Sammy')).toEqual(['Re: Dinner?']);
      expect(find(s, 'to:sammy')).toEqual(['Re: Dinner?']);
      expect(find(s, `with:${sam}`)).toEqual(['Re: Dinner?']);
      expect(find(s, `with:${hubId('idn', 'email', 'sam@rivera.example')}`)).toEqual(['Re: Dinner?']);
    } finally {
      people.stop();
      h.stop();
      hub = null;
      chat.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('inside words, CJK, and misspelt words corrected', () => {
    const { put, s } = local();
    put('INBOX', { subject: 'Quarterly numbers', receivedAt: T0 }, 'The spreadsheet is attached.');
    put('INBOX', { subject: 'Tokyo', receivedAt: T0 + H }, '東京で会いましょう');
    let p = s.local('sheet');
    expect([subjects(p), p.mode, p.hits[0].snippet]).toEqual([['Quarterly numbers'], 'substring', 'The spread\u0001sheet\u0002 is attached.']);
    p = s.local('東京');
    expect([subjects(p), p.mode]).toEqual([['Tokyo'], 'substring']);
    p = s.local('spredsheet');
    expect([subjects(p), p.corrected]).toEqual([['Quarterly numbers'], 'spreadsheet']);
    expect(s.local('').hits).toEqual([]);
  });

  test('pages by cursor, newest first', () => {
    const { put, s } = local();
    for (let i = 0; i < 7; i++) put('INBOX', { subject: `Report ${i}`, receivedAt: T0 + i * H });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p = s.local('report', 3, cursor);
      seen.push(...subjects(p));
      cursor = p.next;
    } while (cursor);
    expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0].map((i) => `Report ${i}`));
  });

  test('a body’s text is searched once stored, stays after the body cache lets it go, and goes under slice 2’s cap', () => {
    const { st, put, s } = local();
    const body = (subject: string, text: string): M.MailMessage => ({ ...summary('INBOX', { subject }), text, html: null, attachments: [], bcc: [], replyTo: [], inReplyTo: null, references: [] });
    const id = put('INBOX', { subject: 'Hello', receivedAt: T0 + 9 * H });
    expect(find(s, 'pineapple')).toEqual([]);
    storeBody(st, id, body('Hello', 'A pineapple for you.'));
    expect(find(s, 'pineapple')).toEqual(['Hello']);
    // The body cache lets every body go: the search text stays (mail_text).
    const cache = new BodyCache(st);
    expect(cache.evict(0)).toContain(id);
    expect(st.one('SELECT 1 FROM mail_body WHERE message_id = ?', id)).toBeNull();
    expect(find(s, 'pineapple')).toEqual(['Hello']);
    // Only the first 16 KB.
    storeBody(st, id, body('Hello', `${'filler '.repeat(3000)} kumquat`));
    expect(find(s, 'kumquat')).toEqual([]);
    expect(find(s, 'filler')).toEqual(['Hello']);

    // Slice 2's cap on the search text, oldest mail first: their text goes back to the preview.
    for (let i = 0; i < 3; i++) put('INBOX', { subject: `Note ${i}`, receivedAt: T0 + i * H }, `Body ${i} ${'filler '.repeat(40)}lychee${i} ${'x'.repeat(20_000)}`);
    expect(cache.trimText(0.05 * 1024 * 1024)).toBe(2);
    expect(find(s, 'lychee0')).toEqual([]);
    expect(find(s, 'lychee1')).toEqual([]);
    expect(find(s, 'lychee2')).toEqual(['Note 2']);
    expect(find(s, 'body')).toEqual(['Note 2', 'Note 1', 'Note 0']);
    expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_search WHERE full = 1')!.n).toBe(2);

    // A message the server deleted leaves the index.
    st.db.query('DELETE FROM mail_location WHERE message_id = ?').run(id);
    st.deleteOrphans([id]);
    expect(find(s, 'filler')).toEqual(['Note 2', 'Note 1', 'Note 0']);
    expect(st.one('SELECT 1 FROM mail_search WHERE message_id = ?', id)).toBeNull();
  });

  test('a body slice 2 fetches ahead is searchable without anything asking for it', async () => {
    Object.assign(MAIL_LIMITS, { backgroundPerSec: 1000, userPauseMs: 0 });
    const fake = new FakeMailBackend();
    fake.addAccount(ACC, { email: ME, mailboxes: BOXES });
    fake.put(ACC, { messageId: '<ahead@x>', from: [{ name: 'Sam Lee', email: 'sam@lee.example' }], subject: 'Plans', text: 'Bring the rambutan on Friday.', receivedAt: Date.now() - H });
    const db = new Database(':memory:', { strict: true });
    db.exec('PRAGMA foreign_keys = ON');
    hub = new MailHub({ db, backend: fake, log: () => {} });
    hub.start();
    await hub.sync(ACC)!.whenSynced();
    const s = mailSearchOf(hub)!;
    const end = Date.now() + 8000;
    while (!s.local('rambutan').hits.length && Date.now() < end) await Bun.sleep(20);
    expect(fake.calls.some((c) => c.op === 'mail.get')).toBe(true);
    expect(subjects(s.local('rambutan'))).toEqual(['Plans']);
    expect(s.local('rambutan').hits[0].snippet).toContain('\u0001rambutan\u0002');
  });

  test('mail from before the index is indexed once, with the text slice 2 already holds', () => {
    const { st, put, s } = local();
    put('INBOX', { subject: 'Before' }, 'durian');
    st.db.exec('DELETE FROM mail_search');
    expect(find(s, 'durian')).toEqual([]);
    expect(s.backfill()).toBe(1);
    expect(find(s, 'durian')).toEqual(['Before']);
    expect(s.backfill()).toBe(0);
  });
});

/**
 * A hub on the fake server. What is past the year the hub keeps (slice 2's horizon), or in a folder it does not follow,
 * only the server has.
 */
const OLD = Date.now() - 400 * D;
async function served(opts: FakeOpts = {}, seed: (f: FakeMailBackend) => void = () => {}, kind?: string) {
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME, opts, mailboxes: BOXES, ...(kind ? { kind } : {}) });
  seed(fake);
  const db = new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  hub = new MailHub({ db, backend: fake, log: () => {} });
  const ingested: string[] = [];
  hub.on('ingested', (e) => ingested.push(...e.messageIds));
  hub.start();
  await hub.sync(ACC)!.whenSynced();
  return { fake, hub, st: hub.store, s: mailSearchOf(hub)!, ingested };
}

describe('the servers’ search', () => {
  test('the hub’s hits first, then the server’s it did not have, stored to open like any other', async () => {
    const { fake, st, s, ingested } = await served({}, (f) => {
      f.put(ACC, { messageId: '<march@x>', subject: 'Invoice March', receivedAt: T0 });
      f.put(ACC, { mailboxId: 'Archive', messageId: '<feb@x>', subject: 'Invoice February', receivedAt: OLD - 30 * D });
      f.put(ACC, { mailboxId: 'Archive', messageId: '<jan@x>', subject: 'Invoice January', receivedAt: OLD - 60 * D });
    });
    const p = await s.search('invoice', { server: 'auto' });
    expect(subjects(p)).toEqual(['Invoice March']);
    expect(p.hits[0].server).toBeUndefined();
    expect(subjects(p.server!.hits)).toEqual(['Invoice February', 'Invoice January']);
    expect(p.server!.hits.every((h) => h.server)).toBe(true);
    expect(p.server!.accounts).toEqual([{ accountId: ACC, state: 'done', found: 3, error: null, note: null }]);
    expect(fake.calls.filter((c) => c.op === 'mail.search').map((c) => c.input)).toEqual([{ query: 'invoice', limit: 50 }]);
    // Stored: the next search finds them here, and they open like any other.
    const feb = mailId('mml', ACC, 'm:<feb@x>');
    expect(ingested).toContain(feb);
    expect(subjects(s.local('invoice'))).toEqual(['Invoice March', 'Invoice February', 'Invoice January']);
    expect(hub!.threadDetail(st.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', feb)!.thread_id)!.messages.map((m) => m.subject)).toEqual(['Invoice February']);
    // Asked again: the hub has them all now, so the server adds nothing.
    expect((await s.search('invoice', { server: true })).server!.hits).toEqual([]);
  });

  test('auto asks only for a first page under 20 hits; server=1 always; none by default', async () => {
    const { fake, s } = await served({}, (f) => {
      for (let i = 0; i < 25; i++) f.put(ACC, { subject: `Ticket ${i}`, receivedAt: T0 + i * H });
    });
    const asked = () => fake.calls.filter((c) => c.op === 'mail.search').length;
    expect((await s.search('ticket')).server).toBeUndefined();
    expect((await s.search('ticket', { server: 'auto' })).server).toBeUndefined();
    expect((await s.search('ticket', { server: 'auto', limit: 10, cursor: '9999999999999:zzz' })).server).toBeUndefined();
    expect(asked()).toBe(0);
    expect((await s.search('ticket', { server: true })).server!.hits).toEqual([]);
    expect(asked()).toBe(1);
  });

  test('deduplicated: a message the server names twice, and a thread the hub already found, show once', async () => {
    const { s } = await served({ threadIds: true }, (f) => {
      // Gmail lists a message in each of its labels; the hub keys it by Message-ID.
      f.put(ACC, { mailboxId: 'Archive', messageId: '<twice@x>', threadId: 't1', subject: 'Budget draft', receivedAt: OLD - 10 * D });
      f.put(ACC, { mailboxId: 'Work/Clients', messageId: '<twice@x>', threadId: 't1', subject: 'Budget draft', receivedAt: OLD - 10 * D });
      // A thread the hub holds: its old message only the server has.
      f.put(ACC, { messageId: '<new@x>', threadId: 't2', subject: 'Re: budget review', receivedAt: T0 });
      f.put(ACC, { mailboxId: 'Archive', messageId: '<old@x>', threadId: 't2', subject: 'Budget review', receivedAt: OLD - 20 * D });
    });
    const p = await s.search('budget', { server: true });
    expect(subjects(p)).toEqual(['Re: budget review']);
    expect(subjects(p.server!.hits)).toEqual(['Budget draft']);
    expect(p.server!.accounts[0].found).toBe(4);
  });

  test('a message the hub holds without the text that matched: from the server', async () => {
    const { s } = await served({}, (f) => {
      f.put(ACC, { subject: 'Hello', text: 'The quarterly figures are in.', receivedAt: T0 });
    });
    const p = await s.search('quarterly', { server: 'auto' });
    expect(p.hits).toEqual([]);
    expect(subjects(p.server!.hits)).toEqual(['Hello']);
    expect(p.server!.hits[0].server).toBe(true);
  });

  test('the query’s operators hold for the server’s hits too', async () => {
    const { fake, s } = await served({}, (f) => {
      f.put(ACC, { mailboxId: 'Archive', subject: 'Invoice old', from: [{ name: 'Sam', email: 'sam@lee.example' }], flags: { seen: true }, receivedAt: OLD - 30 * D });
      f.put(ACC, { mailboxId: 'Archive', subject: 'Invoice new', from: [{ name: 'Sam', email: 'sam@lee.example' }], receivedAt: OLD - 20 * D });
      f.put(ACC, { mailboxId: 'Archive', subject: 'Invoice Pat', from: [{ name: 'Pat', email: 'pat@acme.example' }], receivedAt: OLD - 10 * D });
    });
    const p = await s.search('invoice from:sam is:unread', { server: true });
    expect(subjects(p.server!.hits)).toEqual(['Invoice new']);
    expect(fake.calls.find((c) => c.op === 'mail.search')!.input.query).toBe('invoice sam');
    // Only filters: nothing for an IMAP server to look for.
    const f = await s.search('is:unread', { server: true });
    expect(f.server!.accounts[0]).toMatchObject({ state: 'skipped', found: 0 });
  });

  test('in: one mailbox asks the server about that mailbox only', async () => {
    const { fake, s } = await served({}, (f) => {
      f.put(ACC, { mailboxId: 'Work/Clients', subject: 'Acme quote', receivedAt: OLD - 10 * D });
      f.put(ACC, { mailboxId: 'Archive', subject: 'Acme newsletter', receivedAt: OLD - 9 * D });
    });
    const p = await s.search('acme in:clients', { server: true });
    expect(subjects(p.server!.hits)).toEqual(['Acme quote']);
    expect(fake.calls.find((c) => c.op === 'mail.search')!.input).toEqual({ query: 'acme', limit: 50, mailboxId: 'Work/Clients' });
  });

  test("Proton's server searches subjects and addresses only, and says so; text is searched here once fetched", async () => {
    const { st, s } = await served({ ids: 'proton', state: 'account', events: 'all' }, (f) => {
      f.put(ACC, { messageId: '<fruit@x>', subject: 'Fruit', text: 'A pineapple for you.', receivedAt: T0 });
      f.put(ACC, { mailboxId: 'Archive', messageId: '<old@x>', subject: 'Pineapple recipes', receivedAt: OLD - 30 * D });
    });
    let p = await s.search('pineapple', { server: 'auto' });
    expect(p.hits).toEqual([]);
    expect(subjects(p.server!.hits)).toEqual(['Pineapple recipes']);
    expect(p.server!.accounts).toEqual([{ accountId: ACC, state: 'done', found: 1, error: null, note: PROTON_NOTE }]);
    await hub!.body(mailId('mml', ACC, 'm:<fruit@x>'));
    p = await s.search('pineapple', { server: 'auto' });
    expect(subjects(p)).toEqual(['Fruit', 'Pineapple recipes']);
    expect(p.server!.hits).toEqual([]);
    expect(st.account(ACC)!.kind).toBe('proton');
  });

  test('a server that fails or is offline: the hub’s hits still come, with why', async () => {
    const { fake, s } = await served({}, (f) => {
      f.put(ACC, { subject: 'Invoice March', receivedAt: T0 });
    });
    fake.fail('mail.search', new MailCallError('the server is busy', 503));
    let p = await s.search('invoice', { server: true });
    expect(subjects(p)).toEqual(['Invoice March']);
    expect(p.server!.accounts[0]).toMatchObject({ state: 'failed', error: 'the server is busy' });
    fake.setOnline(ACC, false);
    await Bun.sleep(5);
    p = await s.search('invoice', { server: true });
    expect(p.server!.accounts[0]).toMatchObject({ state: 'offline' });
    expect(subjects(p)).toEqual(['Invoice March']);
  });

  test('GET /api/mail/search', async () => {
    await served({}, (f) => {
      f.put(ACC, { subject: 'Invoice March', receivedAt: T0 });
      f.put(ACC, { mailboxId: 'Archive', subject: 'Invoice February', receivedAt: OLD - 30 * D });
    });
    const get = async (qs: string) => {
      const url = new URL(`http://hub/api/mail/search?${qs}`);
      const r = await hub!.route(new Request(url), url);
      return (await r!.json()) as P.MailSearchPage;
    };
    const local = await get('q=invoice');
    expect([subjects(local), local.server]).toEqual([['Invoice March'], undefined]);
    const both = await get('q=invoice&server=1');
    expect([subjects(both), subjects(both.server!.hits)]).toEqual([['Invoice March'], ['Invoice February']]);
  });
});
