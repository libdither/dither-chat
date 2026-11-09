/**
 * Voting a triage decision between Important, Active, Digest and below it (docs/notifications.md). `TierVote` is up
 * and down arrows around the level, for lists you go through one by one; `TierPicker` is the levels side by side, for
 * a message's menu.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect } from 'preact/hooks';
import { HEAD_LABEL, isTier, levelOf, loadPolicy, thresholds, TIER_LABEL, TIERS, tierDown, tierUp, triagePolicy, vote, type Votable } from '../triage.ts';
import { Icon } from './icons.tsx';

const WHAT: Record<P.NotifyTier, string> = {
  push: 'buzzes your phone and notifies your desktop',
  quiet: 'a silent notification on your phone',
  digest: 'no notification, read it with the digest',
  drop: 'not even the digest: unread in its chat only',
};
export const TIER_ICON: Record<P.NotifyTier, 'bell' | 'bellOff' | 'layers' | 'eyeOff'> = { push: 'bell', quiet: 'bellOff', digest: 'layers', drop: 'eyeOff' };

export function TierVote({ m }: { m: Votable }) {
  const t = m.triage;
  if (!t || !isTier(t.decision)) return null;
  const now = levelOf(t) as P.NotifyTier;
  const up = tierUp(now);
  const down = tierDown(now);
  const moved = !!t.feedback && t.feedback !== t.decision;
  const stop = (f: () => void) => (e: Event) => {
    e.stopPropagation();
    f();
  };
  return (
    <span class="tier-vote">
      <button class={`icon-btn small ${!up && t.feedback === 'push' ? 'on' : ''}`} data-track="vote up" title={up ? `Should be ${TIER_LABEL[up]}: ${WHAT[up]}` : 'Right call: Important'} onClick={stop(() => vote(m, 'up'))}>
        <Icon name="chevronUp" size={15} />
      </button>
      <span class={`tier-chip ${now} ${moved ? 'moved' : ''}`} title={moved ? `You moved it here from ${TIER_LABEL[t.decision]}` : t.feedback ? 'You said this was right' : `Triage put it here: ${WHAT[now]}`}>
        {TIER_LABEL[now]}
        {t.feedback === t.decision && <Icon name="check" size={10} />}
      </span>
      <button class={`icon-btn small ${!down && t.feedback === 'drop' ? 'on' : ''}`} data-track="vote down" title={down ? `Should be ${TIER_LABEL[down]}: ${WHAT[down]}` : 'Right call: not interesting'} onClick={stop(() => vote(m, 'down'))}>
        <Icon name="chevronDown" size={15} />
      </button>
    </span>
  );
}

export function TierPicker({ m, onDone }: { m: Votable; onDone?: () => void }) {
  const t = m.triage;
  if (!t || !isTier(t.decision)) return null;
  const now = levelOf(t);
  return (
    <div class="tier-picker" role="radiogroup" aria-label="Where this should go">
      {[...TIERS].reverse().map((l) => (
        <button
          role="radio"
          aria-checked={now === l}
          data-track={`vote (${TIER_LABEL[l]})`}
          class={`chip-btn tier-${l} ${now === l ? 'on' : ''}`}
          title={`${TIER_LABEL[l]}: ${WHAT[l]}${l === t.decision ? ' (where triage put it)' : ''}`}
          onClick={() => {
            // The same level again takes your vote back.
            void vote(m, t.feedback === l ? null : l);
            onDone?.();
          }}
        >
          <Icon name={TIER_ICON[l]} size={13} /> {TIER_LABEL[l]}
          {l === t.decision && <span class="tier-dot" />}
        </button>
      ))}
    </div>
  );
}

/** "This buzzed you because", "This came as a silent notification because", ... */
export function triageHeading(d: P.TriageDecision): string {
  return d === 'push'
    ? 'Important: this notified you because'
    : d === 'quiet'
      ? 'Active: a silent notification because'
      : d === 'digest'
        ? 'This went to the digest because'
        : d === 'drop'
          ? 'Not interesting enough for the digest because'
          : 'This was silent because';
}

/** The model's three chances, as small bars, named for the level each one decides: Important, Active, Digest. */
export function TriageChances({ p }: { p: P.TriageProbs }) {
  // The hub's own thresholds; its defaults until its policy is in.
  useEffect(() => void (triagePolicy.value || loadPolicy()), []);
  const at = thresholds();
  const keys: (keyof P.TriageProbs)[] = ['ping', 'active', 'interesting'];
  return (
    <div class="triage-chances">
      {keys.map((k) => (
        <div key={k} class={`triage-chance ${p[k] >= at[k] ? 'over' : ''}`} title={`${HEAD_LABEL[k]}: ${Math.round(p[k] * 100)}% (at ${Math.round(at[k] * 100)}% or more it is ${HEAD_LABEL[k]})`}>
          <span>{HEAD_LABEL[k]}</span>
          <span class="triage-bar">
            <span style={{ width: `${Math.round(p[k] * 100)}%` }} />
            <i style={{ left: `${at[k] * 100}%` }} />
          </span>
          <b>{Math.round(p[k] * 100)}%</b>
        </div>
      ))}
    </div>
  );
}
