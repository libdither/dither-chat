/**
 * Accounts whose summaries carry no headers (mail/headerless.ts, docs/mail.md "Summaries without headers"), on a
 * Proton-like FakeMailBackend: the list headers mail.get gives reach a message's class; which accounts count as
 * header-less (the status says, else what summaries carried); the one-time listing again for Proton's categories and
 * the one-time fetch again of bodies kept before; and bodies fetched ahead for what is still from a stranger in the
 * one-list inbox's window.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailId } from '@dither-chat/protocol/ids';
import { mailAttention } from '../src/mail/attention.ts';
import { bigOf } from '../src/mail/backfill.ts';
import { FakeMailBackend, type FakeInput, type FakeOpts } from '../src/mail/fake.ts';
import { relabeled, settled } from '../src/mail/headerless.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailPeople } from '../src/mail/people.ts';
import { Store } from '../src/store.ts';

const ACC = 'acc_headerless1';
const ME = { name: 'Me', email: 'me@example.com' };
const THEO = { name: 'Theo', email: 'theo@example.net' };
const NEWS = { name: 'Rust Weekly', email: 'editor@rust-weekly.example' };
const SHOP = { name: 'Shop', email: 'orders@shop.example' };
const DAY = 86_400_000;
const PROTON: FakeOpts = { ids: 'proton', threadIds: true, refs: false, state: 'account', events: 'all' };
const UNSUB = { listId: null, unsubscribe: '<https://rust-weekly.example/leave>', precedence: null, autoSubmitted: null };

const until = async (f: () => unknown, ms = 4000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
});

const mid = (messageId: string, acc = ACC) => mailId('mml', acc, `m:${messageId}`);

/** A database, and a hub on it (a second hub on the same database is the hub starting again). */
function place() {
  const dir = mkdtempSync(join(tmpdir(), 'dither-mail-headerless-'));
  const chat = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  cleanups.push(() => {
    chat.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async (fake: FakeMailBackend) => {
    const hub = new MailHub({ db: chat.db, backend: fake, log: () => {} });
    mailPeople(hub)!.connect(chat);
    hub.start();
    for (const a of fake.accountsList()) await hub.sync(a.id)!.whenSynced();
    await Bun.sleep(20);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      mailPeople(hub)?.stop();
      hub.stop();
    };
    cleanups.push(stop);
    return { hub, stop };
  };
  return { chat, start };
}

function server(opts: FakeOpts = PROTON, seed: FakeInput[] = []) {
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME.email, name: ME.name, opts });
  for (const i of seed) fake.put(ACC, i);
  return fake;
}

const cls = (hub: MailHub, messageId: string) => hub.store.one<{ class: string; class_why: string; bulk: string | null }>('SELECT class, class_why, bulk FROM mail_message WHERE id = ?', mid(messageId));
const threadOf = (hub: MailHub, messageId: string) => hub.store.one<{ thread_id: string }>('SELECT thread_id FROM mail_message WHERE id = ?', mid(messageId))!.thread_id;
const gets = (fake: FakeMailBackend) => fake.calls.filter((c) => c.op === 'mail.get').map((c) => String(c.input.id));
const lists = (fake: FakeMailBackend) => fake.calls.filter((c) => c.op === 'mail.list').length;

describe('headers from bodies', () => {
  test('a newsletter whose summary had no headers leaves the inbox once its body says List-Unsubscribe; a person’s mail stays', async () => {
    const at = Date.now() - 2 * DAY;
    const fake = server(PROTON, [
      { messageId: '<news-1@x>', from: [NEWS], to: [ME], subject: 'Issue 600', text: 'This week in Rust.', bulk: UNSUB, receivedAt: at },
      { messageId: '<theo-1@x>', from: [THEO], to: [ME], subject: 'Climbing on Sunday?', text: 'Gym at 10?', receivedAt: at + 1000 },
    ]);
    const { hub } = await place().start(fake);
    const candidates = () => mailAttention(hub)!.candidates(Date.now());
    // The summaries said nothing: both look like a stranger's mail, and both could be listed.
    expect(cls(hub, '<news-1@x>')).toMatchObject({ class: 'personal', class_why: 'unknown', bulk: null });
    expect(candidates()).toContain(threadOf(hub, '<news-1@x>'));
    await hub.body(mid('<news-1@x>'));
    await hub.body(mid('<theo-1@x>'));
    expect(cls(hub, '<news-1@x>')).toMatchObject({ class: 'bulk', class_why: 'list' });
    expect(JSON.parse(cls(hub, '<news-1@x>')!.bulk!)).toEqual(UNSUB);
    expect(hub.store.thread(threadOf(hub, '<news-1@x>'))!.class).toBe('bulk');
    expect(candidates()).not.toContain(threadOf(hub, '<news-1@x>'));
    expect(hub.store.listThreads('v:updates:*', null, 50)!.threads.map((t) => t.subject)).toEqual(['Issue 600']);
    // No list headers in the body: still from a person.
    expect(cls(hub, '<theo-1@x>')).toMatchObject({ class: 'personal', class_why: 'unknown', bulk: null });
    expect(candidates()).toContain(threadOf(hub, '<theo-1@x>'));
  });
});

describe('which accounts', () => {
  test('the status says (details.summaryHeaders); without it, whether any summary has carried headers', async () => {
    const fake = new FakeMailBackend();
    fake.addAccount('acc_hlProton', { email: 'p@example.com', opts: PROTON });
    fake.addAccount('acc_hlImap', { email: 'i@example.com' });
    fake.addAccount('acc_hlOldImap', { email: 'o@example.com', opts: { summaryHeaders: null } });
    fake.addAccount('acc_hlOldProton', { email: 'q@example.com', opts: { ...PROTON, summaryHeaders: null } });
    fake.put('acc_hlOldImap', { messageId: '<a@x>', from: [THEO], to: [{ name: null, email: 'o@example.com' }], subject: 'Hi' });
    fake.put('acc_hlOldProton', { messageId: '<b@x>', from: [THEO], to: [{ name: null, email: 'q@example.com' }], subject: 'Hi', inReplyTo: '<zero@x>' });
    const { hub } = await place().start(fake);
    const st = hub.store;
    expect(st.headerless('acc_hlProton')).toBe(true);
    expect(st.headerless('acc_hlImap')).toBe(false);
    // An extractor from before the detail: no summary of it has had a header yet.
    expect(st.headerless('acc_hlOldImap')).toBe(true);
    expect(st.headerless('acc_hlOldProton')).toBe(true);
    // One summary with In-Reply-To says it has them.
    fake.deliver('acc_hlOldImap', { messageId: '<c@x>', from: [THEO], to: [{ name: null, email: 'o@example.com' }], subject: 'Re: Hi', inReplyTo: '<a@x>', references: ['<a@x>'] });
    await until(() => !st.headerless('acc_hlOldImap'), 2000, 'headers seen');
    // What the status says wins.
    fake.setStatus('acc_hlProton', { status: 'online', attention: null, details: { summaryHeaders: true } });
    expect(st.headerless('acc_hlProton')).toBe(false);
  });
});

describe('once, on the start after this', () => {
  test('mail stored before the labels is listed again for them; bodies kept before are fetched again; then the window’s strangers’ bodies come', async () => {
    const at = Date.now() - 3 * DAY;
    const fake = server(PROTON, [
      { messageId: '<news-1@x>', from: [NEWS], to: [ME], subject: 'Issue 600', receivedAt: at },
      { messageId: '<order-1@x>', from: [SHOP], to: [ME], subject: 'Your order', receivedAt: at + 1000 },
      { messageId: '<list-1@x>', from: [{ name: 'Club', email: 'chair@club.example' }], to: [ME], subject: 'AGM', text: 'Minutes attached.', receivedAt: at + 2000 },
      { messageId: '<theo-1@x>', from: [THEO], to: [ME], subject: 'Climbing on Sunday?', text: 'Gym at 10?', receivedAt: at + 3000 },
      { messageId: '<theo-old@x>', from: [THEO], to: [ME], subject: 'Last spring', receivedAt: Date.now() - 60 * DAY },
      { messageId: '<arch-1@x>', mailboxId: 'Archive', from: [{ name: 'Deals', email: 'hello@deals.example' }], to: [ME], subject: 'Sale', receivedAt: at },
    ]);
    const p = place();
    // The hub before this fix: mail without Proton's labels, one body kept without its list headers.
    const first = await p.start(fake);
    await first.hub.body(mid('<list-1@x>'));
    first.stop();
    p.chat.db.exec(`DELETE FROM mail_setting WHERE key LIKE 'relabeled:%' OR key LIKE 'rebodied:%'`);
    p.chat.db.query('UPDATE mail_message SET bulk = NULL WHERE id = ?').run(mid('<list-1@x>'));
    const label = (messageId: string, l: string) => (fake.messages(ACC).find((m) => m.messageId === messageId)!.labels = [l]);
    label('<news-1@x>', 'Category/Newsletters');
    label('<order-1@x>', 'Category/Transactions');
    label('<arch-1@x>', 'Category/Promotions');
    fake.messages(ACC).find((m) => m.messageId === '<list-1@x>')!.bulk = { listId: '<club.example>', unsubscribe: null, precedence: 'list', autoSubmitted: null };

    fake.calls.length = 0;
    const { hub, stop } = await p.start(fake);
    expect(relabeled(hub.store, ACC)).toBe(false);
    expect(cls(hub, '<news-1@x>')!.class_why).toBe('unknown');
    await bigOf(hub)!.headerless.run(ACC);
    expect(settled(hub.store, ACC)).toBe(true);
    // Inbox, then Archive: listed again, the labels in.
    expect(lists(fake)).toBe(2);
    expect(cls(hub, '<news-1@x>')).toMatchObject({ class: 'bulk', class_why: 'category' });
    expect(cls(hub, '<order-1@x>')).toMatchObject({ class: 'bulk', class_why: 'category' });
    expect(cls(hub, '<arch-1@x>')).toMatchObject({ class: 'bulk', class_why: 'category' });
    // The body kept before: fetched again, its list headers read.
    expect(cls(hub, '<list-1@x>')).toMatchObject({ class: 'bulk', class_why: 'list' });
    // Then what is still a stranger's in the window comes ahead; nothing a label settled, nothing older than the window.
    await until(() => gets(fake).length >= 2, 3000, 'the window’s bodies');
    await Bun.sleep(50);
    const ids = new Map(fake.messages(ACC).map((m) => [m.id, m.messageId]));
    expect(gets(fake).map((id) => ids.get(id)).sort()).toEqual(['<list-1@x>', '<theo-1@x>']);
    expect(cls(hub, '<theo-1@x>')).toMatchObject({ class: 'personal', class_why: 'unknown' });
    stop();

    // Once: the next start lists nothing again.
    fake.calls.length = 0;
    const again = await p.start(fake);
    await bigOf(again.hub)!.headerless.run(ACC);
    expect(lists(fake)).toBe(0);
    expect(gets(fake)).toEqual([]);
  });

  test('an account added after this lists its mail with the labels already: nothing to do again', async () => {
    const fake = server(PROTON, [{ messageId: '<news-1@x>', from: [NEWS], to: [ME], subject: 'Issue 600', labels: ['Category/Newsletters'], receivedAt: Date.now() - DAY }]);
    const { hub } = await place().start(fake);
    expect(cls(hub, '<news-1@x>')).toMatchObject({ class: 'bulk', class_why: 'category' });
    expect(settled(hub.store, ACC)).toBe(true);
    const n = lists(fake);
    await bigOf(hub)!.headerless.run(ACC);
    expect(lists(fake)).toBe(n);
  });

  test('an account whose summaries carry headers: none of this', async () => {
    const fake = server({}, [{ messageId: '<theo-1@x>', from: [THEO], to: [ME], subject: 'Hi', receivedAt: Date.now() - 20 * DAY }]);
    const p = place();
    const first = await p.start(fake);
    first.stop();
    p.chat.db.exec(`DELETE FROM mail_setting WHERE key LIKE 'relabeled:%' OR key LIKE 'rebodied:%'`);
    fake.calls.length = 0;
    const { hub } = await p.start(fake);
    expect(settled(hub.store, ACC)).toBe(true);
    await bigOf(hub)!.headerless.run(ACC);
    expect(lists(fake)).toBe(0);
    // Twenty days old: outside bodies.ts's fourteen, and not fetched for the window either.
    expect(bigOf(hub) && gets(fake)).toEqual([]);
  });
});
