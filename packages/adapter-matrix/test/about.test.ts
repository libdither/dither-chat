import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { aboutOf, configureAbout, CREATOR_RANK, inviteLink, joinRuleOf, readAbout, stateFor, type AboutCtx, type AboutHost } from '../src/about.ts';
import { Directory, Room, type MxEvent } from '../src/rooms.ts';

const ME = '@me:x.org';
const ADMIN = '@admin:x.org';
const ROOM = '!r:x.org';
let n = 0;

function state(room: Room, type: string, content: Record<string, any>, stateKey = '', sender = ADMIN) {
  room.setState({ type, state_key: stateKey, content, sender, event_id: `$e${++n}`, origin_server_ts: n });
}

/** A room made by ADMIN, with the power levels most clients create: you at `mine`. */
function makeRoom(opts: { mine?: number; version?: string; pl?: Record<string, any> | null; id?: string } = {}): Room {
  const room = new Room(opts.id ?? ROOM);
  state(room, 'm.room.create', { room_version: opts.version ?? '10' });
  if (opts.pl !== null) {
    state(room, 'm.room.power_levels', opts.pl ?? { users: { [ADMIN]: 100, ...(opts.mine ? { [ME]: opts.mine } : {}) }, events: { 'm.room.name': 50, 'm.room.power_levels': 100, 'm.room.join_rules': 100, 'm.room.history_visibility': 100, 'm.room.encryption': 100 } });
  }
  for (const u of [ADMIN, ME]) state(room, 'm.room.member', { membership: 'join' }, u, u);
  return room;
}

const ctx = (over: Partial<AboutCtx> = {}): AboutCtx => ({ selfId: ME, kind: 'conversation', spaces: [], e2ee: true, ...over });

test('a moderator may rename but not change who can join, and is told why', () => {
  const a = aboutOf(makeRoom({ mine: 50 }), ctx());
  expect(a.fields.name).toEqual({ value: '', canEdit: true });
  expect(a.fields.topic?.canEdit).toBe(true); // state_default 50
  expect(a.fields.joinRule).toEqual({ value: 'invite', canEdit: false, reason: 'Needs power level 100; yours is 50.' });
  expect(a.fields.history?.reason).toBe('Needs power level 100; yours is 50.');
  expect(a.fields.avatar).toEqual({ value: null, canEdit: false, reason: 'Changing the picture is not supported yet.' });
  expect(a.you).toEqual({ role: 'Moderator', rank: 50 });
  expect(() => stateFor(makeRoom({ mine: 50 }), ctx(), { key: 'joinRule', value: 'open' })).toThrow('Needs power level 100; yours is 50.');
  expect(stateFor(makeRoom({ mine: 50 }), ctx(), { key: 'name', value: '  Lounge ' })).toEqual({ type: 'm.room.name', stateKey: '', content: { name: 'Lounge' } });
});

test('a member sees the picture locked by level, and the rules in words', () => {
  const a = aboutOf(makeRoom(), ctx());
  expect(a.fields.avatar?.reason).toBe('Needs power level 50; yours is 0.');
  expect(a.rules).toContainEqual({ what: 'Send messages', who: 'Everyone (0)', you: true });
  expect(a.rules).toContainEqual({ what: 'Change name, topic and picture', who: 'Moderators (50)', you: false });
  expect(a.rules).toContainEqual({ what: 'Change join rules, history and encryption', who: 'Admins (100)', you: false });
  expect(a.rules).toContainEqual({ what: 'Remove or ban people', who: 'Moderators (50)', you: false });
  expect(a.rules).toContainEqual({ what: 'Pin messages', who: 'Moderators (50)', you: false });
  expect(a.pinned).toEqual({ messages: [], canEdit: false, reason: 'Needs power level 50; yours is 0.' });
});

test('without a power levels event the creator has 100, everyone else 0, and state needs 0', () => {
  const room = makeRoom({ pl: null });
  const mine = aboutOf(room, ctx());
  expect(mine.fields.name?.canEdit).toBe(true);
  expect(mine.fields.joinRule?.canEdit).toBe(true);
  expect(mine.you).toEqual({ role: 'Member', rank: 0 });
  expect(mine.fields.announceOnly).toEqual({ value: false, canEdit: false, reason: 'This room has no power levels to change.' });
  expect(mine.rules).toContainEqual({ what: 'Remove or ban people', who: 'Moderators (50)', you: false });
  expect(aboutOf(room, ctx({ selfId: ADMIN })).you).toEqual({ role: 'Admin', rank: 100 });
});

test('only admins can send: read from the levels, written as the whole event with only the send levels moved', () => {
  const pl = { users: { [ADMIN]: 100, '@bob:x.org': 20 }, users_default: 0, events_default: 0, events: { 'm.room.message': 0, 'm.room.power_levels': 100 }, kick: 50, notifications: { room: 50 } };
  const room = makeRoom({ pl: { ...pl, users: { ...pl.users, [ME]: 100 } } });
  expect(aboutOf(room, ctx()).fields.announceOnly).toEqual({ value: false, canEdit: true });
  const w = stateFor(room, ctx(), { key: 'announceOnly', value: true })!;
  expect(w.type).toBe('m.room.power_levels');
  expect(w.content).toEqual({ ...pl, users: { ...pl.users, [ME]: 100 }, events_default: 50, events: { 'm.room.message': 50, 'm.room.power_levels': 100 } });
  expect(room.get('m.room.power_levels')!.content.events_default).toBe(0); // the stored copy is not touched

  // Read back as on; turned off again it goes to 0.
  state(room, 'm.room.power_levels', w.content);
  expect(aboutOf(room, ctx()).fields.announceOnly?.value).toBe(true);
  expect(stateFor(room, ctx(), { key: 'announceOnly', value: false })!.content).toMatchObject({ events_default: 0, events: { 'm.room.message': 0 } });
  // Asking for what already is writes nothing.
  expect(stateFor(room, ctx(), { key: 'announceOnly', value: true })).toBeNull();
});

test('only admins can send needs the old send level within your own, too', () => {
  const room = makeRoom({ pl: { users: { [ADMIN]: 100, [ME]: 60 }, events_default: 100, events: { 'm.room.power_levels': 50 } } });
  expect(aboutOf(room, ctx()).fields.announceOnly).toEqual({ value: true, canEdit: false, reason: 'Needs power level 100; yours is 60.' });
  // Turning it on never sets a level above yours.
  const lower = makeRoom({ pl: { users: { [ADMIN]: 100, [ME]: 30 }, events: { 'm.room.power_levels': 30 } } });
  expect(stateFor(lower, ctx(), { key: 'announceOnly', value: true })!.content.events_default).toBe(30);
});

test('join rules map both ways, and the room version decides what is possible', () => {
  expect(['public', 'invite', 'knock', 'knock_restricted', 'restricted', 'private', undefined].map(joinRuleOf)).toEqual(['open', 'invite', 'ask', 'ask', 'space', 'invite', 'invite']);
  const room = makeRoom({ mine: 100 });
  expect(stateFor(room, ctx(), { key: 'joinRule', value: 'open' })!.content).toEqual({ join_rule: 'public' });
  expect(stateFor(room, ctx(), { key: 'joinRule', value: 'ask' })!.content).toEqual({ join_rule: 'knock' });
  expect(() => stateFor(room, ctx(), { key: 'joinRule', value: 'space' })).toThrow('no space');
  expect(stateFor(room, ctx({ spaces: ['!space:x.org'] }), { key: 'joinRule', value: 'space' })!.content).toEqual({ join_rule: 'restricted', allow: [{ type: 'm.room_membership', room_id: '!space:x.org' }] });
  const old = makeRoom({ mine: 100, version: '6' });
  expect(() => stateFor(old, ctx(), { key: 'joinRule', value: 'ask' })).toThrow('Asking to join needs room version 7 or newer; this room is version 6.');
  const v7 = makeRoom({ mine: 100, version: '7' });
  expect(() => stateFor(v7, ctx({ spaces: ['!space:x.org'] }), { key: 'joinRule', value: 'space' })).toThrow('room version 8 or newer');
  state(room, 'm.room.join_rules', { join_rule: 'knock_restricted', allow: [{ type: 'm.room_membership', room_id: '!other:x.org' }] });
  expect(aboutOf(room, ctx()).fields.joinRule?.value).toBe('ask');
  // An allow list the room already has is kept.
  expect(stateFor(room, ctx({ spaces: ['!space:x.org'] }), { key: 'joinRule', value: 'space' })!.content.allow).toEqual([{ type: 'm.room_membership', room_id: '!other:x.org' }]);
});

test('history visibility reads and writes as itself, shared when unset', () => {
  const room = makeRoom({ mine: 100 });
  expect(aboutOf(room, ctx()).fields.history?.value).toBe('shared');
  state(room, 'm.room.history_visibility', { history_visibility: 'joined' });
  expect(aboutOf(room, ctx()).fields.history?.value).toBe('joined');
  expect(stateFor(room, ctx(), { key: 'history', value: 'world_readable' })).toEqual({ type: 'm.room.history_visibility', stateKey: '', content: { history_visibility: 'world_readable' } });
});

test('encryption turns on, never off, and not from an account that could not write there after', () => {
  const room = makeRoom({ mine: 100 });
  expect(aboutOf(room, ctx()).fields.encrypted).toEqual({ value: false, canEdit: true });
  expect(stateFor(room, ctx(), { key: 'encrypted', value: true })!.content).toEqual({ algorithm: 'm.megolm.v1.aes-sha2' });
  expect(aboutOf(room, ctx({ e2ee: false })).fields.encrypted?.canEdit).toBe(false);
  state(room, 'm.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' });
  expect(aboutOf(room, ctx()).fields.encrypted).toEqual({ value: true, canEdit: false, reason: 'Encryption cannot be turned off once on.' });
  expect(() => stateFor(room, ctx(), { key: 'encrypted', value: false as true })).toThrow('Encryption cannot be turned off once on.');
});

test('topic is written in both forms; pins are added at the end and read newest first', () => {
  const room = makeRoom({ mine: 50 });
  expect(stateFor(room, ctx(), { key: 'topic', value: 'hi' })!.content).toEqual({ topic: 'hi', 'm.topic': { 'm.text': [{ body: 'hi' }] } });
  state(room, 'm.room.pinned_events', { pinned: ['$a', '$b'] });
  expect(aboutOf(room, ctx()).pinned?.messages).toEqual(['$b', '$a']);
  expect(stateFor(room, ctx(), { key: 'pin', message: '$c' })!.content).toEqual({ pinned: ['$a', '$b', '$c'] });
  expect(stateFor(room, ctx(), { key: 'pin', message: '$a', remove: true })!.content).toEqual({ pinned: ['$b'] });
  expect(stateFor(room, ctx(), { key: 'pin', message: '$a' })).toBeNull();
  expect(stateFor(room, ctx(), { key: 'pin', message: '$z', remove: true })).toBeNull();
});

test('what Matrix does not have, or cannot do yet, is refused in words', () => {
  const room = makeRoom({ mine: 100 });
  expect(() => stateFor(room, ctx(), { key: 'slowMode', value: 5 })).toThrow('Slow mode is not a setting of a Matrix room.');
  expect(() => stateFor(room, ctx(), { key: 'avatar', value: 'mxc://x/y' })).toThrow('not supported yet');
  expect(() => stateFor(room, ctx(), { key: 'invite', op: 'create' })).toThrow('made from the room’s address');
  expect(() => stateFor(room, ctx({ kind: 'space' }), { key: 'history', value: 'joined' })).toThrow('not a setting of a Matrix space');
  expect(Object.keys(aboutOf(room, ctx({ kind: 'space' })).fields)).toEqual(['name', 'topic', 'avatar', 'joinRule']);
});

test('the link: the address if there is one, else the id with the busiest servers', () => {
  const room = makeRoom();
  expect(inviteLink(room, ['@a:one.org', '@b:two.org', '@c:two.org', '@d:three.org', '@e:four.org', '@f:three.org', '@g:two.org'])).toBe('https://matrix.to/#/!r%3Ax.org?via=two.org&via=three.org&via=four.org');
  expect(inviteLink(room, [])).toBe('https://matrix.to/#/!r%3Ax.org');
  state(room, 'm.room.canonical_alias', { alias: '#lounge:x.org' });
  expect(inviteLink(room, ['@a:one.org'])).toBe('https://matrix.to/#/%23lounge%3Ax.org');
  expect(aboutOf(room, ctx()).invite).toEqual({ link: 'https://matrix.to/#/%23lounge%3Ax.org', canCreate: false, derived: true, reason: 'Matrix links are made from the room’s address, not issued.' });
});

test('v12 creators outrank everyone, and the numbers survive JSON', () => {
  const room = new Room(ROOM);
  room.setState({ type: 'm.room.create', state_key: '', content: { room_version: '12', additional_creators: [ME] }, sender: ADMIN, event_id: '$c', origin_server_ts: 0 });
  state(room, 'm.room.power_levels', { users: { '@mod:x.org': 50 }, events: { 'm.room.power_levels': 150 } });
  const members = new Map([[ADMIN, {}], [ME, {}], ['@mod:x.org', {}], ['@z:y.org', {}]]);
  const a = JSON.parse(JSON.stringify(aboutOf(room, ctx(), members))) as P.About;
  expect(a.you).toEqual({ role: 'Owner', rank: CREATOR_RANK });
  expect(a.fields.joinRule?.canEdit).toBe(true);
  expect(a.members?.list.map((m) => [m.id, m.role])).toEqual([
    [ADMIN, 'Owner'],
    [ME, 'Owner'],
    ['@mod:x.org', 'Moderator'],
    ['@z:y.org', 'Member'],
  ]);
  expect(a.roles?.find((r) => r.name === 'Owner')).toEqual({ id: 'creator', name: 'Owner', rank: CREATOR_RANK, count: 2 });
  // A later numeric version is treated the same.
  room.setState({ type: 'm.room.create', state_key: '', content: { room_version: '13' }, sender: ME, event_id: '$c2', origin_server_ts: 1 });
  expect(room.powerLevel(ME)).toBe(Infinity);
});

test('custom levels are named by number; a long member list is cut and counted', () => {
  const room = makeRoom({ pl: { users: { [ADMIN]: 100, '@helper:x.org': 25 } } });
  const members = new Map<string, {}>([[ADMIN, {}], ['@helper:x.org', {}]]);
  for (let i = 0; i < 600; i++) members.set(`@u${i}:x.org`, {});
  const a = aboutOf(room, ctx(), members);
  expect(a.members?.list.length).toBe(500);
  expect(a.members?.total).toBe(602);
  expect(a.members?.complete).toBe(false);
  expect(a.members?.list.slice(0, 2)).toEqual([
    { id: ADMIN, role: 'Admin', rank: 100 },
    { id: '@helper:x.org', role: 'Level 25', rank: 25 },
  ]);
  expect(a.roles?.map((r) => r.name)).toEqual(['Admin', 'Moderator', 'Level 25', 'Member']);
});

// ---------------------------------------------------------------- through the commands, with a fake server

function host(room: Room) {
  const dir = new Directory(ME);
  dir.rooms.set(room.id, room);
  const calls: { method: string; path: string; body?: any }[] = [];
  const identities: P.IdentityFact[] = [];
  const applied: MxEvent[] = [];
  const h: AboutHost = {
    dir,
    e2ee: true,
    api: {
      request: (async (method: string, path: string, opts?: { body?: any }) => {
        calls.push({ method, path, body: opts?.body });
        if (path.endsWith('/joined_members')) return { joined: { [ADMIN]: { display_name: 'Ada', avatar_url: 'mxc://x.org/a' }, [ME]: { display_name: 'me' }, '@bob:y.org': {} } };
        if (method === 'PUT') return { event_id: '$written' };
        return {};
      }) as AboutHost['api']['request'],
    },
    identity: (f) => identities.push(f),
    applied: (r, ev) => {
      applied.push(ev);
      r.setState(ev);
    },
  };
  return { h, calls, identities, applied };
}

test('about names the members first, then answers', async () => {
  const room = makeRoom({ mine: 50 });
  const { h, calls, identities } = host(room);
  const a = await readAbout(h, { kind: 'conversation', nativeId: ROOM });
  expect(calls).toEqual([{ method: 'GET', path: '/_matrix/client/v3/rooms/!r%3Ax.org/joined_members', body: undefined }]);
  expect(identities).toEqual([{ nativeId: ADMIN, handle: ADMIN, displayName: 'Ada', avatarUrl: 'mxc://x.org/a' }, { nativeId: '@bob:y.org', handle: '@bob:y.org' }]);
  expect(a.members).toEqual({ list: [{ id: ADMIN, role: 'Admin', rank: 100 }, { id: ME, role: 'Moderator', rank: 50 }, { id: '@bob:y.org', role: 'Member', rank: 0 }], total: 3, complete: true });
  expect(a.facts).toEqual([{ label: 'Room version', value: '10' }]);
  const thread = await readAbout(h, { kind: 'conversation', nativeId: `${ROOM}|$root` });
  expect(thread.noun).toBe('Thread');
});

test('configure writes one state event, and answers with the change in place', async () => {
  const room = makeRoom({ mine: 50 });
  const { h, calls, applied } = host(room);
  const a = await configureAbout(h, { kind: 'conversation', nativeId: ROOM }, { key: 'name', value: 'Lounge' });
  expect(calls[0]).toEqual({ method: 'PUT', path: '/_matrix/client/v3/rooms/!r%3Ax.org/state/m.room.name/', body: { name: 'Lounge' } });
  expect(applied.map((e) => [e.type, e.event_id, e.sender])).toEqual([['m.room.name', '$written', ME]]);
  expect(a.fields.name).toEqual({ value: 'Lounge', canEdit: true });
  // Nothing to change: nothing written.
  calls.length = 0;
  await configureAbout(h, { kind: 'conversation', nativeId: ROOM }, { key: 'name', value: 'Lounge' });
  expect(calls.map((c) => c.method)).toEqual(['GET']);
  await expect(configureAbout(h, { kind: 'conversation', nativeId: ROOM }, { key: 'history', value: 'joined' })).rejects.toThrow('Needs power level 100; yours is 50.');
  await expect(configureAbout(h, { kind: 'conversation', nativeId: `${ROOM}|$root` }, { key: 'name', value: 'x' })).rejects.toThrow('A thread has no settings');
});
