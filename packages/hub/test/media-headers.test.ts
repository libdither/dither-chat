/**
 * Attachment bytes are served from the hub's own origin, so a hostile type must not run there: nosniff and a sandbox on
 * every response, and a download for anything that is not an image, video, audio, PDF or plain text file
 * (mediaheaders.ts). An account's log and an export are guarded the same way.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { showsInline } from '@dither-chat/protocol';
import { attachmentDisposition, inlineType, mediaHeaders, PLAYER_CSP, SANDBOX_CSP, safeFilename, safeMime, sniffMime } from '../src/mediaheaders.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

describe('which types render inline', () => {
  test('image, video, audio, PDF and plain text files do', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'audio/ogg', 'audio/mpeg', 'IMAGE/PNG', 'image/png; charset=binary', 'application/pdf', 'text/plain', 'text/plain; charset=utf-8'])
      expect([t, inlineType(t)]).toEqual([t, true]);
  });

  test('anything that can run or script does not', () => {
    for (const t of ['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml', 'image/svg+xml', 'IMAGE/SVG+XML', 'image/svg+xml; charset=utf-8', 'application/xml', 'text/xml', 'text/css', 'application/json', 'application/javascript', 'text/javascript', 'application/octet-stream', 'application/zip', 'image/vnd.foo+xml', 'image/html', 'video/x-html', 'multipart/x-mixed-replace', ''])
      expect([t, inlineType(t)]).toEqual([t, false]);
  });

  test('the web app asks the same question of the protocol', () => {
    for (const t of ['image/png', 'application/pdf', 'text/plain', 'image/svg+xml', 'text/html', null, undefined]) expect(showsInline(t)).toBe(inlineType(t ?? ''));
  });

  test('a file with no name to go by, by its first bytes', () => {
    const b = (...x: (number | string)[]) => new Uint8Array(x.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])));
    expect(sniffMime(b(0x89, 'PNG', 0x0d, 0x0a))).toBe('image/png');
    expect(sniffMime(b(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMime(b('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('image/webp');
    expect(sniffMime(b(0, 0, 0, 0x20, 'ftypisom'))).toBe('video/mp4');
    expect(sniffMime(b(0, 0, 0, 0x20, 'ftypheic'))).toBe('image/heic');
    expect(sniffMime(b(0x1a, 0x45, 0xdf, 0xa3))).toBe('video/webm');
    expect(sniffMime(b('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(b('<svg xmlns='))).toBeNull();
    expect(sniffMime(b('<!doctype html>'))).toBeNull();
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
  let port = 0;
  let url = '';
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
    'mxc://hs/txt': { mime: 'text/plain; charset=utf-8', body: '<script>alert(1)</script>' },
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
      log: async () => '<script>alert(1)</script>',
    } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: join(dir, 'data'), webDist: dir, secret: 's' });
    port = hub.start().port!;
    url = `http://127.0.0.1:${port}`;
    acc = store.createAccount({ network: 'matrix', label: 'x', color: '#000', adapter: 'matrix' }).id;
    mkdirSync(join(dir, 'data'), { recursive: true });
  });
  afterAll(() => {
    hub.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (raw: string, a: string | null = acc) => fetch(`${url}${sign(raw, a)}`);
  const guarded = (r: Response, csp = SANDBOX_CSP) => {
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe(csp);
    expect(r.headers.get('cache-control')).toContain('private');
  };

  test('the sandbox runs no script and loads nothing else; video and audio keep the origin their player needs', () => {
    for (const csp of [SANDBOX_CSP, PLAYER_CSP]) {
      expect(csp).toMatch(/^sandbox[ ;]/);
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('allow-scripts');
      expect(csp).not.toContain('script-src');
    }
    expect(PLAYER_CSP).toStartWith('sandbox allow-same-origin;');
  });

  test('active types are downloads, sandboxed, and keep their bytes (fresh fetch, then from the cache)', async () => {
    for (const raw of ['mxc://hs/html', 'mxc://hs/svg', 'mxc://hs/xml', 'mxc://hs/xhtml']) {
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

  test('images, video, audio, PDF and plain text stay inline', async () => {
    for (const raw of ['mxc://hs/png', 'mxc://hs/mp4', 'mxc://hs/ogg', 'mxc://hs/pdf', 'mxc://hs/txt']) {
      for (const pass of ['fresh', 'cached']) {
        const r = await get(raw);
        guarded(r, /^(video|audio)\//.test(served[raw].mime) ? PLAYER_CSP : SANDBOX_CSP);
        expect(r.headers.get('content-type'), `${raw} ${pass}`).toBe(served[raw].mime);
        // Bun names a file it sends (filename="<cache key>", no type), which browsers take as inline.
        expect(r.headers.get('content-disposition') ?? '', `${raw} ${pass}`).not.toStartWith('attachment');
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
    // Signal keeps what you sent under a name with no extension: a picture is still a picture.
    writeFileSync(join(dataDir, 'sent-1-0'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const sent = await get(`file://${dataDir}/sent-1-0`, null);
    guarded(sent);
    expect(sent.headers.get('content-type')).toBe('image/png');
    expect(sent.headers.get('content-disposition')).toBeNull();
    await Promise.all([pic, other, sent].map((r) => r.arrayBuffer()));
  });

  test("an account's log is plain text that is never sniffed or run", async () => {
    const r = await fetch(`${url}/api/accounts/${acc}/log`);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe(SANDBOX_CSP);
    await r.text();
  });
});
