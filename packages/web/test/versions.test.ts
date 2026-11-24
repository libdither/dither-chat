/** src/versions.ts, and what decides which version a change moves: syncmodel.ts's identity and conversation checks, memo.ts's props. */
import { expect, test } from 'bun:test';
import { effect, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { changed, convsChangedSince, dataVersion, flush, metaDataVersion, metaRev, onceListed, placesDataVersion, rev, timelineChanged, timelineRev } from '../src/versions.ts';
import { applyEventTo, conversationMetaChanged, emptyDb, identityVersion, onlyOpens, prefKey, putIdentity } from '../src/syncmodel.ts';
import { sameProps } from '../src/ui/memo.ts';

/** How many times each signal moved while `fn` ran and the flush after it. */
function moves(fn: () => void, extra: Record<string, { value: number }> = {}) {
  const seen: Record<string, number> = {};
  const all = { rev, metaRev, ...extra };
  const stops = Object.entries(all).map(([k, s]) => {
    seen[k] = -1;
    return effect(() => void (s.value, seen[k]++));
  });
  fn();
  flush();
  stops.forEach((s) => s());
  return seen;
}

test('a change counts at once; the signals move once for many changes', () => {
  const v = dataVersion();
  const seen = moves(() => {
    changed('list');
    changed('list');
    changed('list');
    expect(dataVersion()).toBe(v + 3);
  });
  expect(seen).toEqual({ rev: 1, metaRev: 0 });
  expect(rev.value).toBe(dataVersion());
});

test('names and settings move both; a timeline only its own', () => {
  expect(moves(() => changed('meta'))).toEqual({ rev: 1, metaRev: 1 });
  const a = timelineRev('c:a');
  const b = timelineRev('c:b');
  expect(moves(() => timelineChanged('c:a'), { a, b })).toEqual({ rev: 0, metaRev: 0, a: 1, b: 0 });
  // Quoted messages are every timeline's.
  expect(moves(() => timelineChanged(), { a, b })).toEqual({ rev: 0, metaRev: 0, a: 1, b: 1 });
  expect(moves(() => {}, { a })).toEqual({ rev: 0, metaRev: 0, a: 0 });
});

test('how things look moves metaRev but not what is where; a read moves neither', () => {
  const m = metaDataVersion();
  expect(moves(() => changed('shown'))).toEqual({ rev: 1, metaRev: 1 });
  expect(metaDataVersion()).toBe(m);
  expect(moves(() => changed('list'))).toEqual({ rev: 1, metaRev: 0 });
  expect(metaDataVersion()).toBe(m);
  changed('meta');
  flush();
  expect(metaDataVersion()).toBe(m + 1);
});

test('a folder opened or closed moves what is where, and nothing a row or a message shows', () => {
  const m = metaDataVersion();
  expect(moves(() => changed('open'))).toEqual({ rev: 1, metaRev: 0 });
  expect(metaDataVersion()).toBe(m + 1);
});

test("the hub's place settings are only a folder opening when nothing else in them differs", () => {
  const db = emptyDb();
  const pref = (id: string, extra: Partial<P.PlacePrefView> = {}): P.PlacePrefView => ({ kind: 'folder', id, position: 1, pinned: false, hidden: false, open: false, railed: false, ...extra });
  for (const p of [pref('f1'), pref('f2', { pinned: true })]) db.placePrefs.set(prefKey(p.kind, p.id), p);
  expect(onlyOpens(db, [pref('f1', { open: true }), pref('f2', { pinned: true })])).toBe(true);
  // The same again: nothing changed, which is no meta change either.
  expect(onlyOpens(db, [pref('f1'), pref('f2', { pinned: true })])).toBe(true);
  // Moved, pinned, a setting added, one missing or one more: a meta change.
  expect(onlyOpens(db, [pref('f1', { open: true, position: 2 }), pref('f2', { pinned: true })])).toBe(false);
  expect(onlyOpens(db, [pref('f1'), pref('f2')])).toBe(false);
  expect(onlyOpens(db, [pref('f1', { pictures: 'grid' } as Partial<P.PlacePrefView>), pref('f2', { pinned: true })])).toBe(false);
  expect(onlyOpens(db, [pref('f1')])).toBe(false);
  expect(onlyOpens(db, [pref('f1'), pref('f2', { pinned: true }), pref('f3')])).toBe(false);
});

test('the signals move by themselves', async () => {
  const before = rev.value;
  changed('list');
  expect(rev.value).toBe(before);
  await Bun.sleep(20);
  expect(rev.value).toBe(dataVersion());
});

const ident = (extra: Partial<P.IdentityView> = {}): P.IdentityView => ({ id: 'i1', network: 'discord', nativeId: 'n1', handle: 'ann', displayName: 'Ann', avatar: null, isBot: false, personId: null, ...extra });

test('an identity the same as the one held is no change, and keeps the object', () => {
  const db = emptyDb();
  const v = identityVersion();
  const first = ident();
  expect(putIdentity(db, first)).toBe(true);
  expect(putIdentity(db, ident())).toBe(false);
  expect(db.identities.get('i1')).toBe(first);
  expect(identityVersion()).toBe(v + 1);
  expect(putIdentity(db, ident({ displayName: 'Annie' }))).toBe(true);
  expect(db.identities.get('i1')!.displayName).toBe('Annie');
  expect(identityVersion()).toBe(v + 2);
  // The native index follows the latest put, as before.
  db.identityByNative.set('discord:n1', 'other');
  putIdentity(db, ident({ displayName: 'Annie' }));
  expect(db.identityByNative.get('discord:n1')).toBe('i1');
});

const conv = (extra: Partial<P.ConversationView> = {}): P.ConversationView => ({
  id: 'c1', network: 'discord', nativeId: 'x', shape: 'channel', variant: 'text', name: 'general', topic: null, avatar: null, encrypted: false, archived: false, parentId: null,
  spaceIds: ['s1'], participantIds: [], peerPersonId: null, vantages: [{ accountId: 'a1', unread: 0, mentions: 0, lastReadTs: null }], lastMessage: null, lastMessageAt: null, nativeMute: null,
  ...extra,
});

test('a new message or read state in a conversation leaves names alone; anything else does not', () => {
  const c = conv();
  expect(conversationMetaChanged(undefined, c)).toBe(true);
  expect(conversationMetaChanged(c, conv())).toBe(false);
  const last = { id: 'm', authorId: null, text: 'hi', ts: 5, kind: 'text' } as unknown as P.MessagePreview;
  expect(conversationMetaChanged(c, conv({ lastMessage: last, lastMessageAt: 5, vantages: [{ accountId: 'a1', unread: 3, mentions: 1, lastReadTs: 2 }] }))).toBe(false);
  expect(conversationMetaChanged(c, conv({ name: 'random' }))).toBe(true);
  expect(conversationMetaChanged(c, conv({ spaceIds: ['s2'] }))).toBe(true);
  expect(conversationMetaChanged(c, conv({ nativeMute: { level: 'none' } as P.NativeMute }))).toBe(true);
  expect(conversationMetaChanged(c, conv({ vantages: [...c.vantages, { accountId: 'a2', unread: 0, mentions: 0, lastReadTs: null }] }))).toBe(true);
  // The same members in another order: the hub's bootstrap and its events once listed them so.
  const two = conv({ participantIds: ['i1', 'i2'] });
  expect(conversationMetaChanged(two, conv({ participantIds: ['i2', 'i1'] }))).toBe(false);
  expect(conversationMetaChanged(two, conv({ participantIds: ['i1', 'i3'] }))).toBe(true);
  expect(conversationMetaChanged(two, conv({ participantIds: ['i1', 'i2', 'i3'] }))).toBe(true);
});

test('a conversation sent again as it was keeps its object; a changed one replaces it', () => {
  const db = emptyDb();
  applyEventTo(db, { t: 'conversation', conversation: conv() });
  const first = db.conversations.get('c1')!;
  // A rule changed: the hub sends every conversation again.
  applyEventTo(db, { t: 'conversation', conversation: conv() });
  expect(db.conversations.get('c1')).toBe(first);
  applyEventTo(db, { t: 'conversation', conversation: conv({ name: 'random' }) });
  expect(db.conversations.get('c1')!.name).toBe('random');
  expect(db.conversations.get('c1')).not.toBe(first);
});

test('props are the same when each value is, arrays item by item', () => {
  const m = {};
  const f = () => {};
  expect(sameProps({ m, why: ['a', 'b'], f }, { m, why: ['a', 'b'], f })).toBe(true);
  expect(sameProps({ m, why: ['a'] }, { m, why: ['a', 'b'] })).toBe(false);
  expect(sameProps({ m }, { m: {} })).toBe(false);
  expect(sameProps({ m, f }, { m, f: () => {} })).toBe(false);
  expect(sameProps({ m }, { m, active: undefined })).toBe(false);
});

test('onceListed runs once when the list has it, even when what it runs reads and sets signals', async () => {
  // As android.ts's Answer: startCall reads the call and sets it, which must not run the wait again.
  const call = signal(0);
  let listed = false;
  let runs = 0;
  onceListed(() => listed, () => void (call.value = call.value + 1, runs++), 60_000);
  changed('list');
  flush();
  expect(runs).toBe(0);
  listed = true;
  changed('list');
  flush();
  expect(runs).toBe(1);
  call.value++;
  changed('list');
  flush();
  await Promise.resolve();
  changed('list');
  flush();
  expect(runs).toBe(1);
});

test('onceListed runs at once when the list has it already, and only then', async () => {
  let runs = 0;
  const call = signal(0);
  onceListed(() => true, () => void (call.value = call.value + 1, runs++), 60_000);
  expect(runs).toBe(1);
  await Promise.resolve();
  changed('list');
  flush();
  expect(runs).toBe(1);
});

test('what a message or a read changed is kept by version, and anything else is "anything"', () => {
  const v0 = placesDataVersion();
  expect(convsChangedSince(v0)).toEqual(new Set());
  changed('list', new Set(['a']));
  changed('list', new Set());
  changed('list', new Set(['b']));
  expect(convsChangedSince(v0)).toEqual(new Set(['a', 'b']));
  expect(convsChangedSince(v0 + 2)).toEqual(new Set(['b']));
  // Who wrote and the inbox move no place: nothing in the log.
  changed('identity');
  changed('inbox');
  expect(convsChangedSince(v0 + 2)).toEqual(new Set(['b']));
  // A list change that does not say what changed, or any other kind: anything may have.
  const v1 = placesDataVersion();
  changed('list');
  expect(convsChangedSince(v1)).toBeNull();
  expect(convsChangedSince(v0)).toBeNull();
  const v2 = placesDataVersion();
  changed('meta', new Set(['c']));
  expect(convsChangedSince(v2)).toBeNull();
  // Too many at once, and too long ago: anything.
  const v3 = placesDataVersion();
  changed('list', new Set(Array.from({ length: 100 }, (_, i) => `x${i}`)));
  expect(convsChangedSince(v3)).toBeNull();
  const v4 = placesDataVersion();
  for (let i = 0; i < 70; i++) changed('list', new Set(['d']));
  expect(convsChangedSince(v4)).toBeNull();
  expect(convsChangedSince(placesDataVersion() - 3)).toEqual(new Set(['d']));
});
