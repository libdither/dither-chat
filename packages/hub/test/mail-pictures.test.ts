/**
 * Which remote pictures can report an open (mail/pictures.ts), and what each setting does with them: the classes on
 * their own, then through the hub (parts.ts): the default loads shared pictures only, a sender's rule outranks the
 * setting, kept trackers load only with everything, and an address seen from another sender counts as shared.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { mailId } from '@dither-chat/protocol/ids';
import { demoPng } from '../src/mail/demo-html.ts';
import { FakeMailBackend, type FakeInput } from '../src/mail/fake.ts';
import { MailHub } from '../src/mail/index.ts';
import { addressForms, classifyPicture, pictureAction } from '../src/mail/pictures.ts';

const ME = 'me@example.com';
const you = addressForms([ME]);
const cls = (url: string, shaped = false, seen = false) => classifyPicture(url, { you, seenElsewhere: () => seen }, shaped).class;

describe('classes', () => {
  test('a logo or product picture at a plain address is shared', () => {
    expect(cls('https://cdn.shop.example/img/logo.png')).toBe('shared');
    expect(cls('https://images.example/products/12345/front.jpg?w=600&h=400&q=80')).toBe('shared');
    // A content-hashed file name is the same for everyone.
    expect(cls('https://cdn.example/a/9f8e7d6c5b4a39281706f5e4d3c2b1a0.png')).toBe('shared');
  });

  test('your address in any form makes it personal', () => {
    expect(cls(`https://img.example/p.png?to=${ME}`)).toBe('personal');
    expect(cls(`https://img.example/p.png?to=${encodeURIComponent(ME)}`)).toBe('personal');
    const md5 = addressForms([ME]).find((f) => /^[0-9a-f]{32}$/.test(f))!;
    expect(cls(`https://img.example/u/${md5}/banner.png`)).toBe('personal');
  });

  test('an opaque token in the query or a folder makes it personal', () => {
    expect(cls('https://img.example/banner.png?r=a8Xk29fQp3LmZ7w1')).toBe('personal');
    expect(cls('https://img.example/9aK3mX7pQ2wL8vN4zR6tY1bC/banner.png')).toBe('personal');
    expect(cls('https://img.example/view/eJyrVkpKLM5WslIqzs9NVcrJT0xRqgUAQE4G1A')).toBe('personal');
  });

  test('pixel-shaped pictures and the big services’ open pixels are trackers; a word in a path is not', () => {
    expect(cls('https://img.example/banner.png', true)).toBe('tracker');
    expect(cls('https://shop.us1.list-manage.com/track/open.php?u=1&id=2')).toBe('tracker');
    expect(cls('https://u123.ct.sendgrid.net/wf/open')).toBe('tracker');
    expect(cls('https://mailtrack.io/trace/mail/abc.png')).toBe('tracker');
    expect(cls('https://cdn.example/products/pixel-art-poster.png')).toBe('shared');
    expect(cls('https://cdn.example/open/house.jpg')).toBe('shared');
  });

  test('seen from another sender: shared whatever it looks like; your address still wins', () => {
    expect(cls('https://img.example/banner.png?r=a8Xk29fQp3LmZ7w1', false, true)).toBe('shared');
    expect(cls(`https://img.example/p.png?to=${ME}`, false, true)).toBe('personal');
  });

  test('what each setting does', () => {
    expect(pictureAction('shared', 'shared', false)).toBe('load');
    expect(pictureAction('personal', 'shared', false)).toBe('hold');
    expect(pictureAction('personal', 'shared', false, true)).toBe('load');
    expect(pictureAction('tracker', 'all', false)).toBe('drop');
    expect(pictureAction('tracker', 'shared', true)).toBe('hold');
    expect(pictureAction('tracker', 'all', true)).toBe('load');
    expect(pictureAction('tracker', 'shared', true, true)).toBe('hold');
    expect(pictureAction('shared', 'none', false)).toBe('hold');
  });
});

// ------------------------------------------------------------------ through the hub

const ACC = 'acc_picturesTest1';
const ORIGIN = 'http://hub.test:8720';
const PNG = demoPng(8, 6, [10, 20, 30], [200, 100, 50]);
let hub: MailHub | null = null;
let dir = '';
afterEach(() => {
  hub?.stop();
  hub = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function world(msgs: FakeInput[]) {
  dir = mkdtempSync(join(tmpdir(), 'mail-pictures-'));
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
      fetch: (async (u: string | URL, init?: RequestInit) => {
        fetched.push(`${new Headers(init?.headers).get('host')}${new URL(String(u)).pathname}`);
        return new Response(Buffer.from(PNG));
      }) as typeof fetch,
    },
  });
  hub.start();
  await hub.sync(ACC)!.whenSynced();
  const req = async (path: string, init: RequestInit = {}) => (await hub!.route(new Request(ORIGIN + path, init), new URL(ORIGIN + path)))!;
  const send = (path: string, body: unknown, method = 'POST') => req(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const body = async (h: string) => (await (await req(`/api/mail/messages/${mailId('mml', ACC, `m:${h}`)}/body`)).json()) as P.MailBodyView;
  const doc = async (h: string) => (await req((await body(h)).html!.url)).text();
  return { req, send, body, doc, fetched };
}

const NEWS: FakeInput = {
  messageId: '<n1@x>',
  from: [{ name: 'Shop', email: 'news@shop.example' }],
  subject: 'Sale',
  html:
    '<p>Sale!</p><img src="https://cdn.shop.example/logo.png" width="200" height="50">' +
    `<img src="https://img.shop.example/hero.png?r=a8Xk29fQp3LmZ7w1" width="600" height="300">` +
    '<img src="https://t.shop.example/o.gif" width="1" height="1">',
  text: 'Sale!',
};

describe('through the hub', () => {
  test('by default only shared pictures load; the personal one is held and the tracker removed', async () => {
    const w = await world([NEWS]);
    const b = await w.body('<n1@x>');
    expect(b.html!.pictures).toMatchObject({ policy: 'shared', source: 'setting', loaded: 1, held: 1, removed: 1, hosts: 3, bytes: 0, unknown: 1 });
    const html = await w.doc('<n1@x>');
    expect(html.match(/\/api\/mail\/img\//g)?.length).toBe(1);
    expect(html).toContain('dc-img-blocked');
    // Loading it gives its size; the held one's address is refused.
    const src = html.match(/src="(\/api\/mail\/img\/[^"]+)"/)![1];
    expect((await w.req(src)).status).toBe(200);
    expect(w.fetched).toEqual(['cdn.shop.example/logo.png']);
    expect((await w.body('<n1@x>')).html!.pictures).toMatchObject({ bytes: PNG.length, unknown: 0 });
  });

  test('a sender’s rule outranks the setting: Never holds everything, Always loads everything but trackers', async () => {
    const w = await world([NEWS]);
    await w.send('/api/mail/images', { sender: 'news@shop.example', allow: false });
    expect((await w.body('<n1@x>')).html!.pictures).toMatchObject({ policy: 'none', source: 'sender', loaded: 0, held: 2, removed: 1 });
    await w.send('/api/mail/images', { sender: 'news@shop.example', allow: true });
    expect((await w.body('<n1@x>')).html!.pictures).toMatchObject({ policy: 'all', source: 'sender', loaded: 2, held: 0, removed: 1 });
    await w.send('/api/mail/images', { sender: 'news@shop.example', forget: true });
    expect((await w.body('<n1@x>')).html!.pictures).toMatchObject({ policy: 'shared', source: 'setting' });
  });

  test('kept trackers are held with the personal ones, and load only with everything', async () => {
    const w = await world([NEWS]);
    await w.send('/api/mail/settings', { trackers: 'keep' }, 'PUT');
    expect((await w.body('<n1@x>')).html!.pictures).toMatchObject({ keepTrackers: true, loaded: 1, held: 2, removed: 0 });
    await w.send('/api/mail/images', { messageId: mailId('mml', ACC, 'm:<n1@x>') });
    expect((await w.body('<n1@x>')).html!.pictures).toMatchObject({ source: 'message', loaded: 3, held: 0 });
  });

  test('an address another sender’s mail carried too is shared', async () => {
    const other: FakeInput = { messageId: '<o1@x>', from: [{ name: null, email: 'hi@other.example' }], subject: 'Hi', html: '<img src="https://img.shop.example/hero.png?r=a8Xk29fQp3LmZ7w1">', text: 'Hi' };
    const w = await world([NEWS, other]);
    // Read in this order: the shop's first, then the other sender's.
    await w.body('<n1@x>');
    expect((await w.body('<o1@x>')).html!.pictures!.items[0]).toMatchObject({ class: 'shared', why: 'seen in other mail too', action: 'load' });
  });
});
