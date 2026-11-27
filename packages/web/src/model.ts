/**
 * Client-side view of the ontology: names, paths, trees and unread
 * aggregation derived from the hub's normalized data. Everything here is
 * memoized per data version (versions.ts), which moves at once rather than once a frame. Reading it subscribes
 * nothing: a component reads `rev` or `metaRev` itself.
 */
import type * as P from '@dither-chat/protocol';
import { categoryThreshold, mutedNow, NETWORK_META, POST_NETWORKS, RULE_LABEL } from '@dither-chat/protocol';
import { dataVersion, db, inbox, isSelfIdentity, mailTriage } from './state.ts';
import { convsChangedSince, mailDataVersion, metaDataVersion, placesDataVersion } from './versions.ts';
import { isMailItem, triageBoard, type Board, type BoardItem } from './board.ts';
import { mailInboxRows, mailNames, scopeAccounts } from './mail/model.ts';
import { routesByPerson } from './mail/chats.ts';
import { accountName, chatKey, groupChats } from './chatroutes.ts';
import { channelKey, groupChannels } from './channelrows.ts';
import { isQuietConv } from './feed.ts';

/**
 * The memos below are kept by what is worked out (`kind`, a literal) and then by the place it is for (`id`, '' for one of
 * a kind), two maps: a key made of the two (`'lvl:' + id`) was a new string to build and hash in each of the tens of
 * thousands of lookups of a first draw (docs/perf.md "Memo keys").
 */
function entries<E>(all: Map<string, Map<string, E>>, kind: string): Map<string, E> {
  let m = all.get(kind);
  if (!m) all.set(kind, (m = new Map()));
  return m;
}

const memos = new Map<string, Map<string, { rev: number; value: unknown }>>();
function memo<T>(kind: string, id: string, fn: () => T): T {
  const byId = entries(memos, kind);
  const m = byId.get(id);
  const v = dataVersion();
  if (m && m.rev === v) return m.value as T;
  const value = fn();
  byId.set(id, { rev: v, value });
  return value;
}

const placesMemos = new Map<string, Map<string, { rev: number; value: unknown; at: number }>>();
/**
 * The same, for what reads no identity and not the inbox's messages (versions.ts `placesDataVersion`): the rail's
 * places, their counts and order, the badge, people's directs and the inbox's rows. Identities that come with a page or
 * the inbox, and the inbox itself, do not work these out again.
 *
 * When all that changed since were some conversations' last messages and counts (a message, a read: versions.ts
 * `convsChangedSince`), `update` brings the value up to date from those alone, or says it cannot (undefined): a
 * server's count is kept when none of them is under it, where every server's was worked out again from all ~5,600
 * conversations (docs/perf.md "One conversation at a time"). With none changed (reactions' usage), the value holds.
 * It must give what `fn` would; test/model-incremental.test.ts checks that it does.
 */
function placesMemo<T>(kind: string, id: string, fn: () => T, update?: (prev: T, ids: ReadonlySet<string>) => T | undefined): T {
  const byId = entries(placesMemos, kind);
  const m = byId.get(id);
  const v = placesDataVersion();
  if (m && m.rev === v) return m.value as T;
  const now = Date.now();
  if (m) {
    const ids = convsChangedSince(m.rev);
    if (ids && levelsHeld(m.at, now)) {
      const value = ids.size ? update?.(m.value as T, ids) : (m.value as T);
      if (value !== undefined) {
        m.rev = v;
        m.value = value;
        m.at = now;
        return value;
      }
    }
  }
  const value = fn();
  byId.set(id, { rev: v, value, at: now });
  return value;
}

/** Whether any of these conversations is in `set`. */
function touches(ids: ReadonlySet<string>, set: ReadonlySet<string>): boolean {
  for (const id of ids) if (set.has(id)) return true;
  return false;
}
/** An update that keeps the value unless one of the conversations it was worked out from changed. */
const keepUnless = (set: () => ReadonlySet<string>) => <T>(prev: T, ids: ReadonlySet<string>) => (touches(ids, set()) ? undefined : prev);
/** An update for what no conversation's last message or counts change. */
const keep = <T>(prev: T) => prev;

const metaMemos = new Map<string, Map<string, { rev: number; value: unknown; until: number }>>();
/** The soonest a native mute looked at while working something out runs out (nativeLevel): no later than that is it kept. */
let expires = Infinity;
/**
 * The same, for what depends only on names, settings and what is where (versions.ts `metaDataVersion`): a message
 * arriving or a conversation read does not work it out again, where it did for every conversation under every server
 * the rail shows (docs/perf.md). It holds conversations' ids, never the objects, which a message replaces.
 */
function metaMemo<T>(kind: string, id: string, fn: () => T): T {
  const byId = entries(metaMemos, kind);
  const m = byId.get(id);
  const v = metaDataVersion();
  if (m && m.rev === v && (m.until === Infinity || Date.now() < m.until)) return m.value as T;
  const outer = expires;
  expires = Infinity;
  const value = fn();
  byId.set(id, { rev: v, value, until: expires });
  if (expires !== Infinity) {
    if (untilsOf !== v) (untilsOf = v), (untils.length = 0);
    untils.push(expires);
  }
  expires = Math.min(outer, expires);
  return value;
}

/** When a native mute looked at since names and settings last changed runs out (`metaDataVersion` `untilsOf`). */
const untils: number[] = [];
let untilsOf = -1;
/**
 * Whether every notification level read at `at` still holds at `now`: no native mute ran out between. One that did
 * changes a level with nothing changed in `db`, so what `placesMemo` keeps from then is worked out again whole.
 */
function levelsHeld(at: number, now: number): boolean {
  if (untilsOf !== metaDataVersion()) return true;
  for (const u of untils) if (u > at && u <= now) return false;
  return true;
}

export const netName = (n: P.Network) => NETWORK_META[n].name;

/** Someone's page on their network's own site, where it has one: for copying, since the browser is rarely signed in there. */
export function externalProfile(i: P.IdentityView): string | null {
  if (i.network === 'discord') return /^\d+$/.test(i.nativeId) ? `https://discord.com/users/${i.nativeId}` : null;
  if (i.network === 'matrix') return `https://matrix.to/#/${encodeURIComponent(i.nativeId)}`;
  if (i.network === 'whatsapp') return /^\+\d{6,}$/.test(i.handle ?? '') ? `https://wa.me/${i.handle!.slice(1)}` : null;
  // Event sites (docs/events.md): Luma's user page by handle or id, Partiful's by id.
  if (i.network === 'luma') return `https://luma.com/user/${encodeURIComponent(i.handle || i.nativeId)}`;
  if (i.network === 'partiful') return `https://partiful.com/u/${encodeURIComponent(i.nativeId)}`;
  if (i.network === 'zulip') {
    const m = i.nativeId.match(/^([^/]+)\/u\/(\d+)$/);
    return m ? `${zulipBase(m[1]!)}/#user/${m[2]}` : null;
  }
  return null;
}

// ------------------------------------------------------------------ Zulip's own links

/**
 * A Zulip organization's address from its host (dither-accounts' ids: `<host>` is the server's host and port, without
 * its scheme). https, as an organization is served; plain http only on this machine (a local test server).
 */
const zulipBase = (host: string) => `${/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https'}://${host}`;

/**
 * Zulip's hash encoding, as its web client writes narrow links (`encodeHashComponent` in zulip/zulip's
 * web/src/internal_url.ts, https://github.com/zulip/zulip/blob/7bb11b60d91def4644f6c74be6611fcc85488b06/web/src/internal_url.ts#L7-L24):
 * encodeURIComponent, then `%` as `.` and `!'()*.` as `.` and their hex.
 */
export const zulipHash = (s: string) => encodeURIComponent(s).replace(/[%!'()*.]/g, (c) => (c === '%' ? '.' : `.${c.charCodeAt(0).toString(16).toUpperCase()}`));

/** A channel's part of a narrow: its id and name, as Zulip writes it (`encode_slug`), or the bare id where that is long. */
function zulipChannel(id: string, name: string | null | undefined) {
  const slug = `${id}-${(name ?? '').replace(/ /g, '-')}`;
  const enc = zulipHash(slug);
  return !name || enc.length - slug.length > 10 || enc.length > slug.length * 1.5 ? id : enc;
}

/**
 * A Zulip conversation's narrow link from its native id (dither-accounts' docs/zulip.md): a channel, a topic (by the
 * name it has now, since its id is lowercased), or direct messages (`-dm` for two, `-group` for more, as Zulip's own
 * permalinks).
 */
function zulipLink(c: P.ConversationView): string | null {
  let m = c.nativeId.match(/^([^/]+)\/s\/(\d+)(?:\/t\/(.*))?$/s);
  if (m) {
    const [, host, stream, topic] = m;
    const channel = c.shape === 'thread' && c.parentId ? db.conversations.get(c.parentId) : c;
    const at = `${zulipBase(host!)}/#narrow/channel/${zulipChannel(stream!, channel?.name)}`;
    // The empty topic ("general chat" in Zulip's apps) is `…/t/`: its link's topic is empty too, as Zulip writes it.
    return topic === undefined ? at : `${at}/topic/${zulipHash(topic === '' ? '' : (c.name ?? decodeURIComponent(topic)))}`;
  }
  m = c.nativeId.match(/^([^/]+)\/dm\/(\d+(?:,\d+)*)$/);
  if (m) return `${zulipBase(m[1]!)}/#narrow/dm/${m[2]}-${m[2]!.split(',').length > 2 ? 'group' : 'dm'}`;
  return null;
}

/** A Zulip message's own link: its conversation's narrow, near it. */
export function zulipMessageLink(c: P.ConversationView, messageNativeId: string): string | null {
  const id = messageNativeId.match(/\/m\/(\d+)$/)?.[1];
  const at = zulipLink(c);
  return id && at ? `${at}/near/${id}` : null;
}

/** A space's page on its network's own site: a Discord server, a Matrix space, a Zulip organization. */
export function spaceLink(s: P.SpaceView): string | null {
  if (s.network === 'discord') return `https://discord.com/channels/${s.nativeId}`;
  if (s.network === 'matrix') return `https://matrix.to/#/${encodeURIComponent(s.nativeId)}`;
  if (s.network === 'zulip') return s.kind === 'community' ? `${zulipBase(s.nativeId)}/` : null;
  return null;
}

/** "Open in …": the app a network's links open, for the button that does. */
export const linkOpensIn = (n: P.Network) => (n === 'matrix' ? 'Element (matrix.to)' : netName(n));
export const netColor = (n: P.Network) => NETWORK_META[n].color;

// ------------------------------------------------------------------ visibility

/** A hub is either a demo world or a real one (never both), so every account it knows is shown. */
export function visibleAccount(id: string) {
  // A mail account is an account too: its email routes and threads are chats (mail/chats.ts).
  return db.accounts.has(id) || db.mail.accounts.has(id);
}
export function visibleConv(c: P.ConversationView) {
  // A loop, not `some` with a closure: this runs for every conversation in several passes of a first draw.
  for (const v of c.vantages) if (visibleAccount(v.accountId)) return true;
  return false;
}
function visibleSpace(s: P.SpaceView) {
  return s.accountIds.some(visibleAccount);
}

// ------------------------------------------------------------------ names

/** Replace raw <@id> / <#id> tokens in stored preview text with readable names. */
export function resolveTokens(text: string, network: P.Network): string {
  return text
    .replace(/<@&[^>\s]+>/g, '@role')
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

/**
 * A conversation by its network's own id, as room links name them: one map of ids while what is where stays the same
 * (`metaMemo`), not a scan per link, nor a new map for every message or read.
 */
export function convByNative(network: P.Network, nativeId: string): P.ConversationView | undefined {
  const id = metaMemo('convByNative', '', () => {
    const m = new Map<string, string>();
    for (const c of db.conversations.values()) if (!m.has(`${c.network}:${c.nativeId}`)) m.set(`${c.network}:${c.nativeId}`, c.id);
    return m;
  }).get(`${network}:${nativeId}`);
  return id ? db.conversations.get(id) : undefined;
}

/** A message body as one plain line, for quotes and previews. */
/** A bio as one line, its links kept for Linked: X's (and the other networks of posts') is plain text as written (no Markdown to take out of it). */
export function bioText(bio: string, network: P.Network): string {
  return POST_NETWORKS.includes(network) ? bio.replace(/\s+/g, ' ').trim() : plainBody(bio, network, true);
}

export function plainBody(body: string, network: P.Network, keepLinks = false): string {
  return plainMarkdown(resolveTokens(body, network).replace(/```[\s\S]*?```/g, '[code]').replace(/\|\|[\s\S]*?\|\|/g, '[spoiler]'), keepLinks);
}

/**
 * Markdown's marks taken out of text that is shown as one plain line: quotes, headings, lists, emphasis, links.
 * `keepLinks`: a Markdown link stays, for text drawn with its links (bits.tsx Linked).
 */
export function plainMarkdown(text: string, keepLinks = false): string {
  // Links kept are set aside while the marks go, so an address's own underscores and stars stay.
  const kept: string[] = [];
  const keep = (s: string) => `\u0000${kept.push(s) - 1}\u0000`;
  let t = text.replace(/```\w*/g, '').replace(/^\s*(?:>|-#|#{1,3}|[-*])\s+/gm, '');
  t = keepLinks
    ? t.replace(/\[[^\]\n]+\]\(https?:[^)\s]+\)|https?:\/\/[^\s<>]+/g, keep)
    : t.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1');
  t = t.replace(/\*\*|__|~~|\|\||[*`]/g, '').replace(/\s+/g, ' ').trim();
  return keepLinks ? t.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]) : t;
}

export function identityName(id: string | null | undefined): string {
  if (!id) return 'Unknown';
  const i = db.identities.get(id);
  if (!i) return 'Unknown';
  return accountName(i);
}

// "Mail with Sam": a `w:` list's heading names the person (mail/model.ts).
scopeAccounts.of = (id) => db.mail.accounts.get(id) ?? null;
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

/**
 * The face an account's author is shown by (docs/chats.md, Names): their person's picture, else the account's own,
 * with `id` for the initials' colour (the person's, so every account of theirs has one) and the network the picture
 * came from. Your own accounts are shown as themselves.
 */
export function faceOf(identityId: string | null | undefined): { id: string; url: string | null; network: P.Network | null } {
  const i = identityId ? db.identities.get(identityId) : undefined;
  const p = personOf(identityId);
  if (!p || p.isSelf || !p.avatar) return { id: p && !p.isSelf ? p.id : (identityId ?? ''), url: i?.avatar ?? null, network: i?.avatar ? i.network : null };
  const theirs = p.identityIds.map((x) => db.identities.get(x));
  const from = theirs.find((x) => x?.avatar === p.avatar) ?? db.identities.get(p.faceId ?? p.identityIds[0]);
  return { id: p.id, url: p.avatar, network: from?.network ?? null };
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
  // A resolved Zulip topic keeps Zulip's ✔ in its name; it shows as a Resolved mark instead (resolvedTopic).
  if (c.name) return resolvedTopic(c) ? c.name.slice(RESOLVED.length) : c.name;
  if (c.shape === 'group')
    return (
      c.participantIds
        .filter((p) => !isSelfIdentity(p))
        .slice(0, 3)
        .map(authorName)
        .join(', ') || 'Group'
    );
  return 'Unnamed';
}

/** Zulip marks a resolved topic by this in front of its name (dither-accounts' docs/zulip.md). */
const RESOLVED = '✔ ';

/** A resolved Zulip topic: its name starts with Zulip's ✔, and the hub has it archived. */
export const resolvedTopic = (c: P.ConversationView) => c.network === 'zulip' && c.shape === 'thread' && !!c.name?.startsWith(RESOLVED);

/**
 * A forum whose threads are topics (Zulip's channels): the channel takes no messages of its own, and its topics are
 * read as channels are, not posts to browse. Its words are Zulip's (threadWords), and its resolved topics are listed
 * with the rest (shownThreads).
 */
export const topicForum = (c: P.ConversationView | null | undefined) => !!c && c.variant === 'forum' && c.network === 'zulip';

/** The words for a channel's threads, by network: Zulip's topics are resolved, Discord's posts and threads archived. */
interface ThreadWords {
  /** "topic", "post", "thread". */
  one: string;
  many: string;
  /** "Resolved", "Archived": a tab, a chip, a toast. */
  archived: string;
  archive: string;
  unarchive: string;
  unarchived: string;
}
export function threadWords(c: P.ConversationView | null | undefined): ThreadWords {
  const place = c && c.shape === 'thread' && c.parentId ? db.conversations.get(c.parentId) : c;
  if (topicForum(place) || (c?.network === 'zulip' && c.shape === 'thread'))
    return { one: 'topic', many: 'topics', archived: 'Resolved', archive: 'Resolve', unarchive: 'Unresolve', unarchived: 'Unresolved' };
  const posts = place?.variant === 'forum' || place?.variant === 'media';
  return { one: posts ? 'post' : 'thread', many: posts ? 'posts' : 'threads', archived: 'Archived', archive: 'Archive', unarchive: 'Unarchive', unarchived: 'Unarchived' };
}

/** "#dev" for channels, plain names otherwise. */
export function convLabel(c: P.ConversationView): string {
  const t = convTitle(c);
  return c.shape === 'channel' && c.network === 'discord' && c.variant !== 'voice' && c.variant !== 'stage' ? `#${t}` : t;
}

export function kindLabel(c: P.ConversationView): string {
  const n = netName(c.network);
  const variant = { text: '', announcement: 'announcement ', forum: 'forum ', voice: 'voice ', stage: 'stage ', media: 'media ', rules: 'rules ', feed: 'notifications ', posts: 'posts ' }[c.variant as Exclude<P.Variant, 'follow'>] ?? '';
  switch (c.shape) {
    case 'direct':
      return c.network === 'discord' || c.network === 'matrix' ? `${n} DM` : `${n} chat`;
    case 'group':
      return c.network === 'discord' ? 'Discord group DM' : c.network === 'matrix' ? 'Matrix room (private)' : `${n} group`;
    case 'self':
      return `${n} notes to self`;
    case 'thread': {
      const parent = c.parentId ? db.conversations.get(c.parentId) : null;
      if (c.network === 'zulip') return 'Zulip topic';
      return parent?.variant === 'forum' ? `${n} forum post` : `${n} thread`;
    }
    case 'channel':
      if (c.network === 'discord') return `Discord ${variant}channel`;
      if (c.network === 'matrix') return c.spaceIds.length ? `Matrix ${variant}room` : 'Matrix room (no space)';
      // A Telegram forum's topic (dither-accounts' forums as spaces); its "channels" are broadcast groups.
      if (c.network === 'telegram') return 'Telegram topic';
      // A Zulip channel is a forum of topics (dither-accounts' docs/zulip.md).
      if (c.network === 'zulip') return 'Zulip channel';
      if (c.variant === 'follow') return `${n} post you follow`;
      return `${n} ${variant}channel`;
  }
}

// ------------------------------------------------------------------ hierarchy

function spaceParents(id: string): P.SpaceView[] {
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

interface Crumb {
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

interface TreeNode {
  kind: 'section' | 'subspace' | 'conversation';
  id: string;
  position: string | null;
}

export function spaceChildren(id: string): TreeNode[] {
  return placesMemo('children', id, () =>
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
    // Ids, names and what is shown: a message or a read changes none of them.
    keep,
  );
}

/** Channels a server can open on: ones with messages to read, not voice rooms, forums or feeds. */
const OPENS_ON: ReadonlySet<P.Variant> = new Set(['text', 'announcement', 'rules']);

/**
 * A space's first channel to read, in list order through its categories and subspaces, as Discord opens a server.
 * A space with no channel of messages opens on its first forum (a Zulip organization, whose channels are all forums),
 * which shows the forum's posts.
 */
export function firstChannel(id: string): string | undefined {
  return firstOf(id, OPENS_ON, new Set()) ?? firstOf(id, FORUMS, new Set());
}
const FORUMS: ReadonlySet<P.Variant> = new Set(['forum']);

function firstOf(id: string, variants: ReadonlySet<P.Variant>, seen: Set<string>): string | undefined {
  if (seen.has(id)) return undefined;
  seen.add(id);
  for (const n of spaceChildren(id)) {
    const hit = n.kind === 'conversation' ? (variants.has(db.conversations.get(n.id)!.variant) ? n.id : undefined) : firstOf(n.id, variants, seen);
    if (hit) return hit;
  }
  return undefined;
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

/** A channel whose own count may already hold its threads' (a Discord forum's read state): it takes no messages itself. */
const postsOnly = (c: P.ConversationView | null | undefined) => !!c && c.shape !== 'thread' && (c.variant === 'forum' || c.variant === 'media');

/** At most this many unread threads under a channel in the sidebar, mentions aside: a busy Zulip channel has hundreds. */
export const UNREAD_THREADS_SHOWN = 8;
/** And this many of its latest threads after them, as long as they are not shown already. */
export const LATEST_THREADS_SHOWN = 3;

interface ShownThreads {
  /** The rows under the channel, in order. */
  shown: P.ConversationView[];
  /** The threads left out that the channel's thread list shows: the "N more topics" row. */
  more: number;
}

/**
 * The threads the sidebar shows under a channel, one rule for every network (docs/servers.md, "Threads under a
 * channel"): the open one, the unread ones (a mention first; a muted one only for a mention; at most
 * UNREAD_THREADS_SHOWN others), then the latest few not shown yet. The open one comes first only when it would not be
 * shown otherwise, and was not shown before it was opened: a row stays where it was clicked. An archived thread shows only open or unread: a Discord text channel keeps hundreds of old ones.
 * Zulip's resolved topics are done, not put away, so they count as any other (its own sidebar lists them too). The
 * rest are `more`.
 */
export function shownThreads(c: P.ConversationView, active?: string): ShownThreads {
  const base = placesMemo('shownThreads', c.id, () => pickThreads(c), keepUnlessChannel(c.id));
  if (!active || active === c.id) return remember(c.id, base);
  const open = db.conversations.get(active);
  if (!open || open.parentId !== c.id || open.shape !== 'thread' || !visibleConv(open)) return remember(c.id, base);
  // Shown already, it stays where it is: a row does not jump from under the pointer that opened it.
  if (base.shown.includes(open)) return remember(c.id, base);
  const more = listedThread(c, open) ? base.more - 1 : base.more;
  // Shown before it was opened (an unread one, read by opening it): in the same place still.
  const was = lastShown.get(c.id);
  const at = was ? was.indexOf(open.id) : -1;
  if (at >= 0) return remember(c.id, { shown: [...base.shown.slice(0, at), open, ...base.shown.slice(at)], more });
  // Opened from the channel's list of the rest, or from elsewhere: it comes first, out of them.
  return remember(c.id, { shown: [open, ...base.shown], more });
}

/** The threads each channel showed last: where an open thread that the rule would now leave out stays. */
const lastShown = new Map<string, string[]>();
function remember(channel: string, s: ShownThreads): ShownThreads {
  lastShown.set(
    channel,
    s.shown.map((t) => t.id),
  );
  return s;
}

/** A thread the channel's thread list shows without asking: not an archived one, but a resolved Zulip topic. */
const listedThread = (c: P.ConversationView, t: P.ConversationView) => !t.archived || topicForum(c);

function pickThreads(c: P.ConversationView): ShownThreads {
  const all = threadsOf(c.id);
  if (!all.length) return { shown: [], more: 0 };
  const chanMuted = unreadOf(c).muted;
  const mentioned: P.ConversationView[] = [];
  const unread: P.ConversationView[] = [];
  const latest: P.ConversationView[] = [];
  let listed = 0;
  // Latest first, so each list takes the latest of its kind, and the latest few are those not shown yet.
  for (const t of all) {
    const listedHere = listedThread(c, t);
    if (listedHere) listed++;
    const u = unreadOf(t);
    if (u.unread > 0 || u.mentions > 0) {
      // Muted, it shows only for a mention that still makes a badge (Mute outright takes even that off).
      if (u.mentions > 0 && (!u.muted || u.badge > 0)) {
        mentioned.push(t);
        continue;
      }
      if (!u.muted && unread.length < UNREAD_THREADS_SHOWN) {
        unread.push(t);
        continue;
      }
    }
    // Muted by itself in a channel that is not: left out of the latest, as Zulip's sidebar does.
    if (listedHere && latest.length < LATEST_THREADS_SHOWN && (chanMuted || !u.muted)) latest.push(t);
  }
  const shown = [...mentioned, ...unread, ...latest];
  return { shown, more: Math.max(0, listed - shown.filter((t) => listedThread(c, t)).length) };
}

/**
 * A channel's count with its threads', every one of them (the sidebar shows only some): what its row's badge says,
 * folded or not. A thread's messages are its own (the hub counts them there), so a text channel's own count and its
 * threads' add up; a forum's own count may already hold its posts', so `sumUnread` takes the larger.
 */
/** An update that keeps what was worked out from a channel and its threads unless one of them changed. */
const keepUnlessChannel =
  (id: string) =>
  <T>(prev: T, ids: ReadonlySet<string>) => {
    for (const x of ids) if (x === id || db.conversations.get(x)?.parentId === id) return undefined;
    return prev;
  };

export function channelUnread(c: P.ConversationView): Unread {
  return placesMemo('cu', c.id, () => {
    const ids = db.threads.get(c.id);
    const own = unreadOf(c);
    if (!ids?.length) return own;
    const all: P.ConversationView[] = [c];
    for (const id of ids) {
      const t = db.conversations.get(id);
      if (t && visibleConv(t)) all.push(t);
    }
    const sum = sumUnread(all);
    // A muted channel's own count is left out of the sum, but the row still says it has some, dimmed.
    return { ...sum, unread: Math.max(sum.unread, own.unread), muted: own.muted };
  }, keepUnlessChannel(c.id));
}

const NO_PREF: Omit<P.PlacePrefView, 'kind' | 'id'> = { position: null, pinned: false, hidden: false, open: false, railed: false };
/**
 * The places a place inherits a setting from, nearest first (not itself): a thread's channel, a channel's server and
 * its parents, then the folders holding any of them (a direct chat through its person). The @ list's setting
 * (ui/MentionFinds.tsx) and how pictures are shown (pictures.ts) are read along it.
 */
export function placesAbove(kind: P.PlaceKind, id: string): [P.PlaceKind, string][] {
  const out: [P.PlaceKind, string][] = [];
  const held: [string, string][] = [[kind, id]];
  let spaces: string[] = [];
  let peer: string | null | undefined;
  if (kind === 'conversation') {
    const c = db.conversations.get(id);
    const base = c ? placeConv(c) : undefined;
    if (base && base.id !== id) held.push(['conversation', base.id]);
    spaces = base?.spaceIds ?? [];
    if (c?.shape === 'direct') peer = c.peerPersonId;
  } else if (kind === 'space') spaces = spaceParents(id).map((s) => s.id);
  const seen = new Set<string>();
  while (spaces.length) {
    const next: string[] = [];
    for (const s of spaces) {
      if (seen.has(s)) continue;
      seen.add(s);
      held.push(['space', s]);
      next.push(...spaceParents(s).map((p) => p.id));
    }
    spaces = next;
  }
  // A direct chat is in a folder through its person.
  if (peer) held.push(['person', peer]);
  for (const [k, i] of held) {
    if ((k !== kind || i !== id) && k !== 'person') out.push([k as P.PlaceKind, i]);
  }
  // Folders after every channel and space, as the hub reads them.
  for (const [k, i] of held) {
    if (k !== 'folder') for (const f of db.folders.filter((f) => f.items.some((x) => x.kind === k && x.id === i)).sort((a, b) => a.id.localeCompare(b.id))) out.push(['folder', f.id]);
  }
  // A folder inside a folder: the outer one after it, as the hub reads them.
  for (const [k, i] of [...out]) {
    const outer = k === 'folder' ? db.folders.find((f) => f.items.some((x) => x.kind === 'folder' && x.id === i)) : undefined;
    if (outer) out.push(['folder', outer.id]);
  }
  return out;
}

export function placePref(kind: P.PlaceKind, id: string) {
  return db.placePrefs.get(`${kind}:${id}`) ?? { kind, id, ...NO_PREF };
}

export type RailEntry = { key: string; kind: 'folder'; folder: P.FolderView } | { key: string; kind: 'space'; space: P.SpaceView } | { key: string; kind: 'conversation'; conv: P.ConversationView };

/** The latest message in a folder: a loop, not a spread of every conversation in it. */
function folderActivity(convs: readonly P.ConversationView[]): number {
  let max = 0;
  for (const c of convs) if ((c.lastMessageAt ?? 0) > max) max = c.lastMessageAt!;
  return max;
}
const placeActivity = (e: RailEntry) => (e.kind === 'folder' ? folderActivity(folderConvs(e.folder)) : e.kind === 'space' ? activityOfSpace(e.space.id) : (e.conv.lastMessageAt ?? 0));

/** A rail entry with what orders it: its settings, activity, and where it came in the list it was made from. */
type RailItem = { e: RailEntry; pref: P.PlacePrefView; act: number; group: number; base: number; fc?: readonly P.ConversationView[] };
/** What a rail list was sorted from, to sort it again when only some conversations' last messages moved. */
type RailOrder = { items: RailItem[]; under: Map<string, RailItem[]> | null };
const railOrders = new WeakMap<readonly RailEntry[], RailOrder>();

/**
 * Pinned, then what you arranged, then folders, then by activity; entries alike in all that keep the order they were
 * listed in: folders as you made them, servers by activity and then as they are, then conversations you added.
 */
function railBefore(a: RailItem, b: RailItem): number {
  const pa = a.pref, pb = b.pref;
  if (pa.pinned !== pb.pinned) return pa.pinned ? -1 : 1;
  if ((pa.position === null) !== (pb.position === null)) return pa.position !== null ? -1 : 1;
  if (pa.position === null) {
    if ((a.e.kind === 'folder') !== (b.e.kind === 'folder')) return a.e.kind === 'folder' ? -1 : 1;
    if (a.act !== b.act) return b.act - a.act;
  } else if (pa.position !== pb.position) return pa.position - pb.position!;
  // The same place you gave both: as listed, where servers are listed by activity.
  else if (a.group === 1 && b.group === 1 && a.act !== b.act) return b.act - a.act;
  return a.group - b.group || a.base - b.base;
}

function sortedRail(items: RailItem[], under: RailOrder['under']): RailEntry[] {
  items.sort(railBefore);
  const out = items.map((x) => x.e);
  railOrders.set(out, { items, under });
  return out;
}

/**
 * After a message or a read: the entries holding a changed conversation take their activity again, and the list is
 * sorted again from what it was sorted from, or kept as it is when no activity moved. An added conversation that
 * changed holds the conversation's new copy, so the list is made again (undefined).
 */
function railUpdate(prev: RailEntry[], ids: ReadonlySet<string>): RailEntry[] | undefined {
  const o = railOrders.get(prev);
  if (!o) return undefined;
  // Each server's conversations, once per list made: what is under a server moves only with what is where.
  if (!o.under) {
    o.under = new Map();
    for (const x of o.items)
      if (x.e.kind === 'space')
        for (const id of idsUnder(x.e.space.id)) {
          const l = o.under.get(id);
          if (l) l.push(x);
          else o.under.set(id, [x]);
        }
  }
  let moved = false;
  const again = (x: RailItem, act: number) => {
    if (act !== x.act) (x.act = act), (moved = true);
  };
  for (const x of o.items) {
    if (x.e.kind === 'conversation' && ids.has(x.e.conv.id)) return undefined;
    // A folder's conversations can be people's chats: few folders, so each is looked at, and its activity taken again
    // only when they are a new list (folderConvs keeps the one it has while none of them changed).
    if (x.e.kind === 'folder') {
      const fc = folderConvs(x.e.folder);
      if (fc !== x.fc) again(x, folderActivity((x.fc = fc)));
    }
  }
  for (const id of ids) for (const x of o.under.get(id) ?? []) if (x.e.kind === 'space') again(x, activityOfSpace(x.e.space.id));
  return moved ? sortedRail([...o.items], o.under) : prev;
}

/**
 * Top-level sidebar entries in display order: pinned, then what you arranged, then the rest (folders, then by activity).
 * Communities are listed by default; a conversation only once you add it. Whatever sits in a folder lives there instead.
 */
export function railEntries(which: 'shown' | 'hidden' = 'shown'): RailEntry[] {
  return placesMemo(
    'rail',
    which,
    () => {
      // Conversations you added to the rail and not to a folder: by id, since what is where moves only with settings.
      const railed = metaMemo('railed', '', () => {
        const inFolder = new Set(db.folders.flatMap((f) => f.items.map((i) => `${i.kind}:${i.id}`)));
        // Whether you added it first: most conversations have no place settings, and `placePref` makes them some.
        return { inFolder, convs: [...db.conversations.values()].filter((c) => db.placePrefs.get(`conversation:${c.id}`)?.railed && visibleConv(c) && !inFolder.has(`conversation:${c.id}`)).map((c) => c.id) };
      });
      const items: RailItem[] = [];
      const add = (e: RailEntry, group: number, base: number) => {
        const pref = placePref(e.kind, e.key.slice(e.key.indexOf(':') + 1));
        // Each entry's place and activity once, not in every comparison of the sort.
        if (pref.hidden !== (which === 'hidden')) return;
        if (e.kind !== 'folder') items.push({ e, pref, act: placeActivity(e), group, base });
        else {
          const fc = folderConvs(e.folder);
          items.push({ e, pref, act: folderActivity(fc), group, base, fc });
        }
      };
      // A folder inside a folder is drawn there, not at the top.
      db.folders.forEach((folder, i) => !railed.inFolder.has(`folder:${folder.id}`) && add({ key: `folder:${folder.id}`, kind: 'folder', folder }, 0, i));
      topCommunities().forEach((space, i) => !railed.inFolder.has(`space:${space.id}`) && add({ key: `space:${space.id}`, kind: 'space', space }, 1, i));
      railed.convs.forEach((id, i) => {
        const conv = db.conversations.get(id);
        if (conv) add({ key: `conversation:${id}`, kind: 'conversation', conv }, 2, i);
      });
      return sortedRail(items, null);
    },
    railUpdate,
  );
}

/** Communities not inside another one you can see, as they are listed. */
const topCommunities = () =>
  metaMemo('communities', '', () => [...db.spaces.values()].filter((s) => s.kind === 'community' && visibleSpace(s) && !spaceParents(s.id).some((p) => p.kind === 'community' && visibleSpace(p))));

export function allCommunities(): P.SpaceView[] {
  return placesMemo('allCommunities', '', () => {
    const top = topCommunities();
    const act = new Map(top.map((s) => [s.id, activityOfSpace(s.id)]));
    return [...top].sort((a, b) => act.get(b.id)! - act.get(a.id)!);
  });
}

/** Every conversation under a space, through sections, subspaces and threads. */
export function convsUnder(id: string): P.ConversationView[] {
  return placesMemo(
    'under',
    id,
    () => {
      const out: P.ConversationView[] = [];
      for (const cid of idsUnder(id)) {
        const c = db.conversations.get(cid);
        if (c) out.push(c);
      }
      return out;
    },
    keepUnlessUnder(id),
  );
}

/** An update that keeps what was worked out from a space's conversations unless one of them changed. */
const keepUnlessUnder = (id: string) => keepUnless(() => idsUnder(id));

/**
 * A space's channels, not the threads and topics under them (every Zulip topic is a conversation of its own), latest
 * first by their newest message there or in a thread of theirs: a Zulip channel takes no messages itself.
 */
export function channelsUnder(id: string): P.ConversationView[] {
  return placesMemo('chans', id, () => {
    const under = convsUnder(id);
    const latest = new Map<string, number>();
    for (const c of under) {
      const k = c.shape === 'thread' && c.parentId ? c.parentId : c.id;
      latest.set(k, Math.max(latest.get(k) ?? 0, c.lastMessageAt ?? 0));
    }
    return under.filter((c) => c.shape === 'channel').sort((a, b) => latest.get(b.id)! - latest.get(a.id)!);
  }, keepUnlessUnder(id));
}

/** Their ids: the walk is done again only when what is where may have changed. */
function idsUnder(id: string): ReadonlySet<string> {
  return metaMemo('under', id, () => {
    const out = new Set<string>();
    const seen = new Set<string>();
    const walk = (sid: string) => {
      if (seen.has(sid)) return;
      seen.add(sid);
      for (const e of db.children.get(sid) ?? []) {
        if (e.childKind === 'space') walk(e.childId);
        else {
          const c = db.conversations.get(e.childId);
          if (c && visibleConv(c)) {
            out.add(c.id);
            for (const t of db.threads.get(c.id) ?? []) {
              const th = db.conversations.get(t);
              if (th && visibleConv(th)) out.add(th.id);
            }
          }
        }
      }
    };
    walk(id);
    return out;
  });
}

export function activityOfSpace(id: string): number {
  return placesMemo(
    'act',
    id,
    () => {
      let max = 0;
      for (const c of convsUnder(id)) if ((c.lastMessageAt ?? 0) > max) max = c.lastMessageAt!;
      return max;
    },
    keepUnlessUnder(id),
  );
}

// ------------------------------------------------------------------ categories

/** Your choice, else the score against the category's threshold (`at` overrides it while a slider moves). */
export const memberOf = (x: P.PlaceCategoryView, at?: Record<string, number>) =>
  x.override ?? (x.p ?? 0) >= (at?.[x.categoryId] ?? categoryThreshold(db.categories.find((c) => c.id === x.categoryId), x.provider));

export function categoriesOf(kind: 'space' | 'conversation', id: string, at?: Record<string, number>): P.CategoryView[] {
  const mine = db.placeCategories.get(`${kind}:${id}`) ?? [];
  return db.categories.filter((c) => mine.some((x) => x.categoryId === c.id && memberOf(x, at)));
}

// ------------------------------------------------------------------ notification rules (mirrors hub triage.ts)

/** What the networks do where nothing is set: DMs and group chats notify on every message, channels on mentions. */
const NATIVE_DEFAULT: Record<P.Shape, 'all' | 'mentions' | 'none'> = { direct: 'all', group: 'all', channel: 'mentions', thread: 'mentions', self: 'none' };
/** A level that still means something: `smart` is from before the tiers and reads as no rule. */
export type Level = Exclude<P.NotifyLevel, 'smart'>;
const rank = (l: Level) => ({ none: 0, digest: 1, mentions: 2, all: 3 })[l];

/** Your rules that still mean something. */
export const liveRules = () => placesMemo('liveRules', '', () => db.rules.filter((r): r is P.RuleView & { level: Level } => r.level !== 'smart'), keep);
/** Your rules by scope, then by target ('' for none): no string made for each look (effectiveLevel looks up several). */
const ruleMap = () =>
  placesMemo(
    'rules',
    '',
    () => {
      const m = new Map<string, Map<string, Level>>();
      // Of two rules on one place, the later holds (as a Map made from them in order).
      for (const r of liveRules()) entries(m, r.scope).set(r.target ?? '', r.level);
      return m;
    },
    keep,
  );
/** The rule set on this very place, person or keyword; null with none. */
export const ruleOn = (scope: P.NotifyScope, target: string | null): Level | null => ruleMap().get(scope)?.get(target ?? '') ?? null;

interface Effective {
  /**
   * What holds here. With a rule, its level: `all` always alerts, `digest` keeps the place to the list, `none` mutes
   * it. With none, what the network itself does: `digest` where it is muted there (kept to the list too).
   */
  level: Level;
  /** The rule that holds, set here or above; null with none, where the tiers decide (Automatic). */
  rule: Level | null;
  /** Where the rule was set; with none, what the network does here, in words. */
  source: string;
  explicit: boolean;
  scope: P.NotifyScope | 'default' | 'native';
}

export function effectiveLevel(c: P.ConversationView): Effective {
  // From rules, places and native mutes, all of which move metaRev: not worked out again for a message or a read.
  return metaMemo('lvl', c.id, () => {
    const rules = ruleMap();
    const hit = (scope: string, target: string | null) => rules.get(scope)?.get(target ?? '');
    const set = (level: Level, source: string, explicit: boolean, scope: Effective['scope']): Effective => ({ level, rule: level, source, explicit, scope });
    let l: Level | undefined;
    if ((l = hit('conversation', c.id))) return set(l, 'this conversation', true, 'conversation');
    // Mail reads only a thread's own rule and people's Always alert (hub mail/triage.ts, docs/mail.md slice 9).
    if (c.network === 'email') return { level: 'digest', rule: null, source: 'mail is on the list by its importance; only someone set to always alert sounds', explicit: false, scope: 'default' };
    const parent = c.shape === 'thread' && c.parentId ? db.conversations.get(c.parentId) : undefined;
    if (parent && (l = hit('conversation', parent.id))) return set(l, convLabel(parent), true, 'conversation');
    // Breadth-first over containing spaces.
    const seen = new Set<string>();
    let frontier = [...(parent ?? c).spaceIds];
    while (frontier.length) {
      const next: string[] = [];
      for (const sid of frontier) {
        if (seen.has(sid)) continue;
        seen.add(sid);
        const s = db.spaces.get(sid);
        if (s && (l = hit('space', sid))) return set(l, s.kind === 'section' ? s.name : `${s.name} (${NETWORK_META[s.network].spaceNoun})`, true, 'space');
        next.push(...(db.parents.get(sid) ?? []).map((e) => e.parentId));
      }
      frontier = next;
    }
    let base: Effective | null = null;
    for (const v of c.vantages) {
      if ((l = hit('account', v.accountId))) {
        base = set(l, `account ${db.accounts.get(v.accountId)?.label}`, false, 'account');
        break;
      }
    }
    if (!base && (l = hit('network', c.network))) base = set(l, `all of ${netName(c.network)}`, false, 'network');
    if (!base && (l = hit('global', null))) base = set(l, 'everything', false, 'global');
    // No rule: Automatic. What the network does here (hub triage.ts nativeLevel) is said beside it; muted there, the
    // place is kept to the list.
    if (!base) {
      const n = nativeLevel(c, parent);
      const net = netName(c.network);
      const source = n === 'all' ? `${net} notifies every message here` : n === 'mentions' ? `${net} notifies only mentions here` : `Muted in ${net}: kept to the list`;
      return { level: n === 'none' ? 'digest' : n, rule: null, source, explicit: false, scope: 'default' };
    }
    const mute = nativeMuteLevel(c, parent);
    if (mute && rank(base.level) > rank(mute)) return set(mute, `muted in ${netName(c.network)}`, false, 'native');
    return base;
  });
}

/** What the network itself does here: the most specific setting that has not run out, nearest first. */
function nativeLevel(c: P.ConversationView, parent?: P.ConversationView): 'all' | 'mentions' | 'none' {
  const now = Date.now();
  const at = (m: P.NativeMute | null | undefined) => {
    if (m?.until !== undefined && m.until > now) expires = Math.min(expires, m.until);
    return !m || (m.until !== undefined && m.until <= now) ? null : mutedNow(m, now) ? 'none' : (m.level ?? null);
  };
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

function nativeMuteLevel(c: P.ConversationView, parent?: P.ConversationView): Level | null {
  const now = Date.now();
  // A thread's own setting is its answer over its channel's (a Zulip topic unmuted in a muted channel), as in nativeLevel.
  const own = c.nativeMute;
  const says = !!own && (mutedNow(own, now) || (own.level !== undefined && !(own.until !== undefined && own.until <= now)));
  const mutes: (P.NativeMute | null)[] = [own, says ? null : (parent?.nativeMute ?? null), ...(parent ?? c).spaceIds.map((s) => db.spaces.get(s)?.nativeMute ?? null)];
  let best: Level | null = null;
  for (const m of mutes) {
    if (!m) continue;
    if (m.until && m.until > now) expires = Math.min(expires, m.until);
    const lv: Level | null = mutedNow(m, now) ? 'digest' : m.level === 'mentions' ? 'mentions' : null;
    if (lv && (!best || rank(lv) < rank(best))) best = lv;
  }
  return best;
}

/** No rule on a place: the tiers decide. */
export const AUTOMATIC = 'Automatic';
export const AUTOMATIC_HELP = 'Conversations and alerts are worked out for you';
/** What each rule you can set does. */
export const RULE_HELP: Record<P.RuleLevel, string> = {
  all: 'Every message here is an alert',
  digest: 'Never a conversation row or an alert; it can still be on the list',
  none: 'No notification and never on the list; the unread count only',
};
/** A rule kept from before the tiers: it can be replaced, not chosen. */
export const OLDER_RULE = 'Mentions only (older setting)';
export const OLDER_RULE_HELP = 'From before the tiers: only mentions and replies count as notified here. Any of the others replaces it';

/** A rule's name; no rule (or one from before the tiers that means nothing now) is Automatic. */
export const ruleName = (l: Level | null | undefined): string => (l === 'mentions' ? OLDER_RULE : ((l && RULE_LABEL[l as P.RuleLevel]) ?? AUTOMATIC));
/** What a rule does, in a sentence without its full stop. */
export const ruleHelp = (l: Level | null | undefined): string => (l === 'mentions' ? OLDER_RULE_HELP : ((l && RULE_HELP[l as P.RuleLevel]) ?? AUTOMATIC_HELP));
/** An icon for a rule; the sparkles are Automatic. */
export const ruleIcon = (l: Level | null | undefined): string => (l === 'all' ? 'bell' : l === 'mentions' ? 'at' : l === 'digest' ? 'layers' : l === 'none' ? 'bellOff' : 'sparkles');

/**
 * What holds at a conversation with no rule of its own, for the line under Automatic: the rule above it and where
 * that was set, else what the network does here.
 */
export const heldHere = (e: Effective): string => (e.rule === null ? e.source : `${ruleName(e.rule)}, from ${e.source}`);

// ------------------------------------------------------------------ unread

interface Unread {
  unread: number;
  mentions: number;
  /** Shown as a red count: mentions, or any message in a DM/group you listen to. */
  badge: number;
  /** Muted, or kept to the list (List only, or muted on its network): drawn dimmed. Only Mute takes mentions off the badge. */
  muted: boolean;
}

export function unreadOf(c: P.ConversationView): Unread {
  // A loop, not filter and map: this runs for every unread conversation in each count.
  let unread = 0,
    mentions = 0;
  for (const v of c.vantages) {
    if (!visibleAccount(v.accountId)) continue;
    if (v.unread > unread) unread = v.unread;
    if (v.mentions > mentions) mentions = v.mentions;
  }
  const lvl = effectiveLevel(c).level;
  const muted = lvl === 'none' || lvl === 'digest';
  const loud = (c.shape === 'direct' || c.shape === 'group') && !muted;
  return { unread, mentions, badge: loud ? unread : muted && lvl === 'none' ? 0 : mentions, muted };
}

/**
 * What these conversations count together. A thread's messages are its own, so a channel's and its threads' add up;
 * but a forum's own count may already hold its posts' (a Discord forum's read state): of the forum and its posts here,
 * the larger, never both (channelUnread, a space's count, a folder's).
 */
export function sumUnread(convs: P.ConversationView[]): Unread {
  const t = newTally(false);
  for (const c of convs) tallyAdd(t, c.id, partOf(c));
  return tallyTotal(t);
}

type Triple = [number, number, number];
/** What one conversation adds to a sum, and the forum it adds to (its own count, or its posts'). */
interface Part {
  u: Unread;
  forum: string | null;
}
/** A sum kept by conversation, so one conversation's change is taken out and put in again (totalUnread). */
interface Tally {
  sum: Triple;
  forums: Map<string, { own: Triple; posts: Triple }>;
  /** Each conversation's part, when kept to be taken out again. */
  parts: Map<string, Part> | null;
}
const newTally = (keep: boolean): Tally => ({ sum: [0, 0, 0], forums: new Map(), parts: keep ? new Map() : null });

function partOf(c: P.ConversationView): Part | null {
  // Nothing unread adds nothing, whatever its level: most conversations, and the level is the dear part.
  if (!c.vantages.some((v) => v.unread || v.mentions)) return null;
  const u = unreadOf(c);
  if (u.muted && !u.badge) return null;
  return { u, forum: postsOnly(c) ? c.id : c.shape === 'thread' && c.parentId && postsOnly(db.conversations.get(c.parentId)) ? c.parentId : null };
}

function tallyAdd(t: Tally, id: string, p: Part | null, sign = 1) {
  if (!p) return;
  let into = t.sum;
  if (p.forum) {
    let f = t.forums.get(p.forum);
    if (!f) t.forums.set(p.forum, (f = { own: [0, 0, 0], posts: [0, 0, 0] }));
    into = p.forum === id ? f.own : f.posts;
  }
  into[0] += sign * p.u.unread;
  into[1] += sign * p.u.mentions;
  into[2] += sign * p.u.badge;
  if (sign > 0) t.parts?.set(id, p);
  else t.parts?.delete(id);
}

function tallyTotal(t: Tally): Unread {
  let [unread, mentions, badge] = t.sum;
  for (const { own, posts } of t.forums.values()) {
    unread += Math.max(own[0], posts[0]);
    mentions += Math.max(own[1], posts[1]);
    badge += Math.max(own[2], posts[2]);
  }
  return { unread, mentions, badge, muted: false };
}

/**
 * Everything shown, summed: the app's badge and the Home tab's. Once per `rev`. Not an open message request's: that
 * waits under Requests, on no badge (docs/add.md); nor a network's notifications, which have a row of their own
 * (docs/feed.md).
 */
export function totalUnread(): Unread {
  return placesMemo('totalUnread', '',
    () => {
      const t = newTally(true);
      const held = heldByRequest();
      // Something unread first: it adds nothing otherwise, and most of the world's conversations are read.
      for (const c of db.conversations.values()) if (c.vantages.some((v) => v.unread || v.mentions) && visibleConv(c) && !held.has(c.id) && !isQuietConv(c)) tallyAdd(t, c.id, partOf(c));
      return { t, total: tallyTotal(t) };
    },
    // A message or a read: that conversation's part out, and in again as it is now.
    (prev, ids) => {
      const { t } = prev;
      const held = heldByRequest();
      for (const id of ids) {
        tallyAdd(t, id, t.parts!.get(id) ?? null, -1);
        const c = db.conversations.get(id);
        if (c && visibleConv(c) && !held.has(c.id) && !isQuietConv(c)) tallyAdd(t, id, partOf(c));
      }
      return { t, total: tallyTotal(t) };
    },
  ).total;
}

export function spaceUnread(id: string): Unread {
  return placesMemo('su', id, () => sumUnread(convsUnder(id)), keepUnlessUnder(id));
}

/** The folder a folder sits in, if it is inside one. */
export function parentFolder(id: string): P.FolderView | undefined {
  return db.folders.find((f) => f.items.some((it) => it.kind === 'folder' && it.id === id));
}

/** What a folder holds, with a folder inside it read as its own items: for counts, names and pictures. */
export function folderLeaves(f: P.FolderView): P.FolderView['items'] {
  return f.items.flatMap((it) => (it.kind === 'folder' ? (db.folders.find((x) => x.id === it.id)?.items.filter((x) => x.kind !== 'folder') ?? []) : [it]));
}

export function folderConvs(f: P.FolderView): P.ConversationView[] {
  return placesMemo('fc', f.id, () => {
    const out = new Map<string, P.ConversationView>();
    for (const it of folderLeaves(f)) {
      if (it.kind === 'space') for (const c of convsUnder(it.id)) out.set(c.id, c);
      else if (it.kind === 'conversation') {
        const c = db.conversations.get(it.id);
        if (c && visibleConv(c)) out.set(c.id, c);
        // A channel with its threads, as under a server: its row's count is theirs too (channelUnread).
        if (c && visibleConv(c))
          for (const id of db.threads.get(c.id) ?? []) {
            const t = db.conversations.get(id);
            if (t && visibleConv(t)) out.set(t.id, t);
          }
      } else for (const c of directsOf(it.id)) out.set(c.id, c);
    }
    return [...out.values()];
  }, (prev, ids) => (touches(ids, idSet(prev)) ? undefined : prev));
}

const idSets = new WeakMap<readonly P.ConversationView[], ReadonlySet<string>>();
/** The ids of a list of conversations, once per list. */
function idSet(convs: readonly P.ConversationView[]): ReadonlySet<string> {
  let s = idSets.get(convs);
  if (!s) idSets.set(convs, (s = new Set(convs.map((c) => c.id))));
  return s;
}

// ------------------------------------------------------------------ people, groups

/** One pass over the conversations, not one per person: `people()` asks for every person on each `rev`. */
function directsByPerson(): Map<string, P.ConversationView[]> {
  return placesMemo('directsByPerson', '',
    () => {
      // A person's email routes are among their directs (mail/chats.ts): mail with them is part of their chat.
      const found = routesByPerson();
      for (const c of db.conversations.values()) {
        if (c.shape !== 'direct' || !c.peerPersonId || !visibleConv(c)) continue;
        const l = found.get(c.peerPersonId);
        if (l) l.push(c);
        else found.set(c.peerPersonId, [c]);
      }
      const sorted = new Map<string, P.ConversationView[]>();
      for (const [p, l] of found) sorted.set(p, latestFirst(l));
      return { found, sorted, mail: mailDataVersion() };
    },
    // A message or a read in a direct chat: that person's list, as found, with its new copy in the old one's place.
    (prev, ids) => {
      if (prev.mail !== mailDataVersion()) return undefined;
      let next: typeof prev | null = null;
      for (const id of ids) {
        const c = db.conversations.get(id);
        if (c?.shape !== 'direct' || !c.peerPersonId || !visibleConv(c)) continue;
        next ??= { found: new Map(prev.found), sorted: new Map(prev.sorted), mail: prev.mail };
        const l = next.found.get(c.peerPersonId);
        const at = l ? l.findIndex((x) => x.id === id) : -1;
        if (!l || at < 0) return undefined;
        const put = [...l];
        put[at] = c;
        next.found.set(c.peerPersonId, put);
        next.sorted.set(c.peerPersonId, latestFirst(put));
      }
      return next ?? prev;
    },
  ).sorted;
}

/** Latest first; a tie in the order found (a stable sort), as the first time. */
const latestFirst = (l: P.ConversationView[]) => [...l].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

const none: P.ConversationView[] = [];
export function directsOf(personId: string): P.ConversationView[] {
  return directsByPerson().get(personId) ?? none;
}

export function people(): { person: P.PersonView; directs: P.ConversationView[]; last: number }[] {
  // An open message request waits under Requests, not among the people you talk with.
  const held = heldByRequest();
  return placesMemo('people', '', () =>
    [...db.persons.values()]
      .filter((p) => !p.isSelf)
      .map((person) => {
        const directs = held.size ? directsOf(person.id).filter((d) => !held.has(d.id)) : directsOf(person.id);
        return { person, directs, last: Math.max(0, ...directs.map((d) => d.lastMessageAt ?? 0)) };
      })
      .filter((x) => x.directs.length)
      .sort((a, b) => b.last - a.last),
    // Only a direct chat's message or read moves anyone's.
    (prev, ids) => {
      for (const id of ids) if (db.conversations.get(id)?.shape === 'direct') return undefined;
      return prev;
    },
  );
}

function accountsOf(network: P.Network): P.AccountView[] {
  return [...db.accounts.values()].filter((a) => a.network === network && visibleAccount(a.id));
}

/** Account annotations only appear when you have more than one account on that network. */
export function annotateAccounts(network: P.Network): boolean {
  return accountsOf(network).length > 1;
}

let usual: { convs: number; accounts: number; by: Map<P.Network, string | null> } | null = null;
/**
 * The account most of a network's chats come through: the one its dots leave out, so a second account (a test one, an
 * alt) marks only the chats it is in. Counted again when chats or accounts come or go.
 */
export function usualAccount(network: P.Network): string | null {
  if (!usual || usual.convs !== db.conversations.size || usual.accounts !== db.accounts.size) usual = { convs: db.conversations.size, accounts: db.accounts.size, by: new Map() };
  if (usual.by.has(network)) return usual.by.get(network)!;
  const counts = new Map<string, number>();
  for (const c of db.conversations.values()) if (c.network === network) for (const v of c.vantages) counts.set(v.accountId, (counts.get(v.accountId) ?? 0) + 1);
  let best: string | null = null;
  for (const a of accountsOf(network)) if (best === null || (counts.get(a.id) ?? 0) > (counts.get(best) ?? 0)) best = a.id;
  usual.by.set(network, best);
  return best;
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
  /** The conversation; for a chat of several routes, the one with the latest message (what a click opens). */
  conv: P.ConversationView;
  /**
   * A person reached by several routes is one row (docs/inbox.md, chatroutes.ts): every route of theirs in the inbox,
   * newest first, and the person. Its key is `person:<id>`.
   */
  chat?: { person: P.PersonView; routes: P.ConversationView[] };
  /**
   * A channel's threads as one row (docs/inbox.md "One row per channel", channelrows.ts): the channel (`conv` too, what
   * a click opens), every conversation of the row (its threads in the inbox, and the channel where it had a row of its
   * own), newest first, the threads alone, and the part whose message the row shows. Its key is `channel:<id>`.
   */
  channel?: { parent: P.ConversationView; parts: P.ConversationView[]; threads: P.ConversationView[]; latest: P.ConversationView; last: number };
}
export interface MailInboxRow extends InboxScore {
  kind: 'mail';
  thread: P.MailThreadView;
}

/** A conversation row's conversations: its one, every route of a chat, or a channel's and its threads'. */
export const rowConvs = (r: ConvInboxRow) => r.chat?.routes ?? r.channel?.parts ?? [r.conv];
/** The latest message of a row, anyone's (a channel's row: of its threads that are not muted, while there are some). */
export const rowLast = (r: InboxRow) => (r.kind === 'conv' ? (r.channel?.last ?? r.conv.lastMessageAt ?? 0) : r.thread.lastAt);
/** One other person: a DM, or a mail thread between you and one other. */
export const rowDirect = (r: InboxRow) => (r.kind === 'conv' ? r.conv.shape === 'direct' : r.thread.participants <= 2);
/** Muted here or on its network: below everything else. Notes to self notify nobody, which is not the same. */
export const rowMuted = (r: InboxRow) => (r.kind === 'conv' ? r.conv.shape !== 'self' && rowConvs(r).every((c) => unreadOf(c).muted) : r.thread.muted);

/** DMs, group chats, notes to self and rooms outside a space are always in the inbox; anything else only while the hub lists it. */
const inboxShape = (c: P.ConversationView) => c.shape === 'direct' || c.shape === 'group' || c.shape === 'self' || (c.shape === 'channel' && !c.spaceIds.length);

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

/**
 * The person whose chat a conversation is a route of, when they have several routes (docs/chats.md): then a DM of
 * theirs opens their whole chat, and the inbox lists them once. Null for anything else.
 */
export function chatPersonOf(c: P.ConversationView | null | undefined): P.PersonView | null {
  if (c?.shape !== 'direct' || !c.peerPersonId) return null;
  const p = db.persons.get(c.peerPersonId);
  if (!p || p.isSelf) return null;
  const ds = directsOf(p.id);
  // Mail with them makes theirs a chat even alone: its subjects and what they wrote elsewhere are the chat's.
  return ds.length > 1 || ds.some((d) => d.network === 'email') ? p : null;
}

/**
 * The channel whose inbox row a thread folds into (docs/inbox.md "One row per channel"): its parent, a Zulip channel,
 * a Discord channel or forum, a Matrix room. Null for anything else, for a thread whose parent this page does not hold
 * (it keeps a row of its own), and for a thread of a DM (a DM's row is the person's).
 */
function threadParentOf(c: P.ConversationView | null | undefined): P.ConversationView | null {
  if (c?.shape !== 'thread' || !c.parentId) return null;
  const parent = db.conversations.get(c.parentId);
  return parent && hasThreads(parent) ? parent : null;
}

/**
 * A place whose inbox row is a channel's row (`channel:<id>`), whether or not a thread of it is listed now: one with
 * threads, not a DM. So its key holds while its threads are read or come unread, and the hold on the open row with it.
 */
const hasThreads = (c: P.ConversationView) => c.shape !== 'direct' && c.shape !== 'thread' && !!db.threads.get(c.id)?.length;

/**
 * A channel's threads with something unread (or a mention), whether or not the hub lists them: what its inbox row
 * counts and opens on (docs/inbox.md "One row per channel"). Unsorted; a busy Zulip channel has a thousand topics, so
 * this is one pass, once per change.
 */
export function unreadThreadsOf(channelId: string): P.ConversationView[] {
  return memo('ut', channelId, () => {
    const out: P.ConversationView[] = [];
    for (const id of db.threads.get(channelId) ?? []) {
      const t = db.conversations.get(id);
      if (t && t.vantages.some((v) => v.unread || v.mentions) && visibleConv(t)) out.push(t);
    }
    return out;
  });
}

/**
 * A conversation's row in the inbox: its own id, `person:<id>` for a route of a chat of several, or `channel:<id>` for
 * a thread and for a place with threads.
 */
export function inboxKeyOf(convId: string): string {
  const c = db.conversations.get(convId);
  const parent = threadParentOf(c);
  if (parent) return channelKey(parent.id);
  if (c && hasThreads(c)) return channelKey(c.id);
  const p = chatPersonOf(c);
  return p ? chatKey(p.id) : convId;
}

type BaseRow = ConvInboxRow & { last: number; unread: number; badge: number; muted: boolean };

/** A conversation's own row before grouping, or null where it has none. */
function baseRow(c: P.ConversationView, held: Set<string>): BaseRow | null {
  const a = db.attention.get(c.id);
  // A network's notifications are the Feed page's Activity (docs/feed.md "The Feed page"); logged posts none.
  if ((!a && !inboxShape(c)) || !visibleConv(c) || held.has(c.id) || isQuietConv(c)) return null;
  const row: ConvInboxRow = a ? { kind: 'conv', key: c.id, conv: c, score: a.score, needs: a.needs, reasons: a.reasons, owedSince: a.owedSince } : unscored(c);
  if (!row.needs && c.shape !== 'self' && db.placePrefs.get(`conversation:${c.id}`)?.hidden) return null;
  const u = unreadOf(c);
  return { ...row, last: c.lastMessageAt ?? 0, unread: u.unread, badge: u.badge, muted: u.muted };
}

function convRows(): ConvInboxRow[] {
  return placesMemo('inboxConvRows', '',
    () => {
      const base = new Map<string, BaseRow>();
      const held = heldByRequest();
      for (const c of db.conversations.values()) {
        const row = baseRow(c, held);
        if (row) base.set(c.id, row);
      }
      return { base, out: groupRows([...base.values()]) };
    },
    // A message, a read or a new score: those conversations' rows made again in their places, and the rows not yet
    // scored by the hub, whose order moves with the time. One that comes into the inbox or leaves it: all again, as
    // its place among the rest is the conversations' order.
    (prev, ids) => {
      const held = heldByRequest();
      const base = new Map(prev.base);
      for (const id of ids) {
        const c = db.conversations.get(id);
        const row = c ? baseRow(c, held) : null;
        if (!row !== !base.has(id)) return undefined;
        if (row) base.set(id, row);
      }
      for (const [id, row] of base) {
        if (db.attention.has(id) || ids.has(id)) continue;
        const again = baseRow(row.conv, held);
        if (!again) return undefined;
        base.set(id, again);
      }
      return { base, out: groupRows([...base.values()]) };
    },
  ).out;
}

/** Rows grouped: a person's routes as one, a channel's threads as one. */
function groupRows(rows: BaseRow[]): ConvInboxRow[] {
  // A person's routes as one row: ranked, kept and drawn as one (chatroutes.ts).
  const g = groupChats(rows, (r) => chatPersonOf(r.conv)?.id ?? null);
  // A channel's threads as one row, with the channel's own where it has one (channelrows.ts).
  const f = groupChannels(
    g.rows,
    (r) => threadParentOf(r.conv)?.id ?? null,
    (r) => r.conv.id,
    (r) => hasThreads(r.conv),
  );
  const out: ConvInboxRow[] = f.rows;
  for (const ch of g.chats)
    out.push({ kind: 'conv', key: ch.key, conv: ch.latest.conv, score: ch.score, needs: ch.needs, reasons: ch.reasons, owedSince: ch.owedSince, chat: { person: db.persons.get(ch.personId)!, routes: ch.parts.map((r) => r.conv) } });
  for (const ch of f.channels) {
    const parent = db.conversations.get(ch.channelId)!;
    const parts = ch.parts.map((r) => r.conv);
    const channel = { parent, parts, threads: parts.filter((c) => c !== parent), latest: ch.latest.conv, last: ch.last };
    out.push({ kind: 'conv', key: ch.key, conv: parent, score: ch.score, needs: ch.needs, reasons: ch.reasons, owedSince: ch.owedSince, channel });
  }
  return out;
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
    mailMemo = { data, mail, rows: foldMailIntoChats(convs, rows), waiting: scored > rows.length };
  }
  return mailMemo.rows;
}

/**
 * Mail as chats (docs/mail.md "Mail as chats"): a thread between you and one person is part of their chat, so its row
 * is theirs. It joins the person's row (ranked by the best of the two, needing you if either does), or, where they
 * have none yet, becomes the row of its email route. A thread with others stays a row of its own, which opens as a
 * chat of its own.
 */
function foldMailIntoChats(convs: InboxRow[], mails: MailInboxRow[]): InboxRow[] {
  const out = [...convs];
  const byPerson = new Map<string, number>();
  out.forEach((r, i) => {
    if (r.kind !== 'conv') return;
    const pid = r.chat?.person.id ?? (r.conv.shape === 'direct' ? r.conv.peerPersonId : null);
    if (pid) byPerson.set(pid, i);
  });
  for (const m of mails) {
    const route = personRouteOf(m.thread);
    if (!route) {
      out.push(m);
      continue;
    }
    const pid = route.peerPersonId!;
    const at = byPerson.get(pid);
    const person = db.persons.get(pid);
    if (at === undefined) {
      byPerson.set(pid, out.length);
      out.push({ kind: 'conv', key: chatKey(pid), conv: route, score: m.score, needs: m.needs, reasons: m.reasons, owedSince: m.owedSince, ...(person ? { chat: { person, routes: [route] } } : {}) });
      continue;
    }
    const r = out[at] as ConvInboxRow;
    const routes = r.chat?.routes ?? [r.conv];
    const later = (m.thread.lastAt ?? 0) > (r.conv.lastMessageAt ?? 0);
    out[at] = {
      ...r,
      key: chatKey(pid),
      conv: later ? route : r.conv,
      score: Math.max(r.score, m.score),
      needs: r.needs || m.needs,
      reasons: [...new Set([...r.reasons, ...m.reasons])],
      owedSince: r.owedSince === null ? m.owedSince : m.owedSince === null ? r.owedSince : Math.min(r.owedSince, m.owedSince),
      chat: { person: r.chat?.person ?? person!, routes: routes.includes(route) ? routes : later ? [route, ...routes] : [...routes, route] },
    };
  }
  return out;
}

/** The email route a mail thread is part of, when it is between you and one person (the hub's place for it). */
export function personRouteOf(t: P.MailThreadView): P.ConversationView | null {
  if (t.class === 'bulk' || t.personIds.length !== 1 || t.participants > 2) return null;
  const pid = t.personIds[0];
  if (!db.persons.has(pid)) return null;
  const theirs = t.from.find((f) => !f.self && f.personId === pid)?.email.toLowerCase();
  for (const c of directsOf(pid)) {
    if (c.network !== 'email' || c.vantages[0]?.accountId !== t.accountId) continue;
    if (!theirs || c.nativeId === theirs) return c;
  }
  return null;
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
  return placesMemo('accountsNeedingYou', '', () => [...db.accounts.values()].filter((a) => a.attention && visibleAccount(a.id)), keep);
}

/** A triaged message you have not read: its conversation has unread messages, and you last read it before this one. */
function messageUnread(m: P.MessageView): boolean {
  const c = db.conversations.get(m.conversationId);
  return !!c && c.vantages.some((v) => (v.lastReadTs ?? 0) < m.ts) && unreadOf(c).unread > 0;
}

/** A mail message on How it sorts you have not read: as its thread says, if held, else as the hub said. */
function mailUnread(m: P.MailTriageItem): boolean {
  const t = db.mail.threads.get(m.threadId);
  return t ? t.unread > 0 && m.unread : m.unread;
}

/** A board card you have not read, chat or mail. */
export const boardUnread = (m: BoardItem) => (isMailItem(m) ? mailUnread(m) : messageUnread(m));

/** How it sorts' lists and counts (board.ts), for what is shown here: chat's messages and mail's. */
export function board(): Board {
  return memo('board', '', () =>
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

/** Alerts and Conversation messages of the last week you have not read yet: the inbox button's count. The list does not count. */
export function inboxBadge(): number {
  const b = board();
  return b.alertsUnread + b.conversationsUnread;
}

export function deepLink(c: P.ConversationView): string | null {
  const base = placeConv(c);
  if (c.network === 'discord') {
    const guild = communitiesOf(c)[0];
    return `https://discord.com/channels/${guild?.nativeId ?? '@me'}/${c.nativeId}`;
  }
  if (c.network === 'matrix') return `https://matrix.to/#/${encodeURIComponent(base.nativeId.split('|')[0])}`;
  if (c.network === 'zulip') return zulipLink(c);
  // A Partiful event's conversation is on its event's page (Luma's address is a slug the id does not give).
  if (c.network === 'partiful' && c.nativeId.startsWith('event:')) return `https://partiful.com/e/${encodeURIComponent(c.nativeId.slice(6))}`;
  return null;
}
