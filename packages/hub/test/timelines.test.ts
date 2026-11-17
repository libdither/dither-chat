/**
 * The Feed page's posts (docs/feed.md "The Feed page", packages/hub/src/timelines.ts) with the demo's two X accounts:
 * home timelines read when looked at and kept in order, Home merging both accounts' Following with a post both follow
 * once, For you keeping X's reasons and order, older pages by cursor; one press of Post to both accounts, a thread's
 * parts as replies, the same press twice posted once; Your posts grouping a cross-post, a delete leaving the other
 * copy; drafts kept and scheduled ones posted at their time, or held when their account was not connected.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEMO_X2_ACCOUNT, DEMO_X_ACCOUNT, DemoX } from '../src/demo-x.ts';
import { Posts } from '../src/posts.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Timelines } from '../src/timelines.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-timelines-'));
let store: Store;
const adapters = new Map<string, DemoX>();
const offline = new Set<string>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const sent: { accountId: string; cmd: Record<string, any> }[] = [];
const X1 = DEMO_X_ACCOUNT.id;
const X2 = DEMO_X2_ACCOUNT.id;

function command<T>(accountId: string, cmd: object): Promise<T> {
  const id = crypto.randomUUID();
  sent.push({ accountId, cmd });
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    adapters.get(accountId)!.command({ ...cmd, id } as P.AdapterCommand);
  });
}
const online = (a: string) => !offline.has(a);
let posts: Posts;
let tl: Timelines;
const asked = (accountId: string, t: string) => sent.filter((s) => s.accountId === accountId && s.cmd.t === t);

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  for (const meta of [DEMO_X_ACCOUNT, DEMO_X2_ACCOUNT]) {
    const acc = store.createAccount({ ...meta, adapter: 'demo', demo: true, config: { epoch: Date.now() } });
    const adir = join(dir, acc.id);
    mkdirSync(adir, { recursive: true });
    const a = new DemoX(acc, adir);
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
  posts = new Posts({ store, online, command });
  tl = new Timelines({ store, posts, online, command });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sources', () => {
  test('each X account: it reads timelines, posts, posts pictures, deletes, and has its notifications conversation', () => {
    const v = tl.sources();
    expect(v.accounts.map((a) => a.accountId)).toEqual([X1, X2]);
    for (const a of v.accounts) expect(a).toMatchObject({ network: 'x', online: true, home: true, publish: true, media: true, unpublish: true });
    expect(v.accounts.every((a) => !!a.feedConvId)).toBe(true);
    expect(v.accounts[0].feedConvId).not.toBe(v.accounts[1].feedConvId);
    expect(v.drafts).toBe(0);
  });
  test('a source the hub does not know is refused', () => {
    expect(() => tl.entries('somewhere')).toThrow(/source/);
  });
});

describe('home timelines', () => {
  test('nothing is read until a timeline is looked at', () => {
    expect(asked(X1, 'home').length + asked(X2, 'home').length).toBe(0);
    expect(tl.entries('home')).toMatchObject({ entries: [], readAt: null });
  });

  test('Home asks both accounts for their Following and merges them, a post both follow once, newest first', async () => {
    const v = await tl.read('home');
    expect(asked(X1, 'home').map((s) => s.cmd.feed)).toEqual(['following']);
    expect(asked(X2, 'home').map((s) => s.cmd.feed)).toEqual(['following']);
    const gossip = v.entries.filter((e) => /gossip layer/.test(e.post.text));
    expect(gossip.length).toBe(1);
    expect(gossip[0].seenBy.map((s) => s.accountId).sort()).toEqual([X1, X2]);
    expect(v.entries.map((e) => e.at)).toEqual([...v.entries.map((e) => e.at)].sort((a, b) => b - a));
    expect(v.entries.some((e) => /repo-tools 2.0/.test(e.post.text) && e.seenBy.every((s) => s.accountId === X2))).toBe(true);
    expect(v.readAt).toBeGreaterThan(Date.now() - 5_000);
    // Every author's identity comes with it, so names draw.
    const authors = new Set(v.entries.map((e) => (e.post.repostOf ?? e.post).author));
    for (const a of authors) expect(v.identities.some((i) => i.id === a)).toBe(true);
  });

  test('a conversation shown with a post keeps the posts above it', () => {
    const v = tl.entries('home');
    const withAbove = v.entries.find((e) => e.above?.length);
    expect(withAbove?.above?.[0].text).toBeTruthy();
  });

  test('read again within a minute, the networks are not asked again', async () => {
    const n = asked(X1, 'home').length;
    await tl.read('home');
    expect(asked(X1, 'home').length).toBe(n);
  });

  test('For you keeps X’s order and says why each post is there', async () => {
    const v = await tl.read(`${X1}:foryou`);
    expect(asked(X1, 'home').at(-1)!.cmd.feed).toBe('foryou');
    expect(asked(X2, 'home').some((s) => s.cmd.feed === 'foryou')).toBe(false);
    expect(v.entries[0].reason).toMatchObject({ text: 'Alice Chen liked', kind: 'like' });
    expect(v.entries.some((e) => e.reason?.kind === 'topic')).toBe(true);
    expect(v.entries.every((e) => e.seenBy.every((s) => s.feed === 'foryou'))).toBe(true);
  });

  test('older posts: the network’s next page, asked with the bottom cursor', async () => {
    const before = tl.entries(`${X1}:following`);
    if (!before.entries.length) await tl.read(`${X1}:following`);
    const had = tl.entries(`${X1}:following`);
    expect(had.older).toBe(true);
    const v = await tl.read(`${X1}:following`, true);
    expect(asked(X1, 'home').at(-1)!.cmd.cursor).toBeTruthy();
    expect(v.entries.length).toBeGreaterThan(had.entries.length);
  });
});

describe('posting', () => {
  let cross: P.PublishView;
  test('one press posts on each account at once, one entry in Your posts with the other as a copy', async () => {
    cross = await tl.publish({ key: 'press-1', destinations: [{ accountId: X1, text: 'Both of us.' }, { accountId: X2, text: 'Both of us.' }] });
    expect(cross.results.map((r) => [r.accountId, r.ok])).toEqual([
      [X1, true],
      [X2, true],
    ]);
    const v = tl.entries('mine');
    const e = v.entries.filter((x) => x.post.text === 'Both of us.');
    expect(e.length).toBe(1);
    expect(e[0].copies?.length).toBe(1);
    expect([e[0].seenBy[0].accountId, e[0].copies![0].accountId].sort()).toEqual([X1, X2]);
    // One account's own Posts shows its own copy only.
    const own = tl.entries(`${X2}:mine`).entries.filter((x) => x.post.text === 'Both of us.');
    expect(own.length).toBe(1);
    expect(own[0].copies).toBeUndefined();
  });

  test('the same press again is answered with what it made, never posted twice', async () => {
    const n = asked(X1, 'publish').length;
    const again = await tl.publish({ key: 'press-1', destinations: [{ accountId: X1, text: 'Both of us.' }, { accountId: X2, text: 'Both of us.' }] });
    expect(asked(X1, 'publish').length).toBe(n);
    expect(again.results.map((r) => r.post?.id)).toEqual(cross.results.map((r) => r.post?.id));
  });

  test('a thread: each part a reply to the one before, who can reply set on the first only', async () => {
    const v = await tl.publish({ key: 'press-2', replies: 'following', destinations: [{ accountId: X1, text: 'One.', parts: ['Two.', 'Three.'] }] });
    const r = v.results[0];
    expect(r.ok).toBe(true);
    expect(r.parts?.length).toBe(2);
    const cmds = asked(X1, 'publish').slice(-3).map((s) => s.cmd);
    expect(cmds.map((c) => c.text)).toEqual(['One.', 'Two.', 'Three.']);
    expect(cmds[0].replies).toBe('following');
    expect(cmds[1].replies).toBeUndefined();
    expect(cmds[1].replyTo).toBe(r.post!.id);
    expect(cmds[2].replyTo).toBe(r.parts![0].id);
  });

  test('too long for X: refused for that account in words, the other posted', async () => {
    const v = await tl.publish({ key: 'press-3', destinations: [{ accountId: X1, text: 'x'.repeat(300) }, { accountId: X2, text: 'Short.' }] });
    expect(v.results[0]).toMatchObject({ accountId: X1, ok: false });
    expect(v.results[0].error).toMatch(/too long/i);
    expect(v.results[1]).toMatchObject({ accountId: X2, ok: true });
  });

  test('a press with no account, or one account twice, is refused', async () => {
    await expect(tl.publish({ key: 'press-4', destinations: [] })).rejects.toThrow(/account/);
    await expect(tl.publish({ key: 'press-5', destinations: [{ accountId: X1, text: 'a' }, { accountId: X1, text: 'b' }] })).rejects.toThrow(/twice/);
  });

  test('deleting one copy of a cross-post: X is asked, and the other copy stands in its place', async () => {
    const first = cross.results.find((r) => r.accountId === X1)!.post!;
    await posts.unpublish('x', first.id, X1);
    expect(asked(X1, 'unpublish').at(-1)!.cmd.post).toBe(first.id);
    const e = tl.entries('mine').entries.filter((x) => x.post.text === 'Both of us.');
    expect(e.length).toBe(1);
    expect(e[0].seenBy[0].accountId).toBe(X2);
    expect(e[0].copies ?? []).toEqual([]);
  });
});

describe('drafts', () => {
  test('a draft is kept on the hub, and counted', () => {
    const d = tl.saveDraft('draft-one', { text: 'Later.', accounts: [X1], replies: 'mentioned' });
    expect(d).toMatchObject({ id: 'draft-one', text: 'Later.', accounts: [X1], replies: 'mentioned' });
    expect(d.scheduledAt).toBeUndefined();
    expect(tl.drafts().map((x) => x.id)).toEqual(['draft-one']);
    expect(tl.sources().drafts).toBe(1);
    tl.dropDraft('draft-one');
    expect(tl.drafts()).toEqual([]);
  });

  test('a scheduled post goes out at its time, cut into a thread when too long, and leaves Drafts', async () => {
    const long = ['A first paragraph that is long enough. '.repeat(5).trim(), 'A second paragraph, also long enough to need its own post. '.repeat(4).trim()].join('\n\n');
    tl.saveDraft('draft-two', { text: long, accounts: [X2], scheduledAt: Date.now() + 60_000 });
    const n = asked(X2, 'publish').length;
    await tl.tick(Date.now());
    expect(asked(X2, 'publish').length).toBe(n);
    await tl.tick(Date.now() + 61_000);
    const made = asked(X2, 'publish').slice(n);
    expect(made.length).toBe(2);
    expect(made[1].cmd.replyTo).toBeTruthy();
    expect(tl.drafts()).toEqual([]);
  });

  test('scheduled while its account is not connected: waited for, then held as failed with why', async () => {
    tl.saveDraft('draft-three', { text: 'When connected.', accounts: [X1], scheduledAt: Date.now() });
    offline.add(X1);
    try {
      await tl.tick(Date.now() + 1_000);
      expect(tl.drafts()[0].failed).toBeUndefined();
      await tl.tick(Date.now() + 31 * 60_000);
      expect(tl.drafts()[0].failed).toMatch(/not connected/);
      expect(tl.sources().accounts.find((a) => a.accountId === X1)!.online).toBe(false);
    } finally {
      offline.delete(X1);
    }
  });

  test('a scheduled draft needs an account and words', () => {
    expect(() => tl.saveDraft('draft-four', { text: 'x', accounts: [], scheduledAt: Date.now() + 1_000 })).toThrow(/account/);
    expect(() => tl.saveDraft('draft-four', { text: '  ', accounts: [X1], scheduledAt: Date.now() + 1_000 })).toThrow(/Nothing/);
  });
});
