/**
 * People in mail (mail/people.ts, docs/mail-design.md §9) against FakeMailBackend and a real chat store: who gets an
 * identity and who a person, the names they get, that nothing joins by name alone, that a merge carries the mail (the
 * profile's Mail card, the `w:` list, the thread views), the merge search, and what goes when an account's mail does.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withList } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { FakeMailBackend } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailPeople, type MailPeople } from '../src/mail/people.ts';
import { Store } from '../src/store.ts';

const ACC = 'acc_peopleTest1';
const ME = { name: 'Me', email: 'me@example.com' };
const SAM = { name: 'Sam Rivera', email: 'sam@rivera.example' };
const ALICE = { name: 'Alice Chen', email: 'alice@example.org' };
const JO = { name: 'Jo Park', email: 'jo@park.example' };
const LEE = { name: 'Lee', email: 'lee@example.net' };
const THEO = { name: 'Theo', email: 'theo@example.net' };
const NEWS = { name: 'Rust Weekly', email: 'newsletter@rust.example' };
const DEE = { name: 'Dee', email: 'dee@example.net' };
const T0 = Date.UTC(2026, 10, 1, 12);
const H = 3_600_000;

const until = async (f: () => unknown, ms = 4000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** A chat store with a Signal contact "Sam Rivera", and a mail account with the seeded mail, synced. */
async function world(seed: (f: FakeMailBackend) => void, o: { connect?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dither-mail-people-'));
  const chat = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  const signal = chat.createAccount({ network: 'signal', label: 's', color: '#111', adapter: 'signal' });
  chat.ingest(signal, { t: 'identity', identity: { nativeId: '+15550100', displayName: 'Sam Rivera', contact: true } });
  chat.ingest(signal, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['+15550100'] } });
  chat.ingest(signal, { t: 'message', message: { nativeId: 'm1', conversation: 'dm', author: '+15550100', ts: T0, body: 'hi' } });
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME.email, name: ME.name });
  seed(fake);
  const hub = new MailHub({ db: chat.db, backend: fake, log: () => {} });
  const people = mailPeople(hub)!;
  if (o.connect !== false) people.connect(chat);
  hub.start();
  await hub.sync(ACC)!.whenSynced();
  people.settle();
  cleanup = () => {
    people.stop();
    hub.stop();
    chat.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { chat, fake, hub, people, signal, signalSam: hubId('idn', 'signal', '+15550100') };
}

const email = (a: string) => hubId('idn', 'email', a);
const identity = (chat: Store, address: string) => chat.one<{ id: string; display_name: string | null; handle: string; person_id: string | null }>('SELECT * FROM identity WHERE id = ?', email(address));
const personOf = (chat: Store, id: string) => chat.one<{ person_id: string | null }>('SELECT person_id FROM identity WHERE id = ?', id)?.person_id ?? null;

/** Sam: you wrote first. Alice wrote, you answered and Cc'd Jo. Kim wrote with Lee in Cc; you answered Kim only. */
function seedMail(f: FakeMailBackend) {
  f.put(ACC, { mailboxId: 'Sent', messageId: '<s1@x>', from: [ME], to: [SAM], subject: 'Dinner?', receivedAt: T0 });
  f.put(ACC, { messageId: '<s2@x>', inReplyTo: '<s1@x>', references: ['<s1@x>'], from: [{ name: 'Sam', email: SAM.email }], to: [ME], subject: 'Re: Dinner?', receivedAt: T0 + H });
  f.put(ACC, { messageId: '<s3@x>', inReplyTo: '<s2@x>', references: ['<s1@x>', '<s2@x>'], from: [{ name: 'Sam Rivera', email: 'Sam@Rivera.example' }], to: [ME], subject: 'Re: Dinner?', receivedAt: T0 + 2 * H });
  f.put(ACC, { messageId: '<a1@x>', from: [ALICE], to: [ME], subject: 'Lease renewal', receivedAt: T0 + 3 * H });
  f.put(ACC, { mailboxId: 'Sent', messageId: '<a2@x>', inReplyTo: '<a1@x>', references: ['<a1@x>'], from: [ME], to: [ALICE], cc: [JO], subject: 'Re: Lease renewal', receivedAt: T0 + 4 * H });
  f.put(ACC, { messageId: '<k1@x>', from: [{ name: 'Kim', email: 'kim@example.net' }], to: [ME], cc: [LEE], subject: 'Climbing', receivedAt: T0 + 5 * H });
  f.put(ACC, { mailboxId: 'Sent', messageId: '<k2@x>', inReplyTo: '<k1@x>', references: ['<k1@x>'], from: [ME], to: [{ name: null, email: 'kim@example.net' }], subject: 'Re: Climbing', receivedAt: T0 + 6 * H });
  f.put(ACC, { messageId: '<t1@x>', from: [THEO], to: [ME], subject: 'Hello from Theo', receivedAt: T0 + 7 * H });
  f.put(ACC, { messageId: '<n1@x>', from: [NEWS], to: [ME], subject: 'Issue 600', receivedAt: T0 + 8 * H, bulk: { listId: '<rust.example>', unsubscribe: null, precedence: 'list', autoSubmitted: null } });
  // A draft to Dee is not mail you sent.
  f.put(ACC, { messageId: '<d1@x>', from: [ME], to: [DEE], subject: 'Unsent', receivedAt: T0 + 9 * H, flags: { draft: true } });
}

describe('who gets a person', () => {
  test('whom you wrote to, and who wrote in a thread you wrote in; nobody else', async () => {
    const { chat } = await world(seedMail);
    for (const a of [SAM, ALICE, JO, { email: 'kim@example.net' }]) {
      const i = identity(chat, a.email);
      expect(i, a.email).not.toBeNull();
      expect(i!.person_id, a.email).toBe(`per_${email(a.email).slice(4)}`);
    }
    // Lee was only Cc'd by Kim; a newsletter; a draft; you.
    for (const a of [LEE, NEWS, DEE, ME]) expect(identity(chat, a.email), a.email).toBeNull();
    // Theo wrote and you never answered: his mail looks personal (slice 8), so an identity, but no person.
    expect(identity(chat, THEO.email)).toMatchObject({ person_id: null });
    // A person shows as anyone's does, named from mail.
    const sam = chat.personView(chat.one('SELECT * FROM person WHERE id = ?', personOf(chat, email(SAM.email)))!);
    expect(sam.name).toBe('Sam Rivera');
    expect(sam.identityIds).toEqual([email(SAM.email)]);
  });

  test('the name is the one on their latest From, else the one you wrote to them under', async () => {
    const { chat } = await world(seedMail);
    // Sam signed "Sam", then "Sam Rivera" (from an address in other case: one identity).
    expect(identity(chat, SAM.email)!.display_name).toBe('Sam Rivera');
    expect(identity(chat, SAM.email)!.handle).toBe(SAM.email);
    // Jo never wrote: the name you used.
    expect(identity(chat, JO.email)!.display_name).toBe('Jo Park');
    // Kim's From named her; your reply did not.
    expect(identity(chat, 'kim@example.net')!.display_name).toBe('Kim');
  });

  test('replying later makes a person of who wrote first', async () => {
    const { chat, fake, people } = await world(seedMail);
    expect(identity(chat, THEO.email)?.person_id).toBeNull();
    expect(people.sender(THEO.email).known).toBe(false);
    fake.deliver(ACC, { mailboxId: 'INBOX', messageId: '<t2@x>', inReplyTo: '<t1@x>', references: ['<t1@x>'], from: [ME], to: [THEO], subject: 'Re: Hello from Theo', receivedAt: T0 + 10 * H });
    await until(() => identity(chat, THEO.email)?.person_id, 3000, 'Theo’s person');
    expect(people.sender(THEO.email)).toMatchObject({ known: true, wroteTo: 1, wroteYou: 1, tookPart: true, chat: false });
  });

  test('a sender classed personal (slice 8) gets an identity, not a person', async () => {
    const { chat, hub, people } = await world(seedMail);
    hub.store.db.query(`UPDATE mail_message SET class = 'personal' WHERE from_addr = ?`).run(THEO.email);
    people.settle(hub.store.all<{ id: string }>('SELECT id FROM mail_thread').map((t) => t.id));
    expect(identity(chat, THEO.email)).toMatchObject({ display_name: 'Theo', person_id: null });
    expect(people.sender(THEO.email).known).toBe(false);
    expect(identity(chat, NEWS.email)).toBeNull();
  });

  test('mail from before (no rows yet) is worked through when the chat store connects', async () => {
    const { chat, hub, people } = await world(seedMail, { connect: false });
    expect(identity(chat, SAM.email)).toBeNull();
    hub.store.db.exec('DELETE FROM mail_party');
    people.connect(chat);
    await until(() => identity(chat, ALICE.email)?.person_id && identity(chat, SAM.email)?.person_id, 3000, 'the persons');
    expect(identity(chat, THEO.email)?.person_id ?? null).toBeNull();
  });

  test('removing a chat account leaves people known by their mail', async () => {
    const { chat, signal } = await world(seedMail);
    chat.deleteAccount(signal.id);
    expect(identity(chat, ALICE.email)!.person_id).not.toBeNull();
    expect(chat.one('SELECT 1 FROM person WHERE id = ?', identity(chat, ALICE.email)!.person_id)).not.toBeNull();
  });
});

describe('no merge by name alone', () => {
  test('Sam by mail and Sam on Signal stay two people until you merge them', async () => {
    const { chat, signalSam } = await world(seedMail);
    const bySignal = personOf(chat, signalSam)!;
    const byMail = personOf(chat, email(SAM.email))!;
    expect(bySignal).not.toBe(byMail);
    expect(chat.one<{ n: number }>('SELECT COUNT(*) AS n FROM identity WHERE person_id = ?', bySignal)!.n).toBe(1);
    // The Signal person's profile has no mail; the mail one's has its thread.
    expect(chat.profile({ personId: bySignal })!.identityIds).toEqual([signalSam]);
  });

  test('the merge search finds email people by address and email identities no person holds', async () => {
    const { chat, hub, people, signalSam } = await world(seedMail);
    const bySignal = personOf(chat, signalSam)!;
    const byAddress = chat.mergeCandidates('sam@rivera', bySignal);
    expect(byAddress.persons.map((p) => p.id)).toEqual([personOf(chat, email(SAM.email))!]);
    expect(byAddress.identities.map((i) => i.network)).toEqual(['email']);
    const byName = chat.mergeCandidates('Sam Rivera', null);
    expect(byName.persons.map((p) => p.id).sort()).toEqual([bySignal, personOf(chat, email(SAM.email))!].sort());
    // Theo, once classed personal: an identity without a person, found too.
    hub.store.db.query(`UPDATE mail_message SET class = 'personal' WHERE from_addr = ?`).run(THEO.email);
    people.settle(hub.store.all<{ id: string }>('SELECT id FROM mail_thread').map((t) => t.id));
    const theo = chat.mergeCandidates('theo', null);
    expect(theo.persons).toEqual([]);
    expect(theo.identities.map((i) => i.id)).toEqual([email(THEO.email)]);
    expect(chat.mergeCandidates('', null)).toEqual({ persons: [], identities: [] });
  });
});

describe('a merge carries the mail', () => {
  const samThreads = (people: MailPeople, ids: string[]) => people.profile(ids);

  test('the merged person has the mail: profile card, its list, and the thread views', async () => {
    const { chat, hub, people, signalSam } = await world(seedMail);
    const bySignal = personOf(chat, signalSam)!;
    const byMail = personOf(chat, email(SAM.email))!;
    expect(samThreads(people, [signalSam])).toBeUndefined();
    const before = samThreads(people, [email(SAM.email)])!;
    expect(before.total).toBe(1);
    expect(before.threads[0].subject).toBe('Re: Dinner?');
    expect(before.threads[0].personIds).toEqual([byMail]);

    hub.flush();
    chat.mergePersons(bySignal, byMail);
    // The page's copy of the thread hears of it.
    const sent = hub.flush().flatMap((e) => (e.t === 'mail.threads' ? e.threads : []));
    expect(sent.map((t) => [t.subject, t.personIds])).toEqual([['Re: Dinner?', [bySignal]]]);
    const ids = chat.profile({ personId: bySignal })!.identityIds.sort();
    expect(ids).toEqual([email(SAM.email), signalSam].sort());
    const card = people.profile(ids)!;
    expect(card.total).toBe(1);
    expect(card.threads[0].personIds).toEqual([bySignal]);
    expect(card.threads[0].from.find((f) => f.email === SAM.email)).toMatchObject({ identityId: email(SAM.email), personId: bySignal });
    // "All mail with Sam" lists it by person, whatever address it came from.
    const page = hub.store.listThreads(withList(bySignal), null, 50)!;
    expect(page.threads.map((t) => t.id)).toEqual([card.threads[0].id]);
    expect(hub.store.listThreads(withList(SAM.email), null, 50)!.threads.length).toBe(1);
    // The messages name the person behind each address.
    const msgs = hub.store.messageViews(card.threads[0].id);
    expect(msgs.find((m) => m.addressed === 'self')!.to[0]).toMatchObject({ email: SAM.email, personId: bySignal });
    // Mail from an address of a person who has a chat identity counts as known (§4's rule 5).
    expect(people.sender(SAM.email)).toMatchObject({ known: true, chat: true, personId: bySignal });

    // Split again: the mail goes with the email identity.
    const back = chat.splitIdentity(email(SAM.email))!;
    expect(people.profile([signalSam])).toBeUndefined();
    expect(people.profile([email(SAM.email)])!.threads[0].personIds).toEqual([back]);
    expect(hub.store.listThreads(withList(bySignal), null, 50)!.threads).toEqual([]);
  });

  test('a new message from a merged address joins the merged person', async () => {
    const { chat, fake, people, signalSam } = await world(seedMail);
    const bySignal = personOf(chat, signalSam)!;
    chat.mergePersons(bySignal, personOf(chat, email(SAM.email))!);
    fake.deliver(ACC, { messageId: '<s4@x>', from: [SAM], to: [ME], subject: 'Photos', receivedAt: T0 + 20 * H });
    await until(() => (people.profile([signalSam, email(SAM.email)])?.total ?? 0) === 2, 3000, 'the new thread');
    expect(personOf(chat, email(SAM.email))).toBe(bySignal);
    expect(people.profile([signalSam, email(SAM.email)])!.threads[0].subject).toBe('Photos');
  });
});

describe('when an account’s mail goes', () => {
  test('its people go with it, unless you merged them', async () => {
    const { chat, fake, hub, signalSam } = await world(seedMail);
    const bySignal = personOf(chat, signalSam)!;
    chat.mergePersons(bySignal, personOf(chat, email(SAM.email))!);
    const alicePerson = identity(chat, ALICE.email)!.person_id!;
    fake.removeAccount(ACC);
    await until(() => hub.store.account(ACC)?.gone_at, 2000, 'access ending');
    expect(hub.deleteNow(ACC)).toBe('deleted');
    expect(identity(chat, ALICE.email)).toBeNull();
    expect(chat.one('SELECT 1 FROM person WHERE id = ?', alicePerson)).toBeNull();
    expect(chat.dirty.removed).toContainEqual({ t: 'person.removed', id: alicePerson });
    // Sam's email identity stays in the person you made.
    expect(personOf(chat, email(SAM.email))).toBe(bySignal);
    expect(hub.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_party')!.n).toBe(0);
  });
});
