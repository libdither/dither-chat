/**
 * Remote images in mail (mail/images.ts, docs/mail-design.md §7): the token, the public internet only (no loopback,
 * link-local, private or tailnet address, however it is written or wherever the name points by the time the request
 * goes), redirects checked, not-an-image refused, the size cap, what is sent and what is served.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageProxy, imageToken, imageType, pinnedFetch, PROXY_UA, readImageToken } from '../src/mail/images.ts';
import { isPrivateAddress, resolvesPrivate } from '../src/webpush.ts';
import { demoPng } from '../src/mail/demo-html.ts';

const KEY = 'test-key';
const PNG = demoPng(4, 3, [0, 0, 0], [255, 255, 255]);
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'mail-img-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An upstream that records what reached it. */
function upstream(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; headers: Headers; init: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, headers: new Headers(init.headers), init });
    return answer(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}
const DNS: Record<string, string[]> = {
  'img.example': ['93.184.216.34'],
  'v6.example': ['2606:4700::1111'],
  'inside.example': ['127.0.0.1'],
  'mixed.example': ['93.184.216.34', '10.0.0.7'],
  'meta.example': ['169.254.169.254'],
  'tail.example': ['100.101.102.103'],
  'mapped.example': ['::ffff:127.0.0.1'],
};
const lookup = async (h: string) => DNS[h] ?? [];
const png = () => new Response(Buffer.from(PNG), { headers: { 'content-type': 'image/png' } });

describe('the token', () => {
  test('carries the message and the URL, signed', () => {
    const t = imageToken(KEY, 'mml_abc', 'https://img.example/a.png?x=1&y=2');
    expect(readImageToken(KEY, t)).toEqual({ messageId: 'mml_abc', url: 'https://img.example/a.png?x=1&y=2' });
  });

  test('another URL, another message or another key: refused', () => {
    const t = imageToken(KEY, 'mml_abc', 'https://img.example/a.png');
    const [m, , sig] = t.split('.');
    expect(readImageToken(KEY, `${m}.${Buffer.from('https://evil.example/').toString('base64url')}.${sig}`)).toBeNull();
    expect(readImageToken(KEY, t.replace('mml_abc', 'mml_abd'))).toBeNull();
    expect(readImageToken('other-key', t)).toBeNull();
    expect(readImageToken(KEY, 'garbage')).toBeNull();
    expect(readImageToken(KEY, `${t}x`)).toBeNull();
  });
});

describe('private addresses', () => {
  test('loopback, link-local, private and tailnet, in every spelling', () => {
    for (const ip of ['127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '172.16.5.4', '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.101.102.103', '224.0.0.1', '255.255.255.255', '::1', '::', '0:0:0:0:0:0:0:1', '[::1]', 'fe80::1', 'fe80::1%eth0', 'fd7a:115c:a1e0::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:6465:6667', '::7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2002:a00:1::', '2001:0:4136:e378::1', '127.1', '1.2.3'])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
  });

  test('the public internet stays public', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '2001:db8::1', '2002:5db8:d822::1', '::ffff:5db8:d822'])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
  });

  test('a URL written with a mapped IPv6 address is caught (URLs rewrite it in hex)', async () => {
    const host = new URL('http://[::ffff:127.0.0.1]/x').hostname;
    expect(host).toBe('[::ffff:7f00:1]');
    expect((await resolvesPrivate(host, lookup)).private).toBe(true);
  });
});

describe('pinnedFetch', () => {
  test('goes to the address it checked, with the name in Host and in TLS', async () => {
    const up = upstream(() => png());
    await pinnedFetch({ lookup, fetch: up.fetch, headers: { 'user-agent': PROXY_UA } })('https://img.example:8443/a.png?q=1');
    expect(up.seen[0].url).toBe('https://93.184.216.34:8443/a.png?q=1');
    expect(up.seen[0].headers.get('host')).toBe('img.example:8443');
    expect((up.seen[0].init as any).tls).toEqual({ serverName: 'img.example' });
    expect(up.seen[0].init.redirect).toBe('manual');
    expect(up.seen[0].headers.get('user-agent')).toBe(PROXY_UA);
    await pinnedFetch({ lookup, fetch: up.fetch })('http://v6.example/b.png');
    expect(up.seen[1].url).toBe('http://[2606:4700::1111]/b.png');
  });

  test('refuses names that point inside, even partly, and literal addresses inside', async () => {
    const up = upstream(() => png());
    const f = pinnedFetch({ lookup, fetch: up.fetch });
    for (const u of ['http://inside.example/', 'http://mixed.example/', 'http://meta.example/latest/meta-data/', 'http://tail.example/', 'http://mapped.example/', 'http://unknown.example/', 'http://localhost:8460/', 'http://app.localhost/', 'http://127.0.0.1:8486/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0x7f.1/', 'http://2130706433/', 'http://169.254.169.254/'])
      await expect(f(u)).rejects.toThrow('not a public address');
    expect(up.seen).toEqual([]);
  });

  test('a name that changes its answer between the check and the request (DNS rebinding) never reaches inside', async () => {
    let n = 0;
    const flip = async () => (n++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
    const up = upstream(() => png());
    const proxy = new ImageProxy({ dir: dir(), lookup: flip, fetch: up.fetch });
    await proxy.serve('http://rebind.example/a.png');
    expect(up.seen.map((s) => s.url).filter((u) => u.includes('127.0.0.1'))).toEqual([]);
  });
});

describe('the proxy', () => {
  test('an image: kept, served with the sandbox and nosniff; asked for as a browser would, without cookies or referrer', async () => {
    const up = upstream(() => png());
    const proxy = new ImageProxy({ dir: dir(), lookup, fetch: up.fetch });
    const r = await proxy.serve('https://img.example/logo.png');
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toStartWith('sandbox;');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('set-cookie')).toBeNull();
    const sent = up.seen[0].headers;
    expect(sent.get('user-agent')).toBe(PROXY_UA);
    expect(sent.get('cookie')).toBeNull();
    expect(sent.get('referer')).toBeNull();
    expect(sent.get('accept')).toContain('image/');
    // The second time from the cache.
    expect((await proxy.serve('https://img.example/logo.png')).status).toBe(200);
    expect(up.seen.length).toBe(1);
  });

  test('the type comes from the bytes, not from what the server says', async () => {
    const up = upstream(() => new Response(Buffer.from(PNG), { headers: { 'content-type': 'text/html' } }));
    const r = await new ImageProxy({ dir: dir(), lookup, fetch: up.fetch }).serve('https://img.example/x');
    expect(r.headers.get('content-type')).toBe('image/png');
  });

  test('not an image: refused, and not kept', async () => {
    const d = dir();
    const answers = ['<html><script>alert(1)</script></html>', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', '%PDF-1.4'];
    for (const body of answers) {
      const up = upstream(() => new Response(body, { headers: { 'content-type': 'image/png' } }));
      const r = await new ImageProxy({ dir: d, lookup, fetch: up.fetch }).serve(`https://img.example/${answers.indexOf(body)}`);
      expect(r.status).toBe(415);
    }
  });

  test('over 10 MB: refused, by its length or by what arrives', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 10);
    big.set(PNG);
    const told = upstream(() => new Response(Buffer.from(big), { headers: { 'content-length': String(big.length) } }));
    expect((await new ImageProxy({ dir: dir(), lookup, fetch: told.fetch }).serve('https://img.example/big')).status).toBe(413);
    const streamed = upstream(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 11; i++) c.enqueue(i === 0 ? big.subarray(0, 1024 * 1024) : new Uint8Array(1024 * 1024));
              c.close();
            },
          }),
        ),
    );
    expect((await new ImageProxy({ dir: dir(), lookup, fetch: streamed.fetch }).serve('https://img.example/stream')).status).toBe(413);
  });

  test('redirects are followed only to public addresses', async () => {
    const up = upstream((url) => (url.includes('93.184.216.34') && !url.includes('final') ? new Response(null, { status: 302, headers: { location: 'http://inside.example/secret.png' } }) : png()));
    const r = await new ImageProxy({ dir: dir(), lookup, fetch: up.fetch }).serve('https://img.example/a.png');
    expect(r.status).toBe(403);
    expect(up.seen.length).toBe(1);
    const ok = upstream((url) => (url.includes('final') ? png() : new Response(null, { status: 301, headers: { location: '/final.png' } })));
    expect((await new ImageProxy({ dir: dir(), lookup, fetch: ok.fetch }).serve('https://img.example/a.png')).status).toBe(200);
    expect(ok.seen[1].url).toBe('https://93.184.216.34/final.png');
    expect(ok.seen[1].headers.get('host')).toBe('img.example');
  });

  test('upstream errors are a plain 502; private names a 403', async () => {
    const up = upstream(() => new Response('gone', { status: 404 }));
    expect((await new ImageProxy({ dir: dir(), lookup, fetch: up.fetch }).serve('https://img.example/x')).status).toBe(502);
    expect((await new ImageProxy({ dir: dir(), lookup, fetch: up.fetch }).serve('http://inside.example/x')).status).toBe(403);
    expect((await new ImageProxy({ dir: dir(), lookup, fetch: up.fetch }).serve('ftp://img.example/x')).status).toBe(400);
  });

  test('kept 7 days, then fetched again', async () => {
    const d = dir();
    let now = Date.now();
    const up = upstream(() => png());
    const proxy = new ImageProxy({ dir: d, lookup, fetch: up.fetch, now: () => now });
    await proxy.serve('https://img.example/a.png');
    now += 6 * 86_400_000;
    await proxy.serve('https://img.example/a.png');
    expect(up.seen.length).toBe(1);
    now += 2 * 86_400_000;
    await proxy.serve('https://img.example/a.png');
    expect(up.seen.length).toBe(2);
  });

  test('imageType knows the browser images, not SVG', () => {
    expect(imageType(PNG)).toBe('image/png');
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageType(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(imageType(new TextEncoder().encode('<svg'))).toBeNull();
  });
});
