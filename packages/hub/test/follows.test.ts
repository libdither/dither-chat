/**
 * Following a post (docs/feed.md "Following a post", packages/hub/src/follows.ts): the demo X account's routing post
 * followed. Following reads the thread first, so the replies there stay in the quiet posts conversation; a reply that
 * comes after is found by a check and goes to the post's own conversation, unread, decided as a Conversation (one your
 * own reading brings in goes there read); the
 * checks slow down, doubling to six hours, and stop after a week with nothing new; a check waits while the account is
 * offline; unfollowing stops them and keeps the conversation. Then the routes. Time is a test clock throughout.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { followNativeId, postNativeId } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { DEMO_X_ACCOUNT, DemoX, X } from '../src/demo-x.ts';
import { FOLLOW, Follows } from '../src/follows.ts';
import { Posts } from '../src/posts.ts';
import { BRISK, ReadingPace } from '../src/readingpace.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { FakeClock } from './fixtures/clock.ts';

type Row = Record<string, any>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A store with the demo X account in it, its adapter answering commands in process. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'dither-follows-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const acc = store.createAccount({ ...DEMO_X_ACCOUNT, adapter: 'demo', demo: true, config: { epoch: Date.now() } });
  const adir = join(dir, acc.id);
  mkdirSync(adir, { recursive: true });
  const adapter = new DemoX(acc, adir);
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const sent: P.AdapterCommand[] = [];
  store.db.transaction(() =>
    adapter.start((ev) => {
      if (ev.t === 'reply') {
        const p = pending.get(ev.id);
        pending.delete(ev.id);
        if (ev.ok) p?.resolve(ev.result);
        else p?.reject(new Error(ev.error));
        return;
      }
      store.ingest(store.account(acc.id)!, ev);
    }),
  )();
  store.flush();
  const command = <T,>(cmd: object): Promise<T> => {
    const full = { ...cmd, id: crypto.randomUUID() } as P.AdapterCommand;
    sent.push(full);
    return new Promise<T>((resolve, reject) => {
      pending.set((full as { id: string }).id, { resolve: resolve as (v: unknown) => void, reject });
      adapter.command(full);
    });
  };
  /** Someone answers `post` on the demo's X now; the reply's id. */
  const newReply = async (post: string) => (await command<{ id: string }>({ t: 'action', action: 'newReply', args: { post } })).id;
  /** The routing post: the one with the thread under it. */
  const routing = () => (JSON.parse(store.one<Row>(`SELECT extra FROM message WHERE native_id LIKE 'reply:%'`)!.extra).feed as P.FeedItem).post!.id;
  return { dir, store, acc, sent, command, newReply, routing };
}

describe('following a post', () => {
  const w = world();
  const { store, acc, sent } = w;
  const clock = new FakeClock(Date.UTC(2026, 0, 5, 12));
  let online = true;
  const told: string[][] = [];
  const posts = new Posts({ store, online: () => online, command: (_: string, cmd: object) => w.command(cmd), now: clock.now, fresh: (ids) => told.push(ids) });
  const follows = new Follows({ store, posts, online: () => online, pace: new ReadingPace(store, BRISK, clock), clock });
  const post = w.routing();
  const cid = hubId('cnv', 'x', followNativeId(post));
  const POSTS = hubId('cnv', 'x', `posts:${X.self.nativeId}`);
  const msg = (id: string) => hubId('msg', 'x', postNativeId(id));
  const row = () => store.one<Row>('SELECT * FROM post_follow WHERE conversation_id = ?', cid)!;
  const unread = () => store.one<Row>(`SELECT unread FROM vantage WHERE account_id = ? AND target_kind = 'conversation' AND target_id = ?`, acc.id, cid)!.unread as number;
  const reads = () => sent.filter((c) => c.t === 'post' && c.post === post).length;
  const where = (id: string) => store.one<Row>('SELECT conversation_id FROM message WHERE id = ?', msg(id))?.conversation_id;
  let first = '';
  beforeAll(() => follows.start());
  afterAll(() => {
    follows.stop();
    store.db.close();
  });

  test('reads the thread first: the replies there now stay in the posts conversation, and the post gets a chat of its own', async () => {
    const f = await follows.follow('x', post);
    expect(reads()).toBe(1);
    expect(f).toMatchObject({ conversationId: cid, accountId: acc.id, since: clock.now(), stopped: null, next: clock.now() + FOLLOW.first, lastNew: clock.now() });
    const c = store.conversationView(cid)!;
    expect(c).toMatchObject({ variant: 'follow', shape: 'channel', name: 'Replies to your post', nativeId: followNativeId(post), follow: { stopped: null } });
    expect(c.topic).toMatch(/^Greedy routing/);
    // Every reply read before the follow is old news: none moved, nothing unread.
    const old = store.raw<Row>(`SELECT m.native_id, m.conversation_id FROM message m WHERE m.native_id LIKE 'post:%' AND m.reply_to_id = ?`, msg(post));
    expect(old.length).toBeGreaterThan(2);
    expect(old.every((m) => m.conversation_id === POSTS)).toBe(true);
    expect(store.one<Row>('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?', cid)!.n).toBe(0);
    expect(unread()).toBe(0);
    // The thread says it is followed; following again asks nothing of X.
    expect((await posts.thread('x', post)).follow).toMatchObject({ conversationId: cid, stopped: null });
    await follows.follow('x', post);
    expect(reads()).toBe(1);
  });

  test('a reply that comes later is found by the check five minutes on, and comes to the chat unread, as news', async () => {
    first = await w.newReply(post);
    await clock.until(() => where(first) === cid, FOLLOW.first + MIN, 'the reply in the chat');
    expect(clock.now()).toBe(row().since + FOLLOW.first);
    expect(reads()).toBe(2);
    expect(unread()).toBe(1);
    expect(told.flat()).toEqual([msg(first)]);
    expect(store.one<Row>('SELECT COUNT(*) AS n FROM message WHERE native_id = ?', postNativeId(first))!.n).toBe(1);
    // Found now: the gap starts over.
    expect(row()).toMatchObject({ last_new: clock.now(), gap: FOLLOW.first, next_at: clock.now() + FOLLOW.first });
    // New until read.
    expect(follows.state('x', post, true)!.fresh).toEqual([first]);
    store.markRead(cid, clock.now());
    expect(follows.state('x', post, true)!.fresh).toEqual([]);
  });

  test('the thread still has it, read from X or from what was logged, wherever each reply was logged', async () => {
    const t = await posts.thread('x', post);
    expect(t.replies.flat().map((p) => p.id)).toContain(first);
    const stored = await new Posts({ store, online: () => false, command: () => Promise.reject(new Error('offline')) }).thread('x', post);
    expect(stored.stored).toBeDefined();
    const before = store.raw<Row>(`SELECT native_id FROM message WHERE reply_to_id = ? AND conversation_id = ?`, msg(post), POSTS).map((m) => String(m.native_id).slice(5));
    expect(stored.replies.flat().map((p) => p.id)).toEqual(expect.arrayContaining([first, ...before.slice(0, 2)]));
  });

  test('a reply to that reply reaches the chat too; one you read in the thread comes in read, and not as New', async () => {
    const deeper = await w.newReply(first);
    await clock.until(() => where(deeper) === cid, FOLLOW.first + MIN, 'the answer to the reply in the chat');
    expect(told.flat()).toEqual([msg(first), msg(deeper)]);
    const seen = await w.newReply(post);
    const read = await posts.reread('x', post, acc.id, false);
    expect(read.followed).toBe(1);
    expect(where(seen)).toBe(cid);
    expect(told.flat()).toEqual([msg(first), msg(deeper)]);
    // The chat was read in the test before: unread is the answer the check found, not the reply you read.
    expect(unread()).toBe(1);
    // New since the chat was read (the test before): what the check found, not what you read.
    expect(follows.state('x', post, true)!.fresh).toEqual([deeper]);
  });

  test('is a Conversation by default, and changes like any chat', async () => {
    const triage = new Triage(store);
    const id = msg(first);
    const d = await triage.decide(id);
    expect(d?.decision).toBe('quiet');
    expect(d?.reasons).toContain('A reply to a post you follow');
    store.setRule('conversation', cid, 'digest');
    try {
      expect((await triage.decide(id))?.decision).not.toBe('quiet');
    } finally {
      store.setRule('conversation', cid, null);
    }
  });

  test('a quiet post is checked less and less often, six hours apart at most, and not after a week with nothing new', async () => {
    const start = row();
    const at: number[] = [start.checked_at];
    while (row().stopped === null) {
      const was = row().checked_at;
      await clock.until(() => row().checked_at !== was, 7 * HOUR, 'the next check');
      at.push(row().checked_at);
    }
    const gaps = at.slice(1).map((t, i) => (t - at[i]) / MIN);
    expect(gaps.slice(0, 8)).toEqual([5, 10, 20, 40, 80, 160, 320, 360]);
    expect(Math.max(...gaps)).toBe(360);
    // The last check falls on the end of the quiet week, and stops it.
    expect(at.at(-1)).toBe(start.last_new + FOLLOW.quiet);
    expect(row()).toMatchObject({ stopped: start.last_new + FOLLOW.quiet, why: 'quiet', next_at: null });
    expect(store.conversationView(cid)!.follow).toMatchObject({ stopped: start.last_new + FOLLOW.quiet, why: 'quiet', next: null });
    // Nothing more is read.
    const n = reads();
    await clock.advance(DAY);
    expect(reads()).toBe(n);
  });

  test('following again starts over; a check due while the account is offline waits for it', async () => {
    const f = await follows.follow('x', post);
    expect(f).toMatchObject({ stopped: null, since: clock.now(), next: clock.now() + FOLLOW.first });
    const n = reads();
    online = false;
    await clock.advance(FOLLOW.first + 10 * MIN);
    expect(reads()).toBe(n);
    expect(row().checked_at).toBe(f.since);
    online = true;
    await clock.until(() => reads() > n, 2 * MIN, 'the check once online');
    expect(row().checked_at).toBeGreaterThan(f.since + FOLLOW.first);
  });

  test('unfollowing stops the checks and keeps the chat; a reply after that stays out of it', async () => {
    const f = follows.unfollow('x', post);
    expect(f).toMatchObject({ why: 'unfollowed', next: null });
    expect(f.stopped).toBe(clock.now());
    expect(store.conversationView(cid)).toMatchObject({ variant: 'follow' });
    const later = await w.newReply(post);
    await posts.reread('x', post, acc.id, true);
    expect(where(later)).toBe(POSTS);
    const n = reads();
    await clock.advance(DAY);
    expect(reads()).toBe(n);
  });

  test('nothing goes to X from the chat', () => {
    expect(sent.filter((c) => c.t === 'markRead' || c.t === 'send' || c.t === 'react')).toEqual([]);
  });
});

describe('the routes', () => {
  const w = world();
  const { store, acc } = w;
  let hub: HubServer;
  let port = 0;
  const req = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  const put = (path: string) => req(path, { method: 'PUT' });
  beforeAll(() => {
    const sup = { authorize: () => null, online: () => true, command: (_: string, c: object) => w.command(c) } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: w.dir, webDist: w.dir, open: true, secret: 's' });
    port = hub.start().port!;
  });
  afterAll(() => {
    hub.stop();
    store.db.close();
  });

  test('PUT follows, GET says which replies are new until the chat is read, DELETE stops; the thread carries it', async () => {
    const post = w.routing();
    expect((await req(`/api/posts/x/${post}/follow`)).status).toBe(404);
    const res = await put(`/api/posts/x/${post}/follow`);
    expect(res.status).toBe(200);
    const f = (await res.json()) as P.PostFollow;
    expect(f).toMatchObject({ accountId: acc.id, stopped: null });
    const t = (await (await req(`/api/posts/x/${post}/thread`)).json()) as P.PostThreadView;
    expect(t.follow).toMatchObject({ conversationId: f.conversationId, stopped: null });
    // A reply a check found (a live read): new until the chat is read.
    const r = await w.newReply(post);
    await hub.posts.reread('x', post, acc.id, true);
    expect(((await (await req(`/api/posts/x/${post}/follow`)).json()) as P.PostFollow).fresh).toEqual([r]);
    expect((await req(`/api/conversations/${f.conversationId}/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
    expect(((await (await req(`/api/posts/x/${post}/follow`)).json()) as P.PostFollow).fresh).toEqual([]);
    const gone = (await (await req(`/api/posts/x/${post}/follow`, { method: 'DELETE' })).json()) as P.PostFollow;
    expect(gone).toMatchObject({ why: 'unfollowed', next: null });
    expect(((await (await req(`/api/posts/x/${post}/thread`)).json()) as P.PostThreadView).follow).toMatchObject({ why: 'unfollowed' });
  });

  test('a bad network or post is refused; the chat takes no message and nothing is sent to X', async () => {
    expect((await put('/api/posts/nowhere/1/follow')).status).toBe(404);
    expect((await req('/api/posts/x/1/follow', { method: 'DELETE' })).status).toBe(404);
    expect((await put('/api/posts/x/1/follow')).status).toBe(502);
    const cid = hubId('cnv', 'x', followNativeId(w.routing()));
    const send = await req(`/api/conversations/${cid}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hi' }) });
    expect(send.status).toBe(409);
    expect(w.sent.filter((c) => c.t === 'send' || c.t === 'markRead')).toEqual([]);
  });
});
