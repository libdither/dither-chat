/**
 * Reacting, as the client sees it. The picker, the pills and the long-press sheet all go
 * through here, so a reaction shows at once and is taken back with a toast if the network refuses.
 */
import { computed, signal, type ReadonlySignal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { canonicalReactionKey, NETWORK_META, REACTION_RULES } from '@dither-chat/protocol';
import { fullTime, stamp } from './format.ts';
import { api, changed, db, isSelfIdentity, patchMessage, pref, toast } from './state.ts';
import { metaRev } from './versions.ts';

export interface Picked {
  key: string;
  emoji?: P.CustomEmojiView;
}

/** The floating UI: one of each, mounted once, so a timeline's scroll box can never clip it. */
export const pickerFor = signal<{ message: P.MessageView; anchor: DOMRect | null } | null>(null);
export const reactorsFor = signal<{ message: P.MessageView; key: string; style: P.ReactionStyle; anchor: DOMRect } | null>(null);

const FALLBACK_QUICK = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

/** Moves when a reaction made here reorders `db.reactionUsage` (bumpUsage). */
const usageRev = signal(0);
/**
 * The quick reactions, by network, as one string: what draws them (a bar over every message) redraws when they change,
 * not with every row and message on each reaction, as `changed('shown')` did. The hub's copy comes with the bootstrap or
 * a sync, which move `metaRev`.
 */
const QUICK_MAX = 6;
const quickBy = new Map<P.Network, ReadonlySignal<string>>();

/** Your most-used emoji on this network, then on any network. Custom emoji only appear in the picker, where we know they still work. */
export function quickReactions(network: P.Network, n = QUICK_MAX): string[] {
  let s = quickBy.get(network);
  if (!s)
    quickBy.set(
      network,
      (s = computed(() => {
        usageRev.value;
        metaRev.value;
        const usage = db.reactionUsage.filter((u) => !u.emoji && !/^mxc:|^\S+:\d+$/.test(u.key));
        const here = usage.filter((u) => u.network === network).map((u) => u.key);
        const anywhere = usage.map((u) => u.key);
        return [...new Set([...here, ...anywhere, ...FALLBACK_QUICK])].slice(0, QUICK_MAX).join('\n');
      })),
    );
  return s.value.split('\n').slice(0, n);
}

/** The account that acts in a conversation: the one you chose to send as, else any connected one. */
function actingAccount(conversationId: string): P.AccountView | null {
  const c = db.conversations.get(conversationId);
  if (!c) return null;
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a);
  return accounts.find((a) => a.id === pref('sendAs')[c.id]) ?? accounts.find((a) => a.status === 'online') ?? accounts[0] ?? null;
}

// ------------------------------------------------------------------ context

const contexts = new Map<string, { at: number; value: Promise<P.ReactionContextView>; known?: P.ReactionContextView }>();
const CONTEXT_TTL = 120_000;

/** What can be reacted with here, right now. Cached briefly: a picker opens many times per conversation. */
export function reactionContext(conversationId: string): Promise<P.ReactionContextView> {
  const account = actingAccount(conversationId);
  const cacheKey = `${conversationId}|${account?.id ?? ''}`;
  const hit = contexts.get(cacheKey);
  if (hit && Date.now() - hit.at < CONTEXT_TTL) return hit.value;
  // Not knowing is no reason to stop someone: the network still has the last word.
  const value = api<P.ReactionContextView>(`/api/conversations/${conversationId}/reaction-context${account ? `?account=${account.id}` : ''}`).catch((): P.ReactionContextView => ({ accountId: account?.id ?? null, canReact: true, custom: [] }));
  // What was known goes on meaning the same until the answer comes.
  const entry: { at: number; value: Promise<P.ReactionContextView>; known?: P.ReactionContextView } = { at: Date.now(), value, known: hit?.known };
  contexts.set(cacheKey, entry);
  const drawn = scopeOf(hit?.known);
  value.then((v) => {
    entry.known = v;
    // The messages redraw only when what their reaction row offers changes (reactionScope); the picker asks for
    // the context itself. So a conversation already in memory is not drawn twice as it opens.
    if (scopeOf(v) !== drawn) changed('shown');
  });
  return value;
}

/** The context if it is already known: a picker that has it draws its custom emoji in its first frame. */
export function knownReactionContext(conversationId: string): P.ReactionContextView | null {
  return contexts.get(`${conversationId}|${actingAccount(conversationId)?.id ?? ''}`)?.known ?? null;
}

/** What the row over a message may offer: everything, only reactions already there, or nothing. Until we know, assume everything. */
export function reactionScope(conversationId: string): 'all' | 'existing' | 'none' {
  return scopeOf(knownReactionContext(conversationId));
}
const scopeOf = (ctx: P.ReactionContextView | null | undefined): 'all' | 'existing' | 'none' => (!ctx ? 'all' : !ctx.canReact ? 'none' : ctx.existingOnly ? 'existing' : 'all');

// ------------------------------------------------------------------ the local copy

function applyLocally(m: P.MessageView, picked: Picked, style: P.ReactionStyle, remove: boolean, self: string | null): P.ReactionView[] {
  const key = canonicalReactionKey(picked.key);
  let next = m.reactions.map((r) => ({ ...r, identityIds: [...r.identityIds] }));
  const leave = (r: P.ReactionView) => {
    const before = r.identityIds.length;
    r.identityIds = r.identityIds.filter((i) => !isSelfIdentity(i));
    r.count = Math.max(0, r.count - (before - r.identityIds.length));
  };
  if (remove) {
    const r = next.find((x) => x.key === key && x.style === style);
    if (r) leave(r);
  } else {
    if (REACTION_RULES[m.network].exclusive) next.forEach(leave);
    let r = next.find((x) => x.key === key && x.style === style);
    if (!r) {
      r = { key, style, count: 0, identityIds: [], ...(picked.emoji ? { emoji: picked.emoji } : {}) };
      next.push(r);
    }
    if (self && !r.identityIds.includes(self)) {
      r.identityIds.push(self);
      r.count++;
    }
  }
  next = next.filter((r) => r.count > 0);
  return next;
}

function bumpUsage(network: P.Network, picked: Picked) {
  const key = canonicalReactionKey(picked.key);
  const u = db.reactionUsage.find((x) => x.key === key && x.network === network);
  if (u) u.count++;
  else db.reactionUsage.push({ key, network, count: 1, ...(picked.emoji ? { emoji: picked.emoji } : {}) });
  db.reactionUsage.sort((a, b) => b.count - a.count);
  // The quick reactions over every message come from this.
  usageRev.value++;
}

// ------------------------------------------------------------------ acting

/** Add the reaction, or take it back if it is already yours. */
export async function toggleReaction(m: P.MessageView, picked: Picked, style: P.ReactionStyle = 'normal') {
  const key = canonicalReactionKey(picked.key);
  const mine = m.reactions.find((r) => r.key === key && r.style === style)?.identityIds.some(isSelfIdentity) ?? false;
  // A super reaction you cannot make yourself still counts as agreeing: add a normal one, if you have not already.
  if (style === 'super' && !mine) {
    const ctx = await reactionContext(m.conversationId);
    if (!ctx.super?.available) {
      if (!m.reactions.find((r) => r.key === key && r.style === 'normal')?.identityIds.some(isSelfIdentity)) return toggleReaction(m, picked, 'normal');
      return toast({ kind: 'info', title: 'Already reacted', body: ctx.super?.reason ?? 'Super reactions are not available here.' });
    }
  }
  const account = actingAccount(m.conversationId);
  const self = account?.selfIdentityId ?? null;
  const previous = m.reactions;
  patchMessage(m.id, (x) => ({ ...x, reactions: applyLocally(x, picked, style, mine, self) }));
  if (!mine) bumpUsage(m.network, picked);
  try {
    await api(`/api/messages/${m.id}/react`, { body: { key, style, remove: mine, accountId: account?.id } });
  } catch (e: any) {
    patchMessage(m.id, (x) => ({ ...x, reactions: previous }));
    toast({ kind: 'error', title: mine ? 'Could not remove the reaction' : 'Could not react', body: e.message });
  }
}

export const hasMine = (r: P.ReactionView) => r.identityIds.some(isSelfIdentity);

/** On a network that keeps one reaction per person (Signal, WhatsApp), yours that a new one would replace. */
export function replacing(m: P.MessageView): P.ReactionView | undefined {
  return REACTION_RULES[m.network].exclusive ? m.reactions.find(hasMine) : undefined;
}

// ------------------------------------------------------------------ when (docs/reactions.md "When")

/** A reaction's time as far as is known: the network's own, or (`seen`) when the hub first heard of it. */
interface ReactedAt {
  at: number;
  seen: boolean;
}

export function reactedAt(r: { at?: Record<string, number>; seenAt?: Record<string, number> }, id: string): ReactedAt | null {
  const at = r.at?.[id];
  if (at != null) return { at, seen: false };
  const seen = r.seenAt?.[id];
  return seen != null ? { at: seen, seen: true } : null;
}

/** "3:41 PM"; "~3:41 PM" where it is only when the hub heard (the network did not say). */
export const whenText = (w: ReactedAt, now = Date.now()) => `${w.seen ? '~' : ''}${stamp(w.at, now)}`;

/** The same in full, for a title; one with "~" says what it is. */
export const whenTitle = (w: ReactedAt) => (w.seen ? `About ${fullTime(w.at)}, when the hub heard of it` : fullTime(w.at));

const TIP_NAMES = 8;

/**
 * A pill's tooltip: who reacted in a line ("You, Alice and 3 others"), then, where any time is known, when: just the
 * time for one person, else a line each, earliest first ("Alice · 3:41 PM", "Bob · ~3:45 PM"), at most eight, then
 * how many more.
 */
export function reactionTip(r: P.ReactionView, nameOf: (id: string) => string, now = Date.now()): { text: string; lines: string[] } {
  const text = reactorsLabel(r, nameOf);
  const timed = r.identityIds.map((id) => ({ id, when: reactedAt(r, id) }));
  if (!timed.some((t) => t.when)) return { text, lines: [] };
  // Those with no time were there before the hub saw the message, so they come first.
  timed.sort((a, b) => (a.when?.at ?? -Infinity) - (b.when?.at ?? -Infinity));
  const shown = timed.slice(0, TIP_NAMES);
  if (r.count === 1) return { text, lines: [whenText(timed[0].when!, now)] };
  const lines = shown.map(({ id, when }) => `${isSelfIdentity(id) ? 'You' : nameOf(id)}${when ? ` · ${whenText(when, now)}` : ''}`);
  const rest = r.count - shown.length;
  if (rest > 0) lines.push(`and ${rest} ${rest === 1 ? 'other' : 'others'}`);
  return { text, lines };
}

/** "You, Alice and 3 others" */
function reactorsLabel(r: P.ReactionView, nameOf: (id: string) => string): string {
  const mine = hasMine(r);
  const others = r.identityIds.filter((i) => !isSelfIdentity(i));
  const names = [...(mine ? ['You'] : []), ...others.slice(0, 3).map(nameOf)];
  const rest = r.count - names.length;
  if (!names.length) return rest === 1 ? '1 person' : `${rest} people`;
  if (rest > 0) return `${names.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}

/** How a reaction reads in a sentence: its emoji, or a custom one by its name. */
export const keyText = (r: { key: string; emoji?: P.CustomEmojiView }) => (r.emoji ? `:${r.emoji.name}:` : r.key);

/**
 * The add button's face. Where a network keeps one reaction per person (Signal, WhatsApp) and you already have one,
 * a pick replaces it rather than adding another, and the button says so: arrows where the plus was.
 */
export function addLook(m: P.MessageView): { icon: string; title: string } {
  const r = replacing(m);
  return r ? { icon: 'smileSwap', title: `Change your reaction (${keyText(r)}): ${NETWORK_META[m.network].name} keeps one per person` } : { icon: 'smilePlus', title: 'Add reaction' };
}
