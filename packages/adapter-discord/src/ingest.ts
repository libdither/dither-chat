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
import type { DispatchName, RawChannel, RawGuild, RawGuildSettings, RawSnapshot } from './discord-types.ts';
import { CHANNEL_TYPE, channelMute, isThread, mapCategory, mapGuild, mapGuildChannel, mapMessage, mapMute, mapPrivateChannel, mapReadState, mapThread, mapUser, reactionKey, snowflakeToMs } from './map.ts';

export interface AdapterState {
  selfId: string;
  guilds: Map<string, RawGuild>;
  guildSettings: Map<string | null, RawGuildSettings>;
  known: Set<string>;
  friends: Set<string>;
}

export function newState(): AdapterState {
  return { selfId: '', guilds: new Map(), guildSettings: new Map(), known: new Set(), friends: new Set() };
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

  const mentionChannels = (data.readStates ?? []).filter((r) => (r.mention_count ?? 0) > 0).map((r) => r.id);
  const backfillTargets: string[] = [];
  for (const c of data.privateChannels ?? []) backfillTargets.push(c.id);
  for (const id of mentionChannels) if (!backfillTargets.includes(id)) backfillTargets.push(id);

  return { events, backfillTargets };
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
      return a.message ? [{ t: 'message', live: true, message: mapMessage(a.message, selfId) }] : [];
    case 'MESSAGE_UPDATE':
      return a.message && a.message.author ? [{ t: 'message', live: true, message: mapMessage(a.message, selfId) }] : [];
    case 'MESSAGE_DELETE':
      return a.id && a.channelId ? [{ t: 'delete', conversation: a.channelId, nativeId: a.id }] : [];
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE':
      return a.messageId && a.emoji
        ? [{ t: 'reaction', conversation: a.channelId, message: a.messageId, author: a.userId, key: reactionKey(a.emoji), remove: event === 'MESSAGE_REACTION_REMOVE' }]
        : [];
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
      return a.channel ? routeChannel(a.channel, st) : [];
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
