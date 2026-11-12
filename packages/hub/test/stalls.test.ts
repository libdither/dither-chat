/**
 * The hub's background work in slices (docs/perf.md, "The hub's own stalls"). After a restart the embedder's refit
 * held the event loop for 10 to 40 s at a time, and the media archiver's scans for a second or more every minute, so
 * devices waited minutes for their bootstrap. Each is now a generator or loop that gives the loop a turn every few
 * thousand rows (slices.ts). Then live traffic: triage of each arriving message read its conversation's last 90 days
 * for the activity features, 0.6 to 1.2 s for a busy channel every five minutes; it reads them a page at a time now.
 *
 * Counted, never timed: a test clock ends a slice at every chance, `onSlice` says what each one worked through, and no
 * slice may go over SLICE_ROWS (a row read, or an example visited once) by more than one step. The answers are the
 * same as running the work straight through, to the last bit. The refit's real times are printed, not judged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityStore } from '../src/activity.ts';
import { DIMS, EmbeddingStore, Embeddings, fitProbe, fitProbeSteps, unit, type JevClient } from '../src/embeddings.ts';
import { MediaArchiver } from '../src/mediaarchive.ts';
import { SLICE_ROWS, sliced, whole, type SliceOptions } from '../src/slices.ts';
import { noteWork, pathShape, StallWatch } from '../src/stalls.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { SELF_SQL } from '../src/interact.ts';
import { SELF_SQL as RANK_SELF_SQL } from '../src/rankhistory.ts';
import { selfIdentities } from '../src/embeddings.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A seeded random number generator, so the world is the same every run. */
function rng(seed = 1) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

/** Slice options that end a slice at every chance and count what each did. */
function everyChance(slices: number[]): SliceOptions {
  return { clock: () => 0, budgetMs: 0, pause: async () => {}, onSlice: (n) => slices.push(n) };
}

describe('slices', () => {
  function* job() {
    let s = 0;
    for (let i = 0; i < 10; i++) {
      s += i;
      yield 3;
    }
    return s;
  }

  test('a sliced job gives the answer it gives straight through, with a turn of the event loop between slices', async () => {
    let t = 0;
    let turns = 0;
    const slices: number[] = [];
    // The clock moves one ms each time it is read: two yields to a slice of two ms.
    const r = await sliced('test job', job(), { clock: () => t++, budgetMs: 2, pause: async () => void turns++, onSlice: (n) => slices.push(n) });
    expect(r).toBe(whole(job()));
    expect(slices).toEqual([6, 6, 6, 6, 6]);
    expect(turns).toBe(5);
  });
});

describe("the embedder's refit", () => {
  test('the probe: the same weights sliced as straight through, and no more than a slice of rows between turns', async () => {
    const r = rng(7);
    const n = 1200;
    const hidden = unit(Array.from({ length: DIMS }, () => gauss(r)));
    const X = Array.from({ length: n }, () => unit(Array.from({ length: DIMS }, () => gauss(r))));
    const y = X.map((x) => (x.reduce((s, v, j) => s + v * hidden[j], 0) + 0.3 * gauss(r) > 0 ? 1 : 0));
    const o = { lambda: 3, offset: X.map(() => gauss(r) * 0.5), weight: X.map((_, i) => (i % 3 ? 0.5 : 1)) };
    const straight = fitProbe(X, y, o);
    const slices: number[] = [];
    const p = await sliced('probe', fitProbeSteps(X, y, o), everyChance(slices));
    expect([...p.w]).toEqual([...straight.w]);
    expect(p.b).toBe(straight.b);
    // A row of the bound counts as a quarter of the dimensions: one is the most a slice goes over by.
    const step = Math.round((DIMS + 1) / 4);
    expect(Math.max(...slices)).toBeLessThanOrEqual(SLICE_ROWS + step);
    // The bound alone is n rows of that: many slices, not one.
    expect(slices.length).toBeGreaterThan((n * step) / (SLICE_ROWS + step));
  });

  /** Vectors from the text: answered plans lean one way, memes the other, the rest is noise. */
  class FakeJev implements JevClient {
    async embed(texts: string[]) {
      return texts.map((t) => {
        const r = rng([...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 2 ** 31, 7) || 1);
        const v = Array.from({ length: DIMS }, () => gauss(r));
        if (/plans/.test(t)) v[0] += 4;
        if (/meme/.test(t)) v[1] += 4;
        return [...unit(v)];
      });
    }
    async judge(_q: string, texts: string[]) {
      return texts.map(() => 0.05);
    }
  }

  let dir: string;
  let store: Store;
  let acc: AccountRow;
  const now = Date.UTC(2026, 10, 10, 12);
  let emb: Embeddings;
  /** Messages from others that a refit learns from. */
  const labelled: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dither-stalls-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    acc = store.createAccount({ network: 'signal', label: 'main', color: '#000', adapter: 'signal' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    store.db.transaction(() => {
      for (const g of ['a', 'b', 'c']) store.ingest(acc, { t: 'conversation', conversation: { nativeId: g, shape: 'group', name: g } });
      // Three weeks of a few groups: you answer the plans within the hour, and leave the memes.
      let ts = now - 21 * DAY;
      for (let i = 0; i < 360; i++) {
        const g = ['a', 'b', 'c'][i % 3];
        const plans = i % 3 === 0 || i % 7 === 0;
        ts += 80 * MIN;
        store.ingest(acc, { t: 'message', message: { nativeId: `m${i}`, conversation: g, author: `friend${i % 5}`, ts, body: plans ? `plans for ${i}?` : `meme ${i}` } });
        if (plans) store.ingest(acc, { t: 'message', message: { nativeId: `r${i}`, conversation: g, author: 'me', ts: ts + 20 * MIN, body: 'yes', replyTo: `m${i}` } });
      }
    })();
    for (const r of store.db.query(`SELECT native_id FROM message WHERE native_id LIKE 'm%'`).all() as { native_id: string }[]) labelled.push(store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', r.native_id)!.id);
    emb = new Embeddings(store.db, join(dir, 'embeddings.sqlite'), { jev: new FakeJev(), now: () => now, batch: 64, meanSample: 100 });
    for (let i = 0; i < 100 && (await emb.tick()) !== 'idle'; i++);
  });
  afterAll(() => {
    emb.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('on a hub: the same features sliced as straight through, and no more than a slice of rows between turns', async () => {
    const features = () => Object.fromEntries(labelled.map((id) => [id, emb.features(id)]));
    let t = performance.now(); // wall-clock: printed, never judged
    await emb.refit({ budgetMs: Infinity });
    const straightMs = performance.now() - t; // wall-clock: printed, never judged
    const straight = features();
    expect(emb.status().heads).toEqual(['important']);
    expect(Object.values(straight).filter((f) => typeof f.emb === 'number').length).toBeGreaterThan(200);

    const slices: number[] = [];
    await emb.refit(everyChance(slices));
    expect(features()).toEqual(straight);
    // The largest step is a fold of the probe's bound (a quarter of the dimensions a row).
    expect(Math.max(...slices)).toBeLessThanOrEqual(SLICE_ROWS + Math.round((DIMS + 1) / 4));
    // Twenty-six fits of a few hundred examples each, sixty passes at most: hundreds of turns, not three.
    expect(slices.length).toBeGreaterThan(100);

    // With the hub's own clock: how long the longest slice was, against the whole refit in one go.
    let longest = 0;
    let begun = 0;
    let n = 0;
    t = performance.now(); // wall-clock: printed, never judged
    await emb.refit({
      clock: () => {
        const x = performance.now(); // wall-clock: printed, never judged
        if (!begun) begun = x;
        return x;
      },
      onSlice: () => {
        const x = performance.now(); // wall-clock: printed, never judged
        longest = Math.max(longest, x - begun);
        begun = 0;
        n++;
      },
    });
    const line = `embeddings refit on ${labelled.length} labelled messages: ${Math.round(straightMs)} ms in one go; sliced, ${Math.round(performance.now() - t)} ms in ${n} slices, the longest ${Math.round(longest)} ms`; // wall-clock: printed, never judged
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line} (printed, not judged)\n`);
  });

  test('with no questions for jev, new messages are not looked into: that read every conversation, seconds after a restart', async () => {
    let looked = 0;
    const own = (emb as unknown as { takesPart: (...a: unknown[]) => boolean }).takesPart;
    (emb as unknown as { takesPart: () => boolean }).takesPart = () => (looked++, true);
    try {
      await emb.askJev(labelled.slice(0, 50));
      expect(looked).toBe(0);
    } finally {
      (emb as unknown as { takesPart: typeof own }).takesPart = own;
    }
  });

  test('a start refits once: at its first step, and not again at its first idle step when the backfill was done before', async () => {
    const at = (backfill: string) => {
      const p = join(dir, `emb-${backfill}.sqlite`);
      const s = new EmbeddingStore(p);
      s.set('backfill', backfill);
      s.close();
      return new Embeddings(store.db, p, { jev: new FakeJev(), now: () => now });
    };
    const done = at('0');
    expect(done.refitDue('new')).toBe(true);
    await done.refit();
    expect(done.refitDue('new')).toBe(false);
    expect(done.refitDue('idle')).toBe(false);
    done.close();
    // Still filling in: once more when it first runs out, as most labelled messages only have vectors from then.
    const filling = at('500');
    expect(filling.refitDue('backfill')).toBe(true);
    await filling.refit();
    expect(filling.refitDue('backfill')).toBe(false);
    expect(filling.refitDue('idle')).toBe(true);
    expect(filling.refitDue('idle')).toBe(false);
    filling.close();
  });
});

describe('the media archiver', () => {
  test('its walks over every attachment give the event loop a turn every few hundred', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dither-stalls-media-'));
    const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    try {
      const acc = store.createAccount({ network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
      store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
      store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'g', shape: 'group', name: 'g' } });
      const N = 1500;
      store.db.transaction(() => {
        for (let i = 0; i < N; i++)
          store.ingest(acc, { t: 'message', message: { nativeId: `m${i}`, conversation: 'g', author: 'friend', ts: Date.UTC(2026, 10, 1) + i, body: '', attachments: [{ nativeId: `a${i}`, kind: 'image', name: 'x.png', url: `https://media.example/${i}.png` }] } } as any);
      })();
      const key = (url: string) => new Bun.CryptoHasher('sha256').update(url).digest('hex');
      // One failure from long ago near the end, to retry; one expired link whose attachment is gone, to look for.
      store.db.query('INSERT INTO media_archive_fail (key, tries, last_at, error) VALUES (?, 1, 0, NULL)').run(key(`https://media.example/${N - 100}.png`));
      store.db.query(`INSERT INTO media_archive_fail (key, tries, last_at, error) VALUES (?, 3, 0, 'expired')`).run(key('https://media.example/gone.png'));
      const fetched: string[] = [];
      const archiver = new MediaArchiver(store, join(dir, 'cache'), async (url) => (fetched.push(url), true), () => {}, async () => new Map());
      const slices: number[] = [];
      archiver.slices = everyChance(slices);
      await archiver.tick();
      // Every attachment but the failed one in the walk, then the failed one again from the retries' scan.
      expect(fetched.length).toBe(N);
      expect(fetched.at(-1)).toBe(`https://media.example/${N - 100}.png`);
      expect(store.one('SELECT 1 AS x FROM media_archive_fail WHERE error IS NULL')).toBeNull();
      expect(Math.max(...slices)).toBeLessThanOrEqual(256);
      // The walk turns at each file; the retries' scan read N - 100 and the expired links' all N, 256 at a time.
      expect(slices.filter((n) => n === 256).length).toBe(Math.floor((N - 100) / 256) + Math.floor(N / 256));
    } finally {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the adapter-event path', () => {
  test("deciding on a message in a busy channel reads its log a page at a time, with the features read in one go", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dither-stalls-activity-'));
    const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    try {
      const acc = store.createAccount({ network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
      store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
      store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'busy', shape: 'channel', name: 'busy' } });
      const now = Date.UTC(2026, 10, 12, 12);
      const N = 1200;
      // Two months of a busy channel: others write, triage decided on each, a push now and then; you write now and then.
      store.db.transaction(() => {
        for (let i = 0; i < N; i++) {
          const ts = now - 60 * DAY + i * 70 * MIN;
          const mine = i % 10 === 9;
          store.ingest(acc, { t: 'message', message: { nativeId: `m${i}`, conversation: 'busy', author: mine ? 'me' : `friend${i % 7}`, ts, body: `message ${i}` } });
          if (!mine) {
            const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', `m${i}`)!.id;
            store.db.query(`INSERT INTO triage (message_id, decision, reasons, decided_by, created_at) VALUES (?, ?, '[]', 'rules', ?)`).run(id, i % 13 === 0 ? 'push' : 'drop', ts);
          }
        }
      })();
      const cid = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'busy'`)!.id;
      const a = new ActivityStore(store, { featuresInTriage: true });
      a.setSettings({ enabled: true, retentionDays: 365 });
      a.featurePage = 100;
      for (let k = 0; k < 4; k++) {
        const t = now - (k + 1) * 7 * DAY;
        const nid = a.notification({ kind: 'message', conversationId: cid }, t)!;
        a.visits([{ id: `v${k}`, view: 'conversation', conversationId: cid, start: t + 3 * MIN, end: t + 5 * MIN, active: 90, source: 'notification', pushId: nid, closed: true, sent: 0 } as any], t + 6 * MIN);
      }
      const straight = new ActivityStore(store, { featuresInTriage: true }).features(cid, now)!;
      expect(straight.conversation.pushes).toBe(4);
      expect(straight.conversation.unpushedBursts).toBeGreaterThan(10);

      store.ingest(acc, { t: 'message', message: { nativeId: 'new', conversation: 'busy', author: 'friend1', ts: now, body: 'are we on for tonight?' }, live: true });
      const id = store.one<{ id: string }>(`SELECT id FROM message WHERE native_id = 'new'`)!.id;
      const slices: number[] = [];
      a.slices = everyChance(slices);
      const d = await new Triage(store, a).decide(id, now);
      expect(d!.features!.conversation).toEqual(straight.conversation);
      // Pages of a hundred messages, a turn of the event loop after each: at most a page and one between turns.
      expect(Math.max(...slices)).toBeLessThanOrEqual(a.featurePage + 1);
      expect(slices.filter((n) => n > 1).length).toBeGreaterThanOrEqual(Math.floor(N / a.featurePage));
      // Cached: the next message there reads nothing.
      slices.length = 0;
      await new Triage(store, a).decide(id, now + MIN);
      expect(slices).toEqual([]);
    } finally {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the identities that are you', () => {
  test('are found from the person that is you, not by reading every identity: once or twice for every message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dither-stalls-self-'));
    const store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    try {
      const acc = store.createAccount({ network: 'discord', label: 'main', color: '#000', adapter: 'discord' });
      store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
      const plan = (sql: string) => (store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
      for (const sql of [`SELECT * FROM ${SELF_SQL}`, `SELECT * FROM ${RANK_SELF_SQL}`]) {
        const steps = plan(sql);
        expect(steps).toContain('SEARCH i USING INDEX identity_person (person_id=?)');
        expect(steps.some((d) => /^SCAN i\b/.test(d))).toBe(false);
      }
      expect([...selfIdentities(store.db)]).toEqual([store.accounts()[0].self_identity]);
    } finally {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the stall log', () => {
  test('a late timer is a stall, with the work that began in it; ten minutes on, one line sums them up', () => {
    const lines: string[] = [];
    // Far from performance.now() of this process, so no other test's notes fall in.
    const T = 1e10;
    const w = new StallWatch({ everyMs: 100, overMs: 200, forMs: 10 * MIN, laterOverMs: 2000, log: (l) => lines.push(l) }).from(T);
    w.check(T + 100);
    noteWork('embeddings refit', T + 120);
    noteWork(`GET ${pathShape('/api/conversations/cnv_placeholder1/messages')}`, T + 23_890);
    w.check(T + 24_000);
    w.check(T + 24_150);
    for (let t = T + 24_250; t <= T + 10 * MIN + 100; t += 100) w.check(t);
    // Later, only holds of two seconds or more.
    let t = T + 10 * MIN + 100;
    noteWork('attention: rescore all', t + 10);
    w.check((t += 600));
    noteWork('media archive', t + 10);
    w.check((t += 2600));
    expect(lines).toEqual([
      'stall: 23.8 s from 100 ms after start: embeddings refit, GET /api/conversations/:id/messages',
      'stalls: 1 of 200 ms or more in the first 10 min, the longest 23.8 s (embeddings refit, GET /api/conversations/:id/messages)',
      'stall: 2.5 s from 600.7 s after start: media archive',
    ]);
  });

  test('paths without their ids', () => {
    expect(pathShape('/api/bootstrap')).toBe('/api/bootstrap');
    expect(pathShape('/media/acc_placeholder/123456')).toBe('/media/:id/:id');
    expect(pathShape('/api/conversations/cnv_x/messages')).toBe('/api/conversations/:id/messages');
  });
});
