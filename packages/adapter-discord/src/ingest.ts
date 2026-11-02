/**
 * Orchestration layer: turns a raw snapshot or a single forwarded Flux action into
 * the sequence of protocol facts the hub expects. Pure except for the small mutable
 * AdapterState it threads through (guild cache, mute settings, known conversations,
 * friends) so later events resolve rules channels, mutes and contacts correctly.
 *
 * main.ts emits whatever these return; test/pipeline.test.ts feeds the same output
 * straight into a real hub Store, so this is where "raw Discord -> facts" is proven
 * end to end without a browser.
 */

import type * as P from '@dither-chat/protocol';
import type { DispatchName, RawChannel, RawGuild, RawGuildSettings, RawMessage, RawSnapshot, RawUser } from './discord-types.ts';
import { CHANNEL_TYPE, channelMute, customEmoji, isThread, mapCategory, mapGuild, mapGuildChannel, mapMessage, mapMute, mapPrivateChannel, mapReadState, mapThread, mapUser, reactionKey, snowflakeToMs } from './map.ts';

export interface AdapterState {
  selfId: string;
  guilds: Map<string, RawGuild>;
  guildSettings: Map<string | null, RawGuildSettings>;
  known: Set<string>;
  friends: Set<string>;
  /** user id -> what we last told the hub about them */
  users: Map<string, string>;
}

export function newState(): AdapterState {
  return { selfId: '', guilds: new Map(), guildSettings: new Map(), known: new Set(), friends: new Set(), users: new Map() };
}

export interface SnapshotResult {
  events: P.AdapterEvent[];
  /** Channels worth a bounded recent-message backfill (DMs + unread-mention channels). */
  backfillTargets: string[];
}

export function translateSnapshot(data: RawSnapshot, st: AdapterState): SnapshotResult {
  const events: P.AdapterEvent[] = [];
  if (data.self) st.selfId = data.self.id;
  const selfId = st.selfId;

  for (const r of data.relationships ?? []) if (r.type === 1) st.friends.add(r.id);
  for (const gs of data.guildSettings ?? []) st.guildSettings.set(gs.guild_id, gs);

  for (const g of data.guilds ?? []) {
    st.guilds.set(g.id, g);
    const gs = st.guildSettings.get(g.id);
    events.push({ t: 'space', space: mapGuild(g, gs ? mapMute(gs) : undefined) });
  }

  for (const c of data.channels ?? []) {
    if (c.type === CHANNEL_TYPE.CATEGORY) {
      events.push({ t: 'space', space: mapCategory(c, channelMute(st.guildSettings.get(c.guild_id ?? ''), c.id)) });
    } else {
      events.push(...guildChannelEvents(c, st));
    }
  }

  for (const t of data.threads ?? []) {
    st.known.add(t.id);
    events.push({ t: 'conversation', conversation: mapThread(t) });
  }

  const dmSettings = st.guildSettings.get(null);
  for (const c of data.privateChannels ?? []) {
    st.known.add(c.id);
    events.push({ t: 'conversation', conversation: mapPrivateChannel(c, selfId, channelMute(dmSettings, c.id)) });
    for (const r of c.recipients ?? []) events.push({ t: 'identity', identity: mapUser(r, { contact: st.friends.has(r.id) }) });
  }

  for (const u of data.users ?? []) if (u.id !== selfId) events.push({ t: 'identity', identity: mapUser(u, { contact: st.friends.has(u.id) }) });

  for (const rs of data.readStates ?? []) {
    if (!st.known.has(rs.id)) continue;
    const { upToTs, mentions } = mapReadState(rs);
    if (upToTs > 0) events.push({ t: 'read', conversation: rs.id, upToTs, mentions });
  }

  // Not every read state is a channel (guild-level ones share the table).
  const mentionChannels = (data.readStates ?? []).filter((r) => (r.mention_count ?? 0) > 0 && st.known.has(r.id)).map((r) => r.id);
  const backfillTargets: string[] = [];
  for (const c of data.privateChannels ?? []) backfillTargets.push(c.id);
  for (const id of mentionChannels) if (!backfillTargets.includes(id)) backfillTargets.push(id);

  return { events, backfillTargets };
}

/** What the hook answered to openDirect. The gateway's CHANNEL_CREATE says the same again later, harmlessly. */
export function openedDirect(peer: string, r: { channelId: string; channel?: RawChannel | null }, st: AdapterState): P.AdapterEvent[] {
  const recipients = r.channel?.recipients?.length ? r.channel.recipients : [{ id: peer } as RawUser];
  st.known.add(r.channelId);
  return [...userFacts(recipients, st), { t: 'conversation', conversation: mapPrivateChannel({ id: r.channelId, type: CHANNEL_TYPE.DM, recipients }, st.selfId) }];
}

/** A message and the people it names. Guild members are not in the snapshot, so this is the only place the hub learns their names. */
export function messageEvents(m: RawMessage, st: AdapterState, live: boolean): P.AdapterEvent[] {
  const message = mapMessage(m, st.selfId);
  // A message fetched over REST is the whole truth, so no reactions means none are left. A gateway update may just not say.
  if (!live) message.reactions ??= [];
  return [...userFacts([m.author, ...(m.mentions ?? [])], st), { t: 'message', live, message }];
}

/** Identity facts for users the hub has not heard about yet, or not in this form. */
export function userFacts(users: (RawUser | null | undefined)[], st: AdapterState): P.AdapterEvent[] {
  const events: P.AdapterEvent[] = [];
  for (const u of users) {
    if (!u?.username || u.id === st.selfId) continue;
    const known = JSON.stringify([u.username, u.global_name, u.avatar]);
    if (st.users.get(u.id) === known) continue;
    st.users.set(u.id, known);
    events.push({ t: 'identity', identity: mapUser(u, { contact: st.friends.has(u.id) }) });
  }
  return events;
}

function guildChannelEvents(c: RawChannel, st: AdapterState): P.AdapterEvent[] {
  st.known.add(c.id);
  const guild = c.guild_id ? st.guilds.get(c.guild_id) : undefined;
  const mute = channelMute(st.guildSettings.get(c.guild_id ?? ''), c.id);
  return [{ t: 'conversation', conversation: mapGuildChannel(c, guild, mute) }];
}

/** One forwarded Flux action -> zero or more facts. */
export function translateDispatch(event: DispatchName, a: any, st: AdapterState): P.AdapterEvent[] {
  const selfId = st.selfId;
  switch (event) {
    case 'MESSAGE_CREATE':
      // An optimistic one is the client echoing a send in flight under a temporary id; the real one follows from the gateway.
      return a.message && !a.optimistic ? messageEvents(a.message, st, true) : [];
    case 'MESSAGE_UPDATE':
      return a.message && a.message.author ? messageEvents(a.message, st, true) : [];
    case 'MESSAGE_DELETE':
      return a.id && a.channelId ? [{ t: 'delete', conversation: a.channelId, nativeId: a.id }] : [];
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE':
      // An optimistic one is the client's own guess; the gateway confirms it.
      if (!a.messageId || !a.emoji || a.optimistic) return [];
      return [
        ...userFacts([a.user], st),
        {
          t: 'reaction',
          conversation: a.channelId,
          message: a.messageId,
          author: a.userId,
          key: reactionKey(a.emoji),
          ...(event === 'MESSAGE_REACTION_REMOVE' ? { remove: true } : {}),
          ...(a.reactionType === 1 ? { style: 'super' as const } : {}),
          ...(a.colors?.length ? { colors: a.colors } : {}),
          ...(a.emoji.id ? { emoji: customEmoji(a.emoji) } : {}),
        },
      ];
    case 'MESSAGE_REACTION_REMOVE_ALL':
      return a.messageId ? [{ t: 'reactionsCleared', conversation: a.channelId, message: a.messageId }] : [];
    case 'MESSAGE_REACTION_REMOVE_EMOJI':
      return a.messageId && a.emoji ? [{ t: 'reactionsCleared', conversation: a.channelId, message: a.messageId, key: reactionKey(a.emoji) }] : [];
    case 'CHANNEL_CREATE':
      return a.channel ? routeChannel(a.channel, st) : [];
    case 'CHANNEL_UPDATES':
      return (a.channels ?? []).flatMap((c: RawChannel) => routeChannel(c, st));
    case 'CHANNEL_DELETE':
      return a.channel?.id ? [{ t: 'leave', kind: 'conversation', nativeId: a.channel.id }] : [];
    case 'GUILD_CREATE':
    case 'GUILD_UPDATE':
      if (!a.guild) return [];
      st.guilds.set(a.guild.id, a.guild);
      return [{ t: 'space', space: mapGuild(a.guild) }];
    case 'GUILD_DELETE':
      return a.id ? [{ t: 'leave', kind: 'space', nativeId: a.id }] : [];
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE':
      if (!a.channel) return [];
      st.known.add(a.channel.id);
      return [{ t: 'conversation', conversation: mapThread(a.channel) }];
    case 'THREAD_DELETE':
      return a.channel?.id ? [{ t: 'leave', kind: 'conversation', nativeId: a.channel.id }] : [];
    case 'THREAD_LIST_SYNC':
      return (a.threads ?? []).map((t: RawChannel) => {
        st.known.add(t.id);
        return { t: 'conversation', conversation: mapThread(t) } as P.AdapterEvent;
      });
    case 'MESSAGE_ACK':
      return a.channelId && a.messageId
        ? [{ t: 'read', conversation: a.channelId, upToTs: snowflakeToMs(a.messageId), mentions: a.mentionCount ?? 0, unread: a.mentionCount ?? 0 }]
        : [];
    case 'TYPING_START':
      return a.channelId && a.userId && a.userId !== selfId ? [{ t: 'typing', conversation: a.channelId, author: a.userId }] : [];
    default:
      return [];
  }
}

function routeChannel(c: RawChannel, st: AdapterState): P.AdapterEvent[] {
  if (c.type === CHANNEL_TYPE.CATEGORY) return [{ t: 'space', space: mapCategory(c) }];
  if (c.type === CHANNEL_TYPE.DM || c.type === CHANNEL_TYPE.GROUP_DM) {
    st.known.add(c.id);
    return [{ t: 'conversation', conversation: mapPrivateChannel(c, st.selfId) }];
  }
  if (isThread(c.type)) {
    st.known.add(c.id);
    return [{ t: 'conversation', conversation: mapThread(c) }];
  }
  return guildChannelEvents(c, st);
}
