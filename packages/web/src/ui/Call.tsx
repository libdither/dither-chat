import { useEffect, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { type ActiveCall, activeCall, callMedia, callName, callStatus, canCall, canRing, featuredSpeaker, isCallSelf, leaveCall, startCall } from '../call.ts';
import { callIn } from '../ringing.ts';
import { db, prefs, rev } from '../state.ts';
import { convTitle } from '../model.ts';
import { CallControls } from './CallControls.tsx';
import { Icon } from './icons.tsx';
import { BarLayer, CallBar, CallSheet, callOpen } from './CallBar.tsx';
import { phone } from '../phone.ts';

type PanelParts = typeof import('./CallPanel.tsx');
let panel: PanelParts | null = null;
let loading: Promise<PanelParts> | null = null;

/** The open dock's chunk, asked for only once the dock is open. */
function useCallPanel(want: boolean): PanelParts['CallPanel'] | null {
  const [p, setP] = useState(panel);
  useEffect(() => {
    if (!want || p) return;
    (loading ??= import('./CallPanel.tsx').then(
      (m) => (panel = m),
      (e) => {
        loading = null;
        throw e;
      },
    )).then(setP, () => {});
  }, [want]);
  return p?.CallPanel ?? null;
}

/**
 * The header's call button: Join on voice channels an online account can call in; Call on a DM or group whose account
 * can ring the others (or Join, when a call is going on there already).
 */
export function JoinCallButton({ c }: { c: P.ConversationView }) {
  rev.value;
  const voiceAccount = canCall(c);
  const ringAccount = voiceAccount ? null : canRing(c);
  const accountId = voiceAccount ?? ringAccount;
  const call = activeCall.value;
  if (!accountId) return null;
  const here = call && call.conversationId === c.id && call.phase !== 'ended';
  const going = !!ringAccount && !!callIn(c.id);
  const ring = !!ringAccount && !going;
  const label = here ? 'Leave' : ring ? 'Call' : 'Join';
  const title = here ? 'Leave the call' : ring ? 'Call: ring everyone here' : 'Join the call';
  return (
    <button
      class={`hdr-btn call-join ${here ? 'on' : ''}`}
      data-track={here ? 'leave call' : ring ? 'start call' : 'join call'}
      title={title}
      aria-label={title}
      onClick={() => (here ? leaveCall() : void startCall(c.id, accountId, prefs.value.callMode, ring))}
    >
      <Icon name={here ? 'phoneOff' : 'phone'} size={16} />
      <span class="hdr-btn-label">{label}</span>
    </button>
  );
}

/** The dock's bar has the round buttons; a stage's Speak and Move to the audience are in its open body. */
const DOCK_BUTTONS = ['mute', 'deafen', 'camera', 'share', 'hand', 'leave'] as const;

/**
 * The call in progress, wherever you are in the app. Tap it for the people in it. `bar`: there's no room for the dock
 * here (CallBar.tsx barShown): the call is the call bar, a row of the layout, and expanding it shows a phone's sheet
 * under it or, on a computer, the dock over it, until it's folded again.
 */
export function CallDock({ bar }: { bar: boolean }) {
  rev.value;
  const call = activeCall.value;
  const open = callOpen.value;
  const [now, setNow] = useState(Date.now());
  // The bar coming or going (a page changed) folds whatever was expanded: the dock, or the bar's sheet.
  useEffect(() => {
    callOpen.value = false;
  }, [bar, !!call]);
  // The open dock is a chunk of its own (CallPanel.tsx), loaded the first time it opens.
  const Panel = useCallPanel(open);
  useEffect(() => {
    if (!call) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [!!call]);
  if (!call) return null;
  if (bar)
    return (
      <>
        <CallVideos />
        <CallBar call={call} now={now} />
        {open && (phone.value ? <CallSheet call={call} Panel={Panel} /> : <Dock call={call} now={now} open Panel={Panel} overBar />)}
      </>
    );
  return (
    <>
      <CallVideos />
      <Dock call={call} now={now} open={open} Panel={Panel} />
    </>
  );
}

/** The dock: the call's name, status and buttons; open, its people too. `overBar`: shown over the call bar, folded by back. */
function Dock({ call, now, open, Panel, overBar }: { call: ActiveCall; now: number; open: boolean; Panel: PanelParts['CallPanel'] | null; overBar?: boolean }) {
  const c = db.conversations.get(call.conversationId);
  const title = c ? convTitle(c) : 'Call';
  // Whoever talks, the featured one (the latest to start, call.ts featuredSpeaker) first.
  const lead = featuredSpeaker.value;
  const speaking = call.participants.filter((p) => p.speaking).sort((x, y) => Number(y.id === lead) - Number(x.id === lead));
  const effect = call.effects.at(-1)?.effect;
  const status = callStatus(call, now);
  return (
    <section
      class={`call-dock ${open ? 'open' : ''} ${overBar ? 'over-bar' : ''} ${call.phase}`}
      aria-label="Call"
      data-call-stats={call.stats ? JSON.stringify(call.stats) : undefined}
      data-call-phase={call.phase}
      data-call-connected={call.self?.connected || call.timing.connected !== undefined ? '1' : undefined}
      data-call-timing={JSON.stringify(call.timing)}
    >
      {overBar && <BarLayer />}
      <div class="call-dock-bar">
        <button class="call-dock-title" onClick={() => (callOpen.value = !open)} aria-expanded={open}>
          <span class={`call-dot ${status.phase === 'reaching' ? 'connecting' : call.phase}`} />
          <span class="call-dock-text">
            <b>{title}</b>
            <small>
              {status.text}
              {call.phase === 'live' && ` · ${call.mode === 'direct' ? 'direct' : 'bridge'}`}
              {status.hint ? ` · ${status.hint}` : effect ? ` · ${callName(effect.who)}: ${effect.sound ? `${effect.emoji ? `${effect.emoji} ` : '🔊 '}${effect.sound.name}` : effect.emoji}` : speaking.length > 0 && ` · ${speaking.map((p) => callName(p.id)).join(', ')} ${speaking.length === 1 ? 'is' : 'are'} talking`}
            </small>
          </span>
        </button>
        <div class="call-dock-buttons">
          <CallControls call={call} only={DOCK_BUTTONS} />
        </div>
      </div>
      {open && (Panel ? <Panel call={call} /> : <div class="call-dock-body call-empty">Loading…</div>)}
    </section>
  );
}

/** One video: a stream on a <video>, a tap for full screen. */
function VideoTile({ stream, label, mirror, slot, speaking }: { stream: MediaStream; label: string; mirror?: boolean; slot?: string; speaking?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (v && v.srcObject !== stream) {
      v.srcObject = stream;
      v.play().catch(() => {});
    }
  }, [stream]);
  return (
    <figure class={`call-video speak-ring ${mirror ? 'mirror' : ''} ${speaking ? 'speaking' : ''}`} data-video-slot={slot}>
      <video ref={ref} autoplay playsInline muted onClick={(e) => void (e.currentTarget as HTMLVideoElement).requestFullscreen?.().catch(() => {})} />
      <figcaption>
        {label}
        {speaking && <span class="sr-only">, speaking</span>}
      </figcaption>
    </figure>
  );
}

/** Video in the call: others' cameras and streams on the bridge's slots, and what this device sends. */
function CallVideos() {
  const call = activeCall.value;
  const media = callMedia.value;
  if (!call || call.phase === 'ended') return null;
  const remote = call.video.map((v) => ({ v, stream: media.slots.get(v.slot) })).filter((x) => !!x.stream);
  if (!remote.length && !media.camera && !media.screen) return null;
  const talks = (who: string) => !!call.participants.find((p) => p.id === who)?.speaking;
  return (
    <div class="call-videos" aria-label="Video">
      {remote.map(({ v, stream }) => (
        <VideoTile key={`${v.slot}:${v.who}:${v.source}`} stream={stream!} slot={v.slot} speaking={v.source !== 'stream' && talks(v.who)} label={`${callName(v.who)}${v.source === 'stream' ? ' · screen' : ''}`} />
      ))}
      {media.screen && <VideoTile key="my-screen" stream={media.screen} label="Your screen" />}
      {media.camera && <VideoTile key="my-camera" stream={media.camera} label="You" mirror speaking={call.participants.some((p) => p.speaking && isCallSelf(call, p.id))} />}
    </div>
  );
}
