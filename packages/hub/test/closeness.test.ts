/**
 * Closeness (closeness.ts): how much you have had to do with each person, month by month. Direct chats count every
 * message either way, groups count their messages less the bigger the group, servers count replies between you and
 * their mentions of you; bots count for nothing; activityView sums a person's identities, and the graph sends you
 * apart.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubId } from '@dither-chat/protocol/ids';
import { activityView, closeness } from '../src/closeness.ts';
import { peopleGraph } from '../src/graph.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-closeness-'));
let store: Store;
const did = (n: string) => hubId('idn', 'discord', n);
const sid = (n: string) => hubId('idn', 'signal', n);
const month = (y: number, m: number) => y * 12 + m;
const MAR24 = Date.UTC(2024, 2, 15);
const JAN23 = Date.UTC(2023, 0, 10);

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  const d = store.createAccount({ network: 'discord', label: 'main', color: '#111', adapter: 'discord' });
  const s = store.createAccount({ network: 'signal', label: 's', color: '#333', adapter: 'signal' });
  store.ingest(d, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me', isSelf: true } });
  store.ingest(s, { t: 'status', status: 'online', self: { nativeId: 'mes', displayName: 'Me', isSelf: true } });
  for (const a of ['ann', 'dee']) store.ingest(d, { t: 'identity', identity: { nativeId: a, displayName: a.toUpperCase() } });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'helper', displayName: 'Helper', isBot: true } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm-bot', shape: 'direct', participants: ['me', 'helper'] } });
  for (const a of ['ann-s', 'fay']) store.ingest(s, { t: 'identity', identity: { nativeId: a, displayName: a.toUpperCase() } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm-ann', shape: 'direct', participants: ['me', 'ann'] } });
  store.ingest(s, { t: 'conversation', conversation: { nativeId: 'grp', shape: 'group', name: 'Three', participants: ['mes', 'ann-s', 'fay'] } });
  store.ingest(d, { t: 'space', space: { nativeId: 'g1', kind: 'community', name: 'Guild' } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'ch', shape: 'channel', name: 'general', spaces: [{ nativeId: 'g1' }], participants: ['me', 'dee'] } });
  store.mergePersons(store.ensurePerson(did('ann')), store.ensurePerson(sid('ann-s')));
  let n = 0;
  const msg = (acc: typeof d, conversation: string, author: string, ts: number, extra: Record<string, unknown> = {}) =>
    store.ingest(acc, { t: 'message', message: { nativeId: `m${++n}`, conversation, author, ts, body: 'x', ...extra } });
  // A direct chat: two from Ann, one from you, all counted for Ann.
  msg(d, 'dm-ann', 'ann', MAR24);
  msg(d, 'dm-ann', 'ann', MAR24 + 1);
  msg(d, 'dm-ann', 'me', MAR24 + 2);
  // A bot's direct chat, however busy.
  for (let i = 0; i < 5; i++) msg(d, 'dm-bot', 'helper', MAR24 + i);
  // A group of three: each of their messages is worth 2/3; yours count for no one.
  for (let i = 0; i < 3; i++) msg(s, 'grp', 'fay', JAN23 + i);
  msg(s, 'grp', 'ann-s', JAN23 + 5);
  msg(s, 'grp', 'mes', JAN23 + 6);
  // A server channel: Dee replies to you (1.5) and mentions you (1); an @everyone and talk among others do not count.
  msg(d, 'ch', 'me', MAR24);
  msg(d, 'ch', 'dee', MAR24 + 1, { replyTo: `m${n}` });
  msg(d, 'ch', 'dee', MAR24 + 2, { mentionsSelf: true });
  msg(d, 'ch', 'dee', MAR24 + 3, { mentionsSelf: true, mentionsAll: true });
  msg(d, 'ch', 'dee', MAR24 + 4);
  store.db.query('INSERT INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?)').run(did('dee'), d.id, JSON.stringify({ mutualFriends: [{ id: 'a' }, { id: 'b' }] }), 1);
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('each kind of talk, by month, weight × 10; you are never counted', () => {
  const run = closeness(store.db);
  expect(run.byIdentity[did('ann')]).toEqual([month(2024, 2), 30]);
  expect(run.byIdentity[sid('fay')]).toEqual([month(2023, 0), 20]);
  expect(run.byIdentity[sid('ann-s')]).toEqual([month(2023, 0), 7]);
  expect(run.byIdentity[did('dee')]).toEqual([month(2024, 2), 25]);
  expect(Object.keys(run.byIdentity).some((k) => k === did('me') || k === sid('mes'))).toBe(false);
  expect(run.byIdentity[did('helper')]).toBeUndefined();
  expect(run.mutual).toEqual({ [did('dee')]: 2 });
  expect(run.from).toBe(month(2023, 0));
});

test('a person is the sum of their identities, keyed as the graph keys them', () => {
  const view = activityView(store, closeness(store.db));
  const ann = store.ensurePerson(did('ann'));
  expect(view.people[ann]).toEqual([month(2023, 0), 7, month(2024, 2), 30]);
  expect(view.people[did('dee')]).toEqual([month(2024, 2), 25]);
  expect(view.mutual[did('dee')]).toBe(2);
});

test('the graph sends you apart, by your name, and everyone you have a direct chat with', () => {
  const g = peopleGraph(store);
  expect(g.me?.name).toBe('Me');
  expect(g.people.some((p) => p.name === 'Me')).toBe(false);
  expect(g.people.find((p) => p.id === store.ensurePerson(did('ann')))?.dm.length).toBeGreaterThan(0);
});

test('places: your own messages in a server (any channel) or a group, and the time you spent in them', () => {
  const MAY24 = Date.UTC(2024, 4, 3);
  const visit = (id: string, conv: string | null, space: string | null, active: number) =>
    store.db
      .query(`INSERT INTO visit (id, device, view, conversation_id, space_id, start_at, end_at, active, source, updated_at) VALUES (?, 'dev', 'conversation', ?, ?, ?, ?, ?, 'rail', ?)`)
      .run(id, conv, space, MAY24, MAY24 + active * 1000, active, MAY24);
  const ch = hubId('cnv', 'discord', 'ch');
  const guild = hubId('spc', 'discord', 'g1');
  const grp = hubId('cnv', 'signal', 'grp');
  visit('v1', ch, null, 120);
  visit('v2', null, guild, 60);
  visit('v3', hubId('cnv', 'discord', 'dm-ann'), null, 300);
  const run = closeness(store.db);
  expect(run.byPlace[guild]).toEqual([month(2024, 2), 10, month(2024, 4), 30]);
  expect(run.byPlace[grp]).toEqual([month(2023, 0), 10]);
  // Time in a direct chat counts for the person in it.
  expect(run.byIdentity[did('ann')]).toEqual([month(2024, 2), 30, month(2024, 4), 50]);
  expect(activityView(store, run).places?.[guild]).toEqual(run.byPlace[guild]);
  store.db.query('DELETE FROM visit').run();
});

test('the graph says which accounts list someone as a friend', () => {
  const d = (store.db.query(`SELECT id FROM account WHERE network = 'discord'`).get() as { id: string }).id;
  store.db.query(`INSERT INTO person_link (account_id, identity_id, relationship) VALUES (?, ?, 'friend')`).run(d, did('dee'));
  const g = peopleGraph(store);
  const ai = g.accounts.indexOf(d);
  expect(g.people.find((p) => p.id === did('dee'))?.friend).toEqual([ai]);
  expect(g.people.find((p) => p.id === store.ensurePerson(did('ann')))?.friend).toBeUndefined();
});
