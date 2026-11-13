/**
 * People on a network that keeps your nicknames and notes, safety numbers and blocks (Signal's adapter, capabilities
 * contactNotes, safetyNumbers, block): what the hub takes from the network and sends back (store.ts networkNotes,
 * people.ts), a network's archive followed (or not), and a blocked person who never alerts. A stub adapter answers.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { blockedByYou } from '../src/add.ts';
import { People } from '../src/people.ts';
import { mediaSigner } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { UsageStore } from '../src/usage.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-sigpeople-'));
let store: Store;
let people: People;
let acc: ReturnType<Store['createAccount']>;
const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002';
const sent: P.AdapterCommand[] = [];
let answer: (c: any) => unknown = () => ({});
const alice = () => hubId('idn', 'signal', ALICE);
const ingest = (ev: P.AdapterEvent) => {
  store.ingest(store.account(acc.id)!, ev);
  store.flush();
};
const row = (sql: string, ...args: unknown[]) => store.one<Record<string, any>>(sql, ...args);

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), mediaSigner('s'));
  acc = store.createAccount({ id: 'acc_sig', network: 'signal', label: 'phone', color: '#000', adapter: 'signal' });
  ingest({ t: 'hello', network: 'signal', version: 't', capabilities: ['profile', 'editProfile', 'relationships', 'disconnect', 'block', 'safetyNumbers', 'contactNotes'] });
  ingest({ t: 'status', status: 'online', self: { nativeId: SELF, handle: '+15550100', isSelf: true } });
  ingest({ t: 'identity', identity: { nativeId: ALICE, handle: '+15550137', displayName: 'Alice Chen', contact: true } });
  ingest({ t: 'conversation', conversation: { nativeId: `dm:${SELF}:${ALICE}`, shape: 'direct', participants: [SELF, ALICE], encrypted: true } });
  people = new People({
    store,
    online: () => true,
    command: async <T>(_a: string, cmd: any) => {
      sent.push(cmd);
      return answer(cmd) as T;
    },
  });
  store.contactNotesOut = (id, change) => people.pushContactNotes(id, change);
});

afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a nickname from the phone becomes yours when you had none; yours goes back to the network', async () => {
  ingest({ t: 'identity', identity: { nativeId: ALICE, displayName: 'Alice Chen', nickname: 'Ali' } });
  expect(row('SELECT nickname, net_nickname FROM identity WHERE id = ?', alice())).toEqual({ nickname: 'Ali', net_nickname: 'Ali' });
  // Changed on the phone while yours is still what it said: taken.
  ingest({ t: 'identity', identity: { nativeId: ALICE, nickname: 'Al' } });
  expect(row('SELECT nickname FROM identity WHERE id = ?', alice())!.nickname).toBe('Al');
  // Yours changed here: it goes to the network, and its echo changes nothing.
  store.setIdentityNickname(alice(), 'Alice C');
  people.pushContactNotes(alice(), { nickname: 'Alice C' });
  expect(sent.at(-1)).toEqual({ t: 'setContact', who: ALICE, nickname: 'Alice C' });
  ingest({ t: 'identity', identity: { nativeId: ALICE, nickname: 'Alice C' } });
  expect(row('SELECT nickname, net_nickname FROM identity WHERE id = ?', alice())).toEqual({ nickname: 'Alice C', net_nickname: 'Alice C' });
  // Both changed: yours stays, the phone keeps its own.
  store.setIdentityNickname(alice(), 'Mine');
  ingest({ t: 'identity', identity: { nativeId: ALICE, nickname: 'Theirs' } });
  expect(row('SELECT nickname FROM identity WHERE id = ?', alice())!.nickname).toBe('Mine');
  // Cleared on the phone while yours is what it said: cleared here too.
  ingest({ t: 'identity', identity: { nativeId: ALICE, nickname: 'Mine' } });
  ingest({ t: 'identity', identity: { nativeId: ALICE, nickname: '' } });
  expect(row('SELECT nickname FROM identity WHERE id = ?', alice())!.nickname).toBeNull();
});

test("notes: the phone's is taken, and two different ones are joined, the joined one going back", async () => {
  const pid = row('SELECT person_id FROM identity WHERE id = ?', alice())!.person_id;
  ingest({ t: 'identity', identity: { nativeId: ALICE, note: 'climbs on thursdays' } });
  expect(row('SELECT note FROM person WHERE id = ?', pid)!.note).toBe('climbs on thursdays');
  store.updatePerson(pid, { note: 'owes me a rope' });
  const n = sent.length;
  ingest({ t: 'identity', identity: { nativeId: ALICE, note: 'climbs on fridays now' } });
  const joined = 'owes me a rope\n\nclimbs on fridays now';
  expect(row('SELECT note FROM person WHERE id = ?', pid)!.note).toBe(joined);
  expect(sent.slice(n)).toEqual([{ t: 'setContact', who: ALICE, note: joined }]);
  // Its echo is the same text: nothing more.
  ingest({ t: 'identity', identity: { nativeId: ALICE, note: joined } });
  expect(sent.length).toBe(n + 1);
  people.pushPersonNote(pid, 'just this');
  expect(sent.at(-1)).toEqual({ t: 'setContact', who: ALICE, note: 'just this' });
});

test('verify and block go to the account that knows them; a blocked person never alerts', async () => {
  answer = (c) => (c.t === 'verify' ? { displayName: 'Alice Chen', safety: { digits: '1'.repeat(60), trust: 'verified' } } : c.t === 'block' ? { blocked: !c.unblock } : {});
  const v = await people.verify(alice(), { safetyNumber: '1'.repeat(60) });
  expect(sent.at(-1)).toEqual({ t: 'verify', who: ALICE, safetyNumber: '1'.repeat(60) });
  expect(v.safety).toEqual({ digits: '1'.repeat(60), trust: 'verified' });
  await expect(people.verify(alice(), {})).rejects.toThrow('safetyNumber');
  expect(await people.block(alice(), false)).toEqual({ blocked: true, accountId: acc.id });
  expect(blockedByYou(store.db, alice())).toBe(true);
  ingest({ t: 'message', live: true, message: { nativeId: `${ALICE}:1`, conversation: `dm:${SELF}:${ALICE}`, author: ALICE, ts: Date.now(), body: 'hey!!' } });
  const { Triage } = await import('../src/triage.ts');
  const d = await new Triage(store).decide(hubId('msg', 'signal', `${ALICE}:1`));
  expect(d?.decision).toBe('silent');
  expect(d?.reasons).toContain('From someone you blocked');
  expect(await people.block(alice(), true)).toEqual({ blocked: false, accountId: acc.id });
  expect(blockedByYou(store.db, alice())).toBe(false);
  await expect(people.block(hubId('idn', 'signal', SELF), false)).rejects.toThrow('your own');
});

test('your own profile: fields beyond the bio only where the last answer listed them', async () => {
  const me = hubId('idn', 'signal', SELF);
  answer = () => ({ displayName: 'Zyan', editable: ['bio', 'name', 'emoji', 'avatar', 'username'], username: { name: 'zyan.42', link: 'https://signal.me/#eu/x' } });
  await expect(people.setOwn(me, { name: 'Zyan Q' })).rejects.toThrow('cannot be changed');
  await people.setOwn(me, { bio: 'hi' });
  const v = await people.setOwn(me, { name: 'Zyan Q', username: 'zyan' });
  expect(sent.at(-1)).toEqual({ t: 'setProfile', change: { name: 'Zyan Q', username: 'zyan' } });
  expect(v.username).toEqual({ name: 'zyan.42', link: 'https://signal.me/#eu/x' });
  await expect(people.setOwn(me, {})).rejects.toThrow('Nothing');
});

test("a network's archive hides and shows the chat when it changes, unless turned off", () => {
  const conv = hubId('cnv', 'signal', `dm:${SELF}:${ALICE}`);
  const hidden = () => !!store.placePrefs().find((p) => p.id === conv)?.hidden;
  ingest({ t: 'conversation', conversation: { nativeId: `dm:${SELF}:${ALICE}`, shape: 'direct', participants: [SELF, ALICE], archived: true } });
  expect(hidden()).toBe(true);
  // A fact that does not say keeps it so.
  ingest({ t: 'conversation', conversation: { nativeId: `dm:${SELF}:${ALICE}`, shape: 'direct', participants: [SELF, ALICE] } });
  expect(row('SELECT archived FROM conversation WHERE id = ?', conv)!.archived).toBe(1);
  // Shown by hand: the same fact again does not hide it.
  store.patchPlacePrefs([{ kind: 'conversation', id: conv, hidden: false }]);
  ingest({ t: 'conversation', conversation: { nativeId: `dm:${SELF}:${ALICE}`, shape: 'direct', participants: [SELF, ALICE], archived: true } });
  expect(hidden()).toBe(false);
  ingest({ t: 'conversation', conversation: { nativeId: `dm:${SELF}:${ALICE}`, shape: 'direct', participants: [SELF, ALICE], archived: false } });
  const usage = new UsageStore(store.db);
  expect(usage.patchArrange({ followArchive: false }).followArchive).toBe(false);
  ingest({ t: 'conversation', conversation: { nativeId: `dm:${SELF}:${ALICE}`, shape: 'direct', participants: [SELF, ALICE], archived: true } });
  expect(hidden()).toBe(false);
  expect(usage.patchArrange({ followArchive: true }).followArchive).toBeUndefined(); // on: the default, left out
});
