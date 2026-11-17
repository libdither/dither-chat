/** The page's error reports (src/errors.ts): route templates, the limits, and what is not reported. */
import { expect, test } from 'bun:test';
import { apiTemplate, noteLeaving, pageError, ReportLimiter, reportAppCrashes, routeTemplate, unlessLeaving } from '../src/errors.ts';

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

test('a fetch failure is dropped when the page starts leaving before it is sent: its own reload cut the fetch off', () => {
  const timers: (() => void)[] = [];
  const later = (f: () => void) => timers.push(f);
  let sent = 0;
  const send = () => sent++;

  unlessLeaving(send, 1500, later);
  timers.shift()!();
  expect(sent).toBe(1);

  unlessLeaving(send, 1500, later);
  noteLeaving(true);
  timers.shift()!();
  expect(sent).toBe(1);

  // Already leaving: nothing is even queued.
  unlessLeaving(send, 1500, later);
  expect(timers.length).toBe(0);

  // Back from the back-forward cache: reported again.
  noteLeaving(false);
  unlessLeaving(send, 1500, later);
  timers.shift()!();
  expect(sent).toBe(2);
});

test("the Android app's crash reports go to the hub as app android, one post each, malformed ones skipped", () => {
  const posts: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  try {
    reportAppCrashes(
      [
        { where: '/android/uncaught', name: 'SecurityException', message: 'Starting FGS with type microphone', stack: ['at CallService.refresh(CallService.kt:83)'], at: 5, sdk: 35 },
        { where: '/android/exit', name: 'ANR', message: 'Input dispatching timed out' },
        { name: 'nothing' } as never,
      ],
      '0.12.0',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(posts.map((p) => p.url)).toEqual(['/api/errors', '/api/errors']);
  expect(posts[0].body).toEqual({ app: 'android', name: 'SecurityException', message: 'Starting FGS with type microphone', stack: ['at CallService.refresh(CallService.kt:83)'], where: '/android/uncaught', extra: { at: 5, sdk: 35 }, version: '0.12.0' });
  expect(posts[1].body).toMatchObject({ app: 'android', name: 'ANR', stack: [], extra: {} });
});
