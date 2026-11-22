/**
 * Threads and the people in them (docs/people-graph.md, docs/history.md): a Zulip channel names nobody and its topics
 * are threads, so the graph links a topic's authors to the organization through the channel, and turns in a topic few
 * people wrote in tie them as a small group's do. A person's roles and user groups, kept against the organization,
 * show on their own History while changes are kept. A profile's facts that name people, and a custom status emoji's
 * picture, come back in hub ids and signed paths.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION, GRAPH_SOURCE } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { addTables } from '../src/add.ts';
import { closeness } from '../src/closeness.ts';
import { peopleGraph } from '../src/graph.ts';
import { People } from '../src/people.ts';
import { Store, type AccountRow } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-topics-'));
let store: Store;
let z: AccountRow;
const HOST = 'chat.example.org';
const ORG = hubId('spc', 'zulip', HOST);
const uid = (n: number) => `${HOST}/u/${n}`;
const zid = (n: number) => hubId('idn', 'zulip', uid(n));
const T0 = Date.UTC(2025, 5, 2, 10);
let n = 0;
const say = (topic: string, author: number, ts: number) => store.ingest(z, { t: 'message', message: { nativeId: `${HOST}/m/${++n}`, conversation: `${HOST}/s/3/t/${topic}`, author: uid(author), ts, body: 'x' } });

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), (raw) => (raw ? `/signed/${raw}` : null));
  addTables(store.db);
  store.setRetention({ ...DEFAULT_RETENTION, changes: true });
  z = store.createAccount({ network: 'zulip', label: 'z', color: '#6492FE', adapter: 'zulip' });
  store.ingest(z, { t: 'status', status: 'online', self: { nativeId: uid(8), displayName: 'Quinn Park', isSelf: true } });
  for (let i = 9; i < 40; i++) store.ingest(z, { t: 'identity', identity: { nativeId: uid(i), displayName: `Person ${i}` } });
  store.ingest(z, { t: 'space', space: { nativeId: HOST, kind: 'community', name: 'Example Org' } });
  // A channel with no participants, as Zulip's are, and its topics as threads in it.
  store.ingest(z, { t: 'conversation', conversation: { nativeId: `${HOST}/s/3`, shape: 'channel', variant: 'forum', name: 'general', spaces: [{ nativeId: HOST }] } });
  for (const t of ['plans', 'launch'])
    store.ingest(z, { t: 'conversation', conversation: { nativeId: `${HOST}/s/3/t/${t}`, shape: 'thread', name: t, parentConversation: `${HOST}/s/3` } });
  // A topic three people wrote in: 9 answers 10, then 10 answers 9 (two turns), and you in between tie no one.
  say('plans', 10, T0);
  say('plans', 9, T0 + 60_000);
  say('plans', 10, T0 + 120_000);
  say('plans', 8, T0 + 180_000);
  // A topic 25 people wrote in: one after another, too many to be a conversation.
  for (let i = 11; i < 36; i++) say('launch', i, T0 + i * 1000);
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a topic's authors link to the organization through their channel; you are left out", () => {
  const g = peopleGraph(store);
  const org = g.places.findIndex((p) => p.id === ORG);
  expect(org).toBeGreaterThanOrEqual(0);
  const linked = new Map<string, number>();
  for (let i = 0; i < g.links.length; i += 3) if (g.links[i + 1] === org) linked.set(g.people[g.links[i]].id, g.links[i + 2]);
  expect(linked.get(zid(9))).toBe(GRAPH_SOURCE.author);
  expect(linked.get(zid(35))).toBe(GRAPH_SOURCE.author);
  expect(linked.size).toBe(2 + 25);
  expect(g.people.some((p) => p.id === zid(8))).toBe(false);
});

test('turns tie people in a topic few wrote in, not in a crowded one', () => {
  const run = closeness(store.db);
  const key = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  // Two turns between 9 and 10 (0.5 each), in June 2025.
  expect(run.ties[key(zid(9), zid(10))]).toEqual([2025 * 12 + 5, 10]);
  // The crowded topic: 25 authors one after another, no ties.
  expect(run.ties[key(zid(11), zid(12))]).toBeUndefined();
});

test("a person's roles and user groups, kept against the organization, show on their own History while changes are kept", () => {
  store.ingest(z, { t: 'role', target: { kind: 'space', nativeId: HOST }, member: uid(9), role: 'designers', given: true, ts: T0 });
  store.ingest(z, { t: 'role', target: { kind: 'space', nativeId: HOST }, member: uid(10), role: 'designers', given: true, ts: T0 + 1 });
  store.ingest(z, { t: 'role', target: { kind: 'space', nativeId: HOST }, member: uid(9), role: 'Member', given: false, ts: T0 + 2 });
  const mine = () => store.changes([{ kind: 'identity', id: zid(9) }], 100, { except: ['status', 'presence'], rolesOf: [zid(9)] });
  expect(mine().map((c) => [c.target.id, c.field, c.old, c.new, c.identityId])).toEqual([
    [ORG, 'role', { identityId: zid(9), role: 'Member' }, null, zid(9)],
    [ORG, 'role', null, { identityId: zid(9), role: 'designers' }, zid(9)],
  ]);
  // Only status asked for: no roles.
  expect(store.changes([{ kind: 'identity', id: zid(9) }], 100, { fields: ['status'], rolesOf: [zid(9)] })).toEqual([]);
  // The organization's History still has all three.
  expect(store.changes([{ kind: 'space', id: ORG }]).length).toBe(3);
  // Changes not kept: not on the person's page.
  store.setRetention({ ...DEFAULT_RETENTION, changes: false });
  expect(mine()).toEqual([]);
  store.setRetention({ ...DEFAULT_RETENTION, changes: true });
});

test("a profile's facts that name people come back as hub identities, and a custom status emoji's picture signed", () => {
  const people = new People({ store } as any);
  const about: P.PersonAbout = {
    displayName: 'Build Bot',
    facts: [{ label: 'Role', value: 'Bot' }, { label: 'Owner', value: 'Person 9', people: [uid(9)] }],
    status: { text: 'Deploying', emoji: ':party_parrot:', emojiUrl: 'zulip:/user_avatars/2/emoji/42.png' },
  };
  const v = people.view(zid(12), z.id, about, 1, undefined);
  expect(v.facts).toEqual([{ label: 'Role', value: 'Bot' }, { label: 'Owner', value: 'Person 9', people: [zid(9)] }]);
  expect(v.status).toEqual({ text: 'Deploying', emoji: ':party_parrot:', emojiUrl: '/signed/zulip:/user_avatars/2/emoji/42.png' });
  expect(v.identities.map((i) => i.id)).toContain(zid(9));
});
