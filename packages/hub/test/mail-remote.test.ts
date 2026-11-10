/**
 * Mail through a real dither-accounts manager (docs/mail.md, docs/mail-design.md §12.2): a throwaway manager on a temp
 * directory with one `imap` account against that repo's test servers (extractors/imap/test/servers.ts: Dovecot 2.4
 * and an SMTP sink on 127.0.0.1), and this hub's RoutedSupervisor and MailHub on it. The hub asks for mail like any
 * app, the test approves it over the manager's API, then checks the first sync, keeping up through IDLE, flags and a
 * move made by another mail client, and a relist after a UIDVALIDITY change. Sending (slice 5): a reply through the
 * SMTP sink, threaded, and a message to yourself that comes back through IDLE.
 *
 * Dovecot and the SMTP sink are told ports the OS picked (fixtures/port.ts); the manager listens on port 0. Needs a
 * dither-accounts checkout beside this repo (or DITHER_ACCOUNTS_REPO) and Dovecot (DOVECOT_BIN, or the store path
 * dither-accounts' tests remember); skipped without them, so a plain `bun test` stays fast. Nothing in the checkout is
 * written.
 */
import { afterAll, beforeAll, describe as describeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mailId } from '@dither-chat/protocol/ids';
import { ManagerMailBackend } from '../src/mail/backend.ts';
import { MailHub } from '../src/mail/index.ts';
import { mailOps } from '../src/mail/ops.ts';
import { RoutedSupervisor } from '../src/remote.ts';
import { Store } from '../src/store.ts';
import { freePorts } from './fixtures/port.ts';

const ACCOUNTS = process.env.DITHER_ACCOUNTS_REPO ?? resolve(import.meta.dir, '../../../../dither-accounts');
const IMAP_KIT = join(ACCOUNTS, 'extractors/imap/test/servers.ts');

/** Dovecot without building it: DOVECOT_BIN, or the binary dither-accounts' imap tests found before. */
function dovecot(): string | null {
  if (process.env.DOVECOT_BIN && existsSync(process.env.DOVECOT_BIN)) return process.env.DOVECOT_BIN;
  try {
    const p = readFileSync(join(tmpdir(), 'dacc-imap-dovecot-bin'), 'utf8').trim();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const DOVECOT = dovecot();
const have = existsSync(join(ACCOUNTS, 'packages/manager/src/index.ts')) && existsSync(IMAP_KIT) && !!DOVECOT;
const describe = describeAll.skipIf(!have);
const REPO = resolve(import.meta.dir, '../../..');

let IMAP_PORT = 0;
let SMTP_PORT = 0;

const alice = { email: 'alice@example.test', password: 'alice-mail-pw' };

const until = async (f: () => unknown, ms = 15_000, what = 'condition') => {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      if (await f()) return;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ''}`);
};

let kit: any;
let m: any;
let dv: any;
let sink: any;
let dir: string;
let store: Store;
let sup: RoutedSupervisor;
let hub: MailHub;
let acc: string;

const other = async <T>(f: (c: any) => Promise<T>): Promise<T> => {
  const c = await dv.client(alice);
  try {
    return await f(c);
  } finally {
    await c.logout().catch(() => c.close());
  }
};
const count = (sql: string, ...args: any[]) => hub.store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM (${sql})`, ...args)!.n;
const byHdr = (hdr: string) => hub.store.one('SELECT * FROM mail_message WHERE id = ?', mailId('mml', acc, `m:${hdr}`));

beforeAll(async () => {
  if (!have) return;
  process.env.DOVECOT_BIN = DOVECOT!;
  process.env.DITHER_ACCOUNTS_CLIENT ??= join(ACCOUNTS, 'packages/client/src/index.ts');
  dir = mkdtempSync(join(tmpdir(), 'dither-mail-remote-'));
  [IMAP_PORT, SMTP_PORT] = freePorts(2);
  kit = await import(IMAP_KIT);
  dv = new kit.Dovecot({ imapPort: IMAP_PORT, users: [alice] }, join(dir, 'dovecot'));
  await dv.start();
  sink = new kit.SmtpSink(SMTP_PORT, [alice], dv, dv.cert);
  await sink.start();
  await other(async (c) => {
    await c.append('INBOX', kit.rfc822({ subject: 'Dinner on Friday?', text: 'Free after 7?', messageId: '<dinner-1@example.test>', from: 'Sam <sam@example.test>', to: `Alice <${alice.email}>` }));
    await c.append('INBOX', kit.rfc822({ subject: 'Re: Dinner on Friday?', text: 'Booked for 7:30.\n\nOn Thu, Alice wrote:\n> Yes', messageId: '<dinner-3@example.test>', inReplyTo: '<dinner-1@example.test>', references: '<dinner-1@example.test>', from: 'Sam <sam@example.test>', to: `Alice <${alice.email}>` }));
    await c.append('INBOX', kit.rfc822({ subject: 'This week', text: 'news', messageId: '<news-1@example.test>', headers: { 'List-Id': '<weekly.example.test>', 'List-Unsubscribe': '<https://example.test/u>' } }));
    await c.append('INBOX', kit.rfc822({ subject: 'Only HTML', html: '<p>Your parcel <b>shipped</b>.</p><script>alert(1)</script>', messageId: '<html-1@example.test>' }));
  });

  const { createManager } = await import(join(ACCOUNTS, 'packages/manager/src/index.ts'));
  mkdirSync(join(dir, 'manager'), { recursive: true });
  m = await createManager({ dataDir: join(dir, 'manager'), port: 0 });

  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  sup = new RoutedSupervisor(store, { hubAdapterUrl: 'ws://127.0.0.1:1/adapter', dataDir: dir, repoRoot: REPO, onFresh: () => {} } as any, { url: m.url, dataDir: dir, repoRoot: REPO, firstListMs: 2000 });
  const backend = new ManagerMailBackend({ callRaw: (a, op, input, t) => sup.callMail(a, op, input, t), askMailAgain: () => sup.askMailAgain() });
  sup.mail = backend;
  hub = new MailHub({ db: store.db, backend, managerUrl: m.url, log: () => {} });
  hub.start();
  await sup.connect();
  expect(hub.access().state).toBe('pending');

  // Approved as you would on the manager's page.
  const st = await (await fetch(`${m.url}/api/state`)).json();
  for (const app of st.apps) for (const r of app.requests) if (r.state === 'pending') await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });

  // The account, added on the manager's page (§14 Q5: never from the hub).
  const res = await fetch(`${m.url}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'imap',
      label: 'Alice',
      config: { email: alice.email, provider: 'custom', name: 'Alice', imapHost: '127.0.0.1', imapPort: String(IMAP_PORT), imapSecurity: 'starttls', smtpHost: '127.0.0.1', smtpPort: String(SMTP_PORT), smtpSecurity: 'starttls', certificate: 'pin' },
      secret: { password: alice.password },
    }),
  });
  const added = (await res.json()) as { id: string; error?: string };
  if (!res.ok) throw new Error(`adding the account: ${added.error}`);
  acc = added.id;
}, 120_000);

afterAll(async () => {
  if (!have) return;
  hub?.stop();
  await sup?.stopAll();
  await m?.stop();
  await sink?.stop();
  await dv?.cleanup();
  store?.db.close();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe('mail through dither-accounts', () => {
  test('the grant: asked for, approved, and the account shows with its addresses', async () => {
    await until(() => hub.access().state === 'granted', 70_000, 'the grant seen');
    // Online comes with the account list; who it is comes with the extractor's status, a moment later.
    await until(() => hub.store.account(acc)?.online && hub.store.account(acc)?.address, 40_000, 'the account online, with its address');
    const v = hub.store.accountView(hub.store.account(acc)!);
    expect(v).toMatchObject({ kind: 'imap', level: 'write', address: alice.email, online: true });
    await until(() => hub.store.accountView(hub.store.account(acc)!).send.ok === true, 20_000, 'canSend');
    expect(v.managedUrl).toBe(`${m.url}/#/accounts/${encodeURIComponent(acc)}`);
  }, 120_000);

  test('the first sync: Inbox, threaded from the summaries’ headers; list headers kept', async () => {
    await until(() => hub.store.account(acc)?.synced_at, 40_000, 'the first sync');
    expect(count('SELECT 1 FROM mail_message')).toBe(4);
    // Listed newest first, the reply came before its parent; the parent joined it by its own Message-ID.
    expect(byHdr('<dinner-3@example.test>')!.thread_id).toBe(byHdr('<dinner-1@example.test>')!.thread_id);
    expect(byHdr('<dinner-1@example.test>')!.thread_by).toBe('ref');
    expect(JSON.parse(byHdr('<news-1@example.test>')!.bulk)).toMatchObject({ listId: '<weekly.example.test>' });
    expect(hub.store.followed(acc).map((b) => b.role)).toEqual(['inbox', 'sent', 'archive']);
  }, 60_000);

  test('a body through mail.get; an HTML-only message shows its text; read here only leaves the server’s \\Seen alone', async () => {
    const html = await hub.body(byHdr('<html-1@example.test>')!.id);
    expect(html.text).toContain('Your parcel shipped');
    expect(html.text).not.toContain('alert');
    const reply = await hub.body(byHdr('<dinner-3@example.test>')!.id);
    expect(reply.text!.slice(0, reply.quoteAt!)).toBe('Booked for 7:30.\n\n');
    // "Only when I mark it" (slice 4): read in view stays here.
    mailOps(hub).setSettings({ markRead: 'manual' });
    hub.readHere([byHdr('<dinner-1@example.test>')!.thread_id]);
    const flags = await other(async (c) => {
      await c.mailboxOpen('INBOX');
      const out: string[][] = [];
      for await (const msg of c.fetch('1:*', { flags: true, envelope: true })) out.push([msg.envelope.messageId, [...msg.flags].join(' ')]);
      return out;
    });
    expect(flags.find(([id]) => id === '<dinner-1@example.test>')![1]).not.toContain('\\Seen');
  }, 60_000);

  test('keeping up through IDLE: a new message arrives by itself', async () => {
    await other((c) => c.append('INBOX', kit.rfc822({ subject: 'Live one', text: 'hello', messageId: '<live-1@example.test>' })));
    await until(() => byHdr('<live-1@example.test>'), 20_000, 'the live message');
  }, 40_000);

  test('flags set by another client reach the hub', async () => {
    await other(async (c) => {
      await c.mailboxOpen('INBOX');
      await c.messageFlagsAdd({ header: { 'message-id': '<news-1@example.test>' } }, ['\\Seen', '\\Flagged']);
    });
    await until(() => byHdr('<news-1@example.test>')?.seen === 1 && byHdr('<news-1@example.test>')?.flagged === 1, 20_000, 'the flags');
  }, 40_000);

  test('a move by another client: a new UID in Archive, the same hub message', async () => {
    const before = byHdr('<live-1@example.test>')!;
    await other(async (c) => {
      await c.mailboxOpen('INBOX');
      await c.messageMove({ header: { 'message-id': '<live-1@example.test>' } }, 'Archive');
    });
    const archive = hub.store.followed(acc).find((b) => b.role === 'archive')!;
    await until(() => hub.store.one('SELECT 1 FROM mail_location WHERE mailbox_id = ? AND message_id = ?', archive.id, before.id), 30_000, 'the Archive location');
    const after = byHdr('<live-1@example.test>')!;
    expect(after.id).toBe(before.id);
    expect(after.thread_id).toBe(before.thread_id);
    expect(count('SELECT 1 FROM mail_location WHERE message_id = ?', before.id)).toBe(1);
  }, 60_000);

  test('a new UIDVALIDITY: the state answers 410, Archive is listed again, and what is gone goes', async () => {
    await other(async (c) => {
      await c.mailboxDelete('Archive');
      await Bun.sleep(1100);
      await c.mailboxCreate('Archive');
      await c.append('Archive', kit.rfc822({ subject: 'Archived again', text: 'a', messageId: '<again@example.test>' }));
    });
    // Archive is not watched by IDLE: pull to refresh asks now.
    await until(async () => {
      await hub.refresh(acc);
      return byHdr('<again@example.test>');
    }, 30_000, 'the relisted Archive');
    await until(() => !byHdr('<live-1@example.test>'), 20_000, 'the message the rebuild dropped');
    expect(hub.sync(acc)!.phase).toBe('idle');
  }, 60_000);
});

describe('sending through dither-accounts (slice 5)', () => {
  /** Sends a composed message and waits for the outbox to say it went (10 s held first). */
  const sendIt = async (req: Parameters<MailHub['outbox']['accept']>[0]) => {
    const { outboxId } = await hub.outbox.accept(req);
    expect(hub.outbox.item(outboxId)!.state).toBe('held');
    await until(() => hub.outbox.item(outboxId)?.state === 'sent' || hub.outbox.item(outboxId)?.state === 'failed', 60_000, 'the send');
    const v = hub.outbox.item(outboxId)!;
    expect([v.state, v.error]).toEqual(['sent', null]);
    return v;
  };
  const header = (raw: string, name: string) => raw.match(new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, 'mi'))?.[1].replace(/\r?\n[ \t]+/g, ' ').trim() ?? null;

  test('a reply reaches the SMTP sink with its quote and In-Reply-To, and its copy in Sent joins the thread', async () => {
    await until(() => hub.store.account(acc)?.synced_at, 40_000, 'the first sync');
    await until(() => hub.store.accountView(hub.store.account(acc)!).send.ok === true, 20_000, 'canSend');
    const original = byHdr('<dinner-3@example.test>')!;
    const start = await hub.outbox.compose('reply', original.id, null, 'UTC');
    expect(start.draft).toMatchObject({ to: [{ name: 'Sam', email: 'sam@example.test' }], subject: 'Re: Dinner on Friday?', from: alice.email });
    const before = sink.received.length;
    const v = await sendIt({ ...start.draft, clientId: `remote-reply-${Date.now()}`, draftKey: start.draftKey, text: 'See you at 7:30.', tz: 'UTC' });
    await until(() => sink.received.length > before, 20_000, 'the sink');
    const got = sink.received[sink.received.length - 1];
    const raw = got.raw.toString('utf8');
    expect(got.to).toEqual(['sam@example.test']);
    expect(got.from).toBe(alice.email);
    expect(header(raw, 'Subject')).toBe('Re: Dinner on Friday?');
    expect(header(raw, 'In-Reply-To')).toBe('<dinner-3@example.test>');
    expect(header(raw, 'References')).toContain('<dinner-1@example.test>');
    expect(header(raw, 'Message-ID')).toBe(v.sentMessageId!);
    expect(raw).toContain('See you at 7:30.');
    expect(raw).toMatch(/On .+, Sam <sam@example\.test> wrote:/);
    expect(raw).toContain('> Booked for 7:30.');
    // Sent's copy comes back (the outbox asks what changed), threaded by its In-Reply-To.
    await until(() => byHdr(v.sentMessageId!), 30_000, 'the copy in Sent');
    const mine = byHdr(v.sentMessageId!)!;
    expect(mine.thread_id).toBe(original.thread_id);
    expect(mine.addressed).toBe('self');
    // The extractor marked the original answered; the hub hears it.
    await until(async () => {
      await hub.refresh(acc);
      return byHdr('<dinner-3@example.test>')?.answered === 1;
    }, 30_000, 'the original answered');
  }, 120_000);

  test('a message to yourself goes out and comes back into the Inbox through IDLE', async () => {
    const start = await hub.outbox.compose('new', null, acc);
    const v = await sendIt({ ...start.draft, clientId: `remote-self-${Date.now()}`, draftKey: start.draftKey, to: [{ name: 'Alice', email: alice.email }], subject: 'Note to self', text: 'Buy milk.' });
    await until(() => byHdr(v.sentMessageId!) && count('SELECT 1 FROM mail_location l JOIN mailbox b ON b.id = l.mailbox_id WHERE l.message_id = ? AND b.role = ?', byHdr(v.sentMessageId!)!.id, 'inbox') === 1, 30_000, 'it in the Inbox');
    expect(byHdr(v.sentMessageId!)!.subject).toBe('Note to self');
    // A From that is not the account's is refused before it is held.
    const e = await hub.outbox.accept({ ...start.draft, clientId: `remote-from-${Date.now()}`, draftKey: null, from: 'mallory@example.test', to: [{ name: null, email: alice.email }], subject: 'x', text: 'x' }).catch((x) => x);
    expect(e.status).toBe(422);
  }, 120_000);
});

describe('writes through dither-accounts (slice 4)', () => {
  /** A message's flags as another IMAP client sees them, by Message-ID. */
  const serverFlags = (box: string, hdr: string) =>
    other(async (c) => {
      await c.mailboxOpen(box);
      const out: { uid: number; flags: string[] }[] = [];
      for await (const msg of c.fetch({ header: { 'message-id': hdr } }, { flags: true, uid: true })) out.push({ uid: msg.uid as number, flags: [...msg.flags] as string[] });
      return out[0] ?? null;
    });

  test('read in view reaches the server: a second IMAP client sees \\Seen, then \\Flagged for a star', async () => {
    const ops = mailOps(hub);
    ops.setSettings({ markRead: 'view' });
    const m = byHdr('<html-1@example.test>')!;
    expect((await serverFlags('INBOX', '<html-1@example.test>'))!.flags).not.toContain('\\Seen');
    hub.readHere([m.thread_id]);
    expect(byHdr('<html-1@example.test>')!.seen).toBe(1);
    await until(async () => (await serverFlags('INBOX', '<html-1@example.test>'))?.flags.includes('\\Seen'), 20_000, '\\Seen on the server');
    await until(() => byHdr('<html-1@example.test>')!.pending === null, 10_000, 'the change confirmed');
    ops.flag({ threadIds: [m.thread_id], flagged: true });
    await until(async () => (await serverFlags('INBOX', '<html-1@example.test>'))?.flags.includes('\\Flagged'), 20_000, '\\Flagged on the server');
    await until(() => byHdr('<html-1@example.test>')!.pending === null, 10_000, 'the star confirmed');
    expect(byHdr('<html-1@example.test>')!.flagged).toBe(1);
  }, 60_000);

  test('archive: the thread leaves Inbox at once; on the server a new UID in Archive, here the same hub message', async () => {
    const before = byHdr('<dinner-3@example.test>')!;
    const inbox = hub.store.followed(acc).find((b) => b.role === 'inbox')!;
    const archive = hub.store.followed(acc).find((b) => b.role === 'archive')!;
    const oldId = hub.store.one<{ native_id: string }>('SELECT native_id FROM mail_location WHERE mailbox_id = ? AND message_id = ?', inbox.id, before.id)!.native_id;
    const r = mailOps(hub).move({ threadIds: [before.thread_id], to: 'archive' });
    expect(r).toMatchObject({ threads: 1, messages: 2 });
    expect(hub.store.threadView(hub.store.thread(before.thread_id)!).roles).not.toContain('inbox');
    await until(async () => (await serverFlags('Archive', '<dinner-3@example.test>')) && (await serverFlags('Archive', '<dinner-1@example.test>')), 20_000, 'both in Archive on the server');
    expect(await serverFlags('INBOX', '<dinner-3@example.test>')).toBeNull();
    await until(() => hub.store.one('SELECT 1 FROM mail_location WHERE mailbox_id = ? AND message_id = ?', archive.id, before.id) && !byHdr('<dinner-3@example.test>')!.pending, 20_000, 'the Archive location here');
    const after = byHdr('<dinner-3@example.test>')!;
    expect(after.id).toBe(before.id);
    expect(after.thread_id).toBe(before.thread_id);
    const locs = hub.store.all<{ mailbox_id: string; native_id: string }>('SELECT mailbox_id, native_id FROM mail_location WHERE message_id = ?', before.id);
    expect(locs.length).toBe(1);
    expect(locs[0].mailbox_id).toBe(archive.id);
    // <mailbox>.<UIDVALIDITY>.<UID>: the UID the second client sees in Archive.
    expect(locs[0].native_id).not.toBe(oldId);
    expect(Number(locs[0].native_id.split('.').pop())).toBe((await serverFlags('Archive', '<dinner-3@example.test>'))!.uid);
    // The changes passes that follow keep it there.
    await hub.refresh(acc);
    expect(count('SELECT 1 FROM mail_location WHERE message_id = ?', before.id)).toBe(1);
    // Out of Inbox for good; your reply (slice 5's test sent one) stays in Sent.
    const roles = hub.store.threadView(hub.store.thread(before.thread_id)!).roles;
    expect(roles).toContain('archive');
    expect(roles).not.toContain('inbox');
  }, 60_000);
});
