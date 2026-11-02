/**
 * The hub over real sockets: TLS, the plaintext side listener, and who gets refused.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ATTACHMENT_LIMITS, MAX_UPLOAD } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { HubServer, isTailnet, mediaSigner, sameOrigin } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-srv-'));
const port = 18460 + Math.floor(Math.random() * 1000);
let server: HubServer;
let store: Store;

beforeAll(() => {
  Bun.spawnSync(['sh', resolve(import.meta.dir, '../../../scripts/tls-init.sh'), dir, 'hub.test.example'], { stdout: 'ignore' });
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const sup = { authorize: () => null, online: () => false } as any;
  server = new HubServer(store, sup, new Triage(store), {
    port,
    plainPort: port + 1,
    hostname: '127.0.0.1',
    dataDir: dir,
    webDist: dir,
    secret: 's',
    tls: { cert: join(dir, 'tls/server.crt'), key: join(dir, 'tls/server.key'), ca: join(dir, 'tls/ca.crt') },
  });
  server.start();
});

afterAll(() => {
  server.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ca = () => Bun.file(join(dir, 'tls/ca.crt')).text();

// Bun's TLS client cannot evaluate name constraints, so chain checks go through openssl and the rest skip them.
const tls = { rejectUnauthorized: false };

test('HTTPS verifies against the private CA and only against it', async () => {
  // Async: the server under test runs on this very event loop.
  const handshake = async (...args: string[]) => {
    const p = Bun.spawn(['openssl', 's_client', '-connect', `127.0.0.1:${port}`, '-verify_hostname', 'hub.test.example', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    return new Response(p.stdout).text();
  };
  expect(await handshake('-CAfile', join(dir, 'tls/ca.crt'))).toContain('Verify return code: 0 (ok)');
  expect(await handshake('-no-CAfile', '-no-CApath')).not.toContain('Verify return code: 0 (ok)');
  expect((await fetch(`https://127.0.0.1:${port}/api/health`, { tls })).status).toBe(200);
});

test('key files are private', async () => {
  for (const f of ['ca.key', 'server.key']) expect((await Bun.file(join(dir, 'tls', f)).stat()).mode & 0o077).toBe(0);
});

test('the plain listener serves the CA and sends everything else to HTTPS', async () => {
  const crt = await fetch(`http://127.0.0.1:${port + 1}/ca.crt`);
  expect(await crt.text()).toBe(await ca());
  const page = await fetch(`http://127.0.0.1:${port + 1}/trust`);
  expect(await page.text()).toContain('fingerprint');
  const res = await fetch(`http://127.0.0.1:${port + 1}/api/bootstrap?x=1`, { redirect: 'manual' });
  expect(res.status).toBe(307);
  expect(res.headers.get('location')).toBe(`https://127.0.0.1:${port}/api/bootstrap?x=1`);
});

test('the adapter socket still works in plaintext from this machine', async () => {
  const res = await fetch(`http://127.0.0.1:${port + 1}/adapter?account=a&token=t`);
  expect(res.status).toBe(401); // reached the token check
});

test('other sites cannot drive the hub', async () => {
  const opts = { method: 'POST', body: '{}', tls };
  const res = await fetch(`https://127.0.0.1:${port}/api/persons/merge`, { ...opts, headers: { origin: 'https://evil.example' } });
  expect(res.status).toBe(403);
  const mk = (origin: string | null, host: string) => new Request('https://x/', { headers: { host, ...(origin ? { origin } : {}) } });
  expect(sameOrigin(mk('https://hub:8460', 'hub:8460'))).toBe(true);
  expect(sameOrigin(mk(null, 'hub:8460'))).toBe(true);
  expect(sameOrigin(mk('https://hub:1', 'hub:8460'))).toBe(false);
  expect(sameOrigin(mk('null', 'hub:8460'))).toBe(false);
});

test('a missing hashed asset is a 404, not the app shell', async () => {
  const res = await fetch(`https://127.0.0.1:${port}/assets/gone.js`, { tls });
  expect(res.status).toBe(404);
});

test('tailnet ranges', () => {
  expect(isTailnet('100.64.0.20')).toBe(true);
  expect(isTailnet('fd7a:115c:a1e0::20')).toBe(true);
  expect(isTailnet('192.168.68.57')).toBe(false);
  expect(isTailnet('100.128.0.1')).toBe(false);
});

test('sidebar arrangement persists, field by field', () => {
  store.patchPlacePrefs([{ kind: 'space', id: 's1', position: 2 }]);
  store.patchPlacePrefs([{ kind: 'space', id: 's1', pinned: true }, { kind: 'conversation', id: 'c1', hidden: true, railed: true }]);
  const reopened = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const prefs = reopened.bootstrap().placePrefs;
  reopened.db.close();
  expect(prefs.find((p) => p.id === 's1')).toEqual({ kind: 'space', id: 's1', position: 2, pinned: true, hidden: false, open: false, railed: false });
  expect(prefs.find((p) => p.id === 'c1')).toMatchObject({ hidden: true, railed: true, position: null });
  store.patchPlacePrefs([{ kind: 'space', id: 's1', position: null }]);
  expect(store.placePrefs().find((p) => p.id === 's1')?.position).toBeNull();
  expect(store.flush().some((e) => e.t === 'placePrefs')).toBe(true);
});

test('deleting a folder forgets its arrangement', () => {
  store.setFolders([{ id: 'f1', name: 'F', icon: null, color: null, items: [] }]);
  store.patchPlacePrefs([{ kind: 'folder', id: 'f1', open: true }]);
  store.setFolders([]);
  expect(store.placePrefs().some((p) => p.id === 'f1')).toBe(false);
});

describe('starting a direct conversation', () => {
  const sent: any[] = [];
  let answer: (c: any) => unknown = () => ({});
  let online = true;
  const p3 = port + 5;
  let hub: HubServer;
  let acc: AccountRow;
  let bare: AccountRow;
  const open = (body: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${p3}/api/directs`, { method: 'POST', body: JSON.stringify(body), headers });
  beforeAll(() => {
    const sup = { authorize: () => null, online: () => online, command: async (id: string, c: any) => (sent.push([id, c]), answer(c)) } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: p3, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    hub.start();
    acc = store.createAccount({ network: 'matrix', label: 'mx', color: '#000', adapter: 'matrix' });
    bare = store.createAccount({ network: 'matrix', label: 'old', color: '#111', adapter: 'matrix' });
    store.ingest(acc, { t: 'hello', network: 'matrix', version: '1', capabilities: ['send', 'openDirect'] });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: '@me:x.org', isSelf: true } });
    store.ingest(bare, { t: 'hello', network: 'matrix', version: '1', capabilities: ['send'] });
  });
  afterAll(() => hub.stop());

  test('the adapter is asked, and its conversation comes back with a person on the other end', async () => {
    answer = () => {
      store.ingest(store.account(acc.id)!, { t: 'conversation', conversation: { nativeId: '!new:x.org', shape: 'direct', participants: ['@me:x.org', '@ann:x.org'] } });
      return { conversation: '!new:x.org', existed: false };
    };
    const res = await open({ accountId: acc.id, peer: ' @ann:x.org ' });
    expect(res.status).toBe(200);
    const r = (await res.json()) as any;
    expect(sent.at(-1)).toEqual([acc.id, { t: 'openDirect', peer: '@ann:x.org' }]);
    expect(r).toMatchObject({ existed: false, startsAtFirstSend: false, conversation: { shape: 'direct', nativeId: '!new:x.org' } });
    expect(r.conversation.peerPersonId).toBeTruthy();
    expect(r.conversation.lastMessageAt).toBeGreaterThan(0); // sorts as recent with no message yet
  });
  test('what cannot work is refused before any adapter hears of it', async () => {
    const asked = sent.length;
    expect((await open({ accountId: 'nope', peer: '@a:x.org' })).status).toBe(404);
    expect((await open({ accountId: bare.id, peer: '@a:x.org' })).status).toBe(409);
    expect((await open({ accountId: acc.id, peer: 'not an address' })).status).toBe(400);
    expect((await open({ accountId: acc.id, peer: '@me:x.org' })).status).toBe(400);
    online = false;
    expect((await open({ accountId: acc.id, peer: '@a:x.org' })).status).toBe(409);
    online = true;
    expect((await open({ accountId: acc.id, peer: '@a:x.org' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(sent.length).toBe(asked);
  });
  test("the network's refusal reaches the person who asked", async () => {
    answer = () => {
      throw new Error('There is no Matrix user @a:x.org');
    };
    const res = await open({ accountId: acc.id, peer: '@a:x.org' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toContain('no Matrix user');
  });
});

describe('what a reply from outside the composer may do', () => {
  const sent: any[] = [];
  const p4 = port + 4;
  let hub: HubServer;
  let mx: AccountRow;
  const send = (cnv: string, body: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${p4}/api/conversations/${hubId('cnv', 'matrix', cnv)}/send`, { method: 'POST', body: JSON.stringify(body), headers });
  beforeAll(() => {
    const sup = { authorize: () => null, online: () => true, command: async (_: string, c: any) => (sent.push(c), { nativeId: 'x' }) } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: p4, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    hub.start();
    mx = store.createAccount({ network: 'matrix', label: 'mxr', color: '#000', adapter: 'matrix' });
    store.ingest(mx, { t: 'hello', network: 'matrix', version: '1', capabilities: ['send'] });
    store.ingest(mx, { t: 'status', status: 'online', self: { nativeId: '@r:x.org', isSelf: true } });
    store.ingest(mx, { t: 'conversation', conversation: { nativeId: '!plain:x.org', shape: 'direct', participants: ['@r:x.org', '@ann:x.org'] } });
    store.ingest(mx, { t: 'conversation', conversation: { nativeId: '!group:x.org', shape: 'group', name: 'g' } });
    store.ingest(mx, { t: 'conversation', conversation: { nativeId: '!secret:x.org', shape: 'group', name: 's', encrypted: true } });
    store.ingest(mx, { t: 'conversation', conversation: { nativeId: '!forum:x.org', shape: 'channel', variant: 'forum', name: 'f' } });
  });
  afterAll(() => hub.stop());

  test('nothing goes out plaintext to an encrypted room, and the adapter is never asked', async () => {
    const before = sent.length;
    const res = await send('!secret:x.org', { body: 'hi' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain('Set up encryption');
    expect(sent.length).toBe(before);
  });
  test('the other composer rules hold here too', async () => {
    expect((await send('!forum:x.org', { body: 'hi' })).status).toBe(409);
    store.updateAccount(mx.id, { status: 'attention' });
    expect((await send('!plain:x.org', { body: 'hi' })).status).toBe(409);
    store.updateAccount(mx.id, { status: 'online' });
    expect((await send('!plain:x.org', { body: 'hi' })).status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ t: 'send', conversation: '!plain:x.org', body: 'hi' });
  });
  test('another site cannot use this send, whatever it knows', async () => {
    const before = sent.length;
    expect((await send('!plain:x.org', { body: 'hi' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(sent.length).toBe(before);
  });
  test('a push offers a reply only where a send would pass, and quotes outside DMs', () => {
    const f = (cnv: string) => hub.replyFields(hubId('cnv', 'matrix', cnv), 'msg_1');
    expect(f('!plain:x.org')).toEqual({ canReply: true });
    expect(f('!group:x.org')).toEqual({ canReply: true, replyTo: 'msg_1' });
    expect(f('!secret:x.org')).toEqual({});
    expect(f('!forum:x.org')).toEqual({});
    store.updateAccount(mx.id, { status: 'offline' });
    expect(f('!plain:x.org')).toEqual({});
    store.updateAccount(mx.id, { status: 'online' });
  });
  test('an adapter that can encrypt lifts the refusal, once it says so', async () => {
    store.ingest(store.account(mx.id)!, { t: 'hello', network: 'matrix', version: '2', capabilities: ['send', 'e2ee'] });
    expect((await send('!secret:x.org', { body: 'hi' })).status).toBe(200);
  });
});

test('edit and delete go through the account that wrote it, where the network allows', async () => {
  const sent: any[] = [];
  const sup = { authorize: () => null, online: () => true, command: async (id: string, c: any) => (sent.push([id, c]), undefined) } as any;
  const p2 = port + 2;
  const hub = new HubServer(store, sup, new Triage(store), { port: p2, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
  hub.start();
  const a = store.createAccount({ network: 'discord', label: 'mine', color: '#000', adapter: 'discord' });
  const n = store.createAccount({ network: 'signal', label: 'noedit', color: '#111', adapter: 'signal' });
  store.ingest(a, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true } });
  store.ingest(n, { t: 'status', status: 'online', self: { nativeId: 'sigme', isSelf: true } });
  store.ingest(a, { t: 'hello', network: 'discord', version: '1', capabilities: ['edit', 'redact'] });
  store.ingest(a, { t: 'conversation', conversation: { nativeId: 'cc', shape: 'group', name: 'c' } });
  store.ingest(n, { t: 'conversation', conversation: { nativeId: 'nc', shape: 'group', name: 'n' } });
  const fresh = store.account(a.id)!;
  store.ingest(fresh, { t: 'message', message: { nativeId: 'mine1', conversation: 'cc', author: 'me', ts: 5, body: 'x' } });
  store.ingest(fresh, { t: 'message', message: { nativeId: 'theirs', conversation: 'cc', author: 'them', ts: 6, body: 'y' } });
  store.ingest(store.account(n.id)!, { t: 'message', message: { nativeId: 'sig1', conversation: 'nc', author: 'sigme', ts: 7, body: 'z' } });
  const post = (id: string, verb: string, body: unknown = {}) => fetch(`http://127.0.0.1:${p2}/api/messages/${hubIdMsg(id)}/${verb}`, { method: 'POST', body: JSON.stringify(body) });
  const hubIdMsg = (nid: string) => store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nid)!.id;
  expect((await post('theirs', 'edit', { body: 'hacked' })).status).toBe(403);
  expect((await post('sig1', 'delete')).status).toBe(409);
  expect((await post('mine1', 'edit', { body: ' ' })).status).toBe(400);
  expect((await post('mine1', 'edit', { body: 'new' })).status).toBe(200);
  expect((await post('mine1', 'delete')).status).toBe(200);
  expect(sent.map(([id, c]) => [id, c.t, c.message, c.body])).toEqual([
    [a.id, 'edit', 'mine1', 'new'],
    [a.id, 'redact', 'mine1', undefined],
  ]);
  hub.stop();
});

describe('sending files', () => {
  const p3 = port + 3;
  const url = `http://127.0.0.1:${p3}`;
  const sent: any[] = [];
  let hub: HubServer;
  let d: AccountRow;
  const up = (body: BodyInit, headers: Record<string, string> = {}) => fetch(`${url}/api/uploads`, { method: 'POST', body, headers: { 'content-type': 'image/png', 'x-file-name': 'a%20b.png', ...headers } });
  const send = (conv: string, body: object) => fetch(`${url}/api/conversations/${conv}/send`, { method: 'POST', body: JSON.stringify(body) });
  const cid = (native: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', native)!.id;

  beforeAll(() => {
    const sup = {
      authorize: () => null,
      online: () => true,
      command: async (_id: string, c: any) => {
        if (c.conversation === 'fails') throw new Error('network said no');
        sent.push({ ...c, seen: c.attachments?.map((f: any) => readFileSync(f.path, 'utf8')) });
        return { nativeId: 'x' };
      },
    } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: p3, hostname: '127.0.0.1', dataDir: join(dir, 'files'), webDist: dir, secret: 's' });
    hub.start();
    d = store.createAccount({ network: 'discord', label: 'files', color: '#000', adapter: 'discord' });
    store.ingest(d, { t: 'hello', network: 'discord', version: '1', capabilities: ['send', 'sendMedia'] });
    store.ingest(d, { t: 'status', status: 'online' });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'ff', shape: 'group', name: 'f' } });
    store.ingest(d, { t: 'conversation', conversation: { nativeId: 'fails', shape: 'group', name: 'f' } });
  });
  afterAll(() => hub.stop());

  test('uploads, sends by id, and cleans up', async () => {
    const u = await (await up('png bytes')).json();
    expect(u).toMatchObject({ name: 'a b.png', mime: 'image/png', size: 9 });
    const res = await send(cid('ff'), { body: '', attachments: [u.id] });
    expect(res.status).toBe(200);
    const c = sent.at(-1);
    expect(c).toMatchObject({ t: 'send', conversation: 'ff', body: '' });
    expect(c.attachments[0]).toMatchObject({ name: 'a b.png', mime: 'image/png', size: 9, kind: 'image' });
    expect(c.seen).toEqual(['png bytes']);
    expect(existsSync(c.attachments[0].path)).toBe(false);
    expect((await send(cid('ff'), { body: '', attachments: [u.id] })).status).toBe(410);
  });
  test('a failed send keeps the file for a retry', async () => {
    const u = await (await up('again')).json();
    expect((await send(cid('fails'), { body: 'x', attachments: [u.id] })).status).toBe(500);
    expect((await send(cid('ff'), { body: 'x', attachments: [u.id] })).status).toBe(200);
  });
  test('refuses a cross-site page, an oversized file, a bad name and a network limit', async () => {
    expect((await up('x', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await up(new Uint8Array(MAX_UPLOAD + 1))).status).toBe(413);
    const named = await (await up('x', { 'x-file-name': '..%2F..%2Fetc%2Fpasswd' })).json();
    expect(named.name).toBe('passwd');
    const big = await (await up(new Uint8Array(ATTACHMENT_LIMITS.discord.bytes + 1))).json();
    expect((await send(cid('ff'), { attachments: [big.id] })).status).toBe(413);
  });
  test('an account without the capability is told so', async () => {
    const n = store.createAccount({ network: 'matrix', label: 'plain', color: '#111', adapter: 'matrix' });
    store.ingest(n, { t: 'hello', network: 'matrix', version: '1', capabilities: ['send'] });
    store.ingest(n, { t: 'status', status: 'online' });
    store.ingest(n, { t: 'conversation', conversation: { nativeId: 'mm', shape: 'group', name: 'm' } });
    const u = await (await up('x')).json();
    const res = await send(cid('mm'), { attachments: [u.id] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('cannot send files');
  });
  test('an empty message is still refused', async () => {
    expect((await send(cid('ff'), { body: '  ' })).status).toBe(400);
  });
});
