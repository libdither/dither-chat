/** The desktop helper, against a fake hub and a recording opener (fixtures/record.ts): nothing is ever opened. */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGioMime } from '../src/apps.ts';
import { createDesk, hubFileUrl, pairedFile, readPaired, safeFilename, safeLink, startPairing, type DeskConfig } from '../src/desk.ts';

const fixtures = join(import.meta.dir, 'fixtures');
const root = mkdtempSync(join(tmpdir(), 'desk-test-'));
const log = join(root, 'opened.log');
const recorder = ['bun', join(fixtures, 'record.ts'), log];

const hub = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === '/media/sig/big') return new Response(new Uint8Array(2048));
    if (p === '/media/sig/redirect') return Response.redirect('http://example.com/x', 302);
    if (p === '/media/sig/elf') return new Response(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2]));
    if (p.startsWith('/media/') || p.startsWith('/emoji/')) return new Response(`file at ${p}`);
    return new Response('no', { status: 404 });
  },
});
const HUB = `http://127.0.0.1:${hub.port}`;
const EVIL = 'https://evil.example';

let config: DeskConfig;
let desk: ReturnType<typeof Bun.serve>;
let base = '';

beforeEach(() => {
  const dir = mkdtempSync(join(root, 'run-'));
  config = { configDir: join(dir, 'config'), downloadDir: join(dir, 'Downloads', 'dither'), openCmd: recorder, gioCmd: recorder, appDirs: [join(fixtures, 'applications')], maxBytes: 1024 };
  desk?.stop(true);
  desk = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createDesk(config) });
  base = `http://127.0.0.1:${desk.port}`;
  rmSync(log, { force: true });
});

afterAll(() => {
  desk?.stop(true);
  hub.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const opened = (): string[][] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function call(path: string, opts: { origin?: string | null; token?: string; body?: unknown; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.origin !== null) headers.origin = opts.origin ?? HUB;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(base + path, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

async function pair(origin = HUB): Promise<string> {
  const code = startPairing(config);
  const r = await call('/pair', { origin, body: { code } });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

describe('pairing', () => {
  test('hello says whether it is paired, and hides nothing it should not', async () => {
    let r = await call('/hello');
    expect(r.headers.get('access-control-allow-origin')).toBe(HUB);
    expect(await r.json()).toEqual({ app: 'dither-desk', version: expect.any(String), paired: false });
    await pair();
    r = await call('/hello');
    expect(await r.json()).toMatchObject({ paired: true });
    // Another page no longer gets an answer it may read.
    r = await call('/hello', { origin: EVIL });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('a code pairs once, from the page that sends it, and the token is stored 0600', async () => {
    const code = startPairing(config);
    const r = await call('/pair', { body: { code: code.toLowerCase().replace('-', ' ') } });
    expect(r.status).toBe(200);
    const p = readPaired(config)!;
    expect(p.origin).toBe(HUB);
    expect(statSync(pairedFile(config)).mode & 0o777).toBe(0o600);
    // Used up.
    expect((await call('/pair', { origin: EVIL, body: { code } })).status).toBe(403);
  });

  test('wrong codes count, and five of them void the code', async () => {
    const code = startPairing(config);
    for (let i = 0; i < 5; i++) expect((await call('/pair', { body: { code: 'AAAA-AAAA' } })).status).toBe(403);
    expect((await call('/pair', { body: { code } })).status).toBe(403);
    expect(readPaired(config)).toBeNull();
  });

  test('a code made for one origin does not pair another', async () => {
    const code = startPairing(config, HUB);
    expect((await call('/pair', { origin: EVIL, body: { code } })).status).toBe(403);
    expect((await call('/pair', { body: { code } })).status).toBe(200);
  });

  test('an expired code does not pair', async () => {
    const code = startPairing(config, undefined, Date.now() - 6 * 60_000);
    expect((await call('/pair', { body: { code } })).status).toBe(403);
  });

  test('no pairing without a pending code', async () => {
    expect((await call('/pair', { body: { code: 'ABCD-EFGH' } })).status).toBe(403);
  });
});

describe('who may use it', () => {
  test('unpaired, it refuses everything but hello', async () => {
    for (const [path, body] of [['/open', { url: 'https://example.com' }], ['/open-file', { url: '/media/a/b', name: 'a.txt' }]] as const) expect((await call(path, { body })).status).toBe(403);
    expect((await call('/apps?mime=text/plain')).status).toBe(403);
    expect(opened()).toEqual([]);
  });

  test('the paired origin needs its token, and the token needs its origin', async () => {
    const token = await pair();
    const body = { url: 'https://example.com/' };
    expect((await call('/open', { body })).status).toBe(401);
    expect((await call('/open', { body, token: 'x'.repeat(43) })).status).toBe(401);
    expect((await call('/open', { body, token, origin: EVIL })).status).toBe(403);
    expect((await call('/open', { body, token, origin: null })).status).toBe(403);
    expect((await call('/open', { body, token, origin: HUB + '/' })).status).toBe(403);
    expect(opened()).toEqual([]);
    expect((await call('/open', { body, token })).status).toBe(200);
    expect(opened()).toEqual([['https://example.com/']]);
  });

  test('a page that rebinds its name to loopback is refused by Host', async () => {
    const token = await pair();
    const r = await call('/open', { body: { url: 'https://example.com/' }, token, headers: { host: 'evil.example:8475' } });
    expect(r.status).toBe(403);
    expect(opened()).toEqual([]);
  });

  test('preflights answer the paired origin only, with the private network header', async () => {
    await pair();
    let r = await call('/open', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe(HUB);
    expect(r.headers.get('access-control-allow-private-network')).toBe('true');
    r = await call('/open', { method: 'OPTIONS', origin: EVIL });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('unpair forgets the page', async () => {
    const token = await pair();
    expect((await call('/unpair', { body: {}, token })).status).toBe(200);
    expect(readPaired(config)).toBeNull();
    expect((await call('/open', { body: { url: 'https://example.com/' }, token })).status).toBe(403);
  });
});

describe('opening links', () => {
  test('only http, https and mailto, passed as one argument', async () => {
    const token = await pair();
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'ftp://x', '--help', 'https://a.example/ x', 'data:text/html,hi', 123])
      expect((await call('/open', { body: { url }, token })).status).toBe(400);
    expect(opened()).toEqual([]);
    const tricky = 'https://example.com/a;rm%20-rf%20~&b=$(id)|`x`';
    expect((await call('/open', { body: { url: 'mailto:someone@example.com' }, token })).status).toBe(200);
    expect((await call('/open', { body: { url: tricky }, token })).status).toBe(200);
    expect(opened()).toEqual([['mailto:someone@example.com'], [new URL(tricky).href]]);
  });

  test('safeLink normalizes and refuses', () => {
    expect(safeLink('HTTPS://Example.com')).toBe('https://example.com/');
    expect(safeLink('https://exa\nmple.com')).toBeNull();
    expect(safeLink('http:///nohost')).toBe('http://nohost/');
    expect(safeLink('http://')).toBeNull();
  });

  test('a failing opener is reported', async () => {
    const token = await pair();
    config.openCmd = ['false'];
    const r = await call('/open', { body: { url: 'https://example.com/' }, token });
    expect(r.status).toBe(502);
  });
});

describe('apps for a type', () => {
  test('gio output parses, default first, each once', () => {
    const out = 'Default application for “text/plain”: a.desktop\nRegistered applications:\n\tb.desktop\n\ta.desktop\nRecommended applications:\n\tc.desktop\n';
    expect(parseGioMime(out)).toEqual(['a.desktop', 'b.desktop', 'c.desktop']);
    expect(parseGioMime('No default applications for “x/y”\n')).toEqual([]);
  });

  test('lists named apps, skipping hidden and missing ones', async () => {
    const token = await pair();
    const r = await call('/apps?mime=text/plain', { token });
    expect(await r.json()).toEqual({
      apps: [
        { id: 'editor.desktop', name: 'Editor' },
        { id: 'other.desktop', name: 'Other App' },
        { id: 'kde-viewer.desktop', name: 'Viewer' },
      ],
    });
    expect((await call('/apps?mime=not a type', { token })).status).toBe(400);
    expect((await call('/apps?mime=text/plain;rm', { token })).status).toBe(400);
  });
});

describe('opening files', () => {
  const file = (over: Record<string, unknown> = {}) => ({ url: `${HUB}/media/sig/abc?a=acc_1`, name: 'notes.txt', mime: 'text/plain', ...over });

  test('downloads a hub file into the folder and opens it', async () => {
    const token = await pair();
    const r = await call('/open-file', { body: file(), token });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, saved: 'notes.txt' });
    const path = join(config.downloadDir, 'notes.txt');
    expect(readFileSync(path, 'utf8')).toBe('file at /media/sig/abc');
    expect(statSync(path).mode & 0o111).toBe(0);
    expect(opened()).toEqual([[path]]);
  });

  test('a relative /media/ path works; the same name gets a new one', async () => {
    const token = await pair();
    await call('/open-file', { body: file({ url: '/media/sig/abc' }), token });
    const r = await call('/open-file', { body: file({ url: '/emoji/x.png' }), token });
    expect(await r.json()).toMatchObject({ saved: 'notes (2).txt' });
    expect(readdirSync(config.downloadDir).sort()).toEqual(['notes (2).txt', 'notes.txt']);
  });

  test('only /media/ and /emoji/ on the paired origin', async () => {
    const token = await pair();
    for (const url of [`${HUB}/api/bootstrap`, `${HUB}/index.html`, 'https://example.com/media/sig/abc', `http://localhost:${hub.port}/media/sig/abc`, `${HUB}/media/`, 'file:///etc/passwd', `http://u:p@127.0.0.1:${hub.port}/media/a/b`])
      expect((await call('/open-file', { body: file({ url }), token })).status).toBe(400);
    expect(opened()).toEqual([]);
  });

  test('no redirects away from the hub, and a size cap', async () => {
    const token = await pair();
    expect((await call('/open-file', { body: file({ url: '/media/sig/redirect' }), token })).status).toBe(502);
    expect((await call('/open-file', { body: file({ url: '/media/sig/big' }), token })).status).toBe(413);
    expect(existsSync(config.downloadDir) ? readdirSync(config.downloadDir) : []).toEqual([]);
    expect(opened()).toEqual([]);
  });

  test('a file that can run code is saved but not opened by default', async () => {
    const token = await pair();
    for (const [name, url] of [['evil.desktop', '/media/sig/x'], ['run.sh', '/media/sig/x'], ['photo.jpg', '/media/sig/elf'], ['noext', '/media/sig/x']]) {
      const r = await call('/open-file', { body: file({ name, url }), token });
      expect(r.status).toBe(422);
    }
    expect(opened()).toEqual([]);
  });

  test('an app must be one /apps lists for that type, and is launched through gio', async () => {
    const token = await pair();
    for (const app of ['notlisted.desktop', 'hidden.desktop', 'missing.desktop', '../editor.desktop', '/usr/share/applications/editor.desktop', '-x.desktop'])
      expect([400, 403, 404]).toContain((await call('/open-file', { body: file({ app }), token })).status);
    expect((await call('/open-file', { body: file({ app: 'editor.desktop', mime: 'none/thing' }), token })).status).toBe(403);
    expect(opened().filter((a) => a[0] !== 'mime')).toEqual([]);
    const r = await call('/open-file', { body: file({ app: 'kde-viewer.desktop' }), token });
    expect(r.status).toBe(200);
    const launch = opened().filter((a) => a[0] === 'launch');
    expect(launch).toEqual([['launch', join(fixtures, 'applications', 'kde', 'viewer.desktop'), join(config.downloadDir, 'notes.txt')]]);
  });
});

describe('file names', () => {
  test('one safe path segment', () => {
    expect(safeFilename('../../.bashrc')).toBe('_.._.bashrc');
    expect(safeFilename('..')).toBe('file');
    expect(safeFilename('.hidden')).toBe('hidden');
    expect(safeFilename('-rf.txt')).toBe('rf.txt');
    expect(safeFilename('a/b\\c:d*e?.pdf')).toBe('a_b_c_d_e_.pdf');
    expect(safeFilename('evil\u202egnp.exe')).toBe('evilgnp.exe');
    expect(safeFilename('line\nbreak.txt')).toBe('linebreak.txt');
    expect(safeFilename('trailing. . ')).toBe('trailing');
    expect(safeFilename('')).toBe('file');
    expect(safeFilename(null, 'emoji')).toBe('emoji');
    const long = safeFilename('ü'.repeat(300) + '.pdf');
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  test('hubFileUrl', () => {
    expect(hubFileUrl('/media/a/b?a=1', 'https://hub.example')?.href).toBe('https://hub.example/media/a/b?a=1');
    expect(hubFileUrl('//other.example/media/a', 'https://hub.example')).toBeNull();
    expect(hubFileUrl('/media/../api/x', 'https://hub.example')).toBeNull();
  });
});

test('the opener is never a shell', () => {
  const src = readFileSync(join(import.meta.dir, '../src/desk.ts'), 'utf8');
  expect(src).not.toMatch(/shell:\s*true|['"]sh['"]|['"]-c['"]|\$`/);
  writeFileSync(join(root, 'ok'), '');
});
