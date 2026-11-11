/**
 * Mail in the one-list inbox (mail/attention.ts, docs/mail-design.md §10) on FakeMailBackend with a real chat store
 * and Attention: what you owe and what is unread, the listing window, archive taking a thread out (from here and from
 * another mail app), mail not from a person never listed, how you answer someone counted over all their threads, and
 * the views going out with the chats' in `attention` events.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId, mailId } from '@dither-chat/protocol/ids';
import { Attention } from '../src/attention.ts';
import { mailAttention, MAIL_INBOX } from '../src/mail/attention.ts';
import { mailClassifier } from '../src/mail/classify.ts';
import { FakeMailBackend, type FakeInput } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailOps } from '../src/mail/ops.ts';
import { mailPeople } from '../src/mail/people.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const ACC = 'acc_attentionMail';
const ME = { name: 'Me', email: 'me@example.com' };
const SAM = { name: 'Sam Rivera', email: 'sam@rivera.example' };
const ALICE = { name: 'Alice Chen', email: 'alice@example.org' };
const JO = { name: 'Jo Park', email: 'jo@park.example' };
const THEO = { name: 'Theo', email: 'theo@example.net' };
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 10, 1, 12);

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

/** Sam, Alice and Jo are people you have written to, long ago; Theo is not. */
async function world(seed: (put: (i: FakeInput) => void) => void, at = T0 + 10 * DAY) {
  const clock = { now: at };
  const dir = mkdtempSync(join(tmpdir(), 'dither-mail-attention-'));
  const chat = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME.email, name: ME.name });
  fake.put(ACC, { mailboxId: 'Sent', messageId: '<hello@x>', from: [ME], to: [SAM, ALICE, JO], subject: 'Hello all', receivedAt: T0 - 60 * DAY, flags: { seen: true } });
  seed((i) => void fake.put(ACC, { flags: { seen: true }, ...i }));
  const hub = new MailHub({ db: chat.db, backend: fake, log: () => {}, now: () => clock.now });
  const attention = new Attention(chat, new Triage(chat), () => clock.now);
  mailPeople(hub)!.connect(chat);
  mailAttention(hub)!.connect(chat, attention, () => clock.now);
  hub.start();
  await hub.sync(ACC)!.whenSynced();
  // Who you wrote to makes their other mail from a person: the classifier's and people's background steps finish.
  while (!mailClassifier(hub)!.idle || !mailPeople(hub)!.idle) await new Promise((r) => setImmediate(r));
  attention.rescoreAll();
  cleanup = () => {
    mailPeople(hub)?.stop();
    hub.stop();
    chat.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  /**
   * What the inbox lists of mail now, after the changes so far. A flush scores for 15 ms at most and leaves the rest
   * for the next (the server flushes every 80 ms), so this flushes until nothing waits.
   */
  const mail = () => {
    attention.sync([]);
    while (mailAttention(hub)!.busy) attention.sync([]);
    return new Map(attention.list().filter((v) => v.kind === 'mail').map((v) => [v.id, v]));
  };
  return { chat, fake, hub, attention, clock, mail };
}

const tid = (h: MailHub, messageId: string) => h.store.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', mailId('mml', ACC, `m:${messageId}`))!.thread_id;

describe('owed and unread', () => {
  test('Sam wrote to you: listed, unread, owed; read, still owed; answered, owed no more', async () => {
    const w = await world((put) => put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: T0 + 10 * DAY - 2 * H, flags: { seen: false } }));
    const t = tid(w.hub, '<s1@x>');
    let v = w.mail().get(t)!;
    expect(v).toMatchObject({ kind: 'mail', needs: true, owedSince: T0 + 10 * DAY - 2 * H });
    expect(v.reasons).toContain('1 unread message');
    expect(v.reasons.some((r) => r.startsWith('Sam Rivera wrote to you 2 hours ago; not answered yet'))).toBe(true);
    expect(w.hub.store.threadView(w.hub.store.thread(t)!).owedSince).toBe(T0 + 10 * DAY - 2 * H);

    // Read: nothing unread, and the turn is still yours.
    w.hub.readHere([t]);
    v = w.mail().get(t)!;
    expect(v.reasons).not.toContain('1 unread message');
    expect(v.owedSince).toBe(T0 + 10 * DAY - 2 * H);
    expect(v.needs).toBe(true);

    // Answered (Sent's copy): listed still (it is recent), owing nothing.
    w.clock.now += 10 * MIN;
    w.fake.deliver(ACC, { mailboxId: 'INBOX', messageId: '<s2@x>', inReplyTo: '<s1@x>', references: ['<s1@x>'], from: [ME], to: [SAM], subject: 'Re: Dinner?', receivedAt: w.clock.now, flags: { seen: true } });
    await until(() => w.mail().get(t)?.owedSince === null, 3000, 'the answer');
    expect(w.hub.store.threadView(w.hub.store.thread(t)!).owedSince).toBeNull();
  });

  test('a flush out of time leaves the read for the next one, which shows it', async () => {
    const w = await world((put) => put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: T0 + 10 * DAY - 2 * H, flags: { seen: false } }));
    const t = tid(w.hub, '<s1@x>');
    expect(w.mail().get(t)!.reasons).toContain('1 unread message');
    // Each fold takes 20 ms by this clock: the read thread's fold spends the flush's 15, and its score waits.
    const src = mailAttention(w.hub)!;
    let ms = 0;
    src.budgetClock = () => ms;
    const facts = src.triageFacts;
    src.triageFacts = (ids) => ((ms += 20), facts(ids));
    w.hub.readHere([t]);
    w.attention.sync([]);
    expect(src.busy).toBe(true);
    expect(src.view(t)!.reasons).toContain('1 unread message');
    w.attention.sync([]);
    expect(src.busy).toBe(false);
    expect(src.view(t)!.reasons).not.toContain('1 unread message');
    expect(src.view(t)!.owedSince).toBe(T0 + 10 * DAY - 2 * H);
  });

  test('an answer sent from here pays what you owe at once, before Sent’s copy comes; a dry run does not', async () => {
    const w = await world((put) => put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: T0 + 10 * DAY - H }));
    const t = tid(w.hub, '<s1@x>');
    expect(w.mail().get(t)!.owedSince).not.toBeNull();
    w.hub.emit('sent', { accountId: ACC, outboxId: 'mob_1', messageId: '<s2@x>', replyTo: null, threadId: t, dryRun: true });
    expect(w.mail().get(t)!.owedSince).not.toBeNull();
    w.hub.emit('sent', { accountId: ACC, outboxId: 'mob_2', messageId: '<s2@x>', replyTo: null, threadId: t, dryRun: false });
    expect(w.mail().get(t)!.owedSince).toBeNull();
  });

  test('in a group, you owe the one who wrote to you in To, not the one who Cc’d you', async () => {
    const w = await world((put) => {
      put({ messageId: '<a1@x>', from: [ALICE], to: [ME], cc: [JO], subject: 'Lease', receivedAt: T0 + 10 * DAY - 3 * H });
      put({ messageId: '<j1@x>', from: [JO], to: [ALICE], cc: [ME], subject: 'Party', receivedAt: T0 + 10 * DAY - 2 * H });
    });
    const views = w.mail();
    expect(views.get(tid(w.hub, '<a1@x>'))!.owedSince).toBe(T0 + 10 * DAY - 3 * H);
    expect(views.get(tid(w.hub, '<j1@x>'))!.owedSince).toBeNull();
  });
});

describe('the listing window', () => {
  const at = T0 + 100 * DAY;
  /** Read mail you answered last: listed only while recent or recently opened. */
  const answered = (put: (i: FakeInput) => void, k: string, age: number) => {
    put({ messageId: `<${k}1@x>`, from: [SAM], to: [ME], subject: `Answered ${k}`, receivedAt: at - age - H });
    put({ mailboxId: 'Sent', messageId: `<${k}2@x>`, inReplyTo: `<${k}1@x>`, references: [`<${k}1@x>`], from: [ME], to: [SAM], subject: `Re: Answered ${k}`, receivedAt: at - age });
  };
  test('recent, unread, owed and opened each list a thread, each for so long', async () => {
    const w = await world((put) => {
      answered(put, 'r', 5 * DAY);
      answered(put, 'o', 8 * DAY);
      put({ messageId: '<u1@x>', from: [SAM], to: [ME], subject: 'Unread', receivedAt: at - 20 * DAY, flags: { seen: false } });
      put({ messageId: '<u2@x>', from: [SAM], to: [ME], subject: 'Unread long ago', receivedAt: at - 40 * DAY, flags: { seen: false } });
      put({ messageId: '<w1@x>', from: [ALICE], to: [ME], subject: 'Owed', receivedAt: at - 10 * DAY });
      put({ messageId: '<w2@x>', from: [ALICE], to: [ME], subject: 'Owed long ago', receivedAt: at - 15 * DAY });
    }, at);
    const listed = () => [...w.mail().keys()].map((id) => w.hub.store.thread(id)!.subject).sort();
    expect(listed()).toEqual(['Owed', 'Re: Answered r', 'Unread']);
    // Opening an old one lists it for two days.
    w.hub.threadDetail(tid(w.hub, '<o1@x>'));
    expect(listed()).toEqual(['Owed', 'Re: Answered o', 'Re: Answered r', 'Unread']);
    expect(w.mail().get(tid(w.hub, '<o1@x>'))!.reasons.some((r) => r.startsWith('You were here'))).toBe(true);
    // Time passes: each lets go at its edge.
    w.clock.now = at + 1.5 * DAY;
    w.attention.rescoreAll();
    expect(listed()).toEqual(['Owed', 'Re: Answered o', 'Re: Answered r', 'Unread']);
    w.clock.now = at + 2.5 * DAY;
    w.attention.rescoreAll();
    expect(listed()).toEqual(['Owed', 'Unread']);
    w.clock.now = at + MAIL_INBOX.owed - 10 * DAY + DAY;
    w.attention.rescoreAll();
    expect(listed()).toEqual(['Unread']);
    // The bootstrap's window carries what is listed, however old.
    expect(w.hub.bootstrap().threads.map((t) => t.subject)).toContain('Unread');
  });
});

describe('archive removes', () => {
  test('archived from here (slice 4): out at once, back when it returns to Inbox', async () => {
    const w = await world((put) => put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: T0 + 10 * DAY - H, flags: { seen: false } }));
    const t = tid(w.hub, '<s1@x>');
    expect(w.mail().has(t)).toBe(true);
    mailOps(w.hub).move({ threadIds: [t], to: 'archive' });
    expect(w.mail().has(t)).toBe(false);
    expect(w.hub.store.thread(t)!.listed).toBe(0);
    mailOps(w.hub).move({ threadIds: [t], to: 'inbox' });
    expect(w.mail().has(t)).toBe(true);
  });

  test('archived in another mail app: out once sync sees it', async () => {
    const w = await world((put) => put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: T0 + 10 * DAY - H }));
    const t = tid(w.hub, '<s1@x>');
    expect(w.mail().has(t)).toBe(true);
    w.fake.move(ACC, w.fake.messages(ACC, 'INBOX')[0].id, 'Archive');
    // Out of Inbox first (IDLE reports it), then found in Archive.
    await until(() => w.hub.store.thread(t)?.roles === '["archive"]', 3000, 'the archive');
    expect(w.mail().has(t)).toBe(false);
    expect(w.hub.store.thread(t)!.listed).toBe(0);
    await w.hub.sync(ACC)!.whenSynced();
  });
});

describe('only mail from people', () => {
  test('bulk is never listed; a sender nobody knows waits for triage (§14 Q4)', async () => {
    const w = await world((put) => {
      put({ messageId: '<n1@x>', from: [{ name: 'News', email: 'news@weekly.example' }], to: [ME], subject: 'Issue 1', receivedAt: T0 + 10 * DAY - H, flags: { seen: false }, bulk: { listId: '<weekly.example>', unsubscribe: null, precedence: null, autoSubmitted: null } });
      put({ messageId: '<t1@x>', from: [THEO], to: [ME], subject: 'Hello', receivedAt: T0 + 10 * DAY - H, flags: { seen: false } });
    });
    expect(w.mail().size).toBe(0);
    const theo = tid(w.hub, '<t1@x>');
    // Slice 9's rating: on the list or above lets it in.
    mailAttention(w.hub)!.triage = (id) => id === theo;
    w.attention.rescoreAll();
    expect([...w.mail().keys()]).toEqual([theo]);
  });

  test('"Not a person" takes it out; a muted thread is not listed', async () => {
    const w = await world((put) => {
      put({ mailboxId: 'Sent', messageId: '<s0@x>', from: [ME], to: [SAM], subject: 'Hi', receivedAt: T0 });
      put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: T0 + 10 * DAY - H });
      put({ messageId: '<a1@x>', from: [ALICE], to: [ME], subject: 'Lease', receivedAt: T0 + 10 * DAY - H });
    });
    const t = tid(w.hub, '<s1@x>');
    expect(w.mail().has(t)).toBe(true);
    const url = new URL(`http://hub/api/mail/threads/${t}/person`);
    await w.hub.route(new Request(url, { method: 'PUT', body: JSON.stringify({ person: false }) }), url);
    expect(w.mail().has(t)).toBe(false);
    const a = tid(w.hub, '<a1@x>');
    w.hub.store.db.query('UPDATE mail_thread SET muted = 1 WHERE id = ?').run(a);
    w.attention.rescoreAll();
    expect(w.mail().has(a)).toBe(false);
  });
});

describe('how you answer someone, over all of it', () => {
  test('Sam answered quickly in two threads: the third says you usually reply within half an hour; chat sees it too', async () => {
    const at = T0 + 10 * DAY;
    const w = await world((put) => {
      for (const [i, d] of [
        [1, 5],
        [2, 3],
      ] as const) {
        put({ messageId: `<q${i}@x>`, from: [SAM], to: [ME], subject: `Question ${i}`, receivedAt: at - d * DAY });
        put({ mailboxId: 'Sent', messageId: `<r${i}@x>`, inReplyTo: `<q${i}@x>`, references: [`<q${i}@x>`], from: [ME], to: [SAM], subject: `Re: Question ${i}`, receivedAt: at - d * DAY + 20 * MIN });
      }
      put({ messageId: '<q3@x>', from: [SAM], to: [ME], subject: 'Question 3', receivedAt: at - 2 * H });
    }, at);
    const v = w.mail().get(tid(w.hub, '<q3@x>'))!;
    expect(v.reasons.some((r) => /^You usually reply to Sam Rivera within 30 minutes; unanswered for 2 hours/.test(r))).toBe(true);
    // Chat's scoring of the same person sums these (attention.ts otherTallies), and nobody else's.
    const person = w.chat.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', hubId('idn', 'email', SAM.email))!.person_id;
    const t = w.attention.otherTallies!(person);
    expect(t.reduce((n, x) => n + x.replied, 0)).toBeGreaterThan(1.5);
    expect(w.attention.otherTallies!('per_nobody')).toEqual([]);
  });
});

describe('with the chats', () => {
  test('mail views go out in attention events, list with the bootstrap, and resume by id; explain answers for them', async () => {
    const w = await world((put) => put({ messageId: '<s1@x>', from: [SAM], to: [ME], subject: 'Dinner?', receivedAt: T0 + 10 * DAY - H }));
    const t = tid(w.hub, '<s1@x>');
    expect(w.attention.list().map((v) => v.id)).toContain(t);
    expect(w.attention.view(t)?.kind).toBe('mail');
    expect((w.attention.explain(t) as any).kind).toBe('mail');
    w.fake.deliver(ACC, { mailboxId: 'INBOX', messageId: '<s2@x>', inReplyTo: '<s1@x>', references: ['<s1@x>'], from: [SAM], to: [ME], subject: 'Re: Dinner?', receivedAt: w.clock.now, flags: { seen: false } });
    let ev: P.ClientEvent[] = [];
    await until(() => (ev = w.attention.sync([])).length, 3000, 'an attention event');
    expect(ev[0]).toMatchObject({ t: 'attention', items: [{ id: t, kind: 'mail' }], removed: [] });
  });
});
