/**
 * Voting on triage's decisions (docs/notifications.md): Important, Active, Digest or below it, up or down a level from
 * where a message is now. The hub's decision model learns from the votes; this keeps what it says it learned.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { TIER_LABEL } from '@dither-chat/protocol';
import { levelOf } from './board.ts';
import { api, inbox, mailTriage, patchMessage, toast } from './state.ts';
import { details } from './mail/held.ts';
import { changed, mailChanged } from './versions.ts';

export { levelOf };

export const TIERS: P.NotifyTier[] = ['drop', 'digest', 'quiet', 'push'];
export { TIER_LABEL };
export const isTier = (d: P.TriageDecision | null | undefined): d is P.NotifyTier => TIERS.includes(d as P.NotifyTier);

export const tierUp = (l: P.NotifyTier): P.NotifyTier | null => TIERS[TIERS.indexOf(l) + 1] ?? null;
export const tierDown = (l: P.NotifyTier): P.NotifyTier | null => TIERS[TIERS.indexOf(l) - 1] ?? null;

/** What the hub learned, as of the last vote or look. */
export const triagePolicy = signal<P.TriagePolicyView | null>(null);

/** Where each chance decides, until the hub's policy is in (the hub's defaults, docs/notifications.md). */
export const DEFAULT_THRESHOLDS: P.TriageProbs = { ping: 0.8, active: 0.5, interesting: 0.5 };
/** The hub's thresholds for the three chances. */
export const thresholds = (): P.TriageProbs => triagePolicy.value?.thresholds ?? DEFAULT_THRESHOLDS;
/** The level each chance stands for, in the board's words. */
export const HEAD_LABEL: Record<P.TriageHead, string> = { ping: 'Important', active: 'Active', interesting: 'Digest' };

/** What can be voted on: a chat message, or a mail message (its id `mml_`, the board's mail rows, the reader's). */
export interface Votable {
  id: string;
  triage?: P.TriageView | null;
}

function setFeedback(id: string, feedback: P.NotifyTier | null) {
  if (id.startsWith('mml_')) {
    mailTriage.value = mailTriage.value.map((m) => (m.id === id ? { ...m, triage: { ...m.triage, feedback } } : m));
    // The reader's copy of the message too.
    for (const d of details.values()) {
      const i = d.messages.findIndex((m) => m.id === id);
      if (i >= 0 && d.messages[i].triage) d.messages[i] = { ...d.messages[i], triage: { ...d.messages[i].triage!, feedback } };
    }
    changed('list');
    mailChanged();
    return;
  }
  const patch = (m: P.MessageView): P.MessageView => (m.triage ? { ...m, triage: { ...m.triage, feedback } } : m);
  inbox.value = inbox.value.map((m) => (m.id === id ? patch(m) : m));
  patchMessage(id, patch);
}

/**
 * Up or down a level, or straight to one; the same level again takes the vote back. Shown at once; a refusal puts it
 * back. Up on Important or down below the digest says it was right. Mail goes the same way (the hub tells its ids).
 */
export async function vote(m: Votable, v: 'up' | 'down' | P.NotifyTier | null) {
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

/** What the candidate model, running in shadow, would have done lately. */
export const triageShadow = signal<P.TriageShadowView | null>(null);

export async function loadShadow() {
  try {
    triageShadow.value = await api<P.TriageShadowView>('/api/triage/shadow');
  } catch {}
}

export async function relearn() {
  triagePolicy.value = await api<P.TriagePolicyView>('/api/triage/policy/relearn', { body: {} });
}
