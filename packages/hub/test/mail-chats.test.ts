/**
 * Mail as chats (mail/places.ts, mail/chatpage.ts, rungs.ts, docs/mail.md "Mail as chats") against FakeMailBackend, a
 * real chat store and the hub's server: where each thread is shown, a person's routes by email, their chat as chat and
 * mail by one cursor, one mail to two accounts shown once, what they wrote in threads with others and how each shows, and
 * the endpoints. Invented people and addresses only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { FakeMailBackend } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailPeople, type MailPeople } from '../src/mail/people.ts';
import { mailPlaces, type MailPlaces } from '../src/mail/places.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { excerptOf } from '../src/rungs.ts';
import { Triage } from '../src/triage.ts';

const ACC = 'acc_chatsMailOne';
const ACC2 = 'acc_chatsMailTwo';
const ME = { name: 'Robin Vale', email: 'me@example.com' };
const ME2 = { name: 'Robin Vale', email: 'me2@example.org' };
const SAM = { name: 'Sam Rivera', email: 'sam@rivera.example' };
const SAM_WORK = { name: 'Sam Rivera', email: 'sam@work.example' };
const ALICE = { name: 'Alice Chen', email: 'alice@example.org' };
const JO = { name: 'Jo Park', email: 'jo@park.example' };
const THEO = { name: 'Theo', email: 'theo@example.net' };
const NEWS = { name: 'Rust Weekly', email: 'newsletter@rust.example' };
const H = 3_600_000;
const DAY = 24 * H;
/** Old mail: a fixed day. Recent mail (what awaits you) is put relative to now. */
const T0 = Date.UTC(2026, 0, 5, 12);
const NOW = Date.now();

const dir = mkdtempSync(join(tmpdir(), 'dither-mail-chats-'));
let store: Store;
let server: HubServer;
let hub: MailHub;
let people: MailPeople;
let places: MailPlaces;
let fake: FakeMailBackend;
let url = '';
const events: P.ClientEvent[] = [];

const call = async <T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> => {
  const res = await fetch(url + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
};
const email = (a: string) => hubId('idn', 'email', a);
const personOf = (address: string) => store.one<{ person_id: string | null }>('SELECT person_id FROM identity WHERE id = ?', email(address))?.person_id ?? null;
/** The thread a message (by its Message-ID) is in. */
const threadOf = (hdr: string, account = ACC) => store.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE message_id_hdr = ? AND account_id = ?', hdr, account)!.thread_id;
const messageOf = (hdr: string, account = ACC) => store.one<{ id: string }>('SELECT id FROM mail_message WHERE message_id_hdr = ? AND account_id = ?', hdr, account)!.id;
/** Settle people, then what a flush says (mail.chats among it). */
const flush = () => {
  people.settle();
  const out = hub.flush();
  events.push(...out);
  return out;
};
/** Every page of a chat, `limit` at a time, oldest first. */
async function allPages(path: string, limit: number): Promise<{ ids: string[]; pages: P.MessagePage[] }> {
  const ids: string[] = [];
  const pages: P.MessagePage[] = [];
  let before: string | null = null;
  for (let i = 0; i < 200; i++) {
    const r: { status: number; json: P.MessagePage } = await call<P.MessagePage>('GET', `${path}?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    expect(r.status).toBe(200);
    pages.push(r.json);
    ids.unshift(...r.json.messages.map((m) => m.id));
    expect(r.json.messages.length).toBeLessThanOrEqual(limit);
    if (!r.json.hasMore) return { ids, pages };
    const oldest = r.json.messages[0];
    before = `${oldest.ts}:${oldest.id}`;
  }
  throw new Error('too many pages');
}

/**
 * Sam: a Signal contact, and by mail a dinner thread one-to-one (ten messages at the times of ten Signal messages),
 * a picnic thread that later gains Jo on Cc, and one mail to both of your accounts. Alice: an old one-to-one thread,
 * and recent group threads with Jo. Theo wrote and you answered (mail only). A newsletter.
 */
function seed(f: FakeMailBackend) {
  for (let i = 0; i < 10; i++) {
    const mine = i % 3 === 0;
    f.put(ACC, {
      mailboxId: mine ? 'Sent' : 'INBOX',
      messageId: `<din${i}@x>`,
      ...(i ? { inReplyTo: `<din${i - 1}@x>`, references: [`<din${i - 1}@x>`] } : {}),
      from: [mine ? ME : SAM],
      to: [mine ? SAM : ME],
      subject: i ? 'Re: Dinner' : 'Dinner',
      receivedAt: T0 + i * H,
      text: `dinner ${i}\n\nOn a day, someone wrote:\n> earlier words`,
    });
  }
  f.put(ACC, { mailboxId: 'Sent', messageId: '<pic1@x>', from: [ME], to: [SAM], subject: 'Picnic', receivedAt: T0 + 20 * H });
  f.put(ACC, { messageId: '<pic2@x>', inReplyTo: '<pic1@x>', references: ['<pic1@x>'], from: [SAM], to: [ME], subject: 'Re: Picnic', receivedAt: T0 + 21 * H });
  // One mail that reached both of your accounts.
  for (const a of [ACC, ACC2]) f.put(a, { messageId: '<both@x>', inReplyTo: '<din9@x>', references: ['<din9@x>'], from: [SAM], to: [ME, ME2], subject: 'Re: Dinner', receivedAt: T0 + 30 * H + (a === ACC2 ? 5000 : 0) });
  // Sam from work, answered: a person of its own until merged.
  f.put(ACC, { messageId: '<w1@x>', from: [SAM_WORK], to: [ME], subject: 'Work lunch', receivedAt: T0 + 40 * H });
  f.put(ACC, { mailboxId: 'Sent', messageId: '<w2@x>', inReplyTo: '<w1@x>', references: ['<w1@x>'], from: [ME], to: [SAM_WORK], subject: 'Re: Work lunch', receivedAt: T0 + 41 * H });
  // Alice: an old thread with you alone, then group threads with Jo, lately.
  f.put(ACC, { mailboxId: 'Sent', messageId: '<al1@x>', from: [ME], to: [ALICE], subject: 'Hello', receivedAt: T0 });
  f.put(ACC, { messageId: '<al2@x>', inReplyTo: '<al1@x>', references: ['<al1@x>'], from: [ALICE], to: [ME], subject: 'Re: Hello', receivedAt: T0 + H });
  for (let i = 0; i < 4; i++)
    f.put(ACC, { messageId: `<g${i}@x>`, from: [ALICE], to: [ME], cc: [JO], subject: `Lease ${i}`, receivedAt: NOW - (5 - i) * H, text: `Lease note ${i}\nline two\nline three\nline four` });
  // A group thread where you answered: her message there no longer awaits you, and yours is not listed.
  f.put(ACC, { messageId: '<ga@x>', from: [ALICE], to: [ME], cc: [JO], subject: 'Movers', receivedAt: NOW - 10 * H });
  f.put(ACC, { mailboxId: 'Sent', messageId: '<gb@x>', inReplyTo: '<ga@x>', references: ['<ga@x>'], from: [ME], to: [ALICE], cc: [JO], subject: 'Re: Movers', receivedAt: NOW - 9 * H });
  // Old group mail: not awaiting, a link.
  f.put(ACC, { messageId: '<old@x>', from: [ALICE], to: [ME], cc: [JO], subject: 'Old plans', receivedAt: NOW - 30 * DAY });
  // Theo writes with formatting (a bold word, a link with its own words) above a quote; the newsletter is a designed page.
  f.put(ACC, {
    messageId: '<t1@x>',
    from: [THEO],
    to: [ME],
    subject: 'Hello from Theo',
    receivedAt: T0 + 50 * H,
    text: 'Hello you, see the plan: https://plans.example/a\n\nOn Mon, Robin wrote:\n> old words',
    html: '<p>Hello <b>you</b>, see <a href="https://plans.example/a">the plan</a>.</p><div class="gmail_quote"><div class="gmail_attr">On Mon, Robin wrote:</div><blockquote class="gmail_quote">old words</blockquote></div>',
  });
  f.put(ACC, { mailboxId: 'Sent', messageId: '<t2@x>', inReplyTo: '<t1@x>', references: ['<t1@x>'], from: [ME], to: [THEO], subject: 'Re: Hello from Theo', receivedAt: T0 + 51 * H });
  f.put(ACC, { messageId: '<n1@x>', from: [NEWS], to: [ME], subject: 'Issue 600', receivedAt: T0 + 60 * H, text: 'Issue 600', html: '<table width="600"><tr><td><h1>Issue 600</h1></td></tr></table>', bulk: { listId: '<rust.example>', unsubscribe: null, precedence: 'list', autoSubmitted: null } });
}

beforeAll(async () => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  let signal: AccountRow = store.createAccount({ network: 'signal', label: 'phone', color: '#111', adapter: 'signal' });
  store.ingest(signal, { t: 'hello', network: 'signal', version: '1', capabilities: ['send'] as any });
  store.ingest(signal, { t: 'status', status: 'online', self: { nativeId: 'aci-me', isSelf: true, displayName: 'Robin' } });
  signal = store.account(signal.id)!;
  store.ingest(signal, { t: 'identity', identity: { nativeId: 'aci-sam', displayName: 'Sam Rivera', contact: true } });
  store.ingest(signal, { t: 'conversation', conversation: { nativeId: 'dm-sam', shape: 'direct', participants: ['aci-sam', 'aci-me'] } });
  // Ten Signal messages at the times of the ten dinner mails: paging must keep both of each pair.
  for (let i = 0; i < 10; i++) store.ingest(signal, { t: 'message', message: { nativeId: `s${i}`, conversation: 'dm-sam', author: i % 2 ? 'aci-me' : 'aci-sam', ts: T0 + i * H, body: `signal ${i}` } });
  store.flush();
  fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME.email, name: ME.name });
  fake.addAccount(ACC2, { email: ME2.email, name: ME2.name });
  seed(fake);
  hub = new MailHub({ db: store.db, backend: fake, log: () => {} });
  people = mailPeople(hub)!;
  places = mailPlaces(hub)!;
  people.connect(store);
  hub.start();
  await hub.sync(ACC)!.whenSynced();
  await hub.sync(ACC2)!.whenSynced();
  // Bodies here for the dinner and the group mail: the chat shows the words above the quote.
  for (let i = 0; i < 10; i++) await hub.body(messageOf(`<din${i}@x>`));
  for (let i = 0; i < 4; i++) await hub.body(messageOf(`<g${i}@x>`));
  flush();
  // Sam on Signal and Sam by mail are one person; so is Sam from work.
  store.mergePersons(store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', hubId('idn', 'signal', 'aci-sam'))!.person_id, personOf(SAM.email)!);
  flush();
  const sup = { authorize: () => null, online: () => true, command: async () => ({ nativeId: 'n' }) } as any;
  server = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, open: true, secret: 's', mail: hub });
  url = `http://127.0.0.1:${server.start().port}`;
});

afterAll(() => {
  server?.stop?.();
  people?.stop();
  hub?.stop();
  store?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sam = () => personOf(SAM.email)!;

describe('where a thread is shown', () => {
  test('one-to-one with a person: their chat; with more people, unknown, bulk or yourself: its own', () => {
    expect(places.placeOf(threadOf('<din0@x>'))).toBe(`person:${sam()}`);
    expect(places.placeOf(threadOf('<g0@x>'))).toBe(threadOf('<g0@x>'));
    expect(places.placeOf(threadOf('<n1@x>'))).toBe(threadOf('<n1@x>'));
    // Theo, answered: a person now, so his thread is his chat.
    expect(places.placeOf(threadOf('<t1@x>'))).toBe(`person:${personOf(THEO.email)}`);
  });

  test('a sender with no person is the thread', () => {
    // Delivered: stored at once (mail.arrived), so it is here when deliver returns.
    fake.deliver(ACC, { mailboxId: 'INBOX', messageId: '<st1@x>', from: [{ name: 'Stranger', email: 'stranger@example.net' }], to: [ME], subject: 'Hi there', receivedAt: T0 + 70 * H });
    flush();
    expect(personOf('stranger@example.net')).toBeNull();
    expect(places.placeOf(threadOf('<st1@x>'))).toBe(threadOf('<st1@x>'));
  });

  test('two addresses of one person: both their chat, a route each', () => {
    const work = personOf(SAM_WORK.email)!;
    expect(places.placeOf(threadOf('<w1@x>'))).toBe(`person:${work}`);
    store.mergePersons(sam(), work);
    const ev = flush().filter((e) => e.t === 'mail.chats') as Extract<P.ClientEvent, { t: 'mail.chats' }>[];
    expect(places.placeOf(threadOf('<w1@x>'))).toBe(`person:${sam()}`);
    const routes = places.chatsOf(sam());
    expect(routes.map((r) => r.id).sort()).toEqual([`email:${ACC}:${SAM.email}`, `email:${ACC}:${SAM_WORK.email}`, `email:${ACC2}:${SAM.email}`].sort());
    // The merge was told: the route is the merged person's now.
    expect(ev.some((e) => e.chats.some((c) => c.id === `email:${ACC}:${SAM_WORK.email}` && c.personId === sam()))).toBe(true);
  });

  test('a one-to-one thread that gains a Cc becomes a chat of its own, and mail.chats says so', () => {
    const pic = threadOf('<pic1@x>');
    expect(places.personThreads(sam())).toContain(pic);
    fake.deliver(ACC, { mailboxId: 'INBOX', messageId: '<pic3@x>', inReplyTo: '<pic2@x>', references: ['<pic1@x>', '<pic2@x>'], from: [SAM], to: [ME], cc: [JO], subject: 'Re: Picnic', receivedAt: T0 + 22 * H });
    const ev = flush().find((e) => e.t === 'mail.chats') as Extract<P.ClientEvent, { t: 'mail.chats' }> | undefined;
    expect(places.placeOf(pic)).toBe(pic);
    expect(places.personThreads(sam())).not.toContain(pic);
    const route = ev?.chats.find((c) => c.id === `email:${ACC}:${SAM.email}`);
    expect(route).toBeDefined();
    expect(route!.threadIds).not.toContain(pic);
  });
});

describe('a person’s chat', () => {
  test('chat and mail by one cursor: nothing skipped or doubled across pages, equal times and all', async () => {
    const path = `/api/chats/${encodeURIComponent(`person:${sam()}`)}/messages`;
    const whole = await call<P.MessagePage>('GET', `${path}?limit=200`);
    const expected = whole.json.messages.map((m) => m.id);
    // Ten Signal, ten dinner mails, the work lunch thread and one copy of the mail to both accounts.
    expect(whole.json.messages.filter((m) => m.network === 'signal')).toHaveLength(10);
    expect(whole.json.messages.filter((m) => m.network === 'email').length).toBeGreaterThanOrEqual(13);
    for (const limit of [1, 2, 3, 7]) {
      const { ids } = await allPages(path, limit);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // Oldest first, by (ts, id).
    const ms = whole.json.messages;
    for (let i = 1; i < ms.length; i++) expect(ms[i - 1].ts < ms[i].ts || (ms[i - 1].ts === ms[i].ts && ms[i - 1].id < ms[i].id)).toBe(true);
  });

  test('a mail as a chat message: route, author, words above the quote, the subject on the first', async () => {
    const r = await call<P.MessagePage>('GET', `/api/chats/${encodeURIComponent(`person:${sam()}`)}/messages?limit=200`);
    const d0 = r.json.messages.find((m) => m.id === messageOf('<din0@x>'))!;
    const d1 = r.json.messages.find((m) => m.id === messageOf('<din1@x>'))!;
    expect(d0.conversationId).toBe(`email:${ACC}:${SAM.email}`);
    expect(d0.body).toBe('dinner 0');
    expect(d0.mail).toMatchObject({ threadId: threadOf('<din0@x>'), place: `person:${sam()}`, opens: true, quoted: true, bodyState: 'cached', rich: false, messageId: '<din0@x>' });
    expect(d1.mail!.opens).toBe(false);
    // What it answers, for the chat to leave out ··· when that is the message drawn above it.
    expect(d0.mail!.inReplyTo).toBeNull();
    expect(d1.mail!.inReplyTo).toBe('<din0@x>');
    expect(d1.authorId).toBe(email(SAM.email));
    // Yours is yours: your address is an identity of the self person.
    const self = store.one<{ id: string }>('SELECT id FROM person WHERE is_self = 1')!.id;
    expect(d0.authorId).toBe(email(ME.email));
    expect(r.json.identities.find((i) => i.id === d0.authorId)?.personId).toBe(self);
    // Every author and address is in the page.
    const have = new Set(r.json.identities.map((i) => i.id));
    for (const m of r.json.messages.filter((m) => m.mail)) for (const a of [m.mail!.from, ...m.mail!.to, ...m.mail!.cc]) expect(have.has(a.identityId!)).toBe(true);
  });

  test("a formatted mail's words carry their tree (blocks) to the quote; the body stays its text; a designed one has none", async () => {
    // The body is here once asked for (a chat draws a mail's words from the body it holds); its view has the tree too.
    const b = await call<P.MailBodyView>('GET', `/api/mail/messages/${messageOf('<t1@x>')}/body`);
    await call('GET', `/api/mail/messages/${messageOf('<n1@x>')}/body`);
    const theo = personOf(THEO.email)!;
    const r = await call<P.MessagePage>('GET', `/api/chats/${encodeURIComponent(`person:${theo}`)}/messages?limit=200`);
    const t1 = r.json.messages.find((m) => m.id === messageOf('<t1@x>'))!;
    expect(t1.mail!.bodyState).toBe('cached');
    expect(t1.body).toBe('Hello you, see the plan: https://plans.example/a');
    expect(t1.mail!.blocks).toEqual([{ t: 'p', c: ['Hello ', { t: 'b', c: ['you'] }, ', see ', { t: 'a', href: 'https://plans.example/a', c: ['the plan'] }, '.'] }]);
    expect(t1.mail).toMatchObject({ quoted: true, rich: true });
    // Your plain answer has no tree: its text says it all.
    const t2 = r.json.messages.find((m) => m.id === messageOf('<t2@x>'))!;
    expect(t2.mail!.blocks).toBeUndefined();
    // The newsletter is a layout table: no tree, and rich, so the chat shows it as sent.
    const n = await call<P.MessagePage>('GET', `/api/mail/chats/${threadOf('<n1@x>')}/messages?limit=10`);
    expect(n.json.messages[0].mail).toMatchObject({ rich: true });
    expect(n.json.messages[0].mail!.blocks).toBeUndefined();
    expect(b.json.blocks).toEqual(t1.mail!.blocks);
  });

  test('one mail to two of your accounts: shown once, both accounts in seenVia', async () => {
    const r = await call<P.MessagePage>('GET', `/api/chats/${encodeURIComponent(`person:${sam()}`)}/messages?limit=200`);
    const both = r.json.messages.filter((m) => m.mail?.messageId === '<both@x>');
    expect(both).toHaveLength(1);
    expect(both[0].id).toBe(messageOf('<both@x>', ACC));
    expect(both[0].seenVia.sort()).toEqual([ACC, ACC2].sort());
  });

  test('routes include email; sending through a chat route never takes one', async () => {
    const theo = personOf(THEO.email)!;
    const v = await call<P.ChatView>('GET', `/api/chats/${encodeURIComponent(`person:${theo}`)}`);
    expect(v.status).toBe(200);
    expect(v.json.routes).toEqual([expect.objectContaining({ conversationId: `email:${ACC}:${THEO.email}`, accountId: ACC, network: 'email', theirIdentityId: email(THEO.email), myIdentityId: null })]);
    expect(v.json.route).toMatchObject({ conversationId: `email:${ACC}:${THEO.email}` });
    // Mail only: the chat pages, and a chat send has nowhere to go.
    const page = await call<P.MessagePage>('GET', `/api/chats/${encodeURIComponent(`person:${theo}`)}/messages`);
    expect(page.json.messages.map((m) => m.mail?.messageId)).toEqual(['<t1@x>', '<t2@x>']);
    const send = await call('POST', `/api/chats/${encodeURIComponent(`person:${theo}`)}/messages`, { body: 'hi' });
    expect(send.status).toBe(409);
    const asked = await call('POST', `/api/chats/${encodeURIComponent(`person:${sam()}`)}/messages`, { body: 'hi', route: { conversationId: `email:${ACC}:${SAM.email}`, accountId: ACC } });
    expect(asked.status).toBe(409);
    // Sam's routes: Signal and email together, the latest first.
    const s = await call<P.ChatView>('GET', `/api/chats/${encodeURIComponent(`person:${sam()}`)}`);
    expect(s.json.routes.map((r) => r.network)).toContain('signal');
    expect(s.json.routes.filter((r) => r.network === 'email')).toHaveLength(3);
  });
});

describe('what they wrote elsewhere', () => {
  const alice = () => personOf(ALICE.email)!;
  const page = async () => (await call<P.MessagePage>('GET', `/api/chats/${encodeURIComponent(`person:${alice()}`)}/messages`)).json;

  test('each with its excerpt and whether it awaits you: answered, old and your own do not', async () => {
    const p = await page();
    expect(p.messages.map((m) => m.mail?.messageId)).toEqual(['<al1@x>', '<al2@x>']);
    const els = p.elsewhere!;
    // Newest last; four lease mails, Movers (hers only), Old plans.
    expect(els.map((e) => e.title)).toEqual(['Old plans', 'Re: Movers', 'Lease 0', 'Lease 1', 'Lease 2', 'Lease 3']);
    const by = new Map(els.map((e) => [e.title, e]));
    expect(by.get('Lease 3')).toMatchObject({ awaits: true, excerpt: 'Lease note 3\nline two\nline three', unread: true, placeKind: 'mail-thread', others: ['Jo Park'] });
    for (const t of ['Lease 0', 'Lease 1', 'Lease 2']) expect(by.get(t)).toMatchObject({ awaits: true, excerpt: expect.stringContaining('line three') });
    expect(by.get('Re: Movers')).toMatchObject({ awaits: false });
    expect(by.get('Old plans')).toMatchObject({ awaits: false });
    // Your own reply in Movers is not listed.
    expect(els.some((e) => e.messageId === messageOf('<gb@x>'))).toBe(false);
  });

  test('an excerpt leaves out a signature and a last line that is only the sender\'s name', () => {
    expect(excerptOf('Hi both,\n\nCould you sign page 3?\n\nAlice', 'Alice Chen')).toBe('Hi both,\nCould you sign page 3?');
    expect(excerptOf('Booked for 7:30.\n\n-- \nSam Rivera\nsam.example', 'Sam Rivera')).toBe('Booked for 7:30.');
    expect(excerptOf('Thanks!\nAlice Chen.', 'Alice Chen')).toBe('Thanks!');
    // Only the name, and only last: a message that is just her name stays.
    expect(excerptOf('Alice', 'Alice Chen')).toBe('Alice');
    expect(excerptOf('Alice will bring the keys.\nSee you', 'Alice Chen')).toBe('Alice will bring the keys.\nSee you');
  });

  test('how a thread shows in their chat is chosen per thread, sent with the bootstrap, and null takes it back', async () => {
    const lease3 = threadOf('<g3@x>');
    const lease0 = threadOf('<g0@x>');
    const view = `person:${alice()}`;
    expect((await call('PUT', '/api/rungs', { view, place: lease3, rung: 'sideways' })).status).toBe(400);
    expect((await call('PUT', '/api/rungs', { view, place: lease3, rung: 'excerpt' })).status).toBe(400);
    expect((await call('PUT', '/api/rungs', { view, place: lease3, rung: 'hidden' })).status).toBe(200);
    expect((await call('PUT', '/api/rungs', { view, place: lease0, rung: 'closed' })).status).toBe(200);
    // A hidden thread is still sent: the chat counts it ("1 hidden thread · Show").
    const els = (await page()).elsewhere!;
    expect(els.find((e) => e.place === lease3)).toMatchObject({ awaits: true });
    const chosen = hub.bootstrap().rungs!.filter((r) => r.view === view);
    expect(chosen).toEqual(expect.arrayContaining([expect.objectContaining({ place: lease3, rung: 'hidden' }), expect.objectContaining({ place: lease0, rung: 'closed' })]));
    for (const place of [lease3, lease0]) expect((await call('PUT', '/api/rungs', { view, place, rung: null })).status).toBe(200);
    expect(hub.bootstrap().rungs!.filter((r) => r.view === view)).toEqual([]);
  });
});

describe('mail chats of their own and the routes list', () => {
  test('a thread with others as a chat, and a route by email', async () => {
    const lease = threadOf('<g2@x>');
    const t = await call<P.MessagePage>('GET', `/api/mail/chats/${lease}/messages`);
    expect(t.status).toBe(200);
    expect(t.json.messages).toHaveLength(1);
    expect(t.json.messages[0]).toMatchObject({ conversationId: lease, network: 'email', mail: { place: lease, opens: true } });
    const news = await call<P.MessagePage>('GET', `/api/mail/chats/${threadOf('<n1@x>')}/messages`);
    expect(news.json.messages).toHaveLength(1);
    const route = `email:${ACC}:${SAM.email}`;
    const { ids } = await allPages(`/api/mail/chats/${encodeURIComponent(route)}/messages`, 4);
    expect(ids).toContain(messageOf('<din0@x>'));
    expect(ids).not.toContain(messageOf('<w1@x>'));
    expect((await call('GET', `/api/mail/chats/${encodeURIComponent(`email:${ACC}:nobody@example.net`)}/messages`)).status).toBe(404);
    const list = await call<P.MailChatView[]>('GET', `/api/mail/chats?person=${sam()}`);
    expect(list.json.map((c) => c.id)).toContain(route);
    const r = list.json.find((c) => c.id === route)!;
    expect(r).toMatchObject({ personId: sam(), identityId: email(SAM.email), accountId: ACC, address: SAM.email });
    expect(r.threadIds[0]).toBe(threadOf('<din0@x>'));
    expect(hub.bootstrap().chats!.map((c) => c.id)).toEqual(expect.arrayContaining([route, `email:${ACC}:${THEO.email}`, `email:${ACC}:${ALICE.email}`]));
  });

  test('answering one person in a thread with others: the send goes to them alone, and the thread marks it "only"', async () => {
    const plans = threadOf('<old@x>');
    const start = await call<P.MailComposeStart>('GET', `/api/mail/compose?kind=replyAll&message=${messageOf('<old@x>')}&tz=UTC`);
    expect(start.status).toBe(200);
    expect([...start.json.draft.to, ...start.json.draft.cc].map((a) => a.email).sort()).toEqual([ALICE.email, JO.email].sort());
    // What the box's "Only Alice" sends: the reply all, narrowed to her (mail/chatsend.ts).
    const sent = await call<{ outboxId: string }>('POST', '/api/mail/send', { ...start.json.draft, to: [ALICE], cc: [], bcc: [], text: 'Just you', clientId: 'only-alice', draftKey: start.json.draftKey });
    expect(sent.status).toBe(200);
    const stored = new Promise<string>((done) => {
      const off = hub.on('sent', (e) => {
        if (e.outboxId !== sent.json.outboxId) return;
        off();
        done(e.messageId!);
      });
    });
    expect((await call('POST', `/api/mail/outbox/${sent.json.outboxId}/send`, {})).status).toBe(200);
    const hdr = await stored;
    const went = fake.sent.find((x) => x.messageId === hdr)!;
    expect(went.mail.to.map((a) => a.email)).toEqual([ALICE.email]);
    expect(went.mail.cc ?? []).toEqual([]);
    // Its copy in Sent, once synced, is in the thread's chat with who it went to.
    await new Promise<void>((done) => {
      const here = () => !!store.one('SELECT id FROM mail_message WHERE message_id_hdr = ? AND account_id = ?', hdr, ACC);
      if (here()) return done();
      const off = hub.on('ingested', () => here() && (off(), done()));
    });
    flush();
    const t = await call<P.MessagePage>('GET', `/api/mail/chats/${plans}/messages`);
    const mine = t.json.messages.find((m) => m.mail?.messageId === hdr)!;
    expect(mine.mail!.only!.map((a) => a.email)).toEqual([ALICE.email]);
    // Mail to everyone on it, and theirs, are not marked.
    expect(t.json.messages.filter((m) => m.id !== mine.id).every((m) => !m.mail!.only)).toBe(true);
    const movers = await call<P.MessagePage>('GET', `/api/mail/chats/${threadOf('<gb@x>')}/messages`);
    expect(movers.json.messages.find((m) => m.id === messageOf('<gb@x>'))!.mail!.only).toBeUndefined();
  });

  test('marking messages read marks only those', async () => {
    const ids = [messageOf('<g0@x>'), messageOf('<g1@x>')];
    const r = await call('POST', '/api/mail/flag', { messageIds: [ids[0]], seen: true });
    expect(r.status).toBe(200);
    const seen = (id: string) => store.one<{ seen: number }>('SELECT seen FROM mail_message WHERE id = ?', id)!.seen;
    expect(seen(ids[0])).toBe(1);
    expect(seen(ids[1])).toBe(0);
  });
});

describe('an email route as the chosen route', () => {
  const chat = () => `/api/chats/${encodeURIComponent(`person:${sam()}`)}`;
  const route = { conversationId: `email:${ACC}:${SAM.email}`, accountId: ACC };

  test('PATCH keeps it as the chat route, and the next GET starts there', async () => {
    const r = await call<P.ChatView>('PATCH', chat(), { route });
    expect(r.status).toBe(200);
    expect(r.json.route).toMatchObject({ ...route, why: 'chosen' });
    const again = await call<P.ChatView>('GET', chat());
    expect(again.json.route).toMatchObject({ ...route, why: 'chosen' });
  });

  test('an email route of someone else, or through the wrong account, is not this chat’s', async () => {
    const theo = await call('PATCH', chat(), { route: { conversationId: `email:${ACC}:${THEO.email}`, accountId: ACC } });
    expect(theo.status).toBe(409);
    const wrong = await call('PATCH', chat(), { route: { conversationId: route.conversationId, accountId: ACC2 } });
    expect(wrong.status).toBe(409);
  });

  test('a chat send with no route still goes through a chat route, never mail', async () => {
    const asked = await call('POST', `${chat()}/messages`, { body: 'hi', route });
    expect(asked.status).toBe(409);
  });

  test('a message on another route since gives the choice way, as a chat route’s does', async () => {
    await call('PATCH', chat(), { route });
    const sig = store.account(store.one<{ id: string }>("SELECT id FROM account WHERE network = 'signal'")!.id)!;
    store.ingest(sig, { t: 'message', message: { nativeId: 's-after-choice', conversation: 'dm-sam', author: 'aci-sam', ts: Date.now() + 60_000, body: 'later on Signal' } });
    store.flush();
    const v = await call<P.ChatView>('GET', chat());
    // The Signal DM's, where the latest message came.
    expect(v.json.route).toMatchObject({ conversationId: store.one<{ id: string }>("SELECT id FROM conversation WHERE native_id = 'dm-sam'")!.id, accountId: sig.id, why: 'latest' });
  });
});
