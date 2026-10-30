/**
 * hook.js against a replica of Discord's bundle layout: several rspack runtimes
 * sharing window.webpackChunkdiscord_app, each wrapping the push before it, and
 * chunk scripts that re-assign the global before every push. The runtime tail
 * below has the same shape as Discord's minified code (rspack 1.7).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOOK = readFileSync(process.env.HOOK_PATH ?? join(import.meta.dir, '../src/extension/hook.js'), 'utf8');

function page(pathname = '/app') {
  const posted: any[] = [];
  const timers: (() => void)[] = [];
  const store = new Map<string, string>();
  const win: any = {
    postMessage: (msg: any) => posted.push(msg.__dither_bridge__ === 'up' ? msg.payload : msg),
    addEventListener() {},
  };
  const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null, body: { innerText: '' } };
  const loc = { origin: 'https://discord.com', href: `https://discord.com${pathname}`, pathname, reload() {} };
  const session = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const runHook = () =>
    new Function('window', 'document', 'location', 'navigator', 'sessionStorage', 'setTimeout', 'setInterval', HOOK)(
      win,
      doc,
      loc,
      { webdriver: false },
      session,
      (fn: () => void) => timers.push(fn),
      () => 0,
    );
  /** Run the timers queued so far (not the ones they queue). */
  const tick = () => timers.splice(0).forEach((fn) => fn());
  return { win, posted, runHook, tick };
}

/** One rspack runtime: the jsonp callback and push install, as in Discord's bundles. */
function runtime(self: any, entryChunk: string) {
  const modules: Record<string, (m: any, e: any, r: any) => void> = {};
  const cache: Record<string, { exports: any }> = {};
  const T: any = (id: string) => {
    if (cache[id]) return cache[id].exports;
    const m = (cache[id] = { exports: {} });
    modules[id](m, m.exports, T);
    return m.exports;
  };
  T.m = modules;
  T.c = cache;
  T.o = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);
  T.O = (result: unknown) => result;
  const A: Record<PropertyKey, any> = { [entryChunk]: 0 };
  const h = (e: any, t: any) => {
    let n: string;
    let i: PropertyKey;
    let o: unknown;
    let l = 0;
    const [r, a, s] = t;
    if (r.some((x: PropertyKey) => A[x] !== 0)) {
      for (n in a) if (T.o(a, n)) T.m[n] = a[n];
      if (s) o = s(T);
    }
    for (e && e(t); l < r.length; l++) {
      i = r[l];
      if (T.o(A, i) && A[i]) A[i][0]();
      A[i] = 0;
    }
    return T.O(o);
  };
  (function (this: any) {
    let f: any;
    (f = this.webpackChunkdiscord_app = this.webpackChunkdiscord_app || []).forEach(h.bind(null, 0)), (f.push = h.bind(null, f.push.bind(f)));
  }).call(self);
  /** Simulates __webpack_require__.e: the chunk is pending until its script pushes it. */
  const ensure = (id: string) => new Promise<void>((resolve, reject) => (A[id] = [resolve, reject]));
  return { T, A, ensure };
}

/** A chunk script: `(this.webpackChunkdiscord_app=this.webpackChunkdiscord_app||[]).push([[id],{...}])`. */
function chunk(self: any, id: string, mods: Record<string, (m: any, e: any, r: any) => void>) {
  (function (this: any) {
    (this.webpackChunkdiscord_app = this.webpackChunkdiscord_app || []).push([[id], mods]);
  }).call(self);
}

function store(name: string, extra: Record<string, unknown> = {}) {
  return { getName: () => name, emitChange() {}, ...extra };
}

const subscribed: string[] = [];
const dispatcher = { dispatch() {}, subscribe: (ev: string) => subscribed.push(ev), unsubscribe() {}, isDispatching: () => false, _subscriptions: {} };

// rspack mangles export names: the stores sit under short keys, not `default`.
const storeModule = (_m: any, e: any) => {
  Object.defineProperty(e, 'A', { enumerable: true, get: () => dispatcher });
  Object.defineProperty(e, 'Ay', { enumerable: true, get: () => store('UserStore', { getCurrentUser: () => null }) });
  e.Bk = store('ChannelStore');
  e.Cx = store('GuildStore');
};

describe('hook.js with several rspack runtimes', () => {
  test('lazy chunks still reach every runtime', async () => {
    const p = page();
    p.runHook();
    chunk(p.win, '533077', { m533077: () => {} }); // a deferred chunk that runs before any runtime
    const libdiscore = runtime(p.win, 'libdiscore');
    chunk(p.win, '935812', { m935812: () => {} });
    const fastConnect = runtime(p.win, 'fast-connect');
    const sentry = runtime(p.win, 'sentry');
    const web = runtime(p.win, 'web');

    const pending = web.ensure('240406');
    chunk(p.win, '240406', { m240406: () => {} });
    await pending; // never settles when the push chain is broken

    for (const rt of [libdiscore, fastConnect, sentry, web]) {
      expect(rt.A['240406']).toBe(0);
      expect(rt.T.m.m240406).toBeDefined();
      expect(rt.T.m.m533077).toBeDefined();
    }
  });

  test('finds the stores under mangled export names and subscribes', () => {
    const p = page();
    p.runHook();
    runtime(p.win, 'libdiscore');
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores'); // the app's own code runs the module
    p.tick(); // resolveTick
    const report = p.posted.find((m) => m.t === 'finders');
    expect(report?.results).toMatchObject({ Dispatcher: true, UserStore: true, ChannelStore: true, GuildStore: true });
    expect(report.detail).toContain('runtimes=2');
    expect(subscribed).toContain('MESSAGE_CREATE');
  });

  test('keeps looking until the stores exist', () => {
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    p.tick(); // nothing has run yet
    expect(p.posted.some((m) => m.t === 'finders')).toBe(false);
    web.T('stores');
    p.tick();
    expect(p.posted.find((m) => m.t === 'finders')?.results.Dispatcher).toBe(true);
  });

  test('injected after the runtimes still gets their requires', () => {
    const p = page();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.runHook();
    p.tick();
    expect(p.posted.find((m) => m.t === 'finders')?.results.UserStore).toBe(true);
    const pending = web.ensure('9');
    chunk(p.win, '9', { m9: () => {} });
    return pending;
  });
});
