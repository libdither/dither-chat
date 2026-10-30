/**
 * Discord objects -> dither-chat protocol facts. Pure functions only: no I/O, no
 * global state, so test/map.test.ts can drive every branch with hand-written
 * fixtures. The adapter process calls these on the raw objects the hook forwards.
 *
 * Channel types (https://discord.com/developers/docs/resources/channel):
 *   0 text  2 voice  4 category  5 announcement  10/11/12 threads
 *   13 stage  15 forum  16 media  1 DM  3 group DM
 */

import type {
  AttachmentKind,
  AttachmentFact,
  ConversationFact,
  IdentityFact,
  MessageFact,
  MessageKind,
  NativeMute,
  Shape,
  SpaceFact,
  Variant,
} from '@dither-chat/protocol';
import type {
  RawAttachment,
  RawChannel,
  RawGuild,
  RawGuildSettings,
  RawMessage,
  RawReadState,
  RawUser,
} from './discord-types.ts';

export const DISCORD_EPOCH = 1420070400000n;

/** A Discord snowflake encodes its creation time; useful for read-state cutoffs. */
export function snowflakeToMs(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return 0;
  }
}

export function isoToMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Positions sort as strings on the hub, so zero-pad. Discord positions are small ints. */
export function pos(n: number | undefined): string | undefined {
  if (n === undefined || n === null) return undefined;
  const neg = n < 0;
  return (neg ? '-' : '') + String(Math.abs(n)).padStart(6, '0');
}

export const CHANNEL_TYPE = {
  TEXT: 0,
  DM: 1,
  VOICE: 2,
  GROUP_DM: 3,
  CATEGORY: 4,
  ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  STAGE: 13,
  DIRECTORY: 14,
  FORUM: 15,
  MEDIA: 16,
} as const;

export const THREAD_TYPES = new Set<number>([
  CHANNEL_TYPE.ANNOUNCEMENT_THREAD,
  CHANNEL_TYPE.PUBLIC_THREAD,
  CHANNEL_TYPE.PRIVATE_THREAD,
]);

export function isThread(type: number): boolean {
  return THREAD_TYPES.has(type);
}

// ------------------------------------------------------------------ identities

export function userDisplayName(u: RawUser): string {
  return u.global_name || u.username || u.id;
}

/** cdn avatar url, or undefined if the user has only the default. */
export function avatarUrl(u: RawUser): string | undefined {
  if (!u.avatar) return undefined;
  const ext = u.avatar.startsWith('a_') ? 'gif' : 'webp';
  return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${ext}?size=128`;
}

export function mapUser(u: RawUser, opts: { isSelf?: boolean; contact?: boolean } = {}): IdentityFact {
  return {
    nativeId: u.id,
    handle: u.username,
    displayName: userDisplayName(u),
    avatarUrl: avatarUrl(u),
    isBot: !!u.bot,
    ...(opts.isSelf ? { isSelf: true } : {}),
    ...(opts.contact ? { contact: true } : {}),
  };
}

// ---------------------------------------------------------------------- spaces

export function guildIconUrl(g: RawGuild): string | undefined {
  if (!g.icon) return undefined;
  const ext = g.icon.startsWith('a_') ? 'gif' : 'webp';
  return `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.${ext}?size=128`;
}

export function mapGuild(g: RawGuild, mute?: NativeMute): SpaceFact {
  return {
    nativeId: g.id,
    kind: 'community',
    name: g.name,
    topic: g.description ?? undefined,
    iconUrl: guildIconUrl(g),
    ...(mute ? { mute } : {}),
  };
}

/** A category (type 4) becomes a section space whose parent is its guild. */
export function mapCategory(c: RawChannel, mute?: NativeMute): SpaceFact {
  return {
    nativeId: c.id,
    kind: 'section',
    name: c.name ?? 'category',
    parents: c.guild_id ? [{ nativeId: c.guild_id, position: pos(c.position) }] : undefined,
    ...(mute ? { mute } : {}),
  };
}

// --------------------------------------------------------------- conversations

export function channelShape(type: number): Shape {
  if (type === CHANNEL_TYPE.DM) return 'direct';
  if (type === CHANNEL_TYPE.GROUP_DM) return 'group';
  if (isThread(type)) return 'thread';
  return 'channel';
}

export function channelVariant(c: RawChannel, guild?: RawGuild): Variant | undefined {
  switch (c.type) {
    case CHANNEL_TYPE.ANNOUNCEMENT:
    case CHANNEL_TYPE.ANNOUNCEMENT_THREAD:
      return 'announcement';
    case CHANNEL_TYPE.FORUM:
      return 'forum';
    case CHANNEL_TYPE.MEDIA:
      return 'media';
    case CHANNEL_TYPE.VOICE:
      return 'voice';
    case CHANNEL_TYPE.STAGE:
      return 'stage';
    case CHANNEL_TYPE.TEXT:
      // The guild's designated rules channel reads as a 'rules' variant.
      if (guild?.rules_channel_id && guild.rules_channel_id === c.id) return 'rules';
      return 'text';
    default:
      return undefined;
  }
}

/** Map a guild text/voice/forum/... channel (NOT a category) to a conversation. */
export function mapGuildChannel(c: RawChannel, guild?: RawGuild, mute?: NativeMute): ConversationFact {
  // A channel sits under its category if it has one, else directly under the guild.
  const parentSpace = c.parent_id ?? c.guild_id ?? undefined;
  return {
    nativeId: c.id,
    shape: 'channel',
    variant: channelVariant(c, guild),
    name: c.name ?? undefined,
    topic: c.topic ?? undefined,
    spaces: parentSpace ? [{ nativeId: parentSpace, position: pos(c.position) }] : undefined,
    ...(mute ? { mute } : {}),
  };
}

export function mapThread(c: RawChannel, mute?: NativeMute): ConversationFact {
  return {
    nativeId: c.id,
    shape: 'thread',
    variant: channelVariant(c),
    name: c.name ?? undefined,
    parentConversation: c.parent_id ?? undefined,
    archived: c.thread_metadata?.archived || undefined,
    ...(mute ? { mute } : {}),
  };
}

/** A DM (type 1) or group DM (type 3). selfId is included in participants. */
export function mapPrivateChannel(c: RawChannel, selfId: string, mute?: NativeMute): ConversationFact {
  const recipients = c.recipients ?? [];
  const participants = [selfId, ...recipients.map((r) => r.id)];
  if (c.type === CHANNEL_TYPE.GROUP_DM) {
    const name = c.name?.trim() || recipients.map(userDisplayName).join(', ') || 'Group';
    return {
      nativeId: c.id,
      shape: 'group',
      name,
      participants,
      avatarUrl: c.icon ? `https://cdn.discordapp.com/channel-icons/${c.id}/${c.icon}.webp?size=128` : undefined,
      ...(mute ? { mute } : {}),
    };
  }
  // 1:1 DM: no name (the UI names it after the peer).
  return {
    nativeId: c.id,
    shape: 'direct',
    participants,
    ...(mute ? { mute } : {}),
  };
}

/** Dispatch any channel object to the right conversation mapper, or null for a category. */
export function mapChannel(c: RawChannel, ctx: { selfId: string; guild?: RawGuild; mute?: NativeMute }): ConversationFact | null {
  if (c.type === CHANNEL_TYPE.CATEGORY) return null;
  if (c.type === CHANNEL_TYPE.DM || c.type === CHANNEL_TYPE.GROUP_DM) return mapPrivateChannel(c, ctx.selfId, ctx.mute);
  if (isThread(c.type)) return mapThread(c, ctx.mute);
  return mapGuildChannel(c, ctx.guild, ctx.mute);
}

// -------------------------------------------------------------------- messages

export function attachmentKind(a: RawAttachment): AttachmentKind {
  const ct = (a.content_type ?? '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  // fall back to the extension when Discord omits content_type
  const name = (a.filename ?? a.url ?? '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/.test(name)) return 'image';
  if (/\.(mp4|mov|webm|mkv|avi)$/.test(name)) return 'video';
  if (/\.(mp3|ogg|wav|flac|m4a|opus)$/.test(name)) return 'audio';
  return 'file';
}

export function mapAttachment(a: RawAttachment): AttachmentFact {
  return {
    nativeId: a.id,
    kind: attachmentKind(a),
    mime: a.content_type,
    name: a.filename,
    size: a.size,
    width: a.width,
    height: a.height,
    url: a.url,
  };
}

/**
 * Discord message type -> a readable string for system messages, or null if this
 * is an ordinary (user-authored) message whose own content should be used.
 * Reply (19) and the default (0) are ordinary.
 */
export function systemMessageText(m: RawMessage): string | null {
  switch (m.type) {
    case undefined:
    case 0: // DEFAULT
    case 19: // REPLY
      return null;
  }
  const who = m.author ? userDisplayName(m.author) : 'Someone';
  switch (m.type) {
    case 1:
      return `${who} added someone to the group.`;
    case 2:
      return `${who} removed someone from the group.`;
    case 3:
      return `${who} started a call.`;
    case 4:
      return `${who} changed the channel name${m.content ? `: ${m.content}` : '.'}`;
    case 5:
      return `${who} changed the channel icon.`;
    case 6:
      return `${who} pinned a message to this channel.`;
    case 7:
      return `${who} joined the server.`;
    case 8:
    case 9:
    case 10:
    case 11:
      return `${who} boosted the server.`;
    case 12:
      return `${who} is live.`;
    case 15:
    case 16:
    case 17:
      return `${who} updated the channel.`;
    case 18:
      return `${who} started a thread${m.content ? `: ${m.content}` : '.'}`;
    case 21:
      return null; // THREAD_STARTER_MESSAGE: the referenced content is shown instead
    case 24: // AUTO_MODERATION_ACTION
      return 'A message was flagged by AutoMod.';
    case 46:
      return `${who} responded to a poll.`;
    default:
      // Unknown system type with no content: say something rather than show blank.
      return m.content ? null : `(unsupported message type ${m.type})`;
  }
}

/** Reaction emoji -> a stable key. Custom emoji use "name:id", unicode use the glyph. */
export function reactionKey(e: { id?: string | null; name: string | null }): string {
  if (e.id) return `${e.name ?? '_'}:${e.id}`;
  return e.name ?? '';
}

/** Discord uses <@!id> for nickname mentions; the ontology wants <@id>. */
export function normalizeMentions(body: string): string {
  return body.replace(/<@!(\d+)>/g, '<@$1>');
}

export function messageKind(m: RawMessage, system: string | null): MessageKind {
  if (system !== null) return 'system';
  if (m.attachments && m.attachments.length && (!m.content || !m.content.trim())) return 'media';
  return 'text';
}

/** Whitelisted subset of an embed, for MessageFact.extra. */
function embedExtra(m: RawMessage) {
  if (!m.embeds || !m.embeds.length) return undefined;
  const embeds = m.embeds.slice(0, 6).map((e) => ({
    type: e.type,
    title: e.title,
    description: e.description,
    url: e.url,
    provider: e.provider?.name,
    image: e.image?.url ?? e.thumbnail?.url,
  }));
  return { embeds };
}

export function mapMessage(m: RawMessage, selfId: string): MessageFact {
  const system = systemMessageText(m);
  const body = system !== null ? system : normalizeMentions(m.content ?? '');
  const mentionsSelf =
    !!m.mention_everyone || (m.mentions?.some((u) => u.id === selfId) ?? false) || body.includes(`<@${selfId}>`);
  const extra = embedExtra(m);
  const replyTo = m.type !== 21 ? m.message_reference?.message_id : undefined;
  return {
    nativeId: m.id,
    conversation: m.channel_id,
    author: m.author.id,
    ts: isoToMs(m.timestamp) || snowflakeToMs(m.id),
    editedTs: m.edited_timestamp ? isoToMs(m.edited_timestamp) : undefined,
    kind: messageKind(m, system),
    body,
    replyTo,
    // A message carrying a `thread` object is the root of that thread conversation.
    threadRoot: m.thread?.id,
    mentionsSelf: mentionsSelf || undefined,
    attachments: m.attachments?.length ? m.attachments.map(mapAttachment) : undefined,
    reactions: m.reactions?.length
      ? m.reactions.map((r) => ({ key: reactionKey(r.emoji), authors: r.me ? [selfId] : [] }))
      : undefined,
    extra,
  };
}

// ------------------------------------------------------------------ read state

/** A Discord read state -> the `read` event payload. upToTs comes from the last read snowflake. */
export function mapReadState(rs: RawReadState): { upToTs: number; mentions: number } {
  return {
    upToTs: rs.last_message_id ? snowflakeToMs(rs.last_message_id) : 0,
    mentions: rs.mention_count ?? 0,
  };
}

// ----------------------------------------------------------------------- mutes

/** Discord notification settings -> a NativeMute, or undefined when nothing is muted. */
export function mapMute(s: {
  muted?: boolean;
  mute_config?: { end_time?: string | null } | null;
  message_notifications?: number;
}): NativeMute | undefined {
  // message_notifications: 0 all, 1 only @mentions, 2 nothing, 3 inherit
  let level: NativeMute['level'] | undefined;
  if (s.muted) level = 'none';
  else if (s.message_notifications === 0) level = 'all';
  else if (s.message_notifications === 1) level = 'mentions';
  else if (s.message_notifications === 2) level = 'none';

  if (level === undefined && !s.muted) return undefined;

  const until = s.muted && s.mute_config?.end_time ? isoToMs(s.mute_config.end_time) : undefined;
  const mute: NativeMute = {};
  if (level) mute.level = level;
  if (until) mute.until = until;
  return Object.keys(mute).length ? mute : undefined;
}

/** Pull a channel's effective mute out of a guild-settings object, if present. */
export function channelMute(gs: RawGuildSettings | undefined, channelId: string): NativeMute | undefined {
  const o = gs?.channel_overrides?.find((c) => c.channel_id === channelId);
  if (!o) return undefined;
  return mapMute(o);
}
