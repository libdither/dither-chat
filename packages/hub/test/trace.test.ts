/**
 * Tracing (docs/tracing.md): spans nest across awaits, carry a traceparent in and out, fail with the error they threw,
 * cost nothing with no sink; the files rotate by size; a stall is recorded with the spans that were on the thread and
 * what the process did; scripts/trace-summary.ts reads it all back.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sliced } from '../src/slices.ts';
import { StallWatch, type StallRecord, type Usage } from '../src/stalls.ts';
import { annotate, currentSpan, NdjsonFile, parseTraceparent, setTraceSink, span, spansBetween, startSpan, type SpanRecord } from '../src/trace.ts';
import { parseSince, readSpans, summarize, traceTree } from '../../../scripts/trace-summary.ts';

let got: SpanRecord[] = [];
const on = () => {
  got = [];
  setTraceSink((r) => got.push(r));
};
afterEach(() => setTraceSink(null));

describe('spans', () => {
  test('a span inside another, across awaits, is its child in the same trace', async () => {
    on();
    await span('outer', { a: 1 }, async () => {
      await Bun.sleep(0);
      await span('inner', {}, async () => {
        await Bun.sleep(0);
        annotate({ b: 'x' });
        currentSpan().event('halfway', { n: 2 });
      });
      span('sync', {}, () => 3);
    });
    const [inner, sync, outer] = got;
    expect(got.map((s) => s.name)).toEqual(['inner', 'sync', 'outer']);
    expect(inner!.traceId).toBe(outer!.traceId);
    expect(sync!.traceId).toBe(outer!.traceId);
    expect(inner!.parentSpanId).toBe(outer!.spanId);
    expect(outer!.parentSpanId).toBeUndefined();
    expect(inner!.attrs).toEqual({ b: 'x' });
    expect(inner!.events?.map((e) => [e.name, e.attrs])).toEqual([['halfway', { n: 2 }]]);
    expect(outer!.attrs).toEqual({ a: 1 });
    expect(outer!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(outer!.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(got.every((s) => s.status === 'ok')).toBe(true);
  });

  test('two spans started side by side are separate traces', async () => {
    on();
    await Promise.all([span('a', {}, () => Bun.sleep(0)), span('b', {}, () => Bun.sleep(0))]);
    expect(got[0]!.traceId).not.toBe(got[1]!.traceId);
  });

  test('a throw or a rejection fails the span and goes on to the caller', async () => {
    on();
    expect(() => span('sync', {}, () => {
      throw new Error('boom');
    })).toThrow('boom');
    await expect(span('async', {}, async () => {
      throw new TypeError('nope');
    })).rejects.toThrow('nope');
    span('marked', {}, (s) => s.fail('status 502'));
    expect(got.map((s) => [s.name, s.status, s.error])).toEqual([
      ['sync', 'error', 'boom'],
      ['async', 'error', 'TypeError: nope'],
      ['marked', 'error', 'status 502'],
    ]);
  });

  test('a traceparent from outside is the parent; a span gives its own for a call out', () => {
    on();
    const p = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(p).toEqual({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' });
    let out = '';
    span('req', {}, (s) => (out = s.traceparent), { parent: p });
    expect(got[0]!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(got[0]!.parentSpanId).toBe('b7ad6b7169203331');
    expect(out).toBe(`00-0af7651916cd43dd8448eb211c80319c-${got[0]!.spanId}-01`);
    for (const bad of [null, '', 'junk', '00-00000000000000000000000000000000-b7ad6b7169203331-01', '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01'])
      expect(parseTraceparent(bad)).toBeUndefined();
  });

  test('with no sink, a span is just the call and keeps nothing', () => {
    got = [];
    expect(span('off', {}, (s) => (s.set({ a: 1 }).event('e').fail('x'), 7))).toBe(7);
    annotate({ a: 1 });
    const s = startSpan('off');
    s.set({ a: 1 }).event('e');
    expect(s.set({ b: 2 })).toBe(s);
    s.end();
    expect(got).toEqual([]);
  });

  test('a hand-started span ends once, or is dropped', () => {
    on();
    const a = startSpan('kept', { n: 1 });
    a.set({ m: 2 });
    a.end();
    a.end();
    const b = startSpan('dropped');
    b.drop();
    b.end();
    expect(got.map((s) => [s.name, s.attrs])).toEqual([['kept', { n: 1, m: 2 }]]);
  });

  test('a sliced job is one span: how many slices, and their time in all', async () => {
    on();
    function* job() {
      for (let i = 0; i < 5; i++) yield 1;
      return 'done';
    }
    let t = 0;
    const r = await sliced('the job', job(), { clock: () => (t += 10), budgetMs: 15, pause: async () => {} });
    expect(r).toBe('done');
    expect(got.map((s) => s.name)).toEqual(['the job']);
    expect(got[0]!.attrs.slices).toBeGreaterThan(1);
    expect(got[0]!.attrs.busyMs).toBeGreaterThan(0);
  });
});

describe('the stall record', () => {
  test('every hold over the floor is recorded at any time, with the spans on the thread and the process counters', () => {
    on();
    let t = 0;
    let u: Usage = { userCPUTime: 0, systemCPUTime: 0, minorPageFault: 0, majorPageFault: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0 };
    const recs: StallRecord[] = [];
    const lines: string[] = [];
    const w = new StallWatch({ now: () => t, wallNow: () => 1_000_000 + t, log: (l) => lines.push(l), record: (r) => recs.push(r), spans: spansBetween, usage: () => u, forMs: 1000 }).from(0);
    // A tick on time, then a held one at 5 s (after the first `forMs`, under the 2 s line in the log but recorded).
    t = 100;
    w.check(t);
    t = 5000;
    w.check(t);
    const held = startSpan('held it');
    t = 6000;
    u = { userCPUTime: 900_000, systemCPUTime: 50_000, minorPageFault: 12, majorPageFault: 3, voluntaryContextSwitches: 4, involuntaryContextSwitches: 5 };
    w.check(t);
    held.end();
    expect(recs.map((r) => r.heldMs)).toEqual([4800, 900]);
    expect(recs[1]).toMatchObject({ heldMs: 900, afterStartMs: 5000, cpuUserMs: 900, cpuSystemMs: 50, minorFaults: 12, majorFaults: 3, voluntarySwitches: 4, involuntarySwitches: 5 });
    // The span still open at the tick is named.
    expect(recs[1]!.spans.some((s) => s.name === 'held it' && s.open)).toBe(true);
    // The log keeps its own rule: after `forMs`, only holds of 2 s or more.
    expect(lines.filter((l) => l.startsWith('stall:'))).toHaveLength(1);
  });
});

describe('files and the summary', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  test('lines are written in batches and the file rotates by size, keeping the newest', () => {
    dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const f = new NdjsonFile(join(dir, 'traces/t.ndjson'), { maxBytes: 100, keep: 2, flushMs: 60_000, bufferBytes: 1 });
    for (let i = 0; i < 12; i++) f.push({ i, pad: 'x'.repeat(20) });
    f.close();
    const lines = (p: string) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l).i as number);
    const all = [...lines(join(dir, 'traces/t.ndjson.2')), ...lines(join(dir, 'traces/t.ndjson.1')), ...lines(join(dir, 'traces/t.ndjson'))];
    expect(existsSync(join(dir, 'traces/t.ndjson.3'))).toBe(false);
    // The oldest went; what is kept is the latest, in order.
    expect(all).toEqual(all.slice().sort((a, b) => a - b));
    expect(all[all.length - 1]).toBe(11);
    expect(all.length).toBeLessThan(12);
  });

  test('the summary reads back every file, and draws a trace as a tree', () => {
    dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const rec = (name: string, startMs: number, durationMs: number, extra: Partial<SpanRecord> = {}): SpanRecord => ({ name, traceId: 't1'.padEnd(32, '0'), spanId: name.padEnd(16, '0'), startMs, durationMs, attrs: {}, status: 'ok', ...extra });
    const spans = [
      rec('POST /api/groups', 1000, 6400, { attrs: { 'http.status': 200 } }),
      rec('command createGroup', 1010, 6380, { parentSpanId: 'POST /api/groups'.padEnd(16, '0') }),
      rec('GET /api/bootstrap', 2000, 300, { traceId: 'other'.padEnd(32, '0') }),
      rec('GET /api/bootstrap', 3000, 500, { traceId: 'other2'.padEnd(32, '0'), status: 'error', error: 'status 500' }),
    ];
    writeFileSync(join(dir, 'hub.trace.ndjson.1'), spans.slice(0, 2).map((s) => JSON.stringify(s)).join('\n') + '\n');
    writeFileSync(join(dir, 'hub.trace.ndjson'), spans.slice(2).map((s) => JSON.stringify(s)).join('\n') + '\n');
    const back = readSpans(dir, 0);
    expect(back.map((s) => s.startMs)).toEqual([1000, 1010, 2000, 3000]);
    expect(readSpans(dir, 2500)).toHaveLength(1);

    const sum = summarize(back, 60);
    expect(sum[0]).toMatchObject({ name: 'POST /api/groups', count: 1, max: 6400 });
    expect(sum.find((s) => s.name === 'GET /api/bootstrap')).toMatchObject({ count: 2, p50: 300, max: 500, failed: 1 });

    const tree = traceTree(back, 't1'.padEnd(32, '0'));
    expect(tree).toHaveLength(2);
    expect(tree[0]).toContain('POST /api/groups');
    expect(tree[0]).toContain('6.40 s');
    expect(tree[1]).toMatch(/^ {2}\+10 ms {2}6\.38 s {2}command createGroup/);
  });

  test('--since takes a span of time or all', () => {
    expect(parseSince('30m', 3_600_000)).toBe(1_800_000);
    expect(parseSince('2h', 10 * 3_600_000)).toBe(8 * 3_600_000);
    expect(parseSince('all')).toBe(0);
    expect(() => parseSince('soon')).toThrow();
  });
});
