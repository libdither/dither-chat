/**
 * Polls and pins from the web (docs/polls.md): who may vote, make or end a poll here, and pinning a message from its
 * menu. Each is offered only where an account that sees the message says it can (protocol poll.ts capabilities).
 */
import type * as P from '@dither-chat/protocol';
import { PIN_DURATIONS, durationLabel } from '@dither-chat/protocol';
import { api, db, ownAccount, toast } from './state.ts';
import { heldRequest } from './requests.ts';

/** An open message request stays quiet: no vote, no poll, nothing that says it was seen (docs/add.md). */
const held = (conversationId: string) => !!heldRequest(db.requests, conversationId);

const onlineWith = (ids: string[], cap: P.Capability) => ids.map((id) => db.accounts.get(id)).find((a) => !!a && a.status === 'online' && a.capabilities.includes(cap)) ?? null;

/** An account that can vote in this poll, or null. */
export const voter = (m: P.MessageView) => (m.poll && !m.poll.ended && !m.deleted && !held(m.conversationId) ? onlineWith(m.seenVia, 'pollVote') : null);

/** You made this poll and its network ends polls early. */
export const canEndPoll = (m: P.MessageView) => !!m.poll && !m.poll.ended && !m.deleted && !!ownAccount(m)?.capabilities.includes('pollEnd');

/** An account that can make a poll in this conversation, or null. */
export function pollMaker(conversationId: string, accountId?: string): P.AccountView | null {
  const c = db.conversations.get(conversationId);
  if (!c || held(conversationId)) return null;
  const ids = c.vantages.map((v) => v.accountId);
  return (accountId && onlineWith([accountId], 'pollCreate')) || onlineWith(ids, 'pollCreate');
}

export async function vote(m: P.MessageView, options: string[]): Promise<boolean> {
  try {
    await api(`/api/messages/${m.id}/vote`, { body: { options } });
    return true;
  } catch (e) {
    toast({ kind: 'error', title: options.length ? 'Could not vote' : 'Could not take your vote back', body: (e as Error).message });
    return false;
  }
}

export async function endPoll(m: P.MessageView): Promise<void> {
  try {
    await api(`/api/messages/${m.id}/end-poll`, { body: {} });
    toast({ kind: 'info', title: 'Poll ended', body: '' }, 2500);
  } catch (e) {
    toast({ kind: 'error', title: 'Could not end the poll', body: (e as Error).message });
  }
}

export async function makePoll(conversationId: string, draft: P.PollDraft, accountId?: string): Promise<boolean> {
  try {
    await api(`/api/conversations/${conversationId}/polls`, { body: { ...draft, ...(accountId ? { accountId } : {}) } });
    return true;
  } catch (e) {
    toast({ kind: 'error', title: 'Could not make the poll', body: (e as Error).message });
    return false;
  }
}

/** Pin or unpin from a message's menu: where an account that sees it pins (capability 'pin'). */
export const pinnable = (m: P.MessageView) => !m.deleted && m.kind !== 'system' && !!onlineWith(m.seenVia, 'pin');

/** The durations a pin may last on this network (Signal), with their words; [] where pins have no timer. */
export const pinChoices = (network: P.Network) => (PIN_DURATIONS[network] ?? []).map((s) => ({ seconds: s, label: s === null ? 'Until unpinned' : durationLabel(s) }));

export async function pin(m: P.MessageView, remove: boolean, seconds?: number | null): Promise<void> {
  const accountId = onlineWith(m.seenVia, 'pin')?.id;
  try {
    await api(`/api/conversations/${m.conversationId}/about`, { body: { change: { key: 'pin', message: m.nativeId, ...(remove ? { remove: true } : {}), ...(seconds !== undefined && !remove ? { seconds } : {}) }, ...(accountId ? { accountId } : {}) } });
    toast({ kind: 'info', title: remove ? 'Unpinned' : 'Pinned', body: '' }, 2500);
  } catch (e) {
    toast({ kind: 'error', title: remove ? 'Could not unpin it' : 'Could not pin it', body: (e as Error).message });
  }
}
