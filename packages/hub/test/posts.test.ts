/**
 * Public posts as messages (docs/feed.md "Threads", packages/hub/src/posts.ts): the demo X account's threads read
 * through the hub. Each post read is logged once as a message in the account's quiet, read-only posts conversation,
 * found by search, with its pictures as attachments and the post in its view; a profile's posts are logged too; the
 * thread comes back from what was logged when X cannot be asked; nothing there unread, notified or sent to X.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { postNativeId } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { DEMO_X_ACCOUNT, DemoX, X } from '../src/demo-x.ts';
import { People } from '../src/people.ts';
import { Posts } from '../src/posts.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-posts-'));
let store: Store;
let acc: AccountRow;
let adapter: DemoX;
let online = true;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const sent: P.AdapterCommand[] = [];
const idn = (i: P.IdentityFact) => hubId('idn', 'x', i.nativeId);
const msgOf = (post: string) => hubId('msg', 'x', postNativeId(post));
let POSTS: string;

function command<T>(cmd: P.AdapterCommand): Promise<T> {
  sent.push(cmd);
  return new Promise<T>((resolve, reject) => {
    if ('id' in cmd) pending.set(cmd.id, { resolve: resolve as (v: unknown) => void, reject });
    adapter.command(cmd);
  });
}
const deps = () => ({ store, online: () => online, command: <T,>(_: string, cmd: object) => command<T>({ ...cmd, id: crypto.randomUUID() } as P.AdapterCommand) });

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  acc = store.createAccount({ ...DEMO_X_ACCOUNT, adapter: 'demo', demo: true, config: { epoch: Date.now() } });
  const adir = join(dir, acc.id);
  mkdirSync(adir, { recursive: true });
  adapter = new DemoX(acc, adir);
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
  POSTS = hubId('cnv', 'x', `posts:${X.self.nativeId}`);
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The routing post: the one with the thread under it. */
const routingId = () => (store.db.query(`SELECT extra FROM message WHERE native_id LIKE 'reply:%'`).get() as { extra: string } | null)
  ? (JSON.parse((store.db.query(`SELECT extra FROM message WHERE native_id LIKE 'reply:%'`).get() as { extra: string }).extra).feed as P.FeedItem).post!.id
  : '';

describe('a thread read from X', () => {
  test('comes back in hub ids, the author continuing first, and every post is logged once as a quiet message', async () => {
    const posts = new Posts(deps());
    const id = routingId();
    const persons = store.one<{ n: number }>('SELECT COUNT(*) AS n FROM person')!.n;
    const t = await posts.thread('x', id);
    expect(sent.at(-1)).toMatchObject({ t: 'post', post: id });
    expect(t.stored).toBeUndefined();
    expect(t.focal!.id).toBe(id);
    expect(t.focal!.author).toBe(idn(X.self));
    expect(t.focal!.messageId).toBe(msgOf(id));
    expect(t.ancestors).toHaveLength(0);
    expect(t.replies).toHaveLength(4);
    expect(t.replies[0].every((p) => p.author === idn(X.self))).toBe(true);
    expect(t.replies[1].map((p) => p.author)).toEqual([idn(X.ravi), idn(X.self), idn(X.ravi)]);
    expect(t.more).toBe('more-1');
    expect(t.conversationId).toBe(POSTS);
    expect(t.identities.some((i) => i.id === idn(X.ravi))).toBe(true);

    // Logged: one conversation, read-only and quiet; a message per post, its reply the post it answers.
    expect(store.conversationView(POSTS)).toMatchObject({ variant: 'posts', shape: 'channel' });
    const n = (store.one<{ n: number }>('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?', POSTS)!).n;
    expect(n).toBe(8);
    const answer = t.replies[1][1];
    const row = store.one<Record<string, any>>('SELECT * FROM message WHERE id = ?', answer.messageId!)!;
    expect(row.reply_to_id).toBe(msgOf(t.replies[1][0].id));
    expect(row.author_id).toBe(idn(X.self));
    const v = store.messageViews([store.one<Record<string, any>>('SELECT * FROM message WHERE id = ?', msgOf(id))!])[0];
    expect(v.post!.id).toBe(id);
    expect(v.post!.author).toBe(idn(X.self));
    expect(v.attachments).toHaveLength(1);
    expect(v.attachments[0].kind).toBe('image');
    // Nothing unread, nothing for triage.
    const vant = store.one<{ unread: number }>(`SELECT unread FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`, POSTS)!;
    expect(vant.unread).toBe(0);
    expect(store.one('SELECT 1 FROM triage t JOIN message m ON m.id = t.message_id WHERE m.conversation_id = ?', POSTS)).toBeNull();
    // No persons made for everyone in a thread.
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM person')!.n).toBe(persons);

    // Read again: nothing new, nothing doubled.
    await posts.thread('x', id);
    expect((store.one<{ n: number }>('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?', POSTS)!).n).toBe(8);
  });

  test('more replies come with the cursor and are logged too', async () => {
    const posts = new Posts(deps());
    const t = await posts.thread('x', routingId(), 'more-1');
    expect(sent.at(-1)).toMatchObject({ t: 'post', cursor: 'more-1' });
    expect(t.replies.flat().map((p) => p.author)).toEqual([idn(X.theo), idn(X.quinn)]);
    expect(t.more).toBeNull();
    expect((store.one<{ n: number }>('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?', POSTS)!).n).toBe(10);
  });

  test('a reply opens with what it answers above it', async () => {
    const posts = new Posts(deps());
    const ravi = store.messageViews([store.one<Record<string, any>>(`SELECT * FROM message WHERE native_id LIKE 'reply:%'`)!])[0].feed!.theirs!;
    const t = await posts.thread('x', ravi.id);
    expect(t.ancestors.map((p) => p.id)).toEqual([routingId()]);
    expect(t.replies.flat()).toHaveLength(1);
  });

  test('search finds a logged post by its words and its author', () => {
    const page = store.search('refill pushed');
    expect(page.hits.some((r) => r.message.conversationId === POSTS && r.message.authorId === idn(X.ravi))).toBe(true);
    expect(store.search('from:theo browser').hits.length).toBe(1);
    expect(store.search('network:x has:image greedy').hits.some((r) => r.message.id === msgOf(routingId()))).toBe(true);
  });
});

describe('without X', () => {
  test('the thread is read back from what the hub logged, saying why', async () => {
    online = false;
    const n = sent.length;
    const posts = new Posts(deps());
    const t = await posts.thread('x', routingId());
    expect(sent.length).toBe(n);
    expect(t.stored).toContain('not connected');
    expect(t.focal!.id).toBe(routingId());
    // The author's own continuation first, then the others, each with what was logged under it.
    expect(t.replies[0][0].author).toBe(idn(X.self));
    expect(t.replies.find((c) => c[0].author === idn(X.ravi))!.map((p) => p.author)).toEqual([idn(X.ravi), idn(X.self), idn(X.ravi)]);
    expect(t.replies.length).toBe(6);
    const deep = await posts.thread('x', t.replies.find((c) => c[0].author === idn(X.ravi))![2].id);
    expect(deep.ancestors.map((p) => p.author)).toEqual([idn(X.self), idn(X.ravi), idn(X.self)]);
    // A post never logged: nothing to show, and still a plain answer.
    const none = await posts.thread('x', '42');
    expect(none.focal).toBeNull();
    online = true;
  });
});

describe('a profile', () => {
  test("someone's recent posts are logged when their profile is read", async () => {
    const posts = new Posts(deps());
    const people = new People({ ...deps(), posts: (a, ps) => posts.log(a, ps) });
    await people.get(idn(X.lee), true);
    const lees = store.db.query('SELECT * FROM message WHERE conversation_id = ? AND author_id = ?').all(POSTS, idn(X.lee)) as Record<string, any>[];
    expect(lees.length).toBe(4);
    // A quoted post is a post of its own.
    expect(store.one('SELECT 1 FROM message WHERE conversation_id = ? AND author_id = ?', POSTS, idn(X.quinn))).not.toBeNull();
  });
});

describe('the hub', () => {
  let hub: HubServer;
  let port = 0;
  const hubSent: P.AdapterCommand[] = [];
  const req = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  beforeAll(() => {
    const sup = {
      authorize: () => null,
      online: () => true,
      command: (_: string, c: P.AdapterCommand) => {
        hubSent.push(c);
        return c.t === 'post' ? command({ ...c, id: crypto.randomUUID() } as P.AdapterCommand) : Promise.resolve({});
      },
    } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    port = hub.start().port!;
  });
  afterAll(() => hub.stop());

  test('GET /api/posts/x/:id/thread reads it; a bad id or network is refused', async () => {
    const res = await req(`/api/posts/x/${routingId()}/thread`);
    expect(res.status).toBe(200);
    const t = (await res.json()) as P.PostThreadView;
    expect(t.focal!.id).toBe(routingId());
    expect(hubSent.filter((c) => c.t === 'post')).toHaveLength(1);
    expect((await req('/api/posts/x/abc/thread')).status).toBe(404);
    expect((await req(`/api/posts/nowhere/1/thread`)).status).toBe(404);
  });

  test('the posts conversation is read-only: no message, reaction, edit or typing reaches X', async () => {
    const n = hubSent.length;
    const msg = msgOf(routingId());
    for (const [path, body] of [
      [`/api/conversations/${POSTS}/send`, { body: 'hi' }],
      [`/api/messages/${msg}/react`, { key: '👍' }],
    ] as const) {
      const res = await req(path, { method: 'POST', body: JSON.stringify(body) });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("X's posts are read-only here");
    }
    expect(await (await req(`/api/conversations/${POSTS}/typing`, { method: 'POST', body: '{}' })).json()).toMatchObject({ sent: false });
    expect(hubSent.length).toBe(n);
  });
});
