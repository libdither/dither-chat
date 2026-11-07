/**
 * Hub <-> client (PWA) API: view models served by /api/* and pushed over /api/live.
 * Every id here is a hub id; native ids are included for display and deep links only.
 */

import type { About, AboutFields, PersonAbout } from './about.ts';
import type { Capability, NativeMute, ReceiptState } from './adapter.ts';
import type {
  AccountStatus,
  AttachmentKind,
  Attention,
  MessageKind,
  Network,
  NotifyLevel,
  NotifyTier,
  NotifyScope,
  ReactionStyle,
  Shape,
  SpaceKind,
  TriageDecision,
  Variant,
} from './ontology.ts';
import type { ArrangeSettings, UsageKind, UsageView } from './usage.ts';

export interface AccountView {
  id: string;
  network: Network;
  label: string;
  color: string;
  status: AccountStatus;
  attention: Attention | null;
  selfIdentityId: string | null;
  capabilities: Capability[];
  liveView: boolean;
  demo: boolean;
  createdAt: number;
  /** Set when dither-accounts runs it rather than this hub (docs/accounts.md). Absent from older hubs. */
  managedBy?: AccountManaged;
}

/** How an account that dither-accounts runs came to be there, and where its page is. */
export interface AccountManaged {
  /** The account on the manager's page, when the hub knows the page's address (DITHER_ACCOUNTS_PUBLIC_URL). */
  url: string | null;
  /**
   * Who made it: this hub, another app, the manager's page, or an import of a session this hub kept (`import`: its
   * session is in the hub's data, so deleting it there would not delete it). Null until the manager has said.
   */
  origin: 'self' | 'app' | 'page' | 'import' | null;
}

export interface IdentityView {
  id: string;
  network: Network;
  nativeId: string;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  isBot: boolean;
  personId: string | null;
  /** Their custom status or About as last heard (docs/history.md). */
  status?: { text?: string; emoji?: string; at: number };
}

export interface PersonView {
  id: string;
  name: string;
  avatar: string | null;
  starred: boolean;
  isSelf: boolean;
  identityIds: string[];
}

/** One of your accounts observing a space or conversation, with its read state. */
export interface VantageView {
  accountId: string;
  unread: number;
  mentions: number;
  lastReadTs: number | null;
}

export interface SpaceView {
  id: string;
  network: Network;
  nativeId: string;
  kind: SpaceKind;
  name: string;
  topic: string | null;
  icon: string | null;
  accountIds: string[];
  nativeMute: NativeMute | null;
}

export interface SpaceEdgeView {
  parentId: string;
  childKind: 'space' | 'conversation';
  childId: string;
  position: string | null;
}

export interface MessagePreview {
  id: string;
  authorId: string | null;
  ts: number;
  kind: MessageKind;
  text: string;
}

export interface ConversationView {
  id: string;
  network: Network;
  nativeId: string;
  shape: Shape;
  variant: Variant;
  name: string | null;
  topic: string | null;
  avatar: string | null;
  encrypted: boolean;
  archived: boolean;
  parentId: string | null;
  /** Spaces that directly contain this conversation (usually one; Matrix can give several). */
  spaceIds: string[];
  participantIds: string[];
  /** direct: the person on the other end. */
  peerPersonId: string | null;
  vantages: VantageView[];
  lastMessage: MessagePreview | null;
  lastMessageAt: number | null;
  nativeMute: NativeMute | null;
}

export interface AttachmentView {
  id: string;
  kind: AttachmentKind;
  mime: string | null;
  name: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  url: string;
}

/** A file uploaded to the hub and waiting to be sent. */
export interface UploadView {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * The answer to `POST /api/conversations/:id/send`. `messageId` is the hub's id for the sent message when the network
 * said which it is: the app replaces its pending copy with that message (packages/web/src/outbox.ts).
 */
export interface SendResult {
  ok: true;
  accountId: string;
  result?: unknown;
  messageId?: string;
}

export interface TriageView {
  decision: TriageDecision;
  /** How much it matters, 0 to 1: the mean of the three chances below. The digest is sorted by it. */
  score: number | null;
  reasons: string[];
  /** 'learned': what your votes taught moved it from where the network's own settings put it (docs/notifications.md). */
  decidedBy: 'rules' | 'model' | 'learned';
  /** The level you voted it to, if you did. */
  feedback: NotifyTier | null;
  /** The model's three chances: worth a ping, worth a silent notification, worth the digest. */
  probs?: TriageProbs | null;
}

/** What the decision model predicts for a message (docs/notifications.md). */
export interface TriageProbs {
  ping: number;
  active: number;
  interesting: number;
}
export type TriageHead = keyof TriageProbs;

/** Something the model learned from your votes: a feature, in words, and how far it moves one of the three chances. */
export interface LearnedFactorView {
  /** The feature, stable: for forgetting it. */
  key: string;
  text: string;
  head: TriageHead;
  /** In log-odds: +1 roughly doubles the odds again over. */
  weight: number;
  /** Votes it was part of. */
  votes: number;
}

/** What triage has learned from your votes, and how well it fits them. */
export interface TriagePolicyView {
  factors: LearnedFactorView[];
  /** Features you told it to forget: never learned again. */
  rejected: { key: string; text: string }[];
  votes: number;
  /** Votes the model gets wrong, and that the networks' own settings alone would. */
  errors: number;
  baseline: number;
  /** A message pings at `ping` or more, is Active at `active`, goes in the digest at `interesting`. */
  thresholds: TriageProbs;
  learnedAt: number | null;
  /** Why it last learned. */
  lastReason: string | null;
  /** The local model's prompt, written from what was learned; shown whether or not a model is set. */
  prompt: string | null;
  model: string | null;
}

/**
 * What the candidate model, run in shadow next to the live one, would have done over the last `days`
 * (GET /api/triage/shadow, docs/notifications.md). Counts of decisions, never which.
 */
export interface TriageShadowView {
  days: number;
  /** The oldest decision with a shadow, or null with none yet. */
  since: number | null;
  /** Decisions with a shadow. */
  decided: number;
  /** Pings and silent notifications: as decided, and as the shadow would have. */
  live: { ping: number; active: number };
  shadow: { ping: number; active: number };
  /** Messages you answered within 15 minutes that both pinged; that only the live model pinged (the shadow would have missed them); that only the shadow would have. */
  answered: { both: number; missed: number; gained: number };
  /** Decisions exploration changed (DITHER_TRIAGE_EXPLORE): tried as Active, or held from Important to Active. */
  explored: { up: number; down: number };
}

/** A link preview or bot card attached to a message. */
export interface EmbedView {
  title?: string;
  description?: string;
  url?: string;
  provider?: string;
  author?: string;
  image?: string;
  fields?: { name: string; value: string }[];
}

export interface CustomEmojiView {
  key: string;
  name: string;
  url: string;
  animated: boolean;
}

export interface ReactionView {
  key: string;
  style: ReactionStyle;
  /** The total. Can exceed identityIds: Discord reports totals without naming everyone. */
  count: number;
  identityIds: string[];
  emoji?: CustomEmojiView;
  colors?: string[];
}

/**
 * A conversation's or space's About as the web app gets it (about.ts, docs/group-settings.md): the adapter's answer
 * in hub ids, from the account that asked. When no account could ask, the last answer the hub kept, with `stale`.
 */
export interface AboutView extends Omit<About, 'members' | 'pinned' | 'fields'> {
  target: { kind: 'conversation' | 'space'; id: string };
  network: Network;
  /** The account whose view this is. null: none could ask, and nothing was kept. */
  accountId: string | null;
  fetchedAt: number;
  /** Why this is not fresh: the account is offline, or its adapter cannot read settings. */
  stale?: string;
  /** Some settings can be changed through this account. */
  canConfigure: boolean;
  fields: AboutFields;
  members?: {
    list: { identityId: string; role?: string; rank?: number; color?: string }[];
    total?: number;
    complete: boolean;
  };
  /** The members' identities, since strangers in a big place are not in the bootstrap. */
  identities: IdentityView[];
  /** A space's members your accounts have seen, with the adversarial `members` setting on. */
  coverage?: MemberCoverageView;
  pinned?: {
    /** Pinned messages the hub has, newest pin first. */
    messages: MessageView[];
    /** Pinned messages the hub has not stored. */
    missing: number;
    canEdit: boolean;
    reason?: string;
  };
}

/**
 * How much of a space's member list the hub has seen (passively: only what your accounts' clients loaded anyway).
 * Never everyone: Discord lists a big server's online members at most, and the client loads only what is in view.
 */
export interface MemberCoverageView {
  /** Members seen, ever, by any of your accounts. */
  seen: number;
  /** The network's member count and online count, as last reported. */
  total?: number;
  online?: number;
  /** seen / total, at most 1, when total is known. */
  fraction?: number;
  /** ms epoch: when someone here was last seen, and when the network last gave its counts. */
  lastSeenAt?: number;
  reportedAt?: number;
}

/** What one of your accounts can react with in a conversation. */
export interface ReactionContextView {
  accountId: string | null;
  canReact: boolean;
  reason?: string;
  existingOnly?: boolean;
  custom: { id: string; name: string; icon: string | null; emoji: CustomEmojiView[] }[];
  super?: { available: boolean; reason?: string };
}

/** How often you have reacted with something: the quick row and "frequently used". */
export interface ReactionUsage {
  key: string;
  network: Network;
  count: number;
  emoji?: CustomEmojiView;
}

export interface MessageView {
  id: string;
  conversationId: string;
  network: Network;
  nativeId: string;
  authorId: string | null;
  ts: number;
  editedTs: number | null;
  kind: MessageKind;
  body: string;
  replyToId: string | null;
  threadId: string | null;
  mentionsSelf: boolean;
  /**
   * Gone on the network. When the hub kept it (docs/history.md) `body` and the attachments are still here, and
   * `gone` says how: deleted, or its disappearing timer ran out; else the body is empty.
   */
  deleted: boolean;
  gone?: { how: 'deleted' | 'disappeared'; at: number; kept: boolean };
  /** Earlier versions the hub kept: GET /api/messages/:id/history. */
  edits?: number;
  /** Other things that happened to it the hub kept: reactions taken back, pins (docs/history.md). */
  events?: number;
  /** Pinned, as the last pin or unpin the hub saw says. */
  pinned?: boolean;
  /** Your own messages: how many people it reached, read and played, and the latest of those. */
  receipts?: { delivered: number; read: number; played: number; latest: { identityId: string; state: ReceiptState; at: number } };
  /** Something is wrong with this message's encryption, e.g. it came in the clear in an encrypted room. */
  encryptionWarning?: string;
  attachments: AttachmentView[];
  embeds: EmbedView[];
  reactions: ReactionView[];
  seenVia: string[];
  triage: TriageView | null;
  /** This message forwards another: body and attachments are what was forwarded. */
  forward?: ForwardView;
}

/** A forward, shown as a card with where it came from. */
export interface ForwardView {
  /** The original, when this hub has it. */
  messageId: string | null;
  conversationId: string | null;
  authorId: string | null;
  /** Who wrote the original, in words, when no identity is known. */
  authorName: string | null;
  network: Network | null;
  /** Where the original was: "#general · Some server". */
  source: string | null;
  ts: number | null;
  /** The forwarded text, when the message's own body also carries a note and a line saying where it came from. */
  text?: string;
  /** What was written with it, when the network carried both as one message (a forward this hub sent across networks). */
  note?: string;
  /** How it went out, for forwards this hub sent: the network's own forward, the content again, or into another network. */
  sentAs?: ForwardMode;
}

export type ForwardMode = 'native' | 'resend' | 'cross';

/** POST /api/messages/:id/forward */
export interface ForwardRequest {
  targets: { conversationId: string; accountId?: string }[];
  note?: string;
}

export interface ForwardResult {
  conversationId: string;
  ok: boolean;
  mode?: ForwardMode;
  accountId?: string;
  error?: string;
  /** Attachments that could not go along (too large for the destination, or gone). */
  skipped?: string[];
}

export interface FolderView {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  items: { kind: 'space' | 'conversation' | 'person'; id: string }[];
}

/** Where a place sits in your sidebar. Hub-only: networks never see it. */
export type PlaceKind = 'folder' | 'space' | 'conversation';
export interface PlacePrefView {
  kind: PlaceKind;
  id: string;
  /** Manual order; null follows activity. */
  position: number | null;
  pinned: boolean;
  /** Out of the sidebar and lists. Notifications are a separate setting and do not change. */
  hidden: boolean;
  /** Folders: shown expanded in the sidebar. */
  open: boolean;
  /** Conversations: has its own sidebar entry, as communities do by default. */
  railed: boolean;
}
export type PlacePrefPatch = { kind: PlaceKind; id: string } & Partial<Omit<PlacePrefView, 'kind' | 'id'>>;

/** A category is a yes/no question asked of each place (hub categorize.ts). */
export interface CategoryView {
  id: string;
  name: string;
  question: string;
  /** Used when no model is running. Empty means words from the name and question. */
  keywords: string[];
  color: string | null;
  /** A place belongs when P(yes) is at least this; null is the provider's default (categoryThreshold). */
  threshold?: number | null;
}

/**
 * Where a category starts matching when you have not moved its slider. Keyword scores are coarse (0.8 for a name hit);
 * the reranker's P(yes) is uncalibrated and low (a Rust server scores about 0.5 for "programming"), so it starts lower.
 */
export const categoryThreshold = (c: Pick<CategoryView, 'threshold'> | undefined, provider: string | null | undefined): number =>
  c?.threshold ?? (provider?.startsWith('jev') ? 0.12 : 0.5);

/** Every place's P(yes) for a question asked once (POST /api/categories/probe), not saved. */
export interface CategoryProbe {
  provider: string;
  question: string;
  scores: { kind: 'space' | 'conversation'; id: string; p: number }[];
}

export interface PlaceCategoryView {
  categoryId: string;
  kind: 'space' | 'conversation';
  id: string;
  /** P(yes) from the provider; null if you decided before any score existed. */
  p: number | null;
  provider: string | null;
  /** Your decision, which always beats the score. */
  override: boolean | null;
}

export interface PlaceStats {
  /** Conversation id -> messages stored in the last 7 days. */
  week: Record<string, number>;
  /** Conversation id -> when you last posted. */
  mine: Record<string, number>;
}

/** Everything the hub has stored about someone. It only knows what crossed your accounts. */
/** What one network says about one of a person's identities (docs/profile.md): PersonAbout in hub ids. */
export interface PersonAboutView extends Omit<PersonAbout, 'avatar' | 'banner' | 'mutualSpaces' | 'mutualFriends' | 'friends'> {
  identityId: string;
  network: Network;
  /** The account that asked. */
  accountId: string | null;
  fetchedAt: number;
  /** Why this is not fresh: no account could ask, it is offline, or the network refused. */
  stale?: string;
  avatar?: string | null;
  banner?: string | null;
  /** Spaces you share; `spaceId` null for one the hub does not have. */
  mutualSpaces?: { spaceId: string | null; nativeId: string; nick?: string; roles?: { name: string; color?: string }[]; joinedAt?: number }[];
  mutualFriends?: string[];
  friends?: string[];
  /** Everyone those name, for rendering. */
  identities: IdentityView[];
}

export interface ProfileView {
  personId: string | null;
  note: string | null;
  identityIds: string[];
  identities: IdentityView[];
  /** Places they have posted in or are listed as a member of, most recent first. */
  conversations: { id: string; messages: number; lastTs: number | null }[];
  recent: MessageView[];
  /** Everyone else named in those messages. */
  mentioned: IdentityView[];
  totalMessages: number;
  firstSeenTs: number | null;
  /** What each network said last, kept by the hub; ask `GET /api/identities/:id/about` for a fresh one. */
  abouts: PersonAboutView[];
  /**
   * Spaces your accounts' clients have seen them as a member of, last seen first. Only with the adversarial `members`
   * setting on; not every space they are in.
   */
  memberOf?: { spaceId: string; nick?: string; roles?: string[]; joinedAt?: number; lastSeenAt: number }[];
}

/** POST /api/directs: a direct conversation, opened or found. */
export interface OpenedDirect {
  conversation: ConversationView | null;
  existed: boolean;
  /** Nothing exists on the network until the first message (Signal). */
  startsAtFirstSend: boolean;
}

export interface SearchHit {
  message: MessageView;
  /** The matching text, with matches between \u0001 and \u0002. Plain text otherwise, not HTML. */
  snippet: string;
  /** With &context=n: the messages just before and after it in its conversation, oldest first. */
  before?: MessageView[];
  after?: MessageView[];
}

export interface SearchPage {
  hits: SearchHit[];
  /** Identities for rendering, including people matched by name. */
  identities: IdentityView[];
  /** Identity ids whose name matches, for people the client may not hold. */
  people: string[];
  /** Pass as &cursor= for the next page; null at the end. */
  next: string | null;
  mode: 'fulltext' | 'substring' | 'filters';
  /** Nothing matched as typed, so these hits are for this query instead, a misspelt word corrected. Page with it. */
  corrected?: string;
}

/** A message with what surrounds it, for jumping to it. */
export interface MessageContext extends MessagePage {
  hasNewer: boolean;
}

/** One device that opted in to Web Push. The endpoint stays on the hub apart from this fingerprint. */
export interface PushDeviceView {
  id: string;
  label: string;
  /** Which relay carries it: Google, Apple, Mozilla, Microsoft, or a UnifiedPush server's host name. */
  relay: string;
  /** The UnifiedPush server's origin (ntfy), or null for a browser vendor's relay. */
  server: string | null;
  createdAt: number;
  /** The push server last took a push for it. */
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastTestAt: number | null;
  /** The device itself said a test push arrived (its service worker, or the Android app). */
  lastArrivedAt: number | null;
}

/** A UnifiedPush server the hub may send to, besides the browser vendors' relays (which are always allowed). */
export interface PushServerView {
  origin: string;
  /** default: allowed until turned off (ntfy.sh); environment: DITHER_PUSH_RELAYS; approved: allowed from the app. */
  source: 'default' | 'environment' | 'approved';
  /** Allowed although it is on a private address, such as a tailnet ntfy. */
  private: boolean;
  addedAt: number | null;
  /** A default the owner turned off. */
  off: boolean;
  devices: number;
}

/** Devices that tried to register through a server the hub does not send to yet, waiting for the owner to allow it. */
export interface PushPendingView {
  origin: string;
  labels: string[];
  at: number;
  /** Plain http: only allowed by typing it out. */
  http: boolean;
}

/** The older plain-text ntfy topic, DITHER_NTFY_URL. */
export interface PushTopicView {
  server: string;
  lastOkAt: number | null;
  lastError: string | null;
}

/** GET /api/push */
export interface PushInfo {
  publicKey: string;
  devices: PushDeviceView[];
  servers: PushServerView[];
  pending: PushPendingView[];
  topic: PushTopicView | null;
}

/** A daily window with no pushes. Times are in `timezone`, the zone of the device that set them. */
export interface QuietHours {
  enabled: boolean;
  start: string; // "22:00"
  end: string; //   "07:00"; earlier than start means it ends the next morning
  timezone: string;
  /** Weekdays the window starts on, 0 = Sunday. Empty or missing: every day. */
  days?: number[];
  /** Starred people, and people set to always notify, still get through. */
  allowStarred: boolean;
}

/** One notification a day about what the inbox's digest gathered. The time is in `timezone`, the zone of the device that set it. */
export interface DailyDigest {
  enabled: boolean;
  time: string; // "18:00"
  timezone: string;
}

export interface RuleView {
  id: string;
  scope: NotifyScope;
  target: string | null;
  level: NotifyLevel;
  createdAt: number;
}

/**
 * Where a device wants notifications, on top of the rules every device shares (docs/devices.md). Only lowers:
 * `hub` follows the shared rules, `mentions` keeps only mentions and replies to you, `none` shows nothing here.
 */
export type DeviceLevel = 'hub' | 'mentions' | 'none';
export type DeviceScope = 'network' | 'account' | 'space' | 'conversation';

export interface DeviceRuleView {
  scope: DeviceScope;
  target: string;
  level: DeviceLevel;
}

/** A device that has said hello, or a push registration no open page has claimed yet. */
export interface DeviceView {
  id: string;
  label: string;
  lastSeenAt: number | null;
  /** Its push registrations (PushDeviceView ids). */
  pushIds: string[];
  rules: DeviceRuleView[];
}

export interface Bootstrap {
  selfPersonId: string | null;
  accounts: AccountView[];
  persons: PersonView[];
  identities: IdentityView[];
  spaces: SpaceView[];
  edges: SpaceEdgeView[];
  conversations: ConversationView[];
  folders: FolderView[];
  placePrefs: PlacePrefView[];
  categories: CategoryView[];
  placeCategories: PlaceCategoryView[];
  categoryProvider: string;
  /** Set when this hub's chat accounts run in dither-accounts. Absent from older hubs and hubs that run their own. */
  accountsManager?: { url: string | null };
  rules: RuleView[];
  /** Absent from hubs that predate per-device rules. */
  devices?: DeviceView[];
  reactionUsage: ReactionUsage[];
  /** The inbox's ranking (docs/inbox.md). Absent from hubs that predate it. */
  attention?: AttentionView[];
  now: number;
  /** Where in the hub's change journal this bootstrap stands, so the next reconnect asks only for what changed since (docs/sync.md). */
  sync?: SyncPosition;
}

/**
 * How much a conversation needs you, from its metadata only (docs/inbox.md). The hub sends one for every
 * conversation the inbox lists: direct, group, notes to self, rooms outside a space, and anything else while it
 * has an unread mention or pinged you.
 */
export interface AttentionView {
  id: string;
  /** The inbox's order: higher first. Roughly 0..100; muted places sit below 0. */
  score: number;
  /** It needs you: something to answer or read, or a conversation going on. Not where you were. */
  needs: boolean;
  /** Why, most important first, as sentences. */
  reasons: string[];
  /** The first message addressed to you that you have not answered, if any. */
  owedSince: number | null;
  /** When the hub computed it. */
  at: number;
}

export interface MessagePage {
  messages: MessageView[];
  identities: IdentityView[];
  hasMore: boolean;
}

export interface InboxItem {
  message: MessageView;
  conversationId: string;
}

export interface InboxPage {
  items: InboxItem[];
  identities: IdentityView[];
}

export type ClientEvent =
  | { t: 'account'; account: AccountView }
  | { t: 'account.removed'; id: string }
  | { t: 'identity'; identity: IdentityView }
  | { t: 'person'; person: PersonView }
  | { t: 'person.removed'; id: string }
  | { t: 'space'; space: SpaceView; edges: SpaceEdgeView[] }
  | { t: 'space.removed'; id: string }
  | { t: 'conversation'; conversation: ConversationView }
  | { t: 'conversation.removed'; id: string }
  | { t: 'message'; message: MessageView; identities: IdentityView[]; live: boolean }
  | { t: 'message.deleted'; id: string; conversationId: string }
  /** No conversation: it is about the inbox as a whole (the daily digest). */
  | { t: 'notify'; messageId?: string; conversationId?: string; title: string; body: string; reasons: string[]; /** Important or Active; absent is Important. */ level?: 'push' | 'quiet'; /** The notification's id in the activity log (docs/activity.md). */ nid?: string; /** Devices whose own rules keep this quiet (docs/devices.md). */ quiet?: string[]; /** The sender's (or the place's) picture, a hub media path. */ icon?: string; network?: Network }
  /**
   * Someone started typing (it lasts `ttl` ms unless another start comes) or `stop`ped. Of the moment: not journaled,
   * and a client that reconnects simply does not see it. `name` only when the hub knows no name for the identity.
   */
  | { t: 'typing'; conversationId: string; identityId: string; ttl?: number; stop?: true; name?: string }
  | { t: 'folders'; folders: FolderView[] }
  | { t: 'placePrefs'; prefs: PlacePrefView[] }
  | { t: 'categories'; categories: CategoryView[]; placeCategories: PlaceCategoryView[] }
  | { t: 'rules'; rules: RuleView[] }
  | { t: 'devices'; devices: DeviceView[] }
  /** What the hub keeps of deleted, disappeared and edited messages changed (docs/history.md). */
  | { t: 'retention'; retention: RetentionSettings }
  /** New or changed inbox scores, and conversations the inbox no longer lists. `replace`: these are all of them. */
  | { t: 'attention'; items: AttentionView[]; removed: string[]; replace?: true }
  /** Mark-all-read still telling the networks: how many reads are left, how many were given up on. */
  | { t: 'readProgress'; pending: number; failed: number }
  /** Time spent in places changed (usage.ts, docs/organize.md). `replace`: these are all of them. */
  | { t: 'usage'; places: UsageView[]; removed: { kind: UsageKind; id: string }[]; replace?: true }
  | { t: 'arrange'; arrange: ArrangeSettings }
  /** Ends a frame whose changes went into the journal: a client holding everything up to here can resume from `seq`. */
  | { t: 'sync'; seq: number }
  | { t: 'resync' };

// ------------------------------------------------------------------ delta sync (docs/sync.md)

/** Bumped when a journal from an older hub cannot be read the same way: a client from another version starts over. */
export const SYNC_VERSION = 1;

/** A place in the hub's change journal. `epoch` changes when the journal starts over, which makes every older position void. */
export interface SyncPosition {
  v: number;
  epoch: string;
  seq: number;
}

export interface SyncTimelineRequest {
  /** `c:<conversation>` or `p:<person>`, as the client keys its timelines. */
  key: string;
  /** The journal position this copy of the timeline is current to. */
  seq: number;
  /** The newest and oldest message held. */
  newest: number;
  oldest: number;
  /** False for a window around an old message: only changes inside it, nothing newer. */
  newer?: boolean;
  /** A person timeline: the conversations it merged. Another set now (people merged or split) means a fresh page. */
  conversationIds?: string[];
}

export interface SyncRequest {
  v: number;
  epoch: string;
  /** Everything but messages, changed after this. Absent: only the timelines. */
  since?: number;
  timelines?: SyncTimelineRequest[];
}

export interface SyncTimeline {
  key: string;
  /** New messages after `newest`, and changed ones (edited, deleted, reacted to) inside the held range. */
  messages: MessageView[];
  /** The held copy is past saving (too many new messages, or older than the journal): `messages` is the newest page instead. */
  replace: boolean;
  /** With `replace`: whether there are older messages than the page. */
  hasMore?: boolean;
  conversationIds?: string[];
}

export type SyncResponse =
  | { full: true; reason: string }
  | {
      full?: false;
      sync: SyncPosition;
      /** Changes since the hub process started; a new one may have brought a new web build. */
      boot: string;
      /** The same events the live socket sends, current as of `sync.seq`. Empty when only timelines were asked for. */
      events: ClientEvent[];
      selfPersonId?: string | null;
      categoryProvider?: string;
      /** As in the bootstrap; null: this hub runs its own accounts. */
      accountsManager?: { url: string | null } | null;
      reactionUsage?: ReactionUsage[];
      /** Messages the inbox lists that arrived or changed since. */
      inbox?: MessageView[];
      timelines: SyncTimeline[];
      /** Authors, reactors and mentions in the messages above. */
      identities: IdentityView[];
      /** Messages replies above quote, when not among them. */
      quoted: MessageView[];
    };

// ------------------------------------------------------------------ history (docs/history.md)

/** What the hub keeps of what the networks take back, per source: deleted, disappeared, and edited messages. */
export interface KeepSettings {
  deleted: boolean;
  disappearing: boolean;
  edits: boolean;
  /** Reactions taken back: who took back what. */
  reactions: boolean;
  /** Who got, read and played your messages, and when. */
  receipts: boolean;
}

export interface RetentionSettings extends KeepSettings {
  /** Names, descriptions, pictures, settings, members, roles, pins, and people's profiles, as they change. */
  changes: boolean;
  /** People's statuses over time (an adversarial feature). */
  statuses: boolean;
  /** People's presence (online, idle, do not disturb, offline) over time, as it changes. Adversarial. */
  presence: boolean;
  /** Who is in which server, from what the network's client loads anyway (passive). Adversarial. */
  members: boolean;
  /**
   * Adversarial features shown, after the warning (docs/history.md): keeping what others deleted or set to disappear,
   * logging statuses and presence, and recording server members. Until then the hub does none of them, whatever their switches say.
   */
  adversarial: boolean;
  /** Kept deleted and disappeared messages: a collapsed row in the timeline, or not shown at all. */
  show: 'collapsed' | 'hidden';
  /** Overrides by network ("signal") or account id, the account's first. */
  sources: Record<string, Partial<KeepSettings>>;
}

export const DEFAULT_RETENTION: RetentionSettings = {
  deleted: false,
  disappearing: false,
  edits: true,
  reactions: true,
  receipts: true,
  changes: true,
  statuses: false,
  presence: false,
  members: false,
  adversarial: false,
  show: 'collapsed',
  sources: {},
};

/** Someone's presence, as a presence change's `old` and `new` (ChangeView, field "presence"). */
export interface PresenceView {
  state: 'online' | 'idle' | 'dnd' | 'offline';
  /** Where they are on, when the network says. */
  devices?: ('desktop' | 'mobile' | 'web')[];
}

/** The kinds kept only with adversarial features shown. */
export const ADVERSARIAL_KEEPS = ['deleted', 'disappearing'] as const satisfies readonly (keyof KeepSettings)[];

/**
 * One thing that changed about a place or a person. `old` and `new` are the values themselves: text for names and
 * descriptions, a media path for pictures, a setting's own type (seconds, true or false, "admins"), `{ text, emoji }`
 * for a status, `{ state, devices }` for presence, an identity id for a member, `{ identityId, role, color }` for a role. null: nothing.
 */
export interface ChangeView {
  id: number;
  target: { kind: 'conversation' | 'space' | 'identity'; id: string };
  /** name, topic, avatar, displayName, handle, bio, status, presence, pronouns, banner, a setting key, member, role. */
  field: string;
  old: unknown;
  new: unknown;
  at: number;
  /** Who made the change, where the network says. */
  actorId?: string;
  /** For member and role changes: whose. */
  identityId?: string;
}

/** Something that happened to one message, besides its text changing. */
export interface MessageEventView {
  kind: 'edit' | 'unreact' | 'pin' | 'unpin';
  /** edit: the text it had before; unreact: { key, style }. */
  data: unknown;
  actorId?: string;
  at: number;
}

/** GET /api/messages/:id/history */
export interface MessageHistoryView {
  /** Every version, oldest first, the last as it reads now. */
  versions: { body: string; at: number | null }[];
  events: MessageEventView[];
  /** Your message: who got it, read it, played it, and when. */
  receipts: { identityId: string; state: ReceiptState; at: number }[];
  identities: IdentityView[];
}
