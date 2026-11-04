/**
 * About and settings for a Matrix room or space (protocol about.ts).
 *
 * Every setting is one state event, and whether this account may change it is its power level against the level
 * that event type needs. Everything is read from the stored room state except the members, which sync loads lazily:
 * those come from /joined_members when the About is asked for. A change is a PUT of one state event, built from the
 * stored copy; the answer is made from the content just written, and sync brings the same event back.
 */

import type * as P from '@dither-chat/protocol';
import { ABOUT_LABEL, ABOUT_RULES } from '@dither-chat/protocol';
import { enc, type MatrixClient } from './http.ts';
import { roomVersionNumber, type Directory, type MxEvent, type Room } from './rooms.ts';

/** Members listed at most; the rest are counted. */
export const MEMBER_CAP = 500;
/** Room v12 creators outrank every power level. Infinity does not survive JSON, so this. */
export const CREATOR_RANK = Number.MAX_SAFE_INTEGER;
/** The send level "only admins can send" sets, or yours if lower. */
const ANNOUNCE_LEVEL = 50;
const MEGOLM = 'm.megolm.v1.aes-sha2';

const PICTURE = 'Changing the picture is not supported yet.';
const ENCRYPTION_STAYS = 'Encryption cannot be turned off once on.';
const DERIVED_LINK = 'Matrix links are made from the room’s address, not issued.';

export interface Member {
  displayName?: string;
  avatarUrl?: string;
}

export interface AboutCtx {
  selfId: string;
  kind: P.AboutTarget['kind'];
  /** Spaces the room is in: who "members of its space" lets in. */
  spaces: string[];
  /** This account can encrypt. Without it, a room turned encrypted could not be written to from here. */
  e2ee: boolean;
}

/** One state event to write. */
export interface StateWrite {
  type: string;
  stateKey: string;
  content: Record<string, any>;
}

// ---------------------------------------------------------------- reading

const toLevel = (v: unknown, d: number): number => {
  if (v === undefined || v === null) return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

/** What each thing needs, with the spec's defaults (no power levels event: state needs 0, kick and ban still 50). */
function levels(room: Room) {
  const pl = room.get('m.room.power_levels')?.content;
  return {
    pl,
    usersDefault: toLevel(pl?.users_default, 0),
    invite: toLevel(pl?.invite, 0),
    kick: toLevel(pl?.kick, 50),
    ban: toLevel(pl?.ban, 50),
    redact: toLevel(pl?.redact, 50),
    state: (type: string) => room.requiredLevel(type, true),
    send: (type: string) => room.requiredLevel(type, false),
  };
}
type Levels = ReturnType<typeof levels>;

/** A member's power level, creators of v12 rooms on top. */
export function rankOf(room: Room, user: string): number {
  const n = room.powerLevel(user);
  return n === Infinity ? CREATOR_RANK : n;
}

/** Admin 100, Moderator 50, Member 0 (or the room's default), Owner for v12 creators, "Level N" for the rest. */
export function roleName(rank: number, usersDefault = 0): string {
  if (rank === CREATOR_RANK) return 'Owner';
  if (rank === 100) return 'Admin';
  if (rank === 50) return 'Moderator';
  if (rank === 0 || rank === usersDefault) return 'Member';
  return `Level ${rank}`;
}

function who(n: number, usersDefault: number): string {
  if (n <= usersDefault) return `Everyone (${n})`;
  if (n === 100) return 'Admins (100)';
  if (n === 50) return 'Moderators (50)';
  return `Power level ${n} and up`;
}

/** public -> open, invite -> invite, knock and knock_restricted -> ask, restricted -> space. No event (or "private"): invite. */
export function joinRuleOf(native: unknown): P.JoinRule {
  switch (native) {
    case 'public':
      return 'open';
    case 'knock':
    case 'knock_restricted':
      return 'ask';
    case 'restricted':
      return 'space';
    default:
      return 'invite';
  }
}

const HISTORY = new Set<P.HistoryVisibility>(['world_readable', 'shared', 'invited', 'joined']);

/** No event means shared, the spec's default. */
export function historyOf(room: Room): P.HistoryVisibility {
  const h = room.get('m.room.history_visibility')?.content?.history_visibility;
  return HISTORY.has(h) ? h : 'shared';
}

function pinnedOf(room: Room): string[] {
  const p = room.get('m.room.pinned_events')?.content?.pinned;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}

/** The send levels "only admins can send" moves: events_default, and m.room.message where the room lists it. */
function sendLevels(pl: Record<string, any>): number[] {
  const msg = pl.events?.['m.room.message'];
  return [toLevel(pl.events_default, 0), ...(msg !== undefined ? [toLevel(msg, 0)] : [])];
}

/** Changing a level needs the power levels event's level, and both the old and new values within your own. */
function announceGate(room: Room, L: Levels, mine: number, need: (n: number) => string): string | null {
  if (!L.pl) return 'This room has no power levels to change.';
  const n = L.state('m.room.power_levels');
  if (mine < n) return need(n);
  const top = Math.max(...sendLevels(L.pl));
  if (top > mine) return need(top);
  if (!room.readOnlyForMembers && Math.min(ANNOUNCE_LEVEL, mine) <= L.usersDefault) return `Needs a power level above ${L.usersDefault}; yours is ${mine}.`;
  return null;
}

/**
 * matrix.to link: the room's address if it has one, else its id with up to three servers to join through, those
 * with the most members first.
 */
export function inviteLink(room: Room, members: string[]): string {
  if (room.alias) return `https://matrix.to/#/${enc(room.alias)}`;
  const count = new Map<string, number>();
  for (const u of members) {
    const i = u.indexOf(':');
    if (i > 0) count.set(u.slice(i + 1), (count.get(u.slice(i + 1)) ?? 0) + 1);
  }
  const via = [...count]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([s]) => `via=${enc(s)}`);
  return `https://matrix.to/#/${enc(room.id)}${via.length ? `?${via.join('&')}` : ''}`;
}

/** Rows that need the same level are said once ("Remove or ban people"); otherwise one row each. */
function rows(L: Levels, mine: number, merged: string, parts: [string, number][]): P.AboutRule[] {
  if (parts.every(([, n]) => n === parts[0][1])) return [{ what: merged, who: who(parts[0][1], L.usersDefault), you: mine >= parts[0][1] }];
  return parts.map(([what, n]) => ({ what, who: who(n, L.usersDefault), you: mine >= n }));
}

/**
 * The About from a room's stored state. `members` is /joined_members (id -> profile); without it the members are
 * the ones sync has told us about, and the list says it is incomplete.
 */
export function aboutOf(room: Room, ctx: AboutCtx, members?: Map<string, Member>): P.About {
  const L = levels(room);
  const conv = ctx.kind === 'conversation';
  const mineRaw = room.powerLevel(ctx.selfId);
  const mine = mineRaw === Infinity ? CREATOR_RANK : mineRaw;
  const can = (n: number) => mineRaw >= n;
  const need = (n: number) => `Needs power level ${n}; yours is ${mine}.`;

  const keys = ABOUT_RULES.matrix[ctx.kind];
  const fields: P.AboutFields = {};
  const set = <K extends P.AboutKey>(k: K, value: P.AboutValues[K] | null, canEdit: boolean, reason?: string | null) => {
    if (keys.includes(k)) (fields as Record<string, P.AboutSetting>)[k] = { value, canEdit, ...(reason ? { reason } : {}) };
  };
  const gated = <K extends P.AboutKey>(k: K, value: P.AboutValues[K] | null, type: string) => {
    const n = L.state(type);
    set(k, value, can(n), can(n) ? null : need(n));
  };
  gated('name', room.name ?? '', 'm.room.name');
  gated('topic', room.topic ?? '', 'm.room.topic');
  const avatarLevel = L.state('m.room.avatar');
  set('avatar', room.avatar ?? null, false, can(avatarLevel) ? PICTURE : need(avatarLevel));
  const announce = announceGate(room, L, mine, need);
  set('announceOnly', room.readOnlyForMembers, !announce, announce);
  gated('joinRule', joinRuleOf(room.joinRule), 'm.room.join_rules');
  gated('history', historyOf(room), 'm.room.history_visibility');
  const encLevel = L.state('m.room.encryption');
  const encReason = room.encrypted
    ? ENCRYPTION_STAYS
    : !can(encLevel)
      ? need(encLevel)
      : !ctx.e2ee
        ? 'Set up encryption on the account page first: without it you could not write here once it is on.'
        : null;
  set('encrypted', room.encrypted, !encReason, encReason);

  // Members, highest power first.
  const ids = members ? [...members.keys()] : room.members('join');
  const ranked = ids.map((id) => ({ id, rank: rankOf(room, id) })).sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  const list: P.AboutMember[] = ranked.slice(0, MEMBER_CAP).map((m) => ({ id: m.id, role: roleName(m.rank, L.usersDefault), rank: m.rank }));
  const total = members ? ids.length : Math.max(room.joinedCount, ids.length);

  // Roles: the usual three, v12 owners, and any other level someone holds.
  const ranks = new Set([100, 50, L.usersDefault]);
  for (const v of Object.values<unknown>(L.pl?.users ?? {})) ranks.add(toLevel(v, 0));
  for (const m of ranked) ranks.add(m.rank);
  if (roomVersionNumber(room.roomVersion) >= 12) ranks.add(CREATOR_RANK);
  const roles = new Map<string, P.AboutRole>();
  for (const rank of [...ranks].sort((a, b) => b - a)) {
    const name = roleName(rank, L.usersDefault);
    if (roles.has(name)) continue;
    const count = members ? ranked.filter((m) => roleName(m.rank, L.usersDefault) === name).length : undefined;
    roles.set(name, { id: rank === CREATOR_RANK ? 'creator' : String(rank), name, rank, ...(count !== undefined ? { count } : {}) });
  }

  const rules: P.AboutRule[] = [];
  if (conv) rules.push({ what: 'Send messages', who: who(L.send('m.room.message'), L.usersDefault), you: can(L.send('m.room.message')) });
  rules.push(
    ...rows(L, mine, 'Change name, topic and picture', [
      ['Change the name', L.state('m.room.name')],
      ['Change the topic', L.state('m.room.topic')],
      ['Change the picture', L.state('m.room.avatar')],
    ]),
  );
  if (conv) {
    rules.push(
      ...rows(L, mine, 'Change join rules, history and encryption', [
        ['Change who can join', L.state('m.room.join_rules')],
        ['Change who can read history', L.state('m.room.history_visibility')],
        ['Turn on encryption', L.state('m.room.encryption')],
      ]),
    );
  } else {
    rules.push({ what: 'Change who can join', who: who(L.state('m.room.join_rules'), L.usersDefault), you: can(L.state('m.room.join_rules')) });
    rules.push({ what: 'Add rooms to the space', who: who(L.state('m.space.child'), L.usersDefault), you: can(L.state('m.space.child')) });
  }
  rules.push({ what: 'Change roles and permissions', who: who(L.state('m.room.power_levels'), L.usersDefault), you: can(L.state('m.room.power_levels')) });
  rules.push({ what: 'Invite people', who: who(L.invite, L.usersDefault), you: can(L.invite) });
  rules.push(
    ...rows(L, mine, 'Remove or ban people', [
      ['Remove people', L.kick],
      ['Ban people', L.ban],
    ]),
  );
  rules.push({ what: 'Delete others’ messages', who: who(L.redact, L.usersDefault), you: can(L.redact) });
  const pinLevel = L.state('m.room.pinned_events');
  if (conv) rules.push({ what: 'Pin messages', who: who(pinLevel, L.usersDefault), you: can(pinLevel) });

  const facts = [{ label: 'Room version', value: room.roomVersion }];
  if (room.alias) facts.push({ label: 'Address', value: room.alias });
  const acl = room.get('m.room.server_acl')?.content;
  if (acl) {
    const deny = Array.isArray(acl.deny) ? acl.deny.length : 0;
    facts.push({ label: 'Server access rules', value: deny ? `${deny} server${deny === 1 ? '' : 's'} blocked` : 'On' });
  }

  return {
    noun: conv ? 'Room' : 'Space',
    fields,
    members: { list, total, complete: !!members && list.length === total },
    roles: [...roles.values()],
    rules,
    you: { role: roleName(mine, L.usersDefault), rank: mine },
    invite: { link: inviteLink(room, ids), canCreate: false, derived: true, reason: DERIVED_LINK },
    // Pins are kept in order of pinning (Element appends), so the newest is last.
    ...(conv ? { pinned: { messages: pinnedOf(room).reverse(), canEdit: can(pinLevel), ...(can(pinLevel) ? {} : { reason: need(pinLevel) }) } } : {}),
    facts,
  };
}

// ---------------------------------------------------------------- changing

/** Only admins can send, on or off: the whole power levels event with the send levels moved, everyone else's untouched. */
export function announceContent(pl: Record<string, any>, on: boolean, mine: number): Record<string, any> {
  const to = on ? Math.min(ANNOUNCE_LEVEL, mine) : Math.min(0, toLevel(pl.users_default, 0));
  const out = structuredClone(pl);
  out.events_default = to;
  if (out.events && out.events['m.room.message'] !== undefined) out.events['m.room.message'] = to;
  return out;
}

/** knock needs room version 7, restricted 8. "Members of its space" keeps the spaces already allowed, else the ones the room is in. */
export function joinRuleContent(room: Room, rule: P.JoinRule, spaces: string[]): Record<string, any> {
  const v = roomVersionNumber(room.roomVersion);
  switch (rule) {
    case 'open':
      return { join_rule: 'public' };
    case 'invite':
      return { join_rule: 'invite' };
    case 'ask':
      if (!(v >= 7)) throw new Error(`Asking to join needs room version 7 or newer; this room is version ${room.roomVersion}.`);
      return { join_rule: 'knock' };
    case 'space': {
      if (!(v >= 8)) throw new Error(`Letting a space's members join needs room version 8 or newer; this room is version ${room.roomVersion}.`);
      const current = room.get('m.room.join_rules')?.content?.allow;
      const kept = Array.isArray(current) ? current.filter((a: any) => a?.type === 'm.room_membership' && typeof a.room_id === 'string') : [];
      const allow = kept.length ? kept : spaces.map((room_id) => ({ type: 'm.room_membership', room_id }));
      if (!allow.length) throw new Error('This room is in no space you know of, so no space’s members could join.');
      return { join_rule: 'restricted', allow };
    }
  }
}

/**
 * The state event a change writes, or null when there is nothing to change. Refuses, in words, what this account
 * may not do or Matrix does not have.
 */
export function stateFor(room: Room, ctx: AboutCtx, change: P.AboutChange): StateWrite | null {
  const w = (type: string, content: Record<string, any>): StateWrite => ({ type, stateKey: '', content });
  if (change.key === 'invite') throw new Error(DERIVED_LINK);
  if (change.key === 'avatar') throw new Error(PICTURE);
  const about = aboutOf(room, ctx);
  if (change.key === 'pin') {
    if (!about.pinned) throw new Error('Messages are pinned in rooms, not spaces.');
    if (!about.pinned.canEdit) throw new Error(about.pinned.reason ?? 'You cannot pin messages here.');
    const now = pinnedOf(room);
    if (now.includes(change.message) !== !!change.remove) return null;
    const pinned = now.filter((id) => id !== change.message);
    if (!change.remove) pinned.push(change.message);
    return w('m.room.pinned_events', { ...room.get('m.room.pinned_events')?.content, pinned });
  }
  const label = ABOUT_LABEL[change.key] ?? String(change.key);
  const field = about.fields[change.key];
  if (!field) throw new Error(`${label} is not a setting of a Matrix ${ctx.kind === 'space' ? 'space' : 'room'}.`);
  if (!field.canEdit) throw new Error(field.reason ?? `You cannot change ${label.toLowerCase()} here.`);
  if (field.value === change.value) return null;
  switch (change.key) {
    case 'name':
      return w('m.room.name', { name: change.value.trim() });
    case 'topic':
      return w('m.room.topic', { topic: change.value, 'm.topic': { 'm.text': [{ body: change.value }] } });
    case 'history':
      return w('m.room.history_visibility', { history_visibility: change.value });
    case 'joinRule':
      return w('m.room.join_rules', joinRuleContent(room, change.value, ctx.spaces));
    case 'encrypted':
      if (change.value !== true) throw new Error(ENCRYPTION_STAYS);
      return w('m.room.encryption', { algorithm: MEGOLM });
    case 'announceOnly':
      return w('m.room.power_levels', announceContent(room.get('m.room.power_levels')!.content, change.value, room.powerLevel(ctx.selfId)));
  }
  throw new Error(`${label} is not a setting of a Matrix room.`);
}

// ---------------------------------------------------------------- the commands

export interface AboutHost {
  api: Pick<MatrixClient, 'request'>;
  dir: Directory;
  e2ee: boolean;
  /** Tell the hub who a member is, before the About names them. */
  identity(f: P.IdentityFact): void;
  /** Keep a state event this account just wrote, and tell the hub what it changed. */
  applied(room: Room, ev: MxEvent): void;
}

function placeOf(h: AboutHost, nativeId: string): { room: Room; root?: string } {
  const i = nativeId.indexOf('|');
  const roomId = i < 0 ? nativeId : nativeId.slice(0, i);
  const room = h.dir.rooms.get(roomId);
  if (!room || room.membership !== 'join') throw new Error(`not joined to ${roomId}`);
  return { room, ...(i < 0 ? {} : { root: nativeId.slice(i + 1) }) };
}

/** The spaces a room is in: joined parents, and the ones its m.space.parent events name. */
function spacesOf(dir: Directory, room: Room): string[] {
  const ids = new Set(dir.parentsOf(room).map((s) => s.nativeId));
  for (const ev of room.ofType('m.space.parent')) if (Array.isArray(ev.content?.via) && ev.content.via.length && ev.state_key) ids.add(ev.state_key);
  return [...ids];
}

const ctxOf = (h: AboutHost, room: Room, kind: P.AboutTarget['kind']): AboutCtx => ({ selfId: h.dir.selfId, kind, spaces: spacesOf(h.dir, room), e2ee: h.e2ee });

/** /joined_members: everyone in, with their profiles here. Undefined if the server would not say. */
async function joinedMembers(h: AboutHost, room: Room): Promise<Map<string, Member> | undefined> {
  try {
    const res: any = await h.api.request('GET', `/_matrix/client/v3/rooms/${enc(room.id)}/joined_members`);
    const out = new Map<string, Member>();
    for (const [user, info] of Object.entries<any>(res?.joined ?? {})) {
      out.set(user, {
        ...(typeof info?.display_name === 'string' && info.display_name.trim() ? { displayName: info.display_name.trim() } : {}),
        ...(typeof info?.avatar_url === 'string' && info.avatar_url.startsWith('mxc://') ? { avatarUrl: info.avatar_url } : {}),
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

/** The `about` command. A thread has no settings of its own; it says which room it is in. */
export async function readAbout(h: AboutHost, target: P.AboutTarget): Promise<P.About> {
  const { room, root } = placeOf(h, target.nativeId);
  if (root) return { noun: 'Thread', fields: {}, facts: [{ label: 'In the room', value: h.dir.displayName(room) ?? room.id }] };
  const members = await joinedMembers(h, room);
  const about = aboutOf(room, ctxOf(h, room, target.kind), members);
  for (const m of about.members?.list ?? []) {
    const p = members?.get(m.id);
    if (!p || m.id === h.dir.selfId) continue;
    h.identity({ nativeId: m.id, handle: m.id, ...(p.displayName ? { displayName: p.displayName } : {}), ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}), ...(h.dir.isContact(m.id) ? { contact: true } : {}) });
  }
  return about;
}

/** The `configure` command: one state event, kept at once (unless sync already brought a newer one), then the About again. */
export async function configureAbout(h: AboutHost, target: P.AboutTarget, change: P.AboutChange): Promise<P.About> {
  const { room, root } = placeOf(h, target.nativeId);
  if (root) throw new Error('A thread has no settings of its own; change its room’s.');
  const write = stateFor(room, ctxOf(h, room, target.kind), change);
  if (write) {
    const before = room.get(write.type, write.stateKey)?.event_id;
    const res: any = await h.api.request('PUT', `/_matrix/client/v3/rooms/${enc(room.id)}/state/${enc(write.type)}/${enc(write.stateKey)}`, { body: write.content });
    if (typeof res?.event_id === 'string' && room.get(write.type, write.stateKey)?.event_id === before) {
      h.applied(room, { type: write.type, state_key: write.stateKey, event_id: res.event_id, sender: h.dir.selfId, origin_server_ts: Date.now(), content: write.content, room_id: room.id });
    }
  }
  return readAbout(h, target);
}
