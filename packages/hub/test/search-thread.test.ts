/**
 * Message search on a thread of its own (search-thread.ts, docs/search.md "On a thread of its own"): the worker's
 * read-only Store answers with the same pages as the hub's own, sees what the hub wrote before each search, and skips a
 * search the hub called off while it was queued.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { mediaSigner } from '../src/mediasign.ts';
import { SearchCalledOff, SearchThread, type SearchAsk } from '../src/search-thread.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-search-thread-'));
const file = join(dir, 'hub.sqlite');
let store: Store;
let thread: SearchThread;

const ask = (q: string, o: Partial<SearchAsk> = {}): SearchAsk => ({ q, limit: 40, cursor: null, context: 1, typing: false, ...o });
const here = (a: SearchAsk) => store.search(a.q, a.limit, a.cursor, a.context, { typing: a.typing });

beforeAll(() => {
  store = new Store(file, mediaSigner('s'));
  const adapters: { stop(): void }[] = [];
  store.db.transaction(() => {
    for (const acc of createDemoAccounts(store)) {
      const adir = join(dir, acc.id);
      mkdirSync(adir, { recursive: true });
      const a = demoFactory(acc, adir)!;
      adapters.push(a);
      a.start((ev) => (ev.t === 'reply' ? undefined : store.ingest(store.account(acc.id)!, ev)));
    }
  })();
  // The world as it began: no chatter landing between the two searches compared.
  for (const a of adapters) a.stop();
  store.flush();
  thread = new SearchThread({ store, file, secret: 's' });
  thread.start();
});

afterAll(() => {
  thread.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the worker answers with the same page as the hub thread, fallbacks and paging included', async () => {
  const common = store.db.query(`SELECT term FROM message_fts_vocab WHERE length(term) >= 5 AND term GLOB '[a-z]*' AND term NOT GLOB 'http*' ORDER BY doc DESC LIMIT 4`).all() as { term: string }[];
  expect(common.length).toBe(4);
  const [a, b, c, d] = common.map((r) => r.term);
  const queries = [
    a,
    a.slice(0, 2),
    `${a} ${b.slice(0, 3)}`,
    `"${c}"`,
    `${d} sort:relevance`,
    `${b} sort:oldest`,
    `${c} has:link`,
    `${a} -${b}`,
    // Inside a word (substring), a typo with two letters swapped (corrected), nothing at all.
    a.slice(1, 4),
    `${b.slice(0, 2)}${b[3]}${b[2]}${b.slice(4)}`,
    'zzqxv',
    'from:a',
  ];
  const seen = new Set<string>();
  for (const q of queries) {
    for (const typing of [false, true]) {
      const asked = ask(q, { typing });
      const page = await thread.search(asked);
      expect({ q, typing, page }).toEqual({ q, typing, page: here(asked) });
      seen.add(`${typing ? 'typing ' : ''}${page.mode}${page.corrected ? ' corrected' : ''}${page.top ? ' top' : ''}`);
    }
  }
  // Every way a search runs was compared.
  for (const way of ['fulltext top', 'substring', 'fulltext corrected top', 'typing fulltext', 'filters']) expect(seen).toContain(way);
  // The next page, by the cursor the first gave.
  const first = here(ask(a.slice(0, 1), { limit: 5 }));
  expect(first.next).not.toBeNull();
  const next = ask(a.slice(0, 1), { limit: 5, cursor: first.next });
  expect(await thread.search(next)).toEqual(here(next));
});

test('what the hub wrote before a search is in it: a new message, a new name', async () => {
  const acc = store.account('acc_demo-signal')!;
  const conv = store.one<{ native_id: string }>(`SELECT native_id FROM conversation WHERE network = 'signal' LIMIT 1`)!.native_id;
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'thread-test-person', displayName: 'Quillon Varnet' } });
  store.ingest(acc, { t: 'message', message: { nativeId: 'thread-test-1', conversation: conv, author: 'thread-test-person', ts: Date.now(), body: 'the plinthwort is blooming' } });
  const page = await thread.search(ask('plinthwort'));
  expect(page.hits.map((h) => h.message.nativeId)).toEqual(['thread-test-1']);
  const people = await thread.search(ask('quillon'));
  expect(people.people.length).toBe(1);
  expect(people.people).toEqual(here(ask('quillon')).people);
  // A rename after the worker loaded its list: found by the new name, and by the old one as what they were.
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'thread-test-person', displayName: 'Orsolya Varnet' } });
  expect((await thread.search(ask('orsolya'))).people.length).toBe(1);
  const was = await thread.search(ask('quillon'));
  expect(was.people[0]?.match).toContain('was');
  expect(was.people).toEqual(here(ask('quillon')).people);
});

test('a search queued behind another is skipped when a newer one comes as you type from the same device', async () => {
  const release = await thread.hold();
  const older = thread.search(ask('bloom', { typing: true }), { key: 'device-a' });
  const olderId = thread.lastAsked;
  // Another device's, and one asked with Enter, are not this one's to replace.
  const other = thread.search(ask('bloo', { typing: true }), { key: 'device-b' });
  const entered = thread.search(ask('blo'), { key: 'device-a' });
  const enteredId = thread.lastAsked;
  const newer = thread.search(ask('blooming', { typing: true }), { key: 'device-a' });
  const newerId = thread.lastAsked;
  // A request gone before the worker came to it.
  const gone = new AbortController();
  const left = thread.search(ask('plinth', { typing: true }), { key: 'device-c', signal: gone.signal });
  const leftId = thread.lastAsked;
  gone.abort();
  await expect(older).rejects.toBeInstanceOf(SearchCalledOff);
  await expect(left).rejects.toBeInstanceOf(SearchCalledOff);
  release();
  expect((await newer).hits.map((h) => h.message.nativeId)).toEqual(['thread-test-1']);
  await Promise.all([other, entered]);
  // The worker answers in order: one asked last comes back after it has said what it did with all the others.
  await thread.search(ask('plinth'));
  expect(thread.ran).toContain(enteredId);
  expect(thread.ran).toContain(newerId);
  expect(thread.ran).not.toContain(olderId);
  expect(thread.ran).not.toContain(leftId);
  expect(thread.skipped).toContain(olderId);
  expect(thread.skipped).toContain(leftId);
});
