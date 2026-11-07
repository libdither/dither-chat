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
import { HubServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Supervisor, type InprocAdapter } from '../src/supervisor.ts';
import { Triage } from '../src/triage.ts';

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
  // The hub asks to manage the four real kinds; restarting this fake one (for a snapshot, after a gap) needs the same.
  const app = JSON.parse(readFileSync(join(dir, 'accounts-app.json'), 'utf8')).app;
  await fetch(`${m.url}/api/grants`, { method: 'POST', body: JSON.stringify({ app, interface: 'accounts', level: 'manage', kinds: ['chat-fake'] }) });
  // The extractor is online before the hub's grant: the hub restarts it for a snapshot once it may see it.
  await until(() => m.sup.state(REMOTE).online, 10_000, 'the extractor online');
  await approveAll();
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

  test('what came while the hub was away arrives when it is back', async () => {
    await sup.stopAll();
    const before = fresh.length;
    await m.sup.command(REMOTE, { t: 'action', action: 'emit', args: { n: 4 } });
    await Bun.sleep(200);
    sup = new RoutedSupervisor(store, supOpts(), { url: m.url, dataDir: dir, repoRoot: REPO, firstListMs: 5000 });
    await sup.connect();
    sup.startAll();
    await until(() => fresh.length >= before + 4, 8000, 'the four held messages');
  }, 20_000);

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

  test('an account the manager made: its log, renames both ways, its live view through the manager', async () => {
    const id = 'acc_madeThere001';
    const atVnc: string[] = [];
    const vnc = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { open: (s) => void s.write('RFB 003.008\n'), data: (_s, d) => void atVnc.push(Buffer.from(d).toString()) } });
    const port = 19460 + Math.floor(Math.random() * 1000);
    const hub = new HubServer(store, sup, new Triage(store), { port, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    hub.start();
    try {
      store.createAccount({ id, network: 'matrix', label: 'made there', color: '#B794F6', adapter: 'chat-fake' });
      const app = JSON.parse(readFileSync(join(dir, 'accounts-app.json'), 'utf8')).app;
      await m.router.admin(app, { do: 'create', id, kind: 'chat-fake', label: 'made there', config: { vncPort: vnc.port } });
      await until(() => sup.isRemote(id) && sup.online(id) && !!sup.liveViewUrl(id), 10_000, 'remote, online, with a live view');
      // Its view says the manager runs it and that this hub made it; the imported one says so too.
      store.accountManaged = (x) => sup.managed(x);
      expect(store.accountView(store.account(id)!).managedBy).toEqual({ url: null, origin: 'self' });
      expect(store.accountView(store.account(REMOTE)!).managedBy).toEqual({ url: null, origin: 'import' });
      expect(store.accountView(store.account(LOCAL)!).managedBy).toBeUndefined();
      // Nothing of it is in the hub's data: its log comes from the manager.
      expect(existsSync(join(dir, 'accounts', id))).toBe(false);
      expect(await (await fetch(`http://127.0.0.1:${port}/api/accounts/${id}/log`)).text()).toContain('dither-accounts starting chat-fake extractor');
      // Renamed in the hub: the manager follows. Renamed on the manager's page: the hub follows.
      await fetch(`http://127.0.0.1:${port}/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ label: 'renamed in the hub' }) });
      await until(() => m.store.account(id)?.label === 'renamed in the hub', 3000, 'the rename there');
      await fetch(`${m.url}/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ label: 'renamed on the page' }) });
      await until(() => store.account(id)?.label === 'renamed on the page', 3000, 'the rename back');
      // The page's live view socket on the hub, carried through the manager's socket to the VNC port.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/liveview/${id}`, ['binary']);
      ws.binaryType = 'arraybuffer';
      const first = await new Promise<string>((res, rej) => {
        ws.onmessage = (e) => res(Buffer.from(e.data as ArrayBuffer).toString());
        ws.onerror = () => rej(new Error('the live view failed'));
      });
      expect(first).toBe('RFB 003.008\n');
      ws.send(new TextEncoder().encode('RFB 003.008\n'));
      await until(() => atVnc.join('').includes('RFB 003.008'), 3000, 'the reply at the VNC port');
      ws.close();
    } finally {
      hub.stop();
      vnc.stop(true);
    }
  });

  test('removed from the manager with no session here: not started here, it says so', async () => {
    const id = 'acc_madeThere001';
    await m.router.remove(m.store.account(id), true);
    await until(() => !sup.isRemote(id), 3000, 'gone from the list');
    await Bun.sleep(200);
    expect(sup.online(id)).toBe(false);
    expect(store.account(id)!.status).toBe('error');
    expect(JSON.parse(store.account(id)!.attention!).message).toMatch(/^Removed from dither-accounts/);
    // A hub restart does not start it either.
    await sup.stopAll();
    sup = new RoutedSupervisor(store, supOpts(), { url: m.url, dataDir: dir, repoRoot: REPO, firstListMs: 5000 });
    await sup.connect();
    sup.startAll();
    await Bun.sleep(500);
    expect(sup.online(id)).toBe(false);
    store.deleteAccount(id);
  });

  test('a new chat account while the manager is unreachable is refused, not run here', async () => {
    // Another hub process on the same data, whose manager never answers: it knows the accounts the manager ran.
    const down = new RoutedSupervisor(store, supOpts(), { url: 'http://127.0.0.1:1', dataDir: dir, repoRoot: REPO, publicUrl: 'https://accounts.example/' });
    expect(down.managed(REMOTE)).toEqual({ url: `https://accounts.example/#/accounts/${REMOTE}`, origin: null });
    const port = 19460 + Math.floor(Math.random() * 1000);
    const hub = new HubServer(store, down, new Triage(store), { port, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    hub.start();
    try {
      const before = store.accounts().length;
      const r = await fetch(`http://127.0.0.1:${port}/api/accounts`, { method: 'POST', body: JSON.stringify({ network: 'discord', label: 'refused' }) });
      expect(r.status).toBe(503);
      expect((await r.json()).error).toMatch(/^dither-accounts is not reachable/);
      expect(store.accounts().length).toBe(before);
      expect(store.accounts().some((a) => a.label === 'refused')).toBe(false);
    } finally {
      hub.stop();
    }
  });

  test("why the manager cannot run an account shows in the hub", async () => {
    const id = 'acc_lockedThere1';
    const d = join(dir, 'manager', 'accounts', id);
    mkdirSync(d, { recursive: true });
    const sleeper = Bun.spawn(['sleep', '30']);
    writeFileSync(join(d, 'extractor.lock'), JSON.stringify({ pid: sleeper.pid, owner: 'someone', at: new Date().toISOString() }));
    store.createAccount({ id, network: 'matrix', label: 'locked there', color: '#FF8C61', adapter: 'chat-fake' });
    const app = JSON.parse(readFileSync(join(dir, 'accounts-app.json'), 'utf8')).app;
    try {
      await m.router.admin(app, { do: 'create', id, kind: 'chat-fake', label: 'locked there' });
      await until(() => !!store.account(id)?.attention, 5000, 'the attention');
      expect(store.account(id)!.status).toBe('error');
      expect(JSON.parse(store.account(id)!.attention!).message).toBe(`Not running in dither-accounts: someone (pid ${sleeper.pid}) runs this account`);
    } finally {
      sleeper.kill();
      await m.router.remove(m.store.account(id), true);
      store.deleteAccount(id);
    }
  });
});

describeAll('kinds the hub asks for after it registered', () => {
  test('only kinds with no grant and no request, open or denied, are asked for', async () => {
    const { kindsToAsk } = await import('../src/remote.ts');
    const kinds = ['discord', 'signal', 'telegram', 'gmessages'];
    // Registered before telegram and gmessages existed: those two.
    expect(kindsToAsk({ grants: [{ interface: 'chat', kinds: null }, { interface: 'accounts', kinds: ['discord', 'signal'] }], requests: [] }, kinds)).toEqual(['telegram', 'gmessages']);
    // Asked already (waiting), or the answer was no: nothing more.
    expect(kindsToAsk({ grants: [{ interface: 'accounts', kinds: ['discord', 'signal'] }], requests: [{ interface: 'accounts', kinds: ['telegram'], state: 'pending' }, { interface: 'accounts', kinds: ['gmessages'], state: 'denied' }] }, kinds)).toEqual([]);
    // A grant for every kind (kinds null) covers them all; nothing known asks for all of them.
    expect(kindsToAsk({ grants: [{ interface: 'accounts', kinds: null }] }, kinds)).toEqual([]);
    expect(kindsToAsk(null, kinds)).toEqual(kinds);
  });
});
