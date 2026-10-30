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
  reactions: { key: string; identityIds: string[] }[];
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
  rules: RuleView[];
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
  | { t: 'rules'; rules: RuleView[] }
  | { t: 'resync' };
