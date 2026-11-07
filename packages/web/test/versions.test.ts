/** src/versions.ts, and what decides which version a change moves: syncmodel.ts's identity and conversation checks, memo.ts's props. */
import { expect, test } from 'bun:test';
import { effect } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { changed, dataVersion, flush, metaRev, rev, timelineChanged, timelineRev } from '../src/versions.ts';
import { conversationMetaChanged, emptyDb, identityVersion, putIdentity } from '../src/syncmodel.ts';
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
