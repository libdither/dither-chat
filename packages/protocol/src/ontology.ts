/**
 * The dither-chat ontology: one vocabulary for Discord, Signal, Matrix and WhatsApp.
 *
 * Three independent axes describe every conversation:
 *   - where it sits socially    -> Shape   (direct, group, channel, thread, self)
 *   - how the network presents it -> Variant (text, announcement, forum, voice, ...)
 *   - who can see it            -> Vantage (which of your accounts observe it)
 *
 * Containment is a graph, not a tree: a Matrix room can belong to several
 * spaces, so space membership is an edge list (SpaceEdge) rather than a
 * parent pointer. Discord guilds and categories simply produce one edge each.
 *
 * Network objects (identities, spaces, conversations, messages) are keyed by
 * (network, nativeId) and deduplicated across accounts. Hub-only objects
 * (persons, folders, notification rules, triage) are never written back.
 */

export type Network = 'discord' | 'signal' | 'matrix' | 'whatsapp' | 'telegram' | 'gmessages' | 'messenger' | 'instagram' | 'x';
/**
 * The networks this hub offers. telegram and gmessages (Google Messages: SMS and RCS) run only in dither-accounts.
 * messenger, instagram and x (X's direct messages) are in the type for dither-accounts' extractors being built, and join
 * this list once the hub runs them.
 */
export const NETWORKS: readonly Network[] = ['discord', 'signal', 'matrix', 'whatsapp', 'telegram', 'gmessages'];

/** Where a conversation sits in the social structure, independent of network. */
export type Shape =
  | 'direct' //  you and one other person: Discord DM, Signal 1:1, Matrix DM room
  | 'group' //   small, invite-defined, no parent community: Discord group DM, Signal group, Matrix room outside any space
  | 'channel' // lives inside a community: Discord guild channel, Matrix room in a space
  | 'thread' //  hangs off a parent conversation: Discord thread / forum post, Matrix m.thread
  | 'self'; //   notes to self: Signal Note to Self, Matrix room with only you

/** Network-flavoured presentation of a conversation. Purely cosmetic for routing. */
export type Variant = 'text' | 'announcement' | 'forum' | 'voice' | 'stage' | 'media' | 'rules';

/**
 * community: something you join and that has its own membership and moderation
 *            (Discord guild, Matrix space, including nested subspaces).
 * section:   a purely visual grouping inside a community (Discord category).
 */
export type SpaceKind = 'community' | 'section';

export type AccountStatus = 'connecting' | 'online' | 'attention' | 'offline' | 'error' | 'disabled';

/** Why an account needs a human. Drives the "Needs you" cards. */
export type AttentionKind =
  | 'login' //           not logged in; open the live view and log in
  | 'captcha' //         a captcha is on screen in the sandbox
  | 'verify' //          email / phone / "suspicious activity" challenge
  | 'link_device' //     Signal, WhatsApp: scan the QR code with your phone
  | 'selector_broken' // the client changed and a hook no longer resolves
  | 'rate_limited'
  | 'unknown';

export interface Attention {
  kind: AttentionKind;
  message: string;
  since: number;
  /** A live view of the sandboxed client is available (VNC through the hub). */
  liveView?: boolean;
  /** A URI to render as a QR code (Signal device linking). */
  qr?: string;
  /** When the adapter replaces `qr` with a fresh code (ms since epoch). */
  qrRefreshAt?: number;
  detail?: unknown;
}

export type NotifyLevel =
  | 'all' //      push every message
  | 'mentions' // push mentions and replies to you; the rest goes to the digest
  | 'smart' //    push what the triage model scores as needing you; the rest goes to the digest
  | 'digest' //   never push; collect into the digest
  | 'none'; //    silent: no push, no digest, unread badge only

export type NotifyScope = 'global' | 'network' | 'account' | 'space' | 'conversation' | 'person' | 'keyword';

/**
 * Where a message lands (docs/notifications.md): 'push' is Important (the phone buzzes, the desktop shows a
 * notification), 'quiet' is Active (a silent notification on the phone, none on the desktop), 'digest' waits for the
 * digest, 'silent' is nowhere but the unread badge.
 */
export type TriageDecision = 'push' | 'quiet' | 'digest' | 'drop' | 'silent';

/**
 * The levels you can vote a decision between: Important, Active, Digest, and below the digest ('drop': not
 * interesting enough for it; still unread in its chat).
 */
export type NotifyTier = 'push' | 'quiet' | 'digest' | 'drop';
export const TIER_LABEL: Record<NotifyTier, string> = { push: 'Important', quiet: 'Active', digest: 'Digest', drop: 'Not interesting' };

export type MessageKind = 'text' | 'media' | 'system' | 'sticker' | 'call' | 'encrypted';

/**
 * Reactions, one vocabulary for all networks (docs/reactions.md).
 *
 * A reaction is a key and a style. The key is a Unicode emoji in canonical form, free text where a
 * network allows it, or an opaque native id for a custom emoji (Discord "name:id", Matrix mxc://),
 * which is described by a catalog entry. The style is 'super' for Discord's burst reactions and
 * 'normal' for everything else; a person can do both on one key, so they count separately.
 */
export type ReactionStyle = 'normal' | 'super';

/** What a network allows anywhere. What is available in one place comes from ReactionContext. */
export interface ReactionRules {
  /** One reaction per person per message: a new one replaces the old. */
  exclusive: boolean;
  /** Any text works as a reaction, not just emoji. */
  freeText: boolean;
  /** Most distinct reactions a message can hold. */
  maxDistinct?: number;
}

export const REACTION_RULES: Record<Network, ReactionRules> = {
  discord: { exclusive: false, freeText: false, maxDistinct: 20 },
  signal: { exclusive: true, freeText: false },
  matrix: { exclusive: false, freeText: true },
  whatsapp: { exclusive: true, freeText: false },
  // One reaction each without Premium.
  telegram: { exclusive: true, freeText: false },
  // RCS reactions; SMS has none.
  gmessages: { exclusive: true, freeText: false },
  // One reaction each, any emoji.
  messenger: { exclusive: true, freeText: false },
  instagram: { exclusive: true, freeText: false },
  x: { exclusive: true, freeText: false },
};

export function discordEmojiUrl(id: string, animated?: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.webp?size=64${animated ? '&animated=true' : ''}`;
}

/**
 * The same emoji reaches us with and without variation selectors (Element adds U+FE0F to everything,
 * others send a bare heart that renders as text). Fully qualified form, so they count as one reaction.
 */
export function canonicalReactionKey(key: string): string {
  if (/^[\x00-\x7F]*$/.test(key)) return key; // "+1", "name:id", "mxc://..."
  const chars = [...key.replace(/\uFE0F/g, '')];
  return chars
    .map((c, i) => {
      const next = chars[i + 1] ?? '';
      const textByDefault = /^\p{Emoji}$/u.test(c) && !/^\p{Emoji_Presentation}$/u.test(c);
      if (!textByDefault || /^\p{Emoji_Modifier}$/u.test(next)) return c;
      return /^[0-9#*]$/.test(c) && next !== '\u20E3' ? c : c + '\uFE0F';
    })
    .join('');
}
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

export function attachmentKind(mime: string): AttachmentKind {
  const top = mime.split('/')[0];
  return top === 'image' || top === 'video' || top === 'audio' ? top : 'file';
}

/**
 * Whether the hub lets a browser show this type from its own origin: images other than SVG, video, audio, PDF and
 * plain text. Anything else (HTML, SVG, XML, scripts, a type it doesn't know) could run as a page there, so the hub
 * serves it as a download.
 */
export function showsInline(mime: string | null | undefined): boolean {
  const t = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (/xml|svg|html/.test(t)) return false;
  return /^(image|video|audio)\/[\w.+-]+$/.test(t) || t === 'application/pdf' || t === 'text/plain';
}

/**
 * The most the hub takes in one file, in bytes. Uploads go to disk, but adapters still read a file whole to send it
 * (Discord's as base64), so this stays where every network's limit below is.
 */
export const MAX_UPLOAD = 25 * 1024 * 1024;
/** The largest piece of an upload in one request: small enough that a dropped connection on a phone loses little. */
export const UPLOAD_CHUNK = 2 * 1024 * 1024;
/** What each network takes, as far as we can tell without asking. Discord's is the limit without Nitro. */
export const ATTACHMENT_LIMITS: Record<Network, { bytes: number; files: number }> = {
  discord: { bytes: 10 * 1024 * 1024, files: 10 },
  signal: { bytes: MAX_UPLOAD, files: 10 },
  matrix: { bytes: MAX_UPLOAD - 1024 * 1024, files: 10 },
  whatsapp: { bytes: MAX_UPLOAD, files: 10 },
  telegram: { bytes: MAX_UPLOAD, files: 10 },
  // RCS takes large files; a carrier's MMS fallback may not.
  gmessages: { bytes: MAX_UPLOAD, files: 10 },
  messenger: { bytes: MAX_UPLOAD, files: 10 },
  instagram: { bytes: MAX_UPLOAD, files: 10 },
  // A direct message carries one photo, GIF or video.
  x: { bytes: MAX_UPLOAD, files: 1 },
};

/** Brand colours used to annotate the source of every object in the UI. */
export const NETWORK_META: Record<Network, { name: string; color: string; spaceNoun: string; sectionNoun: string }> = {
  discord: { name: 'Discord', color: '#5865F2', spaceNoun: 'server', sectionNoun: 'category' },
  signal: { name: 'Signal', color: '#3A91F5', spaceNoun: 'group', sectionNoun: 'section' },
  matrix: { name: 'Matrix', color: '#0DBD8B', spaceNoun: 'space', sectionNoun: 'subspace' },
  whatsapp: { name: 'WhatsApp', color: '#1DAA61', spaceNoun: 'community', sectionNoun: 'section' },
  telegram: { name: 'Telegram', color: '#2AABEE', spaceNoun: 'group', sectionNoun: 'folder' },
  gmessages: { name: 'Google Messages', color: '#1A73E8', spaceNoun: 'group', sectionNoun: 'section' },
  messenger: { name: 'Messenger', color: '#0866FF', spaceNoun: 'group', sectionNoun: 'section' },
  instagram: { name: 'Instagram', color: '#FF0069', spaceNoun: 'group', sectionNoun: 'section' },
  x: { name: 'X', color: '#000000', spaceNoun: 'group', sectionNoun: 'section' },
};
