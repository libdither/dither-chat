/**
 * A call's buttons (docs/calls.md "In a call"), the same wherever the call shows (the dock now; the call bar and a
 * room later): which ones and what each says come from call.ts callControls, by your role and the call's state. The
 * microphone's button carries its level as a ring and, when you talk into it muted, an amber ring and a small note
 * anchored to it, which never moves anything else.
 */
import { type ActiveCall, callControls, callRole, leaveCall, micLevel, mutedTalking, setCamera, setDeafened, setMuted, setScreen, stageAction } from '../call.ts';
import type { CallControl, CallControlKind } from '../callmarks.ts';
import { Icon } from './icons.tsx';

const ICON: Partial<Record<CallControlKind, (c: CallControl) => string>> = {
  mute: (c) => (c.off ? 'micOff' : 'mic'),
  deafen: (c) => (c.off ? 'headphonesOff' : 'headphones'),
  camera: () => 'camera',
  share: () => 'monitor',
  leave: () => 'phoneOff',
};

const TRACK: Partial<Record<CallControlKind, (c: CallControl) => string>> = {
  camera: () => 'call camera',
  share: () => 'call screen',
  hand: (c) => (c.on ? 'stage lower hand' : 'stage raise hand'),
  speak: () => 'stage speak',
  listen: (c) => (c.label === 'Stay in the audience' ? 'stage stay' : 'stage listen'),
};

function run(call: ActiveCall, c: CallControl) {
  switch (c.kind) {
    case 'mute':
      return setMuted(!call.muted);
    case 'deafen':
      return setDeafened(!call.deafened);
    case 'camera':
      return void setCamera(!call.camera);
    case 'share':
      return void setScreen(!call.screen);
    case 'hand':
      return stageAction(callRole(call) === 'hand' ? 'lowerHand' : 'raiseHand');
    case 'speak':
      return stageAction('speak');
    case 'listen':
      return stageAction('listen');
    case 'leave':
      return leaveCall();
  }
}

/**
 * The call's buttons: round ones with an icon (mute, deafen, camera, share, a hand, leave), and Speak or Move to the
 * audience as words. `only`: just these kinds, in the usual order. `track`: a prefix for each button's data-track.
 */
export function CallControls({ call, only, track }: { call: ActiveCall; only?: readonly CallControlKind[]; track?: string }) {
  const list = callControls(call).filter((c) => !only || only.includes(c.kind));
  return (
    <>
      {list.map((c) => {
        const icon = ICON[c.kind]?.(c);
        const t = track ? `${track}: ${c.kind}` : TRACK[c.kind]?.(c);
        if (c.kind === 'mute') return <MicButton call={call} c={c} track={t} />;
        if (!icon && c.kind !== 'hand')
          return (
            <button class={`chip-btn call-word ${c.kind === 'speak' ? 'on' : ''}`} onClick={() => run(call, c)} disabled={c.disabled} data-track={t}>
              {c.label}
            </button>
          );
        return (
          <button class={`call-btn ${c.kind} ${c.off ? 'off' : ''} ${c.on ? 'on' : ''}`} onClick={() => run(call, c)} aria-label={c.label} title={c.title ?? c.label} disabled={c.disabled} aria-pressed={c.kind === 'hand' ? !!c.on : undefined} data-track={t}>
            {icon ? <Icon name={icon} size={18} /> : <span aria-hidden="true">✋</span>}
          </button>
        );
      })}
    </>
  );
}

/** The microphone: its level as a ring; muted and talking, an amber ring and a note anchored above it (below it at a phone's top). */
function MicButton({ call, c, track }: { call: ActiveCall; c: CallControl; track?: string }) {
  const talking = call.muted && mutedTalking.value;
  return (
    <span class="call-mic">
      <button
        class={`call-btn mic ${c.off ? 'off' : ''} ${talking ? 'muted-talking' : ''}`}
        onClick={() => run(call, c)}
        aria-label={c.label}
        title={c.title ?? c.label}
        disabled={c.disabled}
        data-track={track}
        style={{ '--mic-level': call.muted ? 0 : micLevel.value }}
      >
        <Icon name={c.off ? 'micOff' : 'mic'} size={18} />
      </button>
      {talking && (
        <span class="call-mic-note" aria-hidden="true">
          You're muted
        </span>
      )}
      {/* Always here, so a screen reader hears the change rather than a node coming and going. */}
      <span class="sr-only" aria-live="polite">
        {talking ? "You're talking, but you're muted" : ''}
      </span>
    </span>
  );
}
