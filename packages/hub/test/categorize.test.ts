import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Categorizer, describePlace, isPrivateUrl, JevProvider, KeywordProvider, OllamaProvider, type CategoryInput, type CategoryProvider } from '../src/categorize.ts';
import { categoryThreshold } from '@dither-chat/protocol';
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

/** A stand-in for jev: P(yes) is 0.6 when the question's last word appears in the text. */
function fakeJev(seen: { origin: string | null; bodies: any[] }) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      seen.origin = req.headers.get('origin');
      const b = (await req.json()) as { question: string; texts: string[]; instruct?: string };
      seen.bodies.push(b);
      const word = b.question.replace(/\?$/, '').split(' ').pop()!.toLowerCase();
      return Response.json({ p: b.texts.map((t) => (t.toLowerCase().includes(word) ? 0.6 : 0.01)) });
    },
  });
}

describe('jev provider', () => {
  test('one batched call per question, with names, topics and channels only', async () => {
    const seen = { origin: null as string | null, bodies: [] as any[] };
    const srv = fakeJev(seen);
    const jev = new JevProvider(`http://127.0.0.1:${srv.port}`);
    const inputs: CategoryInput[] = [
      { kind: 'space', id: 'a', network: 'discord', name: 'Rusty', topic: 'borrowck', channels: ['async'] },
      { kind: 'conversation', id: 'b', network: 'signal', name: 'Climbing crew', topic: null, channels: [] },
    ];
    const r = await jev.scoreMany(inputs, [{ id: 'p', name: 'P', question: 'Is it about rusty', keywords: [] }, { id: 'c', name: 'C', question: 'Is it about climbing', keywords: [] }]);
    srv.stop(true);
    expect(seen.bodies.length).toBe(2);
    expect(seen.bodies[0].texts).toEqual(inputs.map(describePlace));
    expect(seen.origin).toBeNull();
    expect(r).toEqual([{ p: 0.6, c: 0.01 }, { p: 0.01, c: 0.6 }]);
    expect(describePlace(inputs[0])).toBe('discord server: Rusty\nTopic: borrowck\nChannels: async');
  });

  test('the categorizer scores in batches, and a probe asks every place once without saving', async () => {
    const seen = { origin: null as string | null, bodies: [] as any[] };
    const srv = fakeJev(seen);
    const c = new Categorizer(store, new JevProvider(`http://127.0.0.1:${srv.port}`));
    await c.refresh(true);
    expect(seen.bodies.length).toBe(store.categories().length);
    expect(hub('space', spaceId())[0].provider).toBe('jev');
    const before = JSON.stringify(store.placeCategories());
    const probe = await c.probe('Is this community about family?');
    srv.stop(true);
    expect(probe.provider).toBe('jev');
    expect(probe.scores.find((x) => x.kind === 'conversation')!.p).toBe(0.6);
    expect(probe.scores.find((x) => x.kind === 'space')!.p).toBe(0.01);
    expect(JSON.stringify(store.placeCategories())).toBe(before);
  });

  test('a probe with jev down falls back to keywords', async () => {
    const c = new Categorizer(store, new JevProvider('http://127.0.0.1:1'));
    const probe = await c.probe('Is this community about rust?');
    expect(probe.provider).toBe('keyword');
    expect(probe.scores.find((x) => x.kind === 'space')!.p).toBeGreaterThan(0.5);
  });

  test('refuses a public address', () => {
    expect(() => new JevProvider('https://jev.example.com')).toThrow('refusing');
  });
});

test('thresholds: saved per category, defaulting by provider', () => {
  const id = store.putCategory({ name: 'Chess', question: 'Chess?', keywords: [], color: null, threshold: 0.07 });
  expect(store.categories().find((c) => c.id === id)!.threshold).toBe(0.07);
  store.putCategory({ ...store.categories().find((c) => c.id === id)!, threshold: null });
  const c = store.categories().find((c) => c.id === id)!;
  expect(c.threshold).toBeNull();
  expect(categoryThreshold(c, 'jev')).toBe(0.12);
  expect(categoryThreshold(c, 'keyword')).toBe(0.5);
  expect(categoryThreshold({ threshold: 0.3 }, 'jev')).toBe(0.3);
  store.deleteCategory(id);
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
