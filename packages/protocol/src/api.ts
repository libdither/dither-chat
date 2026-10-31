/**
 * Hub <-> client (PWA) API: view models served by /api/* and pushed over /api/live.
 * Every id here is a hub id; native ids are included for display and deep links only.
 */

import type { Capability, NativeMute } from './adapter.ts';
import type {
  AccountStatus,
  AttachmentKind,
  Attention,
  MessageKind,
  Network,
  NotifyLevel,
  NotifyScope,
  ReactionStyle,
  Shape,
  SpaceKind,
  TriageDecision,
  Variant,
} from './ontology.ts';

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

export interface TriageView {
  decision: TriageDecision;
  score: number | null;
  reasons: string[];
  decidedBy: 'rules' | 'model';
  feedback: 'should_push' | 'should_not_push' | null;
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
  deleted: boolean;
  attachments: AttachmentView[];
  embeds: EmbedView[];
  reactions: ReactionView[];
  seenVia: string[];
  triage: TriageView | null;
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
}

export interface SearchHit {
  message: MessageView;
  /** The matching text, with matches between \u0001 and \u0002. Plain text otherwise, not HTML. */
  snippet: string;
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
}

/** A message with what surrounds it, for jumping to it. */
export interface MessageContext extends MessagePage {
  hasNewer: boolean;
}

/** One device that opted in to Web Push. The endpoint stays on the hub apart from this fingerprint. */
export interface PushDeviceView {
  id: string;
  label: string;
  /** Which relay carries it: Google, Apple, Mozilla, Microsoft. */
  relay: string;
  createdAt: number;
  lastOkAt: number | null;
  lastError: string | null;
}

export interface RuleView {
  id: string;
  scope: NotifyScope;
  target: string | null;
  level: NotifyLevel;
  createdAt: number;
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
  rules: RuleView[];
  reactionUsage: ReactionUsage[];
  now: number;
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
  | { t: 'notify'; messageId: string; conversationId: string; title: string; body: string; reasons: string[] }
  | { t: 'typing'; conversationId: string; identityId: string }
  | { t: 'folders'; folders: FolderView[] }
  | { t: 'placePrefs'; prefs: PlacePrefView[] }
  | { t: 'categories'; categories: CategoryView[]; placeCategories: PlaceCategoryView[] }
  | { t: 'rules'; rules: RuleView[] }
  | { t: 'resync' };
