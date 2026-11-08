/**
 * Keeping mail up to date (mail/sync.ts, docs/mail-design.md §3.3-3.4) against FakeMailBackend: the first sync's
 * order, `more`, 410, moves with and without new ids, Proton's account-wide state, an arrival before its changes, a
 * gap, the manager going away and coming back, and access ending.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import { MailCallError } from '../src/mail/backend.ts';
import { FakeMailBackend, type FakeOpts } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { MAIL_LIMITS } from '../src/mail/limits.ts';

const ACC = 'acc_syncTest01';
const ME = 'me@example.com';
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

let hub: MailHub | null = null;
afterEach(() => {
  hub?.stop();
  hub = null;
});

function world(opts: FakeOpts = {}, seed: (f: FakeMailBackend) => void = () => {}, now = () => Date.now()) {
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME, opts });
  seed(fake);
  const db = new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  hub = new MailHub({ db, backend: fake, log: () => {}, now });
  const ingested: string[] = [];
  hub.on('ingested', (e) => ingested.push(...e.messageIds));
  hub.start();
  return { fake, hub, st: hub.store, ingested, synced: () => hub!.sync(ACC)!.whenSynced() };
}

const msgId = (hdr: string) => mailId('mml', ACC, `m:${hdr}`);
const ops = (fake: FakeMailBackend) => fake.calls.map((c) => `${c.op}${c.input.mailboxId ? ` ${c.input.mailboxId}` : ''}${c.input.state ? ' @' : ''}${c.input.limit ? ` ${c.input.limit}` : ''}${c.input.before ? ' …' : ''}`);
const held = (st: MailHub['store'], native: string) => st.one<{ message_id: string }>('SELECT message_id FROM mail_location WHERE native_id = ?', native)?.message_id ?? null;

describe('first sync', () => {
  test('mailboxes, then states, then Inbox’s newest page, Sent’s, then both further down', async () => {
    const { fake, st, synced } = world({}, (f) => {
      for (let i = 0; i < 70; i++) f.put(ACC, { messageId: `<in${i}@x>`, receivedAt: T0 + i * H, subject: `In ${i}` });
      for (let i = 0; i < 60; i++) f.put(ACC, { mailboxId: 'Sent', messageId: `<out${i}@x>`, from: [{ name: null, email: ME }], receivedAt: T0 + i * H, subject: `Out ${i}` });
    });
    await synced();
    expect(ops(fake).slice(0, 8)).toEqual(['mail.mailboxes', 'mail.changes INBOX', 'mail.changes Sent', 'mail.changes Archive', 'mail.list INBOX 50', 'mail.list Sent 50', 'mail.list INBOX 150 …', 'mail.list Sent 150 …']);
    expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message')!.n).toBe(130);
    expect(st.account(ACC)!.synced_at).not.toBeNull();
    expect(st.mailboxByNative(ACC, 'INBOX')!.complete).toBe(1);
    // Afterwards, a changes pass on each followed mailbox (states taken before listing).
    await until(() => fake.calls.filter((c) => c.op === 'mail.changes' && c.input.state).length >= 3, 2000, 'the catch-up');
  });

  test('stops at MAIL_LIMITS.firstSync of a big Inbox; the rest is backfill (slice 2)', async () => {
    const { st, synced } = world({}, (f) => {
      for (let i = 0; i < MAIL_LIMITS.firstSync + 40; i++) f.put(ACC, { messageId: `<in${i}@x>`, receivedAt: T0 + i * 60_000, subject: `Mail ${i}` });
    });
    await synced();
    const inbox = st.mailboxByNative(ACC, 'INBOX')!;
    expect(st.mailboxHeld(inbox.id).n).toBe(MAIL_LIMITS.firstSync);
    expect(inbox.complete).toBe(0);
    expect(inbox.list_next).not.toBeNull();
    // The newest were kept.
    expect(held(st, 'INBOX.100.1')).toBeNull();
  });

  test('the first page shows before the rest is listed', async () => {
    const seen: number[] = [];
    const { fake, st, synced } = world({}, (f) => {
      for (let i = 0; i < 120; i++) f.put(ACC, { messageId: `<in${i}@x>`, receivedAt: T0 + i * H });
    });
    hub!.on('ingested', () => seen.push(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message')!.n));
    await synced();
    expect(seen[0]).toBe(50);
    expect(fake.calls.findIndex((c) => c.op === 'mail.list')).toBe(4);
  });
});

describe('keeping up', () => {
  test('a new message: stored from mail.arrived at once, and the changes pass after it adds nothing twice', async () => {
    const { fake, st, synced, ingested } = world();
    await synced();
    const n = ingested.length;
    const m = fake.deliver(ACC, { messageId: '<new@x>', subject: 'Fresh', receivedAt: T0 });
    // mail.arrived is applied without waiting for a call.
    expect(held(st, m.id)).toBe(msgId('<new@x>'));
    await until(() => fake.calls.some((c) => c.op === 'mail.changes' && c.input.mailboxId === 'INBOX' && c.input.state), 2000, 'the changes pass');
    await Bun.sleep(30);
    expect(ingested.length).toBe(n + 1);
    expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_location')!.n).toBe(1);
  });

  test('`more`: changes are taken a page at a time until none wait', async () => {
    const { fake, st, synced } = world({ changesPage: 3 });
    await synced();
    // Ten arrive while the hub hears nothing (put does not send events), then one event.
    for (let i = 0; i < 10; i++) fake.put(ACC, { messageId: `<m${i}@x>`, receivedAt: T0 + i });
    fake.setFlags(ACC, fake.messages(ACC)[0].id, { seen: true });
    await until(() => st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message')!.n === 10, 3000, 'all ten');
    const passes = fake.calls.filter((c) => c.op === 'mail.changes' && c.input.mailboxId === 'INBOX' && c.input.state);
    expect(passes.length).toBeGreaterThanOrEqual(4);
  });

  test('410: the mailbox is listed again; the hub’s messages keep their ids and bodies, and what is gone goes', async () => {
    const { fake, st, synced } = world({}, (f) => {
      for (let i = 0; i < 5; i++) f.put(ACC, { messageId: `<r${i}@x>`, receivedAt: T0 + i * H, text: `body ${i}` });
    });
    await synced();
    const id0 = msgId('<r0@x>');
    await hub!.body(id0);
    expect(st.body(id0)).not.toBeNull();
    // A message deleted on the server just before the rebuild, without the hub hearing.
    const gone = fake.messages(ACC, 'INBOX').find((m) => m.messageId === '<r4@x>')!;
    fake.remove(ACC, gone.id);
    fake.rebuild(ACC, 'INBOX');
    await until(() => !held(st, 'INBOX.100.1') && st.one('SELECT 1 FROM mail_location WHERE native_id LIKE ?', 'INBOX.101.%'), 3000, 'the relist');
    await until(() => !st.one('SELECT 1 FROM mail_message WHERE id = ?', msgId('<r4@x>')), 3000, 'the removed message gone');
    expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message')!.n).toBe(4);
    expect(st.body(id0)).not.toBeNull();
    expect(held(st, fake.messages(ACC, 'INBOX').find((m) => m.messageId === '<r0@x>')!.id)).toBe(id0);
    expect(hub!.sync(ACC)!.phase).toBe('idle');
  });

  test('an IMAP move: a new id in the other mailbox, the same hub message, its body kept', async () => {
    const { fake, st, synced } = world({ ids: 'imap', events: 'inbox' }, (f) => f.put(ACC, { messageId: '<mv@x>', text: 'keep me', receivedAt: T0 }));
    await synced();
    const id = msgId('<mv@x>');
    await hub!.body(id);
    const t = st.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', id)!.thread_id;
    const old = fake.messages(ACC, 'INBOX')[0].id;
    // IDLE reports the inbox only: the Archive side is found when the hub asks before deleting.
    const moved = fake.move(ACC, old, 'Archive');
    expect(moved).not.toBe(old);
    await until(() => held(st, moved) === id, 3000, 'the new location');
    await Bun.sleep(30);
    expect(held(st, old)).toBeNull();
    expect(st.one('SELECT thread_id FROM mail_message WHERE id = ?', id)).toEqual({ thread_id: t });
    expect(st.body(id)).not.toBeNull();
    expect(st.threadView(st.thread(t)!).roles).toEqual(['archive']);
  });

  test('moved to a folder the hub does not follow: deleted here (other folders are slice 2)', async () => {
    const { fake, st, synced } = world({}, (f) => f.put(ACC, { messageId: '<away@x>', receivedAt: T0 }));
    await synced();
    fake.move(ACC, fake.messages(ACC, 'INBOX')[0].id, 'Junk');
    await until(() => !st.one('SELECT 1 FROM mail_message'), 3000, 'the message gone');
    expect(st.one('SELECT 1 FROM mail_thread')).toBeNull();
  });

  test('Proton-like: ids survive moves, one state for the account, and removals of ids a mailbox never had are ignored', async () => {
    const { fake, st, synced } = world({ ids: 'proton', state: 'account', events: 'all', threadIds: true, refs: false }, (f) => {
      f.put(ACC, { messageId: '<p1@x>', threadId: 'conv-1', receivedAt: T0 });
      f.put(ACC, { mailboxId: 'Archive', messageId: '<p2@x>', threadId: 'conv-1', receivedAt: T0 + H });
    });
    await synced();
    // Both in one thread, by the server's thread id, though only Inbox and Sent are listed at first.
    const p1 = fake.messages(ACC, 'INBOX')[0];
    fake.move(ACC, p1.id, 'Archive');
    await until(() => st.one<{ role: string }>('SELECT b.role FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.native_id = ?', p1.id)?.role === 'archive', 3000, 'the move');
    expect(held(st, p1.id)).toBe(msgId('<p1@x>'));
    // Deleted for good from Archive: every mailbox's changes name it.
    const before = fake.calls.length;
    fake.remove(ACC, p1.id);
    await until(() => !st.one('SELECT 1 FROM mail_message WHERE id = ?', msgId('<p1@x>')), 3000, 'the delete');
    expect(fake.calls.slice(before).filter((c) => c.op === 'mail.changes').map((c) => c.input.mailboxId)).toContain('INBOX');
  });

  test('a gap: the account catches up with mail.changes', async () => {
    const { fake, st, synced } = world();
    await synced();
    fake.put(ACC, { messageId: '<missed@x>', receivedAt: T0 });
    fake.gap(ACC);
    await until(() => st.one('SELECT 1 FROM mail_message WHERE id = ?', msgId('<missed@x>')), 3000, 'the missed message');
  });

  test('the manager away and back: nothing is asked meanwhile, and what came is fetched after', async () => {
    const { fake, st, synced } = world();
    await synced();
    fake.setConnected(false);
    expect(hub!.access().state).toBe('unreachable');
    fake.deliver(ACC, { messageId: '<while-away@x>', receivedAt: T0 });
    await Bun.sleep(30);
    expect(st.one('SELECT 1 FROM mail_message')).toBeNull();
    await expect(hub!.body(msgId('<while-away@x>'))).rejects.toThrow();
    fake.setConnected(true);
    await until(() => st.one('SELECT 1 FROM mail_message WHERE id = ?', msgId('<while-away@x>')), 3000, 'the catch-up');
    expect(hub!.access().state).toBe('granted');
  });

  test('a failing call is logged, not fatal: the next event tries again', async () => {
    const { fake, st, synced } = world();
    await synced();
    fake.fail('mail.changes', new MailCallError('Service Unavailable', 503));
    fake.deliver(ACC, { messageId: '<a@x>', receivedAt: T0, flags: { seen: false } });
    await Bun.sleep(30);
    fake.setFlags(ACC, fake.messages(ACC)[0].id, { seen: true });
    await until(() => st.one<{ seen: number }>('SELECT seen FROM mail_message')?.seen === 1, 3000, 'the flag');
  });

  test('`limited`: the work waits and runs again', async () => {
    const { fake, st, synced } = world();
    await synced();
    fake.fail('mail.get', new MailCallError('rate limited', 429, 'limited'));
    fake.put(ACC, { messageId: '<b@x>', text: 'slowly', receivedAt: T0 });
    fake.gap(ACC);
    await until(() => st.one('SELECT 1 FROM mail_message'), 3000, 'the message');
    const v = await hub!.body(msgId('<b@x>'));
    expect(v.text).toBe('slowly');
  }, 10_000);
});

describe('the page', () => {
  test('the thread view, the body on demand, read here, and what is flushed', async () => {
    const { fake, st, synced } = world({}, (f) => {
      f.put(ACC, { messageId: '<q1@x>', subject: 'Question', receivedAt: T0, text: 'Free on Friday?' });
      f.put(ACC, { mailboxId: 'Sent', messageId: '<q2@x>', inReplyTo: '<q1@x>', references: ['<q1@x>'], from: [{ name: null, email: ME }], to: [{ name: 'Al', email: 'al@x.org' }], subject: 'Re: Question', receivedAt: T0 + H, flags: { seen: true }, text: 'Yes!' });
      f.put(ACC, { messageId: '<q3@x>', inReplyTo: '<q2@x>', references: ['<q1@x>', '<q2@x>'], subject: 'Re: Question', receivedAt: T0 + 2 * H, html: '<p>Great, <i>see you</i>.</p>' });
    });
    await synced();
    hub!.flush();
    const t = st.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', msgId('<q1@x>'))!.thread_id;
    const d = hub!.threadDetail(t)!;
    expect(d.messages.map((m) => [m.subject, m.addressed, m.body])).toEqual([
      ['Question', 'to', 'none'],
      ['Re: Question', 'self', 'none'],
      ['Re: Question', 'to', 'none'],
    ]);
    expect(d.thread.unread).toBe(2);
    // An HTML-only message: its text part, made from the HTML.
    const b = await hub!.body(msgId('<q3@x>'));
    expect(b.text).toBe('Great, see you.');
    expect(fake.calls.filter((c) => c.op === 'mail.get')).toHaveLength(1);
    await hub!.body(msgId('<q3@x>'));
    expect(fake.calls.filter((c) => c.op === 'mail.get')).toHaveLength(1);
    const read: string[][] = [];
    hub!.on('read', (e) => read.push(e.threadIds));
    hub!.readHere([t]);
    expect(read).toEqual([[t]]);
    const ev = hub!.flush().find((e) => e.t === 'mail.threads') as Extract<P.ClientEvent, { t: 'mail.threads' }>;
    expect(ev.threads.find((x) => x.id === t)).toMatchObject({ unread: 0, preview: 'Great, see you.' });
    // Read here only: the server was not told (that is slice 4).
    expect(fake.calls.some((c) => c.op === 'mail.flag')).toBe(false);
  });

  test('the routes answer through the table', async () => {
    const { synced } = world({}, (f) => f.put(ACC, { messageId: '<r@x>', receivedAt: T0, subject: 'Routed' }));
    await synced();
    const get = async (path: string, method = 'GET') => {
      const res = await hub!.route(new Request(`http://hub${path}`, { method }), new URL(`http://hub${path}`));
      return { status: res?.status ?? 0, json: res ? await res.json() : null };
    };
    const all = await get('/api/mail');
    expect(all.json.access.state).toBe('granted');
    expect(all.json.accounts.map((a: P.MailAccountView) => a.address)).toEqual([ME]);
    const page = await get('/api/mail/threads?list=v:inbox:*');
    expect(page.json.threads.map((t: P.MailThreadView) => t.subject)).toEqual(['Routed']);
    expect((await get(`/api/mail/threads/${page.json.threads[0].id}`)).json.messages).toHaveLength(1);
    expect((await get('/api/mail/threads/mth_nope')).status).toBe(404);
    expect((await get('/api/mail/threads?list=v:people:*')).status).toBe(404);
    expect((await get(`/api/mail/accounts/${ACC}`, 'DELETE')).status).toBe(409);
    expect(await hub!.route(new Request('http://hub/api/mail/nothing'), new URL('http://hub/api/mail/nothing'))).toBeNull();
  });
});

describe('access', () => {
  test('an account that leaves the list keeps its mail for a day, then it goes; "Delete now" does it at once', async () => {
    let now = T0;
    const { fake, st, synced } = world({}, (f) => f.put(ACC, { messageId: '<k@x>', receivedAt: T0 }), () => now);
    await synced();
    const ended: string[] = [];
    hub!.on('account', (e) => ended.push(e.state));
    fake.removeAccount(ACC);
    expect(ended).toEqual(['ended']);
    expect(st.account(ACC)).toMatchObject({ level: null, gone_at: T0 });
    expect(st.one('SELECT 1 FROM mail_message')).not.toBeNull();
    const view = hub!.flush().find((e) => e.t === 'mail.account') as Extract<P.ClientEvent, { t: 'mail.account' }>;
    expect(view.account.deleteAt).toBe(T0 + MAIL_LIMITS.goneMs);
    // A day later the sweep takes it.
    now = T0 + MAIL_LIMITS.goneMs + 1;
    (hub as any).sweep();
    expect(st.account(ACC)).toBeNull();
    expect(st.one('SELECT 1 FROM mail_message')).toBeNull();
    expect(hub!.flush().map((e) => e.t)).toContain('mail.account.removed');
  });

  test('back on the list before then: kept, and syncing again', async () => {
    const { fake, st, synced } = world({}, (f) => f.put(ACC, { messageId: '<k@x>', receivedAt: T0 }));
    await synced();
    fake.removeAccount(ACC);
    expect(hub!.deleteNow('acc_unknown')).toBe('unknown');
    fake.addAccount(ACC, { email: ME });
    expect(st.account(ACC)!.gone_at).toBeNull();
    expect(hub!.deleteNow(ACC)).toBe('active');
    fake.removeAccount(ACC);
    expect(hub!.deleteNow(ACC)).toBe('deleted');
    expect(st.one('SELECT 1 FROM mail_message')).toBeNull();
  });
});

describe('a page that comes back (the journal, docs/sync.md)', () => {
  test('what changed in mail since its position comes back as mail events, and a client applying them matches the hub', async () => {
    const { Store } = await import('../src/store.ts');
    const { changesOf } = await import('../src/journal.ts');
    const { syncResponse } = await import('../src/sync.ts');
    const { applyMailBootstrap, applyMailEvent, emptyMail } = await import('../../web/src/mail/model.ts');
    const store = new Store(':memory:', (raw) => raw ?? null);
    const fake = new FakeMailBackend();
    fake.addAccount(ACC, { email: ME });
    fake.put(ACC, { messageId: '<one@x>', subject: 'First', receivedAt: T0 });
    hub = new MailHub({ db: store.db, backend: fake, log: () => {} });
    hub.start();
    await hub.sync(ACC)!.whenSynced();
    const record = () => store.journal.record(changesOf(hub!.flush()));
    record();
    const client = emptyMail();
    applyMailBootstrap(client, hub.bootstrap());
    const pos = store.journal.position();
    // Meanwhile: a new message, a read, and the account's status.
    fake.deliver(ACC, { messageId: '<two@x>', subject: 'Second', receivedAt: T0 + H });
    await until(() => hub!.store.one('SELECT 1 FROM mail_message WHERE id = ?', msgId('<two@x>')), 2000, 'the new one');
    hub.readHere([hub.store.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', msgId('<one@x>'))!.thread_id]);
    fake.setOnline(ACC, false);
    record();
    const r = syncResponse({ store, usage: {} as any, mail: hub, boot: 'b' }, { v: pos.v, epoch: pos.epoch, since: pos.seq });
    if (r.full) throw new Error('refused');
    const kinds = r.events.map((e) => e.t);
    expect(kinds).toContain('mail.threads');
    expect(kinds).toContain('mail.account');
    for (const e of r.events) applyMailEvent(client, e);
    const fresh = emptyMail();
    applyMailBootstrap(fresh, hub.bootstrap());
    expect([...client.threads.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...fresh.threads.values()].sort((a, b) => a.id.localeCompare(b.id)));
    expect(client.accounts.get(ACC)).toEqual(fresh.accounts.get(ACC)!);
    expect(client.accounts.get(ACC)!.online).toBe(false);
    store.db.close();
  });
});
