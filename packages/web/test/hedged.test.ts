/**
 * src/api.ts: a request given up when the hub goes quiet or its socket is found dead, and a catch-up asked again on
 * another connection while none answers (docs/sync.md, "A bad link"). The browser run is scripts/verify-link.ts.
 */
import { expect, test } from 'bun:test';
import { hedged, hubFetch } from '../src/api.ts';

/** An ask whose tries are held until the test answers them; each fails when its signal aborts, as fetch does. */
function asks() {
  const tries: { signal: AbortSignal; onAnswer: () => void; answer: (v: string) => void; refuse: (e: Error) => void }[] = [];
  const waiting: ((n: number) => void)[] = [];
  const ask = (o: { signal: AbortSignal; onAnswer: () => void }) =>
    new Promise<string>((answer, refuse) => {
      o.signal.addEventListener('abort', () => refuse(new TypeError('given up')), { once: true });
      tries.push({ ...o, answer, refuse });
      for (const w of waiting.splice(0)) w(tries.length);
    });
  /** Resolves once the n-th try has been asked. */
  const nth = (n: number) => (tries.length >= n ? Promise.resolve() : new Promise<void>((r) => waiting.push((k) => (k >= n ? r() : waiting.push((k2) => k2 >= n && r())))));
  return { ask, tries, nth };
}

test('an answer to the first try is the answer, and no other is asked', async () => {
  const a = asks();
  const p = hedged(a.ask, { every: 1e9, tries: 8 });
  a.tries[0].answer('one');
  expect(await p).toBe('one');
  expect(a.tries).toHaveLength(1);
});

test('a try that does not answer is asked again alongside; the first answer wins and the rest are given up', async () => {
  const a = asks();
  const p = hedged(a.ask, { every: 0, tries: 8 });
  await a.nth(2);
  a.tries[1].answer('two');
  expect(await p).toBe('two');
  expect(a.tries[0].signal.aborted).toBe(true);
});

test('two tries wait at once at most: a third gives the oldest up, which closes its connection', async () => {
  const a = asks();
  const p = hedged(a.ask, { every: 0, tries: 3 });
  await a.nth(3);
  expect(a.tries.map((t) => t.signal.aborted)).toEqual([true, false, false]);
  a.tries[2].answer('three');
  expect(await p).toBe('three');
});

test('once an answer has begun, it is waited for: no more tries', async () => {
  const a = asks();
  const p = hedged((o) => (o.onAnswer(), a.ask(o)), { every: 0, tries: 8 });
  // Its next try would have been asked by now (a timer of 0 set before this one).
  await new Promise((r) => setTimeout(r, 0)); // wall-clock: one turn of the timer queue, not a wait for time to pass
  expect(a.tries).toHaveLength(1);
  a.tries[0].answer('slow but here');
  expect(await p).toBe('slow but here');
});

test('every try failing is no answer (a TypeError); a refusal is the answer at once', async () => {
  const a = asks();
  const p = hedged(a.ask, { every: 0, tries: 2 });
  await a.nth(2);
  a.tries[0].refuse(new TypeError('no route'));
  a.tries[1].refuse(new TypeError('no route'));
  expect(p).rejects.toBeInstanceOf(TypeError);
  await p.catch(() => {});

  const b = asks();
  const q = hedged(b.ask, { every: 1e9, tries: 8 });
  const refusal = Object.assign(new Error('bad request'), { status: 400 });
  b.tries[0].refuse(refusal);
  expect(q).rejects.toBe(refusal);
  await q.catch(() => {});
});

test('the socket found dead gives every try up', async () => {
  const a = asks();
  const link = new AbortController();
  const p = hedged(a.ask, { every: 0, tries: 8, signal: link.signal });
  await a.nth(2);
  link.abort();
  expect(p).rejects.toBeInstanceOf(TypeError);
  await p.catch(() => {});
  expect(a.tries.every((t) => t.signal.aborted)).toBe(true);
});

test('hubFetch: a hub that never answers is given up after `quiet`, and a dropped link at once, both as no answer', async () => {
  // Takes the request and says nothing, as a connection that died under it.
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) });
  try {
    const url = `http://127.0.0.1:${server.port}/api/sync`;
    const quiet = hubFetch(url, { method: 'POST', body: {}, quiet: 50 });
    expect(quiet).rejects.toThrow(/did not answer/);
    expect(await quiet.catch((e) => e)).toBeInstanceOf(TypeError);

    const link = new AbortController();
    const dropped = hubFetch(url, { method: 'POST', body: {}, signal: link.signal });
    link.abort();
    const e = await dropped.catch((x) => x);
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toMatch(/dropped/);
  } finally {
    server.stop(true);
  }
});

test("hubFetch: a request asked for already (index.html's bootstrap) is read, not asked again, and given up as any other", async () => {
  let asked = 0;
  // Answers the first request; the rest it takes and says nothing.
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => (++asked === 1 ? Response.json({ hello: 1 }) : new Promise<Response>(() => {})) });
  try {
    const url = `http://127.0.0.1:${server.port}/api/bootstrap`;
    const got = await hubFetch(url, { quiet: 1000, early: { res: fetch(url), abort: () => {} } });
    expect(JSON.parse(got.text)).toEqual({ hello: 1 });
    expect(asked).toBe(1);

    // One that never answers: `quiet` gives it up, through its own abort.
    const c = new AbortController();
    let aborted = 0;
    const res = fetch(url, { signal: c.signal });
    const quiet = await hubFetch(url, { quiet: 50, early: { res, abort: () => (aborted++, c.abort()) } }).catch((e) => e);
    expect(quiet).toBeInstanceOf(TypeError);
    expect(quiet.message).toMatch(/did not answer/);
    expect(aborted).toBe(1);
  } finally {
    server.stop(true);
  }
});
