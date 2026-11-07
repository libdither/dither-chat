/**
 * What the networks say about a person (people.ts, docs/profile.md), against the demo world's adapters run in
 * process: which account asks, native ids turned into hub ones, the answer kept and shown first next time, and what
 * an offline account or an adapter without `profile` still gets.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { createDemoAccounts, demoFactory } from '../src/demo.ts';
import { People } from '../src/people.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-people-'));
let store: Store;
let people: People;
const offline = new Set<string>();
const asked: { account: string; who: string }[] = [];
const adapters = new Map<string, { command: (c: P.AdapterCommand) => void }>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** Alice, by her handle on each network. */
const ALICE: Record<P.Network, string> = { discord: 'alice.chen', signal: '+1 555 0137', whatsapp: '+15550137', matrix: '@alicechen:matrix.org' };
const identityOf = (net: P.Network) => store.one<{ id: string }>('SELECT id FROM identity WHERE network = ? AND handle = ?', net, ALICE[net])!.id;

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
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
  store.flush();
  people = new People({
    store,
    online: (a) => !offline.has(a),
    command: <T>(account: string, cmd: { t: 'profile'; who: string } | { t: 'setProfile'; change: { bio?: string } }) =>
      new Promise<T>((resolve, reject) => {
        const id = crypto.randomUUID();
        asked.push({ account, who: cmd.t === 'profile' ? cmd.who : 'set' });
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        adapters.get(account)!.command({ ...cmd, id });
      }),
  });
});

afterAll(() => {
  for (const a of adapters.values()) (a as unknown as { stop(): void }).stop();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Discord: bio, status, a friend, servers in common with their nickname and roles, mutual friends in hub ids', async () => {
  const id = identityOf('discord');
  const v = await people.get(id);
  expect(v.stale).toBeUndefined();
  expect(v.network).toBe('discord');
  expect(v.bio).toContain('film photography');
  expect(v.pronouns).toBe('she/her');
  expect(v.status).toEqual({ text: 'at the crag', emoji: '🧗' });
  expect(v.relationship).toBe('friend');
  const libdither = store.one<{ id: string }>(`SELECT id FROM space WHERE name = 'libdither'`)!.id;
  expect(v.mutualSpaces).toContainEqual({ spaceId: libdither, nativeId: expect.any(String), nick: 'alice (testing)', roles: [{ name: 'Testers', color: '#3BA55C' }] });
  expect(v.mutualFriends!.length).toBe(3);
  expect(v.mutualFriends!.every((f) => f.startsWith('idn_'))).toBe(true);
  expect(v.identities.map((i) => i.displayName).sort()).toEqual(['Jordan', 'Ravi', 'Theo']);
  expect(v.links).toContainEqual({ label: 'GitHub', value: 'alicechen', url: 'https://github.com/alicechen', verified: true });
});

test('asked through an account that shares a conversation with them, and once per ten minutes', async () => {
  const id = identityOf('signal');
  asked.length = 0;
  const a = await people.get(id);
  expect(a.accountId).toBe('acc_demo-signal');
  expect(a.bio).toBe('on the wall, back at 8');
  expect(a.links).toEqual([{ label: 'Phone', value: '+1 555 0137', url: 'tel:+15550137' }]);
  await people.get(id);
  expect(asked.length).toBe(1);
  await people.get(id, true);
  expect(asked.length).toBe(2);
  // Kept, for the profile's first paint.
  expect(people.kept([id]).map((k) => k.bio)).toEqual(['on the wall, back at 8']);
});

test('your own: your friends; an offline account: what it said last, saying why', async () => {
  const me = store.one<{ self_identity: string }>(`SELECT self_identity FROM account WHERE id = 'acc_demo-signal'`)!.self_identity;
  const mine = await people.get(me);
  expect(mine.relationship).toBeUndefined();
  expect(mine.friends!.length).toBeGreaterThan(5);
  offline.add('acc_demo-signal');
  const id = identityOf('signal');
  const v = await people.get(id, true);
  expect(v.stale).toContain('is not connected');
  expect(v.bio).toBe('on the wall, back at 8');
  offline.delete('acc_demo-signal');
});

test('your own bio through the demo adapter: set, kept, and on Signal the status line too', async () => {
  const me = store.one<{ self_identity: string }>(`SELECT self_identity FROM account WHERE id = 'acc_demo-signal'`)!.self_identity;
  const v = await people.setBio(me, 'climbing at 6');
  expect(v.bio).toBe('climbing at 6');
  expect(people.kept([me])[0].bio).toBe('climbing at 6');
  expect(JSON.parse(store.one<{ status: string }>('SELECT status FROM identity WHERE id = ?', me)!.status).text).toBe('climbing at 6');
  expect((await people.get(me, true)).bio).toBe('climbing at 6');
  await expect(people.setBio(me, 'x'.repeat(141))).rejects.toThrow('Too long for Signal: 141 characters, and it takes 140.');
  // Someone else's, and Matrix's (no bio there): refused before asking.
  asked.length = 0;
  await expect(people.setBio(identityOf('signal'), 'hi')).rejects.toThrow('Only your own profile');
  const mx = store.one<{ self_identity: string }>(`SELECT self_identity FROM account WHERE id = 'acc_demo-matrix'`)!.self_identity;
  await expect(people.setBio(mx, 'hi')).rejects.toThrow('cannot be changed from here');
  expect(asked.length).toBe(0);
});

test('an adapter without profile: said plainly, nothing asked', async () => {
  const acc = store.account('acc_demo-matrix')!;
  store.ingest(acc, { t: 'hello', network: 'matrix', version: '1', capabilities: ['send'] });
  asked.length = 0;
  const v = await people.get(identityOf('matrix'), true);
  expect(v.stale).toBe('The Matrix adapter cannot read profiles yet.');
  expect(asked.length).toBe(0);
});
