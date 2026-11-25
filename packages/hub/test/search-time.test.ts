/**
 * Search's time index and ranking (docs/search.md, "How a search runs" and "Ranking"): newest and oldest first by a
 * walk along search_time, paging without gaps or repeats, filling it in for messages from before it, a taken key, the
 * top matches above the newest, and people search kept current as names change.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { searchKey, Store, type AccountRow } from '../src/store.ts';
import { whole } from '../src/slices.ts';
import { memTempDir } from './fixtures/memdir.ts';

let dir: string;
let store: Store;
let d: AccountRow;
const DAY = 86_400_000;
const NOW = Date.now();

const say = (nativeId: string, conversation: string, author: string, ts: number, body: string) =>
  store.ingest(d, { t: 'message', message: { nativeId, conversation, author, ts, body } });
const ids = (hits: { message: { nativeId: string } }[]) => hits.map((h) => h.message.nativeId);
/** Every page of a search, in order. */
function all(q: string, limit = 3): string[] {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const p = store.search(q, limit, cursor);
    out.push(...ids(p.hits));
    cursor = p.next;
  } while (cursor);
  return out;
}

beforeEach(() => {
  // In memory: each test opens and closes a database file, and a close syncs it to disk. On a busy disk that took
  // tens of seconds and timed these out (memdir.ts). One test opens the file again, so it is a file, not ':memory:'.
  dir = memTempDir('dither-search-time-');
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  d = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann' } });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'zed', displayName: 'Zed' } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', name: 'Ann' } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'big', shape: 'channel', name: 'general' } });
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the time index', () => {
  test('a new database has it from the start, and every message in it', () => {
    expect(store.searchIndexReady).toBe(true);
    for (let i = 0; i < 8; i++) say(`m${i}`, 'big', 'zed', NOW - i * DAY, `pizza number ${i}`);
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM search_key')!.n).toBe(8);
  });

  test('newest first and oldest first, page by page, with nothing missed or repeated', () => {
    // Arrival order is not time order: an import brings old messages after new ones.
    const order = [3, 0, 7, 5, 1, 6, 2, 4];
    for (const i of order) say(`m${i}`, 'big', 'zed', NOW - i * DAY, `pizza number ${i}`);
    expect(all('piz sort:newest')).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(all('piz sort:oldest')).toEqual(['m7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1', 'm0']);
    expect(store.search('p sort:newest', 3).next).toMatch(/^t\d+$/);
  });

  test('a time with a fraction of a millisecond still goes in', () => {
    say('f', 'big', 'zed', NOW + 0.5, 'pizza half');
    expect(ids(store.search('half').hits)).toEqual(['f']);
  });

  test('an edit and a delete reach it', () => {
    say('a', 'big', 'zed', NOW, 'pizza tonight');
    store.db.query(`UPDATE message SET body = 'tacos tonight' WHERE native_id = 'a'`).run();
    expect(ids(store.search('tacos').hits)).toEqual(['a']);
    expect(ids(store.search('pizza').hits)).toEqual([]);
    store.db.query(`DELETE FROM message WHERE native_id = 'a'`).run();
    expect(store.search('tacos').hits).toEqual([]);
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM search_key')!.n).toBe(0);
  });

  test('a key already taken moves up to a free one, so the message still goes in', () => {
    const ts = NOW;
    const next = store.one<{ n: number }>('SELECT COALESCE(MAX(rowid), 0) + 1 AS n FROM message')!.n;
    // Something holds the key this message would take, and the one after it.
    store.db.query('INSERT INTO search_key (key, msg) VALUES (?, ?), (?, ?)').run(searchKey(ts, next), 'x1', searchKey(ts, next) + 1, 'x2');
    say('k', 'big', 'zed', ts, 'pizza clash');
    expect(store.one<{ key: number }>(`SELECT key FROM search_key WHERE msg = (SELECT id FROM message WHERE native_id = 'k')`)!.key).toBe(searchKey(ts, next) + 2);
    expect(ids(store.search('clash').hits)).toEqual(['k']);
  });

  test('messages from before it are filled in, and search goes the old way until then', () => {
    for (let i = 0; i < 300; i++) say(`m${i}`, 'big', 'zed', NOW - i * 60_000, `pizza ${i}`);
    const before = all('pizza sort:newest', 50);
    // As a database from before the index: none of it there.
    store.db.exec(`DELETE FROM search_time; DELETE FROM search_key; DELETE FROM meta WHERE key LIKE 'search_time%'`);
    const path = join(dir, 'hub.sqlite');
    store.db.close();
    store = new Store(path, (raw) => raw ?? null);
    expect(store.searchIndexReady).toBe(false);
    expect(all('pizza sort:newest', 50)).toEqual(before);
    let slices = 0;
    const g = store.fillSearchIndexSteps();
    while (!g.next().done) slices++;
    expect(slices).toBeGreaterThan(1);
    expect(store.searchIndexReady).toBe(true);
    expect(store.search('pizza sort:newest', 50).next).toMatch(/^t/);
    expect(all('pizza sort:newest', 50)).toEqual(before);
  });
});

describe('top matches', () => {
  test('with no sort, the best few come first, a reason with each', () => {
    // Older and in a DM, the words together: beats newer passing mentions in a big channel.
    say('dm1', 'dm', 'ann', NOW - 3 * DAY, 'pizza oven on saturday?');
    for (let i = 0; i < 6; i++) say(`c${i}`, 'big', 'zed', NOW - i * 60_000, `someone said pizza and oven ${i} times in a long rambling message about many other things`);
    const p = store.search('pizza oven', 50);
    expect(p.top?.length).toBe(3);
    expect(p.top![0].message.nativeId).toBe('dm1');
    expect(p.top![0].why).toContain('DM');
    expect(ids(p.hits)[0]).toBe('c0');
    expect(store.search('pizza oven sort:newest', 50).top).toBeUndefined();
    expect(ids(store.search('pizza oven sort:relevance', 50).hits)[0]).toBe('dm1');
  });

  test('none for a handful of hits', () => {
    say('a', 'big', 'zed', NOW, 'rare word');
    expect(store.search('rare').top).toBeUndefined();
  });
});

describe('people search stays current', () => {
  test('a rename, a new identity and a new note are found at the next search', () => {
    expect(store.findPeople('ann').length).toBe(1);
    store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Annabel Lee' } });
    expect(store.findPeople('annabel').length).toBe(1);
    store.ingest(d, { t: 'identity', identity: { nativeId: 'quinn', displayName: 'Quinn' } });
    expect(store.findPeople('quin').length).toBe(1);
    whole(store.loadPeopleSteps());
    expect(store.findPeople('zoe')).toEqual([]);
    store.ingest(d, { t: 'identity', identity: { nativeId: 'zoe', displayName: 'Zoë' } });
    // Accents fold now: typed without one, still found.
    expect(store.findPeople('zoe').length).toBe(1);
  });
});
