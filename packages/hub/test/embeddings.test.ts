import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  averagePrecision,
  centre,
  crossFit,
  dequantize,
  dot,
  DIMS,
  embedText,
  EmbeddingStore,
  Embeddings,
  fitProbe,
  jevFeatures,
  KnnIndex,
  needsJev,
  outcomeLabels,
  outcomes,
  probeLogit,
  quantize,
  rocAuc,
  timeFolds,
  unit,
  type JevClient,
  type Labelled,
  type Turn,
} from '../src/embeddings.ts';
import { Store, type AccountRow } from '../src/store.ts';

const MIN = 60_000;

/** A seeded random number generator, so the synthetic data is the same every run. */
function rng(seed = 1) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
const randVec = (r: () => number, d = 16) => unit(Array.from({ length: d }, () => gauss(r)));

describe('what is embedded', () => {
  test('shape, then the text', () => {
    expect(embedText({ body: 'can you  review\nmy PR?', shape: 'group' })).toBe('[group chat] can you review my PR?');
  });
  test('a short reply carries the start of what it answers, and whose it was', () => {
    const t = embedText({ body: 'lol', shape: 'direct', reply: { body: 'x'.repeat(300), mine: true } })!;
    expect(t).toBe(`[DM] (replying to your message: "${'x'.repeat(100)}") lol`);
    expect(embedText({ body: 'lol', shape: 'channel', reply: { body: 'hi', mine: false } })).toBe('[channel] (replying to a message: "hi") lol');
  });
  test('a long reply stands alone', () => {
    const long = 'this is a long enough message to stand on its own two feet';
    expect(embedText({ body: long, shape: 'group', reply: { body: 'hi', mine: true } })).toBe(`[group chat] ${long}`);
  });
  test('an empty body: attachment, else link title, else nothing', () => {
    expect(embedText({ body: '', shape: 'group', attachments: [{ kind: 'image', name: 'cat.png' }] })).toBe('[group chat] (image: cat.png)');
    expect(embedText({ body: ' ', shape: 'channel', embedTitle: 'Release notes' })).toBe('[channel] (link: Release notes)');
    expect(embedText({ body: '<@123>', shape: 'channel' })).toBeNull();
  });
});

describe('vectors', () => {
  test('int8 keeps a unit vector to within half a step', () => {
    const v = randVec(rng(3), DIMS);
    const { q, scale } = quantize(v);
    const back = dequantize(q, scale);
    for (let i = 0; i < DIMS; i++) expect(Math.abs(back[i] - v[i])).toBeLessThanOrEqual(scale / 2 + 1e-7);
    expect(dot(back, v)).toBeGreaterThan(0.999);
  });
  test('centring takes the mean away and keeps how far it was', () => {
    const { v, norm } = centre([1, 1, 0], [1, 0, 0]);
    expect([...v]).toEqual([0, 1, 0]);
    expect(norm).toBe(1);
  });
});

describe('labels', () => {
  const t = (id: string, ts: number, mine = false, more: Partial<Turn> = {}): Turn => ({ id, conversation: 'c', ts: ts * MIN, mine, ...more });

  test('a reply answers the message it names; a plain message the last one before it', () => {
    const o = outcomes([t('a', 0), t('b', 1), t('me1', 5, true, { replyTo: 'a' }), t('c', 60), t('me2', 70, true)]);
    expect(o.get('a')!.delay).toBe(5 * MIN);
    expect(o.get('b')!.delay).toBeNull();
    expect(o.get('c')!.delay).toBe(10 * MIN);
    expect(o.has('me1')).toBe(false);
  });
  test('after you speak, the next message is engaged; your second message answers nothing new', () => {
    const o = outcomes([t('a', 0), t('me1', 1, true), t('b', 3), t('me2', 4, true), t('me3', 5, true)]);
    expect(o.get('b')!.engaged).toBe(true);
    expect(o.get('a')!.engaged).toBe(false);
    expect(outcomeLabels(o.get('b')!)).toEqual({});
  });
  test('a reaction counts as at once; the heads have their own windows', () => {
    const o = outcomes([t('a', 0, false, { reacted: true }), t('b', 100), t('me', 200, true)]);
    expect(outcomeLabels(o.get('a')!)).toEqual({ ping: 1, active: 1 });
    expect(outcomeLabels(o.get('b')!)).toEqual({ ping: 0, active: 1 });
  });
  test('conversations do not answer each other', () => {
    const o = outcomes([t('a', 0), { id: 'me', conversation: 'other', ts: MIN, mine: true }]);
    expect(o.get('a')!.delay).toBeNull();
  });
});

describe('the probe', () => {
  // Positives lean along the first axis.
  const r = rng(7);
  const X: Float32Array[] = [];
  const y: number[] = [];
  for (let i = 0; i < 300; i++) {
    const pos = r() < 0.3;
    const v = Array.from({ length: 16 }, () => gauss(r) * 0.3);
    v[0] += pos ? 1 : -0.2;
    X.push(unit(v));
    y.push(pos ? 1 : 0);
  }

  test('learns the direction', () => {
    const p = fitProbe(X, y, { lambda: 1 });
    expect(p.w[0]).toBeGreaterThan(Math.max(...[...p.w].slice(1).map(Math.abs)));
    expect(rocAuc(X.map((x) => probeLogit(p, x)), y as (0 | 1)[])).toBeGreaterThan(0.9);
  });
  test('an offset that already explains the labels leaves little to learn', () => {
    const off = y.map((v) => (v ? 6 : -6));
    const p = fitProbe(X, y, { lambda: 1, offset: off });
    const free = fitProbe(X, y, { lambda: 1 });
    expect(Math.abs(p.w[0])).toBeLessThan(Math.abs(free.w[0]) / 3);
  });
  test('cross-fitted logits come from probes that never saw the example', () => {
    const oof = crossFit(X, y, timeFolds(X.length, 5), { lambda: 1 });
    expect(oof.every((v) => v !== null)).toBe(true);
    expect(rocAuc(oof as number[], y as (0 | 1)[])).toBeGreaterThan(0.85);
    expect(timeFolds(10, 5)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe('kNN', () => {
  const e = (id: string, author: string, conversation: string, x: number[], y: 0 | 1): Labelled => ({ id, author, conversation, x: unit(x), y });
  const author = Array.from({ length: 10 }, (_, i) => e(`a${i}`, 'sam', 'c1', i < 3 ? [1, 0.1 * i] : [0, 1], i < 3 ? 1 : 0));
  const others = Array.from({ length: 10 }, (_, i) => e(`o${i}`, `p${i}`, 'c2', i < 5 ? [0, 1] : [1, 0], i < 5 ? 1 : 0));

  test("the author's own examples first, once there are enough", () => {
    const k = new KnnIndex([...author, ...others], 3);
    // Sam's positives point along x; everyone else's along y.
    expect(k.score(unit([1, 0]), { author: 'sam', conversation: 'c1' })!).toBeGreaterThan(0.5);
    expect(k.score(unit([1, 0]), { author: 'nobody', conversation: 'c2' })!).toBeLessThan(-0.5);
  });
  test('too few in a scope: the next one out; one kind missing everywhere: nothing', () => {
    const k = new KnnIndex([...author.slice(0, 5), ...others], 3);
    expect(k.score(unit([1, 0]), { author: 'sam', conversation: 'c1' })!).toBeLessThan(0);
    expect(new KnnIndex(others.slice(0, 5)).score(unit([1, 0]), {})).toBeNull();
  });
  test('an example can be left out of its own score', () => {
    const k = new KnnIndex(others, 1);
    expect(k.score(others[0].x, { conversation: 'c2' })).toBeCloseTo(1, 5);
    expect(k.score(others[0].x, { conversation: 'c2' }, new Set(['o0', 'o1', 'o2', 'o3', 'o4']))).toBeNull();
  });
});

describe('jev answers', () => {
  test('asked only when triage is unsure', () => {
    expect(needsJev({ ping: 0.5, active: 0.6, interesting: 0.9 })).toBe(true);
    expect(needsJev({ ping: 0.99, active: 0.1, interesting: 0.9 })).toBe(false);
    expect(needsJev({ ping: 0.01, active: 0.03, interesting: 0.2 })).toBe(false);
    expect(needsJev({ ping: 0.03, active: 0.2, interesting: 0.2 })).toBe(true);
    expect(needsJev(null)).toBe(false);
  });
  test('as logits', () => {
    const f = jevFeatures({ ask: 0.5, soon: 0.9 });
    expect(f['jev:ask']).toBeCloseTo(0, 6);
    expect(f['jev:soon']).toBeCloseTo(Math.log(9), 6);
  });
});

describe('metrics', () => {
  test('average precision and ROC AUC as sklearn has them', () => {
    expect(averagePrecision([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBeCloseTo(0.8333, 4);
    expect(rocAuc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBeCloseTo(0.75, 6);
  });
  test('tied scores are one step, so a constant score earns the base rate', () => {
    expect(averagePrecision([1, 1, 1, 1], [1, 0, 0, 0])).toBeCloseTo(0.25, 6);
    expect(rocAuc([1, 1, 1, 1], [1, 0, 0, 1])).toBeCloseTo(0.5, 6);
  });
});

describe('the store', () => {
  let dir: string;
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'dither-emb-'))));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('centred, int8, back again; the mean and raw vector survive', () => {
    const s = new EmbeddingStore(join(dir, 'a.sqlite'));
    const r = rng(11);
    const mean = randVec(r, DIMS).map((x) => x * 0.5);
    s.setMean(Float32Array.from(mean));
    const raw = randVec(r, DIMS);
    s.put([{ id: 'm1', conversation: 'c', author: 'p', ts: 5, raw }]);
    const got = s.vector('m1')!;
    expect(got.conversation).toBe('c');
    expect(dot(got.v, centre(raw, mean).v)).toBeGreaterThan(0.999);
    expect(dot(s.raw(got), raw)).toBeGreaterThan(0.999);
    s.close();
    const again = new EmbeddingStore(join(dir, 'a.sqlite'));
    expect([...again.mean()!]).toEqual([...Float32Array.from(mean)]);
    expect(again.count()).toBe(1);
    again.close();
  });

  test('another model or prompt starts over', () => {
    const s = new EmbeddingStore(join(dir, 'a.sqlite'), 'some other model');
    expect(s.count()).toBe(0);
    expect(s.mean()).toBeNull();
    s.close();
  });

  test('the window keeps labelled examples and their answers', () => {
    const s = new EmbeddingStore(join(dir, 'b.sqlite'));
    s.setMean(new Float32Array(DIMS));
    const now = 100 * 86_400_000;
    const v = randVec(rng(2), DIMS);
    s.put([
      { id: 'old', conversation: 'c', author: null, ts: 1, raw: v },
      { id: 'kept', conversation: 'c', author: null, ts: 1, raw: v },
      { id: 'new', conversation: 'c', author: null, ts: now - 1000, raw: v },
    ]);
    s.setAnswers('old', 1, { ask: 0.2 });
    s.setAnswers('kept', 1, { ask: 0.7 });
    s.keep(['kept']);
    expect(s.prune(now)).toBe(1);
    expect(s.has('old')).toBe(false);
    expect(s.answers('old')).toEqual({});
    expect(s.answers('kept')).toEqual({ ask: 0.7 });
    expect(s.has('new')).toBe(true);
    s.close();
  });
});

/** A stand-in for jev: words map to fixed directions, so "lunch" messages sit together. */
class FakeJev implements JevClient {
  down = false;
  embedded = 0;
  judged: string[] = [];
  async embed(texts: string[]) {
    if (this.down) throw new Error('jev answered 503');
    this.embedded += texts.length;
    return texts.map((t) => {
      const v = new Array(DIMS).fill(0.05);
      v[0] = 1;
      if (/lunch|dinner|plans/.test(t)) v[1] = 1;
      if (/meme|lol/.test(t)) v[2] = 1;
      v[3 + (t.length % 50)] += 0.3;
      return [...unit(v)];
    });
  }
  async judge(question: string, texts: string[]) {
    this.judged.push(question);
    return texts.map((t) => (/lunch/.test(t) ? 0.8 : 0.05));
  }
}

describe('the embedder on a hub', () => {
  let dir: string;
  let store: Store;
  let acc: AccountRow;
  const jev = new FakeJev();
  const now = Date.UTC(2026, 10, 5, 12);
  let emb: Embeddings;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-embhub-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    acc = store.createAccount({ network: 'signal', label: 'main', color: '#000', adapter: 'signal' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'grp', shape: 'group', name: 'Friends' } });
    // In a busy group you answer the lunch plans and not the memes.
    let ts = now - 3 * 86_400_000;
    for (let i = 0; i < 40; i++) {
      const plans = i % 3 === 0;
      ts += 60 * MIN;
      store.ingest(acc, { t: 'message', message: { nativeId: `m${i}`, conversation: 'grp', author: `friend${i % 4}`, ts, body: plans ? `lunch plans ${i}?` : `meme ${i} lol` } });
      if (plans) store.ingest(acc, { t: 'message', message: { nativeId: `r${i}`, conversation: 'grp', author: 'me', ts: ts + 2 * MIN, body: 'yes!', replyTo: `m${i}` } });
    }
    store.ingest(acc, { t: 'message', message: { nativeId: 'old', conversation: 'grp', author: 'friend1', ts: now - 40 * 86_400_000, body: 'too old to embed' } });
    store.ingest(acc, { t: 'message', message: { nativeId: 'pic', conversation: 'grp', author: 'friend1', ts: now - 86_400_000, body: '', attachments: [{ nativeId: 'a', kind: 'image', name: 'x.png', url: 'u' }] } as any });
    emb = new Embeddings(store.db, join(dir, 'embeddings.sqlite'), { jev, now: () => now, batch: 8, meanSample: 50 });
  });
  afterAll(() => {
    emb.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the mean first, then the backfill, skipping your own and old messages', async () => {
    expect(await emb.tick()).toBe('mean');
    expect(emb.store.mean()).not.toBeNull();
    let steps = 0;
    while ((await emb.tick()) !== 'idle' && steps++ < 50);
    expect(emb.store.count()).toBe(41);
    const id = (n: string) => (store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', n) ?? { id: '' }).id;
    expect(emb.store.has(id('r0'))).toBe(false);
    expect(emb.store.has(id('old'))).toBe(false);
    expect(emb.store.has(id('pic'))).toBe(true);
  });

  test('new messages are followed; jev is asked only where you take part', async () => {
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'news', shape: 'channel', name: 'news' } });
    store.ingest(acc, { t: 'message', message: { nativeId: 'n0', conversation: 'news', author: 'friend3', ts: now - 1500, body: 'lunch deals today' } });
    store.ingest(acc, { t: 'message', message: { nativeId: 'n1', conversation: 'grp', author: 'friend2', ts: now - 1000, body: 'lunch tomorrow?' } });
    store.ingest(acc, { t: 'message', message: { nativeId: 'n2', conversation: 'grp', author: 'friend2', ts: now - 500, body: 'meme lol' } });
    const id = (n: string) => store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', n)!.id;
    expect(await emb.tick()).toBe('new');
    expect(emb.store.has(id('n1'))).toBe(true);
    // Asked before triage decides, in a group you write in; not in a channel you only read.
    expect(emb.store.answers(id('n1')).ask).toBeCloseTo(0.8, 6);
    expect(emb.store.answers(id('n2')).ask).toBeCloseTo(0.05, 6);
    expect(emb.store.has(id('n0'))).toBe(true);
    expect(Object.keys(emb.store.answers(id('n0')))).toEqual([]);
    expect(emb.features(id('n1'))['jev:ask']).toBeCloseTo(Math.log(4), 2);
  });

  test('the probe and kNN learn which messages you answer', async () => {
    await emb.refit();
    expect(emb.status().heads).toContain('ping');
    const id = (n: string) => store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', n)!.id;
    const plans = emb.features(id('n1'));
    const meme = emb.features(id('n2'));
    expect(plans.emb).toBeGreaterThan(meme.emb);
    expect(plans.knn).toBeGreaterThan(0);
    expect(meme.knn).toBeLessThan(0);
    // A labelled example gets its cross-fitted logit, not the one from a probe that saw it.
    expect(typeof emb.features(id('m0')).emb).toBe('number');
  });

  test('jev down: the step fails, the features stay what they were', async () => {
    jev.down = true;
    store.ingest(acc, { t: 'message', message: { nativeId: 'n3', conversation: 'grp', author: 'friend2', ts: now - 100, body: 'dinner?' } });
    await expect(emb.tick()).rejects.toThrow('503');
    const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', 'n3')!.id;
    expect(emb.features(id)).toEqual({});
    await emb.prepare([id], 50);
    expect(emb.store.has(id)).toBe(false);
    jev.down = false;
    await emb.prepare([id], 1000);
    expect(emb.store.has(id)).toBe(true);
  });
});

test('the probe picks its own strength from the grid, by its out-of-fold loss', async () => {
  const { chooseLambda, LAMBDAS, timeFolds } = await import('../src/embeddings.ts');
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 60; i++) {
    const pos = i % 3 === 0;
    const v = new Array(8).fill(0).map((_, j) => Math.sin(i * 7 + j) * 0.2);
    v[0] = pos ? 1 : -1;
    X.push(v);
    y.push(pos ? 1 : 0);
  }
  const l = chooseLambda(X, y, timeFolds(60));
  expect(LAMBDAS).toContain(l);
  // A clean signal: a weaker hold on the weights fits it better.
  expect(l).toBeLessThanOrEqual(3);
});
