/**
 * hook.js against a replica of Discord's bundle layout: several rspack runtimes
 * sharing window.webpackChunkdiscord_app, each wrapping the push before it, and
 * chunk scripts that re-assign the global before every push. The runtime tail
 * below has the same shape as Discord's minified code (rspack 1.7).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configurePlan, mapAbout, UNSURE } from '../src/about.ts';
import { mapProfile } from '../src/profile.ts';

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
const guildRecords = new Map<string, any>();
const channelStore: any = store('ChannelStore', { getChannel: () => null });
const userStoreGetUser: { value: (id: string) => unknown } = { value: () => null };
const rest: Record<string, any> = { get() {}, post() {}, put() {}, patch() {}, del() {} };
const messageActions = { sendMessage() {}, editMessage() {} };
const privateChannels: any = { opened: 0, openPrivateChannel() { this.opened++; } };
const typingCalls: string[] = [];
const typingModule: { value: any } = { value: { startTyping: (c: string) => typingCalls.push(`start ${c}`), stopTyping: (c: string) => typingCalls.push(`stop ${c}`) } };

// rspack mangles export names: the stores sit under short keys, not `default`.
const storeModule = (_m: any, e: any) => {
  Object.defineProperty(e, 'A', { enumerable: true, get: () => dispatcher });
  Object.defineProperty(e, 'Ay', { enumerable: true, get: () => store('UserStore', { getCurrentUser: () => me, getUser: (id: string) => userStoreGetUser.value(id) }) });
  e.Bk = channelStore;
  // With guild records set (the about tests), only those exist, as in the real store.
  e.Cx = store('GuildStore', { getGuilds: () => ({}), getGuild: (id: string) => (guildRecords.size ? guildRecords.get(id) : { id, name: `Guild ${id}` }) });
  e.Bo = rest;
  e.Dm = messageActions;
  e.Pc = privateChannels;
  Object.defineProperty(e, 'Ty', { enumerable: true, get: () => typingModule.value });
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

  describe('typing', () => {
    const typingPage = () => {
      handlers.clear();
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', { stores: storeModule });
      web.T('stores');
      p.tick();
      return p;
    };
    const cmd = async (p: ReturnType<typeof page>, id: string, c: unknown) => {
      p.win.message?.({ source: p.win, data: { __dither_bridge__: 'down', payload: { t: 'cmd', id, cmd: c } } });
      await Bun.sleep(0);
      return p.posted.find((m) => m.t === 'reply' && m.id === id);
    };

    test("goes through the client's own typing action, never a request of ours", async () => {
      const p = typingPage();
      typingCalls.length = 0;
      const requests: string[] = [];
      for (const k of ['get', 'post', 'put', 'patch', 'del']) rest[k] = (...a: any[]) => void requests.push(k + JSON.stringify(a));
      expect(await cmd(p, 't1', { kind: 'typing', channelId: '42' })).toMatchObject({ ok: true, result: { via: 'actions' } });
      expect(await cmd(p, 't2', { kind: 'typing', channelId: '42', stop: true })).toMatchObject({ ok: true });
      expect(typingCalls).toEqual(['start 42', 'stop 42']);
      expect(requests).toEqual([]);
    });

    test('without that module, the action it would dispatch', async () => {
      const saved = typingModule.value;
      typingModule.value = null;
      const dispatched: any[] = [];
      const before = dispatcher.dispatch;
      dispatcher.dispatch = ((a: any) => void dispatched.push(a)) as any;
      try {
        const p = typingPage();
        expect(await cmd(p, 't3', { kind: 'typing', channelId: '42' })).toMatchObject({ ok: true, result: { via: 'dispatch' } });
        await cmd(p, 't4', { kind: 'typing', channelId: '42', stop: true });
        expect(dispatched).toEqual([{ type: 'TYPING_START_LOCAL', channelId: '42' }, { type: 'TYPING_STOP_LOCAL', channelId: '42' }]);
      } finally {
        typingModule.value = saved;
        dispatcher.dispatch = before;
      }
    });

    test('someone typing comes with a name to show', () => {
      const p = typingPage();
      userStoreGetUser.value = (id: string) => ({ id, username: `user${id}`, globalName: 'Five' });
      emit('TYPING_START', { channelId: 'c', userId: '5' });
      const d = p.posted.find((x) => x.t === 'dispatch' && x.event === 'TYPING_START');
      expect(d.data).toEqual({ channelId: 'c', userId: '5', user: expect.objectContaining({ id: '5', username: 'user5', global_name: 'Five' }), nick: null });
    });
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

  describe('opening a DM', () => {
    const open = async (userId = '42') => {
      handlers.clear();
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', { stores: storeModule });
      web.T('stores');
      p.tick();
      p.win.message?.({ source: p.win, data: { __dither_bridge__: 'down', payload: { t: 'cmd', id: 'o', cmd: { kind: 'openDirect', userId } } } });
      await Bun.sleep(0);
      return p.posted.find((m) => m.t === 'reply');
    };
    afterEach(() => {
      delete channelStore.getDMFromUserId;
      delete privateChannels.ensurePrivateChannel;
      channelStore.getChannel = () => null;
      rest.post = () => {};
    });

    test('one the client already has costs no request', async () => {
      let posted = 0;
      rest.post = (() => void posted++) as any;
      channelStore.getDMFromUserId = () => '9';
      channelStore.getChannel = (id: string) => ({ id, type: 1, recipients: [{ id: '42', username: 'ann' }] });
      expect(await open()).toMatchObject({ ok: true, result: { channelId: '9', existed: true, channel: { id: '9', recipients: [{ id: '42' }] } } });
      expect(posted).toBe(0);
    });

    test("goes through the client's own action, and never its navigating one", async () => {
      const seen: string[] = [];
      privateChannels.ensurePrivateChannel = async (u: string) => (seen.push(u), '10');
      channelStore.getChannel = (id: string) => ({ id, type: 1, recipients: [] });
      expect(await open()).toMatchObject({ ok: true, result: { channelId: '10', existed: false } });
      expect(seen).toEqual(['42']);
      expect(privateChannels.opened).toBe(0);
    });

    test('falls back to the REST client, and passes a refusal on', async () => {
      const bodies: any[] = [];
      rest.post = ((o: any) => (bodies.push(o), Promise.resolve({ body: { id: '11', type: 1, recipients: [{ id: '42', username: 'ann' }] } }))) as any;
      expect(await open()).toMatchObject({ ok: true, result: { channelId: '11', existed: false, channel: { recipients: [{ username: 'ann' }] } } });
      expect(bodies[0]).toMatchObject({ url: '/users/@me/channels', body: { recipients: ['42'] } });
      rest.post = (() => Promise.reject({ status: 400, body: { message: 'Cannot send messages to this user' } })) as any;
      expect(await open()).toMatchObject({ ok: false, error: 'Cannot send messages to this user (400)' });
    });
  });

  test('sends files the way the client does: upload URLs, PUT, then a message naming them', async () => {
    handlers.clear();
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', { stores: storeModule });
    web.T('stores');
    p.tick();
    const posts: any[] = [];
    const realPost = rest.post;
    rest.post = async (req: any) => {
      posts.push(req);
      if (req.url.endsWith('/attachments')) return { body: { attachments: [{ id: '0', upload_url: 'https://storage.example/u', upload_filename: 'up/a.png' }] } };
      return { body: { id: '88' } };
    };
    const puts: { url: string; body: Uint8Array; type: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      puts.push({ url, body: init.body, type: init.headers['content-type'] });
      return { ok: true, status: 200 };
    }) as any;
    try {
      p.win.message?.({ source: p.win, data: { __dither_bridge__: 'down', payload: { t: 'cmd', id: 'f', cmd: { kind: 'send', channelId: '5', content: 'look', replyTo: '4', nonce: 'n2', files: [{ name: 'a.png', mime: 'image/png', size: 3, base64: btoa('abc') }] } } } });
      await Bun.sleep(5);
    } finally {
      rest.post = realPost;
      globalThis.fetch = realFetch;
    }
    expect(posts[0]).toMatchObject({ url: '/channels/5/attachments', body: { files: [{ id: '0', filename: 'a.png', file_size: 3 }] } });
    expect(puts[0].url).toBe('https://storage.example/u');
    expect(new TextDecoder().decode(puts[0].body)).toBe('abc');
    expect(puts[0].type).toBe('image/png');
    expect(posts[1]).toMatchObject({
      url: '/channels/5/messages',
      body: { content: 'look', attachments: [{ id: '0', filename: 'a.png', uploaded_filename: 'up/a.png' }], message_reference: { channel_id: '5', message_id: '4' } },
    });
    expect(p.posted.find((m) => m.t === 'reply' && m.id === 'f')).toMatchObject({ ok: true, result: { nativeId: '88' } });
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

  describe('about and settings', () => {
    const MANAGE_CHANNELS = 1n << 4n;
    const MANAGE_GUILD = 1n << 5n;
    const SEND = 1n << 11n;
    const guild = { id: '100', name: 'Test server', ownerId: '2', verificationLevel: 1, nsfwLevel: 0, features: new Set(['COMMUNITY']), description: 'About it', icon: null };
    // Unsorted, and in both colour forms the client has used.
    const roles = {
      '100': { id: '100', name: '@everyone', position: 0, color: 0 },
      '201': { id: '201', name: 'Helper', position: 1, color: 0x5c7cfa, hoist: false },
      '202': { id: '202', name: 'Mod', position: 2, colorString: '#e86a92', hoist: true },
    };
    const members = [
      { userId: '3', roles: ['201'], colorString: null, nick: 'never sent' },
      { userId: '2', roles: ['202'], colorString: '#e86a92' },
      { userId: '9', roles: [] }, // not in the user store: dropped
      { userId: '1', roles: [] },
    ];
    const channels: Record<string, any> = {
      '300': { id: '300', type: 0, guild_id: '100', parent_id: '400', name: 'general', topic: 'hello', nsfw: false, rateLimitPerUser: 10, permissionOverwrites: { '100': { id: '100', type: 0, allow: 0n, deny: SEND } } },
      '301': { id: '301', type: 0, guild_id: '100', parent_id: '400', name: 'open', topic: null, nsfw: true, rateLimitPerUser: 0, permissionOverwrites: {} },
      '400': { id: '400', type: 4, guild_id: '100', name: 'Text' },
      '500': { id: '500', type: 11, guild_id: '100', parent_id: '300', name: 'a thread', ownerId: '1', rateLimitPerUser: 0 },
      '600': { id: '600', type: 3, recipients: ['2', '3'], ownerId: '2', name: null },
      '700': { id: '700', type: 1, recipients: ['2'] },
    };
    /** Grants by subject id; 'absent' leaves the PermissionStore out, 'throws' makes its check throw. */
    let grants: Record<string, bigint[]> | 'absent' | 'throws' = {};

    function aboutPage() {
      handlers.clear();
      me = { id: '1', username: 'someone' };
      userStoreGetUser.value = (id: string) => (id === '9' ? undefined : { id, username: `user${id}`, email: 'never@forward.this' });
      guildRecords.clear();
      guildRecords.set('100', guild);
      channelStore.getChannel = (id: string) => channels[id];
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', {
        stores: storeModule,
        about: (_m: any, e: any) => {
          e.r = store('GuildRoleStore', { getRoles: () => roles });
          e.m = store('GuildMemberStore', { getMembers: () => members, getNick: () => null });
          e.n = store('GuildMemberCountStore', { getMemberCount: () => 1200 });
          if (grants !== 'absent')
            e.p = store('PermissionStore', {
              can: (bit: bigint, subject: any) => {
                if (grants === 'throws') throw new Error('not ready');
                return ((grants as Record<string, bigint[]>)[subject.id] ?? []).includes(bit);
              },
            });
        },
      });
      web.T('stores');
      web.T('about');
      p.tick();
      return p;
    }
    let n = 0;
    async function ask(p: ReturnType<typeof page>, c: unknown) {
      const id = `a${n++}`;
      p.win.message?.({ source: p.win, data: { __dither_bridge__: 'down', payload: { t: 'cmd', id, cmd: c } } });
      await Bun.sleep(0);
      const r = p.posted.find((m) => m.t === 'reply' && m.id === id);
      // It crosses the window and a WebSocket: no BigInt, no Set, nothing that does not survive JSON.
      if (r?.ok) expect(JSON.parse(JSON.stringify(r.result))).toEqual(r.result);
      return r;
    }
    const aboutOf = async (target: 'conversation' | 'space', id: string) => {
      const r = await ask(aboutPage(), { kind: 'about', target, id });
      expect(r.ok).toBe(true);
      return { raw: r.result, about: mapAbout(r.result) };
    };
    afterEach(() => {
      grants = {};
      guildRecords.clear();
      channelStore.getChannel = () => null;
      userStoreGetUser.value = () => null;
      me = null;
    });

    test('a channel, with Manage Channels', async () => {
      grants = { '300': [MANAGE_CHANNELS, SEND] };
      const { raw, about } = await aboutOf('conversation', '300');
      expect(raw.channel).toMatchObject({ rate_limit_per_user: 10, nsfw: false, everyone_denies_send: true });
      expect(JSON.stringify(raw)).not.toContain('never');
      expect(about.noun).toBe('Channel');
      expect(about.fields).toMatchObject({
        name: { value: 'general', canEdit: true },
        topic: { value: 'hello', canEdit: true },
        slowMode: { value: 10, canEdit: true },
        nsfw: { value: false, canEdit: true },
        announceOnly: { value: true, canEdit: false, reason: "Change who can send in the channel's permissions, in Discord." },
      });
      expect(about.fields.avatar).toBeUndefined();
      expect(about.rules).toContainEqual({ what: 'Change the server', who: 'Manage Server', you: false });
      expect(about.rules).toContainEqual({ what: 'Send messages', who: 'Send Messages', you: true });
    });

    test('roles by position, members with their top role and colour, this account kept', async () => {
      const { about } = await aboutOf('conversation', '301');
      expect(about.roles).toEqual([
        { id: '202', name: 'Mod', rank: 2, color: '#e86a92' },
        { id: '201', name: 'Helper', rank: 1, color: '#5c7cfa' },
        { id: '100', name: '@everyone', rank: 0 },
      ]);
      expect(about.members).toEqual({
        list: [
          { id: '2', role: 'Mod', rank: 2, color: '#e86a92' },
          { id: '3', role: 'Helper', rank: 1, color: '#5c7cfa' },
          { id: '1', rank: 0 },
        ],
        total: 1200,
        complete: false,
      });
      expect(about.you).toEqual({ role: 'Member', rank: 0 });
      expect(about.fields.announceOnly).toMatchObject({ value: false });
    });

    test('fails closed: a refusal, no store, or a check that throws', async () => {
      grants = {};
      expect((await aboutOf('conversation', '300')).about.fields.name).toEqual({ value: 'general', canEdit: false, reason: 'You need the Manage Channels permission.' });
      grants = 'absent';
      const absent = (await aboutOf('conversation', '300')).about;
      expect(absent.fields.name).toEqual({ value: 'general', canEdit: false, reason: UNSURE });
      expect(absent.fields.announceOnly).toMatchObject({ canEdit: false, reason: UNSURE });
      expect(absent.rules!.every((r) => !r.you)).toBe(true);
      grants = 'throws';
      expect((await aboutOf('conversation', '300')).about.fields.slowMode).toEqual({ value: 10, canEdit: false, reason: UNSURE });
    });

    test('a thread its owner may rename, sending by its parent', async () => {
      const { about } = await aboutOf('conversation', '500');
      expect(about.noun).toBe('Thread');
      expect(about.fields.name).toEqual({ value: 'a thread', canEdit: true });
      expect(about.fields.topic).toBeUndefined();
      expect(about.fields.nsfw).toBeUndefined();
      expect(about.fields.announceOnly).toMatchObject({ value: true, canEdit: false });
    });

    test('a group DM: anyone renames, the owner removes', async () => {
      grants = 'absent';
      const { about } = await aboutOf('conversation', '600');
      expect(about.noun).toBe('Group');
      expect(about.fields.name).toEqual({ value: 'user2, user3', canEdit: true });
      expect(about.fields.avatar).toEqual({ value: null, canEdit: false, reason: 'Changing the picture is not supported yet.' });
      expect(about.members).toEqual({ list: [{ id: '1', rank: 0 }, { id: '2', role: 'Group owner', rank: 100 }, { id: '3', rank: 0 }], complete: true });
      expect(about.rules).toEqual([
        { what: 'Rename, change the icon, add people', who: 'Everyone in the group', you: true },
        { what: 'Remove people', who: 'The group owner', you: false },
      ]);
      expect(about.facts).toContainEqual({ label: 'Owner', value: 'user2' });
    });

    test('a DM has nothing to change', async () => {
      grants = { '700': [MANAGE_CHANNELS] };
      const { about } = await aboutOf('conversation', '700');
      expect(about.noun).toBe('Direct message');
      expect(about.fields).toEqual({});
      expect(about.members).toEqual({ list: [{ id: '1', rank: 0 }, { id: '2', rank: 0 }], complete: true });
    });

    test('a server and a category', async () => {
      grants = { '100': [MANAGE_GUILD] };
      const server = (await aboutOf('space', '100')).about;
      expect(server.noun).toBe('Server');
      expect(server.fields).toMatchObject({
        name: { value: 'Test server', canEdit: true },
        topic: { value: 'About it', canEdit: false, reason: 'Change the server description in Discord.' },
        avatar: { value: null, canEdit: false },
        nsfw: { value: false, canEdit: false },
      });
      expect(server.facts).toEqual([
        { label: 'Verification level', value: 'Low: a verified email' },
        { label: 'Owner', value: 'user2' },
        { label: 'Created', value: '2015-01-01' },
      ]);
      const category = (await aboutOf('space', '400')).about;
      expect(category.noun).toBe('Category');
      expect(category.fields).toEqual({ name: { value: 'Text', canEdit: false, reason: 'You need the Manage Channels permission.' } });
      expect((await ask(aboutPage(), { kind: 'about', target: 'space', id: '300' })).ok).toBe(false);
    });

    test("configure sends one PATCH through the client's REST module, with only settings fields", async () => {
      const p = aboutPage();
      const calls: any[] = [];
      const realPatch = rest.patch;
      rest.patch = (req: any) => (calls.push(req), Promise.resolve({ body: req.url.startsWith('/guilds') ? { id: '100', name: req.body.name, owner_id: '2' } : { id: '300', type: 0, name: 'renamed', guild_id: '100', permission_overwrites: [] } }));
      try {
        const ch = await ask(p, { kind: 'configure', channelId: '300', patch: { name: 'renamed', rate_limit_per_user: 30, permission_overwrites: [], type: 5 } });
        expect(ch).toMatchObject({ ok: true, result: { channel: { id: '300', name: 'renamed', guild_id: '100' } } });
        const g = await ask(p, { kind: 'configure', guildId: '100', patch: { name: 'New name', description: 'not offered' } });
        expect(g).toMatchObject({ ok: true, result: { guild: { id: '100', name: 'New name' } } });
        expect((await ask(p, { kind: 'configure', channelId: '../users/@me', patch: { name: 'x' } })).ok).toBe(false);
        expect((await ask(p, { kind: 'configure', channelId: '300', patch: { icon: 'data:' } })).ok).toBe(false);
      } finally {
        rest.patch = realPatch;
      }
      expect(calls).toEqual([
        { url: '/channels/300', query: undefined, body: { name: 'renamed', rate_limit_per_user: 30 } },
        { url: '/guilds/100', query: undefined, body: { name: 'New name' } },
      ]);
    });

    test('the adapter plans that PATCH from the same read', async () => {
      grants = { '300': [MANAGE_CHANNELS] };
      const { raw } = await aboutOf('conversation', '300');
      expect(configurePlan(raw, { key: 'slowMode', value: 30 })).toEqual({ channelId: '300', patch: { rate_limit_per_user: 30 } });
      grants = {};
      const locked = (await aboutOf('conversation', '300')).raw;
      expect(() => configurePlan(locked, { key: 'name', value: 'x' })).toThrow('You need the Manage Channels permission.');
    });
  });

  describe('profiles', () => {
    const WHO = '42';
    const calls: string[] = [];
    let fetchFails: unknown = null;
    // The body the server answers a profile with (snake_case), as the client's fetch receives it.
    const body = (id: string) => ({
      user: { id, username: 'ann', global_name: 'Ann', avatar: 'aa', banner: null },
      user_profile: { bio: 'hi there', pronouns: 'they/them', banner: 'bb', accent_color: 255 },
      connected_accounts: [
        { type: 'github', id: '1', name: 'ann-gh', verified: true, access_token: 'never forward this' },
        { type: 'contacts', id: '2', name: 'hidden by the client' },
      ],
      mutual_guilds: [{ id: '100', nick: 'Annie' }],
      mutual_friends: [{ id: '7', username: 'bo', global_name: null, email: 'never@forward.this' }],
      mutual_friends_count: 1,
      legacy_username: 'ann#0001',
    });
    // The client's profile store, filled by its fetch the way USER_PROFILE_FETCH_SUCCESS fills it.
    const profiles = new Map<string, any>();
    const supported = (t: string) => t !== 'contacts';
    const land = (b: ReturnType<typeof body>) =>
      profiles.set(b.user.id, {
        bio: b.user_profile.bio,
        pronouns: b.user_profile.pronouns,
        banner: b.user_profile.banner,
        accentColor: b.user_profile.accent_color,
        connectedAccounts: b.connected_accounts.filter((a) => supported(a.type)),
        legacyUsername: b.legacy_username,
        guilds: b.mutual_guilds.map((g) => ({ guild: guildRecords.get(g.id), nick: g.nick })),
        friends: b.mutual_friends.map((u) => ({ key: u.id, user: { ...u, globalName: u.global_name }, status: 'online' })),
      });
    const profileStore: any = store('UserProfileStore', {
      isFetchingProfile: () => false,
      getUserProfile: (id: string) => profiles.get(id),
      getMutualGuilds: (id: string) => profiles.get(id)?.guilds,
      getMutualFriends: (id: string) => profiles.get(id)?.friends,
      getMutualFriendsCount: (id: string) => profiles.get(id)?.friends?.length,
    });
    const dispatchLocal = (_a: unknown) => {};
    // As in the client: the fetch shares its module with the terms-of-service call, under mangled names.
    const fetchModule: any = {
      Q9() {
        calls.push('ACCEPTED THE TERMS');
      },
      async eO(id: string, o: any = {}, onBody?: (b: unknown) => void) {
        calls.push(`fetch ${id} ${JSON.stringify(o)}`);
        dispatchLocal({ type: "USER_PROFILE_FETCH_START", userId: id });
        if (fetchFails) throw fetchFails;
        const query = { type: o.type, with_mutual_guilds: o.withMutualGuilds, with_mutual_friends: o.withMutualFriends };
        void query;
        const b = body(id);
        onBody?.(b);
        land(b);
      },
    };
    // A click on someone runs this: it skips a profile fetched in the last minute, else it runs the fetch.
    function maybeFetchProfile(id: string, avatar: unknown, o: any = {}) {
      const { waitForRefetch = true, ...rest } = o;
      void waitForRefetch;
      if (profileStore.isFetchingProfile(id)) return Promise.resolve();
      calls.push(`open ${id} ${avatar}`);
      return fetchModule.eO(id, rest);
    }
    const platforms = {
      github: { name: 'GitHub', getPlatformUserUrl: (a: { name: string }) => `https://github.com/${a.name}` },
    };

    function profilePage(has: { open?: boolean; store?: boolean; fetch?: boolean; platforms?: boolean }, late = false) {
      handlers.clear();
      calls.length = 0;
      profiles.clear();
      me = { id: '1', username: 'someone' };
      const users: Record<string, any> = {
        [WHO]: { id: WHO, username: 'ann', globalName: 'Ann', avatar: 'aa', email: 'never@forward.this' },
        '7': { id: '7', username: 'bo' },
        '8': { id: '8', username: 'cy' },
      };
      userStoreGetUser.value = (id: string) => users[id];
      guildRecords.clear();
      guildRecords.set('100', { id: '100', name: 'Test server' });
      const p = page();
      p.runHook();
      const web = runtime(p.win, 'web');
      chunk(p.win, '700', {
        stores: storeModule,
        people: (_m: any, e: any) => {
          e.r = store('RelationshipStore', {
            getRelationshipType: (id: string) => (id === WHO || id === '7' || id === '8' ? 1 : 0),
            getSince: (id: string) => (id === WHO ? '2020-02-02T00:00:00.000Z' : undefined),
            getFriendIDs: () => [WHO, '7', '8'],
          });
          e.s = store('PresenceStore', { getActivities: (id: string) => (id === WHO ? [{ type: 0, name: 'A game' }, { type: 4, name: 'Custom Status', state: 'busy', emoji: { name: '🔧' } }] : []) });
          e.m = store('GuildMemberStore', {
            getMember: (g: string, u: string) => (g === '100' && u === WHO ? { userId: WHO, nick: 'Annie', roles: ['201', '202'], joinedAt: '2023-04-05T06:07:08.000Z' } : null),
            getNick: () => null,
          });
          e.g = store('GuildRoleStore', {
            getRoles: () => ({
              '100': { id: '100', name: '@everyone', position: 0, color: 0 },
              '202': { id: '202', name: 'Mod', position: 2, colorString: '#e86a92' },
              '201': { id: '201', name: 'Helper', position: 1, color: 0x5c7cfa },
            }),
          });
        },
      });
      const profileChunk = () =>
        chunk(p.win, '701', {
          profile: (_m: any, e: any) => {
            if (has.store) e.p = profileStore;
            if (has.platforms) e.t = { get: (t: string) => (platforms as any)[t] ?? null, getByUrl() {}, isSupported: supported, map() {}, filter() {}, find() {} };
          },
          fetch: (_m: any, e: any) => {
            if (has.fetch) Object.assign(e, fetchModule);
          },
          open: (_m: any, e: any) => {
            if (has.open) e.A = maybeFetchProfile;
          },
        });
      web.T('stores');
      web.T('people');
      const load = () => {
        profileChunk();
        web.T('profile');
        web.T('fetch');
        web.T('open');
      };
      if (!late) load();
      p.tick();
      if (late) load(); // after the finders have looked
      return p;
    }
    let n = 0;
    async function ask(p: ReturnType<typeof page>, c: unknown) {
      const id = `p${n++}`;
      p.win.message?.({ source: p.win, data: { __dither_bridge__: 'down', payload: { t: 'cmd', id, cmd: c } } });
      for (let i = 0; i < 5; i++) await Bun.sleep(0);
      const r = p.posted.find((m) => m.t === 'reply' && m.id === id);
      if (r?.ok) expect(JSON.parse(JSON.stringify(r.result))).toEqual(r.result);
      return r;
    }
    afterEach(() => {
      fetchFails = null;
      guildRecords.clear();
      userStoreGetUser.value = () => null;
      rest.get = () => {};
      me = null;
    });

    test("opens it as a click does, then reads the client's stores", async () => {
      const r = await ask(profilePage({ open: true, store: true, fetch: true, platforms: true }), { kind: 'profile', userId: WHO });
      expect(r.ok).toBe(true);
      expect(calls).toEqual(['open 42 undefined', 'fetch 42 {"type":"popout","withMutualGuilds":true,"withMutualFriends":true}']);
      expect(r.result).toMatchObject({
        selfId: '1',
        user: { id: WHO, username: 'ann', global_name: 'Ann', avatar: 'aa' },
        bio: 'hi there',
        pronouns: 'they/them',
        banner: 'bb',
        accent_color: 255,
        legacy_username: 'ann#0001',
        relationship: 1,
        friend_since: '2020-02-02T00:00:00.000Z',
        custom_status: { text: 'busy', emoji: { id: null, name: '🔧', animated: false } },
        mutual_friends_count: 1,
      });
      expect(r.result.connected_accounts).toEqual([{ type: 'github', id: '1', name: 'ann-gh', verified: true, label: 'GitHub', url: 'https://github.com/ann-gh' }]);
      expect(r.result.mutual_guilds).toEqual([
        {
          id: '100',
          name: 'Test server',
          nick: 'Annie',
          joined_at: '2023-04-05T06:07:08.000Z',
          roles: [
            { id: '201', name: 'Helper', color: '#5c7cfa', position: 1, hoist: false },
            { id: '202', name: 'Mod', color: '#e86a92', position: 2, hoist: false },
          ],
        },
      ]);
      expect(r.result.mutual_friends).toEqual([expect.objectContaining({ id: '7', username: 'bo', global_name: null })]);
      expect(r.result.friends).toBeUndefined();
      expect(r.result.error).toBeUndefined();
      expect(JSON.stringify(r.result)).not.toContain('never');

      const about = mapProfile(r.result, WHO);
      expect(about).toMatchObject({ displayName: 'Ann', banner: 'https://cdn.discordapp.com/banners/42/bb.webp?size=600', relationship: 'friend', status: { text: 'busy', emoji: '🔧' } });
      expect(about.mutualSpaces).toEqual([{ id: '100', nick: 'Annie', roles: [{ name: 'Mod', color: '#e86a92' }, { name: 'Helper', color: '#5c7cfa' }], joinedAt: Date.UTC(2023, 3, 5, 6, 7, 8) }]);
    });

    test('without the open, the fetch itself, never its neighbour; its body when there is no store', async () => {
      const r = await ask(profilePage({ fetch: true }), { kind: 'profile', userId: WHO });
      expect(r.ok).toBe(true);
      expect(calls).toEqual(['fetch 42 {"type":"popout","withMutualGuilds":true,"withMutualFriends":true}']);
      expect(r.result).toMatchObject({ bio: 'hi there', banner: 'bb', accent_color: 255, mutual_friends_count: 1 });
      expect(r.result.mutual_guilds).toMatchObject([{ id: '100', name: 'Test server', nick: 'Annie', roles: [{ name: 'Helper' }, { name: 'Mod' }] }]);
      // No table to ask: the platform's name and link come from the adapter, and nothing marks them as the client's.
      expect(r.result.connected_accounts).toEqual([
        { type: 'github', id: '1', name: 'ann-gh', verified: true },
        { type: 'contacts', id: '2', name: 'hidden by the client', verified: false },
      ]);
      expect(mapProfile(r.result, WHO).links).toEqual([{ label: 'GitHub', value: 'ann-gh', url: 'https://github.com/ann-gh', verified: true }]);
      expect(JSON.stringify(r.result)).not.toContain('never');
    });

    test("without either, the same request through the client's REST module", async () => {
      const seen: any[] = [];
      rest.get = (req: any) => (seen.push(req), Promise.resolve({ body: body(WHO) }));
      const r = await ask(profilePage({}), { kind: 'profile', userId: WHO });
      expect(seen).toEqual([{ url: '/users/42/profile', query: { type: 'popout', with_mutual_guilds: true, with_mutual_friends: true }, body: undefined }]);
      expect(r.result).toMatchObject({ bio: 'hi there', mutual_guilds: [{ id: '100', nick: 'Annie' }], mutual_friends: [{ id: '7' }] });
    });

    test('modules that load after the finders looked are still found', async () => {
      const r = await ask(profilePage({ open: true, store: true, fetch: true }, true), { kind: 'profile', userId: WHO });
      expect(calls[0]).toBe('open 42 undefined');
      expect(r.result.bio).toBe('hi there');
    });

    test('a refused fetch answers with what the client has; a rate limit is passed on', async () => {
      fetchFails = { status: 403, body: { message: 'Missing Access', code: 50001 } };
      const r = await ask(profilePage({ fetch: true, store: true }), { kind: 'profile', userId: WHO });
      expect(r.ok).toBe(true);
      expect(r.result).toMatchObject({ error: 'Missing Access (403)', user: { id: WHO, username: 'ann' }, relationship: 1, mutual_guilds: null, mutual_friends: null });
      expect(mapProfile(r.result, WHO)).toMatchObject({ displayName: 'Ann', relationship: 'friend' });

      fetchFails = { status: 429, body: { message: 'You are being rate limited.', retry_after: 3 } };
      expect(await ask(profilePage({ fetch: true, store: true }), { kind: 'profile', userId: WHO })).toMatchObject({ ok: false, error: 'You are being rate limited. (429)', retryAfter: 3 });
    });

    test('your own: no mutuals asked for, your friends listed', async () => {
      const r = await ask(profilePage({ open: true, store: true, fetch: true }), { kind: 'profile', userId: '1' });
      expect(calls).toEqual(['open 1 undefined', 'fetch 1 {"type":"popout","withMutualGuilds":false,"withMutualFriends":false}']);
      expect(r.result.friends.map((u: any) => u.id)).toEqual([WHO, '7', '8']);
      expect(mapProfile(r.result, '1').friends).toEqual([WHO, '7', '8']);
    });

    test('asks for nothing without a user id', async () => {
      const r = await ask(profilePage({ open: true, store: true, fetch: true }), { kind: 'profile', userId: '../users/@me' });
      expect(r).toMatchObject({ ok: false, error: 'whose profile?' });
      expect(calls).toEqual([]);
    });
  });

  test('reports why a sign-in failed, without tickets or tokens', () => {
    handlers.clear();
    me = null;
    const logLines = [
      '2026-10-31T00:36:13.662Z -> Network -> Completed POST to https://discord.com/api/v9/auth/location-metadata with status: 200',
      '2026-10-31T00:36:13.700Z -> Network -> Completed POST to https://discord.com/api/v9/users/@me/remote-auth/login with status: 400 and body: {"captcha_key":["captcha-required"],"captcha_sitekey":"abc","captcha_rqdata":"secretish"}',
      '2026-10-31T00:36:33.938Z -> Network -> Completed POST to https://discord.com/api/v9/users/@me/remote-auth/login with status: 400 and body: {"captcha_key":["invalid-response"]}',
      '2026-10-31T00:36:53.531Z -> Network -> Completed POST to https://discord.com/api/v9/users/@me/remote-auth/login with status: 404 and body: {"message":"Invalid remote authentication ticket","code":20042}',
      '2026-10-31T00:36:54.000Z -> Network -> Completed GET to https://discord.com/api/v9/channels/1/messages with status: 403 and body: {"message":"Missing Access"}',
    ];
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      log: (_m: any, e: any) => {
        e.z8 = function (category: string) {
          return category;
        };
        e.As = function (filter: string[]) {
          const r = { toArray: () => logLines.map((message) => ({ message })) };
          return r.toArray().filter(() => filter.includes('Network')).map((x) => x.message).join('\n');
        };
      },
    });
    web.T('stores');
    web.T('log');
    p.tick();
    p.poll();
    p.poll(); // no repeats
    const issues = p.posted.filter((m) => m.t === 'loginIssue');
    expect(issues).toEqual([
      { t: 'loginIssue', route: 'users/@me/remote-auth/login', status: 400, captcha: 'captcha-required', message: undefined, code: undefined },
      { t: 'loginIssue', route: 'users/@me/remote-auth/login', status: 400, captcha: 'invalid-response', message: undefined, code: undefined },
      { t: 'loginIssue', route: 'users/@me/remote-auth/login', status: 404, captcha: undefined, message: 'Invalid remote authentication ticket', code: 20042 },
    ]);
    expect(JSON.stringify(issues)).not.toContain('secretish');
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

  test('the snapshot lists friends from a client without getRelationships', () => {
    handlers.clear();
    me = { id: '1', username: 'someone' };
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      rel: (_m: any, e: any) => {
        // Current clients: a Map of records, no getRelationships().
        e.r = store('RelationshipStore', { getMutableRelationships: () => new Map([['7', { type: 1 }], ['8', { type: 2 }]]), getFriendIDs: () => ['7'] });
      },
    });
    web.T('stores');
    web.T('rel');
    p.tick();
    p.poll();
    const snap = p.posted.filter((m) => m.t === 'snapshot').at(-1);
    expect(snap.data.relationships).toEqual([
      { id: '7', type: 1 },
      { id: '8', type: 2 },
    ]);
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

describe('pins, roles and custom statuses', () => {
  // Discord's dispatcher runs interceptors, then the stores' handlers, then subscribers.
  let interceptors: ((action: any) => boolean)[] = [];
  const dispatch = (type: string, action: any, apply: () => void = () => {}) => {
    const a = { type, ...action };
    if (interceptors.some((fn) => fn(a))) return;
    apply();
    emit(type, a);
  };
  const members = new Map<string, { userId: string; roles: string[] }>();
  const messages = new Map<string, { id: string; pinned: boolean }>();
  const presences = new Map<string, { status: string; activities: any[] }>();

  function changesPage(opts: { interceptors?: boolean } = {}) {
    handlers.clear();
    interceptors = [];
    if (opts.interceptors !== false) (dispatcher as any).addInterceptor = (fn: (a: any) => boolean) => interceptors.push(fn);
    me = { id: '1', username: 'someone' };
    userStoreGetUser.value = (id: string) => ({ id, username: `user${id}` });
    guildRecords.clear();
    guildRecords.set('100', { id: '100', name: 'Test server' });
    channelStore.getDMFromUserId = (id: string) => (id === '20' ? '620' : undefined);
    const p = page();
    p.runHook();
    const web = runtime(p.win, 'web');
    chunk(p.win, '700', {
      stores: storeModule,
      changes: (_m: any, e: any) => {
        e.m = store('GuildMemberStore', { getMember: (g: string, u: string) => (g === '100' ? members.get(u) ?? null : null), getNick: () => null });
        e.g = store('GuildRoleStore', {
          getRoles: () => ({
            '100': { id: '100', name: '@everyone', position: 0, color: 0 },
            '201': { id: '201', name: 'Helper', position: 1, color: 0x5c7cfa },
            '202': { id: '202', name: 'Mod', position: 2, colorString: '#e86a92' },
            '203': { id: '203', name: 'Unrelated', position: 3 },
          }),
        });
        e.s = store('MessageStore', { getMessage: (_c: string, id: string) => messages.get(id) });
        e.r = store('RelationshipStore', { getRelationshipType: (id: string) => (id === '7' || id === '8' ? 1 : id === '9' ? 2 : 0), getFriendIDs: () => ['7', '8'] });
        e.p = store('PresenceStore', { getStatus: (id: string) => presences.get(id)?.status ?? 'offline', getActivities: (id: string) => presences.get(id)?.activities ?? [] });
      },
    });
    web.T('stores');
    web.T('changes');
    p.tick();
    const sent = (event: string) => p.posted.filter((x) => x.t === 'dispatch' && x.event === event).map((x) => x.data);
    return { p, sent };
  }
  afterEach(() => {
    delete (dispatcher as any).addInterceptor;
    delete channelStore.getDMFromUserId;
    members.clear();
    messages.clear();
    presences.clear();
    guildRecords.clear();
    userStoreGetUser.value = () => null;
    me = null;
  });

  test("a role change is read against the member as the client had them, before the store takes it in", () => {
    const { sent } = changesPage();
    members.set('5', { userId: '5', roles: ['201'] });
    const update = { guildId: '100', user: { id: '5', username: 'user5' }, roles: ['201', '202'], nick: 'new nick' };
    dispatch('GUILD_MEMBER_UPDATE', update, () => members.set('5', { userId: '5', roles: update.roles }));
    expect(sent('GUILD_MEMBER_UPDATE')).toEqual([
      {
        guildId: '100',
        user: expect.objectContaining({ id: '5', username: 'user5' }),
        roles: ['201', '202'],
        before: ['201'],
        named: [
          { id: '201', name: 'Helper', color: '#5c7cfa' },
          { id: '202', name: 'Mod', color: '#e86a92' },
        ],
      },
    ]);
    expect(JSON.stringify(sent('GUILD_MEMBER_UPDATE'))).not.toContain('new nick');
  });

  test('a nickname change, or a member the client had not loaded, sends nothing', () => {
    const { sent } = changesPage();
    members.set('5', { userId: '5', roles: ['201'] });
    dispatch('GUILD_MEMBER_UPDATE', { guildId: '100', user: { id: '5' }, roles: ['201'], nick: 'x' });
    dispatch('GUILD_MEMBER_UPDATE', { guildId: '100', user: { id: '6' }, roles: ['202'] });
    expect(sent('GUILD_MEMBER_UPDATE')).toEqual([]);
  });

  test('without interceptors, a member update goes to the adapter to compare with what it heard before', () => {
    const { sent } = changesPage({ interceptors: false });
    members.set('5', { userId: '5', roles: ['201'] });
    dispatch('GUILD_MEMBER_UPDATE', { guildId: '100', user: { id: '5' }, roles: ['202'] });
    const [d] = sent('GUILD_MEMBER_UPDATE');
    expect(d.before).toBeUndefined();
    expect(d.roles).toEqual(['202']);
  });

  test('MESSAGE_UPDATE says whether the client had the message pinned; CHANNEL_PINS_UPDATE is passed on', () => {
    const { sent } = changesPage();
    messages.set('41', { id: '41', pinned: false });
    const msg = (id: string) => ({ id, channel_id: '300', author: { id: '5', username: 'user5' }, content: 'never forwarded twice', timestamp: '2024-06-01T12:00:00.000Z', pinned: true });
    dispatch('MESSAGE_UPDATE', { message: msg('41') }, () => messages.set('41', { id: '41', pinned: true }));
    dispatch('MESSAGE_UPDATE', { message: msg('42') });
    dispatch('CHANNEL_PINS_UPDATE', { channelId: '300', lastPinTimestamp: '2024-06-02T00:00:00.000Z' });
    const [known, unknown] = sent('MESSAGE_UPDATE');
    expect(known).toMatchObject({ message: { id: '41', pinned: true }, wasPinned: false });
    expect(unknown.message.pinned).toBe(true);
    expect('wasPinned' in unknown).toBe(false);
    expect(sent('CHANNEL_PINS_UPDATE')).toEqual([{ channelId: '300', lastPinTimestamp: '2024-06-02T00:00:00.000Z' }]);
  });

  test('custom statuses of friends and DM peers only, on change only, and offline is not cleared', () => {
    const { sent } = changesPage();
    const custom = (state: string | null, emoji?: any) => ({ type: 4, name: 'Custom Status', state, emoji });
    const song = (track: string) => ({ type: 2, name: 'Spotify', details: track });
    dispatch('PRESENCE_UPDATES', {
      updates: [
        { user: { id: '7' }, status: 'online', activities: [custom('coding', { id: '99', name: 'ferris', animated: false })] },
        { user: { id: '30' }, guildId: '100', status: 'online', activities: [custom('a stranger in a big server')] },
        { user: { id: '9' }, status: 'online', activities: [custom('blocked')] },
        { user: { id: '20' }, status: 'idle', activities: [] },
        { user: { id: '1' }, status: 'online', activities: [custom('me')] },
      ],
    });
    // The same again, a song moving on, going offline and back: nothing to say.
    dispatch('PRESENCE_UPDATES', { updates: [{ user: { id: '7' }, status: 'online', activities: [song('one'), custom('coding', { id: '99', name: 'ferris' })] }] });
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'offline', activities: [] });
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'dnd', activities: [custom('coding', { id: '99', name: 'ferris' }), song('two')] });
    // Cleared.
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'online', activities: [song('three')] });
    expect([...sent('PRESENCE_UPDATES'), ...sent('PRESENCE_UPDATE')]).toEqual([
      {
        statuses: [
          { user: expect.objectContaining({ id: '7' }), text: 'coding', emoji: { id: '99', name: 'ferris', animated: false } },
          { user: expect.objectContaining({ id: '20' }), text: null, emoji: null },
        ],
      },
      { statuses: [{ user: expect.objectContaining({ id: '7' }), text: null, emoji: null }] },
    ]);
  });

  test("the snapshot and CONNECTION_OPEN_SUPPLEMENTAL carry online friends' custom statuses", () => {
    const { p, sent } = changesPage();
    p.poll();
    expect(p.posted.find((m) => m.t === 'snapshot').data.customStatuses).toEqual([]); // presences come later
    presences.set('7', { status: 'online', activities: [{ type: 4, state: 'on holiday', emoji: { name: '🌴' } }] });
    presences.set('8', { status: 'offline', activities: [] });
    dispatch('CONNECTION_OPEN_SUPPLEMENTAL', { presences: [] });
    expect(sent('CONNECTION_OPEN_SUPPLEMENTAL')).toEqual([{ statuses: [{ user: expect.objectContaining({ id: '7' }), text: 'on holiday', emoji: { id: null, name: '🌴', animated: false } }] }]);
    // What it said is the last said: the same presence again sends nothing.
    dispatch('PRESENCE_UPDATE', { user: { id: '7' }, status: 'online', activities: [{ type: 4, state: 'on holiday', emoji: { name: '🌴' } }] });
    expect(sent('PRESENCE_UPDATE')).toEqual([]);
    emit('CONNECTION_OPEN');
    expect(p.posted.filter((m) => m.t === 'snapshot').at(-1).data.customStatuses).toEqual([{ user: expect.objectContaining({ id: '7' }), text: 'on holiday', emoji: { id: null, name: '🌴', animated: false } }]);
  });
});
