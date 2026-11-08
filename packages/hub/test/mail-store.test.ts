/** MailStore (mail/store.ts): ingest, locations, threads, bodies, read state, lists, accounts and what flushes. */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import type * as M from '@dither-chat/protocol/mail-iface';
import { mailId } from '@dither-chat/protocol/ids';
import { MAIL_LIMITS } from '../src/mail/limits.ts';
import { htmlText, MailStore } from '../src/mail/store.ts';

const ACC = 'acc_storeTest1';
const ME = 'me@example.com';
const T0 = Date.UTC(2026, 10, 1, 12);
const H = 3_600_000;

let now = T0;
let st: MailStore;
const box = (native: string) => st.mailboxByNative(ACC, native)!;

const sum = (s: Partial<M.MailSummary> & { id: string }): M.MailSummary => ({
  mailboxId: 'INBOX',
  messageId: `<${s.id}@example.org>`,
  threadId: null,
  from: [{ name: 'Alice', email: 'alice@example.org' }],
  to: [{ name: null, email: ME }],
  cc: [],
  subject: 'Hello there friend',
  date: T0,
  receivedAt: T0,
  flags: { seen: false, flagged: false, answered: false, draft: false },
  labels: [],
  size: 100,
  preview: null,
  hasAttachments: false,
  ...s,
});

const body = (s: M.MailSummary, b: Partial<M.MailMessage>): M.MailMessage => ({ ...s, bcc: [], replyTo: [], inReplyTo: s.inReplyTo ?? null, references: s.references ?? [], text: null, html: null, attachments: [], ...b });

beforeEach(() => {
  const db = new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  now = T0;
  st = new MailStore(db, () => now);
  st.upsertAccount({ id: ACC, kind: 'imap', label: 'Mail', level: 'write', dryRun: false, online: true });
  st.setStatus(ACC, { status: 'online', self: { email: ME }, layers: [{ name: 'inbox', state: 'ok' }] });
  st.putMailboxes(ACC, [
    { id: 'INBOX', name: 'Inbox', path: 'INBOX', parentId: null, role: 'inbox', unread: 1, total: 1 },
    { id: 'Sent', name: 'Sent', path: 'Sent', parentId: null, role: 'sent', unread: 0, total: 0 },
    { id: 'Archive', name: 'Archive', path: 'Archive', parentId: null, role: 'archive', unread: 0, total: 0 },
    { id: 'Work', name: 'Work', path: 'Work', parentId: null, role: null, unread: 0, total: 0 },
  ]);
  st.flush(() => ({ state: 'granted', managerUrl: null }));
});

const thread = (messageNative: string, mailbox = 'INBOX') => {
  const r = st.one<{ thread_id: string }>('SELECT m.thread_id FROM mail_location l JOIN mail_message m ON m.id = l.message_id WHERE l.native_id = ? AND l.mailbox_id = ?', messageNative, box(mailbox).id);
  return r?.thread_id ?? null;
};

describe('mailboxes', () => {
  test('Inbox, Sent and Archive are followed; other folders are not', () => {
    const f = st.followed(ACC).map((b) => b.native_id);
    expect(f).toEqual(['INBOX', 'Sent', 'Archive']);
    // With an All mailbox (Gmail, Proton), that one is followed instead of Archive.
    st.putMailboxes(ACC, [
      { id: 'INBOX', name: 'Inbox', path: 'INBOX', parentId: null, role: 'inbox', unread: 0, total: 0 },
      { id: 'Sent', name: 'Sent', path: 'Sent', parentId: null, role: 'sent', unread: 0, total: 0 },
      { id: 'Archive', name: 'Archive', path: 'Archive', parentId: null, role: 'archive', unread: 0, total: 0 },
      { id: 'All', name: 'All mail', path: 'All', parentId: null, role: 'all', unread: 0, total: 0 },
    ]);
    expect(st.followed(ACC).map((b) => b.native_id)).toEqual(['INBOX', 'Sent', 'All']);
    expect(st.mailboxes(ACC).find((b) => b.native_id === 'Work')).toBeUndefined();
  });
});

describe('ingest', () => {
  test('one Message-ID in two mailboxes is one message with two locations', () => {
    const a = st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.1', messageId: '<same@x>' })]);
    const b = st.ingest(ACC, box('Archive'), [sum({ id: 'Archive.1.9', mailboxId: 'Archive', messageId: '<same@x>' })]);
    expect(a.added).toHaveLength(1);
    expect(b.added).toHaveLength(0);
    const id = mailId('mml', ACC, 'm:<same@x>');
    expect(st.all('SELECT mailbox_id FROM mail_location WHERE message_id = ?', id)).toHaveLength(2);
    const t = st.threadView(st.thread(thread('INBOX.1.1')!)!);
    expect(t.roles.sort()).toEqual(['archive', 'inbox']);
  });

  test('summaries with In-Reply-To and References thread as they come', () => {
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.1', messageId: '<a@x>', subject: 'Plans' })]);
    st.ingest(ACC, box('Sent'), [sum({ id: 'Sent.1.1', mailboxId: 'Sent', messageId: '<b@x>', subject: 'Re: Plans', from: [{ name: null, email: ME }], to: [{ name: 'Alice', email: 'alice@example.org' }], inReplyTo: '<a@x>', references: ['<a@x>'], receivedAt: T0 + H })]);
    // A reply with a different subject still threads by its headers.
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.2', messageId: '<c@x>', subject: 'Different words', inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'], receivedAt: T0 + 2 * H })]);
    const t = thread('INBOX.1.1')!;
    expect(thread('Sent.1.1', 'Sent')).toBe(t);
    expect(thread('INBOX.1.2')).toBe(t);
    const v = st.threadView(st.thread(t)!);
    expect(v.count).toBe(3);
    expect(v.from.map((f) => [f.email, !!f.self])).toEqual([
      ['me@example.com', true],
      ['alice@example.org', false],
    ]);
    expect(v.lastFromMe).toBe(false);
  });

  test('the parent arriving after its reply joins the reply’s thread', () => {
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.2', messageId: '<child@x>', inReplyTo: '<parent@x>', references: ['<parent@x>'], subject: 'Re: Plans' })]);
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.1', messageId: '<parent@x>', subject: 'Plans', receivedAt: T0 - H })]);
    expect(thread('INBOX.1.1')).toBe(thread('INBOX.1.2'));
  });

  test('a message linking two threads merges them, and the merged one is reported gone', () => {
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.1', messageId: '<a@x>', subject: 'First topic' })]);
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.2', messageId: '<b@x>', subject: 'Second topic', receivedAt: T0 + H })]);
    const [ta, tb] = [thread('INBOX.1.1')!, thread('INBOX.1.2')!];
    expect(ta).not.toBe(tb);
    st.flush(() => ({ state: 'granted', managerUrl: null }));
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.3', messageId: '<c@x>', subject: 'Both', inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'], receivedAt: T0 + 2 * H })]);
    expect(thread('INBOX.1.2')).toBe(ta);
    expect(thread('INBOX.1.3')).toBe(ta);
    const ev = st.flush(() => ({ state: 'granted', managerUrl: null })).find((e) => e.t === 'mail.threads') as Extract<P.ClientEvent, { t: 'mail.threads' }>;
    expect(ev.removed).toContain(tb);
    expect(ev.threads.map((t) => t.id)).toContain(ta);
  });

  test('without headers (plain IMAP summaries), a provisional thread by subject moves when mail.get brings references', () => {
    // Two unrelated threads that share a subject and a person.
    const root = sum({ id: 'INBOX.1.1', messageId: '<root@x>', subject: 'Status update for the project' });
    const other = sum({ id: 'INBOX.1.2', messageId: '<other@x>', subject: 'Status update for the project', receivedAt: T0 + H });
    st.ingest(ACC, box('INBOX'), [root]);
    const reply = sum({ id: 'INBOX.1.3', messageId: '<reply@x>', subject: 'Re: Status update for the project', receivedAt: T0 + 2 * H });
    st.ingest(ACC, box('INBOX'), [other, reply]);
    // By subject alone, all three are one provisional thread.
    expect(thread('INBOX.1.2')).toBe(thread('INBOX.1.1'));
    // A separate thread the reply really belongs to, by its id.
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.4', messageId: '<elsewhere@x>', subject: 'Something unrelated', receivedAt: T0 - 5 * H })]);
    const real = thread('INBOX.1.4')!;
    st.putBody(mailId('mml', ACC, 'm:<reply@x>'), body(reply, { text: 'answer', inReplyTo: '<elsewhere@x>', references: ['<elsewhere@x>'] }));
    expect(thread('INBOX.1.3')).toBe(real);
    expect(thread('INBOX.1.1')).toBe(thread('INBOX.1.2'));
  });

  test('the server’s flags win, except one with a change of ours it has not confirmed', () => {
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.1' })]);
    const id = mailId('mml', ACC, 'm:<INBOX.1.1@example.org>');
    st.changeFlags(box('INBOX').id, [{ id: 'INBOX.1.1', flags: { seen: true, flagged: true, answered: false, draft: false }, labels: ['work'] }]);
    let m = st.one('SELECT * FROM mail_message WHERE id = ?', id)!;
    expect([m.seen, m.flagged, m.labels]).toEqual([1, 1, '["work"]']);
    st.db.query(`UPDATE mail_message SET pending = '{"flagged":true}' WHERE id = ?`).run(id);
    st.changeFlags(box('INBOX').id, [{ id: 'INBOX.1.1', flags: { seen: true, flagged: false, answered: false, draft: false }, labels: [] }]);
    m = st.one('SELECT * FROM mail_message WHERE id = ?', id)!;
    expect(m.flagged).toBe(1);
    // An id the hub does not hold is ignored.
    expect(() => st.changeFlags(box('INBOX').id, [{ id: 'INBOX.1.99', flags: { seen: true, flagged: false, answered: false, draft: false }, labels: [] }])).not.toThrow();
  });

  test('bulk headers are kept for classification (slice 8)', () => {
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.1', bulk: { listId: '<l.example>', unsubscribe: null, precedence: 'list', autoSubmitted: null } })]);
    expect(JSON.parse(st.one<{ bulk: string }>('SELECT bulk FROM mail_message')!.bulk)).toEqual({ listId: '<l.example>', unsubscribe: null, precedence: 'list', autoSubmitted: null });
  });
});

describe('removal', () => {
  test('a message with no location left is deleted with its body and its empty thread; unknown ids are ignored', () => {
    const s = sum({ id: 'INBOX.1.1' });
    st.ingest(ACC, box('INBOX'), [s]);
    const id = mailId('mml', ACC, 'm:<INBOX.1.1@example.org>');
    st.putBody(id, body(s, { text: 'hi' }));
    const t = thread('INBOX.1.1')!;
    expect(st.dropLocations(box('INBOX').id, ['INBOX.1.42'])).toEqual([]);
    const orphans = st.dropLocations(box('INBOX').id, ['INBOX.1.1']);
    expect(orphans).toEqual([id]);
    // Moved meanwhile: a location elsewhere keeps it.
    st.ingest(ACC, box('Archive'), [sum({ id: 'Archive.1.5', mailboxId: 'Archive', messageId: '<INBOX.1.1@example.org>' })]);
    expect(st.deleteOrphans(orphans)).toEqual([]);
    expect(st.body(id)).not.toBeNull();
    expect(st.dropLocations(box('Archive').id, ['Archive.1.5'])).toEqual([id]);
    expect(st.deleteOrphans([id])).toEqual([id]);
    expect(st.body(id)).toBeNull();
    expect(st.thread(t)).toBeNull();
  });
});

describe('bodies', () => {
  test('an HTML-only message gets text made from its HTML, without scripts or styles', () => {
    const s = sum({ id: 'INBOX.1.1' });
    st.ingest(ACC, box('INBOX'), [s]);
    const id = mailId('mml', ACC, 'm:<INBOX.1.1@example.org>');
    st.putBody(id, body(s, { html: '<style>p{}</style><script>alert(1)</script><p>Your order <b>shipped</b>.</p><p><a href="https://shop.example/t">Track it</a></p><img src="https://t.example/p.gif" width=1>' }));
    const v = st.bodyView(id)!;
    expect(v.text).toBe('Your order shipped.\n\nTrack it [https://shop.example/t]');
    expect(v.html).toBeNull();
    expect(st.threadView(st.thread(thread('INBOX.1.1')!)!).preview).toBe('Your order shipped. Track it [https://shop.example/t]');
  });

  test('htmlText decodes entities and keeps lines', () => {
    expect(htmlText('a&amp;b&nbsp;&lt;c&gt;<br>d&#33;&#x21;')).toBe('a&b <c>\nd!!');
  });

  test('the preview leaves out the quote and the signature; quoteAt says where the quote starts', () => {
    const s = sum({ id: 'INBOX.1.1' });
    st.ingest(ACC, box('INBOX'), [s]);
    const id = mailId('mml', ACC, 'm:<INBOX.1.1@example.org>');
    const text = 'Sounds good.\n\n-- \nAlice\n\nOn Mon, Bob <bob@x.org> wrote:\n> earlier\n> words';
    st.putBody(id, body(s, { text }));
    expect(st.bodyView(id)!.quoteAt).toBe(text.indexOf('On Mon'));
    expect(st.one<{ preview: string }>('SELECT preview FROM mail_message WHERE id = ?', id)!.preview).toBe('Sounds good.');
  });
});

describe('read state', () => {
  test('read here lowers the count without telling the server; marked unread elsewhere shows unread again', () => {
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.1' }), sum({ id: 'INBOX.1.2', inReplyTo: '<INBOX.1.1@example.org>', receivedAt: T0 + H })]);
    const t = thread('INBOX.1.1')!;
    expect(st.thread(t)!.unread).toBe(2);
    expect(st.markReadHere([t])).toEqual([t]);
    expect(st.thread(t)!.unread).toBe(0);
    expect(st.markReadHere([t])).toEqual([]);
    // Seen on the server, then marked unread there.
    st.changeFlags(box('INBOX').id, [{ id: 'INBOX.1.2', flags: { seen: true, flagged: false, answered: false, draft: false }, labels: [] }]);
    st.changeFlags(box('INBOX').id, [{ id: 'INBOX.1.2', flags: { seen: false, flagged: false, answered: false, draft: false }, labels: [] }]);
    expect(st.thread(t)!.unread).toBe(1);
  });
});

describe('lists', () => {
  beforeEach(() => {
    const inbox = Array.from({ length: 7 }, (_, i) => sum({ id: `INBOX.1.${i}`, subject: `Topic number ${i}`, receivedAt: T0 + i * H, flags: { seen: i % 2 === 0, flagged: i === 3, answered: false, draft: false } }));
    st.ingest(ACC, box('INBOX'), inbox);
    st.ingest(ACC, box('Sent'), [sum({ id: 'Sent.1.1', mailboxId: 'Sent', subject: 'Sent only', from: [{ name: null, email: ME }], to: [{ name: null, email: 'bob@x.org' }], receivedAt: T0 + 10 * H, flags: { seen: true, flagged: false, answered: false, draft: false } })]);
  });

  test('inbox, newest first, page by page', () => {
    const p1 = st.listThreads('v:inbox:*', null, 3)!;
    expect(p1.threads.map((t) => t.subject)).toEqual(['Topic number 6', 'Topic number 5', 'Topic number 4']);
    const p2 = st.listThreads('v:inbox:*', p1.next, 3)!;
    expect(p2.threads.map((t) => t.subject)).toEqual(['Topic number 3', 'Topic number 2', 'Topic number 1']);
    const p3 = st.listThreads('v:inbox:*', p2.next, 3)!;
    expect(p3.threads.map((t) => t.subject)).toEqual(['Topic number 0']);
    expect(p3.next).toBeNull();
    // The hub has not listed Inbox to its end.
    expect(p3.complete).toBe(false);
    st.setListed(box('INBOX').id, { next: null, horizon: T0, complete: true });
    expect(st.listThreads('v:inbox:*', p2.next, 3)!.complete).toBe(true);
  });

  test('sent, unread, starred, one mailbox, one account; unknown lists and later views are refused', () => {
    expect(st.listThreads(`v:sent:${ACC}`, null, 50)!.threads.map((t) => t.subject)).toEqual(['Sent only']);
    expect(st.listThreads('v:unread:*', null, 50)!.threads.map((t) => t.subject)).toEqual(['Topic number 5', 'Topic number 3', 'Topic number 1']);
    expect(st.listThreads('v:starred:*', null, 50)!.threads.map((t) => t.subject)).toEqual(['Topic number 3']);
    expect(st.listThreads(`mb:${box('Sent').id}`, null, 50)!.threads).toHaveLength(1);
    expect(st.listThreads('v:inbox:acc_other', null, 50)!.threads).toHaveLength(0);
    expect(st.listThreads('v:people:*', null, 50)).toBeNull();
    expect(st.listThreads('bogus', null, 50)).toBeNull();
  });

  test('the bootstrap carries each account’s newest Inbox page', () => {
    const b = st.bootstrap({ state: 'granted', managerUrl: null });
    expect(b.threads.length).toBe(7);
    expect(b.accounts[0].sync.synced).toBe(8);
    expect(b.mailboxes.map((m) => m.role)).toContain('inbox');
  });
});

describe('accounts', () => {
  test('status: the problem, sending, the addresses an account sends as', () => {
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.1', to: [{ name: null, email: 'Other@Example.com' }] })]);
    expect(st.one<{ addressed: string }>('SELECT addressed FROM mail_message')!.addressed).toBe('hidden');
    st.setStatus(ACC, {
      status: 'attention',
      attention: { message: 'Sign in to Proton in the live view' },
      self: { email: ME, addresses: [{ email: 'other@example.com', name: null }] },
      details: { canSend: false, sendNote: "Proton's send path was not found" },
      layers: [{ name: 'signed in', state: 'failed' }],
    });
    const v = st.accountView(st.account(ACC)!);
    expect(v.problem).toEqual({ layer: 'signed in', message: 'Sign in to Proton in the live view' });
    expect(v.send).toEqual({ ok: false, why: "Proton's send path was not found" });
    expect(v.online).toBe(false);
    // Its addresses known now: the message was to one of them.
    expect(st.one<{ addressed: string }>('SELECT addressed FROM mail_message')!.addressed).toBe('to');
    // Without canSend, a failed send layer says so.
    st.setStatus(ACC, { status: 'online', self: { email: ME }, layers: [{ name: 'SMTP', state: 'failed', note: 'login refused' }] });
    expect(st.accountView(st.account(ACC)!).send).toEqual({ ok: false, why: 'login refused' });
  });

  test('access ended: kept for a day, then deleted with everything of it', () => {
    st.ingest(ACC, box('INBOX'), [sum({ id: 'INBOX.1.1' })]);
    expect(st.accessEnded(ACC, now)).toBe(true);
    expect(st.accessEnded(ACC, now + 5)).toBe(false);
    expect(st.accountView(st.account(ACC)!)).toMatchObject({ level: null, deleteAt: now + MAIL_LIMITS.goneMs });
    expect(st.goneBefore(now + MAIL_LIMITS.goneMs - 1 - MAIL_LIMITS.goneMs)).toEqual([]);
    expect(st.goneBefore(now)).toEqual([ACC]);
    // Back on the manager's list: kept.
    st.upsertAccount({ id: ACC, kind: 'imap', label: 'Mail', level: 'read', dryRun: false });
    expect(st.account(ACC)!.gone_at).toBeNull();
    st.flush(() => ({ state: 'granted', managerUrl: null }));
    st.deleteAccount(ACC);
    for (const t of ['mail_account', 'mailbox', 'mail_message', 'mail_location', 'mail_thread', 'mail_ref', 'mail_body']) expect(st.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n).toBe(0);
    const evs = st.flush(() => ({ state: 'granted', managerUrl: null }));
    expect(evs.map((e) => e.t)).toEqual(['mail.threads', 'mail.account.removed']);
  });
});
