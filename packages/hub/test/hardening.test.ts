/**
 * What keeps the hub up and its data safe: names it answers to, where it fetches media from, which adapters it starts
 * and with what, secrets written whole, triage that survives a crash, migrations copied first, and the upkeep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { hostAllowed, hostNames } from '../src/hosts.ts';
import { fetchPublicToFile } from '../src/fetchsafe.ts';
import { adapterEntry, adapterEnv } from '../src/supervisor.ts';
import { HubServer, mediaSigner, validAdapterName } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { NightlyBackup, pruneMediaCache, rotateAdapterLogs, tightenPermissions } from '../src/housekeeping.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-hard-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the names the hub answers to', () => {
  const names = hostNames({ DITHER_PUBLIC_URL: 'https://chat.example.net', DITHER_ALLOWED_HOSTS: 'hub.lan, other.example' }, 'box');

  test('IP literals, localhost, this machine, its MagicDNS name and the configured names', () => {
    for (const h of ['127.0.0.1:8460', '100.64.0.10:8460', '[::1]:8460', '[fd7a:115c:a1e0::4]', 'localhost:5173', 'app.localhost', 'box', 'box:8460', 'box.tail1234.ts.net', 'chat.example.net', 'CHAT.example.net.', 'hub.lan', 'other.example:443', null])
      expect(hostAllowed(h, names)).toBe(true);
  });

  test('a rebound domain is refused', () => {
    for (const h of ['evil.example', 'evil.example:8460', 'chat.example.net.evil.example', 'box.evil.example', 'other.tail1234.ts.net', 'a.box.tail1234.ts.net'])
      expect(hostAllowed(h, names)).toBe(false);
  });
});

describe('fetching media someone else named', () => {
  const lookup = async (h: string) => ({ 'cdn.example': ['203.0.113.5'], 'inside.example': ['10.0.0.8'], 'moves.example': ['203.0.113.9'] })[h] ?? [];
  const body = (n: number) => new Uint8Array(n).fill(7);
  const fake = (routes: Record<string, () => Response>) => (async (url: string | URL | Request) => routes[String(url)]?.() ?? new Response('nope', { status: 404 })) as typeof fetch;
  const file = (name: string) => join(dir, name);

  test('a public URL lands in the file whole', async () => {
    const r = await fetchPublicToFile('https://cdn.example/a.png', file('a'), { lookup, fetch: fake({ 'https://cdn.example/a.png': () => new Response(body(1000), { headers: { 'content-type': 'image/png' } }) }) });
    expect(r).toEqual({ ok: true, mime: 'image/png', bytes: 1000 });
    expect(readFileSync(file('a')).length).toBe(1000);
    expect(statSync(file('a')).mode & 0o077).toBe(0);
  });

  test('loopback, the LAN, the tailnet and names that do not resolve are refused, before any request', async () => {
    let asked = 0;
    const counting = (async () => (asked++, new Response('x'))) as unknown as typeof fetch;
    for (const u of ['http://127.0.0.1:8460/api/accounts', 'http://[::1]/', 'http://10.1.2.3/', 'http://100.64.0.10/', 'http://169.254.169.254/latest', 'http://inside.example/', 'http://nowhere.example/', 'file:///etc/passwd', 'http://user:pw@cdn.example/'])
      expect((await fetchPublicToFile(u, file('b'), { lookup, fetch: counting })).ok).toBe(false);
    expect(asked).toBe(0);
    expect(existsSync(file('b'))).toBe(false);
  });

  test('a redirect is checked like the first address', async () => {
    const routes = {
      'https://moves.example/x': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8460/api/accounts' } }),
      'https://moves.example/y': () => new Response(null, { status: 301, headers: { location: '/z' } }),
      'https://moves.example/z': () => new Response(body(10), { headers: { 'content-type': 'image/gif' } }),
    };
    expect(await fetchPublicToFile('https://moves.example/x', file('c'), { lookup, fetch: fake(routes) })).toMatchObject({ ok: false, status: 403 });
    expect(await fetchPublicToFile('https://moves.example/y', file('c'), { lookup, fetch: fake(routes) })).toMatchObject({ ok: true, bytes: 10 });
  });

  test('past the size limit nothing is kept, declared or streamed', async () => {
    const declared = fake({ 'https://cdn.example/big': () => new Response(body(10), { headers: { 'content-length': '999999' } }) });
    expect(await fetchPublicToFile('https://cdn.example/big', file('d'), { lookup, fetch: declared, maxBytes: 100 })).toMatchObject({ ok: false, status: 413 });
    const streamed = fake({
      'https://cdn.example/stream': () =>
        new Response(new ReadableStream({ pull: (c) => c.enqueue(body(64)) }), { headers: { 'content-type': 'video/mp4' } }),
    });
    expect(await fetchPublicToFile('https://cdn.example/stream', file('d'), { lookup, fetch: streamed, maxBytes: 1000 })).toMatchObject({ ok: false, status: 413 });
    expect(readdirSync(dir).filter((f) => f.startsWith('d'))).toEqual([]);
  });
});

describe('adapters the hub starts', () => {
  test('a kind is a plain name, never a path', () => {
    for (const a of ['discord', 'matrix', 'chat-fake']) expect(validAdapterName(a)).toBe(true);
    for (const a of ['../x', 'x/../../y', 'Discord', '', 'a b', 'x'.repeat(40), 3]) expect(validAdapterName(a)).toBe(false);
    expect(adapterEntry(dir, 'x/../../../etc')).toBeNull();
  });

  test("dither-accounts' extractors come first, then DITHER_ADAPTERS_DIR, then this repo's copy", () => {
    const root = join(dir, 'repo');
    const mk = (p: string) => (mkdirSync(join(p, 'src'), { recursive: true }), writeFileSync(join(p, 'src', 'main.ts'), ''), join(p, 'src', 'main.ts'));
    const own = mk(join(root, 'packages', 'adapter-signal'));
    expect(adapterEntry(root, 'signal', {})).toBe(own);
    const sibling = mk(join(dir, 'dither-accounts', 'extractors', 'signal'));
    expect(adapterEntry(root, 'signal', {})).toBe(sibling);
    const custom = mk(join(dir, 'custom', 'signal'));
    expect(adapterEntry(root, 'signal', { DITHER_ADAPTERS_DIR: join(dir, 'custom') })).toBe(custom);
    expect(adapterEntry(root, 'matrix', {})).toBeNull();
  });

  test("the hub's own secrets stay out of an adapter's environment", () => {
    const env = adapterEnv({ PATH: '/bin', HOME: '/h', DITHER_TURN_SECRET: 'x', DITHER_NTFY_TOKEN: 'y', GITHUB_TOKEN: 'z', DITHER_DAVE_DIR: '/d', SOME_PASSWORD: 'p', DITHER_DATA: '/data' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', DITHER_DAVE_DIR: '/d', DITHER_DATA: '/data' });
  });
});

describe('secret.json', () => {
  const p = join(dir, 'acct', 'secret.json');
  beforeAll(() => mkdirSync(join(dir, 'acct'), { recursive: true }));

  test('written whole, private, with the last good copy kept', () => {
    writeSecretFile(p, { a: 1 });
    writeSecretFile(p, { a: 2 });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 2 });
    expect(JSON.parse(readFileSync(p + '.bak', 'utf8'))).toEqual({ a: 1 });
    expect(statSync(p).mode & 0o077).toBe(0);
    expect(readdirSync(join(dir, 'acct')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('a torn file reads as the backup, and a missing one as {}', () => {
    writeFileSync(p, '{"a": 3, "storeKe');
    expect(readSecretFile(p)).toEqual({ a: 1 });
    // A torn file is not saved as the backup.
    writeSecretFile(p, { a: 4 });
    expect(JSON.parse(readFileSync(p + '.bak', 'utf8'))).toEqual({ a: 1 });
    expect(readSecretFile(p)).toEqual({ a: 4 });
    expect(readSecretFile(join(dir, 'acct', 'none.json'))).toEqual({});
  });
});

describe('the store', () => {
  test('a database meeting a new schema is copied before it is migrated, and not again', () => {
    const d = join(dir, 'mig');
    mkdirSync(d);
    const path = join(d, 'hub.sqlite');
    new Store(path, mediaSigner('s')).db.close();
    expect(existsSync(join(d, 'backups'))).toBe(false);
    // As if opened by an older hub: its schema signature differs.
    const db = new Database(path);
    db.exec(`UPDATE meta SET value = 'old' WHERE key = 'schema_sig'`);
    db.close();
    new Store(path, mediaSigner('s')).db.close();
    const copies = readdirSync(join(d, 'backups'));
    expect(copies.length).toBe(1);
    expect(copies[0]).toMatch(/^pre-migrate-.*\.sqlite$/);
    new Store(path, mediaSigner('s')).db.close();
    expect(readdirSync(join(d, 'backups')).length).toBe(1);
  });

  describe('triage', () => {
    let store: Store;
    let acc: AccountRow;
    const msg = (conv: string, id: string, author: string, ts: number) => {
      store.ingest(acc, { t: 'message', message: { nativeId: id, conversation: conv, author, body: 'hi', ts }, live: true });
      return store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', id)!.id;
    };
    beforeAll(() => {
      store = new Store(':memory:', mediaSigner('s'));
      acc = store.createAccount({ network: 'discord', label: 'a', color: '#000', adapter: 'discord' });
      store.ingest(acc, { t: 'hello', network: 'discord', version: '1', capabilities: ['send'] });
      store.ingest(acc, { t: 'identity', identity: { nativeId: 'me', displayName: 'me', isSelf: true } } as any);
      for (const c of ['busy', 'mine']) store.ingest(acc, { t: 'conversation', conversation: { nativeId: c, shape: 'group', name: c } });
    });

    test('what a crash left undecided comes back in order; what is too old to notify is let go', () => {
      const [a, b, c] = ['p1', 'p2', 'p3'].map((n, i) => msg('busy', n, 'someone', 1000 + i));
      store.pendTriage([a], 1_000);
      store.pendTriage([b, c], 50_000);
      store.triageDone(c);
      expect(store.takePendingTriage(10_000)).toEqual([b]);
      expect(store.takePendingTriage(0)).toEqual([b]);
    });

    test('only rows nobody learns from are let go: old, in a place you never wrote, not voted, notified or explored', () => {
      const old = 1_000;
      const now = old + 100 * 86_400_000;
      const t = (id: string, decision: string, extra: Record<string, unknown> = {}) =>
        store.setTriage(id, { decision, score: 0.1, reasons: [], decidedBy: 'rules', ...extra } as any);
      const ids = ['q1', 'q2', 'q3', 'q4', 'q5'].map((n, i) => msg('busy', n, 'someone', 2000 + i));
      const mine = msg('mine', 'm1', 'someone', 3000);
      msg('mine', 'm2', 'me', 3001);
      const recent = msg('busy', 'r1', 'someone', 4000);
      t(ids[0], 'drop');
      t(ids[1], 'digest');
      t(ids[2], 'push');
      t(ids[3], 'drop', { explore: 'up' });
      t(ids[4], 'drop');
      store.triageFeedback(ids[4], 'push', old);
      t(mine, 'drop');
      t(recent, 'drop');
      store.db.query('UPDATE triage SET created_at = ? WHERE message_id != ?').run(old, recent);
      store.db.query('UPDATE triage SET created_at = ? WHERE message_id = ?').run(now - 86_400_000, recent);
      expect(store.pruneTriage(now, 90)).toBe(2);
      const left = new Set((store.db.query('SELECT message_id FROM triage').all() as { message_id: string }[]).map((r) => r.message_id));
      expect(left.has(ids[0]) || left.has(ids[1])).toBe(false);
      for (const id of [ids[2], ids[3], ids[4], mine, recent]) expect(left.has(id)).toBe(true);
    });
  });
});

describe('the server', () => {
  let port = 0;
  let url = '';
  let hub: HubServer;
  let store: Store;
  let answer: 'ok' | 'timeout' = 'ok';
  const sent: unknown[] = [];

  beforeAll(() => {
    store = new Store(':memory:', mediaSigner('s'));
    const sup = {
      authorize: () => null,
      online: () => true,
      command: async (_id: string, c: any) => {
        sent.push(c);
        if (answer === 'timeout') throw new Error('adapter timed out on send');
        return { nativeId: 'n' };
      },
      created: async () => {},
    } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: join(dir, 'srv'), webDist: dir, secret: 's' });
    port = hub.start().port!;
    url = `http://127.0.0.1:${port}`;
    const acc = store.createAccount({ network: 'discord', label: 'x', color: '#000', adapter: 'discord' });
    store.ingest(acc, { t: 'hello', network: 'discord', version: '1', capabilities: ['send'] });
    store.ingest(acc, { t: 'status', status: 'online' });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'c', shape: 'group', name: 'c' } });
  });
  afterAll(() => hub.stop());

  test('a request under a name the hub does not have gets nothing', async () => {
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
    const rebound = await fetch(`${url}/api/accounts`, { headers: { host: `evil.example:${port}` } });
    expect(rebound.status).toBe(421);
    expect(await rebound.text()).not.toContain('acc_');
  });

  test('an account cannot name an adapter outside the adapters', async () => {
    const res = await fetch(`${url}/api/accounts`, { method: 'POST', body: JSON.stringify({ network: 'discord', adapter: '../../../tmp/x' }) });
    expect(res.status).toBe(400);
    expect(store.accounts().length).toBe(1);
  });

  test('a send whose answer never came is not sent again by a retry', async () => {
    const conv = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'c'`)!.id;
    const send = () => fetch(`${url}/api/conversations/${conv}/send`, { method: 'POST', body: JSON.stringify({ body: 'once', clientId: 'tmp-1' }) });
    answer = 'timeout';
    const first = await send();
    expect(first.status).toBe(504);
    expect((await first.json()).unknown).toBe(true);
    answer = 'ok';
    const retry = await send();
    expect(retry.status).toBe(504);
    expect(sent.filter((c: any) => c.body === 'once').length).toBe(1);
  });

  test('media from a private address is refused', async () => {
    const path = mediaSigner('s')(`http://127.0.0.1:${port}/api/accounts`, null)!;
    expect((await fetch(`${url}${path}`)).status).toBe(403);
  });
});

describe('upkeep', () => {
  test("files other users could read are closed to them", () => {
    const d = join(dir, 'perm');
    mkdirSync(join(d, 'backups'), { recursive: true });
    writeFileSync(join(d, 'hub.sqlite'), '');
    writeFileSync(join(d, 'backups', 'old.sqlite'), '');
    chmodSync(join(d, 'hub.sqlite'), 0o644);
    chmodSync(join(d, 'backups', 'old.sqlite'), 0o644);
    chmodSync(join(d, 'backups'), 0o755);
    expect(tightenPermissions(d).length).toBe(4);
    for (const p of ['hub.sqlite', 'backups', 'backups/old.sqlite']) expect(statSync(join(d, p)).mode & 0o077).toBe(0);
    expect(tightenPermissions(d)).toEqual([]);
  });

  test('the media cache keeps the most recently shown files under its size', () => {
    const d = join(dir, 'media');
    mkdirSync(d);
    const now = Date.now();
    for (const [n, age] of [['a', 3], ['b', 2], ['c', 1]] as const) {
      writeFileSync(join(d, n), new Uint8Array(100));
      writeFileSync(join(d, n + '.mime'), 'image/png');
      const t = new Date(now - age * 3_600_000);
      utimesSync(join(d, n), t, t);
    }
    writeFileSync(join(d, 'x.123.tmp'), 'part');
    utimesSync(join(d, 'x.123.tmp'), new Date(now - 7_200_000), new Date(now - 7_200_000));
    expect(pruneMediaCache(d, 250, now)).toEqual({ removed: 2, bytes: 200 });
    expect(readdirSync(d).sort()).toEqual(['b', 'b.mime', 'c', 'c.mime']);
  });

  test('nightly copies: when due, the newest kept, a copy you made never touched', async () => {
    const d = join(dir, 'nightly');
    mkdirSync(join(d, 'backups'), { recursive: true });
    writeFileSync(join(d, 'backups', 'hub-before-x.sqlite'), 'mine');
    let now = new Date(2026, 10, 6, 4, 5).getTime();
    const b = new NightlyBackup({ dataDir: d, db: 'unused', hour: 4, keep: 2, now: () => now, copy: async (_from, to) => writeFileSync(to, String(now)) });
    expect(b.due()).toBe(true);
    for (let day = 0; day < 4; day++) {
      expect(await b.tick()).not.toBeNull();
      // Same night: not again.
      expect(await b.tick()).toBeNull();
      now += 86_400_000;
    }
    // Two days down: the first tick after, whatever the hour.
    now += 2 * 86_400_000 + 5 * 3_600_000;
    expect(await b.tick()).not.toBeNull();
    expect(b.list().length).toBe(2);
    expect(existsSync(join(d, 'backups', 'hub-before-x.sqlite'))).toBe(true);
    expect(readdirSync(join(d, 'backups')).some((f) => f.endsWith('.part'))).toBe(false);
  });

  test('a real copy of a live database', async () => {
    const d = join(dir, 'real');
    mkdirSync(d);
    const s = new Store(join(d, 'hub.sqlite'), mediaSigner('s'));
    s.db.exec(`INSERT INTO meta (key, value) VALUES ('probe', 'yes')`);
    const to = await new NightlyBackup({ dataDir: d, db: join(d, 'hub.sqlite') }).tick(true);
    s.db.close();
    expect(to).not.toBeNull();
    const copy = new Database(to!, { readonly: true });
    expect((copy.query(`SELECT value FROM meta WHERE key = 'probe'`).get() as { value: string }).value).toBe('yes');
    copy.close();
    expect(statSync(to!).mode & 0o077).toBe(0);
  });

  test('an adapter log past its size is rotated', () => {
    const d = join(dir, 'accounts', 'acc_1');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'adapter.log'), 'x'.repeat(2000));
    expect(rotateAdapterLogs(join(dir, 'accounts'), 1000)).toBe(1);
    expect(existsSync(join(d, 'adapter.log'))).toBe(false);
    expect(existsSync(join(d, 'adapter.log.1'))).toBe(true);
  });
});

describe('the protocol version an adapter speaks', () => {
  test('another version is flagged and stays flagged until a matching hello; none at all is taken as it is', async () => {
    const { PROTOCOL_VERSION } = await import('@dither-chat/protocol');
    const store = new Store(':memory:', mediaSigner('s'));
    const acc = store.createAccount({ network: 'matrix', label: 'm', color: '#000', adapter: 'matrix' });
    const attention = () => store.account(acc.id)!.attention;
    store.ingest(acc, { t: 'hello', network: 'matrix', version: '1', capabilities: [] });
    store.ingest(acc, { t: 'status', status: 'online' });
    expect(attention()).toBeNull();
    store.ingest(acc, { t: 'hello', network: 'matrix', version: '1', capabilities: [], protocol: PROTOCOL_VERSION + 1 });
    expect(JSON.parse(attention()!).message).toContain('update this hub');
    store.ingest(acc, { t: 'status', status: 'online' });
    expect(JSON.parse(attention()!).message).toContain(`protocol ${PROTOCOL_VERSION + 1}`);
    store.ingest(acc, { t: 'hello', network: 'matrix', version: '1', capabilities: [], protocol: PROTOCOL_VERSION });
    expect(attention()).toBeNull();
  });
});
