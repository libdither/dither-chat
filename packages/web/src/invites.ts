/**
 * Invite links in a message (docs/add.md, "Invites in messages"): which links in a body get a card, and what kind of
 * link each is before anything is looked up. No browser needed, so it can be tested alone.
 */
import type * as P from '@dither-chat/protocol';
import { addRefKey, NETWORK_META, parseAdd } from '@dither-chat/protocol';

export interface FoundInvite {
  /** The link, with https:// when it was written without. */
  url: string;
  ref: P.AddRef;
  /** addRefKey: one card per thing, however often it is linked. */
  key: string;
}

/** Cards under one message, at most. */
export const MAX_INVITE_CARDS = 3;

/** Hosts whose links may be invites, also written without https:// (t.me/+…, discord.gg/…), as Telegram links them. */
const BARE_HOSTS = String.raw`(?:discord\.gg|(?:ptb\.|canary\.)?discord(?:app)?\.com\/invite|chat\.whatsapp\.com|t\.me|telegram\.me|telegram\.dog|signal\.group|matrix\.to)`;
/** A link to one of those hosts without its scheme, not inside a longer word or address. */
export const BARE_INVITE = new RegExp(String.raw`(?<![\w./@:-])${BARE_HOSTS}\/[^\s<>()]*[^\s<>().,;:!?'"]`, 'gi');
const LINKS = new RegExp(String.raw`\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|${BARE_INVITE.source}`, 'gi');
const MAYBE = /discord|whatsapp|t\.me|telegram|signal\.group|matrix\.to/i;

/**
 * The reading a link in a message gets a card for: an invite (Discord, WhatsApp, Telegram, Signal), a Matrix room by
 * matrix.to link, or a Telegram public name (t.me/name). Not a link to a message in a room or channel.
 */
export function inviteRef(link: string): P.AddRef | null {
  const r = parseAdd(link)[0];
  if (!r) return null;
  if (r.kind === 'invite') return r;
  let u: URL;
  try {
    u = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link) ? link : `https://${link}`);
  } catch {
    return null;
  }
  // matrix.to/#/#room:server, not matrix.to/#/#room:server/$event
  if (r.kind === 'place') return u.hash.slice(2).split('?')[0].split('/').length === 1 ? r : null;
  if (r.kind === 'name' && r.network === 'telegram') {
    const seg = u.pathname.split('/').filter(Boolean);
    return seg.length === 1 || (seg.length === 2 && seg[0] === 's') ? r : null;
  }
  return null;
}

/** The invite links in a message's text, once each, in order; none inside code. */
export function findInvites(body: string): FoundInvite[] {
  if (!body || !MAYBE.test(body)) return [];
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  const out: FoundInvite[] = [];
  for (const m of text.matchAll(LINKS)) {
    const ref = inviteRef(m[0]);
    if (!ref) continue;
    const key = addRefKey(ref);
    if (out.some((f) => f.key === key)) continue;
    out.push({ url: /^https?:\/\//i.test(m[0]) ? m[0] : `https://${m[0]}`, ref, key });
    if (out.length === MAX_INVITE_CARDS) break;
  }
  return out;
}

/** What kind of link it is, before anything is looked up: "Discord server invite", "Matrix room". */
export function inviteKind(ref: P.AddRef): string {
  const net = NETWORK_META[ref.network].name;
  if (ref.kind === 'place') return `${net} room`;
  if (ref.kind === 'name') return `${net} channel, group or person`;
  if (ref.kind !== 'invite') return `${net} link`;
  if (ref.network === 'discord') return 'Discord server invite';
  if (ref.network === 'signal') return 'Signal group link';
  return `${net} group invite`;
}

/** The link as a reader knows it: no scheme, and long codes cut short. */
export function shortLink(url: string): string {
  const s = url.replace(/^https?:\/\/(www\.)?/i, '');
  return s.length > 44 ? `${s.slice(0, 43)}…` : s;
}
