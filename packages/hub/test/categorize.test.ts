import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Categorizer, isPrivateUrl, KeywordProvider, OllamaProvider, type CategoryInput, type CategoryProvider } from '../src/categorize.ts';
import { Store, type AccountRow } from '../src/store.ts';

let dir: string;
let store: Store;
let acc: AccountRow;

const SECRET = 'the launch code is hunter2';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-cat-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  acc = store.createAccount({ network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
  store.ingest(acc, { t: 'space', space: { nativeId: 'g', kind: 'community', name: 'Rust Programming', topic: 'help with borrowck' } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'ch', shape: 'channel', name: 'async-help', spaces: [{ nativeId: 'g' }] } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'grp', shape: 'group', name: 'Family' } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', name: 'Someone' } });
  store.ingest(acc, { t: 'message', message: { nativeId: 'm', conversation: 'ch', author: 'x', ts: 1, body: SECRET } });
});

afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cat = (name: string) => store.categories().find((c) => c.name === name)!;
const hub = (kind: string, id: string) => store.placeCategories().filter((x) => x.kind === kind && x.id === id);
const spaceId = () => new Categorizer(store).inputs().find((i) => i.kind === 'space')!.id;

describe('input', () => {
  test('names, topics and channel names, and never a message or a DM', () => {
    const inputs = new Categorizer(store).inputs();
    expect(inputs.map((i) => i.name).sort()).toEqual(['Family', 'Rust Programming']);
    expect(inputs.find((i) => i.kind === 'space')!.channels).toEqual(['async-help']);
    expect(JSON.stringify(inputs)).not.toContain('hunter2');
  });
});

describe('keyword provider', () => {
  const q = { id: 'q', name: 'Programming', question: '?', keywords: ['rust', 'code'] };
  const input: CategoryInput = { kind: 'space', id: 's', network: 'discord', name: 'Rust folk', topic: null, channels: [] };
  test('is deterministic and needs no model', async () => {
    const p = new KeywordProvider();
    const a = await p.score(input, [q]);
    expect(a.q).toBe(0.8);
    expect(await p.score(input, [q])).toEqual(a);
  });
  test('matches at the start of words only', async () => {
    const r = await new KeywordProvider().score({ ...input, name: 'Trusted barcode' }, [q]);
    expect(r.q).toBe(0);
  });
  test('channels add up, weakly', async () => {
    const r = await new KeywordProvider().score({ ...input, name: 'x', channels: ['rust-a', 'rust-b'] }, [q]);
    expect(r.q).toBeCloseTo(0.44, 2);
  });
  test('a category with no keywords uses its name and question', async () => {
    const r = await new KeywordProvider().score({ ...input, name: 'Chess club' }, [{ id: 'c', name: 'Chess', question: 'Is this about chess?', keywords: [] }]);
    expect(r.c).toBe(0.8);
  });
});

describe('categorizer', () => {
  test('scores everything with defaults, and overrides beat it', async () => {
    await new Categorizer(store).refresh();
    const sid = spaceId();
    const prog = hub('space', sid).find((x) => x.categoryId === cat('Programming').id)!;
    expect(prog.p).toBeGreaterThanOrEqual(0.5);
    expect(prog.provider).toBe('keyword');
    store.setCategoryOverride(cat('Programming').id, 'space', sid, false);
    store.setCategoryOverride(cat('Gaming').id, 'space', sid, true);
    await new Categorizer(store).refresh(true);
    const rows = hub('space', sid);
    expect(rows.find((x) => x.categoryId === cat('Programming').id)).toMatchObject({ override: false });
    expect(rows.find((x) => x.categoryId === cat('Gaming').id)).toMatchObject({ override: true });
    store.setCategoryOverride(cat('Programming').id, 'space', sid, null);
    expect(hub('space', sid).find((x) => x.categoryId === cat('Programming').id)).toMatchObject({ override: null });
    store.setCategoryOverride(cat('Gaming').id, 'space', sid, null);
  });

  test('asks again only when the input or the questions changed', async () => {
    let calls = 0;
    const counting: CategoryProvider = { id: 'count', score: async (_i, qs) => (calls++, Object.fromEntries(qs.map((q) => [q.id, 0.5]))) };
    const c = new Categorizer(store, counting);
    await c.refresh();
    expect(calls).toBe(2);
    await c.refresh();
    expect(calls).toBe(2);
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'ch2', shape: 'channel', name: 'new-channel', spaces: [{ nativeId: 'g' }] } });
    await c.refresh();
    expect(calls).toBe(3);
    const added = store.putCategory({ name: 'Chess', question: 'Chess?', keywords: [], color: null });
    await c.refresh();
    expect(calls).toBe(5);
    store.deleteCategory(added);
    expect(store.placeCategories().some((x) => x.categoryId === added)).toBe(false);
  });

  test('a failing provider falls back to keywords', async () => {
    const broken: CategoryProvider = { id: 'broken', score: async () => { throw new Error('down'); } };
    await new Categorizer(store, broken).refresh(true);
    expect(hub('space', spaceId())[0].provider).toBe('keyword');
  });
});

describe('ollama provider', () => {
  test('sends only names to the local model, and reads probabilities', async () => {
    let sent = '';
    const srv = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = (await req.json()) as { prompt: string };
        sent = body.prompt;
        return Response.json({ response: JSON.stringify({ a: 0.9, b: 7 }) });
      },
    });
    const qs = [{ id: 'a', name: 'A', question: 'Is it A?', keywords: [] }, { id: 'b', name: 'B', question: 'Is it B?', keywords: [] }];
    const r = await new OllamaProvider(`http://127.0.0.1:${srv.port}`, 'm').score({ kind: 'space', id: 's', network: 'discord', name: 'Rusty', topic: 't', channels: ['c'] }, qs);
    srv.stop(true);
    expect(r).toEqual({ a: 0.9, b: 1 });
    expect(sent).toContain('Rusty');
    expect(sent).toContain('Is it A?');
  });
  test('refuses a public address by default', () => {
    expect(() => new OllamaProvider('https://api.example.com', 'm')).toThrow('refusing');
    expect(isPrivateUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isPrivateUrl('http://100.64.0.20:11434')).toBe(true);
    expect(isPrivateUrl('http://192.168.1.2')).toBe(true);
    expect(isPrivateUrl('http://8.8.8.8')).toBe(false);
    expect(isPrivateUrl('https://api.openai.com')).toBe(false);
  });
});

test('stats: messages this week and when you last posted', () => {
  const s = store.placeStats(0);
  expect(Object.values(s.week).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
});
