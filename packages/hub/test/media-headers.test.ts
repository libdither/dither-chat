/**
 * Attachment bytes are served from the hub's own origin, so a hostile type must not run there: nosniff and a sandbox on
 * every response, and a download for anything that is not an image, video or audio file (mediaheaders.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentDisposition, inlineType, mediaHeaders, safeFilename, safeMime } from '../src/mediaheaders.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

describe('which types render inline', () => {
  test('image, video and audio files do', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'audio/ogg', 'audio/mpeg', 'IMAGE/PNG', 'image/png; charset=binary']) expect(inlineType(t)).toBe(true);
  });

  test('anything that can run or script does not', () => {
    for (const t of ['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml', 'image/svg+xml', 'IMAGE/SVG+XML', 'image/svg+xml; charset=utf-8', 'application/xml', 'text/xml', 'application/pdf', 'text/plain', 'application/javascript', 'text/javascript', 'application/octet-stream', 'application/zip', 'image/vnd.foo+xml', 'image/html', 'video/x-html', 'multipart/x-mixed-replace', ''])
      expect(inlineType(t)).toBe(false);
  });

  test('a content type that is not a type is opaque bytes', () => {
    for (const t of ['', 'text', 'text/html\r\nset-cookie: a=b', 'image/png\nx: y', 'a b/c', 'é/é', '/png'])
      expect(safeMime(t)).toBe('application/octet-stream');
    expect(safeMime('image/png')).toBe('image/png');
    expect(safeMime('text/html; charset=utf-8')).toBe('text/html; charset=utf-8');
  });
});

describe('file names in Content-Disposition', () => {
  test('control characters, quotes and path parts are gone', () => {
    expect(safeFilename('a"b\r\nc.html')).toBe('a_bc.html');
    expect(safeFilename('../../etc/passwd')).not.toMatch(/[\\/]/);
    expect(safeFilename('.hidden')).toBe('hidden');
    expect(safeFilename('x\u0000y\u202ez.svg')).toBe('xyz.svg');
    expect(safeFilename('a'.repeat(500)).length).toBe(100);
  });

  test('the header keeps one line, one quoted name and a UTF-8 form', () => {
    const d = attachmentDisposition('https://cdn.example/files/r%C3%A9sum%C3%A9%20%22x%22.html', 'abcdef0123456789', 'text/html');
    expect(d).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/);
    expect(d).not.toMatch(/[\r\n]/);
    expect(d.match(/filename="([^"]*)"/)![1]).not.toContain('"');
    expect(d).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20_x_.html");
  });

  test('a link without a name gets one from the cache key and the type', () => {
    expect(attachmentDisposition('mxc://server/abc', 'abcdef0123456789', 'image/svg+xml')).toBe(`attachment; filename="attachment-abcdef012345.svg"; filename*=UTF-8''attachment-abcdef012345.svg`);
    expect(attachmentDisposition('mxc://server/abc', 'abcdef0123456789', 'application/x-weird')).toContain('attachment-abcdef012345.bin');
  });

  test('a header injection in a name or type cannot add a header', () => {
    const h = mediaHeaders('https://cdn.example/a%0D%0Aset-cookie:%20x=1.html', 'k'.repeat(64), 'text/html\r\nset-cookie: x=1');
    for (const v of Object.values(h)) expect(v).not.toMatch(/[\r\n]/);
    expect(h['content-type']).toBe('application/octet-stream');
  });
});

describe('the media route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-mh-'));
  const port = 20460 + Math.floor(Math.random() * 500);
  const url = `http://127.0.0.1:${port}`;
  const sign = mediaSigner('s');
  const served: Record<string, { mime: string; body: string }> = {
    'mxc://hs/html': { mime: 'text/html', body: '<script>alert(1)</script>' },
    'mxc://hs/svg': { mime: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
    'mxc://hs/xml': { mime: 'application/xml', body: '<a/>' },
    'mxc://hs/xhtml': { mime: 'application/xhtml+xml', body: '<html xmlns="http://www.w3.org/1999/xhtml"/>' },
    'mxc://hs/pdf': { mime: 'application/pdf', body: '%PDF-1.4' },
    'mxc://hs/png': { mime: 'image/png', body: 'png' },
    'mxc://hs/mp4': { mime: 'video/mp4', body: 'mp4' },
    'mxc://hs/ogg': { mime: 'audio/ogg', body: 'ogg' },
    'mxc://hs/odd': { mime: 'text/html\r\nx-evil: 1', body: 'x' },
  };
  let hub: HubServer;
  let acc: string;

  beforeAll(() => {
    const store = new Store(':memory:', sign);
    const sup = {
      authorize: () => null,
      online: () => true,
      command: async (_id: string, c: any) => {
        const s = served[c.url];
        if (!s) throw new Error('nope');
        return { mime: s.mime, base64: Buffer.from(s.body).toString('base64') };
      },
      created: async () => {},
    } as any;
    hub = new HubServer(store, sup, new Triage(store), { port, hostname: '127.0.0.1', dataDir: join(dir, 'data'), webDist: dir, secret: 's' });
    hub.start();
    acc = store.createAccount({ network: 'matrix', label: 'x', color: '#000', adapter: 'matrix' });
    mkdirSync(join(dir, 'data'), { recursive: true });
  });
  afterAll(() => {
    hub.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (raw: string, a: string | null = acc) => fetch(`${url}${sign(raw, a)}`);
  const guarded = (r: Response) => {
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe('sandbox');
    expect(r.headers.get('cache-control')).toContain('private');
  };

  test('active types are downloads, sandboxed, and keep their bytes (fresh fetch, then from the cache)', async () => {
    for (const raw of ['mxc://hs/html', 'mxc://hs/svg', 'mxc://hs/xml', 'mxc://hs/xhtml', 'mxc://hs/pdf']) {
      for (const pass of ['fresh', 'cached']) {
        const r = await get(raw);
        expect(r.status, `${raw} ${pass}`).toBe(200);
        guarded(r);
        expect(r.headers.get('content-type')).toBe(served[raw].mime);
        expect(r.headers.get('content-disposition'), `${raw} ${pass}`).toMatch(/^attachment; filename="attachment-[0-9a-f]{12}\.[a-z]+"; filename\*=UTF-8''/);
        expect(await r.text()).toBe(served[raw].body);
      }
    }
  });

  test('images, video and audio stay inline', async () => {
    for (const raw of ['mxc://hs/png', 'mxc://hs/mp4', 'mxc://hs/ogg']) {
      for (const pass of ['fresh', 'cached']) {
        const r = await get(raw);
        guarded(r);
        expect(r.headers.get('content-type'), `${raw} ${pass}`).toBe(served[raw].mime);
        expect(r.headers.get('content-disposition'), `${raw} ${pass}`).toBeNull();
        await r.text();
      }
    }
  });

  test('a type with a header injection in it is served as opaque bytes and downloaded', async () => {
    const r = await get('mxc://hs/odd');
    guarded(r);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('x-evil')).toBeNull();
    expect(r.headers.get('content-disposition')).toStartWith('attachment;');
    await r.text();
  });

  test('a file under the data dir carries a type, the sandbox and, when active, a download with its own name', async () => {
    const dataDir = join(dir, 'data');
    writeFileSync(join(dataDir, 'pic.png'), 'png');
    writeFileSync(join(dataDir, 'page.html'), '<script>alert(1)</script>');
    writeFileSync(join(dataDir, 'vector.svg'), '<svg/>');
    writeFileSync(join(dataDir, 'thing.unknownext'), 'x');
    const pic = await get(`file://${dataDir}/pic.png`, null);
    guarded(pic);
    expect(pic.headers.get('content-type')).toStartWith('image/png');
    expect(pic.headers.get('content-disposition')).toBeNull();
    for (const [name, type] of [['page.html', 'text/html'], ['vector.svg', 'image/svg+xml']] as const) {
      const r = await get(`file://${dataDir}/${name}`, null);
      guarded(r);
      expect(r.headers.get('content-type')).toStartWith(type);
      expect(r.headers.get('content-disposition')).toStartWith(`attachment; filename="${name}"`);
    }
    const other = await get(`file://${dataDir}/thing.unknownext`, null);
    guarded(other);
    expect(other.headers.get('content-type')).toBe('application/octet-stream');
    expect(other.headers.get('content-disposition')).toStartWith('attachment; filename="thing.unknownext"');
  });
});
