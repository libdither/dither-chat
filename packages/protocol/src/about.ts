/**
 * About and settings, one shape for every network (docs/group-settings.md).
 *
 * A conversation or space has an About: its settings, each with whether *this account* may change it and why not,
 * who is in it and with what role, who may do what there, its invite link and its pinned messages. The adapter
 * answers `about` with an About in native ids; the hub turns it into an AboutView. `configure` changes one setting
 * and answers with the About as it now stands.
 *
 * What a network has at all, and the choices its own client offers, is in ABOUT_RULES, the way REACTION_RULES says
 * how reactions work there. What is allowed in one place comes from the adapter, as ReactionContext does.
 */
import type { MediaUrl } from './adapter.ts';
import type { Network } from './ontology.ts';

/** Who may do something, as far as the networks agree. */
export type Who = 'everyone' | 'admins';

/**
 * How people get in. open: anyone who finds it or has the link. invite: only those invited. ask: they ask, a member
 * lets them in (Matrix knock). space: members of a containing space (Matrix restricted).
 */
export type JoinRule = 'open' | 'invite' | 'ask' | 'space';

/** Matrix: who can read the history. */
export type HistoryVisibility = 'world_readable' | 'shared' | 'invited' | 'joined';

/** Every setting, with the type of its value. A network has the ones its ABOUT_RULES lists. */
export interface AboutValues {
  name: string;
  /** Topic or description. */
  topic: string;
  avatar: MediaUrl;
  /** Messages disappear this many seconds after they are sent (Signal: after they are read). 0: off. */
  disappearing: number;
  /** Seconds a member waits between messages (Discord). 0: off. */
  slowMode: number;
  /** Age-restricted (Discord NSFW). */
  nsfw: boolean;
  /** Only admins can send. */
  announceOnly: boolean;
  /** Who can change the name, topic and picture. */
  editInfo: Who;
  /** Who can add people. */
  addMembers: Who;
  /** Someone with the invite link still needs an admin to let them in. */
  joinApproval: boolean;
  joinRule: JoinRule;
  history: HistoryVisibility;
  /** End-to-end encrypted. On Matrix it can be turned on, never off. */
  encrypted: boolean;
}

export type AboutKey = keyof AboutValues;

export const ABOUT_KEYS: readonly AboutKey[] = ['name', 'topic', 'avatar', 'disappearing', 'slowMode', 'nsfw', 'announceOnly', 'editInfo', 'addMembers', 'joinApproval', 'joinRule', 'history', 'encrypted'];

/** One setting: its value, and whether this account may change it. */
export interface AboutSetting<K extends AboutKey = AboutKey> {
  /** null: the network has it but did not say. */
  value: AboutValues[K] | null;
  canEdit: boolean;
  /** Why not, in words (shown on hover and under the setting). Also a limit worth knowing when canEdit is true. */
  reason?: string;
}

export type AboutFields = { [K in AboutKey]?: AboutSetting<K> };

export interface AboutMember {
  /** Native identity id. The adapter emits identity facts for members first. */
  id: string;
  /** What the network calls their standing: "Admin", "Owner", "Moderator", the top Discord role. */
  role?: string;
  /** Power, to sort by: 100 for admins and owners, 50 for moderators, 0 for members. Matrix: the power level. */
  rank?: number;
  /** CSS colour of their role (Discord). */
  color?: string;
}

export interface AboutRole {
  id: string;
  name: string;
  color?: string;
  rank: number;
  /** Members with it, when known. */
  count?: number;
}

/** "Who can do what", in words: one row per thing the network gates. */
export interface AboutRule {
  what: string;
  who: string;
  /** This account may. */
  you: boolean;
}

export interface AboutInvite {
  /** The link, when there is one and this account may see it. */
  link: string | null;
  /** Make one, or a new one in place of the old (which stops working). */
  canCreate: boolean;
  /** Turn the link off. */
  canRevoke?: boolean;
  reason?: string;
  /** A Matrix address (alias) or room id, which works as a link without anyone making one. */
  derived?: boolean;
}

export interface AboutPinned {
  /** Native message ids, newest pin first. */
  messages: string[];
  canEdit: boolean;
  reason?: string;
}

/** What `about` answers, in native ids. */
export interface About {
  /** The network's word for it: "Group", "Server", "Room", "Channel", "Community". */
  noun?: string;
  fields: AboutFields;
  members?: {
    list: AboutMember[];
    /** How many there are; list may hold fewer (Discord servers load members lazily). */
    total?: number;
    complete: boolean;
  };
  roles?: AboutRole[];
  rules?: AboutRule[];
  /** This account's own standing here. */
  you?: { role?: string; rank?: number };
  invite?: AboutInvite;
  pinned?: AboutPinned;
  /** Read-only details only some networks have: "Room version", "Verification level", "Created". */
  facts?: { label: string; value: string }[];
}

export interface AboutTarget {
  kind: 'conversation' | 'space';
  nativeId: string;
}

/** One change. `invite` makes, replaces or turns off the invite link; `pin` pins or unpins a message. */
export type AboutChange =
  | { [K in AboutKey]: { key: K; value: AboutValues[K] } }[AboutKey]
  | { key: 'invite'; op: 'create' | 'revoke' }
  | { key: 'pin'; message: string; remove?: boolean };

// ---------------------------------------------------------------- per network

export interface AboutRules {
  /** Settings this network has for conversations, in the order its own client shows them. */
  conversation: AboutKey[];
  /** And for spaces. */
  space: AboutKey[];
  /** The timers its own client offers, in seconds (0: off). */
  disappearing?: number[];
  /** Any timer works, not just the ones offered (Signal sets any number of seconds). */
  disappearingFree?: boolean;
  slowMode?: number[];
  nameMax?: number;
  topicMax?: number;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

export const ABOUT_RULES: Record<Network, AboutRules> = {
  discord: {
    conversation: ['name', 'topic', 'avatar', 'slowMode', 'nsfw', 'announceOnly'],
    space: ['name', 'topic', 'avatar', 'nsfw'],
    slowMode: [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, HOUR, 2 * HOUR, 6 * HOUR],
    nameMax: 100,
    topicMax: 1024,
  },
  signal: {
    conversation: ['name', 'topic', 'avatar', 'disappearing', 'announceOnly', 'editInfo', 'addMembers', 'joinApproval', 'encrypted'],
    space: [],
    disappearing: [0, 30, 5 * 60, HOUR, 8 * HOUR, DAY, 7 * DAY, 28 * DAY],
    disappearingFree: true,
    nameMax: 32,
    topicMax: 480,
  },
  matrix: {
    conversation: ['name', 'topic', 'avatar', 'announceOnly', 'joinRule', 'history', 'encrypted'],
    space: ['name', 'topic', 'avatar', 'joinRule'],
    nameMax: 255,
  },
  whatsapp: {
    conversation: ['name', 'topic', 'avatar', 'disappearing', 'announceOnly', 'editInfo', 'addMembers', 'joinApproval', 'encrypted'],
    space: ['name', 'topic', 'avatar', 'addMembers', 'joinApproval'],
    disappearing: [0, DAY, 7 * DAY, 90 * DAY],
    nameMax: 100,
    topicMax: 2048,
  },
  telegram: {
    conversation: ['name', 'topic', 'avatar', 'slowMode', 'joinApproval'],
    space: ['name', 'topic', 'avatar'],
    slowMode: [0, 10, 30, 60, 5 * 60, 15 * 60, HOUR],
    nameMax: 128,
    topicMax: 255,
  },
  gmessages: {
    conversation: ['name'],
    space: [],
    nameMax: 100,
  },
};

export const ABOUT_LABEL: Record<AboutKey, string> = {
  name: 'Name',
  topic: 'Description',
  avatar: 'Picture',
  disappearing: 'Disappearing messages',
  slowMode: 'Slow mode',
  nsfw: 'Age-restricted',
  announceOnly: 'Only admins can send',
  editInfo: 'Who can edit info',
  addMembers: 'Who can add members',
  joinApproval: 'Approve new members',
  joinRule: 'Who can join',
  history: 'Who can read history',
  encrypted: 'End-to-end encryption',
};

/** "5 minutes", "1 day", "Off". */
export function durationLabel(seconds: number | null | undefined): string {
  if (!seconds) return 'Off';
  const units: [number, string][] = [
    [7 * DAY, 'week'],
    [DAY, 'day'],
    [HOUR, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  for (const [n, name] of units) {
    if (seconds % n === 0) {
      const k = seconds / n;
      return `${k} ${name}${k === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}

export const WHO_LABEL: Record<Who, string> = { everyone: 'All members', admins: 'Only admins' };
export const JOIN_RULE_LABEL: Record<JoinRule, string> = { open: 'Anyone', invite: 'Only invited people', ask: 'Anyone can ask to join', space: 'Members of its space' };
export const HISTORY_LABEL: Record<HistoryVisibility, string> = {
  world_readable: 'Anyone, without joining',
  shared: 'Members, all of it',
  invited: 'Members, since they were invited',
  joined: 'Members, since they joined',
};

/**
 * Is this change well formed for this network? The hub refuses anything else before asking the adapter, and checks
 * canEdit against a fresh About. Returns the reason, or null.
 */
export function aboutChangeProblem(network: Network, kind: AboutTarget['kind'], change: AboutChange): string | null {
  const rules = ABOUT_RULES[network];
  if (change.key === 'invite') return change.op === 'create' || change.op === 'revoke' ? null : 'unknown invite operation';
  if (change.key === 'pin') return typeof change.message === 'string' && change.message ? null : 'which message?';
  if (!ABOUT_KEYS.includes(change.key)) return `unknown setting ${String(change.key)}`;
  if (!rules[kind].includes(change.key)) return `${ABOUT_LABEL[change.key]} is not a setting here`;
  const v = change.value as unknown;
  switch (change.key) {
    case 'name': {
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s) return 'a name cannot be empty';
      if (rules.nameMax && s.length > rules.nameMax) return `a name is at most ${rules.nameMax} characters here`;
      return null;
    }
    case 'topic':
      if (typeof v !== 'string') return 'a description is text';
      if (rules.topicMax && v.length > rules.topicMax) return `a description is at most ${rules.topicMax} characters here`;
      return null;
    case 'avatar':
      return 'changing the picture is not supported yet';
    case 'disappearing':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return 'a timer is a whole number of seconds';
      if (!rules.disappearingFree && !rules.disappearing?.includes(v)) return `${durationLabel(v)} is not one of the timers offered here`;
      return null;
    case 'slowMode':
      return typeof v === 'number' && rules.slowMode?.includes(v) ? null : 'not one of the slow mode choices';
    case 'editInfo':
    case 'addMembers':
      return v === 'everyone' || v === 'admins' ? null : 'everyone or admins';
    case 'joinRule':
      return v === 'open' || v === 'invite' || v === 'ask' || v === 'space' ? null : 'unknown join rule';
    case 'history':
      return v === 'world_readable' || v === 'shared' || v === 'invited' || v === 'joined' ? null : 'unknown history setting';
    case 'encrypted':
      return v === true ? null : 'encryption cannot be turned off';
    default:
      return typeof v === 'boolean' ? null : 'on or off';
  }
}

// ---------------------------------------------------------------- people

/**
 * What a network says about one person (the `profile` command, docs/profile.md), in native ids. Only what the
 * network's own client shows when you open someone's profile, asked only when you open theirs.
 */
export interface PersonAbout {
  /** As the network has them now. The adapter also emits an identity fact with these. */
  displayName?: string;
  handle?: string;
  avatar?: MediaUrl;
  /** A banner picture (Discord). */
  banner?: MediaUrl;
  /** A CSS colour for the banner when there is no picture (Discord's accent colour). */
  accent?: string;
  /** Bio or About text, as the network has it (Discord markdown, WhatsApp About, Signal About). */
  bio?: string;
  /** A short status line with an emoji (Discord custom status, Signal's About emoji). */
  status?: { text?: string; emoji?: string };
  pronouns?: string;
  /** ms epoch: when their account was made (Discord, from the id). */
  createdAt?: number;
  /** Your standing with them on this network. */
  relationship?: PersonRelationship;
  /** Spaces you share, native ids, with their name and roles there. All of them, not only where they posted. */
  mutualSpaces?: { id: string; nick?: string; roles?: { name: string; color?: string }[]; joinedAt?: number }[];
  /** Friends you share: native identity ids (identity facts for them are emitted first). */
  mutualFriends?: string[];
  /** When the person is you: your friends or contacts on this network, native identity ids. */
  friends?: string[];
  /** Connected accounts, websites, a phone number. */
  links?: { label: string; value: string; url?: string; verified?: boolean }[];
  /** Anything else worth a line: "Business account", "Local time". */
  facts?: { label: string; value: string }[];
}

/**
 * How long your own bio may be on each network that lets you change it (capability 'editProfile'), in characters
 * as bioLength counts them. Matrix has no bio.
 */
export const BIO_LIMIT: Partial<Record<Network, number>> = { discord: 190, signal: 140, whatsapp: 139 };

/** A bio's length the way the limits count it: one per character, so an emoji is one. */
export const bioLength = (s: string) => [...s].length;

/** friend: accepted; requested: you asked them; requesting: they asked you; contact: in your address book. */
export type PersonRelationship = 'friend' | 'requested' | 'requesting' | 'blocked' | 'contact' | 'stranger';

export const RELATIONSHIP_LABEL: Record<PersonRelationship, string> = {
  friend: 'Friend',
  requested: 'Friend request sent',
  requesting: 'Wants to be friends',
  blocked: 'Blocked',
  contact: 'In your contacts',
  stranger: 'Not a contact',
};
