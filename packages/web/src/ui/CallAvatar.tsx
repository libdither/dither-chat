/**
 * A person in a call (docs/calls.md "Who is speaking"): their picture in a fixed square box with the speaking ring (the
 * shared `.speak-ring`) around it, so it is round at every size, and one badge in the corner for their most important
 * state. `CallAvatar` draws only what it is given; `callMarks` works out what to give it, for someone in the call you're
 * in or in a voice channel you aren't in.
 */
import type * as P from '@dither-chat/protocol';
import { type ActiveCall, callLevels, callName, isCallSelf, mutedTalking } from '../call.ts';
import { BADGE_WORDS, badgeSize, type CallBadge, callBadge } from '../callmarks.ts';
import { db } from '../state.ts';
import { faceOf } from '../model.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import './CallAvatar.css';

interface CallMarkProps {
  /** For the picture's fallback colour: the person's id, or the identity's. */
  id: string;
  name: string;
  picture: string | null;
  size?: number;
  square?: boolean;
  /** Speaking now, held (call.ts). */
  speaking?: boolean;
  /** How loud, 0 to 1, where a level per person exists (direct mode): the ring's strength follows it. */
  level?: number;
  /** The ring's colour: speaking green, or amber for you talking into a muted microphone. */
  tone?: 'good' | 'warn';
  badge?: CallBadge | null;
}

/** Someone a mark can be worked out for: a call's participant, or a voice channel's member (no speaking known). */
type MarkPerson = Pick<P.CallParticipant, 'id'> & Partial<Pick<P.CallParticipant, 'muted' | 'deafened' | 'speaking' | 'serverMuted' | 'serverDeafened' | 'stage' | 'localMute'>>;

/** The marks for a person: in `call` (the call you're in) when given, else from what a voice channel says of them. */
export function callMarks(call: ActiveCall | null, p: MarkPerson): CallMarkProps {
  const idn = db.identities.get(p.id);
  const self = !!call && isCallSelf(call, p.id);
  const level = call?.mode === 'direct' ? callLevels.value.get(p.id) : undefined;
  return {
    id: idn?.personId ?? p.id,
    name: callName(p.id),
    picture: faceOf(p.id).url,
    speaking: !!p.speaking,
    ...(level !== undefined ? { level } : {}),
    tone: self && call.muted && mutedTalking.value ? 'warn' : 'good',
    badge: callBadge({ muted: !!p.muted, deafened: !!p.deafened, serverMuted: p.serverMuted, serverDeafened: p.serverDeafened, stage: p.stage, localMute: p.localMute }),
  };
}

/** What a screen reader hears for the mark: "Lev, speaking, muted". */
function markWords(m: Pick<CallMarkProps, 'name' | 'speaking' | 'tone' | 'badge'>): string {
  return [m.name, m.tone === 'warn' ? 'talking while muted' : m.speaking ? 'speaking' : '', m.badge ? BADGE_WORDS[m.badge] : ''].filter(Boolean).join(', ');
}

export function CallAvatar({ id, name, picture, size = 40, square, speaking, level, tone = 'good', badge }: CallMarkProps) {
  const corner = badgeSize(size);
  const warn = tone === 'warn';
  return (
    <span
      class={`call-av speak-ring ${speaking || warn ? 'speaking' : ''} ${warn ? 'warn' : ''} ${square ? 'square' : ''}`}
      style={{ '--s': `${size}px`, '--corner': `${corner}px`, ...(level !== undefined && !warn ? { '--ring-on': String(0.35 + level * 0.65) } : {}) }}
      role="img"
      aria-label={markWords({ name, speaking, tone, badge })}
      data-speaking={speaking ? '1' : undefined}
      data-badge={badge ?? undefined}
    >
      <Avatar id={id} name={name} url={picture} size={size} square={square} />
      {badge && <CallBadgeMark badge={badge} size={corner} />}
    </span>
  );
}

/** A badge's mark: the face's corner here, a video tile's caption in the call window. */
export function CallBadgeMark({ badge, size }: { badge: CallBadge; size: number }) {
  return (
    <b class={`call-av-badge ${badge}`} title={BADGE_WORDS[badge]}>
      {badge === 'hand' ? '✋' : <Icon name={badge === 'invited' ? 'stage' : badge === 'deafened' || badge === 'serverDeafened' ? 'headphonesOff' : 'micOff'} size={Math.round(size * 0.66)} />}
    </b>
  );
}
