/**
 * Client-side view of the ontology: names, paths, trees and unread
 * aggregation derived from the hub's normalized data. Everything here is
 * memoized per data version (versions.ts), which moves at once rather than once a frame. Reading it subscribes
 * nothing: a component reads `rev` or `metaRev` itself.
 */
import type * as P from '@dither-chat/protocol';
import { categoryThreshold, NETWORK_META } from '@dither-chat/protocol';
import { dataVersion, db, inbox, isSelfIdentity, mailTriage, prefs } from './state.ts';
import { mailDataVersion } from './versions.ts';
import { isMailItem, triageBoard, type Board, type BoardItem } from './board.ts';
import { mailInboxRows, mailNames } from './mail/model.ts';

const memos = new Map<string, { rev: number; value: unknown }>();
function memo<T>(key: string, fn: () => T): T {
  const m = memos.get(key);
  const v = dataVersion();
  if (m && m.rev === v) return m.value as T;
  const value = fn();
  memos.set(key, { rev: v, value });
  return value;
}

export const netName = (n: P.Network) => NETWORK_META[n].name;
export const netColor = (n: P.Network) => NETWORK_META[n].color;

// ------------------------------------------------------------------ visibility

/** A hub is either a demo world or a real one (never both), so every account it knows is shown. */
export function visibleAccount(id: string) {
  return db.accounts.has(id);
}
export function visibleConv(c: P.ConversationView) {
  return c.vantages.some((v) => visibleAccount(v.accountId));
}
export function visibleSpace(s: P.SpaceView) {
  return s.accountIds.some(visibleAccount);
}

// ------------------------------------------------------------------ names

/** Replace raw <@id> / <#id> tokens in stored preview text with readable names. */
export function resolveTokens(text: string, network: P.Network): string {
  return text
    .replace(/<@&\d+>/g, '@role')
    .replace(/<@!?([^>\s]+)>/g, (_, id) => {
      const hid = db.identityByNative.get(`${network}:${id}`);
      return '@' + (hid ? (isSelfIdentity(hid) ? 'you' : authorName(hid)) : 'user');
    })
    .replace(/<#([^>\s]+)>/g, (_, id) => {
      const c = convByNative(network, id);
      return c ? '#' + convTitle(c) : '#channel';
    })
    .replace(/<a?:(\w+):\d+>/g, ':$1:');
}

/** A conversation by its network's own id, as room links name them: one map per `rev`, not a scan per link. */
export function convByNative(network: P.Network, nativeId: string): P.ConversationView | undefined {
  return memo('convByNative', () => {
    const m = new Map<string, P.ConversationView>();
    for (const c of db.conversations.values()) if (!m.has(`${c.network}:${c.nativeId}`)) m.set(`${c.network}:${c.nativeId}`, c);
    return m;
  }).get(`${network}:${nativeId}`);
}

/** A message body as one plain line, for quotes and previews. */
export function plainBody(body: string, network: P.Network): string {
  return plainMarkdown(resolveTokens(body, network).replace(/```[\s\S]*?```/g, '[code]').replace(/\|\|[\s\S]*?\|\|/g, '[spoiler]'));
}

/** Markdown's marks taken out of text that is shown as one plain line: quotes, headings, lists, emphasis, links. */
export function plainMarkdown(text: string): string {
  return text
    .replace(/```\w*/g, '')
    .replace(/^\s*(?:>|-#|#{1,3}|[-*])\s+/gm, '')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1')
    .replace(/\*\*|__|~~|\|\||[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function identityName(id: string | null | undefined): string {
  if (!id) return 'Unknown';
  const i = db.identities.get(id);
  if (!i) return 'Unknown';
  return i.displayName || i.handle || i.nativeId;
}

// "Mail with Sam": a `w:` list's heading names the person (mail/model.ts).
mailNames.of = (who) => db.persons.get(who)?.name ?? (db.identities.has(who) ? identityName(who) : null);

export function personOf(identityId: string | null | undefined): P.PersonView | null {
  if (!identityId) return null;
  const i = db.identities.get(identityId);
  return i?.personId ? (db.persons.get(i.personId) ?? null) : null;
}

/** Author label: the person's name when they are someone you know, else the network display name. */
export function authorName(identityId: string | null | undefined): string {
  if (isSelfIdentity(identityId)) return 'You';
  const p = personOf(identityId);
  return p && !p.isSelf ? p.name : identityName(identityId);
}

export function peerIdentity(c: P.ConversationView): string | null {
  return c.participantIds.find((p) => !isSelfIdentity(p)) ?? null;
}

export function convTitle(c: P.ConversationView | undefined | null): string {
  if (!c) return 'Unknown';
  if (c.shape === 'direct') {
    const p = c.peerPersonId ? db.persons.get(c.peerPersonId) : null;
    return p?.name ?? identityName(peerIdentity(c));
  }
  if (c.shape === 'self') return c.name ?? 'Notes to self';
  if (c.name) return c.name;
  if (c.shape === 'group')
    return (
      c.participantIds
        .filter((p) => !isSelfIdentity(p))
        .slice(0, 3)
        .map(identityName)
        .join(', ') || 'Group'
    );
  return 'Unnamed';
}

/** "#dev" for channels, plain names otherwise. */
export function convLabel(c: P.ConversationView): string {
  const t = convTitle(c);
  return c.shape === 'channel' && c.network === 'discord' && c.variant !== 'voice' && c.variant !== 'stage' ? `#${t}` : t;
}

export function kindLabel(c: P.ConversationView): string {
  const n = netName(c.network);
  const variant = { text: '', announcement: 'announcement ', forum: 'forum ', voice: 'voice ', stage: 'stage ', media: 'media ', rules: 'rules ' }[c.variant] ?? '';
  switch (c.shape) {
    case 'direct':
      return c.network === 'discord' || c.network === 'matrix' ? `${n} DM` : `${n} chat`;
    case 'group':
      return c.network === 'discord' ? 'Discord group DM' : c.network === 'matrix' ? 'Matrix room (private)' : `${n} group`;
    case 'self':
      return `${n} notes to self`;
    case 'thread': {
      const parent = c.parentId ? db.conversations.get(c.parentId) : null;
      return parent?.variant === 'forum' ? `${n} forum post` : `${n} thread`;
    }
    case 'channel':
      if (c.network === 'discord') return `Discord ${variant}channel`;
      if (c.network === 'matrix') return c.spaceIds.length ? `Matrix ${variant}room` : 'Matrix room (no space)';
      return `${n} ${variant}channel`;
  }
}

// ------------------------------------------------------------------ hierarchy

export function spaceParents(id: string): P.SpaceView[] {
  return (db.parents.get(id) ?? []).map((e) => db.spaces.get(e.parentId)).filter((s): s is P.SpaceView => !!s);
}

/** The community a space belongs to: itself if it is one, else its nearest community ancestor. */
export function communityOfSpace(id: string): P.SpaceView | null {
  let s = db.spaces.get(id) ?? null;
  const seen = new Set<string>();
  while (s && s.kind === 'section' && !seen.has(s.id)) {
    seen.add(s.id);
    s = spaceParents(s.id)[0] ?? null;
  }
  return s;
}

/** Walk to the top of the visible community graph (Matrix subspaces nest). */
export function rootCommunity(id: string): P.SpaceView | null {
  let s = communityOfSpace(id);
  const seen = new Set<string>();
  while (s && !seen.has(s.id)) {
    seen.add(s.id);
    const up = spaceParents(s.id).find((p) => p.kind === 'community');
    if (!up) break;
    s = up;
  }
  return s;
}

/** Threads inherit their parent's place. */
export function placeConv(c: P.ConversationView): P.ConversationView {
  return c.shape === 'thread' && c.parentId ? (db.conversations.get(c.parentId) ?? c) : c;
}

export function communitiesOf(c: P.ConversationView): P.SpaceView[] {
  const base = placeConv(c);
  const out: P.SpaceView[] = [];
  for (const sid of base.spaceIds) {
    const com = communityOfSpace(sid);
    if (com && !out.some((x) => x.id === com.id)) out.push(com);
  }
  return out;
}

export interface Crumb {
  label: string;
  kind: 'network' | 'space' | 'section' | 'conversation';
  id?: string;
}

/** Discord › libdither › Development › #dev › DHT bootstrap refactor */
export function crumbs(c: P.ConversationView, within?: string): Crumb[] {
  const out: Crumb[] = [{ label: netName(c.network), kind: 'network' }];
  const base = placeConv(c);
  const sid = (within && base.spaceIds.find((s) => communityOfSpace(s)?.id === within || s === within)) ?? base.spaceIds[0];
  if (sid) {
    const chain: P.SpaceView[] = [];
    let s: P.SpaceView | null = db.spaces.get(sid) ?? null;
    const seen = new Set<string>();
    while (s && !seen.has(s.id)) {
      seen.add(s.id);
      chain.unshift(s);
      s = spaceParents(s.id)[0] ?? null;
    }
    for (const sp of chain) out.push({ label: sp.name, kind: sp.kind === 'community' ? 'space' : 'section', id: sp.id });
  } else if (c.shape === 'direct' || c.shape === 'self') {
    out.push({ label: c.shape === 'self' ? 'Notes' : 'Direct messages', kind: 'section' });
  } else if (base.shape === 'group') {
    out.push({ label: 'Groups', kind: 'section' });
  }
  if (base !== c) out.push({ label: convLabel(base), kind: 'conversation', id: base.id });
  out.push({ label: convLabel(c), kind: 'conversation', id: c.id });
  return out;
}

export interface TreeNode {
  kind: 'section' | 'subspace' | 'conversation';
  id: string;
  position: string | null;
}

export function spaceChildren(id: string): TreeNode[] {
  return memo('children:' + id, () =>
    (db.children.get(id) ?? [])
      .map((e): TreeNode | null => {
        if (e.childKind === 'conversation') {
          const c = db.conversations.get(e.childId);
          return c && visibleConv(c) ? { kind: 'conversation', id: c.id, position: e.position } : null;
        }
        const s = db.spaces.get(e.childId);
        if (!s || !visibleSpace(s)) return null;
        return { kind: s.kind === 'section' ? 'section' : 'subspace', id: s.id, position: e.position };
      })
      .filter((x): x is TreeNode => !!x)
      .sort((a, b) => {
        // Uncategorized channels first (Discord), then by position, then name.
        const rank = (n: TreeNode) => (n.kind === 'conversation' ? 0 : 1);
        if (rank(a) !== rank(b) && db.spaces.get(id)?.network === 'discord') return rank(a) - rank(b);
        return (a.position ?? '~').localeCompare(b.position ?? '~') || nodeName(a).localeCompare(nodeName(b));
      }),
  );
}

function nodeName(n: TreeNode) {
  return n.kind === 'conversation' ? convTitle(db.conversations.get(n.id)) : (db.spaces.get(n.id)?.name ?? '');
}

export function threadsOf(convId: string): P.ConversationView[] {
  return (db.threads.get(convId) ?? [])
    .map((id) => db.conversations.get(id)!)
    .filter((t) => t && visibleConv(t))
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
}

const NO_PREF: Omit<P.PlacePrefView, 'kind' | 'id'> = { position: null, pinned: false, hidden: false, open: false, railed: false };
export function placePref(kind: P.PlaceKind, id: string) {
  return db.placePrefs.get(`${kind}:${id}`) ?? { kind, id, ...NO_PREF };
}

export type RailEntry = { key: string; kind: 'folder'; folder: P.FolderView } | { key: string; kind: 'space'; space: P.SpaceView } | { key: string; kind: 'conversation'; conv: P.ConversationView };

const placeActivity = (e: RailEntry) =>
  e.kind === 'folder' ? Math.max(0, ...folderConvs(e.folder).map((c) => c.lastMessageAt ?? 0)) : e.kind === 'space' ? activityOfSpace(e.space.id) : (e.conv.lastMessageAt ?? 0);

/**
 * Top-level sidebar entries in display order: pinned, then what you arranged, then the rest (folders, then by activity).
 * Communities are listed by default; a conversation only once you add it. Whatever sits in a folder lives there instead.
 */
export function railEntries(which: 'shown' | 'hidden' = 'shown'): RailEntry[] {
  return memo('rail:' + which, () => {
    const inFolder = new Set(db.folders.flatMap((f) => f.items.map((i) => `${i.kind}:${i.id}`)));
    const entries: RailEntry[] = [
      ...db.folders.map((folder): RailEntry => ({ key: `folder:${folder.id}`, kind: 'folder', folder })),
      ...allCommunities()
        .filter((s) => !inFolder.has(`space:${s.id}`))
        .map((space): RailEntry => ({ key: `space:${space.id}`, kind: 'space', space })),
      ...[...db.conversations.values()]
        .filter((c) => visibleConv(c) && !inFolder.has(`conversation:${c.id}`) && placePref('conversation', c.id).railed)
        .map((conv): RailEntry => ({ key: `conversation:${conv.id}`, kind: 'conversation', conv })),
    ];
    const pref = (e: RailEntry) => placePref(e.kind, e.key.slice(e.key.indexOf(':') + 1));
    return entries
      .filter((e) => pref(e).hidden === (which === 'hidden'))
      .sort((a, b) => {
        const pa = pref(a), pb = pref(b);
        if (pa.pinned !== pb.pinned) return pa.pinned ? -1 : 1;
        if ((pa.position === null) !== (pb.position === null)) return pa.position !== null ? -1 : 1;
        if (pa.position !== null && pb.position !== null) return pa.position - pb.position;
        if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
        return placeActivity(b) - placeActivity(a);
      });
  });
}

/** Communities that should get a rail icon. */
export function railCommunities(): P.SpaceView[] {
  return railEntries().flatMap((e) => (e.kind === 'space' ? [e.space] : []));
}

export function allCommunities(): P.SpaceView[] {
  return memo('allCommunities', () =>
    [...db.spaces.values()]
      .filter((s) => s.kind === 'community' && visibleSpace(s) && !spaceParents(s.id).some((p) => p.kind === 'community' && visibleSpace(p)))
      .sort((a, b) => activityOfSpace(b.id) - activityOfSpace(a.id)),
  );
}

/** Every conversation under a space, through sections, subspaces and threads. */
export function convsUnder(id: string): P.ConversationView[] {
  return memo('under:' + id, () => {
    const out = new Map<string, P.ConversationView>();
    const seen = new Set<string>();
    const walk = (sid: string) => {
      if (seen.has(sid)) return;
      seen.add(sid);
      for (const e of db.children.get(sid) ?? []) {
        if (e.childKind === 'space') walk(e.childId);
        else {
          const c = db.conversations.get(e.childId);
          if (c && visibleConv(c)) {
            out.set(c.id, c);
            for (const t of threadsOf(c.id)) out.set(t.id, t);
          }
        }
      }
    };
    walk(id);
    return [...out.values()];
  });
}

export function activityOfSpace(id: string): number {
  return memo('act:' + id, () => Math.max(0, ...convsUnder(id).map((c) => c.lastMessageAt ?? 0)));
}

// ------------------------------------------------------------------ categories

/** Your choice, else the score against the category's threshold (`at` overrides it while a slider moves). */
export const memberOf = (x: P.PlaceCategoryView, at?: Record<string, number>) =>
  x.override ?? (x.p ?? 0) >= (at?.[x.categoryId] ?? categoryThreshold(db.categories.find((c) => c.id === x.categoryId), x.provider));

export function categoriesOf(kind: 'space' | 'conversation', id: string, at?: Record<string, number>): P.CategoryView[] {
  const mine = db.placeCategories.get(`${kind}:${id}`) ?? [];
  return db.categories.filter((c) => mine.some((x) => x.categoryId === c.id && memberOf(x, at)));
}

// ------------------------------------------------------------------ notification level (mirrors hub triage.ts)

/** What the networks do where nothing is set: DMs and group chats notify on every message, channels on mentions. */
const NATIVE_DEFAULT: Record<P.Shape, 'all' | 'mentions' | 'none'> = { direct: 'all', group: 'all', channel: 'mentions', thread: 'mentions', self: 'none' };
const rank = (l: P.NotifyLevel) => ({ none: 0, digest: 1, mentions: 2, smart: 3, all: 4 })[l];

export interface Effective {
  level: P.NotifyLevel;
  source: string;
  explicit: boolean;
  scope: P.NotifyScope | 'default' | 'native';
}

export function effectiveLevel(c: P.ConversationView): Effective {
  return memo('lvl:' + c.id, () => {
    const rules = memo('rules', () => new Map(db.rules.map((r) => [`${r.scope}:${r.target ?? ''}`, r.level])));
    const hit = (scope: string, target: string | null) => rules.get(`${scope}:${target ?? ''}`);
    let l: P.NotifyLevel | undefined;
    if ((l = hit('conversation', c.id))) return { level: l, source: 'this conversation', explicit: true, scope: 'conversation' };
    const parent = c.shape === 'thread' && c.parentId ? db.conversations.get(c.parentId) : undefined;
    if (parent && (l = hit('conversation', parent.id))) return { level: l, source: convLabel(parent), explicit: true, scope: 'conversation' };
    // Breadth-first over containing spaces.
    const seen = new Set<string>();
    let frontier = [...(parent ?? c).spaceIds];
    while (frontier.length) {
      const next: string[] = [];
      for (const sid of frontier) {
        if (seen.has(sid)) continue;
        seen.add(sid);
        const s = db.spaces.get(sid);
        if (s && (l = hit('space', sid))) return { level: l, source: s.kind === 'section' ? s.name : `${s.name} (${NETWORK_META[s.network].spaceNoun})`, explicit: true, scope: 'space' };
        next.push(...(db.parents.get(sid) ?? []).map((e) => e.parentId));
      }
      frontier = next;
    }
    let base: Effective | null = null;
    for (const v of c.vantages) {
      if ((l = hit('account', v.accountId))) {
        base = { level: l, source: `account ${db.accounts.get(v.accountId)?.label}`, explicit: false, scope: 'account' };
        break;
      }
    }
    if (!base && (l = hit('network', c.network))) base = { level: l, source: `all of ${netName(c.network)}`, explicit: false, scope: 'network' };
    if (!base && (l = hit('global', null))) base = { level: l, source: 'global default', explicit: false, scope: 'global' };
    // Nothing set: as the network has it (hub triage.ts nativeLevel), muted held for the digest.
    if (!base) {
      const n = nativeLevel(c, parent);
      return { level: n === 'none' ? 'digest' : n, source: `as in ${netName(c.network)}`, explicit: false, scope: 'default' };
    }
    const mute = nativeMuteLevel(c, parent);
    if (mute && rank(base.level) > rank(mute)) return { level: mute, source: `muted in ${netName(c.network)}`, explicit: false, scope: 'native' };
    return base;
  });
}

/** What the network itself does here: the most specific setting that has not run out, nearest first. */
function nativeLevel(c: P.ConversationView, parent?: P.ConversationView): 'all' | 'mentions' | 'none' {
  const now = Date.now();
  const at = (m: P.NativeMute | null | undefined) => (!m || (m.until !== undefined && m.until <= now) ? null : m.until !== undefined ? 'none' : (m.level ?? null));
  for (const m of [c.nativeMute, parent?.nativeMute]) {
    const lv = at(m);
    if (lv) return lv;
  }
  const seen = new Set<string>();
  let frontier = [...(parent ?? c).spaceIds];
  while (frontier.length) {
    const next: string[] = [];
    for (const sid of frontier) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const lv = at(db.spaces.get(sid)?.nativeMute);
      if (lv) return lv;
      next.push(...(db.parents.get(sid) ?? []).map((e) => e.parentId));
    }
    frontier = next;
  }
  return NATIVE_DEFAULT[c.shape];
}

function nativeMuteLevel(c: P.ConversationView, parent?: P.ConversationView): P.NotifyLevel | null {
  const now = Date.now();
  const mutes: (P.NativeMute | null)[] = [c.nativeMute, parent?.nativeMute ?? null, ...(parent ?? c).spaceIds.map((s) => db.spaces.get(s)?.nativeMute ?? null)];
  let best: P.NotifyLevel | null = null;
  for (const m of mutes) {
    if (!m) continue;
    const lv: P.NotifyLevel | null = m.level === 'none' || (m.until && m.until > now) ? 'digest' : m.level === 'mentions' ? 'mentions' : null;
    if (lv && (!best || rank(lv) < rank(best))) best = lv;
  }
  return best;
}

/** A place's notification setting. 'digest' is "Digest only": nothing there notifies; not to be confused with the Digest level of one message. */
export const LEVEL_LABEL: Record<P.NotifyLevel, string> = { all: 'All messages', smart: 'Smart', mentions: 'Mentions', digest: 'Digest only', none: 'Off' };

// ------------------------------------------------------------------ unread

export interface Unread {
  unread: number;
  mentions: number;
  /** Shown as a red count: mentions, or any message in a DM/group you listen to. */
  badge: number;
  muted: boolean;
}

export function unreadOf(c: P.ConversationView): Unread {
  const vs = c.vantages.filter((v) => visibleAccount(v.accountId));
  const unread = Math.max(0, ...vs.map((v) => v.unread));
  const mentions = Math.max(0, ...vs.map((v) => v.mentions));
  const lvl = effectiveLevel(c).level;
  const muted = lvl === 'none' || lvl === 'digest';
  const loud = (c.shape === 'direct' || c.shape === 'group') && !muted;
  return { unread, mentions, badge: loud ? unread : muted && lvl === 'none' ? 0 : mentions, muted };
}

export function sumUnread(convs: P.ConversationView[]): Unread {
  let unread = 0,
    mentions = 0,
    badge = 0;
  for (const c of convs) {
    // Nothing unread adds nothing, whatever its level: most conversations, and the level is the dear part.
    if (!c.vantages.some((v) => v.unread || v.mentions)) continue;
    const u = unreadOf(c);
    if (u.muted && !u.badge) continue;
    unread += u.unread;
    mentions += u.mentions;
    badge += u.badge;
  }
  return { unread, mentions, badge, muted: false };
}

/**
 * Everything shown, summed: the app's badge and the Home tab's. Once per `rev`. Not an open message request's: that
 * waits under Requests, on no badge (docs/add.md).
 */
export function totalUnread(): Unread {
  return memo('totalUnread', () => {
    const held = heldByRequest();
    return sumUnread([...db.conversations.values()].filter((c) => visibleConv(c) && !held.has(c.id)));
  });
}

export function spaceUnread(id: string): Unread {
  return memo('su:' + id, () => sumUnread(convsUnder(id)));
}

export function folderConvs(f: P.FolderView): P.ConversationView[] {
  return memo('fc:' + f.id, () => {
    const out = new Map<string, P.ConversationView>();
    for (const it of f.items) {
      if (it.kind === 'space') for (const c of convsUnder(it.id)) out.set(c.id, c);
      else if (it.kind === 'conversation') {
        const c = db.conversations.get(it.id);
        if (c && visibleConv(c)) out.set(c.id, c);
      } else for (const c of directsOf(it.id)) out.set(c.id, c);
    }
    return [...out.values()];
  });
}

// ------------------------------------------------------------------ people, groups

/** One pass over the conversations, not one per person: `people()` asks for every person on each `rev`. */
function directsByPerson(): Map<string, P.ConversationView[]> {
  return memo('directsByPerson', () => {
    const m = new Map<string, P.ConversationView[]>();
    for (const c of db.conversations.values()) {
      if (c.shape !== 'direct' || !c.peerPersonId || !visibleConv(c)) continue;
      const l = m.get(c.peerPersonId);
      if (l) l.push(c);
      else m.set(c.peerPersonId, [c]);
    }
    for (const l of m.values()) l.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
    return m;
  });
}

const none: P.ConversationView[] = [];
export function directsOf(personId: string): P.ConversationView[] {
  return directsByPerson().get(personId) ?? none;
}

export function people(): { person: P.PersonView; directs: P.ConversationView[]; last: number }[] {
  // An open message request waits under Requests, not among the people you talk with.
  const held = heldByRequest();
  return memo('people', () =>
    [...db.persons.values()]
      .filter((p) => !p.isSelf)
      .map((person) => {
        const directs = held.size ? directsOf(person.id).filter((d) => !held.has(d.id)) : directsOf(person.id);
        return { person, directs, last: Math.max(0, ...directs.map((d) => d.lastMessageAt ?? 0)) };
      })
      .filter((x) => x.directs.length)
      .sort((a, b) => Number(b.person.starred) - Number(a.person.starred) || b.last - a.last),
  );
}

export function accountsOf(network: P.Network): P.AccountView[] {
  return [...db.accounts.values()].filter((a) => a.network === network && visibleAccount(a.id));
}

/** Account annotations only appear when you have more than one account on that network. */
export function annotateAccounts(network: P.Network): boolean {
  return accountsOf(network).length > 1;
}

// ------------------------------------------------------------------ inbox

/** What the hub says about how much a row of the inbox needs you (docs/inbox.md). */
interface InboxScore {
  /** The conversation's id, or the mail thread's. */
  key: string;
  score: number;
  /** It needs you: an answer, something to read, a conversation going on. Shows the ↩ of a turn you owe. */
  needs: boolean;
  reasons: string[];
  owedSince: number | null;
}
/** One row of the inbox: a conversation, or a thread of mail from a person (docs/mail.md, slice 8). */
export type InboxRow = ConvInboxRow | MailInboxRow;
export interface ConvInboxRow extends InboxScore {
  kind: 'conv';
  conv: P.ConversationView;
}
export interface MailInboxRow extends InboxScore {
  kind: 'mail';
  thread: P.MailThreadView;
}

/** The latest message of a row, anyone's. */
export const rowLast = (r: InboxRow) => (r.kind === 'conv' ? (r.conv.lastMessageAt ?? 0) : r.thread.lastAt);
/** Something in it you have not read. */
export const rowUnread = (r: InboxRow) => (r.kind === 'conv' ? unreadOf(r.conv).unread > 0 : r.thread.unread > 0);
/** One other person: a DM, or a mail thread between you and one other. */
export const rowDirect = (r: InboxRow) => (r.kind === 'conv' ? r.conv.shape === 'direct' : r.thread.participants <= 2);
/** Muted here or on its network: below everything else. Notes to self notify nobody, which is not the same. */
export const rowMuted = (r: InboxRow) => (r.kind === 'conv' ? r.conv.shape !== 'self' && unreadOf(r.conv).muted : r.thread.muted);

/** DMs, group chats, notes to self and rooms outside a space are always in the inbox; anything else only while the hub lists it. */
export const inboxShape = (c: P.ConversationView) => c.shape === 'direct' || c.shape === 'group' || c.shape === 'self' || (c.shape === 'channel' && !c.spaceIds.length);

/**
 * Before the hub has scored a conversation (a fresh one, or a hub that predates scores): unread first, then the
 * latest, much as the inbox used to be.
 */
function unscored(c: P.ConversationView): ConvInboxRow {
  const u = unreadOf(c);
  const needs = !u.muted && u.badge > 0;
  const age = Math.max(0, Date.now() - (c.lastMessageAt ?? 0));
  return { kind: 'conv', key: c.id, conv: c, score: (needs ? 30 : 0) + 10 * 2 ** (-age / 86_400_000) - (u.muted ? 50 : 0), needs, reasons: [], owedSince: null };
}

/** The conversations' rows. */
/** Conversations an open message request is about: they wait under Requests, not in the inbox (docs/add.md). */
export function heldByRequest(): Set<string> {
  const out = new Set<string>();
  for (const r of db.requests) if (r.kind === 'message' && r.target?.kind === 'conversation' && r.target.id) out.add(r.target.id);
  return out;
}

function convRows(): ConvInboxRow[] {
  return memo('inboxConvRows', () => {
    const out: ConvInboxRow[] = [];
    const held = heldByRequest();
    for (const c of db.conversations.values()) {
      const a = db.attention.get(c.id);
      if ((!a && !inboxShape(c)) || !visibleConv(c) || held.has(c.id)) continue;
      const row: ConvInboxRow = a ? { kind: 'conv', key: c.id, conv: c, score: a.score, needs: a.needs, reasons: a.reasons, owedSince: a.owedSince } : unscored(c);
      if (!row.needs && c.shape !== 'self' && placePref('conversation', c.id).hidden) continue;
      out.push(row);
    }
    return out;
  });
}

/** Mail threads the hub lists in the inbox (`AttentionView.kind` 'mail'), with the thread the page holds. */
const mailRows = (): MailInboxRow[] => mailInboxRows(db.attention.values(), db.mail).map((r) => ({ kind: 'mail', ...r }));

let mailMemo: { data: number; mail: number; rows: InboxRow[]; waiting: boolean } | null = null;
/** Every inbox row, in no particular order: arrange it with inbox.ts. A hidden group only shows while it needs you. */
export function inboxRows(): InboxRow[] {
  const convs = convRows();
  if (!db.mail.accounts.size) return convs;
  // Mail moves on its own version (versions.ts): the rows are made again when either moved.
  const data = dataVersion();
  const mail = mailDataVersion();
  if (mailMemo?.data !== data || mailMemo.mail !== mail) {
    const rows = mailRows();
    let scored = 0;
    for (const a of db.attention.values()) if (a.kind === 'mail') scored++;
    mailMemo = { data, mail, rows: [...convs, ...rows], waiting: scored > rows.length };
  }
  return mailMemo.rows;
}

/**
 * The hub listed a mail thread the page does not hold yet: its view comes with a mail event, which the inbox then
 * waits for. Otherwise mail events leave the list alone (each mail row follows its own thread).
 */
export function mailRowsWaiting(): boolean {
  inboxRows();
  return !!db.mail.accounts.size && !!mailMemo?.waiting;
}

/** Accounts that need you to act (a QR to scan, a login): the rows above the conversations. */
export function accountsNeedingYou(): P.AccountView[] {
  return memo('accountsNeedingYou', () => [...db.accounts.values()].filter((a) => a.attention && visibleAccount(a.id)));
}

/** A triaged message you have not read: its conversation has unread messages, and you last read it before this one. */
export function messageUnread(m: P.MessageView): boolean {
  const c = db.conversations.get(m.conversationId);
  return !!c && c.vantages.some((v) => (v.lastReadTs ?? 0) < m.ts) && unreadOf(c).unread > 0;
}

/** A mail message on the board you have not read: as its thread says, if held, else as the hub said. */
function mailUnread(m: P.MailTriageItem): boolean {
  const t = db.mail.threads.get(m.threadId);
  return t ? t.unread > 0 && m.unread : m.unread;
}

/** A board card you have not read, chat or mail. */
export const boardUnread = (m: BoardItem) => (isMailItem(m) ? mailUnread(m) : messageUnread(m));

/** The Triage board's lists and counts (board.ts), for what is shown here: chat's messages and mail's. */
export function board(): Board {
  return memo('board', () =>
    triageBoard<BoardItem>([...inbox.value, ...mailTriage.value], {
      now: Date.now(),
      shown: (m) => {
        if (isMailItem(m)) return db.mail.accounts.has(m.accountId);
        const c = db.conversations.get(m.conversationId);
        return !!c && visibleConv(c);
      },
      unread: boardUnread,
    }),
  );
}

/** Important messages on the Triage board you have not read yet, by where they are now (your vote counts): the inbox button's count. */
export function pingedCount(): number {
  return board().importantUnread;
}

export function deepLink(c: P.ConversationView): string | null {
  const base = placeConv(c);
  if (c.network === 'discord') {
    const guild = communitiesOf(c)[0];
    return `https://discord.com/channels/${guild?.nativeId ?? '@me'}/${c.nativeId}`;
  }
  if (c.network === 'matrix') return `https://matrix.to/#/${encodeURIComponent(base.nativeId.split('|')[0])}`;
  return null;
}
