/**
 * Voting on triage's decisions (docs/notifications.md): Important, Active, Digest or below it, up or down a level from
 * where a message is now. The hub's decision model learns from the votes; this keeps what it says it learned.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { TIER_LABEL } from '@dither-chat/protocol';
import { api, inbox, patchMessage, toast } from './state.ts';

export const TIERS: P.NotifyTier[] = ['drop', 'digest', 'quiet', 'push'];
export { TIER_LABEL };
export const isTier = (d: P.TriageDecision | null | undefined): d is P.NotifyTier => TIERS.includes(d as P.NotifyTier);

/** Where a message is now: your vote, else the decision. */
export const levelOf = (t: P.TriageView): P.TriageDecision => t.feedback ?? t.decision;
export const tierUp = (l: P.NotifyTier): P.NotifyTier | null => TIERS[TIERS.indexOf(l) + 1] ?? null;
export const tierDown = (l: P.NotifyTier): P.NotifyTier | null => TIERS[TIERS.indexOf(l) - 1] ?? null;

/** What the hub learned, as of the last vote or look. */
export const triagePolicy = signal<P.TriagePolicyView | null>(null);

function setFeedback(id: string, feedback: P.NotifyTier | null) {
  const patch = (m: P.MessageView): P.MessageView => (m.triage ? { ...m, triage: { ...m.triage, feedback } } : m);
  inbox.value = inbox.value.map((m) => (m.id === id ? patch(m) : m));
  patchMessage(id, patch);
}

/**
 * Up or down a level, or straight to one; the same level again takes the vote back. Shown at once; a refusal puts it
 * back. Up on Important or down below the digest says it was right.
 */
export async function vote(m: P.MessageView, v: 'up' | 'down' | P.NotifyTier | null) {
  const t = m.triage;
  if (!t || !isTier(t.decision)) return;
  const now = levelOf(t) as P.NotifyTier;
  const target = v === 'up' ? (tierUp(now) ?? now) : v === 'down' ? (tierDown(now) ?? now) : v;
  const before = t.feedback;
  setFeedback(m.id, target);
  try {
    const r = await api<{ feedback: P.NotifyTier | null; policy: P.TriagePolicyView }>(`/api/messages/${m.id}/feedback`, { body: { feedback: target } });
    if (r?.policy) triagePolicy.value = r.policy;
  } catch (e: any) {
    setFeedback(m.id, before);
    toast({ kind: 'error', title: 'Could not vote', body: e.message });
  }
}

export async function loadPolicy() {
  try {
    triagePolicy.value = await api<P.TriagePolicyView>('/api/triage/policy');
  } catch {}
}

/** Forget something it learned, for good; or let it be learned again. */
export async function forgetFactor(key: string, rejected: boolean) {
  triagePolicy.value = await api<P.TriagePolicyView>(`/api/triage/factors/${encodeURIComponent(key)}`, { body: { rejected } });
}

export async function relearn() {
  triagePolicy.value = await api<P.TriagePolicyView>('/api/triage/policy/relearn', { body: {} });
}
