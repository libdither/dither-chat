/**
 * src/model.ts `placesMemo`'s updates: after a message or a read (`changed('list', ids)`), what is brought up to date
 * from the changed conversations alone gives what working it all out again gives. Random worlds and random runs of
 * changes; every so often the whole is worked out again (`changed('list')`, no ids) and compared.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { emptyDb } from '../src/syncmodel.ts';
import { changed, flush } from '../src/versions.ts';
import { db, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const M = await import('../src/model.ts');

const realNow = Date.now;
let clock = 1_800_000_000_000;
Date.now = () => clock;
afterAll(() => {
  Date.now = realNow;
  // The signals move now, not in another file's test.
  flush();
});

/** A fixed sequence of numbers in [0, 1) from a seed (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function world(r: () => number) {
  Object.assign(db, emptyDb());
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const chance = (p: number) => r() < p;
  const mute = (): P.NativeMute | null => (chance(0.1) ? { level: 'none', until: clock + Math.floor(r() * 50) * 60_000 } : chance(0.08) ? { muted: true } : chance(0.05) ? { level: 'mentions' } : null);
  for (const id of ['acc1', 'acc2']) db.accounts.set(id, { id, network: 'discord', label: id } as unknown as P.AccountView);
  const link = (parentId: string, childId: string, childKind: 'space' | 'conversation') => {
    const e: P.SpaceEdgeView = { parentId, childId, childKind, position: chance(0.5) ? String(Math.floor(r() * 9)) : null };
    db.children.set(parentId, [...(db.children.get(parentId) ?? []), e]);
    db.parents.set(childId, [...(db.parents.get(childId) ?? []), e]);
  };
  const spaces: string[] = [];
  for (let i = 0; i < 6; i++) {
    const id = `s${i}`;
    db.spaces.set(id, { id, network: 'discord', nativeId: id, kind: 'community', name: id, topic: null, icon: null, accountIds: [pick(['acc1', 'acc2'])], nativeMute: mute() });
    spaces.push(id);
    // Sections, and now and then a subspace that is a community of its own.
    for (let j = 0; j < 2; j++) {
      const sid = `${id}-sec${j}`;
      const sub = chance(0.2);
      db.spaces.set(sid, { id: sid, network: 'discord', nativeId: sid, kind: sub ? 'community' : 'section', name: sid, topic: null, icon: null, accountIds: ['acc1'], nativeMute: mute() });
      link(id, sid, 'space');
      spaces.push(sid);
    }
  }
  const persons = ['p0', 'p1', 'p2', 'p3', 'p4'];
  for (const id of persons) db.persons.set(id, { id, name: id, isSelf: false } as unknown as P.PersonView);
  const conv = (id: string, extra: Partial<P.ConversationView>): P.ConversationView =>
    ({
      id,
      network: 'discord',
      shape: 'channel',
      variant: 'text',
      spaceIds: [],
      parentId: null,
      name: id,
      // Within the last three days: the inbox's rows not yet scored order by how long ago.
      lastMessageAt: clock - Math.floor(r() * 3 * 86_400_000),
      lastMessage: null,
      nativeMute: mute(),
      peerPersonId: null,
      participantIds: [],
      vantages: [{ accountId: pick(['acc1', 'acc2']), unread: 0, mentions: 0, lastReadTs: null }],
      ...extra,
    }) as unknown as P.ConversationView;
  const ids: string[] = [];
  const put = (c: P.ConversationView) => {
    db.conversations.set(c.id, c);
    ids.push(c.id);
  };
  for (let i = 0; i < 40; i++) {
    const sid = pick(spaces);
    const variant = pick(['text', 'text', 'forum', 'media', 'feed', 'voice'] as const);
    const c = conv(`ch${i}`, { variant, spaceIds: [sid] });
    put(c);
    link(sid, c.id, 'conversation');
    const threads = chance(0.4) ? Math.floor(r() * 4) : 0;
    for (let t = 0; t < threads; t++) put(conv(`ch${i}-t${t}`, { shape: 'thread', parentId: c.id, archived: chance(0.2) } as Partial<P.ConversationView>));
  }
  for (let i = 0; i < 12; i++) put(conv(`dm${i}`, { shape: 'direct', peerPersonId: pick(persons) }));
  for (let i = 0; i < 5; i++) put(conv(`gr${i}`, { shape: 'group' }));
  put(conv('self', { shape: 'self' }));
  put(conv('room', { shape: 'channel' }));
  for (const c of db.conversations.values()) if (c.parentId) db.threads.set(c.parentId, [...(db.threads.get(c.parentId) ?? []), c.id]);
  // Rules, a folder of a server, a channel and a person, places railed and hidden, a request, inbox scores.
  db.rules = [
    { id: 'r1', scope: 'space', target: pick(spaces), level: pick(['all', 'digest', 'none'] as const) },
    { id: 'r2', scope: 'conversation', target: pick(ids), level: pick(['all', 'digest', 'none'] as const) },
    { id: 'r3', scope: 'account', target: 'acc2', level: 'digest' },
  ] as P.RuleView[];
  db.folders = [{ id: 'f1', name: 'f', icon: null, color: null, items: [{ kind: 'space', id: 's1' }, { kind: 'conversation', id: 'ch3' }, { kind: 'person', id: 'p1' }] }];
  for (const id of ids)
    if (chance(0.1)) db.placePrefs.set(`conversation:${id}`, { kind: 'conversation', id, position: null, pinned: false, hidden: chance(0.5), open: false, railed: chance(0.5) });
  db.placePrefs.set('space:s2', { kind: 'space', id: 's2', position: 1, pinned: false, hidden: false, open: false, railed: false });
  db.placePrefs.set('space:s4', { kind: 'space', id: 's4', position: null, pinned: false, hidden: true, open: false, railed: false });
  db.requests = [{ kind: 'message', target: { kind: 'conversation', id: 'dm0' } } as unknown as P.RequestView];
  for (const id of ids) if (chance(0.3)) db.attention.set(id, { id, score: Math.floor(r() * 100), needs: chance(0.5), reasons: [], owedSince: null } as P.AttentionView);
  changed('meta');
  return { ids, spaces, persons, pick, chance };
}

/** Everything the rail, the sidebar, the badge and the inbox read, as plain data. */
function everything(spaces: string[], persons: string[]) {
  const objIds = (cs: readonly P.ConversationView[]) => cs.map((c) => c.id);
  const channels = [...db.conversations.values()].filter((c) => c.shape !== 'thread');
  return {
    total: M.totalUnread(),
    rail: M.railEntries().map((e) => e.key),
    hidden: M.railEntries('hidden').map((e) => e.key),
    communities: M.allCommunities().map((s) => s.id),
    spaces: spaces.map((id) => ({ id, under: M.convsUnder(id), unread: M.spaceUnread(id), act: M.activityOfSpace(id), chans: objIds(M.channelsUnder(id)), children: M.spaceChildren(id) })),
    channels: channels.map((c) => ({ id: c.id, unread: M.channelUnread(c), threads: M.shownThreads(c) })),
    folder: M.folderConvs(db.folders[0]),
    directs: persons.map((p) => M.directsOf(p)),
    people: M.people(),
    inbox: M.inboxRows(),
  };
}

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`seed ${seed}: a run of messages and reads gives what working everything out again gives`, () => {
    const r = rng(seed);
    const { ids, spaces, persons, pick, chance } = world(r);
    everything(spaces, persons);
    for (let step = 0; step < 120; step++) {
      const changedIds = new Set<string>();
      const n = 1 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const id = pick(ids);
        const c = db.conversations.get(id)!;
        if (chance(0.15)) {
          // The hub scores it again (or drops it from the inbox).
          if (chance(0.3)) db.attention.delete(id);
          else db.attention.set(id, { id, score: Math.floor(r() * 100), needs: chance(0.5), reasons: [], owedSince: null } as P.AttentionView);
        } else {
          // A message (newer, unread) or a read (nothing unread).
          const read = chance(0.4);
          const unread = read ? 0 : (c.vantages[0].unread || 0) + 1;
          db.conversations.set(id, { ...c, lastMessageAt: read ? c.lastMessageAt : clock - Math.floor(r() * 60_000), vantages: c.vantages.map((v) => ({ ...v, unread, mentions: read ? 0 : chance(0.3) ? v.mentions + 1 : v.mentions })) });
        }
        changedIds.add(id);
      }
      // Reactions' usage now and then: nothing a count reads.
      if (chance(0.1)) changed('list', new Set());
      changed('list', changedIds);
      // Time passes: now and then a native mute runs out with nothing changed.
      clock += Math.floor(r() * 3) * 60_000;
      // Some steps read everything, some only part (so a memo catches up over several changes), some nothing.
      if (chance(0.7)) everything(spaces, persons);
      else if (chance(0.5)) M.totalUnread();
      if (step % 10 === 9) {
        const incremental = everything(spaces, persons);
        changed('list');
        expect(incremental).toEqual(everything(spaces, persons));
      }
    }
  });
}

test('with nothing a count reads changed, what was worked out is the very same', () => {
  const r = rng(99);
  const { spaces, persons } = world(r);
  const a = everything(spaces, persons);
  changed('list', new Set());
  const b = everything(spaces, persons);
  expect(b.total).toBe(a.total);
  expect(b.spaces[0].under).toBe(a.spaces[0].under);
  expect(M.people()).toBe(b.people);
});

test('a read under one server leaves the others as they were', () => {
  const r = rng(7);
  const { spaces, persons } = world(r);
  const before = everything(spaces, persons);
  const c = before.spaces.find((s) => s.under.length)!.under[0];
  db.conversations.set(c.id, { ...c, vantages: c.vantages.map((v) => ({ ...v, unread: 0, mentions: 0 })) });
  changed('list', new Set([c.id]));
  const after = everything(spaces, persons);
  for (const [i, s] of after.spaces.entries()) {
    const holds = s.under.some((x) => x.id === c.id);
    if (holds) expect(s.under).not.toBe(before.spaces[i].under);
    else expect(s.under).toBe(before.spaces[i].under);
  }
});
