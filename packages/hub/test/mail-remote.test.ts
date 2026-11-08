/**
 * Mail through a real dither-accounts manager (docs/mail.md, docs/mail-design.md §12.2): a throwaway manager on a temp
 * directory with one `imap` account against that repo's test servers (extractors/imap/test/servers.ts: Dovecot 2.4
 * and an SMTP sink on 127.0.0.1), and this hub's RoutedSupervisor and MailHub on it. The hub asks for mail like any
 * app, the test approves it over the manager's API, then checks the first sync, keeping up through IDLE, flags and a
 * move made by another mail client, and a relist after a UIDVALIDITY change. Sending is slice 5's.
 *
 * Ports 18580-18589 (dither-accounts' own tests use 18550-18569). Needs a dither-accounts checkout beside this repo
 * (or DITHER_ACCOUNTS_REPO) and Dovecot (DOVECOT_BIN, or the store path dither-accounts' tests remember); skipped
 * without them, so a plain `bun test` stays fast. Nothing in the checkout is written.
 */
import { afterAll, beforeAll, describe as describeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mailId } from '@dither-chat/protocol/ids';
import { ManagerMailBackend } from '../src/mail/backend.ts';
import { MailHub } from '../src/mail/index.ts';
import { RoutedSupervisor } from '../src/remote.ts';
import { Store } from '../src/store.ts';

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
const describe = have ? describeAll : describeAll.skip;
const REPO = resolve(import.meta.dir, '../../..');

const IMAP_PORT = 18580;
const SMTP_PORT = 18582;
const MANAGER_PORT = 18583;

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
  m = await createManager({ dataDir: join(dir, 'manager'), port: MANAGER_PORT });

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
    await until(() => hub.store.account(acc)?.online, 40_000, 'the account online');
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

  test('a body through mail.get; an HTML-only message shows its text; reading here leaves the server’s \\Seen alone', async () => {
    const html = await hub.body(byHdr('<html-1@example.test>')!.id);
    expect(html.text).toContain('Your parcel shipped');
    expect(html.text).not.toContain('alert');
    const reply = await hub.body(byHdr('<dinner-3@example.test>')!.id);
    expect(reply.text!.slice(0, reply.quoteAt!)).toBe('Booked for 7:30.\n\n');
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
