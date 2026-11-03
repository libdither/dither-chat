/**
 * Reacting, as the client sees it. The picker, the pills and the long-press sheet all go
 * through here, so a reaction shows at once and is taken back with a toast if the network refuses.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { canonicalReactionKey, REACTION_RULES } from '@dither-chat/protocol';
import { api, db, isSelfIdentity, patchMessage, prefs, rev, toast } from './state.ts';

export interface Picked {
  key: string;
  emoji?: P.CustomEmojiView;
}

/** The floating UI: one of each, mounted once, so a timeline's scroll box can never clip it. */
export const pickerFor = signal<{ message: P.MessageView; anchor: DOMRect | null } | null>(null);
export const reactorsFor = signal<{ message: P.MessageView; key: string; style: P.ReactionStyle; anchor: DOMRect } | null>(null);

const FALLBACK_QUICK = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

/** Your most-used emoji on this network, then on any network. Custom emoji only appear in the picker, where we know they still work. */
export function quickReactions(network: P.Network, n = 6): string[] {
  const usage = db.reactionUsage.filter((u) => !u.emoji && !/^mxc:|^\S+:\d+$/.test(u.key));
  const here = usage.filter((u) => u.network === network).map((u) => u.key);
  const anywhere = usage.map((u) => u.key);
  return [...new Set([...here, ...anywhere, ...FALLBACK_QUICK])].slice(0, n);
}

/** The account that acts in a conversation: the one you chose to send as, else any connected one. */
function actingAccount(conversationId: string): P.AccountView | null {
  const c = db.conversations.get(conversationId);
  if (!c) return null;
  const accounts = c.vantages.map((v) => db.accounts.get(v.accountId)).filter((a): a is P.AccountView => !!a);
  return accounts.find((a) => a.id === prefs.value.sendAs[c.id]) ?? accounts.find((a) => a.status === 'online') ?? accounts[0] ?? null;
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
  const entry: { at: number; value: Promise<P.ReactionContextView>; known?: P.ReactionContextView } = { at: Date.now(), value };
  contexts.set(cacheKey, entry);
  value.then((v) => {
    entry.known = v;
    rev.value++;
  });
  return value;
}

/** What the row over a message may offer: everything, only reactions already there, or nothing. Until we know, assume everything. */
export function reactionScope(conversationId: string): 'all' | 'existing' | 'none' {
  const ctx = contexts.get(`${conversationId}|${actingAccount(conversationId)?.id ?? ''}`)?.known;
  if (!ctx) return 'all';
  return !ctx.canReact ? 'none' : ctx.existingOnly ? 'existing' : 'all';
}

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

/** "You, Alice and 3 others" */
export function reactorsLabel(r: P.ReactionView, nameOf: (id: string) => string): string {
  const mine = hasMine(r);
  const others = r.identityIds.filter((i) => !isSelfIdentity(i));
  const names = [...(mine ? ['You'] : []), ...others.slice(0, 3).map(nameOf)];
  const rest = r.count - names.length;
  if (!names.length) return rest === 1 ? '1 person' : `${rest} people`;
  if (rest > 0) return `${names.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}
