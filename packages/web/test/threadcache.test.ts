/**
 * Threads read ahead on the Feed page (src/ui/feed/threadcache.ts, docs/feed.md "Reading ahead"): two at a time, twelve
 * a minute, a card pointed at first, a card that left the screen not read, none where data is dear; a thread read is
 * kept, and its card says how far it is; one forgotten is asked again.
 */
import { afterEach, expect, mock, setSystemTime, test } from 'bun:test';
import { hub, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const tc = await import('../src/ui/feed/threadcache.ts');

const path = (post: string) => `/api/posts/x/${post}/thread`;
const view = (post: string) => ({ network: 'x', post, focal: null, ancestors: [], replies: [], more: null, identities: [], stored: false });
/** The hub's answers held back until a test gives them. */
let asked: string[] = [];
const held = new Map<string, () => void>();
const holdAnswers = () => {
  asked = [];
  hub.answer = (p) =>
    new Promise((ok) => {
      asked.push(p);
      held.set(p, () => ok(view(p.split('/')[4])));
    });
};
const answer = (post: string) => held.get(path(post))!();
/** Microtasks only, until what is checked holds (a promise's handlers run in a few turns). */
async function settle(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await Promise.resolve();
  expect(cond()).toBe(true);
}
/** A clock of its own per test, each a few minutes past the last: what one test read is out of the next one's minute.
 * Kept on globalThis, as the module read ahead keeps its state when the file is run again (--rerun-each); and posts
 * named for the run. */
const g = globalThis as { tcClock?: number; tcRun?: number };
const run = (g.tcRun = (g.tcRun ?? 0) + 1);
const tick = () => setSystemTime(new Date((g.tcClock = (g.tcClock ?? Date.parse('2030-01-01T00:00:00Z')) + 5 * 60_000)));
const id = (s: string) => `r${run}${s}`;
afterEach(() => {
  hub.answer = null;
  setSystemTime();
});

test('two at a time; the next goes as one comes back', async () => {
  tick();
  holdAnswers();
  for (const p of ['a1', 'a2', 'a3', 'a4'].map(id)) tc.readAhead('x', p);
  expect(asked).toEqual([path(id('a1')), path(id('a2'))]);
  expect(tc.preState('x', id('a1'))).toBe('loading');
  expect(tc.preState('x', id('a3'))).toBeNull();
  answer(id('a1'));
  await settle(() => asked.length === 3);
  expect(asked[2]).toBe(path(id('a3')));
  // Read: kept, and opening it asks nothing.
  expect(tc.preState('x', id('a1'))).toBe('ready');
  expect(tc.heldThread('x', id('a1'))?.post).toBe(id('a1'));
  const n = asked.length;
  expect((await tc.readThread('x', id('a1'))).post).toBe(id('a1'));
  expect(asked.length).toBe(n);
  answer(id('a2'));
  answer(id('a3'));
  await settle(() => asked.length === 4);
  answer(id('a4'));
});

test('a card pointed at goes first; one that left the screen is not read', async () => {
  tick();
  holdAnswers();
  for (const p of ['b1', 'b2', 'b3', 'b4', 'b5'].map(id)) tc.readAhead('x', p);
  tc.dropAhead('x', id('b3'));
  tc.readAhead('x', id('b5'), true);
  answer(id('b1'));
  await settle(() => asked.length === 3);
  expect(asked[2]).toBe(path(id('b5')));
  answer(id('b2'));
  await settle(() => asked.length === 4);
  // b3 left the screen: b4 is next.
  expect(asked[3]).toBe(path(id('b4')));
  answer(id('b5'));
  answer(id('b4'));
  await settle(() => tc.preState('x', id('b4')) === 'ready');
  expect(asked).not.toContain(path(id('b3')));
});

test('twelve a minute: the thirteenth waits for the minute to pass', async () => {
  tick();
  asked = [];
  hub.answer = async (p) => (asked.push(p), view(p.split('/')[4]));
  const posts = Array.from({ length: 14 }, (_, i) => id(`c${i}`));
  for (const p of posts) tc.readAhead('x', p);
  await settle(() => tc.preState('x', id('c11')) === 'ready');
  // Every turn the thirteenth could have had.
  for (let i = 0; i < 50; i++) await Promise.resolve();
  expect(asked.length).toBe(12);
  setSystemTime(new Date(g.tcClock! + 61_000));
  // The next card that comes on the screen starts the queue again (as the timer set for the minute's end would).
  tc.readAhead('x', id('c14'));
  await settle(() => asked.length === 15);
  expect(asked.slice(12)).toEqual([path(id('c12')), path(id('c13')), path(id('c14'))]);
});

test('none where data is dear: Save-Data or a cellular connection', () => {
  tick();
  holdAnswers();
  Object.defineProperty(navigator, 'connection', { value: { type: 'cellular', effectiveType: '4g' }, configurable: true });
  try {
    tc.readAhead('x', id('d1'));
    expect(asked).toEqual([]);
    expect(tc.preState('x', id('d1'))).toBeNull();
  } finally {
    delete (navigator as { connection?: unknown }).connection;
  }
});

test('a post on the page is shown before its thread comes', () => {
  tc.seedPosts('x', [{ id: id('e1'), url: 'https://x.example/e1', ts: 0, author: 'idn_a', text: 'shown at once' }]);
  expect(tc.seedPost('x', id('e1'))).toMatchObject({ id: id('e1'), text: 'shown at once', messageId: null });
  expect(tc.seedPost('x', id('e2'))).toBeNull();
});

test('a thread forgotten is asked of the hub again: a followed post’s chat sees what the hub’s checks found', async () => {
  tick();
  holdAnswers();
  const p = tc.readThread('x', id('f1'));
  answer(id('f1'));
  await p;
  expect(tc.heldThread('x', id('f1'))?.post).toBe(id('f1'));
  tc.forgetThread('x', id('f1'));
  expect(tc.heldThread('x', id('f1'))).toBeNull();
  const again = tc.readThread('x', id('f1'));
  expect(asked).toEqual([path(id('f1')), path(id('f1'))]);
  answer(id('f1'));
  expect((await again).post).toBe(id('f1'));
});
