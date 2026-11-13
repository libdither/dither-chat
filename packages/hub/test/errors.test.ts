/**
 * The error file (errors.ts, docs/tracing.md "Errors"): a report's record (clipped, stacks relative to the repo, the
 * contract's fields), the dedup that folds repeats into `count`, the cap on lines and what it says in the log, the
 * attempts' records, a request's 5xx, and POST /api/errors with its validation and its cap per client.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AboutError } from '../src/about.ts';
import { attempt, candidatesAttempt } from '../src/attempts.ts';
import { clientReport, ErrorLog, jobFailed, oneLine, PerClientCap, reportError, scrub, setErrorLog, stackFrames, type ErrorRecord } from '../src/errors.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { setSpanThrowHook, setTraceSink, span } from '../src/trace.ts';
import { Triage } from '../src/triage.ts';

let clock = 1_000_000;
const now = () => clock;
let lines: ErrorRecord[] = [];
let logged: string[] = [];
const log = (o: { capLines?: number; root?: string } = {}) => {
  lines = [];
  logged = [];
  const l = new ErrorLog((r) => lines.push(r), { now, version: 'abc12345', log: (s) => logged.push(s), ...o });
  setErrorLog(l);
  return l;
};
afterEach(() => {
  setErrorLog(null);
  setTraceSink(null);
  setSpanThrowHook(null);
});

describe('a record', () => {
  test('has the contract fields, the message one line of at most 300, the stack 10 frames relative to the repo', () => {
    log({ root: '/repo' });
    const e = new TypeError(`${'x'.repeat(400)}\nsecond line`);
    e.stack = `TypeError: x\n${Array.from({ length: 14 }, (_, i) => `    at f${i} (/repo/packages/hub/src/x.ts:${i}:3)`).join('\n')}`;
    reportError({ source: 'job', where: 'upkeep', error: e, extra: { account: 'acc_1', none: undefined } });
    const [r] = lines;
    expect(Object.keys(r!).sort()).toEqual(['app', 'at', 'extra', 'message', 'name', 'source', 'stack', 'v', 'version', 'where'].sort());
    expect(r).toMatchObject({ v: 1, at: clock, app: 'hub', source: 'job', where: 'upkeep', name: 'TypeError', version: 'abc12345', extra: { account: 'acc_1' } });
    expect(r!.message.length).toBe(300);
    expect(r!.message).not.toContain('second line');
    expect(r!.stack).toHaveLength(10);
    expect(r!.stack[0]).toBe('at f0 (packages/hub/src/x.ts:0:3)');
  });

  test('a thrown value that is not an Error says only its type', () => {
    log();
    reportError({ source: 'rejection', where: 'process', error: 'someone wrote this' });
    expect(lines[0]).toMatchObject({ name: 'string', message: 'a string was thrown, not an Error', stack: [] });
  });

  test("the trace is the current span's; one Error passed up and caught again is one line", async () => {
    log();
    setTraceSink(() => {});
    const e = new Error('boom');
    let trace = '';
    await span('outer', {}, async (s) => {
      trace = s.traceId;
      reportError({ source: 'job', where: 'a', error: e });
    });
    reportError({ source: 'job', where: 'b', error: e });
    expect(lines.map((l) => [l.where, l.trace])).toEqual([['a', trace]]);
  });

  test("a span a throw ended reaches the hook; the hub's main.ts reports it as a job", async () => {
    log();
    setTraceSink(() => {});
    setSpanThrowHook((name, e) => jobFailed(name, e));
    await expect(span('categories', {}, async () => {
      throw new RangeError('out');
    })).rejects.toThrow('out');
    expect(lines[0]).toMatchObject({ source: 'job', where: 'categories', name: 'RangeError', message: 'out' });
  });

  test('a closed database (the hub stopping) is not a job failure', () => {
    log();
    jobFailed('mail: people', new Error('Cannot use a closed database'));
    expect(lines).toEqual([]);
  });

  test('a message loses phone numbers, handles and email addresses; ids stay', () => {
    log();
    reportError({ source: 'request', where: 'POST /api/directs', name: 'HttpError', message: '+1 555 000 0000 is not on Signal; nobody is called @nobody; write to a.b@mail.example about cnv_9x and 1234567890123' });
    expect(lines[0]!.message).toBe('<number> is not on Signal; nobody is called @<handle>; write to <email> about cnv_9x and <number>');
    expect(scrub('status 502 after 90 seconds')).toBe('status 502 after 90 seconds');
  });

  test('frames: Firefox frames and origins', () => {
    expect(stackFrames('foo@https://hub.example:8460/assets/index-abc.js:1:200\n@https://hub.example/assets/x.js:2:3')).toEqual(['at foo (/assets/index-abc.js:1:200)', 'at /assets/x.js:2:3']);
    expect(stackFrames('Error: x\n    at g (https://h.example/assets/a.js:1:2)')).toEqual(['at g (/assets/a.js:1:2)']);
    expect(oneLine('a\nb')).toBe('a');
  });
});

describe('dedup and the cap', () => {
  test('the same error within 10 s is folded, and its count goes on the next line written for it', () => {
    const l = log();
    for (let i = 0; i < 5; i++) reportError({ source: 'job', where: 'flush', name: 'SQLiteError', message: 'database is locked' });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.count).toBeUndefined();
    clock += 10_000;
    reportError({ source: 'job', where: 'flush', name: 'SQLiteError', message: 'database is locked' });
    expect(lines).toHaveLength(2);
    expect(lines[1]!.count).toBe(5);
    // Folded ones with nothing after them: the sweep writes them once their window ends.
    reportError({ source: 'job', where: 'flush', name: 'SQLiteError', message: 'database is locked' });
    reportError({ source: 'job', where: 'flush', name: 'SQLiteError', message: 'database is locked' });
    l.sweep();
    expect(lines).toHaveLength(2);
    clock += 10_000;
    l.sweep();
    expect(lines).toHaveLength(3);
    expect(lines[2]!.count).toBe(2);
    // Another where is another error.
    reportError({ source: 'job', where: 'upkeep', name: 'SQLiteError', message: 'database is locked' });
    expect(lines).toHaveLength(4);
  });

  test('at most capLines a window; the log says when lines are dropped, and how many once the window ends', () => {
    log({ capLines: 3 });
    for (let i = 0; i < 6; i++) reportError({ source: 'job', where: `w${i}`, name: 'Error', message: 'x' });
    expect(lines).toHaveLength(3);
    expect(logged).toEqual(['errors: over the cap of 3 lines per 10 min; dropping until the window ends']);
    clock += 600_000;
    reportError({ source: 'job', where: 'later', name: 'Error', message: 'x' });
    expect(lines).toHaveLength(4);
    expect(logged[1]).toBe('errors: 3 lines dropped over the cap of 3 per 10 min (traces/errors.ndjson)');
  });

  test('a write that throws never reaches the caller', () => {
    setErrorLog(
      new ErrorLog(() => {
        throw new Error('disk full');
      }),
    );
    expect(reportError({ source: 'job', where: 'x', error: new Error('y') })).toBe(false);
  });
});

describe('attempts', () => {
  const quiet = () => spyOn(console, 'warn').mockImplementation(() => {});

  test('a failed attempt (502) and a partial one are records; a refusal (400) is not', async () => {
    log();
    const spy = quiet();
    try {
      await attempt({ kind: 'create', people: 3 }, async (a) => {
        a.accountId = 'acc_d';
        a.network = 'discord';
        return { added: [1, 2], invited: [], failed: [3] };
      });
      await expect(
        attempt({ kind: 'add', conversation: 'dc_c1', people: 1 }, async (a) => {
          a.accountId = 'acc_m';
          a.network = 'matrix';
          throw new AboutError('the server said no', 502);
        }),
      ).rejects.toThrow();
      await expect(attempt({ kind: 'create', people: 1 }, async () => {
        throw new AboutError('Which account makes it?', 400);
      })).rejects.toThrow();
      await expect(candidatesAttempt('dc_c1', () => {
        throw new Error('boom');
      })).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((l) => [l.source, l.where, l.name, l.status, l.extra])).toEqual([
      ['attempt', 'groups: create', 'Partial', undefined, { what: 'create', account: 'acc_d', network: 'discord', people: 3, failed: 1 }],
      ['attempt', 'members: add', 'AboutError', 502, { what: 'add', account: 'acc_m', network: 'matrix', conversation: 'dc_c1', people: 1, failed: 1 }],
      ['attempt', 'members: candidates', 'Error', 500, { what: 'candidates', conversation: 'dc_c1' }],
    ]);
  });
});

describe('the page', () => {
  test('clientReport takes a report and holds where to a template', () => {
    expect(clientReport({ name: 'TypeError', message: 'x is undefined', stack: 'at a (/assets/i.js:1:2)', where: '#/inbox/c/:id', status: 502, version: 'abc' })).toMatchObject({ app: 'web', source: 'client', where: '#/inbox/c/:id', status: 502, version: 'abc' });
    expect(clientReport({ message: 'x', where: 'https://evil/?q=hello' })).toBeNull();
    expect(clientReport({ message: 'x', where: '#/search?q=secret' })).toBeNull();
    expect(clientReport({ message: 3, where: '#/' })).toBeNull();
    expect(clientReport({ message: 'x', where: '#/', status: 'bad' })).toBeNull();
    expect(clientReport([1])).toBeNull();
    expect(clientReport({ message: 'x', where: '#/', version: 'not a version!' })?.version).toBeUndefined();
  });

  test('PerClientCap: 60 a minute from one client', () => {
    let t = 0;
    const cap = new PerClientCap(60, 60_000, () => t);
    for (let i = 0; i < 60; i++) expect(cap.take('a')).toBe(true);
    expect(cap.take('a')).toBe(false);
    expect(cap.take('b')).toBe(true);
    t = 60_000;
    expect(cap.take('a')).toBe(true);
  });
});

describe('the routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-errors-'));
  let store: Store;
  let server: HubServer;
  let base = '';
  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
    const sup = { authorize: () => null, online: () => false } as any;
    server = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    base = `http://127.0.0.1:${server.start().port}`;
  });
  afterAll(() => {
    server.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/errors`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

  test('POST /api/errors writes app web, source client; a bad body is 400; a cross-site one 403; past 60 a minute 429', async () => {
    log();
    const r = await post({ name: 'TypeError', message: 'a is not a function\nmore', stack: 'TypeError: a\n    at b (http://127.0.0.1:5319/assets/index-1.js:1:2)', where: '#/inbox/c/:id', version: 'deadbeef' });
    expect(r.status).toBe(204);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ app: 'web', source: 'client', where: '#/inbox/c/:id', name: 'TypeError', message: 'a is not a function', stack: ['at b (/assets/index-1.js:1:2)'], version: 'deadbeef' });
    expect(lines[0]!.trace).toBeUndefined();
    expect((await post('not json')).status).toBe(400);
    expect((await post({ message: 'x', where: '#/p/Alice Smith' })).status).toBe(400);
    expect((await post({ message: 'x', where: '#/' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ message: 'x'.repeat(20_000), where: '#/' })).status).toBe(413);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await post({ message: `m${i}`, where: '#/' })).status;
    expect(last).toBe(429);
  });

  test('a request answered with 5xx is a record with its route template; 4xx and 503 are not', async () => {
    log();
    // A refusal (4xx) is no record.
    expect((await fetch(`${base}/api/conversations/dc_nope/about`)).status).toBeLessThan(500);
    expect(lines).toEqual([]);
    // A throw inside a handler (a broken store): 500, and one record with the route's template.
    const real = store.bootstrap.bind(store);
    (store as any).bootstrap = () => {
      throw new Error('database disk image is malformed');
    };
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await fetch(`${base}/api/bootstrap`)).status).toBe(500);
    } finally {
      spy.mockRestore();
      (store as any).bootstrap = real;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ app: 'hub', source: 'request', where: 'GET /api/bootstrap', name: 'Error', message: 'database disk image is malformed', status: 500 });
  });
});

test('trace-summary --errors: occurrences by source, where and name, counts folded in', async () => {
  const { summarizeErrors } = await import('../../../scripts/trace-summary.ts');
  const base = { v: 1 as const, app: 'hub' as const, source: 'job' as const, name: 'SQLiteError', stack: [] };
  const rows = summarizeErrors([
    { ...base, at: 1, where: 'flush', message: 'database is locked' },
    { ...base, at: 2, where: 'flush', message: 'database is locked', count: 4 },
    { ...base, at: 3, where: 'upkeep', message: 'disk I/O error', trace: 't1' },
  ]);
  expect(rows.map((r) => [r.source, r.where, r.count, r.lines, r.lastAt])).toEqual([
    ['hub/job', 'flush', 5, 2, 2],
    ['hub/job', 'upkeep', 1, 1, 3],
  ]);
  expect(rows[1]!.lastTrace).toBe('t1');
});
