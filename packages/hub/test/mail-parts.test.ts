/**
 * Slice 3's routes (mail/parts.ts) on FakeMailBackend: the frame's document and its CSP, images held back until
 * allowed (for a message, or always for a sender) and then through the proxy, cid: parts, files and what they are,
 * the body view's counts, files and warnings, and the files going with their message.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import { demoPdf, demoPng } from '../src/mail/demo-html.ts';
import { MailCallError } from '../src/mail/backend.ts';
import { FakeMailBackend, type FakeInput } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';

const ACC = 'acc_partsTest01';
const ME = 'me@example.com';
const ORIGIN = 'http://hub.test:8720';
const PNG = demoPng(8, 6, [10, 20, 30], [200, 100, 50]);
const SAM = { name: 'Sam Lee', email: 'sam@lee.example' };

let hub: MailHub | null = null;
let dir = '';
afterEach(() => {
  hub?.stop();
  hub = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function world(msgs: FakeInput[]) {
  dir = mkdtempSync(join(tmpdir(), 'mail-parts-'));
  const fake = new FakeMailBackend();
  fake.addAccount(ACC, { email: ME });
  for (const m of msgs) fake.put(ACC, m);
  const db = new Database(':memory:', { strict: true });
  db.exec('PRAGMA foreign_keys = ON');
  const fetched: string[] = [];
  hub = new MailHub({
    db,
    backend: fake,
    log: () => {},
    media: {
      dir,
      key: 'k',
      lookup: async (h) => (h.endsWith('.example') ? ['93.184.216.34'] : []),
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        fetched.push(`${new Headers(init?.headers).get('host')} ${String(u)}`);
        return new Response(Buffer.from(PNG));
      }) as typeof fetch,
    },
  });
  hub.start();
  await hub.sync(ACC)!.whenSynced();
  const get = async (path: string, init: RequestInit = {}) => (await hub!.route(new Request(ORIGIN + path, init), new URL(ORIGIN + path)))!;
  const post = (path: string, body: unknown) => get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { fake, hub, get, post, fetched };
}
const mid = (hdr: string) => mailId('mml', ACC, `m:${hdr}`);

const NEWSLETTER: FakeInput = {
  messageId: '<news@x>',
  from: [{ name: 'Shop', email: 'news@shop.example' }],
  subject: 'Sale',
  html: '<p>Sale!</p><img src="https://img.example/banner.png" width="300" height="100"><img src="https://t.example/o.gif" width="1" height="1"><script>alert(1)</script><a href="https://evil.example/">https://shop.example/</a>',
  text: 'Sale!',
};
const LETTER: FakeInput = {
  messageId: '<letter@x>',
  from: [SAM],
  replyTo: [{ name: null, email: 'sam@elsewhere.example' }],
  subject: 'Plan',
  html: '<p>See the sketch:</p><img src="cid:sketch@x"><div class="gmail_quote">old</div>',
  text: 'See the sketch.',
  attachments: [
    { id: '2', filename: 'sketch.png', mime: 'image/png', size: PNG.length, inline: true, contentId: '<sketch@x>' },
    { id: '3', filename: 'plan.pdf', mime: 'application/octet-stream', size: 500, inline: false, contentId: null },
    { id: '4', filename: 'page.html', mime: 'text/html', size: 30, inline: false, contentId: null },
    { id: '5', filename: 'not-an-image.png', mime: 'image/png', size: 9, inline: true, contentId: '<fake@x>' },
  ],
  files: { '2': PNG, '3': demoPdf(['A plan']), '4': '<script>alert(1)</script>', '5': 'not a png' },
};

describe('the frame’s document', () => {
  test('sanitised, with the CSP, nosniff and no referrer', async () => {
    const { get } = await world([NEWSLETTER]);
    const body = (await (await get(`/api/mail/messages/${mid('<news@x>')}/body`)).json()) as P.MailBodyView;
    expect(body.html).toEqual({ url: `/api/mail/messages/${mid('<news@x>')}/html?images=0&v=1`, remoteImages: 1, trackers: 1, imagesShown: false, plain: false });
    expect(body.warnings).toEqual(['A link that shows shop.example goes to evil.example.']);
    const r = await get(body.html!.url);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp.split('; ')).toEqual([
      'sandbox allow-same-origin',
      "default-src 'none'",
      `img-src ${ORIGIN}/api/mail/img/ ${ORIGIN}/api/mail/messages/${mid('<news@x>')}/cid/ data:`,
      "style-src 'unsafe-inline'",
      "font-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
    ]);
    expect(csp).not.toContain('script-src');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const doc = await r.text();
    expect(doc).not.toMatch(/<script|img\.example|t\.example/);
    expect(doc).toContain('class="dc-img-blocked"');
  });

  test('images=1 is honoured only once images are allowed', async () => {
    const { get, post, fetched } = await world([NEWSLETTER]);
    const id = mid('<news@x>');
    expect(await (await get(`/api/mail/messages/${id}/html?images=1`)).text()).not.toContain('/api/mail/img/');
    const r = (await (await post('/api/mail/images', { messageId: id })).json()) as { body: P.MailBodyView };
    expect(r.body.html!.imagesShown).toBe(true);
    expect(r.body.html!.url).toContain('images=1');
    const doc = await (await get(r.body.html!.url)).text();
    const src = doc.match(/src="(\/api\/mail\/img\/[^"]+)"/)![1];
    expect(doc).not.toContain('t.example');
    const img = await get(src);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(fetched).toEqual(['img.example https://93.184.216.34/banner.png']);
  });

  test('a token for one message does not open another’s images, nor one whose images are not allowed', async () => {
    const { get, post } = await world([NEWSLETTER, { ...NEWSLETTER, messageId: '<news2@x>', from: [{ name: null, email: 'other@shop.example' }] }]);
    await post('/api/mail/images', { messageId: mid('<news@x>') });
    const doc = await (await get(`/api/mail/messages/${mid('<news@x>')}/html?images=1`)).text();
    const src = doc.match(/src="\/api\/mail\/img\/([^"]+)"/)![1];
    const [, url, sig] = src.split('.');
    expect((await get(`/api/mail/img/${mid('<news2@x>')}.${url}.${sig}`)).status).toBe(403);
    expect((await get(`/api/mail/img/${src.replace(/.$/, src.endsWith('A') ? 'B' : 'A')}`)).status).toBe(403);
  });

  test('always from a sender: every message of theirs, until said otherwise', async () => {
    const { get, post } = await world([NEWSLETTER, { ...NEWSLETTER, messageId: '<news3@x>' }]);
    expect((await post('/api/mail/images', { sender: 'News@Shop.example', allow: true })).status).toBe(200);
    for (const h of ['<news@x>', '<news3@x>']) expect(((await (await get(`/api/mail/messages/${mid(h)}/body`)).json()) as P.MailBodyView).html!.imagesShown).toBe(true);
    await post('/api/mail/images', { sender: 'news@shop.example', allow: false });
    expect(((await (await get(`/api/mail/messages/${mid('<news@x>')}/body`)).json()) as P.MailBodyView).html!.imagesShown).toBe(false);
    expect((await post('/api/mail/images', { sender: 'not an address' })).status).toBe(400);
  });

  test('a message without HTML has none to serve', async () => {
    const { get } = await world([{ messageId: '<plain@x>', text: 'hi' }]);
    const body = (await (await get(`/api/mail/messages/${mid('<plain@x>')}/body`)).json()) as P.MailBodyView;
    expect(body.html).toBeNull();
    expect((await get(`/api/mail/messages/${mid('<plain@x>')}/html`)).status).toBe(404);
  });

  test('plain HTML with a text part is marked plain (the reader shows the text); styled or HTML-only is not', async () => {
    const reply = '<div dir="auto">See you at 7:30!</div><br><blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">Are you free after 7?</blockquote>';
    const { get } = await world([
      { messageId: '<reply@x>', html: reply, text: 'See you at 7:30!\n\n> Are you free after 7?' },
      { messageId: '<only@x>', html: reply, text: null },
      NEWSLETTER,
    ]);
    const html = async (hdr: string) => ((await (await get(`/api/mail/messages/${mid(hdr)}/body`)).json()) as P.MailBodyView).html!;
    expect((await html('<reply@x>')).plain).toBe(true);
    // The frame still serves it, as it is: only the part the reader picks changed.
    expect((await get(`/api/mail/messages/${mid('<reply@x>')}/html`)).status).toBe(200);
    expect((await html('<only@x>')).plain).toBe(false);
    expect((await html('<news@x>')).plain).toBe(false);
  });
});

describe('parts and files', () => {
  test('the body lists files, not the pictures the HTML shows; warns of a Reply-To elsewhere', async () => {
    const { get } = await world([LETTER]);
    const id = mid('<letter@x>');
    const body = (await (await get(`/api/mail/messages/${id}/body`)).json()) as P.MailBodyView;
    expect(body.attachments.map((a) => [a.name, a.inline])).toEqual([
      ['plan.pdf', false],
      ['page.html', false],
      ['not-an-image.png', true],
    ]);
    expect(body.attachments[0].url).toMatch(new RegExp(`^/api/mail/messages/${id}/attachments/[\\w-]{16}$`));
    expect(body.attachments[0].infoUrl).toBe(`${body.attachments[0].url}/info`);
    expect(body.warnings).toEqual(['Replies go to sam@elsewhere.example, not to sam@lee.example.']);
  });

  test('cid: an image part, shown in place; one that is not an image is refused', async () => {
    const { get, fake } = await world([LETTER]);
    const id = mid('<letter@x>');
    await get(`/api/mail/messages/${id}/body`);
    const r = await get(`/api/mail/messages/${id}/cid/${encodeURIComponent('sketch@x')}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-security-policy')).toStartWith('sandbox;');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
    // Kept: the second time does not ask the server.
    const asked = fake.calls.filter((c) => c.op === 'mail.attachment').length;
    await get(`/api/mail/messages/${id}/cid/sketch%40x`);
    expect(fake.calls.filter((c) => c.op === 'mail.attachment').length).toBe(asked);
    expect((await get(`/api/mail/messages/${id}/cid/fake%40x`)).status).toBe(415);
    expect((await get(`/api/mail/messages/${id}/cid/nothing%40x`)).status).toBe(404);
  });

  test('files: the bytes, a type the bytes say, a download for what a browser would run; and what they are', async () => {
    const { get } = await world([LETTER]);
    const id = mid('<letter@x>');
    const body = (await (await get(`/api/mail/messages/${id}/body`)).json()) as P.MailBodyView;
    const [pdf, page] = body.attachments;
    const info = (await (await get(pdf.infoUrl)).json()) as P.FileInfo;
    expect(info).toMatchObject({ kind: 'pdf', mime: 'application/pdf', pages: 1 });
    const r = await get(pdf.url);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toStartWith('inline; filename="plan.pdf"');
    const h = await get(page.url);
    expect(h.headers.get('content-disposition')).toStartWith('attachment; filename="page.html"');
    expect(h.headers.get('content-security-policy')).toStartWith('sandbox;');
    expect(h.headers.get('x-content-type-options')).toBe('nosniff');
    // Once looked at, the body view says so.
    const again = (await (await get(`/api/mail/messages/${id}/body`)).json()) as P.MailBodyView;
    expect(again.attachments[0].info?.kind).toBe('pdf');
    expect((await get(`/api/mail/messages/${id}/attachments/nope`)).status).toBe(404);
  });

  test('a file the server no longer has, or an account that is offline, says so', async () => {
    const { get, fake } = await world([LETTER]);
    const id = mid('<letter@x>');
    const body = (await (await get(`/api/mail/messages/${id}/body`)).json()) as P.MailBodyView;
    fake.fail('mail.attachment', new MailCallError('no such attachment', 404));
    expect((await get(body.attachments[0].url)).status).toBe(404);
    fake.connected = false;
    const r = await get(body.attachments[1].url);
    expect(r.status).toBe(503);
  });

  test('a message the server deleted takes its files with it', async () => {
    const { get, fake } = await world([LETTER]);
    const id = mid('<letter@x>');
    const body = (await (await get(`/api/mail/messages/${id}/body`)).json()) as P.MailBodyView;
    await get(body.attachments[0].url);
    expect(readdirSync(dir).some((f) => f.startsWith('mailpart-'))).toBe(true);
    hub!.emit('deleted', { accountId: ACC, messageIds: [id] });
    expect(readdirSync(dir).filter((f) => f.startsWith('mailpart-'))).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    void fake;
  });
});
