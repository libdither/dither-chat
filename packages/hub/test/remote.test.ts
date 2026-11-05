/**
 * Remote accounts (remote.ts, docs/accounts.md) against a real dither-accounts manager on a temp dir, with its fake
 * chat extractor (extractors/chat-fake) on one account and an in-process adapter on another that stays local.
 *
 * Needs a dither-accounts checkout beside this repo (or DITHER_ACCOUNTS_REPO); skipped without one.
 */
import { afterAll, beforeAll, describe as describeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { RoutedSupervisor } from '../src/remote.ts';
import { Store } from '../src/store.ts';
import { Supervisor, type InprocAdapter } from '../src/supervisor.ts';

const ACCOUNTS = process.env.DITHER_ACCOUNTS_REPO ?? resolve(import.meta.dir, '../../../../dither-accounts');
const have = existsSync(join(ACCOUNTS, 'packages/manager/src/index.ts'));
const describe = have ? describeAll : describeAll.skip;
const REPO = resolve(import.meta.dir, '../../..');

const until = async (f: () => boolean | Promise<boolean>, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};

let m: any;
let router: any;
let dir: string;
let store: Store;
let sup: RoutedSupervisor;
const fresh: string[] = [];
const localCommands: P.AdapterCommand[] = [];
let localStarted = 0;
const REMOTE = 'acc_remoteFake01';
const LOCAL = 'acc_localInproc1';

const inproc = (acc: { id: string; adapter: string }): InprocAdapter | null => {
  if (acc.adapter !== 'inproc-fake') return null;
  return {
    start(emit) {
      localStarted++;
      emit({ t: 'status', status: 'online' });
    },
    command(cmd) {
      localCommands.push(cmd);
    },
    stop() {},
  };
};
const supOpts = () => ({ hubAdapterUrl: 'ws://127.0.0.1:1/adapter', dataDir: dir, repoRoot: REPO, inproc: inproc as any, onFresh: (ids: string[]) => fresh.push(...ids) });

async function approveAll() {
  const st = await (await fetch(`${m.url}/api/state`)).json();
  for (const app of st.apps) for (const r of app.requests) if (r.state === 'pending') await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
}

beforeAll(async () => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), 'dither-remote-'));
  const { createManager } = await import(join(ACCOUNTS, 'packages/manager/src/index.ts'));
  router = await import(join(ACCOUNTS, 'packages/manager/src/router.ts'));
  mkdirSync(join(dir, 'manager'), { recursive: true });
  m = await createManager({ dataDir: join(dir, 'manager'), port: 0 });
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  store.createAccount({ id: REMOTE, network: 'matrix', label: 'remote', color: '#5CC8FF', adapter: 'chat-fake' });
  store.createAccount({ id: LOCAL, network: 'matrix', label: 'local', color: '#F2A541', adapter: 'inproc-fake' });
  // The account's session directory, imported in place.
  mkdirSync(join(dir, 'accounts', REMOTE), { recursive: true });
  const r = await fetch(`${m.url}/api/accounts/import`, { method: 'POST', body: JSON.stringify({ accounts: [{ id: REMOTE, kind: 'chat-fake', label: 'remote', dir: join(dir, 'accounts', REMOTE) }] }) });
  expect(r.status).toBe(200);
  sup = new RoutedSupervisor(store, supOpts(), { url: m.url, dataDir: dir, repoRoot: REPO, firstListMs: 5000 });
  await sup.connect();
  await approveAll();
  // The hub manages the four real kinds; restarting this fake one (after a gap) needs the same for its kind.
  const app = JSON.parse(readFileSync(join(dir, 'accounts-app.json'), 'utf8')).app;
  await fetch(`${m.url}/api/grants`, { method: 'POST', body: JSON.stringify({ app, interface: 'accounts', level: 'manage', kinds: ['chat-fake'] }) });
  sup.startAll();
});

afterAll(async () => {
  if (!have) return;
  await sup?.stopAll();
  await m?.stop();
  store?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('remote accounts through dither-accounts', () => {
  test('registered once, credentials kept 0600', () => {
    const p = join(dir, 'accounts-app.json');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("the remote adapter's events land in the hub; the local account runs here", async () => {
    await until(() => sup.isRemote(REMOTE) && sup.online(REMOTE), 10_000, 'the remote account online');
    await until(() => store.bootstrap().conversations.some((c) => c.nativeId === 'dm:me:alice'), 5000, 'the DM ingested');
    const conv = store.bootstrap().conversations.find((c) => c.nativeId === 'dm:me:alice')!;
    expect(store.messages(conv.id, null, 10).messages.map((x) => x.body)).toEqual(['an old message', 'an old answer']);
    expect(store.account(REMOTE)!.status).toBe('online');
    await until(() => localStarted === 1, 3000, 'the local account started');
    expect(sup.isRemote(LOCAL)).toBe(false);
    expect(sup.online(LOCAL)).toBe(true);
  });

  test('commands go out as calls and come back; live messages reach triage', async () => {
    const conv = store.bootstrap().conversations.find((c) => c.nativeId === 'dm:me:alice')!;
    const res = await sup.command<{ nativeId: string }>(REMOTE, { t: 'send', conversation: 'dm:me:alice', body: 'hi from the hub' });
    expect(res.nativeId).toBeTruthy();
    await until(() => store.messages(conv.id, null, 10).messages.some((x) => x.body === 'hi from the hub'), 4000, 'the echo');
    const before = fresh.length;
    await sup.command(REMOTE, { t: 'action', action: 'emit', args: { n: 3 } });
    await until(() => fresh.length >= before + 3, 4000, 'three fresh messages');
  });

  test('a local account keeps its own commands', async () => {
    void sup.command(LOCAL, { t: 'markRead', conversation: 'x', upTo: 'y' }, 200).catch(() => {});
    await until(() => localCommands.some((c) => c.t === 'markRead'), 2000, 'the local command');
  });

  test('a gap restarts the account, whose snapshot fills it', async () => {
    const pid1 = ((await sup.command(REMOTE, { t: 'action', action: 'pid' })) as { pid: number }).pid;
    await sup.stopAll(); // the hub goes away; the manager keeps the adapter running
    const before = router.BUFFER.events;
    router.BUFFER.events = 5;
    try {
      await m.sup.command(REMOTE, { t: 'action', action: 'emit', args: { n: 20 } });
      await Bun.sleep(200);
      sup = new RoutedSupervisor(store, supOpts(), { url: m.url, dataDir: dir, repoRoot: REPO, firstListMs: 5000 });
      await sup.connect();
      sup.startAll();
      await until(async () => {
        if (!sup.online(REMOTE)) return false;
        const r = (await sup.command(REMOTE, { t: 'action', action: 'pid' }).catch(() => null)) as { pid: number } | null;
        return !!r && r.pid !== pid1;
      }, 15_000, 'a restarted adapter');
    } finally {
      router.BUFFER.events = before;
    }
  }, 30_000);

  test('a supervisor will not start an account another process runs', async () => {
    // The manager's extractor for REMOTE has DITHER_ACCOUNT_ID in its environment: a plain local supervisor refuses.
    await until(() => m.sup.state(REMOTE).online, 10_000, 'the manager running the account');
    store.updateAccount(REMOTE, { status: 'online', attention: null });
    const local = new Supervisor(store, { ...supOpts(), repoRoot: REPO });
    // A real adapter kind, so start gets as far as the lock; the lock check comes before any spawn.
    store.db.query('UPDATE account SET adapter = ? WHERE id = ?').run('matrix', REMOTE);
    try {
      local.start(REMOTE);
      const acc = store.account(REMOTE)!;
      expect(acc.status).toBe('error');
      expect(JSON.parse(acc.attention!).message).toMatch(/^Not started here: pid \d+ already runs this account$/);
      expect(local.online(REMOTE)).toBe(false);
    } finally {
      await local.stop(REMOTE);
      store.db.query('UPDATE account SET adapter = ? WHERE id = ?').run('chat-fake', REMOTE);
    }
  });

  test("a lock file held by a live process is respected", async () => {
    const id = 'acc_lockedMatrix';
    store.createAccount({ id, network: 'matrix', label: 'locked', color: '#B794F6', adapter: 'matrix' });
    const d = join(dir, 'accounts', id);
    mkdirSync(d, { recursive: true });
    const sleeper = Bun.spawn(['sleep', '30']);
    writeFileSync(join(d, 'extractor.lock'), JSON.stringify({ pid: sleeper.pid, owner: 'dither-accounts', at: new Date().toISOString() }));
    const local = new Supervisor(store, supOpts());
    try {
      local.start(id);
      expect(JSON.parse(store.account(id)!.attention!).message).toBe(`Not started here: dither-accounts (pid ${sleeper.pid}) runs this account`);
    } finally {
      sleeper.kill();
      await local.stop(id);
    }
  });
});
