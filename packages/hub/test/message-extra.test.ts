/**
 * What a message carries besides its text (protocol extra.ts, docs/messages.md): a reply's own quote when the quoted
 * message is not here, contact cards, story replies, people a send did not reach, files that did not download, voice
 * notes and captions; and the hub's side of viewed receipts, resetting a session and link previews (unfurl.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { extraView } from '../src/msgextra.ts';
import { HubServer } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { firstLink, parsePreview, unfurl } from '../src/unfurl.ts';

const SELF = 'self-aci';
const ALICE = 'alice-aci';
const DM = `dm:${SELF}:${ALICE}`;
const GROUP = 'group:g1';
const T = 1_793_330_000_000;

const dir = mkdtempSync(join(tmpdir(), 'dither-extra-'));
let store: Store;
let hub: HubServer;
let sig: AccountRow;
let base = '';
const commands: { account: string; cmd: any }[] = [];
const online = new Set<string>();
let answer: (cmd: any) => unknown = () => ({});

const msg = (nativeId: string) => hubId('msg', 'signal', nativeId);
const view = (nativeId: string) => store.messageView(msg(nativeId))!;
const put = (m: Partial<P.MessageFact> & { nativeId: string }, conversation = DM) =>
  store.ingest(sig, { t: 'message', live: false, message: { conversation, author: ALICE, ts: T, body: 'hi', ...m } });
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { status: r.status, body: await r.json() };
};
const caps = (list: P.Capability[]) => store.ingest(sig, { t: 'hello', network: 'signal', version: '1', capabilities: list });

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  const sup = {
    authorize: () => null,
    online: (id: string) => online.has(id),
    stop: async () => {},
    command: async (account: string, cmd: any) => (commands.push({ account, cmd }), answer(cmd)),
  } as any;
  hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
  base = `http://127.0.0.1:${hub.start().port}`;
  sig = store.createAccount({ network: 'signal', label: 'sig', color: '#111', adapter: 'signal' });
  caps(['send', 'viewed', 'resetSession']);
  store.ingest(sig, { t: 'status', status: 'online', self: { nativeId: SELF, isSelf: true, handle: '+15550100' } });
  online.add(sig.id);
  store.ingest(sig, { t: 'identity', identity: { nativeId: ALICE, displayName: 'Alice', handle: '+15550137', contact: true } });
  store.ingest(sig, { t: 'conversation', conversation: { nativeId: DM, shape: 'direct', participants: [SELF, ALICE] } });
  store.ingest(sig, { t: 'conversation', conversation: { nativeId: GROUP, shape: 'group', name: 'Crew', participants: [SELF, ALICE] } });
});

afterAll(() => {
  hub.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a reply's own quote", () => {
  test('shown when the quoted message is not here, with its author, files and thumbnail; a stored one wins', () => {
    put({ nativeId: `${ALICE}:${T + 1}`, replyTo: `${SELF}:${T - 5}`, extra: { quote: { author: SELF, ts: T - 5, text: 'yes! **7pm**', attachments: [{ mime: 'image/jpeg', name: 'v4.jpg', thumbnail: 'file:///x/thumb.jpg' }, { mime: 'audio/aac', name: null }] } } });
    expect(view(`${ALICE}:${T + 1}`).quote).toEqual({
      authorId: hubId('idn', 'signal', SELF),
      authorName: null,
      ts: T - 5,
      text: 'yes! **7pm**',
      attachments: [
        { kind: 'image', mime: 'image/jpeg', name: 'v4.jpg' },
        { kind: 'audio', mime: 'audio/aac', name: null },
      ],
      thumbnail: 'file:///x/thumb.jpg',
    });
    put({ nativeId: `${SELF}:${T - 5}`, author: SELF, body: 'yes! **7pm**' });
    expect(view(`${ALICE}:${T + 1}`).quote).toBeUndefined();
  });

  test('an author named only by number: their identity when one has that number, else the number', () => {
    put({ nativeId: `${ALICE}:${T + 2}`, extra: { quote: { author: '+15550137', ts: T - 9, text: 'a' } } });
    expect(view(`${ALICE}:${T + 2}`).quote).toMatchObject({ authorId: hubId('idn', 'signal', ALICE), authorName: null });
    put({ nativeId: `${ALICE}:${T + 3}`, extra: { quote: { author: '+15550999', ts: T - 9, text: 'a' } } });
    expect(view(`${ALICE}:${T + 3}`).quote).toMatchObject({ authorId: null, authorName: '+15550999', attachments: [], thumbnail: null });
  });
});

describe('cards, story replies, failures and files', () => {
  test('all of them, from the extra the adapter set', () => {
    put({
      nativeId: `${ALICE}:${T + 10}`,
      body: '👤 Robin · +15550142',
      kind: 'media',
      attachments: [
        { nativeId: 'a', kind: 'audio', mime: 'audio/aac', url: 'file:///x/a.aac' },
        { nativeId: 'b', kind: 'image', mime: 'image/png', url: 'file:///x/b.png' },
      ],
      extra: {
        contacts: [{ name: 'Robin', line: '👤 Robin · +15550142', phones: [{ value: '+15550142', label: 'Mobile' }], avatar: 'file:///x/av.jpg' }],
        storyReply: { author: SELF, ts: T - 100, emoji: '❤️' },
        missingAttachments: [{ name: 'send.mp4', mime: 'video/mp4', size: 5 }],
        attachmentNotes: [{ voiceNote: true }, { caption: 'the crux' }],
      },
    });
    const v = view(`${ALICE}:${T + 10}`);
    expect(v.contacts).toEqual([{ name: 'Robin', line: '👤 Robin · +15550142', phones: [{ value: '+15550142', label: 'Mobile' }], avatar: 'file:///x/av.jpg' }]);
    expect(v.storyReply).toEqual({ mine: true, authorId: hubId('idn', 'signal', SELF), emoji: '❤️' });
    expect(v.missingAttachments).toEqual([{ name: 'send.mp4', mime: 'video/mp4', size: 5 }]);
    expect(v.attachments.map((a) => [a.voiceNote, a.caption])).toEqual([
      [true, undefined],
      [undefined, 'the crux'],
    ]);
  });

  test('your message that some did not get: who, and why', () => {
    put({ nativeId: `${SELF}:${T + 20}`, author: SELF, extra: { failed: [{ who: ALICE, reason: 'unregistered' }, { who: 'stranger', number: '+15550188', reason: 'network' }, { who: null, reason: 'bogus' }] } }, GROUP);
    expect(view(`${SELF}:${T + 20}`).failed).toEqual([
      { identityId: hubId('idn', 'signal', ALICE), name: null, reason: 'unregistered' },
      { identityId: null, name: '+15550188', reason: 'network' },
    ]);
  });

  test('nothing malformed gets through, and a message without extra has none of it', () => {
    const d = { identity: () => null, isSelf: () => false, media: (u: string | null | undefined) => u ?? null, stored: () => false };
    expect(extraView({ quote: { text: 'no ts' }, contacts: [{ phones: [] }], failed: 'x', attachmentNotes: [1, null] } as any, null, d)).toEqual({});
    put({ nativeId: `${ALICE}:${T + 30}` });
    const v = view(`${ALICE}:${T + 30}`);
    for (const k of ['quote', 'contacts', 'storyReply', 'failed', 'missingAttachments'] as const) expect(v[k]).toBeUndefined();
  });
});

describe('viewed receipts and resetting a session', () => {
  test('a viewed receipt goes once, through an account that has them, for others’ messages only', async () => {
    put({ nativeId: `${ALICE}:${T + 40}`, kind: 'media' });
    put({ nativeId: `${SELF}:${T + 41}`, author: SELF });
    commands.length = 0;
    expect((await post(`/api/messages/${msg(`${ALICE}:${T + 40}`)}/viewed`)).body).toEqual({ sent: true });
    expect((await post(`/api/messages/${msg(`${ALICE}:${T + 40}`)}/viewed`)).body).toMatchObject({ sent: false, why: 'already' });
    expect((await post(`/api/messages/${msg(`${SELF}:${T + 41}`)}/viewed`)).body).toMatchObject({ sent: false, why: 'your own' });
    expect(commands.map((c) => c.cmd)).toEqual([{ t: 'viewed', conversation: DM, message: `${ALICE}:${T + 40}` }]);
    caps(['send']);
    put({ nativeId: `${ALICE}:${T + 42}`, kind: 'media' });
    expect((await post(`/api/messages/${msg(`${ALICE}:${T + 42}`)}/viewed`)).body).toMatchObject({ sent: false, why: 'not on this network' });
    caps(['send', 'viewed', 'resetSession']);
  });

  test('reset secure session: a direct conversation only, and the network’s refusal in words', async () => {
    commands.length = 0;
    expect(await post(`/api/conversations/${hubId('cnv', 'signal', DM)}/reset-session`)).toEqual({ status: 200, body: { ok: true } });
    expect(commands.map((c) => c.cmd)).toEqual([{ t: 'resetSession', conversation: DM }]);
    expect((await post(`/api/conversations/${hubId('cnv', 'signal', GROUP)}/reset-session`)).status).toBe(400);
    answer = () => {
      throw new Error('Rate limit reached');
    };
    expect(await post(`/api/conversations/${hubId('cnv', 'signal', DM)}/reset-session`)).toEqual({ status: 502, body: { error: 'The network refused it: Rate limit reached' } });
    answer = () => ({});
  });
});

describe('link previews', () => {
  test('the first link, outside code and without trailing punctuation', () => {
    expect(firstLink('see https://example.org/a?b=1. and https://other.example')).toBe('https://example.org/a?b=1');
    expect(firstLink('`https://code.example` then (https://example.org/x)')).toBe('https://example.org/x');
    expect(firstLink('no links, ftp://x.example')).toBeNull();
  });

  test("a page's Open Graph tags first, then its title and description; entities decoded, the picture made absolute", () => {
    const html = `<html><head><title>Plain &amp; title</title><meta name="description" content="Fallback">
      <meta property="og:title" content="The &quot;route&quot;"><meta content='/img/r.jpg' property='og:image'></head></html>`;
    expect(parsePreview(html, 'https://example.org/a/b')).toEqual({ title: 'The "route"', description: 'Fallback', image: 'https://example.org/img/r.jpg' });
    expect(parsePreview('<title>\n  Only   a title </title>', 'https://example.org')).toEqual({ title: 'Only a title' });
    expect(parsePreview('<p>nothing</p>', 'https://example.org')).toEqual({});
  });

  test('fetched by the media proxy rules: a private address, a page that is not HTML, or no title is no preview', async () => {
    const lookup = async (h: string) => ({ 'pub.example': ['203.0.113.5'], 'lan.example': ['10.0.0.8'] })[h] ?? [];
    const routes: Record<string, () => Response> = {
      'https://pub.example/page': () => new Response('<title>Page</title><meta property="og:image" content="https://pub.example/pic.png">', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      'https://pub.example/pic.png': () => new Response(new Uint8Array(100), { headers: { 'content-type': 'image/png' } }),
      'https://pub.example/big': () => new Response('<title>Big</title><meta property="og:image" content="https://pub.example/huge.png">', { headers: { 'content-type': 'text/html' } }),
      'https://pub.example/huge.png': () => new Response(new Uint8Array(2 * 1024 * 1024), { headers: { 'content-type': 'image/png' } }),
      'https://pub.example/file.zip': () => new Response('PK', { headers: { 'content-type': 'application/zip' } }),
      'https://pub.example/untitled': () => new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } }),
    };
    const fetch = (async (u: string | URL | Request) => routes[String(u)]?.() ?? new Response('', { status: 404 })) as typeof globalThis.fetch;
    const d = join(dir, 'unfurl');
    require('node:fs').mkdirSync(d, { recursive: true });
    const p = await unfurl('https://pub.example/page', d, 'one', { lookup, fetch, allowPrivate: false });
    expect(p).toEqual({ url: 'https://pub.example/page', title: 'Page', image: join(d, 'one.img') });
    expect(existsSync(join(d, 'one.html'))).toBe(false);
    expect(await unfurl('https://pub.example/big', d, 'two', { lookup, fetch, allowPrivate: false })).toEqual({ url: 'https://pub.example/big', title: 'Big' });
    expect(existsSync(join(d, 'two.img'))).toBe(false);
    for (const u of ['https://lan.example/page', 'https://pub.example/file.zip', 'https://pub.example/untitled']) expect(await unfurl(u, d, 'x', { lookup, fetch, allowPrivate: false })).toBeNull();
    expect(readdirSync(d).sort()).toEqual(['one.img']);
  });

  test('a send carries one only for an account that sends previews, and the hub deletes its picture after', async () => {
    const page = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        new URL(req.url).pathname === '/pic.png'
          ? new Response(new Uint8Array(64), { headers: { 'content-type': 'image/png' } })
          : new Response('<title>Local page</title><meta property="og:description" content="here"><meta property="og:image" content="/pic.png">', { headers: { 'content-type': 'text/html' } }),
    });
    const was = process.env.DITHER_MEDIA_ALLOW_PRIVATE;
    process.env.DITHER_MEDIA_ALLOW_PRIVATE = '1'; // a page on this machine stands in for the internet
    try {
      const url = `http://127.0.0.1:${page.port}/post`;
      let image: string | undefined;
      answer = (cmd) => ((image = cmd.preview?.image), image && expect(existsSync(image)).toBe(true), { nativeId: `${SELF}:${T + 99}` });
      commands.length = 0;
      await post(`/api/conversations/${hubId('cnv', 'signal', DM)}/send`, { body: `look ${url}` });
      expect(commands.at(-1)!.cmd.preview).toBeUndefined(); // no 'linkPreviews': nothing fetched
      caps(['send', 'viewed', 'resetSession', 'linkPreviews']);
      await post(`/api/conversations/${hubId('cnv', 'signal', DM)}/send`, { body: `look ${url}` });
      expect(commands.at(-1)!.cmd.preview).toEqual({ url, title: 'Local page', description: 'here', image: expect.stringContaining(join(dir, 'previews')) });
      expect(existsSync(image!)).toBe(false);
    } finally {
      answer = () => ({});
      if (was === undefined) delete process.env.DITHER_MEDIA_ALLOW_PRIVATE;
      else process.env.DITHER_MEDIA_ALLOW_PRIVATE = was;
      page.stop(true);
    }
  });
});
