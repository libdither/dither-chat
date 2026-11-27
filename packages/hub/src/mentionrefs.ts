/**
 * Person and identity references in what you send (docs/mentions.md, "References"): `<@person:per_…>` and
 * `<@identity:idn_…>`, which the @ picker puts in for people from other networks and in Calendar chats. No network
 * knows them, so the hub lowers them on every send, edit and forward, unless the account sending has capability
 * 'personRefs' (the calendar names them itself):
 *  - an account on the chat's network becomes that network's own mention, `<@nativeId>`, which pings them;
 *  - anything else becomes plain `@Name`, which pings nobody. The owner's decision (2026-11-13): a friend who is not
 *    on the chat's network gets the text and nothing else, never a DM or any other notification.
 * An id the hub does not know becomes `@someone`: the raw id never goes out. References inside code stay as written.
 *
 * On a network that has no mentions of its own (not in MENTION_NETWORKS: Messenger, Instagram, Partiful, Luma…) its
 * own `<@nativeId>` would go out as written too, so there every mention is a plain name.
 */
import type * as P from '@dither-chat/protocol';
import { sendsMentions } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { Store } from './store.ts';

/** What a reference becomes: the network's mention of this account, or a name written out. Null: nobody the hub knows. */
export type RefTarget = { nativeId: string } | { name: string } | null;
export type RefResolve = (kind: 'person' | 'identity', id: string) => RefTarget;

const REF = /<@(person|identity):((?:per|idn)_[\w-]{1,64})>/g;
/** Code keeps what it says: fenced blocks and inline spans, as markdown.ts reads them. */
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;

/** Holds a reference, so a body without one is passed on untouched. */
const hasRefs = (body: string) => body.includes('<@person:') || body.includes('<@identity:');

/**
 * A name as plain text that pings nobody and makes no token: every `<` and `@` in it is followed by a zero-width
 * space, so it cannot make `<@id>`, `<#id>`, `<:emoji:id>` or `@everyone`, and nor can the @ in front of it
 * (@everyone, @here, @room, @channel, @all).
 */
export function plainMention(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim() || 'someone';
  const safe = n.replace(/</g, '<​').replace(/@/g, '@​');
  return '@' + (/^(everyone|here|room|channel|all)\b/i.test(safe) ? '​' : '') + safe;
}

function lowerText(text: string, resolve: RefResolve): string {
  return text.replace(REF, (_, kind: 'person' | 'identity', id: string) => {
    const t = resolve(kind, id);
    return t && 'nativeId' in t ? `<@${t.nativeId}>` : plainMention(t?.name ?? 'someone');
  });
}

/** `f` on each part of the body outside code. */
function outsideCode(body: string, f: (text: string) => string): string {
  let out = '';
  let at = 0;
  for (const m of body.matchAll(CODE)) {
    out += f(body.slice(at, m.index)) + m[0];
    at = m.index! + m[0].length;
  }
  return out + f(body.slice(at));
}

/** The body with every reference outside code lowered as `resolve` says. Pure. */
export function lowerRefs(body: string, resolve: RefResolve): string {
  if (!hasRefs(body)) return body;
  return outsideCode(body, (t) => lowerText(t, resolve));
}

/** A network's own mentions outside code, `<@nativeId>`, as plain names, for a network that has none. Pure. */
export function plainNative(body: string, name: (nativeId: string) => string | null): string {
  if (!body.includes('<@')) return body;
  return outsideCode(body, (t) => t.replace(/<@!?([^>\s]+)>/g, (_, id: string) => plainMention(name(id) ?? 'someone')));
}

type Row = Record<string, any>;

/**
 * What references become in a conversation, from the store. An account on the conversation's network is mentioned;
 * for a person with several there, the one in the conversation, else the one who wrote there last, else the newest.
 * Names: an account's own (its display name, then handle), else its person's; a person's name.
 */
export function storeResolve(store: Store, conversationId: string): RefResolve {
  const at = store.one<{ network: P.Network }>('SELECT network FROM conversation WHERE id = ?', conversationId)?.network;
  // A network without mentions of its own mentions nobody: each is a name.
  const network = sendsMentions(at) ? at : undefined;
  return (kind, id) => {
    if (kind === 'identity') {
      const i = store.one<Row>('SELECT i.network, i.native_id, i.display_name, i.handle, p.name AS person FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.id = ?', id);
      if (!i) return null;
      if (network && i.network === network) return { nativeId: i.native_id };
      return { name: i.display_name || i.handle || i.person || 'someone' };
    }
    const p = store.one<Row>('SELECT name FROM person WHERE id = ?', id);
    if (!p) return null;
    const here = network ? (store.raw<Row>('SELECT id, native_id, updated_at FROM identity WHERE person_id = ? AND network = ?', id, network) as Row[]) : [];
    if (here.length > 1) {
      const rank = (i: Row) => {
        if (store.one('SELECT 1 FROM participant WHERE conversation_id = ? AND identity_id = ?', conversationId, i.id)) return Number.MAX_SAFE_INTEGER;
        return store.one<{ ts: number }>('SELECT ts FROM message WHERE author_id = ? AND conversation_id = ? ORDER BY ts DESC LIMIT 1', i.id, conversationId)?.ts ?? 0;
      };
      here.sort((a, b) => rank(b) - rank(a) || b.updated_at - a.updated_at);
    }
    return here.length ? { nativeId: here[0].native_id } : { name: p.name };
  };
}

/** The body as it goes out from this account into this conversation: references lowered unless it takes them ('personRefs'). */
export function lowerForSend(store: Store, conversationId: string, caps: readonly P.Capability[], body: string): string {
  if (caps.includes('personRefs') || !body.includes('<@')) return body;
  const out = lowerRefs(body, storeResolve(store, conversationId));
  const network = store.one<{ network: P.Network }>('SELECT network FROM conversation WHERE id = ?', conversationId)?.network;
  if (!network || sendsMentions(network)) return out;
  return plainNative(out, (nativeId) => {
    const i = store.one<Row>('SELECT i.display_name, i.handle, p.name AS person FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.id = ?', hubId('idn', network, nativeId));
    return i ? i.display_name || i.handle || i.person || null : null;
  });
}

/** Mentions as plain names, so a re-sent message pings nobody; channel and emoji tokens as text another network can show. */
export function plainTokens(body: string, name: (kind: 'user' | 'room', nativeId: string) => string | null): string {
  return body
    .replace(/<@&\d+>/g, '@role')
    .replace(/<@!?([^>\s]+)>/g, (_, id) => '@' + (name('user', id) ?? 'someone'))
    .replace(/<#([^>\s]+)>/g, (_, id) => '#' + (name('room', id) ?? 'channel'))
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/@(everyone|here)\b/g, '@​$1');
}

/** A body's mentions and channels as the names the hub knows, references (a Calendar chat's) included: what a forward or a notification shows. */
export function namedTokens(store: Store, network: P.Network, body: string): string {
  const names = (kind: 'user' | 'room', id: string) =>
    kind === 'user' ? store.identityLabel(hubId('idn', network, id)) : store.conversationView(hubId('cnv', network, id))?.name ?? null;
  return plainTokens(lowerRefs(body, storeResolve(store, '')), names);
}
