/**
 * A person's posts (packages/hub/src/personposts.ts, docs/places.md "A person's networks"): what the hub logged whose
 * author is one of their identities, newest first, paged by a cursor; their reply in your notifications counted once;
 * nothing from a chat, a like or a follow; a merge brings an identity's posts, a split takes them away.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { parseCursor } from '../src/chats.ts';
import { personPosts, withPublic } from '../src/personposts.ts';
import { Posts } from '../src/posts.ts';
import { mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-personposts-'));
let store: Store;
let x: AccountRow;
let masto: AccountRow;
let signal: AccountRow;
let posts: Posts;
const T = 1_700_000_000_000;
const MIN = 60_000;
const me: P.IdentityFact = { nativeId: 'x-me', handle: 'me_demo', displayName: 'Me' };
const kim: P.IdentityFact = { nativeId: 'x-kim', handle: 'kim_posts', displayName: 'Kim' };
const lou: P.IdentityFact = { nativeId: 'x-lou', handle: 'lou_posts', displayName: 'Lou' };
const kimM: P.IdentityFact = { nativeId: 'kim@social.example', handle: 'kim@social.example', displayName: 'Kim' };
const kimS: P.IdentityFact = { nativeId: '+15550100', displayName: 'Kim' };
const idn = (net: P.Network, i: P.IdentityFact) => hubId('idn', net, i.nativeId);
const post = (n: number, who: P.IdentityFact, min: number, x: Partial<P.PostFact> = {}): P.PostFact => ({ id: `p${n}`, url: `https://example.org/p${n}`, ts: T - min * MIN, author: who.nativeId, text: `post ${n}`, ...x });

let kimPerson: string;
const page = (before: string | null = null, limit = 30, toYou = false) => personPosts(store, kimPerson, parseCursor(before), limit, toYou)!;
const ids = (p: P.PersonPostsPage) => p.posts.map((v) => v.post.id);

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  x = store.createAccount({ id: 'acc_x', network: 'x', label: 'x', color: '#111', adapter: 'demo', demo: true });
  masto = store.createAccount({ id: 'acc_m', network: 'mastodon', label: 'm', color: '#222', adapter: 'demo', demo: true });
  signal = store.createAccount({ id: 'acc_s', network: 'signal', label: 's', color: '#333', adapter: 'demo', demo: true });
  store.ingest(x, { t: 'status', status: 'online', self: { ...me, isSelf: true } });
  for (const i of [kim, lou]) store.ingest(x, { t: 'identity', identity: i });
  store.ingest(masto, { t: 'identity', identity: kimM });
  store.ingest(signal, { t: 'identity', identity: kimS });
  x = store.account(x.id)!;
  posts = new Posts({ store, online: () => true, command: () => Promise.reject(new Error('never asked')) });
  // Five of Kim's on X, one of Lou's, one reply of Kim's to you; two on Mastodon.
  posts.log(x.id, [1, 2, 3, 4, 5].map((n) => post(n, kim, n * 10)));
  posts.log(x.id, [post(6, lou, 25), post(7, kim, 5, { replyTo: { id: 'p0', author: me.nativeId } })]);
  posts.log(masto.id, [post(8, kimM, 15), post(9, kimM, 60)]);
  // Kim's notifications in your feed: a reply already logged above (p7), a mention logged nowhere else, and a like.
  store.ingest(x, { t: 'conversation', conversation: { nativeId: 'feed', shape: 'channel', variant: 'feed', name: 'Notifications' } });
  const feed = (nativeId: string, min: number, item: P.FeedItem, body: string) => store.ingest(x, { t: 'message', message: { nativeId, conversation: 'feed', author: kim.nativeId, ts: T - min * MIN, kind: 'text', body, extra: { feed: item } } });
  feed('reply:p7', 5, { type: 'reply', theirs: post(7, kim, 5, { replyTo: { id: 'p0', author: me.nativeId } }), url: 'u' }, 'post 7');
  feed('mention:p10', 2, { type: 'mention', theirs: post(10, kim, 2, { text: '@me_demo look' }), url: 'u' }, '@me_demo look');
  feed('like:p0:kim', 1, { type: 'like', post: post(0, me, 100), url: 'u' }, 'liked your post');
  // A direct message from Kim on X, and one on Signal: chats, never posts.
  store.ingest(x, { t: 'conversation', conversation: { nativeId: 'dm-kim', shape: 'direct', name: 'Kim' } });
  store.ingest(x, { t: 'message', message: { nativeId: 'dm1', conversation: 'dm-kim', author: kim.nativeId, ts: T - 3 * MIN, kind: 'text', body: 'hi' } });
  store.ingest(signal, { t: 'conversation', conversation: { nativeId: 'sig-kim', shape: 'direct', name: 'Kim' } });
  store.ingest(signal, { t: 'message', message: { nativeId: 's1', conversation: 'sig-kim', author: kimS.nativeId, ts: T - 4 * MIN, kind: 'text', body: 'hey' } });
  store.flush();
  kimPerson = store.ensurePerson(idn('x', kim));
  store.mergePersons(kimPerson, store.ensurePerson(idn('signal', kimS)));
  store.ensurePerson(idn('x', lou));
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a person’s posts', () => {
  test('theirs only, newest first: their mention once from the feed, their reply once as logged, no like and no chat', () => {
    const p = page();
    expect(ids(p)).toEqual(['p10', 'p7', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(p.hasMore).toBe(false);
    expect(p.before).toBeNull();
    expect(p.posts.every((v) => v.network === 'x' && v.post.author === idn('x', kim))).toBe(true);
    expect(p.posts.find((v) => v.post.id === 'p10')?.toYou).toBe('mention');
    expect(p.posts.find((v) => v.post.id === 'p7')?.toYou).toBe('reply');
    expect(p.posts.filter((v) => v.toYou).length).toBe(2);
    // The page names whom it draws: Kim, and you, whom the reply answers.
    expect(p.identities.map((i) => i.id).sort()).toEqual([idn('x', kim), idn('x', me)].sort());
  });

  test('pages by the cursor, never twice and never skipping', () => {
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const p = page(before, 2);
      seen.push(...ids(p));
      expect(p.hasMore).toBe(p.before !== null);
      before = p.before;
      pages++;
    } while (before && pages < 10);
    expect(seen).toEqual(['p10', 'p7', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(pages).toBe(4);
  });

  test('to you only: the reply and the mention', () => {
    expect(ids(page(null, 30, true))).toEqual(['p10', 'p7']);
  });

  test('their chat: what they wrote to you in public, as rows in the page’s range, oldest first', () => {
    const empty: P.MessagePage = { messages: [], identities: [], hasMore: false };
    const all = withPublic(store, kimPerson, null, empty).elsewhere!;
    expect(all.map((e) => [e.place, e.placeKind, e.post?.act, e.title])).toEqual([
      ['pst_x_p7', 'post', 'reply', 'replied to your post on X'],
      ['pst_x_p10', 'post', 'mention', 'mentioned you on X'],
    ]);
    expect(all[1]!.excerpt).toBe('@me_demo look');
    // A page with more before it covers from its oldest message: the reply, older, is the next page's.
    const oldest = { id: 'msg_x', conversationId: 'c', ts: T - 3 * MIN } as P.MessageView;
    expect(withPublic(store, kimPerson, null, { ...empty, messages: [oldest], hasMore: true }).elsewhere!.map((e) => e.place)).toEqual(['pst_x_p10']);
    // …and that page, from the cursor, has the reply and not the mention.
    expect(withPublic(store, kimPerson, { ts: T - 3 * MIN, id: 'msg_x' }, empty).elsewhere!.map((e) => e.place)).toEqual(['pst_x_p7']);
  });

  test('a merge brings the other identity’s posts in, by time; a split takes them away', () => {
    const m = store.ensurePerson(idn('mastodon', kimM));
    store.mergePersons(kimPerson, m);
    const merged = page();
    expect(ids(merged)).toEqual(['p10', 'p7', 'p1', 'p8', 'p2', 'p3', 'p4', 'p5', 'p9']);
    expect(merged.posts.find((v) => v.post.id === 'p8')?.network).toBe('mastodon');
    store.splitIdentity(idn('mastodon', kimM));
    expect(ids(page())).toEqual(['p10', 'p7', 'p1', 'p2', 'p3', 'p4', 'p5']);
  });

  test('someone on no network of posts has none, and nobody by that id is null', () => {
    const solo = store.db.query('SELECT person_id FROM identity WHERE id = ?').get(idn('signal', kimS)) as { person_id: string };
    expect(solo.person_id).toBe(kimPerson);
    store.splitIdentity(idn('signal', kimS));
    const sig = (store.db.query('SELECT person_id FROM identity WHERE id = ?').get(idn('signal', kimS)) as { person_id: string }).person_id;
    expect(personPosts(store, sig, null, 30)).toEqual({ posts: [], identities: [], hasMore: false, before: null });
    expect(personPosts(store, 'per_nobody', null, 30)).toBeNull();
  });
});
