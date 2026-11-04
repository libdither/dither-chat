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
  | { kind: 'typing'; channelId: string; stop?: boolean }
  | { kind: 'react'; channelId: string; messageId: string; emoji: string; remove?: boolean; burst?: boolean }
  | { kind: 'reactors'; channelId: string; messageId: string; emoji: string; burst?: boolean }
  | { kind: 'reactionContext'; channelId: string }
  | { kind: 'edit'; channelId: string; messageId: string; content: string }
  | { kind: 'redact'; channelId: string; messageId: string }
  | { kind: 'fetchMedia'; url: string }
  /** reply RawAbout, from the client's stores only. */
  | { kind: 'about'; target: 'conversation' | 'space'; id: string }
  /** PATCH one channel or server; reply { channel } or { guild } as it now stands. */
  | { kind: 'configure'; channelId?: string; guildId?: string; patch: RawAboutPatch }
  /** reply RawProfile: the client's own profile fetch, then its stores. */
  | { kind: 'profile'; userId: string }
  /** join: reply { direct?: DirectVoiceSession }. */
  | { kind: 'call'; call: string; op: 'join'; channelId: string; mode: 'bridge' | 'direct'; muted?: boolean; deafened?: boolean }
  | { kind: 'call'; call: string; op: 'leave' }
  | { kind: 'call'; call: string; op: 'mute'; muted: boolean; deafened: boolean }
  | { kind: 'call'; call: string; op: 'signal' | 'note'; data: unknown };

// ------------------------------------------------------------ about and settings

/** A server role, from the client's role store. */
export interface RawRole {
  id: string;
  name: string;
  /** CSS colour, or null for none. */
  color?: string | null;
  /** Higher is more senior; @everyone is 0. */
  position: number;
  /** Shown apart in the member list. */
  hoist?: boolean;
}

/** A loaded server member: who, and their role ids. */
export interface RawMember {
  user: RawUser;
  roles: string[];
  /** The colour the client shows their name in. */
  color?: string | null;
}

/** What this account may do where it is, by the client's own check. null: the client did not say. */
export type RawCan = Partial<Record<'createInvite' | 'manageChannels' | 'manageGuild' | 'sendMessages' | 'manageMessages' | 'manageRoles' | 'manageThreads' | 'pinMessages', boolean | null>>;

/** The settings fields of a channel the hook adds to RawChannel. */
export interface RawAboutChannel extends RawChannel {
  nsfw?: boolean;
  rate_limit_per_user?: number;
  /** The @everyone overwrite denies Send Messages (here, or on a thread's parent). */
  everyone_denies_send?: boolean;
}

export interface RawAboutGuild extends RawGuild {
  owner_id?: string | null;
  owner?: RawUser | null;
  verification_level?: number | null;
  nsfw_level?: number | null;
  community?: boolean;
}

/** The hook's answer to `about`, read from the client's stores alone. */
export interface RawAbout {
  selfId: string | null;
  /** The conversation, or the category when the target is a section space. */
  channel?: RawAboutChannel;
  /** The server the target is, or is in. */
  guild?: RawAboutGuild;
  roles?: RawRole[];
  /** Members the client has loaded, at most 200. */
  members?: RawMember[];
  memberCount?: number | null;
  /** On the target itself (the channel, category or server). */
  can: RawCan;
  /** On the server, when the target is in one. */
  guildCan?: RawCan;
}

/** The only fields `configure` may send. */
export interface RawAboutPatch {
  name?: string;
  topic?: string;
  rate_limit_per_user?: number;
  nsfw?: boolean;
}

// ------------------------------------------------------------------- profiles

/** A connected account as the profile lists it. */
export interface RawConnectedAccount {
  /** "github", "steam", "twitter", ... */
  type: string;
  id?: string;
  name: string;
  verified?: boolean;
  /** The platform's name from the client's own table ("GitHub", "X"). Absent: the hook could not ask it. */
  label?: string;
  /** The link the client builds for it, when it builds one. */
  url?: string;
}

/** A server you share with them, and who they are there as far as the client has loaded them. */
export interface RawMutualGuild {
  id: string;
  name?: string;
  nick?: string | null;
  /** Their roles there, when the client has them as a member. */
  roles?: RawRole[];
  joined_at?: string | null;
}

/**
 * The hook's answer to `profile`: what the client's profile shows after its own fetch, from its stores, or from the
 * REST body when it has no such stores. null: the client did not say (not asked, or the fetch failed).
 */
export interface RawProfile {
  selfId: string | null;
  user: RawUser | null;
  bio?: string | null;
  pronouns?: string | null;
  /** Banner image hash. */
  banner?: string | null;
  /** The banner colour, as a number. */
  accent_color?: number | null;
  /** The custom status line. */
  custom_status?: { text?: string | null; emoji?: RawEmoji | null } | null;
  /** RelationshipStore type: 0 none, 1 friend, 2 blocked, 3 they asked you, 4 you asked them. */
  relationship?: number | null;
  /** When you became friends (ISO). */
  friend_since?: string | null;
  /** Their name before the new usernames ("name#1234"). */
  legacy_username?: string | null;
  connected_accounts?: RawConnectedAccount[];
  mutual_guilds?: RawMutualGuild[] | null;
  mutual_friends?: RawUser[] | null;
  mutual_friends_count?: number | null;
  /** When the person is you: your friends. */
  friends?: RawUser[];
  /** Why the profile fetch failed, when it did; the rest is what the stores still had. */
  error?: string;
}
