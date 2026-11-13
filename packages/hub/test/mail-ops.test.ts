/**
 * Writes (mail/ops.ts, docs/mail-design.md §2.4, §3.7) against FakeMailBackend: shown at once and pending until the
 * server answers, batches of 1000, 404, 403 and 501, a restart with changes waiting, the manager away, read in view
 * and the "only when I mark it" setting, a read grant, moves with and without new ids, a move out of All mail where
 * ids are the message's (Proton, whether its status says so or not) and where they are not, the routes, threadIds
 * beside ids, answers in part (refused, unknown, a move's nulls), and the writes a status lists (details.writes).
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import { MailCallError } from '../src/mail/backend.ts';
import { FakeMailBackend, type FakeOpts, PROTON_DETAILS } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailOps } from '../src/mail/ops.ts';
import { FakeClock } from './fixtures/clock.ts';

const ACC = 'acc_opsTest01';
const ME = 'me@example.com';
const T0 = Date.UTC(2026, 10, 1, 12);
const H = 3_600_000;
const sam = { name: 'Sam', email: 'sam@example.net' };

/** Each test's clock (world() makes one): the writer's pacing and the fake server's answers run on it. */
let clock = new FakeClock();
const until = (f: () => unknown, ms = 4000, what = 'condition') => clock.until(f, ms, what);

const hubs: MailHub[] = [];
afterEach(() => {
  for (const h of hubs.splice(0)) h.stop();
});

function start(db: Database, fake: FakeMailBackend) {
  fake.clock = clock;
  const hub = new MailHub({ db, backend: fake, log: () => {}, clock });
  hubs.push(hub);
  const ops = mailOps(hub);
  ops.coalesceMs = 0;
  ops.pollMs = 20;
  const filed: { action: string; threadIds: string[]; undone?: boolean }[] = [];
  hub.on('filed', (e) => filed.push(e));
  hub.start();
  return { hub, ops, filed, st: hub.store };
}

async function world(o: { opts?: FakeOpts; level?: 'read' | 'write'; seed?: (f: FakeMailBackend) => void } = {}) {
  clock = new FakeClock();
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME, opts: o.opts, level: o.level });
  o.seed?.(fake);
  const db = new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  const w = start(db, fake);
  await clock.wait(w.hub.sync(ACC)!.whenSynced());
  return { fake, db, ...w };
}

/** Sam's two-message thread, a newsletter, and something of yours in Sent. */
function seed(f: FakeMailBackend) {
  f.put(ACC, { messageId: '<a1@x>', from: [sam], subject: 'Dinner', receivedAt: T0, flags: { seen: true } });
  f.put(ACC, { messageId: '<a2@x>', from: [sam], subject: 'Re: Dinner', inReplyTo: '<a1@x>', references: ['<a1@x>'], receivedAt: T0 + H });
  f.put(ACC, { mailboxId: 'Sent', messageId: '<a3@x>', from: [{ name: null, email: ME }], to: [sam], subject: 'Re: Dinner', inReplyTo: '<a2@x>', references: ['<a1@x>', '<a2@x>'], receivedAt: T0 + 2 * H, flags: { seen: true } });
  f.put(ACC, { messageId: '<n1@x>', from: [{ name: 'News', email: 'news@list.example' }], subject: 'Weekly', receivedAt: T0 + 3 * H });
}

const mid = (hdr: string) => mailId('mml', ACC, `m:${hdr}`);
const msg = (st: MailHub['store'], hdr: string) => st.one('SELECT * FROM mail_message WHERE id = ?', mid(hdr))!;
const thread = (st: MailHub['store'], hdr: string) => st.threadView(st.thread(msg(st, hdr).thread_id)!);
const onServer = (f: FakeMailBackend, hdr: string) => f.messages(ACC).find((m) => m.messageId === hdr)!;
const writes = (f: FakeMailBackend) => f.calls.filter((c) => c.op === 'mail.flag' || c.op === 'mail.move' || c.op === 'mail.trash');
const boxOf = (st: MailHub['store'], role: string) => st.one<{ id: string }>('SELECT id FROM mailbox WHERE account_id = ? AND role = ?', ACC, role)!.id;

describe('shown at once, pending until the server answers', () => {
  test('archive: out of Inbox at once, then moved on the server with a new UID, the same hub message', async () => {
    const { fake, st, ops, filed } = await world({ seed });
    ops.coalesceMs = 60_000;
    const t = thread(st, '<a1@x>');
    const r = ops.move({ threadIds: [t.id], to: 'archive' });
    // Sam's two are in Inbox; your reply stays in Sent.
    expect(r).toEqual({ ok: true, threads: 1, messages: 2 });
    const now = thread(st, '<a1@x>');
    expect(now.roles).not.toContain('inbox');
    expect(now.roles).toEqual(expect.arrayContaining(['archive', 'sent']));
    expect(now.pending).toBe(true);
    expect(st.listThreads('v:inbox:*', null, 50)!.threads.map((x) => x.id)).not.toContain(t.id);
    expect(st.listThreads(`mb:${boxOf(st, 'archive')}`, null, 50)!.threads.map((x) => x.id)).toContain(t.id);
    expect(filed).toEqual([{ accountId: ACC, threadIds: [t.id], action: 'archive' }]);
    expect(st.accountView(st.account(ACC)!).ops).toMatchObject({ waiting: 2, error: null });
    // Nothing has reached the server yet.
    expect(onServer(fake, '<a2@x>').mailboxId).toBe('INBOX');
    expect(writes(fake)).toEqual([]);

    ops.coalesceMs = 0;
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    expect(writes(fake).map((c) => [c.op, c.input.ids.length, c.input.mailboxId])).toEqual([['mail.move', 2, 'Archive']]);
    const there = onServer(fake, '<a2@x>');
    expect(there.mailboxId).toBe('Archive');
    // The hub message is the same, now at its new id in Archive only.
    const locs = st.all('SELECT mailbox_id, native_id FROM mail_location WHERE message_id = ?', mid('<a2@x>'));
    expect(locs).toEqual([{ mailbox_id: boxOf(st, 'archive'), native_id: there.id }]);
    expect(msg(st, '<a2@x>').pending).toBeNull();
    expect(thread(st, '<a1@x>').pending).toBe(false);
    expect(thread(st, '<a1@x>').roles).not.toContain('inbox');
    // The changes passes the move set off keep it so.
    await until(() => fake.calls.filter((c) => c.op === 'mail.changes' && c.input.mailboxId === 'Archive' && c.input.state).length >= 1, 2000, 'changes on Archive');
    await clock.settle();
    expect(st.all('SELECT 1 FROM mail_location WHERE message_id = ?', mid('<a2@x>')).length).toBe(1);
    expect(st.accountView(st.account(ACC)!).ops!.waiting).toBe(0);
  });

  test('star and read: the columns change at once, the server follows, and its later changes win again', async () => {
    const { fake, st, ops } = await world({ seed });
    const t = thread(st, '<a1@x>');
    ops.coalesceMs = 60_000;
    ops.flag({ threadIds: [t.id], flagged: true });
    ops.flag({ threadIds: [t.id], seen: true });
    // Starring a thread stars its latest message; read marks every message read.
    expect(msg(st, '<a3@x>').flagged).toBe(1);
    expect(thread(st, '<a1@x>')).toMatchObject({ flagged: true, unread: 0, pending: true });
    expect(JSON.parse(msg(st, '<a2@x>').pending)).toMatchObject({ seen: { v: 1, was: 0 } });
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    expect(writes(fake).map((c) => [c.op, c.input.flagged ?? c.input.seen, c.input.ids.length])).toEqual([
      ['mail.flag', true, 1],
      ['mail.flag', true, 1],
    ]);
    expect(onServer(fake, '<a3@x>').flags.flagged).toBe(true);
    expect(onServer(fake, '<a2@x>').flags.seen).toBe(true);
    expect(msg(st, '<a2@x>').pending).toBeNull();
    // Another client marks it unread: the server wins now.
    fake.setFlags(ACC, onServer(fake, '<a2@x>').id, { seen: false });
    await until(() => msg(st, '<a2@x>').seen === 0, 2000, 'the server’s unread');
    expect(thread(st, '<a1@x>').unread).toBe(1);
  });

  test('while a change waits, the server’s value for that flag is not taken', async () => {
    const { fake, st, ops } = await world({ seed });
    ops.coalesceMs = 60_000;
    ops.flag({ messageIds: [mid('<n1@x>')], flagged: true });
    // Something else changes on the same message meanwhile: the flag stays ours.
    fake.setFlags(ACC, onServer(fake, '<n1@x>').id, { seen: true });
    await until(() => msg(st, '<n1@x>').seen === 1, 2000, 'the server’s seen');
    expect(msg(st, '<n1@x>').flagged).toBe(1);
  });

  test('changed back before it went: nothing is sent', async () => {
    const { fake, st, ops } = await world({ seed });
    ops.coalesceMs = 60_000;
    const t = thread(st, '<n1@x>');
    ops.move({ threadIds: [t.id], to: 'archive' });
    expect(thread(st, '<n1@x>').roles).toEqual(['archive']);
    // Undo: back to Inbox, where the server still has it.
    const r = ops.move({ threadIds: [t.id], to: 'inbox' });
    expect(r.messages).toBe(0);
    expect(thread(st, '<n1@x>')).toMatchObject({ roles: ['inbox'], pending: false });
    ops.flag({ threadIds: [t.id], flagged: true });
    ops.flag({ threadIds: [t.id], flagged: false });
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    expect(writes(fake).filter((c) => c.op === 'mail.move')).toEqual([]);
    // The unstar still goes, so a star already on its way cannot win; the server ends unstarred.
    expect(onServer(fake, '<n1@x>').flags.flagged).toBe(false);
    expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_op')!.n).toBe(0);
  });

  test('trash, junk and back: only folders move; what you sent stays in Sent', async () => {
    const { fake, st, ops } = await world({ seed });
    const t = thread(st, '<a1@x>');
    ops.move({ threadIds: [t.id], to: 'trash' });
    expect(thread(st, '<a1@x>').roles.sort()).toEqual(['sent', 'trash']);
    await clock.wait(ops.idle());
    expect(onServer(fake, '<a1@x>').mailboxId).toBe('Trash');
    expect(onServer(fake, '<a3@x>').mailboxId).toBe('Sent');
    ops.move({ threadIds: [t.id], to: 'inbox' });
    await clock.wait(ops.idle());
    expect(onServer(fake, '<a1@x>').mailboxId).toBe('INBOX');
    expect(thread(st, '<a1@x>').roles.sort()).toEqual(['inbox', 'sent']);
    const n = thread(st, '<n1@x>');
    ops.move({ threadIds: [n.id], to: 'junk' });
    await clock.wait(ops.idle());
    expect(onServer(fake, '<n1@x>').mailboxId).toBe('Junk');
    expect(thread(st, '<n1@x>').roles).toEqual(['junk']);
    // A mailbox of its own, by id.
    ops.move({ threadIds: [n.id], to: boxOf(st, 'archive') });
    await clock.wait(ops.idle());
    expect(onServer(fake, '<n1@x>').mailboxId).toBe('Archive');
    expect(st.all('SELECT 1 FROM mail_location WHERE message_id = ?', mid('<n1@x>')).length).toBe(1);
  });

  test('a server that does not say the new id: the next changes pass finds it, and the message is kept', async () => {
    const { fake, st, ops } = await world({ seed, opts: { moveIds: 'null' } });
    const before = msg(st, '<n1@x>');
    ops.move({ threadIds: [before.thread_id], to: 'archive' });
    await clock.wait(ops.idle());
    const archive = boxOf(st, 'archive');
    await until(() => st.one('SELECT 1 FROM mail_location WHERE mailbox_id = ? AND message_id = ?', archive, before.id), 3000, 'the Archive location');
    expect(msg(st, '<n1@x>').id).toBe(before.id);
    expect(thread(st, '<n1@x>').roles).toEqual(['archive']);
  });

  test('Proton-like ids survive the move', async () => {
    const { fake, st, ops } = await world({ seed, opts: { ids: 'proton', state: 'account', events: 'all' } });
    const id = onServer(fake, '<n1@x>').id;
    ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'archive' });
    await clock.wait(ops.idle());
    expect(onServer(fake, '<n1@x>')).toMatchObject({ id, mailboxId: 'Archive' });
    expect(st.all('SELECT native_id FROM mail_location WHERE message_id = ?', mid('<n1@x>'))).toEqual([{ native_id: id }]);
  });

  test('moved elsewhere by another client while ours waited: ours does not undo it', async () => {
    const { fake, st, ops } = await world({ seed });
    ops.coalesceMs = 60_000;
    ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'archive' });
    fake.move(ACC, onServer(fake, '<n1@x>').id, 'Trash');
    await until(() => !st.one(`SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = ? AND b.role = 'inbox'`, mid('<n1@x>')), 2000, 'the inbox location gone');
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    expect(writes(fake)).toEqual([]);
    expect(onServer(fake, '<n1@x>').mailboxId).toBe('Trash');
  });
});

describe('batches', () => {
  test('2500 messages: three calls of at most 1000 ids each, for flags and for moves', async () => {
    const { fake, st, ops } = await world({
      seed: (f) => {
        for (let i = 0; i < 2500; i++) f.put(ACC, { messageId: `<bulk${i}@x>`, subject: `Bulk ${i}`, receivedAt: T0 + i * 1000 });
      },
    });
    // The first sync holds the newest 500; the rest come as if listed further back.
    const inbox = st.mailboxByNative(ACC, 'INBOX')!;
    const missing = fake.messages(ACC, 'INBOX').filter((m) => !st.one('SELECT 1 FROM mail_location WHERE native_id = ?', m.id));
    st.ingest(ACC, inbox, missing.map((m) => (fake as any).summary((fake as any).accs.get(ACC), m)));
    const ids = st.all<{ id: string }>('SELECT id FROM mail_message').map((r) => r.id);
    expect(ids.length).toBe(2500);
    ops.coalesceMs = 60_000;
    // Asked in pieces: they join the calls waiting.
    ops.flag({ messageIds: ids.slice(0, 700), seen: true });
    ops.flag({ messageIds: ids.slice(700), seen: true });
    expect(st.all('SELECT json_array_length(message_ids) AS n FROM mail_op ORDER BY created_at, rowid').map((r) => r.n)).toEqual([1000, 1000, 500]);
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle(10_000));
    expect(writes(fake).map((c) => c.input.ids.length)).toEqual([1000, 1000, 500]);
    // One write to an account every 220 ms at most.
    const at = writes(fake).map((c) => c.at);
    expect(at.slice(1).map((t, i) => t - at[i])).toEqual([220, 220]);
    expect(fake.messages(ACC, 'INBOX').every((m) => m.flags.seen)).toBe(true);
    fake.calls.length = 0;
    const threads = st.all<{ id: string }>('SELECT id FROM mail_thread').map((r) => r.id);
    ops.coalesceMs = 0;
    ops.move({ threadIds: threads, to: 'archive' });
    await clock.wait(ops.idle(10_000));
    expect(writes(fake).map((c) => [c.op, c.input.ids.length])).toEqual([
      ['mail.move', 1000],
      ['mail.move', 1000],
      ['mail.move', 500],
    ]);
    expect(fake.messages(ACC, 'Archive').length).toBe(2500);
    expect(st.listThreads('v:inbox:*', null, 50)!.threads).toEqual([]);
  }, 30_000);
});

describe('what the server answers', () => {
  test('404: dropped, back to what the server had, and a changes pass', async () => {
    const { fake, st, ops, filed } = await world({ seed });
    fake.fail('mail.flag', new MailCallError('no such message', 404));
    ops.flag({ messageIds: [mid('<n1@x>')], flagged: true });
    expect(msg(st, '<n1@x>').flagged).toBe(1);
    const before = fake.calls.length;
    await clock.wait(ops.idle());
    expect(msg(st, '<n1@x>')).toMatchObject({ flagged: 0, pending: null });
    expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_op')!.n).toBe(0);
    expect(st.accountView(st.account(ACC)!).ops!.error?.message).toBe('Could not star a message: no such message');
    expect(filed.at(-1)).toMatchObject({ action: 'star', undone: true });
    await until(() => fake.calls.slice(before).some((c) => c.op === 'mail.changes' && c.input.state), 2000, 'a changes pass');
  });

  test('403: every change waiting is undone, and the account is read-only here', async () => {
    const { fake, st, ops } = await world({ seed });
    fake.fail('mail.move', new MailCallError('the hub may not write to this account', 403, 'denied'));
    ops.coalesceMs = 60_000;
    ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'archive' });
    ops.flag({ messageIds: [mid('<a1@x>')], flagged: true });
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    expect(thread(st, '<n1@x>').roles).toEqual(['inbox']);
    expect(msg(st, '<a1@x>')).toMatchObject({ flagged: 0, pending: null });
    expect(st.account(ACC)!.level).toBe('read');
    expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_op')!.n).toBe(0);
    expect(() => ops.flag({ messageIds: [mid('<a1@x>')], flagged: true })).toThrow(expect.objectContaining({ status: 403 }));
    expect(onServer(fake, '<n1@x>').mailboxId).toBe('INBOX');
  });

  test('501: undone, and refused at once from then on', async () => {
    const { fake, st, ops } = await world({ seed, opts: { ids: 'proton' } });
    fake.fail('mail.flag', new MailCallError('Proton cannot star from here', 501));
    ops.flag({ messageIds: [mid('<n1@x>')], flagged: true });
    await clock.wait(ops.idle());
    expect(msg(st, '<n1@x>').flagged).toBe(0);
    expect(st.accountView(st.account(ACC)!).ops!.unsupported).toEqual(['flag.flagged']);
    const calls = writes(fake).length;
    expect(() => ops.flag({ messageIds: [mid('<n1@x>')], flagged: true })).toThrow(expect.objectContaining({ status: 501, message: 'Proton cannot star from here' }));
    // Read still works.
    ops.flag({ messageIds: [mid('<n1@x>')], seen: true });
    await clock.wait(ops.idle());
    expect(writes(fake).length).toBe(calls + 1);
    expect(onServer(fake, '<n1@x>').flags.seen).toBe(true);
  });

  test('410: a changes pass (which lists the mailbox again), then the change is tried again', async () => {
    const { fake, st, ops } = await world({ seed });
    fake.fail('mail.flag', new MailCallError('the mailbox was rebuilt (its UIDVALIDITY changed): list it again', 410));
    const at = fake.calls.length;
    ops.flag({ messageIds: [mid('<n1@x>')], flagged: true });
    await clock.wait(ops.idle());
    expect(st.one('SELECT attempts FROM mail_op')).toEqual({ attempts: 1 });
    expect(msg(st, '<n1@x>').flagged).toBe(1);
    await until(() => fake.calls.slice(at).some((c) => c.op === 'mail.changes' && c.input.state), 2000, 'a changes pass');
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    expect(onServer(fake, '<n1@x>').flags.flagged).toBe(true);
    expect(msg(st, '<n1@x>').pending).toBeNull();
  });

  test('the ids sent are the ones current when it goes, not when it was asked', async () => {
    const { fake, st, ops } = await world({ seed });
    ops.coalesceMs = 60_000;
    ops.flag({ messageIds: [mid('<n1@x>')], flagged: true });
    const stale = onServer(fake, '<n1@x>').id;
    // A new UIDVALIDITY: every id in Inbox changes, and the hub lists it again.
    fake.rebuild(ACC, 'INBOX');
    const fresh = onServer(fake, '<n1@x>').id;
    await until(() => st.one('SELECT 1 FROM mail_location WHERE native_id = ?', fresh), 3000, 'the relist');
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    expect(writes(fake).map((c) => c.input.ids)).toEqual([[fresh]]);
    expect(fresh).not.toBe(stale);
    expect(onServer(fake, '<n1@x>').flags.flagged).toBe(true);
  });

  test('a dry run grant: the manager answers without reaching the account, so the change is undone, and says why', async () => {
    const { fake, st, ops } = await world({ seed });
    fake.setGrant(ACC, { dryRun: true });
    await until(() => st.account(ACC)!.dry_run === 1, 2000, 'the dry run grant');
    ops.flag({ messageIds: [mid('<n1@x>')], flagged: true });
    ops.move({ threadIds: [thread(st, '<a1@x>').id], to: 'archive' });
    expect(msg(st, '<n1@x>').flagged).toBe(1);
    await clock.wait(ops.idle());
    expect(msg(st, '<n1@x>')).toMatchObject({ flagged: 0, pending: null });
    expect(thread(st, '<a1@x>').roles).toContain('inbox');
    expect(onServer(fake, '<a2@x>').mailboxId).toBe('INBOX');
    expect(st.accountView(st.account(ACC)!).ops!.error?.message).toContain('a dry run: nothing reaches the account');
  });

  test('a failure that may pass is tried again, pending meanwhile', async () => {
    const { fake, st, ops } = await world({ seed });
    fake.fail('mail.flag', new MailCallError('the account is busy', 503));
    ops.flag({ messageIds: [mid('<n1@x>')], flagged: true });
    await clock.wait(ops.idle());
    const op = st.one('SELECT * FROM mail_op')!;
    expect(op).toMatchObject({ attempts: 1, error: 'the account is busy' });
    expect(msg(st, '<n1@x>').flagged).toBe(1);
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    expect(onServer(fake, '<n1@x>').flags.flagged).toBe(true);
    expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_op')!.n).toBe(0);
  });
});

describe('offline and restarts', () => {
  test('the manager away: changes wait; back, a changes pass first, then them', async () => {
    const { fake, st, ops } = await world({ seed });
    fake.setConnected(false);
    ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'archive' });
    await clock.wait(ops.idle(300));
    expect(thread(st, '<n1@x>')).toMatchObject({ roles: ['archive'], pending: true });
    expect(writes(fake)).toEqual([]);
    const at = fake.calls.length;
    fake.setConnected(true);
    await until(() => onServer(fake, '<n1@x>').mailboxId === 'Archive', 3000, 'the move');
    const after = fake.calls.slice(at).map((c) => c.op);
    expect(after.indexOf('mail.changes')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('mail.changes')).toBeLessThan(after.indexOf('mail.move'));
  });

  test('a restart with changes waiting: they are still shown, and go once the hub is back', async () => {
    const { fake, db, hub, st } = await world({ seed });
    fake.setConnected(false);
    const ops = mailOps(hub);
    ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'archive' });
    ops.flag({ threadIds: [thread(st, '<a1@x>').id], flagged: true });
    hub.stop();
    expect(db.query('SELECT COUNT(*) AS n FROM mail_op').get()).toEqual({ n: 2 });

    const again = start(db, fake);
    expect(thread(again.st, '<n1@x>')).toMatchObject({ roles: ['archive'], pending: true });
    expect(thread(again.st, '<a1@x>').flagged).toBe(true);
    fake.setConnected(true);
    await until(() => onServer(fake, '<n1@x>').mailboxId === 'Archive' && onServer(fake, '<a3@x>').flags.flagged, 4000, 'both changes on the server');
    await clock.wait(again.ops.idle());
    expect(db.query('SELECT COUNT(*) AS n FROM mail_op').get()).toEqual({ n: 0 });
    expect(thread(again.st, '<n1@x>').pending).toBe(false);
  });

  test('an account offline: its changes wait for it', async () => {
    const { fake, st, ops } = await world({ seed });
    fake.setOnline(ACC, false);
    await until(() => !st.account(ACC)!.online, 2000, 'offline');
    ops.flag({ messageIds: [mid('<n1@x>')], seen: true });
    await clock.wait(ops.idle(200));
    expect(writes(fake)).toEqual([]);
    fake.setOnline(ACC, true);
    await until(() => onServer(fake, '<n1@x>').flags.seen, 4000, 'read on the server');
  });

  test('access ends: what waited is undone', async () => {
    const { fake, st, ops } = await world({ seed });
    fake.setConnected(false);
    ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'archive' });
    fake.setConnected(true);
    fake.removeAccount(ACC);
    await until(() => st.account(ACC)!.gone_at, 2000, 'access ended');
    expect(thread(st, '<n1@x>').roles).toEqual(['inbox']);
    expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_op')!.n).toBe(0);
  });
});

describe('read state', () => {
  test('read in view goes to the server; with "only when I mark it" it stays here', async () => {
    const { fake, st, ops, hub } = await world({ seed });
    const t = thread(st, '<a1@x>');
    hub.readHere([t.id]);
    await clock.wait(ops.idle());
    expect(onServer(fake, '<a2@x>').flags.seen).toBe(true);
    expect(writes(fake).map((c) => [c.op, c.input.seen, c.input.ids.length])).toEqual([['mail.flag', true, 1]]);

    expect(ops.setSettings({ markRead: 'manual' })).toEqual({ markRead: 'manual' });
    const n = thread(st, '<n1@x>');
    hub.readHere([n.id]);
    await clock.wait(ops.idle());
    expect(thread(st, '<n1@x>').unread).toBe(0);
    expect(onServer(fake, '<n1@x>').flags.seen).toBe(false);
    // Marking it read yourself does.
    ops.flag({ threadIds: [n.id], seen: true });
    await clock.wait(ops.idle());
    expect(onServer(fake, '<n1@x>').flags.seen).toBe(true);
    // Unread: its latest message, on the server too.
    ops.flag({ threadIds: [n.id], seen: false });
    expect(thread(st, '<n1@x>').unread).toBe(1);
    await clock.wait(ops.idle());
    expect(onServer(fake, '<n1@x>').flags.seen).toBe(false);
  });

  test('a read grant: read here only, and no other writes', async () => {
    const { fake, st, ops, hub } = await world({ seed, level: 'read' });
    const t = thread(st, '<a1@x>');
    hub.readHere([t.id]);
    ops.flag({ threadIds: [thread(st, '<n1@x>').id], seen: true });
    await clock.wait(ops.idle());
    expect(thread(st, '<a1@x>').unread).toBe(0);
    expect(thread(st, '<n1@x>').unread).toBe(0);
    expect(msg(st, '<n1@x>')).toMatchObject({ seen: 0, seen_local: 1, pending: null });
    expect(writes(fake)).toEqual([]);
    expect(() => ops.move({ threadIds: [t.id], to: 'archive' })).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => ops.flag({ threadIds: [t.id], flagged: true })).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe('routes', () => {
  const call = (hub: MailHub, method: string, path: string, body?: unknown) =>
    clock.wait(hub.route(new Request(`http://hub${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } }), new URL(`http://hub${path}`))).then(async (r) => ({ status: r!.status, body: await r!.json() }));

  test('flag, move and the setting; a clientId sent twice is made once; bad input is refused', async () => {
    const { fake, st, hub, ops } = await world({ seed });
    ops.coalesceMs = 60_000;
    const t = thread(st, '<n1@x>');
    expect(await call(hub, 'POST', '/api/mail/flag', { threadIds: [t.id], flagged: true, clientId: 'c1' })).toEqual({ status: 200, body: { ok: true, threads: 1, messages: 1 } });
    expect(await call(hub, 'POST', '/api/mail/flag', { threadIds: [t.id], flagged: true, clientId: 'c1' })).toEqual({ status: 200, body: { ok: true, threads: 1, messages: 1 } });
    expect(st.one('SELECT message_ids FROM mail_op')!.message_ids).toBe(JSON.stringify([mid('<n1@x>')]));
    expect((await call(hub, 'POST', '/api/mail/move', { threadIds: [t.id], to: 'archive' })).body).toEqual({ ok: true, threads: 1, messages: 1 });
    expect((await call(hub, 'POST', '/api/mail/move', { threadIds: ['mth_nope'], to: 'archive' })).status).toBe(404);
    expect((await call(hub, 'POST', '/api/mail/move', { threadIds: [t.id] })).status).toBe(400);
    expect((await call(hub, 'POST', '/api/mail/flag', { threadIds: [t.id], seen: 'yes' })).status).toBe(400);
    expect((await call(hub, 'POST', '/api/mail/flag', { threadIds: [t.id] })).status).toBe(400);
    expect((await call(hub, 'POST', '/api/mail/move', { threadIds: [t.id], to: 'mbx_nope' })).status).toBe(404);
    expect(await call(hub, 'GET', '/api/mail/settings')).toEqual({ status: 200, body: { markRead: 'view' } });
    expect(await call(hub, 'PUT', '/api/mail/settings', { markRead: 'manual' })).toEqual({ status: 200, body: { markRead: 'manual' } });
    expect((await call(hub, 'PUT', '/api/mail/settings', { markRead: 'never' })).status).toBe(400);
    // The thread and account views say what waits.
    const flushed = hub.flush();
    const threads = flushed.find((e) => e.t === 'mail.threads') as Extract<P.ClientEvent, { t: 'mail.threads' }>;
    expect(threads.threads.find((x) => x.id === t.id)).toMatchObject({ pending: true, flagged: true, roles: ['archive'] });
    const acc = flushed.find((e) => e.t === 'mail.account') as Extract<P.ClientEvent, { t: 'mail.account' }>;
    expect(acc.account.ops).toMatchObject({ waiting: 1 });
    expect(writes(fake)).toEqual([]);
  });

  test('an account with no Junk mailbox says so', async () => {
    clock = new FakeClock();
    const fake = new FakeMailBackend();
    fake.addAccount(ACC, { email: ME, mailboxes: [{ id: 'INBOX', name: 'Inbox', path: 'INBOX', parentId: null, role: 'inbox', unread: null, total: null }] });
    seed(fake);
    const db = new Database(':memory:', { strict: true });
    db.exec('PRAGMA foreign_keys = ON');
    const { hub, ops, st } = start(db, fake);
    await clock.wait(hub.sync(ACC)!.whenSynced());
    expect(() => ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'junk' })).toThrow(expect.objectContaining({ status: 409, message: `${ME} has no Junk mailbox` }));
  });
});

describe('ids per message (store.ts idPerMessage)', () => {
  /** An All mail, and an old message there alone. */
  const allMail = (f: FakeMailBackend) => {
    seed(f);
    f.addMailbox(ACC, { id: 'All', name: 'All mail', path: 'All', parentId: null, role: 'all', unread: null, total: null });
    f.put(ACC, { mailboxId: 'All', messageId: '<o1@x>', from: [sam], subject: 'Old one', receivedAt: T0 - 24 * H, flags: { seen: true } });
  };
  const listAll = (hub: MailHub, st: MailHub['store']) => clock.wait(hub.sync(ACC)!.backfill.more(boxOf(st, 'all')));

  for (const [what, details] of [
    ['saying nothing of it (an extractor from before it)', null],
    ['saying so', PROTON_DETAILS],
  ] as const) {
    test(`Proton ${what}: one id a message, so Move to Inbox from All mail goes by it; Proton's caps`, async () => {
      const { fake, st, ops, hub } = await world({ seed: allMail, opts: { ids: 'proton', state: 'account', events: 'all', details } });
      expect(st.account(ACC)!.id_per_message).toBe(details ? 1 : null);
      expect(st.idPerMessage(ACC)).toBe(true);
      expect(st.gmail(ACC)).toBe(false);
      expect(st.accountView(st.account(ACC)!)).toMatchObject({ sendCap: 25 * 1024 * 1024, maxRecipients: 100 });
      await listAll(hub, st);
      const id = onServer(fake, '<o1@x>').id;
      expect(ops.move({ threadIds: [thread(st, '<o1@x>').id], to: 'inbox' })).toEqual({ ok: true, threads: 1, messages: 1 });
      expect(thread(st, '<o1@x>').roles).toEqual(['inbox']);
      await clock.wait(ops.idle());
      // No thread on these summaries: null beside its id.
      expect(writes(fake).map((c) => c.input)).toEqual([{ ids: [id], threadIds: [null], mailboxId: 'INBOX' }]);
      expect(onServer(fake, '<o1@x>')).toMatchObject({ id, mailboxId: 'INBOX' });
      expect(st.all('SELECT native_id FROM mail_location WHERE message_id = ?', mid('<o1@x>'))).toEqual([{ native_id: id }]);
    });
  }

  test('an IMAP server: an id per mailbox, so All mail is never emptied from here; IMAP\'s caps', async () => {
    const { fake, st, ops, hub } = await world({ seed: allMail });
    expect(st.idPerMessage(ACC)).toBe(false);
    expect(st.accountView(st.account(ACC)!)).toMatchObject({ sendCap: 35 * 1024 * 1024, maxRecipients: 500 });
    await listAll(hub, st);
    expect(ops.move({ threadIds: [thread(st, '<o1@x>').id], to: 'inbox' })).toEqual({ ok: true, threads: 0, messages: 0 });
    await clock.wait(ops.idle());
    expect(writes(fake)).toEqual([]);
    expect(onServer(fake, '<o1@x>').mailboxId).toBe('All');
  });
});

describe('answers in part, and the writes an account lists (details.writes)', () => {
  /** Counts the account's changes passes asked for from now on (catchUp), and still makes them. */
  const countCatchUps = (hub: MailHub) => {
    const sync = hub.sync(ACC)!;
    const real = sync.catchUp.bind(sync);
    const n = { calls: 0 };
    sync.catchUp = (...a: Parameters<typeof real>) => (n.calls++, real(...a));
    return n;
  };
  const error = (st: MailHub['store']) => st.accountView(st.account(ACC)!).ops!.error?.message ?? null;

  test('threadIds go beside ids, in the same order: each message’s thread as its summary gave it', async () => {
    const { fake, st, ops } = await world({ seed, opts: { threadIds: true } });
    ops.coalesceMs = 60_000;
    ops.flag({ messageIds: [mid('<n1@x>'), mid('<a2@x>')], flagged: true });
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    const [c] = writes(fake);
    expect(c.input.ids).toHaveLength(2);
    // The fake's summaries give a message with no thread of its own its Message-ID as one.
    expect(c.input.threadIds).toEqual(c.input.ids.map((id: string) => fake.messages(ACC).find((m) => m.id === id)!.messageId));
    expect([...c.input.threadIds].sort()).toEqual(['<a2@x>', '<n1@x>']);
  });

  test('a flag batch with some refused: only those undone, the rest kept', async () => {
    const { fake, st, ops, hub, filed } = await world({ seed });
    const ups = countCatchUps(hub);
    ops.coalesceMs = 60_000;
    ops.flag({ messageIds: [mid('<a2@x>'), mid('<n1@x>')], seen: true });
    fake.refuse(ACC, [onServer(fake, '<a2@x>').id], 'refused');
    filed.length = 0;
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    expect(writes(fake).map((c) => c.input.ids.length)).toEqual([2]);
    // Sam's reply: back to unread, as the server has it; the newsletter stays read.
    expect(msg(st, '<a2@x>')).toMatchObject({ seen: 0, pending: null });
    expect(msg(st, '<n1@x>')).toMatchObject({ seen: 1, pending: null });
    expect(thread(st, '<a1@x>').unread).toBe(1);
    expect(thread(st, '<n1@x>')).toMatchObject({ unread: 0, pending: false });
    expect(onServer(fake, '<n1@x>').flags.seen).toBe(true);
    expect(filed).toEqual([{ accountId: ACC, threadIds: [thread(st, '<a1@x>').id], action: 'read', undone: true }]);
    expect(error(st)).toBe('Could not mark a message read: the server turned it down');
    expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_op')!.n).toBe(0);
    // Refused is not lost: no changes pass for it.
    expect(ups.calls).toBe(0);
  });

  /** Sam's first message and the newsletter archived in one call, the first answered as `how`. */
  async function archiveTwo(how: 'refused' | 'unknown' | null, moveIds: 'new' | 'null') {
    const w = await world({ seed, opts: { moveIds } });
    const ups = countCatchUps(w.hub);
    w.ops.coalesceMs = 60_000;
    w.ops.move({ messageIds: [mid('<a1@x>'), mid('<n1@x>')], to: 'archive' });
    if (how) w.fake.refuse(ACC, [onServer(w.fake, '<a1@x>').id], how);
    w.filed.length = 0;
    w.st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(w.ops.idle());
    expect(writes(w.fake).map((c) => c.input.ids.length)).toEqual([2]);
    return { ...w, ups };
  }
  const inInbox = (st: MailHub['store'], hdr: string) => st.all<{ mailbox_id: string }>('SELECT mailbox_id FROM mail_location WHERE message_id = ?', mid(hdr)).map((l) => l.mailbox_id).includes(boxOf(st, 'inbox'));

  test('a move: null and refused is undone, with no changes pass', async () => {
    const { st, fake, ups, filed } = await archiveTwo('refused', 'new');
    expect(onServer(fake, '<a1@x>').mailboxId).toBe('INBOX');
    expect(msg(st, '<a1@x>').pending).toBeNull();
    expect(inInbox(st, '<a1@x>')).toBe(true);
    expect(thread(st, '<a1@x>').roles).toContain('inbox');
    expect(filed).toEqual([{ accountId: ACC, threadIds: [thread(st, '<a1@x>').id], action: 'archive', undone: true }]);
    expect(error(st)).toBe('Could not archive a message: the server turned it down');
    // The newsletter moved, to the id the answer gave.
    expect(st.all('SELECT native_id FROM mail_location WHERE message_id = ?', mid('<n1@x>'))).toEqual([{ native_id: onServer(fake, '<n1@x>').id }]);
    expect(thread(st, '<n1@x>').roles).toEqual(['archive']);
    expect(ups.calls).toBe(0);
  });

  test('a move: null and unknown is undone, and a changes pass looks for it', async () => {
    const { st, ups, filed } = await archiveTwo('unknown', 'new');
    expect(msg(st, '<a1@x>').pending).toBeNull();
    expect(inInbox(st, '<a1@x>')).toBe(true);
    expect(filed.filter((f) => f.undone)).toHaveLength(1);
    expect(error(st)).toBe('Could not archive a message: the server could not find it');
    expect(thread(st, '<n1@x>').roles).toEqual(['archive']);
    expect(ups.calls).toBe(1);
  });

  test('a move: null and not listed moved (the server would not say where): kept, and a changes pass finds it', async () => {
    const { st, fake, ups, filed } = await archiveTwo(null, 'null');
    expect(filed.filter((f) => f.undone)).toEqual([]);
    expect(error(st)).toBeNull();
    for (const h of ['<a1@x>', '<n1@x>']) {
      expect(msg(st, h).pending).toBeNull();
      expect(onServer(fake, h).mailboxId).toBe('Archive');
    }
    expect(ups.calls).toBe(1);
    await until(() => !inInbox(st, '<n1@x>') && !inInbox(st, '<a1@x>'), 2000, 'the changes pass');
    expect(thread(st, '<n1@x>').roles).toEqual(['archive']);
  });

  test('a status listing a kind clears its 501; one not listed is refused at once, with no call', async () => {
    const { fake, st, ops, filed } = await world({ seed, opts: { ids: 'proton' } });
    fake.fail('mail.flag', new MailCallError('cannot star from here', 501));
    ops.flag({ messageIds: [mid('<n1@x>')], flagged: true });
    await clock.wait(ops.idle());
    expect(st.accountView(st.account(ACC)!).ops!.unsupported).toEqual(['flag.flagged']);
    expect(st.accountView(st.account(ACC)!).writes).toBeUndefined();

    // Gmail's stage: it reads, stars and marks read, and files nothing yet.
    fake.setOpts(ACC, { details: { ...PROTON_DETAILS, provider: 'Gmail', writes: ['seen', 'flagged'] } });
    fake.setOnline(ACC, true);
    await until(() => st.accountView(st.account(ACC)!).writes?.length === 2, 2000, 'the status');
    expect(st.accountView(st.account(ACC)!)).toMatchObject({ writes: ['seen', 'flagged'], ops: { unsupported: [] } });
    const calls = writes(fake).length;
    filed.length = 0;
    const t = thread(st, '<a1@x>');
    for (const [to, why] of [
      ['archive', "Gmail can't archive from here yet"],
      ['trash', "Gmail can't move mail to the trash from here yet"],
      ['junk', "Gmail can't mark mail as junk from here yet"],
      [boxOf(st, 'archive'), "Gmail can't move mail into folders or labels from here yet"],
    ]) {
      expect(() => ops.move({ threadIds: [t.id], to })).toThrow(expect.objectContaining({ status: 501, message: why }));
    }
    expect(thread(st, '<a1@x>').roles).toContain('inbox');
    expect(filed).toEqual([]);
    // Starring is listed: it goes.
    ops.flag({ messageIds: [mid('<n1@x>')], flagged: true });
    await clock.wait(ops.idle());
    expect(writes(fake).length).toBe(calls + 1);
    expect(onServer(fake, '<n1@x>').flags.flagged).toBe(true);
    // A status listing less: a star waiting for the server is undone without a call.
    ops.coalesceMs = 60_000;
    ops.flag({ messageIds: [mid('<n1@x>')], flagged: false });
    fake.setOpts(ACC, { details: { ...PROTON_DETAILS, provider: 'Gmail', writes: ['seen'] } });
    fake.setOnline(ACC, true);
    await until(() => st.accountView(st.account(ACC)!).writes?.length === 1, 2000, 'the status');
    st.db.query('UPDATE mail_op SET next_at = 0').run();
    await clock.wait(ops.idle());
    expect(writes(fake).length).toBe(calls + 1);
    expect(msg(st, '<n1@x>')).toMatchObject({ flagged: 1, pending: null });
    expect(error(st)).toBe("Could not unstar a message: Gmail can't star mail from here yet");
    expect(() => ops.flag({ messageIds: [mid('<n1@x>')], flagged: false })).toThrow(expect.objectContaining({ status: 501 }));
  });

  test('read in view sends no seen write when the status leaves seen out: read here only', async () => {
    const { fake, st, ops, hub } = await world({ seed, opts: { details: { writes: ['flagged', 'move', 'trash', 'junk'] } } });
    hub.readHere([thread(st, '<a1@x>').id]);
    await clock.wait(ops.idle());
    expect(thread(st, '<a1@x>').unread).toBe(0);
    expect(msg(st, '<a2@x>')).toMatchObject({ seen: 0, seen_local: 1, pending: null });
    expect(writes(fake)).toEqual([]);
    expect(onServer(fake, '<a2@x>').flags.seen).toBe(false);
  });

  test('a 501 to a move into the trash is kept as trash: archiving still goes', async () => {
    const { fake, st, ops } = await world({ seed });
    fake.fail('mail.move', new MailCallError('no trash here', 501));
    ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'trash' });
    await clock.wait(ops.idle());
    expect(st.accountView(st.account(ACC)!).ops!.unsupported).toEqual(['trash']);
    expect(() => ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'trash' })).toThrow(expect.objectContaining({ status: 501, message: 'no trash here' }));
    ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'archive' });
    await clock.wait(ops.idle());
    expect(onServer(fake, '<n1@x>').mailboxId).toBe('Archive');
  });

  test('an older `move` row still refuses the trash and junk while the status lists no writes', async () => {
    const { st, ops } = await world({ seed });
    st.db.query(`INSERT INTO mail_unsupported (account_id, op, why, at) VALUES (?, 'move', 'no moves here', 0)`).run(ACC);
    for (const to of ['archive', 'trash', 'junk']) expect(() => ops.move({ threadIds: [thread(st, '<n1@x>').id], to })).toThrow(expect.objectContaining({ status: 501, message: 'no moves here' }));
  });

  for (const ids of ['imap', 'proton'] as const) {
    test(`${ids}: no writes in its status, its {} answers stand, nothing undone`, async () => {
      const { fake, st, ops, hub, filed } = await world({ seed, opts: { ids } });
      const ups = countCatchUps(hub);
      expect(st.account(ACC)!.writes).toBeNull();
      expect(st.accountView(st.account(ACC)!).writes).toBeUndefined();
      ops.flag({ messageIds: [mid('<n1@x>')], flagged: true });
      ops.move({ threadIds: [thread(st, '<a1@x>').id], to: 'archive' });
      ops.move({ threadIds: [thread(st, '<n1@x>').id], to: 'junk' });
      await clock.wait(ops.idle());
      expect(writes(fake).map((c) => c.op)).toEqual(['mail.flag', 'mail.move', 'mail.move']);
      expect(filed.filter((f) => f.undone)).toEqual([]);
      expect(error(st)).toBeNull();
      expect(onServer(fake, '<n1@x>')).toMatchObject({ mailboxId: 'Junk', flags: expect.objectContaining({ flagged: true }) });
      expect(st.one<{ n: number }>('SELECT COUNT(*) AS n FROM mail_message WHERE pending IS NOT NULL')!.n).toBe(0);
      expect(ups.calls).toBe(0);
    });
  }
});
