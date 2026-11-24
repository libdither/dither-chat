/**
 * What the menus need of index jobs (docs/indexing.md) at once: whether a place can be indexed, and opening the dialog.
 * The dialog and Settings → Indexing are in ui/Indexing.tsx, a chunk of its own, loaded when the dialog opens.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { convLabel, convTitle, folderLeaves } from './model.ts';
import { db } from './state.ts';

/** What the index dialog is open for. */
export const indexing = signal<{ kind: P.JobTargetKind; id: string } | null>(null);

const able = (ids: Iterable<string>, capability: P.Capability) => [...ids].some((id) => {
  const a = db.accounts.get(id);
  return !!a && a.status !== 'disabled' && a.capabilities.includes(capability);
});

/** What a target is, as the dialog and the menus need it: its name, network, and what your accounts there can fetch. */
export function describe(kind: P.JobTargetKind, id: string): { name: string; noun: string; network: P.Network | null; history: boolean; members: boolean; communities: boolean } | null {
  if (kind === 'space') {
    const s = db.spaces.get(id);
    if (!s) return null;
    const community = s.kind === 'community';
    const noun = s.kind === 'section' ? NETWORK_META[s.network].sectionNoun : s.network === 'discord' ? 'server' : NETWORK_META[s.network].spaceNoun;
    return { name: s.name, noun, network: s.network, history: able(s.accountIds, 'history'), members: community && able(s.accountIds, 'walkMembers'), communities: community };
  }
  if (kind === 'conversation') {
    const c = db.conversations.get(id);
    if (!c) return null;
    const accounts = c.vantages.map((v) => v.accountId);
    const channel = c.shape === 'channel' || c.shape === 'thread';
    // The hub's own (docs/feed.md: notifications, logged posts, a post you follow) have no history on the network to read.
    const hubMade = c.variant === 'feed' || c.variant === 'posts' || c.variant === 'follow';
    return { name: c.shape === 'direct' ? convTitle(c) : convLabel(c), noun: channel ? 'channel' : 'chat', network: c.network, history: !hubMade && able(accounts, 'history'), members: false, communities: false };
  }
  const f = db.folders.find((x) => x.id === id);
  if (!f) return null;
  const spaces = folderLeaves(f).filter((i) => i.kind === 'space').map((i) => db.spaces.get(i.id)).filter((s): s is P.SpaceView => !!s);
  const convs = folderLeaves(f).filter((i) => i.kind === 'conversation').map((i) => db.conversations.get(i.id)).filter((c): c is P.ConversationView => !!c);
  const accounts = [...spaces.flatMap((s) => s.accountIds), ...convs.flatMap((c) => c.vantages.map((v) => v.accountId))];
  const communities = spaces.filter((s) => s.kind === 'community');
  const nets = new Set([...spaces.map((s) => s.network), ...convs.map((c) => c.network)]);
  return {
    name: f.name,
    noun: 'folder',
    network: nets.size === 1 ? [...nets][0] : null,
    history: able(accounts, 'history'),
    members: able(communities.flatMap((s) => s.accountIds), 'walkMembers'),
    communities: communities.length > 0,
  };
}

/** Whether any account of yours could fetch something of it: the menus offer indexing only then. */
export function canIndex(kind: P.JobTargetKind, id: string): boolean {
  const d = describe(kind, id);
  return !!d && (d.history || d.members);
}

/** Opens the index dialog for a target. */
export function startIndexing(kind: P.JobTargetKind, id: string) {
  indexing.value = { kind, id };
}
