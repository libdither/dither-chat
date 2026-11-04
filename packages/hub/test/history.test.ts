/**
 * What the hub keeps of what changes and what the networks take back (docs/history.md): names, descriptions and
 * members as they change; earlier versions of edited messages; deleted and disappeared messages kept or emptied, by
 * source; and forgetting what was kept.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { Store, type AccountRow } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-history-'));
let store: Store;
let sig: AccountRow;
let dc: AccountRow;
let n = 0;

const conv = (acc: AccountRow, f: Partial<P.ConversationFact> & { nativeId: string }) => store.ingest(acc, { t: 'conversation', conversation: { shape: 'group', ...f } });
const say = (acc: AccountRow, conversation: string, body: string, author = 'ann', nativeId = `m${++n}`) => {
  store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts: 1_000_000 + n, body }, live: true });
  return hubId('msg', acc.network, nativeId);
};
const changes = (kind: P.ChangeView['target']['kind'], acc: AccountRow, native: string) => store.changes([{ kind, id: hubId(kind === 'conversation' ? 'cnv' : kind === 'space' ? 'spc' : 'idn', acc.network, native) }]);
const msg = (id: string) => store.messageViews([store.one<Record<string, any>>('SELECT * FROM message WHERE id = ?', id)!])[0];

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  sig = store.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
  dc = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
  store.ingest(sig, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me', isSelf: true } });
  store.ingest(dc, { t: 'status', status: 'online', self: { nativeId: 'dme', displayName: 'Me', isSelf: true } });
  for (const a of ['ann', 'bob', 'cy']) store.ingest(sig, { t: 'identity', identity: { nativeId: a, displayName: a.toUpperCase() } });
  store.ingest(dc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann' } });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('changes', () => {
  test('a group renamed, its description set and changed; filling in a conversation first seen from a message is not a change', () => {
    say(sig, 'g1', 'hi');
    conv(sig, { nativeId: 'g1', name: 'Climbing', participants: ['me', 'ann', 'bob'] });
    expect(changes('conversation', sig, 'g1')).toEqual([]);
    conv(sig, { nativeId: 'g1', name: 'Climbing crew', topic: 'Tuesdays', participants: ['me', 'ann', 'bob'] });
    conv(sig, { nativeId: 'g1', name: 'Climbing crew', topic: 'Tuesdays and Thursdays', participants: ['me', 'ann', 'bob'] });
    const c = changes('conversation', sig, 'g1');
    expect(c.map((x) => [x.field, x.old, x.new])).toEqual([
      ['topic', 'Tuesdays', 'Tuesdays and Thursdays'],
      ['topic', null, 'Tuesdays'],
      ['name', 'Climbing', 'Climbing crew'],
    ]);
  });

  test('who joined and who left a group', () => {
    conv(sig, { nativeId: 'g1', name: 'Climbing crew', participants: ['me', 'ann', 'cy'] });
    const m = changes('conversation', sig, 'g1').filter((x) => x.field === 'member');
    const id = (x: string) => hubId('idn', 'signal', x);
    expect(m.map((x) => [x.old, x.new, x.identityId])).toEqual(expect.arrayContaining([[null, id('cy'), id('cy')], [id('bob'), null, id('bob')]]));
  });

  test('a name that flips back within a day cancels out', () => {
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Annie' } });
    expect(changes('identity', dc, 'ann').map((x) => [x.field, x.old, x.new])).toEqual([['displayName', 'Ann', 'Annie']]);
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann' } });
    expect(changes('identity', dc, 'ann')).toEqual([]);
  });

  test('nothing when changes are not kept', () => {
    store.setRetention({ ...DEFAULT_RETENTION, changes: false });
    conv(sig, { nativeId: 'g1', name: 'Crew' });
    expect(changes('conversation', sig, 'g1')[0].new).not.toBe('Crew');
    store.setRetention(DEFAULT_RETENTION);
  });
});

describe('edits', () => {
  test('each earlier version, oldest first, then how it reads now', () => {
    say(sig, 'g1', 'see you at 6', 'ann', 'e1');
    store.ingest(sig, { t: 'message', message: { nativeId: 'e1', conversation: 'g1', author: 'ann', ts: 1, editedTs: 2000, body: 'see you at 7' } });
    store.ingest(sig, { t: 'message', message: { nativeId: 'e1', conversation: 'g1', author: 'ann', ts: 1, editedTs: 3000, body: 'see you at 7:30' } });
    const id = hubId('msg', 'signal', 'e1');
    expect(store.messageHistory(id)!.versions.map((v) => v.body)).toEqual(['see you at 6', 'see you at 7', 'see you at 7:30']);
    expect(msg(id).edits).toBe(2);
  });

  test('not kept where edits are off for the source', () => {
    store.setRetention({ ...DEFAULT_RETENTION, sources: { signal: { edits: false } } });
    say(sig, 'g1', 'one', 'ann', 'e2');
    store.ingest(sig, { t: 'message', message: { nativeId: 'e2', conversation: 'g1', author: 'ann', ts: 1, editedTs: 2, body: 'two' } });
    expect(msg(hubId('msg', 'signal', 'e2')).edits).toBeUndefined();
    store.setRetention(DEFAULT_RETENTION);
  });
});

describe('deleted and disappeared messages', () => {
  test('a deleted message keeps its words, and says how it went', () => {
    const id = say(sig, 'g1', 'oops, wrong chat');
    store.ingest(sig, { t: 'delete', conversation: 'g1', nativeId: `m${n}` });
    const m = msg(id);
    expect(m.deleted).toBe(true);
    expect(m.body).toBe('oops, wrong chat');
    expect(m.gone).toMatchObject({ how: 'deleted', kept: true });
    // The network sending it again, emptied, keeps what was kept.
    store.ingest(sig, { t: 'message', message: { nativeId: `m${n}`, conversation: 'g1', author: 'ann', ts: 1, body: '' } });
    expect(msg(id).body).toBe('oops, wrong chat');
  });

  test('a message whose timer ran out is kept as disappeared', () => {
    const id = say(sig, 'g1', 'this disappears');
    store.ingest(sig, { t: 'delete', conversation: 'g1', nativeId: `m${n}`, reason: 'expired' });
    expect(msg(id).gone).toMatchObject({ how: 'disappeared', kept: true });
    expect(msg(id).body).toBe('this disappears');
  });

  test('what you delete yourself is not kept', () => {
    const id = say(sig, 'g1', 'mine', 'me');
    store.ingest(sig, { t: 'delete', conversation: 'g1', nativeId: `m${n}` });
    expect(msg(id).body).toBe('');
    expect(msg(id).gone).toMatchObject({ how: 'deleted', kept: false });
  });

  test('a source set not to keep them empties them, as before; an account overrides its network', () => {
    store.setRetention({ ...DEFAULT_RETENTION, sources: { discord: { deleted: false }, [sig.id]: { disappearing: false } } });
    const a = say(dc, 'c1', 'gone for good');
    store.ingest(dc, { t: 'delete', conversation: 'c1', nativeId: `m${n}` });
    expect(msg(a).body).toBe('');
    const b = say(sig, 'g1', 'timer');
    store.ingest(sig, { t: 'delete', conversation: 'g1', nativeId: `m${n}`, reason: 'expired' });
    expect(msg(b).body).toBe('');
    const c = say(sig, 'g1', 'still kept');
    store.ingest(sig, { t: 'delete', conversation: 'g1', nativeId: `m${n}` });
    expect(msg(c).body).toBe('still kept');
    store.setRetention(DEFAULT_RETENTION);
  });

  test('forgetting what was kept', () => {
    expect(store.eraseKept('deleted')).toBeGreaterThan(0);
    expect(store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM message WHERE gone_how = 'deleted' AND body != ''`)!.n).toBe(0);
    expect(store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM message WHERE gone_how = 'disappeared' AND body != ''`)!.n).toBe(1);
    expect(store.eraseKept('edits')).toBe(2);
    expect(store.messageHistory(hubId('msg', 'signal', 'e1'))!.versions.length).toBe(1);
  });
});

describe('pins, roles, statuses, receipts, reactions taken back', () => {
  test('a pin and an unpin, by whom; the message says whether it is pinned now', () => {
    const id = say(sig, 'g1', 'gym opens at 7');
    store.ingest(sig, { t: 'pin', conversation: 'g1', message: `m${n}`, pinned: true, by: 'bob', ts: 5000 });
    expect(msg(id).pinned).toBe(true);
    expect(msg(id).events).toBe(1);
    store.ingest(sig, { t: 'pin', conversation: 'g1', message: `m${n}`, pinned: false, by: 'ann', ts: 6000 });
    expect(msg(id).pinned).toBeUndefined();
    const h = store.messageHistory(id)!;
    expect(h.events.map((e) => [e.kind, e.actorId])).toEqual([
      ['pin', hubId('idn', 'signal', 'bob')],
      ['unpin', hubId('idn', 'signal', 'ann')],
    ]);
    expect(h.identities.map((i) => i.displayName).sort()).toEqual(['ANN', 'BOB']);
  });

  test('history sent again (a phone re-syncing) counts once', () => {
    const id = say(sig, 'g1', 'repeat me');
    const pin = () => store.ingest(sig, { t: 'pin', conversation: 'g1', message: `m${n}`, pinned: true, by: 'bob', ts: 777_000 });
    pin();
    pin();
    expect(store.messageHistory(id)!.events.length).toBe(1);
    const role = () => store.ingest(sig, { t: 'role', target: { kind: 'conversation', nativeId: 'g7' }, member: 'cy', role: 'Admin', given: true, ts: 888_000 });
    conv(sig, { nativeId: 'g7', name: 'Seven' });
    role();
    role();
    expect(changes('conversation', sig, 'g7').filter((c) => c.field === 'role').length).toBe(1);
  });

  test('a role given and taken, with whose it is', () => {
    store.ingest(sig, { t: 'role', target: { kind: 'conversation', nativeId: 'g1' }, member: 'cy', role: 'Admin', given: true, by: 'ann' });
    store.ingest(sig, { t: 'role', target: { kind: 'conversation', nativeId: 'g1' }, member: 'cy', role: 'Admin', given: false });
    const r = changes('conversation', sig, 'g1').filter((c) => c.field === 'role');
    const cy = hubId('idn', 'signal', 'cy');
    expect(r.map((c) => [c.old, c.new, c.identityId])).toEqual([
      [{ identityId: cy, role: 'Admin' }, null, cy],
      [null, { identityId: cy, role: 'Admin' }, cy],
    ]);
    expect(r[1].actorId).toBe(hubId('idn', 'signal', 'ann'));
  });

  test('a status: the first is where history starts; each change after, typed', () => {
    store.ingest(dc, { t: 'customStatus', who: 'ann', text: 'at the crag', emoji: '🧗' });
    expect(changes('identity', dc, 'ann').filter((c) => c.field === 'status')).toEqual([]);
    store.ingest(dc, { t: 'customStatus', who: 'ann', text: 'at the crag', emoji: '🧗' });
    store.ingest(dc, { t: 'customStatus', who: 'ann' });
    store.ingest(dc, { t: 'customStatus', who: 'ann', text: 'back' });
    const s = changes('identity', dc, 'ann').filter((c) => c.field === 'status');
    expect(s.map((c) => [c.old, c.new])).toEqual([
      [null, { text: 'back' }],
      [{ text: 'at the crag', emoji: '🧗' }, null],
    ]);
    expect(store.identitiesByIds([hubId('idn', 'discord', 'ann')])[0].status).toMatchObject({ text: 'back' });
  });

  test('receipts on your own messages; Matrix read up to counts the earlier ones', () => {
    const mine = say(sig, 'g1', 'leaving now', 'me');
    store.ingest(sig, { t: 'receipt', conversation: 'g1', messages: [`m${n}`], who: 'ann', state: 'delivered', ts: 100 });
    store.ingest(sig, { t: 'receipt', conversation: 'g1', messages: [`m${n}`], who: 'ann', state: 'read', ts: 200 });
    store.ingest(sig, { t: 'receipt', conversation: 'g1', messages: [`m${n}`], who: 'bob', state: 'read', ts: 300 });
    expect(msg(mine).receipts).toEqual({ delivered: 1, read: 2, played: 0, latest: { identityId: hubId('idn', 'signal', 'bob'), state: 'read', at: 300 } });
    // Theirs are not kept.
    const theirs = say(sig, 'g1', 'ok');
    store.ingest(sig, { t: 'receipt', conversation: 'g1', messages: [`m${n}`], who: 'bob', state: 'read', ts: 400 });
    expect(msg(theirs).receipts).toBeUndefined();

    const mx = store.createAccount({ network: 'matrix', label: 'm', color: '#222', adapter: 'matrix' });
    store.ingest(mx, { t: 'status', status: 'online', self: { nativeId: '@me:x', displayName: 'Me', isSelf: true } });
    const a = say(mx, '!r:x', 'one', '@me:x');
    const b = say(mx, '!r:x', 'two', '@me:x');
    store.ingest(mx, { t: 'receipt', conversation: '!r:x', messages: [`m${n}`], who: '@kai:x', state: 'read', ts: 900 });
    expect([msg(a).receipts?.read, msg(b).receipts?.read]).toEqual([1, 1]);
  });

  test('a reaction taken back is kept, a moderator clearing them too; your own are not', () => {
    const id = say(dc, 'c1', 'nice');
    const react = (author: string, remove = false) => store.ingest(dc, { t: 'reaction', conversation: 'c1', message: `m${n}`, author, key: '👍', remove });
    react('ann');
    react('ann', true);
    react('dme');
    react('dme', true);
    react('ann');
    store.ingest(dc, { t: 'reactionsCleared', conversation: 'c1', message: `m${n}` });
    const ev = store.messageHistory(id)!.events;
    expect(ev.map((e) => [e.kind, e.data])).toEqual([
      ['unreact', { key: '👍', style: 'normal' }],
      ['unreact', { key: '👍', style: 'normal', cleared: true }],
    ]);
  });

  test('a message gone from the hub takes its history with it', () => {
    const id = say(sig, 'g9', 'x', 'me');
    store.ingest(sig, { t: 'receipt', conversation: 'g9', messages: [`m${n}`], who: 'ann', state: 'read', ts: 1 });
    store.ingest(sig, { t: 'pin', conversation: 'g9', message: `m${n}`, pinned: true });
    store.ingest(sig, { t: 'leave', kind: 'conversation', nativeId: 'g9' });
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM receipt WHERE message_id = ?', id)!.n).toBe(0);
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM message_event WHERE message_id = ?', id)!.n).toBe(0);
  });
});

test('the first change log comes across: values as JSON, edits into message events', () => {
  const d2 = mkdtempSync(join(tmpdir(), 'dither-log-v1-'));
  try {
    const path = join(d2, 'hub.sqlite');
    const s1 = new Store(path, (raw) => raw ?? null);
    const acc = s1.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
    s1.ingest(acc, { t: 'message', message: { nativeId: 'x', conversation: 'g', author: 'a', ts: 1, body: 'now' } });
    const mid = hubId('msg', 'signal', 'x');
    s1.db.exec(`DROP TABLE change_log; DROP TABLE message_event; CREATE TABLE change_log (id INTEGER PRIMARY KEY,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('conversation', 'space', 'identity', 'message')), target_id TEXT NOT NULL,
      field TEXT NOT NULL, old TEXT, new TEXT, at INTEGER NOT NULL, account_id TEXT);
      CREATE INDEX change_log_target ON change_log(target_kind, target_id, at);`);
    s1.db.query(`INSERT INTO change_log (target_kind, target_id, field, old, new, at) VALUES ('conversation', 'cnv_g', 'disappearing', '0', '604800', 5), ('message', ?, 'body', 'before', 'now', 6)`).run(mid);
    s1.db.close();
    const s2 = new Store(path, (raw) => raw ?? null);
    expect(s2.changes([{ kind: 'conversation', id: 'cnv_g' }]).map((c) => [c.old, c.new])).toEqual([['0', '604800']]);
    expect(s2.messageHistory(mid)!.versions.map((v) => v.body)).toEqual(['before', 'now']);
    expect(s2.one(`SELECT name FROM sqlite_master WHERE name = 'change_log_v1'`)).toBeNull();
    s2.db.close();
  } finally {
    rmSync(d2, { recursive: true, force: true });
  }
});
