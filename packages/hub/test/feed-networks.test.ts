/**
 * The Feed with Mastodon, Reddit, Lemmy and Substack (docs/feed.md "A feed of posts, for any network"), through the
 * demo world's four accounts (demo-posts.ts): their timelines in Following and Discover with titles, places and a
 * content warning; threads with comment trees read by their own ids (Reddit's t1_…, Lemmy's comment:…), a branch
 * deeper than six levels opened as a thread of its own; like and repost where each network has them; a new Reddit or
 * Lemmy post refused without its title and place, posted with them; Mastodon's content warning; the notifications in
 * each network's words; the feed read-only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEMO_POST_ACCOUNTS, DemoPosts } from '../src/demo-posts.ts';
import { feedRefusalFor } from '../src/feed.ts';
import { Posts } from '../src/posts.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Timelines } from '../src/timelines.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-feednets-'));
let store: Store;
const adapters = new Map<string, DemoPosts>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const sent: { accountId: string; cmd: Record<string, any> }[] = [];
const ACC = Object.fromEntries(DEMO_POST_ACCOUNTS.map((a) => [a.network, a.id])) as Record<'mastodon' | 'reddit' | 'lemmy' | 'substack', string>;

function command<T>(accountId: string, cmd: object): Promise<T> {
  const id = crypto.randomUUID();
  sent.push({ accountId, cmd });
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    adapters.get(accountId)!.command({ ...cmd, id } as P.AdapterCommand);
  });
}
let posts: Posts;
let tl: Timelines;

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  for (const meta of DEMO_POST_ACCOUNTS) {
    const acc = store.createAccount({ ...meta, adapter: 'demo', demo: true, config: { epoch: Date.now() } });
    const adir = join(dir, acc.id);
    mkdirSync(adir, { recursive: true });
    const a = new DemoPosts(acc, adir);
    adapters.set(acc.id, a);
    store.db.transaction(() =>
      a.start((ev) => {
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
  }
  store.flush();
  posts = new Posts({ store, online: () => true, command });
  tl = new Timelines({ store, posts, online: () => true, command });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sources and timelines', () => {
  test('each account reads timelines, posts and has its notifications conversation', () => {
    const v = tl.sources();
    expect(v.accounts.map((a) => a.network)).toEqual(['mastodon', 'reddit', 'lemmy', 'substack']);
    for (const a of v.accounts) expect(a).toMatchObject({ online: true, home: true, publish: true, unpublish: true });
    expect(v.accounts.every((a) => !!a.feedConvId)).toBe(true);
  });

  test("Following takes every account's: Reddit's titles and subreddits, Lemmy's communities, Mastodon's warning and boost, Substack's publication", async () => {
    const v = await tl.read('following');
    const by = (n: string) => v.entries.filter((e) => e.network === n).map((e) => e.post);
    expect(by('reddit').every((p) => p.title && p.place?.name.startsWith('r/'))).toBe(true);
    expect(by('lemmy').every((p) => p.place?.name.startsWith('!'))).toBe(true);
    expect(by('mastodon').some((p) => p.warning?.startsWith('Spoilers'))).toBe(true);
    expect(by('mastodon').some((p) => p.repostOf)).toBe(true);
    expect(by('substack').some((p) => p.title === 'Why maps lie, gently' && p.place?.name === 'The Slow Graph')).toBe(true);
    // Discover is each account's For you, its reasons kept.
    const d = await tl.read('discover');
    expect(d.entries.some((e) => e.network === 'reddit' && e.reason?.text.startsWith('Popular in r/'))).toBe(true);
  });
});

describe('threads', () => {
  test("a Reddit post's comment tree, past six levels deep, and a deep comment opened by its own id", async () => {
    const greedy = (await tl.read(`${ACC.reddit}:following`)).entries.find((e) => e.post.title?.startsWith('Greedy'))!.post;
    const t = await posts.thread('reddit', greedy.id);
    expect(t.focal?.title).toStartWith('Greedy routing');
    expect(Math.max(...t.replies.map((c) => c.length))).toBeGreaterThan(6);
    const deep = t.replies.flat().find((p) => p.text.startsWith('Level 8'))!;
    expect(deep.id).toMatch(/^t1_/);
    const sub = await posts.thread('reddit', deep.id);
    expect(sub.focal?.id).toBe(deep.id);
    expect(sub.ancestors[0]?.id).toBe(greedy.id);
    expect(sub.ancestors.length).toBe(8);
    expect(sub.replies.flat().length).toBeGreaterThan(0);
  });

  test("Lemmy's comment:… ids, and a Mastodon reply behind its own content warning", async () => {
    const t = await posts.thread('lemmy', 'comment:9002');
    expect(t.ancestors.map((p) => p.id)).toEqual(['post:101', 'comment:9001']);
    const mine = (await tl.read(`${ACC.mastodon}:following`)).entries.find((e) => e.post.text.startsWith('Trying out'))!.post;
    const m = await posts.thread('mastodon', mine.id);
    expect(m.replies.flat().some((p) => p.warning === 'Bright light, flashing water')).toBe(true);
  });
});

describe('answering', () => {
  test('like everywhere; repost on Mastodon and Substack, refused on Reddit and Lemmy before anything is sent', async () => {
    const first = (n: string) => tl.entries(`${ACC[n as 'reddit']}:following`).entries[0]!.post;
    for (const n of ['mastodon', 'reddit', 'lemmy', 'substack'] as const) expect((await posts.act(n, first(n).id, 'like')).viewer.liked).toBe(true);
    expect((await posts.act('mastodon', first('mastodon').id, 'repost')).viewer.reposted).toBe(true);
    expect((await posts.act('substack', first('substack').id, 'repost')).viewer.reposted).toBe(true);
    const before = sent.length;
    await expect(posts.act('reddit', first('reddit').id, 'repost')).rejects.toMatchObject({ status: 409 });
    await expect(posts.act('lemmy', first('lemmy').id, 'repost')).rejects.toMatchObject({ status: 409 });
    expect(sent.length).toBe(before);
  });

  test('a new Reddit post needs a title and a subreddit; Lemmy a community; a comment takes neither', async () => {
    await expect(posts.publish('reddit', { text: 'body', key: 'r1' })).rejects.toMatchObject({ status: 422, message: 'A post on Reddit needs a title.' });
    await expect(posts.publish('reddit', { text: 'body', title: 'T', key: 'r2' })).rejects.toMatchObject({ status: 422 });
    await expect(posts.publish('reddit', { text: '', title: 'T', place: 'r/not a name', key: 'r3' })).rejects.toMatchObject({ status: 422 });
    const p = await posts.publish('reddit', { text: '', title: 'Title only', place: 'r/graphtheory', key: 'r4' });
    expect(p).toMatchObject({ title: 'Title only', place: { name: 'r/graphtheory' } });
    const l = await posts.publish('lemmy', { text: 'Bring seeds.', title: 'Seed swap', place: '!gardening@lemmy.example', key: 'l1' });
    expect(l.place?.name).toBe('!gardening@lemmy.example');
    const sentPublish = sent.filter((s) => s.cmd.t === 'publish' && s.accountId === ACC.lemmy).at(-1)!.cmd;
    expect(sentPublish).toMatchObject({ title: 'Seed swap', place: 'gardening@lemmy.example' });
    await expect(posts.publish('reddit', { text: 'a comment', title: 'no', replyTo: 't3_nflu', key: 'r5' })).rejects.toMatchObject({ status: 422 });
    expect((await posts.publish('reddit', { text: 'a comment', replyTo: p.id, key: 'r6' })).replyTo?.id).toBe(p.id);
  });

  test("Mastodon's content warning goes with the post; X-style limits by each network's count", async () => {
    const m = await posts.publish('mastodon', { text: 'The finale, discussed.', warning: 'Spoilers', key: 'm1' });
    expect(m.warning).toBe('Spoilers');
    await expect(posts.publish('substack', { text: 'note', warning: 'cw', key: 's1' })).rejects.toMatchObject({ status: 422 });
    await expect(posts.publish('mastodon', { text: 'a'.repeat(501), key: 'm2' })).rejects.toMatchObject({ status: 422 });
    expect((await posts.publish('mastodon', { text: `${'a'.repeat(470)} https://example.com/${'b'.repeat(200)}`, key: 'm3' })).id).toBeTruthy();
  });

  test('one press to every account: who can reply goes only where the network has it, a title and place to Reddit alone', async () => {
    const v = await tl.publish({
      key: 'press-1',
      replies: 'following',
      destinations: [
        { accountId: ACC.mastodon, text: 'Hello from one press' },
        { accountId: ACC.reddit, text: 'Hello from one press', title: 'One press', place: 'graphtheory' },
        { accountId: ACC.substack, text: 'Hello from one press' },
      ],
    });
    expect(v.results.map((r) => r.ok)).toEqual([true, true, true]);
    const cmds = sent.filter((s) => s.cmd.t === 'publish' && s.cmd.text === 'Hello from one press').map((s) => s.cmd);
    expect(cmds.every((c) => c.replies === undefined)).toBe(true);
    expect(cmds.filter((c) => c.title)).toEqual([expect.objectContaining({ title: 'One press', place: 'graphtheory' })]);
  });

  test('who favourited a Mastodon post is named; Reddit names nobody', async () => {
    const mine = tl.entries(`${ACC.mastodon}:following`).entries.find((e) => e.post.text.startsWith('Trying out'))!.post;
    const r = await posts.reactors('mastodon', mine.id, 'like');
    expect(r.people.length).toBe(2);
    const greedy = tl.entries(`${ACC.reddit}:following`).entries.find((e) => e.post.title?.startsWith('Greedy'))!.post;
    expect((await posts.reactors('reddit', greedy.id, 'like')).note).toStartWith('Reddit does not say who liked a post.');
  });
});

describe('notifications', () => {
  test("each account's feed carries its items, in the network's own words, and is read-only", () => {
    for (const [net, id] of Object.entries(ACC)) {
      const conv = tl.sources().accounts.find((a) => a.accountId === id)!.feedConvId!;
      const msgs = store.db.query("SELECT body, extra FROM message WHERE conversation_id = ? ORDER BY ts").all(conv) as { body: string; extra: string }[];
      expect(msgs.length).toBeGreaterThan(0);
      expect(msgs.every((m) => JSON.parse(m.extra).feed?.type)).toBe(true);
      if (net === 'mastodon') expect(msgs.map((m) => m.body)).toContain('boosted your post');
      expect(feedRefusalFor(store.db, conv)).toContain(`notifications are read-only here`);
    }
  });
});
