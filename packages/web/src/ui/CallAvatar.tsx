/**
 * A person in a call (docs/calls.md "Who is speaking"): their picture in a fixed square box, so the speaking ring drawn
 * around it is round at every size; the ring follows the held speaking value (call.ts speakingNow), turns amber on you
 * when you talk into a muted microphone, and one badge in the corner shows their most important state.
 */
import type * as P from '@dither-chat/protocol';
import { activeCall, isCallSelf, mutedTalking, speakingLevels, speakingNow } from '../call.ts';
import { BADGE_WORDS, callBadge } from '../callmarks.ts';
import { db, prefs } from '../state.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import './CallAvatar.css';

export function CallAvatar({ p, name, size = 40 }: { p: P.CallParticipant; name: string; size?: number }) {
  const call = activeCall.value;
  const idn = db.identities.get(p.id);
  const mark = prefs.value.callSpeakingMark ?? 'ring';
  const self = !!call && isCallSelf(call, p.id);
  const speaking = speakingNow.value.has(p.id);
  const amber = self && !!call?.muted && mutedTalking.value;
  const badge = callBadge(p);
  const level = speakingLevels.value.get(p.id);
  const bars = mark === 'bars' && speaking;
  const corner = Math.min(18, Math.max(12, Math.round(size * 0.38)));
  return (
    <span
      class={`call-av mark-${mark} ${speaking ? 'speaking' : ''} ${amber ? 'muted-talking' : ''}`}
      style={{ '--s': `${size}px`, '--corner': `${corner}px`, ...(level !== undefined ? { '--lv': level } : {}) }}
      data-speaking={speaking ? '1' : undefined}
      data-badge={badge ?? undefined}
    >
      <Avatar id={idn?.personId ?? p.id} name={name} url={idn?.avatar ?? null} size={size} />
      {bars ? (
        <b class="call-av-bars" aria-hidden="true">
          <s />
          <s />
          <s />
        </b>
      ) : (
        badge && (
          <b class={`call-av-badge ${badge}`} title={BADGE_WORDS[badge]}>
            {badge === 'hand' ? '✋' : <Icon name={badge === 'deafened' || badge === 'serverDeafened' ? 'headphonesOff' : 'micOff'} size={Math.round(corner * 0.66)} />}
          </b>
        )
      )}
    </span>
  );
}

