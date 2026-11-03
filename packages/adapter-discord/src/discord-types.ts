/**
 * Minimal shapes of the raw Discord objects the in-page hook forwards, plus the
 * little "bridge" protocol spoken between the extension's service worker and this
 * adapter process. Only whitelisted fields appear here: the hook must never send
 * anything this file does not name.
 *
 * These mirror the Discord client's own gateway/REST objects closely enough that
 * the fixtures in test/ read like real payloads. Nothing here talks to the hub;
 * map.ts turns these into protocol facts.
 */

// ----------------------------------------------------------------- raw Discord

export interface RawUser {
  id: string;
  username?: string;
  global_name?: string | null;
  /** legacy discriminator; "0" for the new username system */
  discriminator?: string;
  avatar?: string | null;
  bot?: boolean;
}

export interface RawGuild {
  id: string;
  name: string;
  icon?: string | null;
  description?: string | null;
  rules_channel_id?: string | null;
}

/** A guild channel, category, thread, DM or group DM. Discord uses one object for all. */
export interface RawChannel {
  id: string;
  type: number;
  guild_id?: string | null;
  name?: string | null;
  topic?: string | null;
  position?: number;
  parent_id?: string | null;
  /** DMs / group DMs */
  recipients?: RawUser[];
  owner_id?: string | null;
  icon?: string | null;
  /** threads */
  thread_metadata?: { archived?: boolean; locked?: boolean };
  last_message_id?: string | null;
}

export interface RawAttachment {
  id?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  width?: number;
  height?: number;
  url: string;
  proxy_url?: string;
}

export interface RawEmbed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  provider?: { name?: string };
  author?: { name?: string };
  fields?: { name: string; value: string }[];
  thumbnail?: { url?: string };
  image?: { url?: string };
}

export interface RawEmoji {
  id?: string | null;
  name: string | null;
  animated?: boolean;
}

export interface RawReaction {
  emoji: RawEmoji;
  /** Normal plus super, unless count_details is there. */
  count?: number;
  count_details?: { normal?: number; burst?: number };
  burst_count?: number;
  me?: boolean;
  me_burst?: boolean;
  burst_colors?: string[];
}

export interface RawMessageReference {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
  /** 0 a reply (the default), 1 a forward. */
  type?: number;
}

export interface RawMessage {
  id: string;
  channel_id: string;
  guild_id?: string | null;
  author: RawUser;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  /** https://discord.com/developers/docs/resources/channel#message-object-message-types */
  type?: number;
  tts?: boolean;
  mention_everyone?: boolean;
  mentions?: RawUser[];
  attachments?: RawAttachment[];
  embeds?: RawEmbed[];
  reactions?: RawReaction[];
  message_reference?: RawMessageReference;
  /** present on the message that started a thread */
  thread?: RawChannel;
  /** a forward: the content lives here, and the message's own fields are empty */
  message_snapshots?: { content?: string; timestamp?: string; attachments?: RawAttachment[]; embeds?: RawEmbed[] }[];
  sticker_items?: { name: string }[];
  poll?: { question?: string; answers?: string[] };
  nonce?: string | number;
}

/** Discord read state (ReadStateStore): one row per channel the user has seen. */
export interface RawReadState {
  id: string; // channel id
  last_message_id?: string | null;
  mention_count?: number;
}

/** A single friend/block relationship (RelationshipStore). type 1 = friend. */
export interface RawRelationship {
  id: string; // the other user's id
  type: number;
  user?: RawUser;
}

/** Per-guild notification settings (UserGuildSettingsStore). */
export interface RawChannelOverride {
  channel_id: string;
  muted?: boolean;
  mute_config?: { end_time?: string | null } | null;
  message_notifications?: number;
}
export interface RawGuildSettings {
  guild_id: string | null; // null = the "private channels" pseudo-guild (DMs)
  muted?: boolean;
  mute_config?: { end_time?: string | null } | null;
  message_notifications?: number;
  channel_overrides?: RawChannelOverride[];
}

/** Everything the hook gathers once it is logged in and the stores are warm. */
export interface RawSnapshot {
  self?: RawUser;
  guilds?: RawGuild[];
  /** guild channels and categories (types 0,2,4,5,13,15,16) */
  channels?: RawChannel[];
  /** active threads (types 10,11,12) */
  threads?: RawChannel[];
  /** DMs and group DMs (types 1,3) */
  privateChannels?: RawChannel[];
  relationships?: RawRelationship[];
  /** users referenced anywhere above that are not otherwise sent */
  users?: RawUser[];
  readStates?: RawReadState[];
  guildSettings?: RawGuildSettings[];
}

// --------------------------------------------------------------- bridge protocol
// service worker  <->  adapter process, over ws://127.0.0.1:<port>/?token=...

/** The auth/page/gateway state the hook reports. Drives adapter status. */
export type PageState = 'loading' | 'login' | 'app' | 'captcha' | 'verify' | 'crashed';

/** service worker -> adapter */
export type BridgeUp =
  | { t: 'ready' }
  | { t: 'finders'; results: Record<string, boolean>; detail?: string }
  | { t: 'page'; state: PageState; url?: string }
  | { t: 'connection'; open: boolean }
  | { t: 'snapshot'; data: RawSnapshot }
  | { t: 'identities'; users: RawUser[] }
  | { t: 'dispatch'; event: DispatchName; data: any }
  /** A sign-in request Discord refused, from the client's own log. */
  | { t: 'loginIssue'; route: string; status: number; captcha?: string; message?: string; code?: number }
  /** A call's bridge signalling, its participants (with their users, so they have names), or its end. */
  | { t: 'call'; call: string; signal?: unknown; state?: { channelId: string; participants: { id: string; muted: boolean; deafened: boolean; speaking: boolean; video?: boolean }[] }; users?: RawUser[]; ended?: string }
  | { t: 'reply'; id: string; ok: true; result?: unknown }
  | { t: 'reply'; id: string; ok: false; error: string; retryAfter?: number }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: unknown };

/** Flux actions the hook forwards. Keep this list in sync with hook.js. */
export type DispatchName =
  | 'MESSAGE_CREATE'
  | 'MESSAGE_UPDATE'
  | 'MESSAGE_DELETE'
  | 'MESSAGE_REACTION_ADD'
  | 'MESSAGE_REACTION_REMOVE'
  | 'MESSAGE_REACTION_REMOVE_ALL'
  | 'MESSAGE_REACTION_REMOVE_EMOJI'
  | 'CHANNEL_CREATE'
  | 'CHANNEL_UPDATES'
  | 'CHANNEL_DELETE'
  | 'GUILD_CREATE'
  | 'GUILD_UPDATE'
  | 'GUILD_DELETE'
  | 'THREAD_CREATE'
  | 'THREAD_UPDATE'
  | 'THREAD_DELETE'
  | 'THREAD_LIST_SYNC'
  | 'MESSAGE_ACK'
  | 'TYPING_START';

/** adapter -> service worker: a command for the hook to run through the client's own code. */
export type BridgeDown =
  | { t: 'cmd'; id: string; cmd: HookCommand }
  | { t: 'ping' };

export type HookCommand =
  | { kind: 'lab'; op: string; [k: string]: unknown }
  | { kind: 'send'; channelId: string; content: string; replyTo?: string; nonce: string; files?: { name: string; mime: string; size: number; base64: string }[] }
  /** reply { nativeId } of the forward; the note follows it as its own message, as the client's forward does. */
  | { kind: 'forward'; channelId: string; source: { channelId: string; messageId: string }; note?: string; nonce: string }
  | { kind: 'openDirect'; userId: string }
  | { kind: 'history'; channelId: string; limit: number; beforeId?: string }
  | { kind: 'markRead'; channelId: string; messageId: string }
  | { kind: 'react'; channelId: string; messageId: string; emoji: string; remove?: boolean; burst?: boolean }
  | { kind: 'reactors'; channelId: string; messageId: string; emoji: string; burst?: boolean }
  | { kind: 'reactionContext'; channelId: string }
  | { kind: 'edit'; channelId: string; messageId: string; content: string }
  | { kind: 'redact'; channelId: string; messageId: string }
  | { kind: 'fetchMedia'; url: string }
  /** join: reply { direct?: DirectVoiceSession }. */
  | { kind: 'call'; call: string; op: 'join'; channelId: string; mode: 'bridge' | 'direct'; muted?: boolean; deafened?: boolean }
  | { kind: 'call'; call: string; op: 'leave' }
  | { kind: 'call'; call: string; op: 'mute'; muted: boolean; deafened: boolean }
  | { kind: 'call'; call: string; op: 'signal' | 'note'; data: unknown };
