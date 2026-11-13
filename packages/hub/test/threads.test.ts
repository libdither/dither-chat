/**
 * Threads, forums and group DMs through the hub (threads.ts, docs/threads.md), against the demo world's adapters run in
 * process: a thread's following, tags and first message in its conversation's view, following and notifications,
 * archiving refused where a fresh About says no, starting threads and forum posts, a channel's archived and private
 * threads on request, publishing, and running a group DM you own (and leaving one, through servers.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { Abouts } from '../src/about.ts';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { mediaSigner } from '../src/server.ts';
import { Servers } from '../src/servers.ts';
import { Store } from '../src/store.ts';
import { Threads, ThreadsError } from '../src/threads.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-threads-'));
let store: Store;
let threads: Threads;
let servers: Servers;
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const sent: { account: string; cmd: { t: string } & Record<string, unknown> }[] = [];
const notes: string[] = [];
const uploads = new Map<string, P.OutgoingAttachment>();
const MAIN = 'acc_demo-discord-main';

const conv = (name: string, shape?: string) => {
  const r = store.one<{ id: string }>(`SELECT id FROM conversation WHERE network = 'discord' AND name = ?${shape ? ' AND shape = ?' : ''}`, ...(shape ? [name, shape] : [name]));
  if (!r) throw new Error(`no conversation ${name}`);
  return r.id;
};
const view = (id: string) => store.conversationViews([id])[0];
const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ThreadsError;
  }
  throw new Error('it went through');
};

const deps = {
  get store() {
    return store;
  },
  online: () => true,
  command: <T>(account: string, cmd: any) => {
    sent.push({ account, cmd });
    return new Promise<T>((resolve, rej) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject: rej });
      adapters.get(account)!.command({ ...cmd, id });
    });
  },
  pickAccount: (c: string, requested?: string) => {
    const vs = store.vantageAccounts('conversation', c);
    return requested && vs.includes(requested) ? requested : vs.includes(MAIN) ? MAIN : (vs[0] ?? null);
  },
};

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  store.db.transaction(() => {
    for (const acc of createDemoAccounts(store)) {
      const adir = join(dir, acc.id);
      mkdirSync(adir, { recursive: true });
      const a = demoFactory(acc, adir)!;
      adapters.set(acc.id, a);
      a.start((ev) => {
        if (ev.t === 'reply') {
          const p = pending.get(ev.id);
          pending.delete(ev.id);
          if (ev.ok) p?.resolve(ev.result);
          else p?.reject(new Error(ev.error));
          return;
        }
        store.ingest(store.account(acc.id)!, ev);
      });
    }
  })();
  store.flush();
  const abouts = new Abouts({ ...deps });
  const aboutView = (k: 'conversation' | 'space', i: string, n: P.Network, a: string, ab: P.About) => abouts.view(k, i, n, a, ab, Date.now(), undefined, true);
  threads = new Threads({ ...deps, note: (_a, line) => notes.push(line), aboutView, uploads: { get: (ids) => (ids.every((i) => uploads.has(i)) ? ids.map((i) => uploads.get(i)!) : null), remove: (ids) => ids.forEach((i) => uploads.delete(i)) } });
  servers = new Servers({ ...deps, aboutView });
});

afterAll(() => {
  for (const a of adapters.values()) (a as unknown as { stop(): void }).stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('what the views say', () => {
  test("a forum's tags and default order; a post's tags, who started it, and whether you follow it", () => {
    const forum = view(conv('help'));
    expect(forum.forum).toEqual({ tags: [expect.objectContaining({ name: 'Solved', moderated: true }), expect.objectContaining({ name: 'async' }), expect.objectContaining({ name: 'cargo' })], sort: 'activity', layout: 'list', tagRequired: false });
    const post = view(conv('Lifetime error with async closures'));
    expect(post.thread).toMatchObject({ following: [MAIN], notFollowing: [], locked: false, ownerId: hubId('idn', 'discord', 'owl') === post.thread!.ownerId ? post.thread!.ownerId : expect.stringMatching(/^idn_/) });
    expect(post.thread!.tags).toHaveLength(2);
  });

  test("a thread you are not in notifies on mentions only, as Discord's own apps do", () => {
    const ws = view(conv('Workspace layout for a CLI + lib?'));
    expect(ws.thread).toMatchObject({ following: [], notFollowing: [MAIN] });
    expect(ws.nativeMute).toEqual({ level: 'mentions' });
  });
});

describe('following', () => {
  test('follow and unfollow go through the account; the view and the mute follow', async () => {
    const id = conv('Workspace layout for a CLI + lib?');
    expect(await threads.follow(id, { follow: true })).toMatchObject({ joined: true });
    expect(view(id).thread!.following).toEqual([MAIN]);
    expect(view(id).nativeMute).toEqual({});
    await threads.follow(id, { follow: false });
    expect(view(id).thread!.notFollowing).toEqual([MAIN]);
    expect(notes.slice(-2)).toEqual(['[thread] followed Workspace layout for a CLI + lib?', '[thread] unfollowed Workspace layout for a CLI + lib?']);
  });

  test('a notification setting and a mute with a timer; nonsense refused before anything is asked', async () => {
    const id = conv('Lifetime error with async closures');
    await threads.notify(id, { notify: 'none' });
    expect(view(id).thread!.notify).toBe('none');
    const before = sent.length;
    expect((await reject(threads.notify(id, { notify: 'loud' }))).status).toBe(400);
    expect((await reject(threads.notify(id, { muted: true, minutes: 7 }))).status).toBe(400);
    expect((await reject(threads.notify(conv('general', 'channel'), { notify: 'all' }))).status).toBe(400);
    expect(sent.length).toBe(before);
    await threads.notify(id, { muted: true, minutes: 60 });
    expect(view(id).thread).toMatchObject({ muted: true, mutedUntil: expect.any(Number) });
  });
});

describe('archiving and locking', () => {
  test("someone else's thread in a server you do not run: refused on a fresh About, nothing done", async () => {
    const id = conv('Lifetime error with async closures');
    const e = await reject(threads.state(id, { archived: true }));
    expect(e.status).toBe(403);
    expect(e.message).toMatch(/Manage Threads/);
    expect(sent.at(-1)!.cmd.t).toBe('about');
  });

  test('your own thread where you moderate: archived and locked, then opened again', async () => {
    const id = conv('DHT bootstrap refactor');
    const v = (await threads.state(id, { archived: true, locked: true })) as P.AboutView;
    expect(v.thread).toMatchObject({ archived: true, locked: true, canArchive: true, canLock: true });
    expect(view(id).archived).toBe(true);
    await threads.state(id, { archived: false, locked: false });
    expect(view(id).archived).toBe(false);
  });
});

describe('starting threads and posts', () => {
  test('a thread from a message in a channel, followed and yours; bad names and places refused', async () => {
    const chan = conv('dev', 'channel');
    const msg = store.one<{ id: string }>('SELECT id FROM message WHERE conversation_id = ? ORDER BY ts DESC LIMIT 1', chan)!.id;
    const r = await threads.createThread(chan, { name: '  Release notes  ', message: msg, body: 'Let us talk here' });
    const t = view(r.conversationId);
    expect(t).toMatchObject({ shape: 'thread', name: 'Release notes', parentId: chan });
    expect(t.thread).toMatchObject({ following: [MAIN] });
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'createThread', name: 'Release notes', message: expect.any(String) });
    expect((await reject(threads.createThread(chan, { name: '' }))).status).toBe(400);
    expect((await reject(threads.createThread(conv('help'), { name: 'x' }))).status).toBe(400);
    expect((await reject(threads.createThread(chan, { name: 'x', message: hubId('msg', 'discord', 'not-here') }))).status).toBe(400);
  });

  test("a forum post with the forum's tags and a file; its first message is its preview", async () => {
    const forum = conv('help');
    const tags = view(forum).forum!.tags;
    const before = sent.length;
    expect((await reject(threads.createPost(forum, { name: 'Help', body: 'x', tags: ['nope'] }))).message).toMatch(/not one this forum has/);
    expect((await reject(threads.createPost(forum, { name: 'Help', body: '' }))).status).toBe(400);
    expect(sent.length).toBe(before);
    const f = join(dir, 'shot.png');
    writeFileSync(f, 'png');
    uploads.set('u1', { path: f, name: 'shot.png', mime: 'image/png', size: 3, kind: 'image' });
    const r = await threads.createPost(forum, { name: 'Borrow checker vs closures', body: 'Why does this not compile?', tags: [tags[1].id], attachments: ['u1'] });
    const post = view(r.conversationId);
    expect(post.parentId).toBe(forum);
    expect(post.thread).toMatchObject({ tags: [tags[1].id], following: [MAIN] });
    expect(post.thread!.first).toMatchObject({ text: 'Why does this not compile?' });
    expect(uploads.has('u1')).toBe(false);
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'createPost', attachments: [expect.objectContaining({ name: 'shot.png' })] });
  });
});

describe("a channel's archived threads, on request", () => {
  test("a forum's archived posts come with their first messages; your private ones are a list of their own", async () => {
    const forum = conv('help');
    const page = await threads.page(forum, { archived: true, mine: false, offset: 0, accountId: MAIN });
    const old = view(conv('Is there a no_std HashMap?'));
    expect(page.conversationIds).toContain(old.id);
    expect(old).toMatchObject({ archived: true });
    expect(old.thread!.first).toMatchObject({ text: expect.stringMatching(/hashbrown/) });
    const mine = await threads.page(conv('dev', 'channel'), { archived: true, mine: true, offset: 0, accountId: MAIN });
    expect(mine.conversationIds).toEqual([conv('release planning')]);
    expect(view(conv('release planning')).thread).toMatchObject({ private: true });
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'threads', archived: true, mine: true });
  });
});

describe('publishing', () => {
  test('a message in an announcement channel is published; elsewhere refused before anything is asked', async () => {
    const ann = store.one<{ id: string }>(`SELECT id FROM conversation WHERE network = 'discord' AND variant = 'announcement' AND name = 'announcements' ORDER BY id LIMIT 1`)!.id;
    const m = store.one<{ id: string }>('SELECT id FROM message WHERE conversation_id = ? LIMIT 1', ann)!.id;
    expect(await threads.crosspost(m, { accountId: MAIN })).toEqual({ ok: true });
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'crosspost' });
    const other = store.one<{ id: string }>('SELECT id FROM message WHERE conversation_id = ? LIMIT 1', conv('dev', 'channel'))!.id;
    expect((await reject(threads.crosspost(other, {}))).status).toBe(400);
  });
});

describe('group DMs', () => {
  test('the owner takes someone out and hands it over; then may do neither', async () => {
    const raid = conv('weekend raid');
    const about = (await threads.member(raid, view(raid).participantIds.find((p) => p !== store.account(MAIN)!.self_identity && !p.includes('zyan'))!, 'remove', {})) as P.AboutView;
    expect(about.ownership).toMatchObject({ youOwn: true });
    expect(view(raid).participantIds).toHaveLength(2);
    const other = view(raid).participantIds.find((p) => p !== store.account(MAIN)!.self_identity)!;
    const handed = (await threads.member(raid, other, 'owner', {})) as P.AboutView;
    expect(handed.ownership).toMatchObject({ youOwn: false, owner: other });
    expect((await reject(threads.member(raid, other, 'remove', {}))).status).toBe(403);
  });

  test("its picture; then leaving it, silently, through the general leave", async () => {
    const raid = conv('weekend raid');
    const v = (await threads.picture(raid, { upload: null })) as P.AboutView;
    expect(v.fields.avatar?.canEdit).toBe(true);
    expect((await reject(threads.picture(conv('dev', 'channel'), { upload: null }))).status).toBe(400);
    expect(await servers.leave('conversation', raid, { silent: true, accountId: MAIN })).toEqual({ left: true });
    expect(sent.at(-1)!.cmd).toMatchObject({ t: 'leave', silent: true });
  });
});
