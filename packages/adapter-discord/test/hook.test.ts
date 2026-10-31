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
  const intervals: (() => void)[] = [];
  const store = new Map<string, string>();
  const win: any = {
    postMessage: (msg: any) => posted.push(msg.__dither_bridge__ === 'up' ? msg.payload : msg),
    addEventListener(type: string, fn: (e: any) => void) {
      if (type === 'message') win.message = fn;
    },
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
      (fn: () => void) => intervals.push(fn),
    );
  /** Run the timers queued so far (not the ones they queue). */
  const tick = () => timers.splice(0).forEach((fn) => fn());
  /** The page-state poll, as setInterval would run it. */
  const poll = () => intervals.forEach((fn) => fn());
  return { win, posted, runHook, tick, poll };
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

const handlers = new Map<string, ((action: any) => void)[]>();
const dispatcher = {
  dispatch() {},
  subscribe: (ev: string, fn: (action: any) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
  unsubscribe() {},
  isDispatching: () => false,
  _subscriptions: {},
};
const emit = (ev: string, action: any = {}) => (handlers.get(ev) ?? []).forEach((fn) => fn(action));

let me: { id: string; username: string } | null = null;
const channelStore: any = store('ChannelStore', { getChannel: () => null });
const userStoreGetUser: { value: (id: string) => unknown } = { value: () => null };
const rest: Record<string, any> = { get() {}, post() {}, put() {}, patch() {}, del() {} };
const messageActions = { sendMessage() {}, editMessage() {} };

// rspack mangles export names: the stores sit under short keys, not `default`.
const storeModule = (_m: any, e: any) => {
  Object.defineProperty(e, 'A', { enumerable: true, get: () => dispatcher });
  Object.defineProperty(e, 'Ay', { enumerable: true, get: () => store('UserStore', { getCurrentUser: () => me, getUser: (id: string) => userStoreGetUser.value(id) }) });
  e.Bk = channelStore;
  e.Cx = store('GuildStore', { getGuilds: () => ({}), getGuild: (id: string) => ({ id, name: `Guild ${id}` }) });
  e.Bo = rest;
  e.Dm = messageActions;
};

// An i18n message bundle in the real client: answers every key with a function.
const intlBundle = (_m: any, e: any) => {
  const lookups: unknown[] = [];
  e.default = new Proxy({}, { get: (_t, key) => (arg: unknown) => void lookups.push([key, arg]) });
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
    expect(handlers.has('MESSAGE_CREATE')).toBe(true);
  });

  test('is not fooled by a Proxy that answers every key', async () => {
    handlers.clear();
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { i18n: intlBundle, stores: storeModule });
    web.T('i18n'); // ahead of the real modules, as in the real client
    web.T('stores');
    p.tick();
    expect(handlers.has('MESSAGE_CREATE')).toBe(true);
    // Commands reach the real REST and message modules, not the bundle.
    const calls: string[] = [];
    rest.get = () => {
      calls.push('rest');
      return { body: [] } as any;
    };
    const sent = p.posted.length;
    p.win.message?.({ source: p.win, data: { __dither_bridge__: 'down', payload: { t: 'cmd', id: 'x', cmd: { kind: 'history', channelId: '1' } } } });
    await Bun.sleep(0);
    expect(calls).toEqual(['rest']);
    expect(p.posted.slice(sent).find((m) => m.t === 'reply')).toMatchObject({ id: 'x', ok: true, result: { messages: [] } });
  });

  test('reports a REST rejection with its message and retry_after', async () => {
    handlers.clear();
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.tick();
    rest.get = () => Promise.reject({ status: 429, body: { message: 'You are being rate limited.', retry_after: 2.5 } }) as any;
    p.win.message?.({ source: p.win, data: { __dither_bridge__: 'down', payload: { t: 'cmd', id: 'y', cmd: { kind: 'history', channelId: '1' } } } });
    await Bun.sleep(0);
    expect(p.posted.find((m) => m.t === 'reply')).toMatchObject({ ok: false, error: 'You are being rate limited. (429)', retryAfter: 2.5 });
  });

  test('sends without waiting for the channel to load, with a raw reply reference', async () => {
    handlers.clear();
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.tick();
    const calls: any[][] = [];
    messageActions.sendMessage = ((...args: any[]) => {
      calls.push(args);
      return Promise.resolve({ body: { id: '77' } });
    }) as any;
    p.win.message?.({ source: p.win, data: { __dither_bridge__: 'down', payload: { t: 'cmd', id: 's', cmd: { kind: 'send', channelId: '5', content: 'hi', replyTo: '4', nonce: 'n1' } } } });
    await Bun.sleep(0);
    expect(calls[0][2]).toBe(false); // true or undefined hangs until the channel is on screen
    expect(calls[0][3]).toEqual({ nonce: 'n1', messageReference: { channel_id: '5', message_id: '4' } });
    expect(p.posted.find((m) => m.t === 'reply')).toMatchObject({ id: 's', ok: true, result: { nativeId: '77' } });
  });

  describe('reacting', () => {
    const emojiA = { id: '1', name: 'here', animated: false, available: true, guildId: 'g1' };
    const emojiB = { id: '2', name: 'there', animated: true, available: true, guildId: 'g2' };
    const canPerm = { allow: true };
    const allowAll = { allow: true };

    /** A page with the emoji and permission modules loaded, and the client's own rule for usable emoji. */
    function reactingPage() {
      handlers.clear();
      me = { id: '1', username: 'someone', premiumType: 0 } as any;
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', {
        stores: storeModule,
        emoji: (_m: any, e: any) => {
          e.a = store('EmojiStore', { getGuilds: () => ({ g2: {}, g1: {} }), getGuildEmoji: (g: string) => (g === 'g1' ? [emojiA] : [emojiB]) });
          e.b = store('PermissionStore', { can: (bit: bigint) => (bit === 1n << 6n ? canPerm.allow : allowAll.allow) });
          e.c = { getEmojiUnavailableReason: ({ emoji, channel }: any) => (emoji.guildId === channel?.guild_id ? null : 3) };
        },
      });
      web.T('stores');
      web.T('emoji');
      p.tick();
      return p;
    }
    const down = (p: ReturnType<typeof page>, cmd: any, id = 'r') => p.win.message?.({ source: p.win, data: { __dither_bridge__: 'down', payload: { t: 'cmd', id, cmd } } });
    const reply = (p: ReturnType<typeof page>, id = 'r') => p.posted.find((m) => m.t === 'reply' && m.id === id);

    test('a normal reaction and a super one take different routes', async () => {
      const p = reactingPage();
      const calls: any[] = [];
      for (const verb of ['put', 'del']) rest[verb] = (a: any) => (calls.push([verb, a.url, a.query]), Promise.resolve({ body: null, headers: () => {} }));
      down(p, { kind: 'react', channelId: 'c', messageId: 'm', emoji: 'party:7' }, 'a');
      down(p, { kind: 'react', channelId: 'c', messageId: 'm', emoji: '🎉', burst: true }, 'b');
      down(p, { kind: 'react', channelId: 'c', messageId: 'm', emoji: '🎉', burst: true, remove: true }, 'c');
      await Bun.sleep(0);
      expect(calls).toEqual([
        ['put', '/channels/c/messages/m/reactions/party%3A7/@me', { location: 'Message', type: 0 }],
        ['put', `/channels/c/messages/m/reactions/${encodeURIComponent('🎉')}/@me`, { location: 'Message', type: 1 }],
        ['del', `/channels/c/messages/m/reactions/${encodeURIComponent('🎉')}/1/@me`, { location: 'Message', burst: true }],
      ]);
      // Nothing that can't be posted across the window boundary comes back.
      expect(reply(p, 'a')).toMatchObject({ ok: true, result: { ok: true } });
    });

    test('names the people behind a total', async () => {
      const p = reactingPage();
      const seen: any[] = [];
      rest.get = (a: any) => (seen.push(a), Promise.resolve({ body: [{ id: '9', username: 'nine', email: 'never@forward.this' }] })) as any;
      down(p, { kind: 'reactors', channelId: 'c', messageId: 'm', emoji: '🎉', burst: true });
      await Bun.sleep(0);
      expect(seen[0].query).toEqual({ limit: 100, type: 1 });
      expect(reply(p).result.users[0]).toEqual({ id: '9', username: 'nine', global_name: null, discriminator: undefined, avatar: undefined, bot: false });
    });

    const channelIn = (guild: string | null) => ({ guild_id: guild, id: 'c' });

    test('offers what the client itself says is usable, this server first', async () => {
      const p = reactingPage();
      channelStore.getChannel = () => channelIn('g1');
      down(p, { kind: 'reactionContext', channelId: 'c' });
      await Bun.sleep(0);
      const ctx = reply(p).result;
      expect(ctx).toMatchObject({ canReact: true, existingOnly: false, nitro: false });
      expect(ctx.custom.map((g: any) => g.emoji.map((e: any) => e.name))).toEqual([['here']]);
    });

    test('Nitro, and a channel without Add Reactions', async () => {
      const p = reactingPage();
      me = { id: '1', username: 'someone', premiumType: 2 } as any;
      canPerm.allow = false;
      channelStore.getChannel = () => channelIn('g1');
      down(p, { kind: 'reactionContext', channelId: 'c' });
      await Bun.sleep(0);
      expect(reply(p).result).toMatchObject({ canReact: true, existingOnly: true, nitro: true });
      canPerm.allow = true;
    });

    test('direct messages have no permissions to check', async () => {
      const p = reactingPage();
      canPerm.allow = false;
      channelStore.getChannel = () => channelIn(null);
      down(p, { kind: 'reactionContext', channelId: 'c' });
      await Bun.sleep(0);
      expect(reply(p).result).toMatchObject({ canReact: true, existingOnly: false });
      canPerm.allow = true;
    });

    test('a gateway reaction carries its style, colours and who did it', () => {
      const p = reactingPage();
      userStoreGetUser.value = (id: string) => ({ id, username: `user${id}` });
      emit('MESSAGE_REACTION_ADD', { channelId: 'c', messageId: 'm', userId: '5', emoji: { id: '7', name: 'party', animated: true }, reactionType: 1, colors: ['#f00'] });
      const d = p.posted.find((x) => x.t === 'dispatch' && x.event === 'MESSAGE_REACTION_ADD');
      expect(d.data).toMatchObject({ reactionType: 1, colors: ['#f00'], emoji: { id: '7', name: 'party', animated: true }, user: { id: '5', username: 'user5' } });
    });
  });

  test('sends the snapshot when the login finishes', () => {
    handlers.clear();
    me = null;
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.tick();
    p.poll();
    expect(p.posted.some((m) => m.t === 'snapshot')).toBe(false); // the login form is up

    me = { id: '1', username: 'someone' };
    emit('CONNECTION_OPEN');
    expect(p.posted.filter((m) => m.t === 'snapshot')[0].data.self.id).toBe('1');
    p.poll(); // no second copy from the poll...
    expect(p.posted.filter((m) => m.t === 'snapshot')).toHaveLength(1);
    emit('CONNECTION_OPEN'); // ...but a reconnect refreshes it
    expect(p.posted.filter((m) => m.t === 'snapshot')).toHaveLength(2);
    me = null;
  });

  test('sends the snapshot when CONNECTION_OPEN fired before the hook subscribed', () => {
    handlers.clear();
    me = { id: '1', username: 'someone' };
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.tick();
    p.poll();
    expect(p.posted.filter((m) => m.t === 'snapshot')).toHaveLength(1);
    me = null;
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
