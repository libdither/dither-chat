/**
 * The dither-chat ontology: one vocabulary for Discord, Signal and Matrix.
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

export type Network = 'discord' | 'signal' | 'matrix';
export const NETWORKS: readonly Network[] = ['discord', 'signal', 'matrix'];

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
  | 'link_device' //     Signal: scan the QR code with your phone
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
  detail?: unknown;
}

export type NotifyLevel =
  | 'all' //      push every message
  | 'mentions' // push mentions and replies to you; the rest goes to the digest
  | 'smart' //    push what the triage model scores as needing you; the rest goes to the digest
  | 'digest' //   never push; collect into the digest
  | 'none'; //    silent: no push, no digest, unread badge only

export type NotifyScope = 'global' | 'network' | 'account' | 'space' | 'conversation' | 'person' | 'keyword';

export type TriageDecision = 'push' | 'digest' | 'silent';

export type MessageKind = 'text' | 'media' | 'system' | 'sticker' | 'call' | 'encrypted';
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

/** Brand colours used to annotate the source of every object in the UI. */
export const NETWORK_META: Record<Network, { name: string; color: string; spaceNoun: string; sectionNoun: string }> = {
  discord: { name: 'Discord', color: '#5865F2', spaceNoun: 'server', sectionNoun: 'category' },
  signal: { name: 'Signal', color: '#3A76F0', spaceNoun: 'group', sectionNoun: 'section' },
  matrix: { name: 'Matrix', color: '#0DBD8B', spaceNoun: 'space', sectionNoun: 'subspace' },
};
