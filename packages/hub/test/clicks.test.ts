/**
 * Button counts (docs/button-counts.md): what the hub accepts, how it adds up, and its API.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLICK_BATCH_MAX, CLICK_BODY_MAX, CLICK_KEY_MAX, cleanClick, localDay, type ClicksView } from '@dither-chat/protocol';
import { ClickCounts } from '../src/clicks.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 9, 12).getTime();
const today = localDay(NOW);
const ago = (d: number) => localDay(NOW - d * DAY);
const c = (key: string, n = 1, extra: Record<string, unknown> = {}) => ({ day: today, key, page: 'inbox', device: 'desktop', n, ...extra });

describe('what the hub accepts', () => {
  test('a key and page from code, a known device, a day near today, a count of one or more', () => {
    expect(cleanClick(c('inbox: row (DM, unread)', 3), NOW)).toEqual({ day: today, key: 'inbox: row (DM, unread)', page: 'inbox', device: 'desktop', n: 3 });
    expect(cleanClick(c('x'.repeat(CLICK_KEY_MAX)), NOW)).not.toBeNull();
    expect(cleanClick(c('x'.repeat(CLICK_KEY_MAX + 1)), NOW)).toBeNull();
    expect(cleanClick(c('inbox: row', 1, { page: 'p'.repeat(33) }), NOW)).toBeNull();
    // Nothing that is not plain printable text, and no padding.
    expect(cleanClick(c('inbox: row\n'), NOW)).toBeNull();
    expect(cleanClick(c(' inbox: row'), NOW)).toBeNull();
    expect(cleanClick(c('inbox: rów'), NOW)).toBeNull();
    expect(cleanClick(c(''), NOW)).toBeNull();
    expect(cleanClick(c('inbox: row', 1, { key: 42 }), NOW)).toBeNull();
    expect(cleanClick(c('inbox: row', 1, { device: 'tablet' }), NOW)).toBeNull();
    expect(cleanClick(c('inbox: row', 0), NOW)).toBeNull();
    expect(cleanClick(c('inbox: row', -5), NOW)).toBeNull();
    expect(cleanClick(c('inbox: row', 1e9), NOW)!.n).toBe(10_000);
    // A day either side of the hub's is fine; a year and more ago, or next week, is not.
    expect(cleanClick(c('inbox: row', 1, { day: localDay(NOW + DAY) }), NOW)).not.toBeNull();
    expect(cleanClick(c('inbox: row', 1, { day: localDay(NOW + 7 * DAY) }), NOW)).toBeNull();
    expect(cleanClick(c('inbox: row', 1, { day: ago(500) }), NOW)).toBeNull();
    expect(cleanClick(c('inbox: row', 1, { day: '2026-11-9' }), NOW)).toBeNull();
    expect(cleanClick(c('inbox: row', 1, { day: 1762689600000 }), NOW)).toBeNull();
  });
});

describe('the table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-clicks-'));
  const store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const clicks = new ClickCounts(store.db);
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('adds batches up per day, key, page and device, and counts a resent batch once', () => {
    expect(clicks.apply('b1', [c('inbox: row (DM, unread)', 2), c('triage: vote up'), c('bogus\u0000', 5)], NOW)).toBe(2);
    expect(clicks.apply('b1', [c('inbox: row (DM, unread)', 2)], NOW)).toBe(0);
    clicks.apply('b2', [c('inbox: row (DM, unread)', 3), c('inbox: row (DM, unread)', 4, { device: 'phone' }), c('inbox: row (DM, unread)', 1, { page: 'conversation' })], NOW);
    const v = clicks.totals(7, 'device', 200, NOW);
    expect(v.total).toBe(11);
    expect(v.since).toBe(ago(6));
    expect(v.keys).toEqual([
      { key: 'inbox: row (DM, unread)', n: 10, phone: 4, desktop: 6 },
      { key: 'triage: vote up', n: 1, phone: 0, desktop: 1 },
    ]);
    expect(clicks.totals(7, 'page', 200, NOW).keys).toEqual([
      { key: 'inbox: row (DM, unread)', page: 'inbox', n: 9 },
      { key: 'inbox: row (DM, unread)', page: 'conversation', n: 1 },
      { key: 'triage: vote up', page: 'inbox', n: 1 },
    ]);
    expect(clicks.totals(7, null, 1, NOW).keys).toEqual([{ key: 'inbox: row (DM, unread)', n: 10 }]);
  });

  test('only the days asked for; a batch over the limit stops at it', () => {
    clicks.apply('b3', [c('people: chip (friends)', 50, { day: ago(10) })], NOW);
    expect(clicks.totals(7, null, 200, NOW).keys.map((k) => k.key)).not.toContain('people: chip (friends)');
    expect(clicks.totals(30, null, 200, NOW).keys[0]).toEqual({ key: 'people: chip (friends)', n: 50 });
    const many = Array.from({ length: CLICK_BATCH_MAX + 20 }, (_, i) => c(`settings: k${i}`));
    expect(clicks.apply('b4', many, NOW)).toBe(CLICK_BATCH_MAX);
  });

  test('forget takes everything', () => {
    clicks.forget();
    expect(clicks.totals(365, null, 200, NOW)).toMatchObject({ total: 0, keys: [] });
    // And the batch ids, so nothing is skipped after.
    expect(clicks.apply('b1', [c('inbox: search')], NOW)).toBe(1);
  });
});

describe('the API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-clicks-api-'));
  let port = 0;
  let server: HubServer;
  let store: Store;
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const self = () => ({ 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` });
  const now = Date.now();
  const day = localDay(now);
  const post = (body: unknown, headers: Record<string, string> = self()) => fetch(url('/api/usage/clicks'), { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const get = (q = '') => fetch(url(`/api/usage/clicks${q}`)).then((r) => r.json() as Promise<ClicksView>);

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    const sup = { authorize: () => null, online: () => false } as any;
    server = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    port = server.start().port!;
  });
  afterAll(() => {
    server.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('counts in from the app, totals out sorted, by device if asked', async () => {
    const counts = [
      { day, key: 'triage: vote up', page: 'triage', device: 'phone', n: 2 },
      { day, key: 'inbox: filter (Unread)', page: 'inbox', device: 'desktop', n: 5 },
      { day, key: 'triage: vote up', page: 'inbox', device: 'desktop', n: 1 },
      { day, key: 'k'.repeat(CLICK_KEY_MAX + 1), page: 'inbox', device: 'desktop', n: 9 },
    ];
    const r = await post({ batch: 'a1', counts });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ applied: 3 });
    expect(await (await post({ batch: 'a1', counts })).json()).toEqual({ applied: 0 });

    const all = await get('?days=7');
    expect(all.days).toBe(7);
    expect(all.total).toBe(8);
    expect(all.keys).toEqual([
      { key: 'inbox: filter (Unread)', n: 5 },
      { key: 'triage: vote up', n: 3 },
    ]);
    const split = await get('?days=30&by=device');
    expect(split.days).toBe(30);
    expect(split.keys).toEqual([
      { key: 'inbox: filter (Unread)', n: 5, phone: 0, desktop: 5 },
      { key: 'triage: vote up', n: 3, phone: 2, desktop: 1 },
    ]);
    expect((await get('?days=5000')).days).toBe(365);
    expect((await get('?days=nonsense')).days).toBe(7);
    // Without an Origin it is not a browser (the CLI, scripts/clicks.ts): allowed, as for every route.
    expect((await post({ counts: [{ day, key: 'inbox: search', page: 'inbox', device: 'desktop', n: 1 }] }, { 'content-type': 'application/json' })).status).toBe(200);
  });

  test('another site cannot write or forget, and a body too big or not a list is refused', async () => {
    const evil = { 'content-type': 'application/json', origin: 'https://evil.example' };
    const one = { counts: [{ day, key: 'evil: press', page: 'inbox', device: 'desktop', n: 1000 }] };
    expect((await post(one, evil)).status).toBe(403);
    expect((await fetch(url('/api/usage/clicks'), { method: 'DELETE', headers: evil })).status).toBe(403);
    expect((await get()).keys.map((k) => k.key)).not.toContain('evil: press');

    const big = JSON.stringify({ counts: [{ day, key: 'x', page: 'inbox', device: 'desktop', n: 1, pad: 'p'.repeat(CLICK_BODY_MAX) }] });
    expect((await post(big)).status).toBe(413);
    expect((await post({ counts: 'lots' })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
  });

  test('DELETE forgets it all', async () => {
    expect((await fetch(url('/api/usage/clicks'), { method: 'DELETE', headers: self() })).status).toBe(200);
    expect(await get('?days=365')).toMatchObject({ total: 0, keys: [] });
  });
});
