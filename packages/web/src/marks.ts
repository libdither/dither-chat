/**
 * Your marks on triage's decisions (docs/notifications.md): "Should have alerted" (on an alert it reads "Alert was
 * wrong") and "Less like this". Two toggles; a mark teaches the next decision and does not move this one. Pure:
 * triage.ts hands `sendMark` the hub and the page's state.
 */
import type * as P from '@dither-chat/protocol';

export const TIERS: P.NotifyTier[] = ['drop', 'digest', 'quiet', 'push'];
/** A decision that can be marked: any tier, never a silenced place. */
export const isTier = (d: P.TriageDecision | null | undefined): d is P.NotifyTier => TIERS.includes(d as P.NotifyTier);

/** What can be marked: a chat message, or a mail message (its id `mml_`, How it sorts' mail lines, the reader's). */
export interface Markable {
  id: string;
  triage?: P.TriageView | null;
}

/** Mail has no alert marks: only "Less like this" (docs/mail.md). */
export const isMailId = (id: string) => id.startsWith('mml_');

export const LESS_LABEL = 'Less like this';

/**
 * The alert toggle on a decision: what it says, whether it is ticked, and what a click sends. On an alert it is
 * "Alert was wrong" (ticked when you said so); anywhere else "Should have alerted". A click on a ticked one takes the
 * mark back.
 */
export function alertToggle(t: Pick<P.TriageView, 'decision' | 'marks'>): { label: string; on: boolean; send: boolean | null } {
  const alerted = t.decision === 'push';
  const on = alerted ? t.marks?.alert === false : t.marks?.alert === true;
  return { label: alerted ? 'Alert was wrong' : 'Should have alerted', on, send: on ? null : !alerted };
}

/** The "Less like this" toggle: ticked, and what a click sends. */
export function lessToggle(t: Pick<P.TriageView, 'marks'>): { label: string; on: boolean; send: boolean } {
  const on = !!t.marks?.less;
  return { label: LESS_LABEL, on, send: !on };
}

/** Marks with one changed: each given key is set, and null (or `less: false`) takes that mark back. */
export function withMarks(now: P.TriageMarks | null | undefined, change: P.TriageMarks): P.TriageMarks {
  const out: P.TriageMarks = {};
  const alert = change.alert !== undefined ? change.alert : now?.alert;
  const less = change.less !== undefined ? change.less : now?.less;
  if (typeof alert === 'boolean') out.alert = alert;
  if (less) out.less = true;
  return out;
}

/** What the hub answers a mark with. */
export interface MarkAnswer {
  marks?: P.TriageMarks;
  policy?: P.TriagePolicyView;
}

export interface MarkDeps {
  post: (path: string, body: P.TriageMarks) => Promise<MarkAnswer | null | undefined>;
  /** Put these marks on every copy of the message the page holds. */
  apply: (id: string, marks: P.TriageMarks) => void;
  /** What the hub learned from it. */
  learned: (policy: P.TriagePolicyView) => void;
  failed: (e: Error) => void;
}

/**
 * Marks a decision, or takes a mark back: `{ alert: true | false | null }` or `{ less: true | false }`. Shown at once;
 * the marks in the hub's answer are what stays, and a refusal puts the old ones back. Mail takes only `less`, on its
 * own route.
 */
export async function sendMark(m: Markable, change: P.TriageMarks, d: MarkDeps): Promise<void> {
  const t = m.triage;
  if (!t || !isTier(t.decision)) return;
  const mail = isMailId(m.id);
  if (mail && change.less === undefined) return;
  const before = withMarks(t.marks, {});
  d.apply(m.id, withMarks(before, change));
  try {
    const r = mail ? await d.post(`/api/mail/triage/${m.id}/vote`, { less: !!change.less }) : await d.post(`/api/messages/${m.id}/feedback`, change);
    if (r?.marks) d.apply(m.id, withMarks(r.marks, {}));
    if (r?.policy) d.learned(r.policy);
  } catch (e) {
    d.apply(m.id, before);
    d.failed(e as Error);
  }
}

/** A vote from before the tiers, by the level's old name: shown as history only. */
export const OLD_LEVEL: Record<P.NotifyTier, string> = { push: 'Important', quiet: 'Active', digest: 'Digest', drop: 'Not interesting' };

/**
 * "Voted Active before the tiers", or null with no such vote. Mail keeps "Less like this" in the same field as an old
 * vote down, so there a ticked "Less like this" is not said twice.
 */
export function oldVote(t: Pick<P.TriageView, 'feedback' | 'marks'>): string | null {
  if (!t.feedback || (t.feedback === 'drop' && t.marks?.less)) return null;
  return `Voted ${OLD_LEVEL[t.feedback]} before the tiers`;
}
