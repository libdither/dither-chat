/**
 * Chats (chats.ts, docs/chats.md) through the hub with a stand-in supervisor: a person's routes, the route a message
 * goes through when nobody says, the one you chose and what a merge or a split does to it, paging across
 * conversations that share a time, reading every route, and nicknames, including where old names came from.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { HubServer, mediaSigner } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-chats-'));
const sent: { account: string; cmd: any }[] = [];
let store: Store;
let hub: HubServer;
let url = '';
let main: AccountRow, alt: AccountRow, sig: AccountRow;
let kit = '';
const cnv = (net: 'discord' | 'signal', id: string) => hubId('cnv', net, id);
const idn = (net: 'discord' | 'signal', id: string) => hubId('idn', net, id);
const call = async <T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> => {
  const res = await fetch(url + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
};
const chat = () => call<P.ChatView>('GET', `/api/chats/person:${kit}`).then((r) => r.json);

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  const sup = {
    authorize: () => null,
    online: () => true,
    command: async (account: string, cmd: any) => {
      sent.push({ account, cmd });
      return { nativeId: `n${sent.length}` };
    },
  } as any;
  hub = new HubServer(store, sup, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
  url = `http://127.0.0.1:${hub.start().port}`;
  const acc = (network: 'discord' | 'signal', label: string, self: string) => {
    const a = store.createAccount({ network, label, color: '#000', adapter: network });
    store.ingest(a, { t: 'hello', network, version: '1', capabilities: ['send', 'markRead'] as any });
    store.ingest(a, { t: 'status', status: 'online', self: { nativeId: self, isSelf: true, displayName: label } });
    return store.account(a.id)!;
  };
  main = acc('discord', 'zyansheep', 'me1');
  alt = acc('discord', 'zyn', 'me2');
  sig = acc('signal', 'phone', 'aci-me');
  // Kit: kit.exe talks with both Discord accounts, kit.work with main only, and Kit on Signal.
  store.ingest(main, { t: 'identity', identity: { nativeId: 'k-exe', handle: 'kit.exe', displayName: 'Kit' } });
  store.ingest(main, { t: 'identity', identity: { nativeId: 'k-work', handle: 'kit.work', displayName: 'Kit (work)' } });
  store.ingest(sig, { t: 'identity', identity: { nativeId: 'aci-kit', handle: '+15550100', displayName: 'Kit' } });
  store.ingest(main, { t: 'conversation', conversation: { nativeId: 'dm-exe-main', shape: 'direct', participants: ['k-exe', 'me1'] } });
  store.ingest(alt, { t: 'conversation', conversation: { nativeId: 'dm-exe-alt', shape: 'direct', participants: ['k-exe', 'me2'] } });
  store.ingest(main, { t: 'conversation', conversation: { nativeId: 'dm-work-main', shape: 'direct', participants: ['k-work', 'me1'] } });
  store.ingest(sig, { t: 'conversation', conversation: { nativeId: 'dm-kit', shape: 'direct', participants: ['aci-kit', 'aci-me'] } });
  const m = (a: AccountRow, conversation: string, nativeId: string, author: string, ts: number) => store.ingest(a, { t: 'message', message: { nativeId, conversation, author, ts, body: nativeId } });
  m(main, 'dm-exe-main', 'a1', 'k-exe', 1000);
  m(alt, 'dm-exe-alt', 'b1', 'k-exe', 2000);
  // Two messages at the same time in two conversations: paging one at a time must give both.
  m(main, 'dm-work-main', 'c1', 'k-work', 3000);
  m(sig, 'dm-kit', 'd1', 'aci-kit', 3000);
  m(main, 'dm-exe-main', 'a2', 'me1', 4000);
  store.flush();
  const p = (id: string) => store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', id)!.person_id;
  kit = p(idn('discord', 'k-exe'));
  store.mergePersons(kit, p(idn('discord', 'k-work')));
  store.mergePersons(kit, p(idn('signal', 'aci-kit')));
  store.flush();
});

afterAll(() => {
  hub.stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('routes', () => {
  test('every direct conversation with them, once per account of yours in it, the latest first', async () => {
    const c = await chat();
    expect(c).toMatchObject({ id: `person:${kit}`, kind: 'person', personId: kit, name: 'Kit', nameSource: 'merge' });
    expect(c.routes.map((r) => [r.conversationId, r.accountId])).toEqual([
      [cnv('discord', 'dm-exe-main'), main.id],
      [cnv('signal', 'dm-kit'), sig.id],
      [cnv('discord', 'dm-work-main'), main.id],
      [cnv('discord', 'dm-exe-alt'), alt.id],
    ]);
    expect(c.routes[0]).toMatchObject({ network: 'discord', theirIdentityId: idn('discord', 'k-exe'), myIdentityId: idn('discord', 'me1'), lastTs: 4000 });
  });

  test('nobody chose: the latest message’s route', async () => {
    expect((await chat()).route).toEqual({ conversationId: cnv('discord', 'dm-exe-main'), accountId: main.id, why: 'latest' });
  });

  test('a chosen route is kept, one the chat does not have is refused, and null forgets it', async () => {
    const r = { conversationId: cnv('discord', 'dm-exe-alt'), accountId: alt.id };
    expect((await call('PATCH', `/api/chats/person:${kit}`, { route: r })).json.route).toEqual({ ...r, why: 'chosen' });
    expect((await chat()).route).toEqual({ ...r, why: 'chosen' });
    expect((await call('PATCH', `/api/chats/person:${kit}`, { route: { conversationId: cnv('discord', 'dm-exe-alt'), accountId: main.id } })).status).toBe(409);
    expect((await call('PATCH', `/api/chats/person:${kit}`, { route: null })).json.route.why).toBe('latest');
  });

  test('a conversation is a chat of its own, and an unknown id is not one', async () => {
    const c = (await call<P.ChatView>('GET', `/api/chats/${cnv('discord', 'dm-work-main')}`)).json;
    expect(c).toMatchObject({ kind: 'conversation', personId: null, nameSource: null, route: { accountId: main.id, why: 'latest' } });
    expect(c.routes[0].theirIdentityId).toBe(idn('discord', 'k-work'));
    expect((await call('GET', '/api/chats/person:per_nobody')).status).toBe(404);
    expect((await call('GET', '/api/chats/cnv_nothing')).status).toBe(404);
  });
});

describe('messages', () => {
  test('paging one at a time across conversations that share a time skips nothing and repeats nothing', async () => {
    const seen: string[] = [];
    let before = '';
    for (let i = 0; i < 10; i++) {
      const page = (await call<P.MessagePage>('GET', `/api/chats/person:${kit}/messages?limit=1${before ? `&before=${before}` : ''}`)).json;
      if (!page.messages.length) break;
      const m = page.messages[0];
      seen.push(m.body);
      before = `${m.ts}:${m.id}`;
      if (!page.hasMore) break;
    }
    expect(seen[0]).toBe('a2');
    expect(seen.slice(1, 3).sort()).toEqual(['c1', 'd1']);
    expect(seen.slice(3)).toEqual(['b1', 'a1']);
  });

  test('a time alone still works, as before', async () => {
    const page = (await call<P.MessagePage>('GET', `/api/chats/person:${kit}/messages?before=3000`)).json;
    expect(page.messages.map((m) => m.body)).toEqual(['a1', 'b1']);
  });

  test('a send without a route goes through the chat’s; with one, through that; a reply, where it was said', async () => {
    let r = await call('POST', `/api/chats/person:${kit}/messages`, { body: 'hello' });
    expect(r.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ account: main.id, cmd: { t: 'send', conversation: 'dm-exe-main', body: 'hello' } });
    r = await call('POST', `/api/chats/person:${kit}/messages`, { body: 'on signal', route: { conversationId: cnv('signal', 'dm-kit') } });
    expect(sent.at(-1)).toMatchObject({ account: sig.id, cmd: { conversation: 'dm-kit' } });
    r = await call('POST', `/api/chats/person:${kit}/messages`, { body: 'yes', replyTo: hubId('msg', 'discord', 'b1') });
    expect(sent.at(-1)).toMatchObject({ account: alt.id, cmd: { conversation: 'dm-exe-alt', replyTo: 'b1' } });
    r = await call('POST', `/api/chats/person:${kit}/messages`, { body: 'x', route: { conversationId: cnv('discord', 'dm-exe-alt'), accountId: main.id } });
    expect(r.status).toBe(409);
  });

  test('reading the chat reads every route', async () => {
    const unread = () => store.db.query(`SELECT SUM(unread) AS n FROM vantage WHERE target_kind = 'conversation'`).get() as { n: number };
    expect(unread().n).toBeGreaterThan(0);
    expect((await call('POST', `/api/chats/person:${kit}/read`, {})).status).toBe(200);
    expect(unread().n).toBe(0);
  });
});

describe('names', () => {
  test('a nickname says so; taking it away gives back the name of the account they wrote in last', async () => {
    let c = (await call<P.ChatView>('PATCH', `/api/chats/person:${kit}`, { name: ' Kitty ' })).json;
    expect(c).toMatchObject({ name: 'Kitty', nameSource: 'user' });
    expect(store.personView(store.one('SELECT * FROM person WHERE id = ?', kit)!).nameSource).toBe('user');
    c = (await call<P.ChatView>('PATCH', `/api/chats/person:${kit}`, { name: null })).json;
    expect(c.nameSource).toBe('merge');
    expect(['Kit', 'Kit (work)']).toContain(c.name);
    expect((await call('PATCH', `/api/chats/person:${kit}`, { name: '  ' })).status).toBe(400);
    expect((await call('PATCH', `/api/chats/${cnv('signal', 'dm-kit')}`, { name: 'x' })).status).toBe(400);
  });

  test('a merge keeps a nickname from either side, and takes the chosen route along', () => {
    store.ingest(main, { t: 'identity', identity: { nativeId: 'k-3', handle: 'kit3', displayName: 'k3' } });
    store.ingest(main, { t: 'conversation', conversation: { nativeId: 'dm-3', shape: 'direct', participants: ['k-3', 'me1'] } });
    const other = store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', idn('discord', 'k-3'))!.person_id;
    store.setNickname(other, 'Kit three');
    store.db.query('INSERT INTO chat_route (chat_id, conversation_id, account_id, set_at) VALUES (?, ?, ?, 1)').run(`person:${other}`, cnv('discord', 'dm-3'), main.id);
    store.mergePersons(kit, other);
    expect(store.one('SELECT name, name_source FROM person WHERE id = ?', kit)).toEqual({ name: 'Kit three', name_source: 'user' });
    expect(store.one('SELECT conversation_id FROM chat_route WHERE chat_id = ?', `person:${kit}`)).toEqual({ conversation_id: cnv('discord', 'dm-3') });
    expect(store.one('SELECT 1 FROM chat_route WHERE chat_id = ?', `person:${other}`)).toBeNull();
  });

  test('a split leaves the chosen route behind: the chat goes back to the latest message’s', async () => {
    store.splitIdentity(idn('discord', 'k-3'));
    expect((await chat()).route?.why).toBe('latest');
  });
});

test('where old names came from: merged under an account’s name is a merge, anything else a nickname', () => {
  const d2 = mkdtempSync(join(tmpdir(), 'dither-names-'));
  try {
    const path = join(d2, 'hub.sqlite');
    let s = new Store(path, mediaSigner('s'));
    const a = s.createAccount({ network: 'discord', label: 'x', color: '#000', adapter: 'discord' });
    for (const [id, name] of [['u1', 'Ann'], ['u2', 'Bo'], ['u3', 'Cy']]) s.ingest(s.account(a.id)!, { t: 'identity', identity: { nativeId: id, handle: name.toLowerCase(), displayName: name } });
    const pid = (n: string) => s.ensurePerson(hubId('idn', 'discord', n));
    const [ann, bo, cy] = [pid('u1'), pid('u2'), pid('u3')];
    // As a hub from before name_source wrote them: renamed (Bo), merged under a handle (Ann), untouched (Cy).
    s.db.query(`UPDATE person SET manual = 1, name = 'Bobby' WHERE id = ?`).run(bo);
    s.db.query(`UPDATE person SET manual = 1, name = '@ann' WHERE id = ?`).run(ann);
    s.db.query(`UPDATE person SET name_source = 'network'`).run();
    s.db.query(`DELETE FROM meta WHERE key = 'name_source_set'`).run();
    s.db.close();
    s = new Store(path, mediaSigner('s'));
    const src = (id: string) => s.one<{ name_source: string }>('SELECT name_source FROM person WHERE id = ?', id)!.name_source;
    expect([src(ann), src(bo), src(cy)]).toEqual(['merge', 'user', 'network']);
    s.db.close();
  } finally {
    rmSync(d2, { recursive: true, force: true });
  }
});
