/**
 * A decision's tier in words and your marks on it (docs/notifications.md). `MarkToggles` is the two toggles, "Should
 * have alerted" (on an alert, "Alert was wrong") and "Less like this": small beside a line of How it sorts, with
 * their words in a message's bell and the phone's sheet. `TriageWhy` is what a bell opens: the tier, the reasons, the
 * importance, the local model's answer, and the toggles.
 */
import type * as P from '@dither-chat/protocol';
import { TIER_LABEL } from '@dither-chat/protocol';
import { alertToggle, isMailId, isTier, lessToggle, oldVote } from '../marks.ts';
import { mark, type Markable } from '../triage.ts';
import { Icon } from './icons.tsx';

// Light ones: every message in a timeline carries its tier's icon among its hover actions, and most are below the list.
export const TIER_ICON: Record<P.NotifyTier, string> = { push: 'bell', quiet: 'groups', digest: 'layers', drop: 'chevronDown' };
export const tierIcon = (d: P.TriageDecision) => (d === 'silent' ? 'bellOff' : TIER_ICON[d]);
export const tierName = (d: P.TriageDecision) => (d === 'silent' ? 'Silent' : TIER_LABEL[d]);

/** "Alert: it sounded because", "Conversation: a silent row of its own on your phone because", ... */
export function tierHeading(d: P.TriageDecision): string {
  return d === 'push'
    ? 'Alert: this notified you, with sound, because'
    : d === 'quiet'
      ? 'Conversation: a silent row of its own on your phone because'
      : d === 'digest'
        ? "List: a silent row in your phone's list because"
        : d === 'drop'
          ? 'Below the list: unread in its chat only, because'
          : 'This was silent because';
}

export const percent = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The two toggles on a decision; mail has only "Less like this". `small`: icons alone, their words in the tooltip.
 * `onDone` closes the menu or sheet they sit in.
 */
export function MarkToggles({ m, small, onDone }: { m: Markable; small?: boolean; onDone?: () => void }) {
  const t = m.triage;
  if (!t || !isTier(t.decision)) return null;
  const alert = alertToggle(t);
  const less = lessToggle(t);
  const send = (change: P.TriageMarks) => (e: Event) => {
    e.stopPropagation();
    void mark(m, change);
    onDone?.();
  };
  const cls = (on: boolean) => `${small ? 'icon-btn small' : 'chip-btn'} ${on ? 'on' : ''}`;
  const said = (label: string, on: boolean) => (on ? `${label}: you said so. Click to take it back.` : label);
  return (
    <span class={`mark-toggles ${small ? 'small' : ''}`}>
      {!isMailId(m.id) && (
        <button class={cls(alert.on)} data-mark="alert" data-track={t.decision === 'push' ? 'mark alert wrong' : 'mark alert'} aria-pressed={alert.on} aria-label={alert.label} title={said(alert.label, alert.on)} onClick={send({ alert: alert.send })}>
          <Icon name={t.decision === 'push' ? 'bellOff' : 'bell'} size={small ? 15 : 13} />
          {!small && ` ${alert.label}`}
        </button>
      )}
      <button class={cls(less.on)} data-mark="less" data-track="mark less" aria-pressed={less.on} aria-label={less.label} title={said(less.label, less.on)} onClick={send({ less: less.send })}>
        <Icon name="chevronDown" size={small ? 15 : 13} />
        {!small && ` ${less.label}`}
      </button>
    </span>
  );
}

/**
 * Why a message landed where it did, and the toggles. The local model's answer comes with the bar it was set against
 * (lower in a DM and for a message about you). `marks` false leaves the toggles out (your own message).
 */
export function TriageWhy({ m, marks = true, onDone }: { m: Markable; marks?: boolean; onDone?: () => void }) {
  const t = m.triage;
  const judged = typeof t?.judge === 'number';
  if (!t) return null;
  const old = oldVote(t);
  return (
    <div class="triage-pop">
      <div class="menu-title">{tierHeading(t.decision)}</div>
      <ul>
        {t.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      {(t.score !== null || judged || old) && (
        <div class="triage-score">
          {t.score !== null && (
            <div data-importance>
              Importance {percent(t.score)}
              {t.decidedBy === 'learned' ? ' · moved by your marks' : ''}
            </div>
          )}
          {judged && (
            <div data-judge>
              The local model's answer: {t.judge}
              {typeof t.bar === 'number' ? ` (the bar here is ${t.bar})` : ''}
            </div>
          )}
          {old && <div data-old-vote>{old}</div>}
        </div>
      )}
      {marks && isTier(t.decision) && (
        <div class="triage-fb">
          <MarkToggles m={m} onDone={onDone} />
        </div>
      )}
    </div>
  );
}
