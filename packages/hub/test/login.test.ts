/**
 * The hub's login (auth.ts, docs/login.md): every route the hub has answers 401 without a session, from this machine
 * too (the proxy here reaches the hub from loopback); a password and a session, or the service token, open them; a
 * browser's write or socket must come from the hub's own page.
 *
 * The routes are not listed by hand: every path the hub's sources name (string and template literals, and the regexes
 * the router matches) is asked for, so a route added later is covered without touching this file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COOKIE, fileTicket, setPassword, TOKEN_FILE } from '../src/auth.ts';
import { GATED, HubServer, mediaSigner, PUBLIC_API, sameOrigin } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const PASSWORD = 'a-long-test-password';
let dir: string;
let store: Store;
let hub: HubServer;
let base: string;
let host: string;
let token: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-login-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const sup = { authorize: () => null, online: () => false, command: async () => ({}) } as any;
  hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: join(dir, 'data'), webDist: dir, secret: 's' });
  const port = hub.start().port!;
  base = `http://127.0.0.1:${port}`;
  host = `127.0.0.1:${port}`;
  token = readFileSync(join(dir, 'data', TOKEN_FILE), 'utf8').trim();
});

afterAll(() => {
  hub.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ every route

/** Every path the hub's sources name under a gated prefix, with a stand-in for each parameter. */
function routePaths(): string[] {
  const src = join(import.meta.dir, '../src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(src);
  const out = new Set<string>();
  const add = (p: string) => {
    const clean = p.replace(/[?#].*$/, '').replace(/\/+$/, '') || '/';
    if (GATED.test(clean) && /^[\w/.~-]+$/.test(clean)) out.add(clean);
  };
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    // '/api/…' and "/api/…"
    for (const m of text.matchAll(/['"](\/(?:api|media|emoji|voice|calendar|demo)[^'"\s]*)['"]/g)) add(m[1]);
    // `/api/…${id}…`
    for (const m of text.matchAll(/`(\/(?:api|media|emoji|voice|calendar|demo)[^`\s]*)`/g)) add(m[1].replace(/\$\{[^}]*\}/g, 'x1'));
    // /^\/api\/conversations\/([\w-]+)\/send$/ and the like
    // (an escape, or a character class, may hold a slash; the regex ends at the first other one)
    for (const m of text.matchAll(/\/\^(\\\/(?:api|media|emoji|voice|calendar|demo)(?:[^/\n\\[]|\\.|\[(?:[^\]\\\n]|\\.)*\])*)\/[a-z]*/g)) {
      let r = m[1].replace(/\\\//g, '/');
      // Groups (and alternations in them) become one stand-in; what is optional is left out.
      for (let i = 0; i < 4; i++) r = r.replace(/\((?:\?:)?[^()]*\)[?*]/g, '').replace(/\((?:\?:)?[^()]*\)\+?/g, 'x1');
      r = r.replace(/\\[dw]\+?|\[[^\]]*\][+*]?/g, 'x1').replace(/[?*+$\\]/g, '');
      add(r);
    }
  }
  return [...out].sort();
}

const PATHS = routePaths();
/** The sockets (an upgrade is not a plain request). */
const SOCKETS = ['/api/live', '/api/call', '/api/liveview/acc_x1', '/api/call/x1/voice', '/api/demo/callroom'];

/** A raw HTTP request, for an upgrade: its status line's code. */
async function upgradeStatus(path: string, headers: Record<string, string> = {}): Promise<number> {
  const port = Number(new URL(base).port);
  let data = '';
  const done = Promise.withResolvers<void>();
  const sock = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, d) {
        data += d.toString();
        if (data.includes('\r\n')) done.resolve();
      },
      close() {
        done.resolve();
      },
      error() {
        done.resolve();
      },
    },
  });
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`);
  await done.promise;
  sock.end();
  return Number(data.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
}

describe('without a session', () => {
  test('the sources name the routes (the scan works)', () => {
    expect(PATHS.length).toBeGreaterThan(200);
    for (const p of ['/api/bootstrap', '/api/mail', '/api/attention', '/api/devices', '/api/sync', '/api/live', '/api/errors', '/api/uploads', '/api/imports', '/api/push/subscribe', '/api/sessions'])
      expect(PATHS).toContain(p);
    expect(PATHS.some((p) => p.startsWith('/api/liveview/'))).toBe(true);
    expect(PATHS.some((p) => p.startsWith('/api/conversations/') && p.endsWith('/send'))).toBe(true);
  });

  test('every route answers 401, from this machine too, whatever the method', async () => {
    const wrong: string[] = [];
    for (const p of PATHS) {
      if (PUBLIC_API.has(p)) continue;
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        // A browser's own page (Origin = Host) and a program (no Origin) alike.
        for (const origin of [base, null]) {
          const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: method === 'GET' ? undefined : '{}' });
          if (res.status !== 401) wrong.push(`${method} ${p}${origin ? '' : ' (no Origin)'}: ${res.status}`);
          await res.arrayBuffer();
        }
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  test('a proxy on this machine (X-Forwarded-For, X-Forwarded-Proto) is no way in', async () => {
    for (const p of ['/api/bootstrap', '/api/mail', '/api/attention', '/api/devices']) {
      const res = await fetch(base + p, { headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'localhost' } });
      expect(res.status).toBe(401);
    }
  });

  test('every socket is refused before it opens', async () => {
    for (const p of SOCKETS) expect(await upgradeStatus(p, { Origin: base })).toBe(401);
  });

  test('a wrong token or cookie is nobody', async () => {
    expect((await fetch(`${base}/api/bootstrap`, { headers: { authorization: 'Bearer nope-nope-nope-nope-nope-nope-nope-nope' } })).status).toBe(401);
    expect((await fetch(`${base}/api/bootstrap`, { headers: { cookie: `${COOKIE}=forged` } })).status).toBe(401);
  });

  test('only the login, a bare health check and the app files answer', async () => {
    const h = await fetch(`${base}/api/health`);
    expect(h.status).toBe(200);
    expect(Object.keys(await h.json()).sort()).toEqual(['now', 'ok']);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>app</title>');
    // A path no route knows is the app's shell, never a route.
    expect(await (await fetch(`${base}/conversations`)).text()).toContain('<title>app</title>');
    const l = await (await fetch(`${base}/api/login`)).json();
    expect(l).toMatchObject({ signedIn: false, passwordSet: false, user: 'admin', open: false });
  });

  test('with no password set, nothing opens and the answer says how to set one', async () => {
    const res = await fetch(`${base}/api/bootstrap`);
    expect(res.status).toBe(401);
    const b = await res.json();
    expect(b.setup).toBe(true);
    expect(b.error).toContain('set-password');
    const tried = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'anything-at-all' }) });
    expect(tried.status).toBe(503);
  });
});

// ------------------------------------------------------------------ signing in

const login = (password: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ username: 'admin', password }) });
const cookieFrom = (res: Response) => res.headers.get('set-cookie')!.split(';')[0];

describe('with a password', () => {
  beforeAll(async () => {
    await setPassword(join(dir, 'data'), PASSWORD);
  });

  test('the service token opens everything, without an Origin', async () => {
    const auth = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/api/bootstrap`, { headers: auth })).status).toBe(200);
    const h = await (await fetch(`${base}/api/health`, { headers: auth })).json();
    expect(h.gapRestarts).toBe(0);
    const t = await fetch(`${base}/api/ticket`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ url: '/media/abc/def' }) });
    expect(t.status).toBe(200);
  });

  test('the service token can make a session for a browser a script drives; a session cannot', async () => {
    const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const { name, value } = await r.json();
    expect(name).toBe(COOKIE);
    const cookie = `${name}=${value}`;
    expect((await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { cookie, origin: base } })).status).toBe(403);
  });

  test('a wrong password is refused; the right one gives an HttpOnly, SameSite cookie', async () => {
    expect((await login('not-the-password')).status).toBe(401);
    const ok = await login(PASSWORD);
    expect(ok.status).toBe(200);
    const c = ok.headers.get('set-cookie')!;
    expect(c).toContain(`${COOKIE}=`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).not.toContain('Secure');
    // Behind the proxy on this machine, over https: Secure.
    expect((await login(PASSWORD, { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).toContain('Secure');
  });

  test('a login from another site is refused', async () => {
    expect((await login(PASSWORD, { origin: 'https://evil.example' })).status).toBe(403);
    const none = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
    expect(none.status).toBe(403);
  });

  test('a session reads; its writes and sockets must come from this page', async () => {
    const cookie = cookieFrom(await login(PASSWORD));
    expect((await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).status).toBe(200);
    expect((await (await fetch(`${base}/api/login`, { headers: { cookie } })).json()).signedIn).toBe(true);
    const write = (headers: Record<string, string>) => fetch(`${base}/api/ticket`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ url: '/media/abc/def' }) });
    expect((await write({ origin: base })).status).toBe(200);
    expect((await write({ referer: `${base}/` })).status).toBe(200);
    expect((await write({})).status).toBe(403); // no Origin: not this page
    expect((await write({ origin: 'https://evil.example' })).status).toBe(403);
    expect(await upgradeStatus('/api/live', { Cookie: cookie, Origin: base })).toBe(101);
    expect(await upgradeStatus('/api/live', { Cookie: cookie, Origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus('/api/live', { Cookie: cookie })).toBe(403);
  });

  test('sessions are listed, signed out one by one, and logging out ends this one', async () => {
    const a = cookieFrom(await login(PASSWORD));
    const b = cookieFrom(await login(PASSWORD));
    const list = (await (await fetch(`${base}/api/sessions`, { headers: { cookie: a } })).json()).sessions as { id: string; current: boolean }[];
    expect(list.filter((s) => s.current).length).toBe(1);
    const other = list.find((s) => !s.current)!;
    // b is one of the others: sign every other out from a.
    expect((await fetch(`${base}/api/sessions?others=1`, { method: 'DELETE', headers: { cookie: a, origin: base } })).status).toBe(200);
    expect((await fetch(`${base}/api/bootstrap`, { headers: { cookie: b } })).status).toBe(401);
    expect(other.id).toBeTruthy();
    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie: a, origin: base } });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(out.headers.get('clear-site-data')).toContain('storage');
    expect((await fetch(`${base}/api/bootstrap`, { headers: { cookie: a } })).status).toBe(401);
  });

  test('setting the password again signs every device out', async () => {
    const cookie = cookieFrom(await login(PASSWORD));
    await setPassword(join(dir, 'data'), PASSWORD);
    expect((await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).status).toBe(401);
  });

  test('a file ticket opens one media path for a few minutes, nothing else', async () => {
    const path = '/media/abcdefghijklmnop/aHR0cHM6Ly9leGFtcGxlLmNvbS94LnBuZw';
    const good = fileTicket('s', path);
    // Past the login (the media route's own signature check answers, not the login).
    expect((await fetch(`${base}${path}?ticket=${good}`)).status).not.toBe(401);
    expect((await fetch(`${base}/media/other/aaaa?ticket=${good}`)).status).toBe(401);
    expect((await fetch(`${base}/api/bootstrap?ticket=${good}`)).status).toBe(401);
    const old = fileTicket('s', path, Date.now() - 10 * 60_000);
    expect((await fetch(`${base}${path}?ticket=${old}`)).status).toBe(401);
  });

  test('wrong passwords back off', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await login('wrong-password', { 'x-forwarded-for': '203.0.113.9' })).status);
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses).toContain(429);
  });
});

test('no Origin is no browser write', () => {
  const mk = (h: Record<string, string>) => new Request('http://x/', { headers: { host: 'hub:8460', ...h } });
  expect(sameOrigin(mk({}))).toBe(false);
  expect(sameOrigin(mk({ origin: 'http://hub:8460' }))).toBe(true);
  expect(sameOrigin(mk({ referer: 'http://hub:8460/#/inbox' }))).toBe(true);
  expect(sameOrigin(mk({ origin: 'null' }))).toBe(false);
});
