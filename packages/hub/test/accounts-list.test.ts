/**
 * One list of accounts (protocol accounts.ts, accounts-manager.ts, docs/accounts.md "One list"): a row's feature icons
 * and status from its chat, mail and manager parts; the link to dither-accounts on a stand-in client (the full list, the
 * requests waiting there, asking for one interface of one account or for a kind, the kinds, adding Proton Mail, and
 * running an account that has no chats here); and the routes on a demo world's stand-in manager.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { accountFeatures, askFor, kindAsk, rowStatus } from '@dither-chat/protocol';
import { DEMO_UNGRANTED, DemoManager } from '../src/accounts-manager.ts';
import { FakeMailBackend } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { FakeNoticeSource } from '../src/notices/fake.ts';
import { ASKED_KINDS, asksOf, RoutedSupervisor } from '../src/remote.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { stub } from './fixtures/accounts-client-stub.ts';

const chatAccount = (o: Partial<P.AccountView> = {}): P.AccountView => ({
  id: 'acc_chat',
  network: 'discord',
  label: 'main',
  color: '#000',
  status: 'online',
  attention: null,
  selfIdentityId: null,
  capabilities: ['send', 'calls'],
  liveView: true,
  demo: false,
  createdAt: 0,
  ...o,
});
const mailAccount = (o: Partial<P.MailAccountView> = {}): P.MailAccountView =>
  ({
    id: 'acc_mail',
    kind: 'proton',
    label: 'Proton',
    address: 'ann@example.com',
    name: null,
    color: '#111',
    level: 'write',
    dryRun: false,
    online: true,
    problem: null,
    send: { ok: true, why: null },
    sync: { phase: 'idle', synced: 1, oldest: null },
    managedUrl: null,
    deleteAt: null,
    ...o,
  }) as P.MailAccountView;
const managed = (o: Partial<P.ManagedAccountView> = {}): P.ManagedAccountView => ({
  id: 'acc_x',
  kind: 'google',
  label: 'Work',
  interfaces: ['google.calendar', 'mail'],
  grants: {},
  manages: false,
  liveView: false,
  online: true,
  running: true,
  enabled: true,
  error: null,
  origin: 'page',
  ...o,
});
const icons = (f: P.FeatureView[]) => f.map((x) => `${x.feature}:${x.state}`);

describe('a row: its icons and its status', () => {
  test('a chat account: chats, then what its chats can do', () => {
    expect(icons(accountFeatures({ chat: chatAccount(), spaces: true }))).toEqual(['chat:on', 'calls:on', 'spaces:on']);
    expect(icons(accountFeatures({ chat: chatAccount({ network: 'x', capabilities: ['send'] }), feed: true }))).toEqual(['chat:on', 'feed:on']);
    // In trouble: a dot on chats, with the account's own words.
    const f = accountFeatures({ chat: chatAccount({ status: 'attention', attention: { kind: 'login', message: 'Sign in again', since: 0 } }) });
    expect(f[0]).toEqual({ feature: 'chat', state: 'trouble', why: 'Sign in again' });
    // A calendar account is for its calendar; its Calendar chat comes with it.
    expect(icons(accountFeatures({ chat: chatAccount({ network: 'calendar', capabilities: ['send'] }) }))).toEqual(['chat:on', 'calendar:on']);
  });

  test('a mail account, and what its account offers that this hub does not use yet', () => {
    expect(icons(accountFeatures({ mail: mailAccount() }))).toEqual(['mail:on']);
    expect(accountFeatures({ mail: mailAccount({ problem: { layer: 'signed in', message: 'Sign in to Proton' } }) })[0]).toEqual({ feature: 'mail', state: 'trouble', why: 'Sign in to Proton' });
    // google.calendar is not this hub's to use: no icon; mail is, but not granted: dim, then asked, then declined.
    const g = managed({ id: 'acc_g' });
    expect(icons(accountFeatures({ managed: g }))).toEqual(['mail:off']);
    const pending: P.AccessAsk = { interface: 'mail', accounts: ['acc_g'], kinds: null, state: 'pending' };
    expect(icons(accountFeatures({ managed: g, asks: [pending] }))).toEqual(['mail:asked']);
    expect(icons(accountFeatures({ managed: g, asks: [{ ...pending, state: 'denied' }] }))).toEqual(['mail:denied']);
    // Granted to every account: on.
    expect(icons(accountFeatures({ managed: { ...g, grants: { mail: 'write' } }, mail: mailAccount({ id: 'acc_g' }) }))).toEqual(['mail:on']);
    // A notices account: on while it runs.
    expect(icons(accountFeatures({ managed: managed({ kind: 'github', interfaces: ['notifications'], grants: { notifications: 'write' } }) }))).toEqual(['notices:on']);
    expect(accountFeatures({ managed: managed({ kind: 'github', interfaces: ['notifications'], grants: { notifications: 'write' }, online: false, error: 'token refused' }) })[0]).toMatchObject({ state: 'trouble', why: 'token refused' });
  });

  test('its pill: the worst of its parts, a disabled part only when all are', () => {
    expect(rowStatus({ chat: chatAccount() })).toEqual({ status: 'online', label: 'Online' });
    expect(rowStatus({ mail: mailAccount({ level: null }) })).toEqual({ status: 'disabled', label: 'No access' });
    expect(rowStatus({ mail: mailAccount({ problem: { layer: null, message: 'x' } }) })).toEqual({ status: 'attention', label: 'Needs you' });
    expect(rowStatus({ chat: chatAccount(), mail: mailAccount({ online: false }) })).toEqual({ status: 'offline', label: 'Offline' });
    expect(rowStatus({ chat: chatAccount({ status: 'disabled' }), mail: mailAccount() })).toEqual({ status: 'online', label: 'Online' });
    expect(rowStatus({ managed: managed({ enabled: false, interfaces: ['notifications'], grants: { notifications: 'write' } }) })).toEqual({ status: 'disabled', label: 'Disabled' });
    const notices = { interfaces: ['notifications'], grants: { notifications: 'write' as const } };
    expect(rowStatus({ managed: managed({ ...notices, online: false, running: false, error: 'no extractor' }) })).toEqual({ status: 'error', label: 'Error' });
    // Nothing of it used here: says so, or that it was asked for.
    expect(rowStatus({ managed: managed({ id: 'acc_g' }) })).toEqual({ status: 'disabled', label: 'Not used' });
    expect(rowStatus({ managed: managed({ id: 'acc_g' }), asks: [{ interface: 'mail', accounts: ['acc_g'], kinds: null, state: 'pending' }] })).toEqual({ status: 'disabled', label: 'Asked' });
  });

  test('which request covers an account, or a kind', () => {
    const asks: P.AccessAsk[] = [
      { interface: 'mail', accounts: '*', kinds: null, state: 'denied' },
      { interface: 'mail', accounts: ['acc_a'], kinds: null, state: 'pending' },
      { interface: 'accounts', accounts: '*', kinds: ['imap'], state: 'pending' },
    ];
    expect(askFor(asks, 'mail', 'acc_a')?.state).toBe('pending');
    expect(askFor(asks, 'mail', 'acc_b')?.state).toBe('denied');
    expect(askFor(asks, 'chat', 'acc_a')).toBeUndefined();
    expect(kindAsk(asks, 'imap')?.state).toBe('pending');
    expect(kindAsk(asks, 'proton')).toBeUndefined();
    expect(asksOf({ requests: [{ interface: 'mail', accounts: ['acc_a'], state: 'pending' }, { interface: 'chat', state: 'approved' }, { interface: 'accounts', kinds: ['imap'], state: 'denied' }] })).toEqual([
      { interface: 'mail', accounts: ['acc_a'], kinds: null, state: 'pending' },
      { interface: 'accounts', accounts: '*', kinds: ['imap'], state: 'denied' },
    ]);
  });
});

describe('the link to dither-accounts', () => {
  let cleanup: (() => void) | null = null;
  afterAll(() => cleanup?.());
  const before = process.env.DITHER_ACCOUNTS_CLIENT;
  process.env.DITHER_ACCOUNTS_CLIENT = resolve(import.meta.dir, 'fixtures/accounts-client-stub.ts');
  afterAll(() => {
    if (before === undefined) delete process.env.DITHER_ACCOUNTS_CLIENT;
    else process.env.DITHER_ACCOUNTS_CLIENT = before;
  });

  async function hub(self: typeof stub.self, kinds?: unknown[]) {
    cleanup?.();
    const dir = mkdtempSync(join(tmpdir(), 'dither-accounts-list-'));
    const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    writeFileSync(join(dir, 'accounts-app.json'), JSON.stringify({ app: 'app_stub', token: 'token_stub', url: 'http://manager.test' }));
    Object.assign(stub, { self, registered: [], asked: [], client: null, calls: [], admin: [], kinds });
    const repoRoot = resolve(import.meta.dir, '../../..');
    const sup = new RoutedSupervisor(store, { hubAdapterUrl: 'ws://127.0.0.1:1/adapter', dataDir: dir, repoRoot, inproc: () => null, onFresh: () => {} }, { url: 'http://manager.test', dataDir: dir, repoRoot, publicUrl: 'https://accounts.example' });
    await sup.connect();
    cleanup = () => {
      void sup.stopAll();
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { sup, store };
  }

  const LIST = [
    { id: 'acc_dc', kind: 'discord', label: 'main', interfaces: ['chat'], running: true, online: true, enabled: true, grants: { chat: 'manage' }, dryRun: false, manages: true, liveView: true, origin: 'self' },
    { id: 'acc_pm', kind: 'proton', label: 'Proton Mail', interfaces: ['mail'], running: true, online: true, enabled: true, grants: { mail: 'write' }, dryRun: false, manages: true, liveView: true, origin: 'self' },
    { id: 'acc_gh', kind: 'github', label: 'GitHub', interfaces: ['notifications'], running: true, online: true, enabled: true, grants: { notifications: 'write' }, dryRun: false, manages: false, liveView: false, origin: 'page' },
  ];

  test('Proton Mail is a kind it asks to add; a hub that may not yet asks once', async () => {
    expect(ASKED_KINDS).toContain('proton');
    await hub({ grants: [{ interface: 'accounts', kinds: ['discord', 'signal', 'matrix', 'whatsapp', 'telegram', 'gmessages', 'messenger', 'instagram', 'x', 't3'] }], requests: [] });
    expect(stub.asked).toContainEqual([expect.objectContaining({ interface: 'accounts', level: 'manage', kinds: ['proton'] })]);
  });

  test('every account it lists is in the view, with the requests waiting there', async () => {
    const pending = { interface: 'mail', accounts: ['acc_gw'], state: 'pending' };
    const { sup, store } = await hub({ grants: [{ interface: 'accounts', kinds: null }], requests: [pending] });
    stub.client!.opts.onAccounts?.(LIST);
    await Bun.sleep(0);
    const v = store.accountsManager!;
    expect(v).toMatchObject({ url: 'https://accounts.example', reachable: true });
    expect(v.accounts!.map((a) => [a.id, a.kind, a.manages])).toEqual([
      ['acc_dc', 'discord', true],
      ['acc_pm', 'proton', true],
      ['acc_gh', 'github', false],
    ]);
    expect(v.asks).toEqual([{ interface: 'mail', accounts: ['acc_gw'], kinds: null, state: 'pending' }]);
    // The page hears of it as it changes.
    expect(store.dirty.extra.filter((e) => e.t === 'accountsManager').length).toBe(1);
    // Only the chat account has a chat account here; the others are run through the manager.
    expect(sup.managedOnly('acc_dc')).toBeNull();
    expect(sup.managedOnly('acc_pm')?.kind).toBe('proton');
    stub.admin.length = 0;
    await sup.restart('acc_pm');
    expect(await sup.log('acc_pm')).toBe('log of acc_pm');
    await sup.setEnabled('acc_pm', false);
    await sup.remove('acc_pm', true);
    expect(stub.admin).toEqual([
      { do: 'restart', account: 'acc_pm' },
      { do: 'log', account: 'acc_pm', lines: 400 },
      { do: 'update', account: 'acc_pm', enabled: false },
      { do: 'delete', account: 'acc_pm', purge: true },
    ]);
    // Not one it may not run.
    expect(sup.remove('acc_gh', false)).rejects.toThrow(/may not remove/);
  });

  test('asking for one interface of one account, or for a kind', async () => {
    const { sup } = await hub({ grants: [{ interface: 'accounts', kinds: null }], requests: [] });
    await sup.ask('acc_gw', 'mail');
    await sup.askKind('imap');
    expect(stub.asked).toEqual([
      [{ interface: 'mail', level: 'write', accounts: ['acc_gw'], reason: "Show this account's mail in dither-chat" }],
      [{ interface: 'accounts', level: 'manage', kinds: ['imap'], reason: 'Add, sign in and remove imap accounts from dither-chat' }],
    ]);
    expect(sup.ask('acc_gw', 'google.calendar')).rejects.toThrow(/does not use/);
  });

  test('its kinds, with this hub’s requests for them; null from a manager before the action', async () => {
    const kinds = [
      { kind: 'proton', name: 'Proton Mail', interfaces: ['mail'], add: { blurb: 'b' }, manages: true },
      { kind: 'imap', name: 'Email (IMAP)', interfaces: ['mail'], add: { blurb: 'b', fields: [{ key: 'email', label: 'Email address' }] }, manages: false },
    ];
    let { sup } = await hub({ grants: [], requests: [{ interface: 'accounts', kinds: ['imap'], state: 'pending' }] }, kinds);
    expect(await sup.kinds()).toEqual([
      { kind: 'proton', name: 'Proton Mail', interfaces: ['mail'], add: { blurb: 'b' }, manages: true },
      { kind: 'imap', name: 'Email (IMAP)', interfaces: ['mail'], add: { blurb: 'b', fields: [{ key: 'email', label: 'Email address' }] }, manages: false, asked: 'pending' },
    ]);
    ({ sup } = await hub({ grants: [], requests: [] }));
    expect(await sup.kinds()).toBeNull();
  });

  test('adding a Proton Mail account: created there from its form', async () => {
    const { sup } = await hub({ grants: [{ interface: 'accounts', kinds: null }], requests: [] });
    stub.admin.length = 0;
    expect(await sup.create('proton', 'Personal', {})).toBe('acc_made1');
    expect(stub.admin).toEqual([{ do: 'create', kind: 'proton', label: 'Personal', form: {}, config: {} }]);
  });
});

describe('the routes, on a demo world’s manager', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-accounts-routes-'));
  const store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const fake = new FakeMailBackend();
  fake.addAccount('acc_demoMail', { kind: 'imap', label: 'Personal mail', email: 'ann@example.com' });
  const notices = new FakeNoticeSource();
  notices.addAccount('acc_demoGithub', 'github', 'GitHub');
  const mail = new MailHub({ db: store.db, backend: fake, managerUrl: null, dataDir: dir, log: () => {} });
  mail.start();
  const manager = new DemoManager({ store, mail: fake, notices });
  manager.publish();
  const sup = { authorize: () => null, online: () => true, command: async () => ({}), restart: async () => {}, log: async () => '' } as any;
  const hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's', mail, manager });
  const url = `http://127.0.0.1:${hub.start().port}`;
  afterAll(() => {
    hub.stop();
    mail.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async <T = any>(method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: (await res.json().catch(() => null)) as T };
  };

  test('the bootstrap carries the manager’s list', async () => {
    const b = (await call<P.Bootstrap>('GET', '/api/bootstrap')).json;
    expect(b.accountsManager?.accounts?.map((a) => a.id)).toEqual(['acc_demoMail', 'acc_demoGithub', DEMO_UNGRANTED]);
  });

  test('kinds, asking for a kind and for mail on one account', async () => {
    const k = (await call<P.KindsPage>('GET', '/api/accounts/kinds')).json;
    expect(k.kinds?.find((x) => x.kind === 'proton')).toMatchObject({ manages: true });
    expect(k.kinds?.find((x) => x.kind === 'imap')).toMatchObject({ manages: false });
    expect((await call('POST', '/api/accounts/kinds/imap/ask')).status).toBe(200);
    expect((await call<P.KindsPage>('GET', '/api/accounts/kinds')).json.kinds?.find((x) => x.kind === 'imap')?.asked).toBe('pending');
    expect((await call('POST', `/api/accounts/${DEMO_UNGRANTED}/ask`, { interface: 'google.calendar' })).status).toBe(400);
    expect((await call('POST', `/api/accounts/${DEMO_UNGRANTED}/ask`, { interface: 'mail' })).status).toBe(200);
    const v = store.accountsManager!;
    expect(accountFeatures({ managed: v.accounts!.find((a) => a.id === DEMO_UNGRANTED), asks: v.asks }).map((f) => f.state)).toEqual(['asked']);
  });

  test('adding Proton Mail: an account that asks you to sign in; a chat network or a kind it may not add is refused', async () => {
    expect((await call('POST', '/api/accounts/managed', { kind: 'discord' })).status).toBe(400);
    expect((await call('POST', '/api/accounts/managed', { kind: 'imap', form: {} })).status).toBe(403);
    const r = await call<{ id: string }>('POST', '/api/accounts/managed', { kind: 'proton', label: 'Personal', form: {} });
    expect(r.status).toBe(200);
    const acc = mail.store.accountView(mail.store.account(r.json.id)!);
    expect(acc).toMatchObject({ kind: 'proton', label: 'Personal', online: false });
    expect(acc.problem?.message).toContain('Sign in to Proton');
    expect(store.accountsManager!.accounts!.some((a) => a.id === r.json.id && a.manages)).toBe(true);
    // Run through the manager: restart, its log, removing it.
    expect((await call('POST', `/api/accounts/${r.json.id}/action`, { action: 'restart' })).status).toBe(200);
    expect(await (await fetch(`${url}/api/accounts/${r.json.id}/log`)).text()).toContain('pretend dither-accounts');
    expect((await call('DELETE', `/api/accounts/${r.json.id}`)).status).toBe(200);
    expect(store.accountsManager!.accounts!.some((a) => a.id === r.json.id)).toBe(false);
  });
});
