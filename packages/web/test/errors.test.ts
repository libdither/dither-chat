/** The page's error reports (src/errors.ts): route templates, the limits, and what is not reported. */
import { expect, test } from 'bun:test';
import { apiTemplate, BLIP_MS, HubLoss, type LossEnv, type LossVerdict, lossMessage, pageError, ReportLimiter, routeTemplate } from '../src/errors.ts';

test('a route is a template: ids, names and anything typed become :id, the query goes', () => {
  expect(routeTemplate('#/inbox/c/dc_123?m=msg_9')).toBe('#/inbox/c/:id');
  expect(routeTemplate('#/search?q=what%20I%20typed')).toBe('#/search');
  expect(routeTemplate('#/p/Alice%20Smith')).toBe('#/p/:id');
  expect(routeTemplate('#/mail/l/inbox/t/mt_4')).toBe('#/mail/l/inbox/t/:id');
  expect(routeTemplate('#/calendar/day/2026-11-14?e=x')).toBe('#/calendar/:id/:id');
  expect(routeTemplate('')).toBe('#/');
});

test('an API path as the hub names it, without its query', () => {
  expect(apiTemplate('/api/conversations/dc_1/messages?before=5')).toBe('/api/conversations/:id/messages');
  expect(apiTemplate('/api/bootstrap')).toBe('/api/bootstrap');
});

test('at most 20 a minute, the same one at most once a minute', () => {
  const l = new ReportLimiter();
  expect(l.allow('a', 0)).toBe(true);
  expect(l.allow('a', 59_999)).toBe(false);
  expect(l.allow('a', 60_000)).toBe(true);
  let n = 0;
  for (let i = 0; i < 30; i++) if (l.allow(`k${i}`, 70_000)) n++;
  // 'a' at 60 000 is still in the minute: 19 more.
  expect(n).toBe(19);
  expect(l.allow('later', 130_001)).toBe(true);
});

test('not reported: an abort, an api() error with a status (the hub wrote it); reported: a plain throw', () => {
  expect(pageError(Object.assign(new Error('gone'), { name: 'AbortError' }))).toBeNull();
  expect(pageError(Object.assign(new Error('no'), { status: 404 }))).toBeNull();
  expect(pageError(Object.assign(new Error('offline'), { status: 503 }))).toBeNull();
  expect(pageError(Object.assign(new Error('slow'), { status: 504 }))).toBeNull();
  expect(pageError(Object.assign(new Error('broke'), { status: 502 }))).toBeNull();
  expect(pageError(new TypeError('x is undefined'))).toMatchObject({ name: 'TypeError', message: 'x is undefined' });
  expect(pageError('typed text')).toEqual({ name: 'string', message: 'a string was thrown, not an Error' });
  expect(pageError(undefined)).toBeNull();
});

/** A loss with a clock, timers and a hub the test moves by hand. */
function harness() {
  let now = 1_000_000;
  const timers: { at: number; f: () => void }[] = [];
  const st = { online: true, leaving: false, hubUp: false };
  const sent: { ms: number; ago: number; calls: string[] }[] = [];
  const verdicts: LossVerdict[] = [];
  let probes = 0;
  const env: LossEnv = {
    now: () => now,
    online: () => st.online,
    leaving: () => st.leaving,
    probe: async () => (probes++, st.hubUp),
    later: (f, ms) => timers.push({ at: now + ms, f }),
    send: (r) => sent.push(r),
    judged: (v) => verdicts.push(v),
  };
  const loss = new HubLoss(env);
  /** Move the clock to `ms` later, running each timer due on the way and waiting for its probe. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.f();
      // The probe's promise, then check()'s continuation.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = end;
  };
  return { loss, st, sent, verdicts, advance, probes: () => probes, pending: () => timers.length };
}

test('a hub back within a moment is a blip: nothing sent, however many calls failed', async () => {
  const h = harness();
  h.loss.fail('GET /api/usage');
  h.loss.fail('GET /api/retention');
  h.loss.fail('POST /api/devices/hello');
  h.st.hubUp = true;
  await h.advance(2000);
  expect(h.verdicts).toEqual(['blip']);
  expect(h.sent).toEqual([]);
  expect(h.probes()).toBe(1);
});

test('a hub lost for longer is one report, with every call that failed and how long', async () => {
  const h = harness();
  h.loss.fail('GET /api/usage');
  await h.advance(5000);
  h.loss.fail('GET /api/read-all');
  h.loss.fail('GET /api/usage');
  await h.advance(10_000);
  h.st.hubUp = true;
  await h.advance(60_000);
  expect(h.verdicts).toEqual(['report']);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].calls).toEqual(['GET /api/usage', 'GET /api/read-all']);
  expect(h.sent[0].ms).toBeGreaterThanOrEqual(BLIP_MS);
  expect(h.sent[0].ago).toBe(h.sent[0].ms);
  // Done: no more asking, and a later failure is a new loss.
  expect(h.pending()).toBe(0);
});

test('not the hub: the device offline, the page waking or leaving', async () => {
  const offline = harness();
  offline.loss.fail('GET /api/usage');
  offline.st.online = false;
  await offline.advance(30_000);
  expect(offline.verdicts).toEqual(['offline']);

  // A failure soon after the page came back into sight: the phone's network was still waking.
  const woke = harness();
  woke.loss.woke();
  await woke.advance(3000);
  woke.loss.fail('GET /api/usage');
  await woke.advance(20_000);
  woke.st.hubUp = true;
  await woke.advance(60_000);
  expect(woke.verdicts).toEqual(['woke']);

  // Long after waking it counts again.
  const later = harness();
  later.loss.woke();
  await later.advance(60_000);
  later.loss.fail('GET /api/usage');
  await later.advance(20_000);
  later.st.hubUp = true;
  await later.advance(60_000);
  expect(later.verdicts).toEqual(['report']);

  // The network changed during the loss.
  const moved = harness();
  moved.loss.fail('GET /api/usage');
  await moved.advance(8000);
  moved.loss.woke();
  moved.st.hubUp = true;
  await moved.advance(60_000);
  expect(moved.verdicts).toEqual(['woke']);

  // A reload cut the fetches off.
  const leaving = harness();
  leaving.loss.fail('GET /api/usage');
  leaving.st.leaving = true;
  leaving.loss.leaving();
  await leaving.advance(5000);
  expect(leaving.verdicts).toEqual(['leaving']);
  expect(leaving.probes()).toBe(0);

  for (const h of [offline, woke, moved, leaving]) expect(h.sent).toEqual([]);
});

test('a loss names its length in a few steps, one fingerprint per step', () => {
  expect(lossMessage(12_000)).toBe('the hub was not reached for 10 s or more');
  expect(lossMessage(59_999)).toBe('the hub was not reached for 10 s or more');
  expect(lossMessage(90_000)).toBe('the hub was not reached for 1 min or more');
  expect(lossMessage(600_000)).toBe('the hub was not reached for 5 min or more');
});
