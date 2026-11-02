/**
 * Adapter <-> hub protocol.
 *
 * An adapter is one process per account (a Matrix sync loop, a signal-cli
 * daemon wrapper, a sandboxed Discord web client). It speaks only in
 * *native* IDs and sends idempotent facts; the hub maps them to stable hub
 * IDs, deduplicates objects seen by several accounts, and decides what
 * the user is notified about.
 *
 * Transport: WebSocket to ws://127.0.0.1:<hub>/adapter?account=<id>&token=<token>,
 * one JSON object per text frame. The hub passes these to spawned adapters:
 *
 *   DITHER_HUB_URL         ws://127.0.0.1:8460/adapter
 *   DITHER_ACCOUNT_ID      acc_...
 *   DITHER_ADAPTER_TOKEN   per-account secret for the WebSocket
 *   DITHER_ACCOUNT_DIR     private state dir (0700) for sessions, keys, profiles
 *   DITHER_ACCOUNT_CONFIG  JSON, non-secret account config (homeserver, phone, ...)
 *
 * Secrets the user typed in (passwords, tokens) are in $DITHER_ACCOUNT_DIR/secret.json.
 * Adapters may rewrite that file (e.g. swap a password for an access token).
 *
 * Every reference inside a fact (author, conversation, replyTo, ...) is a
 * native ID on the adapter's own network.
 */

import type { AccountStatus, AttachmentKind, Attention, MessageKind, Network, ReactionStyle, Shape, SpaceKind, Variant } from './ontology.ts';

export type Capability =
  | 'send'
  | 'history'
  | 'react'
  | 'edit'
  | 'redact'
  | 'markRead'
  | 'typing'
  | 'threads'
  | 'media'
  /** Sending files, not just showing them. */
  | 'sendMedia'
  | 'liveView';

// ---------------------------------------------------------------- facts

export interface IdentityFact {
  nativeId: string; //      Discord snowflake | Signal ACI uuid | Matrix @user:server
  handle?: string; //       username | phone number | @user:server
  displayName?: string;
  avatarUrl?: string; //    https://, mxc://, or file:// (see MediaUrl)
  isBot?: boolean;
  isSelf?: boolean;
  /** In the address book / friends list. Contacts get a Person, strangers in big channels do not. */
  contact?: boolean;
}

export interface SpaceRef {
  nativeId: string;
  /** Sort key within the parent: Discord `position`, Matrix `order`. Compared as strings, so zero-pad numbers. */
  position?: string;
}

export interface NativeMute {
  level?: 'all' | 'mentions' | 'none';
  /** ms epoch; muted until then. */
  until?: number;
}

export interface SpaceFact {
  nativeId: string; // Discord guild or category snowflake | Matrix space room id
  kind: SpaceKind;
  name: string;
  topic?: string;
  iconUrl?: string;
  /** Parent spaces. Discord category -> its guild; Matrix subspace -> every space that lists it. */
  parents?: SpaceRef[];
  mute?: NativeMute;
}

export interface ConversationFact {
  /**
   * Discord channel snowflake | Matrix room id | Matrix thread "<roomId>|<rootEventId>" |
   * Signal group "group:<base64 id>" | Signal 1:1 "dm:<selfAci>:<peerAci>"
   */
  nativeId: string;
  shape: Shape;
  variant?: Variant;
  /** Omit for directs: the UI names them after the peer. */
  name?: string;
  topic?: string;
  avatarUrl?: string;
  encrypted?: boolean;
  archived?: boolean;
  /** Threads: the conversation they hang off. */
  parentConversation?: string;
  /** Containing spaces (a graph: a Matrix room may be in several). */
  spaces?: SpaceRef[];
  /** Identity native IDs. Only for direct, group and self; big channels skip this. */
  participants?: string[];
  mute?: NativeMute;
  lastMessageAt?: number;
}

/**
 * Canonical message body: a Discord-flavoured Markdown subset.
 *   **bold** *italic* __underline__ ~~strike~~ `code` ```fenced``` ||spoiler|| > quote
 *   mentions as <@identityNativeId>, rooms as <#conversationNativeId>, links bare or [text](url)
 * Adapters convert from Matrix HTML / Signal body ranges into this.
 */
export interface MessageFact {
  /** Discord snowflake | Matrix event id | Signal "<authorAci>:<sentTimestamp>" */
  nativeId: string;
  conversation: string;
  author: string;
  ts: number;
  editedTs?: number;
  kind?: MessageKind;
  body: string;
  replyTo?: string;
  /** This message is the root of that thread conversation. */
  threadRoot?: string;
  mentionsSelf?: boolean;
  attachments?: AttachmentFact[];
  /** Full reaction snapshot (backfill). Live changes use the `reaction` event. */
  reactions?: ReactionFact[];
  extra?: Record<string, unknown>;
}

/** A custom emoji. Reactions refer to it by key; the hub keeps a catalog per network. */
export interface CustomEmojiFact {
  key: string; //     Discord "name:id" | Matrix mxc://
  name: string; //    shortcode, without colons
  url: MediaUrl;
  animated?: boolean;
}

export interface ReactionFact {
  key: string;
  style?: ReactionStyle;
  /** Who reacted, as far as the network says. */
  authors: string[];
  /** The network's total, when it does not name everyone (Discord). Omit when authors is the full list. */
  count?: number;
  /** Super reactions: the colours of the effect, as CSS hex. */
  colors?: string[];
  emoji?: CustomEmojiFact;
}

/** What this account can react with here. Network-wide rules are in REACTION_RULES. */
export interface ReactionContext {
  canReact: boolean;
  /** Why not, or a limit worth knowing. Shown in the picker. */
  reason?: string;
  /** Only reactions already on the message can be added to (Discord without Add Reactions). */
  existingOnly?: boolean;
  /** Custom emoji usable here: this server first, then others, Matrix image packs. */
  custom: { id: string; name: string; icon?: MediaUrl; emoji: CustomEmojiFact[] }[];
  /** Absent: this network has no super reactions. */
  super?: { available: boolean; reason?: string };
}

/**
 * A URL the hub can resolve: https:// is fetched directly, file:// is served
 * if it lives under the account dir, anything else (mxc://, attachment ids)
 * is resolved by sending the adapter a `fetchMedia` command.
 */
export type MediaUrl = string;

export interface AttachmentFact {
  nativeId?: string;
  kind: AttachmentKind;
  mime?: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  url: MediaUrl;
}

/** A file to send, in the hub's spool. The adapter reads it during the send; the hub deletes it afterwards. */
export interface OutgoingAttachment {
  path: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
}

// ---------------------------------------------------------------- adapter -> hub

export type AdapterEvent =
  | { t: 'hello'; network: Network; version: string; capabilities: Capability[] }
  | {
      t: 'status';
      status: AccountStatus;
      /** null clears it. */
      attention?: Omit<Attention, 'since'> | null;
      /** The account's own identity, once known. */
      self?: IdentityFact;
      /** Live view endpoint for the hub to proxy (Discord sandbox VNC). */
      liveView?: { vncPort: number; width: number; height: number } | null;
    }
  | { t: 'identity'; identity: IdentityFact }
  | { t: 'space'; space: SpaceFact }
  | { t: 'conversation'; conversation: ConversationFact }
  | { t: 'leave'; kind: 'space' | 'conversation'; nativeId: string }
  /** Create or replace (edits re-send the whole message). live=false marks backfill: no notifications. */
  | { t: 'message'; message: MessageFact; live?: boolean }
  | { t: 'delete'; conversation: string; nativeId: string }
  | { t: 'reaction'; conversation: string; message: string; author: string; key: string; remove?: boolean; style?: ReactionStyle; colors?: string[]; emoji?: CustomEmojiFact }
  /** A moderator removed every reaction on a message, or every one with this key. */
  | { t: 'reactionsCleared'; conversation: string; message: string; key?: string }
  /** Read state as the network reports it. Counts override the hub's own tally when given. */
  | { t: 'read'; conversation: string; upToTs: number; unread?: number; mentions?: number }
  | { t: 'typing'; conversation: string; author: string }
  | { t: 'reply'; id: string; ok: true; result?: unknown }
  | { t: 'reply'; id: string; ok: false; error: string }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: unknown };

// ---------------------------------------------------------------- hub -> adapter

export type AdapterCommand =
  /** reply.result: { nativeId } of the sent message if known (the echo still arrives as a message fact). */
  | { t: 'send'; id: string; conversation: string; body: string; replyTo?: string; attachments?: OutgoingAttachment[] }
  /** Backfill older messages as message facts with live=false; reply.result: { count, done } */
  | { t: 'history'; id: string; conversation: string; beforeTs?: number; limit: number }
  | { t: 'markRead'; id: string; conversation: string; upTo: string }
  | { t: 'react'; id: string; conversation: string; message: string; key: string; remove?: boolean; style?: ReactionStyle; emoji?: CustomEmojiFact }
  /** reply.result: ReactionContext */
  | { t: 'reactionContext'; id: string; conversation: string; message?: string }
  /** Name the people behind a total: identity facts first, then reply.result: { authors: string[] } */
  | { t: 'reactors'; id: string; conversation: string; message: string; key: string; style?: ReactionStyle }
  | { t: 'edit'; id: string; conversation: string; message: string; body: string }
  | { t: 'redact'; id: string; conversation: string; message: string }
  /** reply.result: { mime: string, base64: string } */
  | { t: 'fetchMedia'; id: string; url: MediaUrl }
  /** Account-specific actions, e.g. 'relogin', 'startLink', 'resync'. */
  | { t: 'action'; id: string; action: string; args?: unknown }
  | { t: 'shutdown' };

export type AdapterCommandType = AdapterCommand['t'];
