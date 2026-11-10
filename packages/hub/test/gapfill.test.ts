/**
 * Fetching what an import and live sync both lack (imports/gapfill.ts), against a fake channel served a page at a
 * time; and keeping every remote attachment's bytes (mediaarchive.ts).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { GapFill, PAUSE_MS } from '../src/imports/gapfill.ts';
import { MediaArchiver } from '../src/mediaarchive.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { FakeClock } from './fixtures/clock.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-gap-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ME = '1';
const PEER = '2';
const minute = 60_000;
const T0 = Date.UTC(2026, 4, 1);

function world(name: string) {
  const store = new Store(join(dir, `${name}.sqlite`), mediaSigner('s'));
  let acc = store.createAccount({ id: 'acc_dc', network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: ME, isSelf: true } });
  acc = store.account('acc_dc')!;
  return { store, acc };
}
const msg = (id: number, ts: number, conversation = 'dm1'): P.MessageFact => ({ nativeId: String(id), conversation, author: PEER, ts, body: `m${id}` });

describe('gap fill', () => {
  test('pages back from live sync until it meets the import, then stops', async () => {
    const { store, acc } = world('gap');
    // The channel as Discord has it: one message a minute for 100 minutes.
    const channel = Array.from({ length: 100 }, (_, i) => msg(1000 + i, T0 + i * minute));
    // The export ends at minute 20; live sync has minutes 90 on.
    store.importBatch(acc, { conversation: { nativeId: 'dm1', shape: 'direct', participants: [ME, PEER] }, identities: [], messages: channel.slice(0, 21) }, { sourceSha: 'sha', runId: 'r', dryRun: false, archiveNew: false, first: true });
    for (const m of channel.slice(90)) store.ingest(acc, { t: 'message', message: m, live: false });
    const asked: number[] = [];
    const at: number[] = [];
    const clock = new FakeClock();
    const gaps = new GapFill(
      store,
      async (_acc, cmd) => {
        asked.push(cmd.beforeTs!);
        at.push(clock.now());
        const page = channel.filter((m) => m.ts < cmd.beforeTs!).slice(-cmd.limit).slice(-30);
        for (const m of page) store.ingest(acc, { t: 'message', message: m, live: false });
        return { count: page.length, done: page.length < 30 && page[0]?.ts === channel[0].ts };
      },
      () => {},
      clock,
    );
    const v = gaps.start('acc_dc');
    expect(v.conversations).toBe(1);
    await clock.until(() => !gaps.status('acc_dc').running, 60_000, 'the gap fill');
    const s = gaps.status('acc_dc');
    expect(s).toMatchObject({ running: false, done: 1, failed: 0 });
    expect((store.db.query('SELECT COUNT(*) AS n FROM message').get() as any).n).toBe(100);
    // It started at the oldest live message and never paged past the import.
    expect(asked[0]).toBe(T0 + 90 * minute);
    expect(Math.min(...asked)).toBeGreaterThan(T0 + 20 * minute);
    expect(s.fetched).toBe(69);
    // A page every 1.5 s at most, on top of the extractor's own pacing.
    expect(PAUSE_MS).toBe(1500);
    expect(at.slice(1).map((t, i) => t - at[i])).toEqual(asked.slice(1).map(() => PAUSE_MS));
  });

  test('a conversation nothing was imported into goes back to its start; channels only when asked', async () => {
    const { store, acc } = world('gap2');
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'chan', shape: 'channel', name: 'big' } });
    store.ingest(acc, { t: 'message', message: msg(5, T0 + 5 * minute, 'chan'), live: false });
    const channel = Array.from({ length: 10 }, (_, i) => msg(100 + i, T0 + i * minute, 'dm2'));
    store.ingest(acc, { t: 'message', message: channel[9], live: false });
    const clock = new FakeClock();
    const gaps = new GapFill(
      store,
      async (_acc, cmd) => {
        const page = channel.filter((m) => m.ts < cmd.beforeTs!).slice(-4);
        for (const m of page) store.ingest(acc, { t: 'message', message: m, live: false });
        return { count: page.length, done: page.length < 4 };
      },
      () => {},
      clock,
    );
    gaps.start('acc_dc');
    await clock.until(() => !gaps.status('acc_dc').running, 60_000, 'the gap fill');
    expect(gaps.status('acc_dc')).toMatchObject({ conversations: 1, done: 1 });
    expect((store.db.query(`SELECT COUNT(*) AS n FROM message WHERE conversation_id = (SELECT id FROM conversation WHERE native_id = 'dm2')`).get() as any).n).toBe(10);
  });
});

describe('media archive', () => {
  test('every remote attachment is fetched once; failures are counted and left after three tries', async () => {
    const { store, acc } = world('media');
    const cache = join(dir, 'media-cache');
    mkdirSync(cache, { recursive: true });
    const att = (id: string, url: string): P.MessageFact => ({ ...msg(Number(id), T0), attachments: [{ kind: 'image', url }] });
    store.ingest(acc, { t: 'message', message: att('1', 'https://cdn.example/a.png'), live: false });
    store.ingest(acc, { t: 'message', message: att('2', 'file:///local.png'), live: false });
    store.ingest(acc, { t: 'message', message: att('3', 'https://cdn.example/expired.png'), live: false });
    const fetched: string[] = [];
    const key = (u: string) => new Bun.CryptoHasher('sha256').update(u).digest('hex');
    const a = new MediaArchiver(store, cache, async (url) => {
      fetched.push(url);
      if (url.includes('expired') || url.includes('discordapp')) return false;
      writeFileSync(join(cache, key(url)), 'x');
      return true;
    });
    await a.tick();
    expect(fetched).toEqual(['https://cdn.example/a.png', 'https://cdn.example/expired.png']);
    expect(existsSync(join(cache, key('https://cdn.example/a.png')))).toBe(true);
    expect(store.db.query('SELECT tries FROM media_archive_fail').all()).toEqual([{ tries: 1 }]);
    // Nothing new: nothing fetched again, and the failure waits for its retry time.
    await a.tick();
    expect(fetched.length).toBe(2);
    const past = (Math.floor(Date.now() / 1000) - 3600).toString(16);
    store.ingest(acc, { t: 'message', message: att('5', `https://cdn.discordapp.com/attachments/1/2/x.png?ex=${past}&is=0&hm=0`), live: false });
    store.ingest(acc, { t: 'message', message: att('4', 'https://cdn.example/b.png'), live: false });
    await a.tick();
    expect(fetched.at(-1)).toBe('https://cdn.example/b.png');
    expect(store.db.query('SELECT tries, error FROM media_archive_fail ORDER BY error').all()).toEqual([{ tries: 1, error: null }, { tries: 3, error: 'expired' }]);
  });
});

describe('expired Discord links', () => {
  test('are signed again in batches through the account, kept under the old link; ones Discord won’t sign are gone', async () => {
    const { store, acc } = world('refresh');
    const cache = join(dir, 'media-cache-refresh');
    mkdirSync(cache, { recursive: true });
    const past = (Math.floor(Date.now() / 1000) - 3600).toString(16);
    const link = (i: number) => `https://cdn.discordapp.com/attachments/1/${i}/f${i}.png?ex=${past}&is=0&hm=0`;
    for (let i = 0; i < 60; i++) store.ingest(acc, { t: 'message', message: { ...msg(100 + i, T0 + i), attachments: [{ kind: 'image', url: link(i) }] }, live: false });
    const key = (u: string) => new Bun.CryptoHasher('sha256').update(u).digest('hex');
    const asked: string[][] = [];
    const fetched: [string, string | undefined][] = [];
    let offline = true;
    const a = new MediaArchiver(
      store,
      cache,
      async (url, _acc, from) => {
        fetched.push([url, from]);
        if (!from) return false;
        writeFileSync(join(cache, key(url)), 'x');
        return true;
      },
      () => {},
      async (account, urls) => {
        expect(account).toBe('acc_dc');
        if (offline) throw new Error('offline');
        asked.push(urls);
        // Discord answers without the old signature, and leaves out one it no longer has.
        return new Map(urls.filter((u) => !u.includes('/7/')).map((u) => [u.split('?')[0], u.split('?')[0] + '?ex=ffffffff&is=1&hm=1']));
      },
    );
    await a.tick();
    // Nothing fetched one by one; all marked for a batch, and the account was offline.
    expect(fetched).toEqual([]);
    expect((store.db.query(`SELECT COUNT(*) AS n FROM media_archive_fail WHERE error = 'expired'`).get() as any).n).toBe(60);
    offline = false;
    // It waits for that account a while, not for ever.
    await a.refreshExpired();
    expect(asked).toEqual([]);
    (a as any).refreshPausedUntil = 0;
    (a as any).accountPausedUntil.clear();
    await a.refreshExpired();
    expect(asked.map((b) => b.length)).toEqual([50, 10]);
    expect(fetched.every(([u, f]) => f && f.startsWith(u.split('?')[0]) && f.includes('ex=ffffffff'))).toBe(true);
    expect(existsSync(join(cache, key(link(0))))).toBe(true);
    expect(store.db.query('SELECT error FROM media_archive_fail').all()).toEqual([{ error: 'gone' }]);
    expect(a.refreshed).toBe(59);
  });
});

test('an account that can’t refresh holds up only its own links', async () => {
  const { store, acc } = world('refresh2');
  const old = store.account(store.createAccount({ id: 'acc_old', network: 'discord', label: 'old', color: '#000', adapter: 'discord' }).id)!;
  store.ingest(old, { t: 'status', status: 'online', self: { nativeId: '9', isSelf: true } });
  const cache = join(dir, 'media-cache-refresh2');
  mkdirSync(cache, { recursive: true });
  const past = (Math.floor(Date.now() / 1000) - 3600).toString(16);
  const link = (i: number) => `https://cdn.discordapp.com/attachments/1/${i}/f.png?ex=${past}&is=0&hm=0`;
  // The old account's links come first in the table.
  store.ingest(old, { t: 'message', message: { ...msg(1, T0, 'dmold'), attachments: [{ kind: 'image', url: link(1) }] }, live: false });
  store.ingest(acc, { t: 'message', message: { ...msg(2, T0), attachments: [{ kind: 'image', url: link(2) }] }, live: false });
  const key = (u: string) => new Bun.CryptoHasher('sha256').update(u).digest('hex');
  const a = new MediaArchiver(
    store,
    cache,
    async (url, _acc, from) => (from ? (writeFileSync(join(cache, key(url)), 'x'), true) : false),
    () => {},
    async (account, urls) => {
      if (account === 'acc_old') throw new Error('the extractor cannot refresh links');
      return new Map(urls.map((u) => [u, u + '&new']));
    },
  );
  await a.tick();
  expect(existsSync(join(cache, key(link(2))))).toBe(true);
  expect(store.db.query('SELECT error FROM media_archive_fail').all()).toEqual([{ error: 'expired' }]);
});
