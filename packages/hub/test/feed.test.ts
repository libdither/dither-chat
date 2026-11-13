/**
 * A network's notifications about you (docs/feed.md, packages/hub/src/feed.ts): the demo X account's feed run in
 * process into a store. Its messages carry what they did to the page, the people in it become people, what X showed
 * about them is kept as a profile answer unless a newer one is, likes never notify and replies are at most a silent
 * row on the list, and the hub sends nothing to the network for it: no message, reaction, edit, read mark or typing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { DEMO_X_ACCOUNT, DemoX, X } from '../src/demo-x.ts';
import { keptAbout, People } from '../src/people.ts';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-feed-'));
let store: Store;
let acc: AccountRow;
let adapter: DemoX;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** Every command the hub sent the X adapter. */
const sent: P.AdapterCommand[] = [];
const FEED = hubId('cnv', 'x', 'feed');
const idn = (i: P.IdentityFact) => hubId('idn', 'x', i.nativeId);

function command<T>(cmd: P.AdapterCommand): Promise<T> {
  sent.push(cmd);
  return new Promise<T>((resolve, reject) => {
    if ('id' in cmd) pending.set(cmd.id, { resolve: resolve as (v: unknown) => void, reject });
    adapter.command(cmd);
    if (!('id' in cmd)) resolve(undefined as T);
  });
}

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
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the feed in the store', () => {
  test('one read-only conversation whose messages say what each person did, with hub ids and signed pictures', () => {
    expect(store.conversationView(FEED)).toMatchObject({ variant: 'feed', shape: 'channel', name: 'Notifications' });
    const rows = store.db.query('SELECT * FROM message WHERE conversation_id = ? ORDER BY ts').all(FEED) as Record<string, unknown>[];
    const views = store.messageViews(rows);
    expect(views.length).toBe(13);
    const likes = views.filter((m) => m.feed?.type === 'like');
    expect(likes.length).toBe(7);
    expect(likes.every((m) => m.kind === 'system' && m.body === 'liked your post')).toBe(true);
    const reply = views.find((m) => m.feed?.type === 'reply')!;
    expect(reply.kind).toBe('text');
    expect(reply.authorId).toBe(idn(X.ravi));
    expect(reply.feed!.theirs!.author).toBe(idn(X.ravi));
    expect(reply.feed!.theirs!.replyTo!.author).toBe(idn(X.self));
    expect(reply.feed!.post!.author).toBe(idn(X.self));
    // Pictures as the page fetches them: the demo's are inline, as they came.
    expect(reply.feed!.post!.media![0].url.startsWith('data:image/svg+xml')).toBe(true);
    const quote = views.find((m) => m.feed?.type === 'quote')!;
    expect(quote.feed!.theirs!.quoteOf!.author).toBe(idn(X.self));
  });

  test('extra.feed survives the same message sent again without it, and an edit of a reply', () => {
    const native = store.one<{ native_id: string; body: string; ts: number }>(`SELECT native_id, body, ts FROM message WHERE conversation_id = ? AND native_id LIKE 'reply:%'`, FEED)!;
    store.ingest(acc, { t: 'message', message: { nativeId: native.native_id, conversation: 'feed', author: X.ravi.nativeId, ts: native.ts, body: native.body } });
    store.ingest(acc, { t: 'message', message: { nativeId: native.native_id, conversation: 'feed', author: X.ravi.nativeId, ts: native.ts, body: `${native.body} (edited)`, editedTs: native.ts + 1000 } });
    const v = store.messageViews([store.one('SELECT * FROM message WHERE native_id = ?', native.native_id)!])[0];
    expect(v.feed?.type).toBe('reply');
    expect(v.body.endsWith('(edited)')).toBe(true);
  });

  test('everyone in it is a person, and none of them is in People: they have no DM', () => {
    for (const k of ['alice', 'ravi', 'quinn', 'maya', 'theo', 'nora', 'lee', 'sam'] as const) {
      const pid = store.one<{ person_id: string | null }>('SELECT person_id FROM identity WHERE id = ?', idn(X[k]))!.person_id;
      expect(pid).toBeTruthy();
    }
    expect(store.one('SELECT 1 FROM participant WHERE conversation_id = ?', FEED)).toBeNull();
  });

  test('what X showed about them is kept as a profile answer, marked unasked, unless a newer one is held', () => {
    const k = keptAbout(store, idn(X.alice))!;
    expect(k.about).toMatchObject({ bio: expect.any(String), counts: { followers: 2310 }, followsYou: true, unasked: true });
    expect(k.about.posts).toBeUndefined();
    const at = k.at;
    // Older than what is held: nothing changes.
    store.ingest(acc, { t: 'personAbout', who: X.alice.nativeId, about: { bio: 'stale' }, ts: at - 1000 });
    expect(keptAbout(store, idn(X.alice))!.about.bio).not.toBe('stale');
    // Newer, with a new bio: kept, and the change is in her history like an asked profile's.
    store.ingest(acc, { t: 'personAbout', who: X.alice.nativeId, about: { bio: 'Now at a bigger company.', counts: { followers: 2400 } }, ts: at + 1000 });
    expect(keptAbout(store, idn(X.alice))!.about).toMatchObject({ bio: 'Now at a bigger company.', counts: { followers: 2400 }, unasked: true });
    const change = store.one<{ old: string; new: string }>(`SELECT old, new FROM change_log WHERE target_kind = 'identity' AND target_id = ? AND field = 'bio'`, idn(X.alice))!;
    expect(JSON.parse(change.new)).toBe('Now at a bigger company.');
  });

  test('opening the profile asks X for their posts even right after an unasked one; an event after keeps those posts', async () => {
    const people = new People({ store, online: () => true, command: (a, cmd) => command({ ...cmd, id: crypto.randomUUID() } as P.AdapterCommand) });
    const v = await people.get(idn(X.nora));
    expect(sent.some((c) => c.t === 'profile' && c.who === X.nora.nativeId)).toBe(true);
    expect(v.unasked).toBeUndefined();
    expect(v.posts!.length).toBeGreaterThan(2);
    expect(v.posts![0].pinned).toBe(true);
    const repost = v.posts!.find((p) => p.repostOf)!;
    expect(repost.repostOf!.author).toBe(idn(X.self));
    // A quote names someone else: they come along for drawing it.
    expect(v.identities.some((i) => i.id === idn(X.quinn))).toBe(true);
    // Fresh now: asked again only when forced.
    const n = sent.length;
    await people.get(idn(X.nora));
    expect(sent.length).toBe(n);
    // X shows her again in a notification: her posts stay, and the next open asks again.
    store.ingest(acc, { t: 'personAbout', who: X.nora.nativeId, about: { bio: 'Networks researcher.' }, ts: Date.now() + 1000 });
    const k = keptAbout(store, idn(X.nora))!;
    expect(k.about.posts!.length).toBe(v.posts!.length);
    expect(k.about.unasked).toBe(true);
  });
});

describe('notifications', () => {
  let triage: Triage;
  let judged = 0;
  const decide = async (nativeId: string) => (await triage.decide(store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id))!;
  const ravi = () => store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', idn(X.ravi))!.person_id;
  beforeAll(() => {
    triage = new Triage(store);
    // The local model would call anything urgent: nothing in the feed may ask it.
    triage.judge = async () => (judged++, 0.99);
  });

  test('likes, reposts and follows never notify, whatever the rules', async () => {
    store.setRule('person', ravi(), 'all');
    const like = store.one<{ native_id: string }>(`SELECT native_id FROM message WHERE native_id LIKE 'like:%:${X.ravi.nativeId}'`)!.native_id;
    const d = await decide(like);
    expect(d.decision).toBe('silent');
    expect(d.reasons[0]).toContain('never notify');
    for (const prefix of ['repost:', 'follow:']) {
      const id = store.one<{ native_id: string }>(`SELECT native_id FROM message WHERE native_id LIKE ?`, `${prefix}%`)!.native_id;
      expect((await decide(id)).decision).toBe('silent');
    }
  });

  test('a reply, a mention or a quote is at most a silent row on the list, even from someone set to Always alert', async () => {
    for (const prefix of ['reply:', 'mention:', 'quote:']) {
      const id = store.one<{ native_id: string }>(`SELECT native_id FROM message WHERE native_id LIKE ?`, `${prefix}%`)!.native_id;
      const d = await decide(id);
      expect(['digest', 'drop']).toContain(d.decision);
      expect(d.reasons.some((r) => r.includes('kept to the list'))).toBe(true);
    }
    // X notified you of it, so it starts at the network's importance: on the list at the default level.
    const reply = store.one<{ native_id: string }>(`SELECT native_id FROM message WHERE native_id LIKE 'reply:%'`)!.native_id;
    expect((await decide(reply)).decision).toBe('digest');
    expect(judged).toBe(0);
    store.setRule('person', ravi(), null);
  });

  test('muting the feed silences replies too', async () => {
    store.setRule('conversation', FEED, 'none');
    const reply = store.one<{ native_id: string }>(`SELECT native_id FROM message WHERE native_id LIKE 'reply:%'`)!.native_id;
    expect((await decide(reply)).decision).toBe('silent');
    store.setRule('conversation', FEED, null);
  });
});

describe('the hub sends X nothing for it', () => {
  let hub: HubServer;
  let port = 0;
  const hubSent: P.AdapterCommand[] = [];
  const post = (path: string, body: unknown = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body) });
  beforeAll(() => {
    const sup = { authorize: () => null, online: () => true, command: async (_: string, c: P.AdapterCommand) => (hubSent.push(c), {}) } as any;
    hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    port = hub.start().port!;
  });
  afterAll(() => hub.stop());

  test('a message, a reaction, an edit and settings are refused with a plain reason', async () => {
    const msg = store.one<{ id: string }>(`SELECT id FROM message WHERE native_id LIKE 'reply:%'`)!.id;
    for (const [path, body] of [
      [`/api/conversations/${FEED}/send`, { body: 'hi' }],
      [`/api/messages/${msg}/react`, { key: '👍' }],
      [`/api/messages/${msg}/edit`, { body: 'x' }],
      [`/api/conversations/${FEED}/about`, { change: { key: 'name', value: 'x' } }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("X's notifications are read-only here");
    }
    expect(hubSent).toHaveLength(0);
  });

  test('reading it stays on the hub, and typing there goes nowhere', async () => {
    const before = store.one<{ unread: number }>(`SELECT unread FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`, FEED)!.unread;
    expect(before).toBeGreaterThan(0);
    expect((await post(`/api/conversations/${FEED}/read`)).status).toBe(200);
    expect(store.one<{ unread: number }>(`SELECT unread FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`, FEED)!.unread).toBe(0);
    expect(await (await post(`/api/conversations/${FEED}/typing`)).json()).toMatchObject({ sent: false });
    expect(hubSent).toHaveLength(0);
  });
});
