/**
 * The hub over real sockets: TLS, the plaintext side listener, and who gets refused.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HubServer, isTailnet, mediaSigner, sameOrigin } from '../src/server.ts';
import { Store } from '../src/store.ts';
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
