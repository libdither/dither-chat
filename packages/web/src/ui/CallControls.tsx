/**
 * A call's buttons (docs/calls.md "In a call"), the same wherever the call shows (the dock now; the call bar and a
 * room later): which ones and what each says come from call.ts callControls, by your role and the call's state. The
 * microphone's button carries its level as a ring and, when you talk into it muted, an amber ring and a small note
 * anchored to it, which never moves anything else.
 */
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { android } from '../android.ts';
import { type ActiveCall, callControls, callRole, leaveCall, micLevel, mutedTalking, setCamera, setDeafened, setMuted, setScreen, stageAction } from '../call.ts';
import { audioControl, type AudioRoute, type CallControl, type CallControlKind } from '../callmarks.ts';
import { metaRev } from '../state.ts';
import { openMenu } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';

/** A sound output's icon: the loudspeaker, the earpiece, a Bluetooth or wired headset. */
function routeIcon(r: AudioRoute | null | undefined): string {
  switch (r?.kind) {
    case 'speaker':
      return 'voice';
    case 'earpiece':
      return 'phone';
    case 'bluetooth':
      return 'bluetooth';
    default:
      return r ? 'headphones' : 'voice';
  }
}

const ICON: Partial<Record<CallControlKind, (c: CallControl) => string>> = {
  mute: (c) => (c.off ? 'micOff' : 'mic'),
  deafen: (c) => (c.off ? 'headphonesOff' : 'headphones'),
  speaker: (c) => routeIcon(c.audio?.current),
  camera: () => 'camera',
  share: () => 'monitor',
  leave: () => 'phoneOff',
};

const TRACK: Partial<Record<CallControlKind, (c: CallControl) => string>> = {
  speaker: () => 'call sound output',
  camera: () => 'call camera',
  share: () => 'call screen',
  hand: (c) => (c.on ? 'stage lower hand' : 'stage raise hand'),
  speak: () => 'stage speak',
  listen: (c) => (c.label === 'Stay in the audience' ? 'stage stay' : 'stage listen'),
};

/**
 * The switches' names: the same whichever way they are, with aria-pressed saying which (a screen reader hears "Mute,
 * pressed", not "Unmute, pressed"). Their tooltips still say what a press does now.
 */
const SWITCH: Partial<Record<CallControlKind, { name: string; pressed: (c: CallControl) => boolean }>> = {
  mute: { name: 'Mute', pressed: (c) => !!c.off },
  deafen: { name: 'Deafen', pressed: (c) => !!c.off },
  speaker: { name: 'Speaker', pressed: (c) => !!c.on },
  camera: { name: 'Camera', pressed: (c) => !!c.on },
  share: { name: 'Share your screen', pressed: (c) => !!c.on },
};

/** The phone's sound outputs to pick from, under the speaker button. */
function pickRoute(c: CallControl, from: HTMLElement) {
  const r = from.getBoundingClientRect();
  const items = (c.audio?.routes ?? []).map((x) => ({ label: x.name, icon: routeIcon(x), checked: x.id === c.audio?.current?.id, radio: true, track: 'call sound output pick', run: () => android?.setAudioRoute(x.id) }));
  openMenu({ x: r.left + r.width / 2, y: r.bottom }, { items, head: <b>Sound plays from</b>, track: 'call sound output menu' }, from);
}

/** Short words under a button where there is room for them (a phone's call sheet). */
const WORD: Partial<Record<CallControlKind, (c: CallControl) => string>> = {
  mute: (c) => (c.off ? 'Unmute' : 'Mute'),
  deafen: (c) => (c.off ? 'Undeafen' : 'Deafen'),
  speaker: (c) => c.audio?.current?.name ?? 'Speaker',
  camera: (c) => (c.on ? 'Camera off' : 'Camera'),
  share: (c) => (c.on ? 'Stop sharing' : 'Share'),
  hand: (c) => (c.on ? 'Lower hand' : 'Raise hand'),
  leave: () => 'Leave',
};

function run(call: ActiveCall, c: CallControl, e?: MouseEvent) {
  switch (c.kind) {
    case 'speaker':
      if (c.audio?.next) return android?.setAudioRoute(c.audio.next.id);
      return void (e && pickRoute(c, e.currentTarget as HTMLElement));
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
 * Every button the call gives you now: callControls, and in the Android app the speaker button after Deafen (the app
 * reports the phone's sound outputs; it is asked once a call shows).
 */
function useCallControls(call: ActiveCall): CallControl[] {
  metaRev.value; // the account's abilities and which identity is it change without `call` changing
  const audio = android?.audio.value ?? null;
  const live = call.phase !== 'ended';
  useEffect(() => {
    if (android && live) android.send({ t: 'audio.get' });
  }, [live]);
  const list = callControls(call);
  const speaker = android ? audioControl(audio, !live) : null;
  if (speaker) list.splice(list.findIndex((c) => c.kind === 'deafen') + 1, 0, speaker);
  return list;
}

/**
 * The call's buttons: ones with an icon (mute, deafen, the speaker, camera, share, a hand, leave), and Speak or Move to
 * the audience as words. `only`: just these kinds, in the usual order; `except`: all but these. `track`: a prefix for
 * each button's data-track. `words`: a short word under each button (a phone's sheet).
 */
export function CallControls({ call, only, except, track, words }: { call: ActiveCall; only?: readonly CallControlKind[]; except?: readonly CallControlKind[]; track?: string; words?: boolean }) {
  const list = useCallControls(call).filter((c) => (!only || only.includes(c.kind)) && !except?.includes(c.kind));
  return (
    <>
      {list.map((c) => {
        const icon = ICON[c.kind]?.(c);
        const t = track ? `${track}: ${c.kind}` : TRACK[c.kind]?.(c);
        const word = words ? WORD[c.kind]?.(c) : undefined;
        if (c.kind === 'mute') return <Worded word={word}><MicButton call={call} c={c} track={t} /></Worded>;
        if (!icon && c.kind !== 'hand')
          return (
            <button class={`chip-btn call-word ${c.kind === 'speak' ? 'on' : ''}`} onClick={() => run(call, c)} disabled={c.disabled} data-track={t}>
              {c.label}
            </button>
          );
        const sw = SWITCH[c.kind];
        return (
          <Worded word={word}>
          <button
            class={`call-btn ${c.kind} ${c.off ? 'off' : ''} ${c.on ? 'on' : ''}`}
            onClick={(e) => run(call, c, e)}
            aria-haspopup={c.kind === 'speaker' && !c.audio?.next ? 'menu' : undefined}
            aria-label={sw?.name ?? c.label}
            title={c.title ?? c.label}
            disabled={c.disabled}
            aria-pressed={sw ? sw.pressed(c) : c.kind === 'hand' ? !!c.on : undefined}
            data-track={t}
          >
            {icon ? <Icon name={icon} size={18} /> : <span aria-hidden="true">✋</span>}
          </button>
          </Worded>
        );
      })}
    </>
  );
}

/** A button with its word under it (`word`), or the button alone. */
function Worded({ word, children }: { word: string | undefined; children: ComponentChildren }) {
  if (!word) return <>{children}</>;
  return (
    <span class="call-worded">
      {children}
      <span class="call-word-under" aria-hidden="true">
        {word}
      </span>
    </span>
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
        aria-label={SWITCH.mute!.name}
        aria-pressed={SWITCH.mute!.pressed(c)}
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
