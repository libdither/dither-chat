/**
 * The Feed with Mastodon, Reddit, Lemmy, Substack, Bluesky and LessWrong (docs/feed.md "A feed of posts, for any
 * network"), through the demo world's six accounts (demo-posts.ts): their timelines in Following and Discover with titles, places and a
 * content warning; threads with comment trees read by their own ids (Reddit's t1_…, Lemmy's comment:…), a branch
 * deeper than six levels opened as a thread of its own; like and repost where each network has them; a new Reddit or
 * Lemmy post refused without its title and place, posted with them; Mastodon's content warning; the notifications in
 * each network's words; Bluesky's `<did>~<rkey>` ids, its 300 graphemes and quote posts; LessWrong's `p-` and `c-` ids,
 * its articles only in their threads, karma as the like, comments only and no repost; the feed read-only.
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
const ACC = Object.fromEntries(DEMO_POST_ACCOUNTS.map((a) => [a.network, a.id])) as Record<'mastodon' | 'reddit' | 'lemmy' | 'substack' | 'bluesky' | 'lesswrong', string>;

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
    expect(v.accounts.map((a) => a.network)).toEqual(['mastodon', 'reddit', 'lemmy', 'substack', 'bluesky', 'lesswrong']);
    // LessWrong deletes a comment of yours while nothing answers it (dither-accounts' lesswrong kind), so it can too.
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
    expect(by('bluesky').some((p) => p.quoteOf?.media?.length)).toBe(true);
    expect(by('bluesky').some((p) => p.repostOf)).toBe(true);
    expect(by('bluesky').every((p) => !p.title && !p.place && !p.warning)).toBe(true);
    expect(by('lesswrong').length).toBeGreaterThan(0);
    expect(by('lesswrong').every((p) => p.title && !p.place && p.counts?.reposts === undefined)).toBe(true);
    // A card has the short text; the whole article comes only with the post's thread.
    expect(v.entries.every((e) => e.post.article === undefined)).toBe(true);
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
    for (const n of ['mastodon', 'reddit', 'lemmy', 'substack', 'bluesky'] as const) expect((await posts.act(n, first(n).id, 'like')).viewer.liked).toBe(true);
    expect((await posts.act('mastodon', first('mastodon').id, 'repost')).viewer.reposted).toBe(true);
    expect((await posts.act('substack', first('substack').id, 'repost')).viewer.reposted).toBe(true);
    expect((await posts.act('bluesky', first('bluesky').id, 'repost')).viewer.reposted).toBe(true);
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

describe('Bluesky', () => {
  const mineOf = () => tl.entries(`${ACC.bluesky}:following`).entries.find((e) => e.post.text.startsWith('Trying Bluesky'))!.post;

  test('a post id is `<did>~<rkey>`; its thread is read by it, and a reply opened by its own id', async () => {
    const mine = mineOf();
    expect(mine.id).toMatch(/^did:plc:[a-z0-9]{24}~[a-z0-9]{13}$/);
    expect(mine.url).toMatch(/^https:\/\/bsky\.app\/profile\/zyan\.example\/post\/[a-z0-9]{13}$/);
    const t = await posts.thread('bluesky', mine.id);
    expect(t.focal?.id).toBe(mine.id);
    const deep = t.replies.flat().find((p) => p.text.startsWith('Yes please'))!;
    const sub = await posts.thread('bluesky', deep.id);
    expect(sub.ancestors.map((p) => p.id)).toEqual([mine.id, t.replies.flat().find((p) => p.text.startsWith('Welcome'))!.id]);
  });

  test('300 graphemes, an emoji one; no title, place or content warning; a reply and a quote post go to it', async () => {
    const mine = mineOf();
    await expect(posts.publish('bluesky', { text: 'a'.repeat(301), key: 'b1' })).rejects.toMatchObject({ status: 422, message: "Too long: 1 over Bluesky's 300." });
    expect((await posts.publish('bluesky', { text: '👨‍👩‍👧'.repeat(300), key: 'b2' })).id).toMatch(/~/);
    for (const [k, f] of [['b3', { warning: 'cw' }], ['b4', { title: 'T' }], ['b5', { place: 'somewhere' }]] as const) await expect(posts.publish('bluesky', { text: 'hi', key: k, ...f })).rejects.toMatchObject({ status: 422 });
    expect((await posts.publish('bluesky', { text: 'A reply.', replyTo: mine.id, key: 'b6' })).replyTo?.id).toBe(mine.id);
    const q = await posts.publish('bluesky', { text: 'Quoting myself.', quote: mine.id, key: 'b7' });
    expect(q.quoteOf?.id).toBe(mine.id);
    expect(sent.filter((s) => s.accountId === ACC.bluesky && s.cmd.t === 'publish').at(-1)!.cmd).toMatchObject({ quote: mine.id });
  });

  test('who liked and reposted is named; a quote post arrives as a notification', async () => {
    const mine = mineOf();
    expect((await posts.reactors('bluesky', mine.id, 'like')).people.length).toBe(1);
    expect((await posts.reactors('bluesky', mine.id, 'repost')).people.length).toBe(1);
    const conv = tl.sources().accounts.find((a) => a.accountId === ACC.bluesky)!.feedConvId!;
    const types = (store.db.query('SELECT extra FROM message WHERE conversation_id = ?').all(conv) as { extra: string }[]).map((m) => JSON.parse(m.extra).feed.type);
    expect(types.sort()).toEqual(['follow', 'like', 'quote', 'reply', 'repost']);
  });
});

describe('LessWrong', () => {
  const calibOf = () => tl.entries(`${ACC.lesswrong}:following`).entries.find((e) => e.post.title === 'Notes on calibrating small predictions')!.post;

  test('posts are `p-…`, comments `c-…`; a post\'s whole article comes in its thread, not on its card; karma and comments as counts', async () => {
    const calib = calibOf();
    expect(calib.id).toMatch(/^p-[A-Za-z0-9]{17}$/);
    expect(calib.url).toStartWith('https://www.lesswrong.com/posts/');
    expect(calib.article).toBeUndefined();
    expect(calib.counts).toMatchObject({ likes: 87, replies: 4 });
    const t = await posts.thread('lesswrong', calib.id);
    expect(t.focal?.article).toContain('## What I did');
    expect(t.focal?.article).toStartWith(calib.text);
    expect(t.focal?.text).toBe(calib.text);
    const comments = t.replies.flat();
    expect(comments.length).toBe(4);
    expect(comments.every((c) => /^c-[A-Za-z0-9]{17}$/.test(c.id) && !c.article)).toBe(true);
    // A comment opened by its own id: the post and the comment it answers above it.
    const deep = comments.find((c) => c.text.startsWith('The tail is'))!;
    const sub = await posts.thread('lesswrong', deep.id);
    expect(sub.ancestors.map((p) => p.id)).toEqual([calib.id, comments.find((c) => c.text.startsWith('I tried the same'))!.id]);
    expect(sub.focal?.article).toBeUndefined();
    // The card stays short after its thread was read.
    expect(tl.entries(`${ACC.lesswrong}:following`).entries.find((e) => e.post.id === calib.id)!.post.article).toBeUndefined();
  });

  test('a like is an upvote and takes back; a repost is refused before anything is sent', async () => {
    const calib = calibOf();
    const up = await posts.act('lesswrong', calib.id, 'like');
    expect(up.viewer.liked).toBe(true);
    expect((await posts.act('lesswrong', calib.id, 'unlike')).viewer.liked).toBe(false);
    const before = sent.length;
    await expect(posts.act('lesswrong', calib.id, 'repost')).rejects.toMatchObject({ status: 409 });
    expect(sent.length).toBe(before);
  });

  test('only comments: no new post (409, nothing sent), a comment on a post and on a comment, 100,000 characters, no pictures', async () => {
    const calib = calibOf();
    const before = sent.length;
    await expect(posts.publish('lesswrong', { text: 'A new post', key: 'w1' })).rejects.toMatchObject({ status: 409, message: 'LessWrong takes only comments from here: answer a post or a comment.' });
    await expect(posts.publish('lesswrong', { text: 'A new post', title: 'Title', key: 'w1b' })).rejects.toMatchObject({ status: 409 });
    expect(sent.length).toBe(before);
    const c = await posts.publish('lesswrong', { text: 'A **comment**, in Markdown.', replyTo: calib.id, key: 'w2' });
    expect(c.id).toMatch(/^c-/);
    expect(c.replyTo?.id).toBe(calib.id);
    const under = (await posts.thread('lesswrong', calib.id)).replies.flat().find((p) => p.text.startsWith('Brier'))!;
    expect((await posts.publish('lesswrong', { text: 'A reply to a comment.', replyTo: under.id, key: 'w3' })).root).toBe(calib.id);
    expect((await posts.publish('lesswrong', { text: 'a'.repeat(100_000), replyTo: calib.id, key: 'w4' })).id).toMatch(/^c-/);
    await expect(posts.publish('lesswrong', { text: 'a'.repeat(100_001), replyTo: calib.id, key: 'w5' })).rejects.toMatchObject({ status: 422, message: "Too long: 1 over LessWrong's 100000." });
    await expect(posts.publish('lesswrong', { text: 'with a picture', replyTo: calib.id, key: 'w6', media: [{ kind: 'image', mime: 'image/png', path: 'nowhere.png', name: 'p.png', size: 10 }] })).rejects.toMatchObject({ status: 422, message: 'LessWrong takes words only here: no pictures or videos.' });
    await expect(posts.publish('lesswrong', { text: 'cw', warning: 'cw', replyTo: calib.id, key: 'w7' })).rejects.toMatchObject({ status: 422 });
  });

  test('one press to every account leaves LessWrong out with its reason, the others posted', async () => {
    const v = await tl.publish({ key: 'press-lw', destinations: [{ accountId: ACC.mastodon, text: 'Hello again' }, { accountId: ACC.lesswrong, text: 'Hello again' }] });
    expect(v.results.map((r) => r.ok)).toEqual([true, false]);
    expect(v.results[1]!.error).toContain('only comments');
    expect(sent.some((s) => s.accountId === ACC.lesswrong && s.cmd.t === 'publish' && s.cmd.text === 'Hello again')).toBe(false);
  });

  test('a Substack essay brings its whole article in its thread too', async () => {
    const essay = tl.entries(`${ACC.substack}:following`).entries.find((e) => e.post.title === 'Why maps lie, gently')!.post;
    expect(essay.article).toBeUndefined();
    expect((await posts.thread('substack', essay.id)).focal?.article).toContain('## Three projections');
  });

  test('replies arrive as notifications in LessWrong\'s feed', () => {
    const conv = tl.sources().accounts.find((a) => a.accountId === ACC.lesswrong)!.feedConvId!;
    const types = (store.db.query('SELECT extra FROM message WHERE conversation_id = ?').all(conv) as { extra: string }[]).map((m) => JSON.parse(m.extra).feed.type);
    expect(types.sort()).toEqual(['follow', 'reply']);
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
