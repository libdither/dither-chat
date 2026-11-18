/**
 * Mail through a real dither-accounts manager with its `google` kind (Gmail read through the signed-in browser): a
 * throwaway manager on a temp directory, one google account against dither-accounts' fake Google (test/fake-google.ts
 * there, `web`: a stand-in Gmail page and its sync endpoints), and this hub's RoutedSupervisor and MailHub on it, as
 * mail-remote.test.ts does for `imap`. It checks the first sync, catching up a message that arrives, and that the
 * states an account passes through while its Gmail page is not ready (the extractor starting, the page stalled and
 * reloaded) put no line in the hub's errors.ndjson.
 *
 * The google kind runs a real Chromium on Xvfb (and x11vnc), so this needs those as dither-accounts' own
 * google-browser test does (its resolveBins), and a dither-accounts checkout beside this repo (or
 * DITHER_ACCOUNTS_REPO); skipped without them, as in CI. Nothing in the checkout is written. Run it alone:
 * `DITHER_ACCOUNTS_REPO=<checkout> bun test test/mail-remote-google.test.ts`.
 */
import { afterAll, beforeAll, describe as describeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ErrorRecord, ErrorLog, setErrorLog } from '../src/errors.ts';
import { ManagerMailBackend } from '../src/mail/backend.ts';
import { MailHub } from '../src/mail/index.ts';
import { RoutedSupervisor } from '../src/remote.ts';
import { Store } from '../src/store.ts';

const ACCOUNTS = process.env.DITHER_ACCOUNTS_REPO ?? resolve(import.meta.dir, '../../../../dither-accounts');
const FAKE_GOOGLE = join(ACCOUNTS, 'test/fake-google.ts');

/** Xvfb, x11vnc and Chromium, as dither-accounts' browser package finds them; null when any is missing. */
async function browserBins(): Promise<unknown> {
  const at = join(ACCOUNTS, 'packages/browser/src/index.ts');
  if (!existsSync(at) || !existsSync(FAKE_GOOGLE) || !existsSync(join(ACCOUNTS, 'packages/manager/src/index.ts'))) return null;
  try {
    return (await import(at)).resolveBins(() => {});
  } catch {
    return null;
  }
}
const have = !!(await browserBins());
const describe = describeAll.skipIf(!have);
const REPO = resolve(import.meta.dir, '../../..');

/** Invented: what the fake Google's pages say and set. */
const WEB = {
  sapisid: 'sapisid-for-the-hub-test',
  pageKey: `AIza${'P'.repeat(35)}`,
  htmlKey: `AIza${'H'.repeat(35)}`,
  email: 'pat@example.com',
  mailKey: `AIza${'M'.repeat(35)}`,
  mailEmail: 'pat@example.com',
  mailMark: 'Hm#4410',
  peopleKey: `AIza${'Q'.repeat(35)}`,
};

/** The remote polls real processes (a manager, an extractor, Chromium): it waits for the exact state it checks. */
const until = async (f: () => unknown, ms = 15_000, what = 'condition') => {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) { // wall-clock: a real manager, extractor and Chromium answer in real time; skipped in CI
    try {
      if (await f()) return;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(50); // wall-clock: polls another process's state for the exact thing checked; skipped in CI
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ''}`);
};

let fake: any;
let m: any;
let dir: string;
let store: Store;
let sup: RoutedSupervisor;
let hub: MailHub;
let acc: string;
const errors: ErrorRecord[] = [];
const logs: string[] = [];
const saved = process.env.DITHER_GOOGLE_BACKOFF_MS;

/** The hub's errors.ndjson lines (where, and what), all of them: none is expected. */
const mailErrors = () => errors.map((e) => `${e.where}: ${e.message}`);
/** What the fake Gmail lists in Inbox: Gmail's ids of its messages labelled ^i, out of Spam and Trash. */
const inboxOnServer = (): string[] => fake.gmail.messages.filter((x: any) => !x.pending && x.labels.includes('^i') && !x.labels.includes('^s') && !x.labels.includes('^k')).map((x: any) => x.id);
const inboxHere = (): Set<string> => {
  const box = hub.store.followed(acc).find((b) => b.role === 'inbox');
  return new Set(box ? hub.store.all<{ native_id: string }>('SELECT native_id FROM mail_location WHERE mailbox_id = ?', box.id).map((r) => r.native_id) : []);
};

/** Every process on this machine started for the account (the extractor and all it spawned carry its id). */
function processesOf(id: string): number[] {
  const needle = `DITHER_ACCOUNT_ID=${id}`;
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes(needle)) out.push(Number(d));
    } catch {}
  }
  return out;
}

beforeAll(async () => {
  if (!have) return;
  // The extractor's waits after a failure, cut short (as dither-accounts' google-browser test does).
  process.env.DITHER_GOOGLE_BACKOFF_MS = '1';
  process.env.DITHER_ACCOUNTS_CLIENT ??= join(ACCOUNTS, 'packages/client/src/index.ts');
  setErrorLog(new ErrorLog((r) => errors.push(r), { dedupMs: 0 }));
  dir = mkdtempSync(join(tmpdir(), 'dither-mail-google-'));
  const { startFakeGoogle } = await import(FAKE_GOOGLE);
  fake = startFakeGoogle({ web: WEB });
  fake.addCalendar({ id: WEB.email, summary: WEB.email, timeZone: 'UTC', accessRole: 'owner', primary: true, selected: true });

  const { createManager } = await import(join(ACCOUNTS, 'packages/manager/src/index.ts'));
  mkdirSync(join(dir, 'manager'), { recursive: true });
  m = await createManager({ dataDir: join(dir, 'manager'), port: 0, openPage: true });

  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  sup = new RoutedSupervisor(store, { hubAdapterUrl: 'ws://127.0.0.1:1/adapter', dataDir: dir, repoRoot: REPO, onFresh: () => {} } as any, { url: m.url, dataDir: dir, repoRoot: REPO, firstListMs: 2000 });
  const backend = new ManagerMailBackend({ callRaw: (a, op, input, t) => sup.callMail(a, op, input, t), askMailAgain: () => sup.askMailAgain() });
  sup.mail = backend;
  hub = new MailHub({ db: store.db, backend, managerUrl: m.url, log: (s) => logs.push(s) });
  hub.start();
  await sup.connect();
  const st = await (await fetch(`${m.url}/api/state`)).json();
  for (const app of st.apps) for (const r of app.requests) if (r.state === 'pending') await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });

  // The account, added on the manager's page, its pages on the fake Google; Gmail looked at every 2 s.
  const res = await fetch(`${m.url}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'google',
      label: 'Google (test)',
      config: { authuser: 0, testOrigin: fake.url, apiBase: fake.url, testMailOrigin: fake.mailUrl, gmailApiBase: fake.mailUrl, peopleApiBase: fake.mailUrl, gmailPollSeconds: 2 },
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
  for (const pid of acc ? processesOf(acc) : []) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fake?.stop();
  store?.db.close();
  setErrorLog(null);
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.DITHER_GOOGLE_BACKOFF_MS;
  else process.env.DITHER_GOOGLE_BACKOFF_MS = saved;
}, 60_000);

describe('mail through dither-accounts’ google kind', () => {
  test('the first sync: online as Gmail, every Inbox message here, no errors while the page came up', async () => {
    await until(() => hub.access().state === 'granted', 70_000, 'the grant seen');
    await until(() => hub.store.account(acc)?.online && hub.store.account(acc)?.address, 90_000, 'the account online, with its address');
    const row = hub.store.account(acc)!;
    expect(row).toMatchObject({ kind: 'google', provider: 'Gmail', id_per_message: 1 });
    await until(() => hub.store.account(acc)?.synced_at, 120_000, 'the first sync');
    const server = inboxOnServer();
    expect(server.length).toBeGreaterThan(0);
    await until(() => server.every((id) => inboxHere().has(id)), 30_000, 'every Inbox message here');
    expect(hub.store.followed(acc).map((b) => b.role)).toEqual(expect.arrayContaining(['inbox', 'sent', 'all']));
    // A first sync tried before the extractor had its browser fails (logged, and the page says why); the passes after
    // the first sync clear it.
    const sync = () => hub.store.accountView(hub.store.account(acc)!).sync;
    await until(() => sync().failures === 0 && sync().stateAt !== null, 60_000, 'the failures cleared');
    expect(mailErrors()).toEqual([]);
  }, 300_000);

  test('catching up: a message that arrives in Gmail comes here by itself', async () => {
    const fresh = fake.gmail.arrive({ subject: `Fresh one ${WEB.mailMark}` });
    await until(() => inboxHere().has(fresh.id), 60_000, 'the new message');
    expect(mailErrors()).toEqual([]);
  }, 90_000);

  test('a Gmail page that stops answering and is reloaded: passes go on through it, with no errors.ndjson line', async () => {
    // The fake holds the page's profile and labels calls until the page loads again; the probe (asked for with a file
    // in the account's directory, as an operator would) makes two of them, and after two silences the extractor
    // reloads the page (a pass of the hub's that works in between would break the two in a row). Right after the
    // reload the page has not synced yet: the hub's passes then meet the extractor's not-ready answers.
    const loads = fake.pageLoads('gmail', 0);
    fake.stall('gmail', 'until-reload');
    writeFileSync(join(m.store.account(acc).dir, 'probe-gmail.request'), '');
    await until(() => fake.pageLoads('gmail', 0) > loads, 120_000, 'the Gmail page reloaded');
    // At once, while the page comes up again.
    await hub.refresh(acc);
    const fresh = fake.gmail.arrive({ subject: `After the reload ${WEB.mailMark}` });
    await until(async () => {
      await hub.refresh(acc);
      return inboxHere().has(fresh.id);
    }, 120_000, 'the message after the reload');
    await until(() => hub.store.accountView(hub.store.account(acc)!).sync.failures === 0, 60_000, 'the failures cleared');
    expect(mailErrors()).toEqual([]);
  }, 400_000);
});
