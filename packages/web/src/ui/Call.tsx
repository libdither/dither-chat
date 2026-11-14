import { useEffect, useRef, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { activeCall, callMedia, canCall, canRing, canShareScreen, canVideo, leaveCall, micLevel, setCamera, setDeafened, setMuted, setScreen, startCall } from '../call.ts';
import { callIn } from '../ringing.ts';
import { db, isSelfIdentity, prefs, rev } from '../state.ts';
import { convTitle } from '../model.ts';
import { Icon } from './icons.tsx';

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

function elapsed(since: number, now: number) {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** The call in progress, wherever you are in the app. Tap it for the people in it. */
export function CallDock() {
  rev.value;
  const call = activeCall.value;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  // The open dock is a chunk of its own (CallPanel.tsx), loaded the first time it opens.
  const Panel = useCallPanel(open);
  useEffect(() => {
    if (!call) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [!!call]);
  if (!call) return null;
  const c = db.conversations.get(call.conversationId);
  const title = c ? convTitle(c) : 'Call';
  const speaking = call.participants.filter((p) => p.speaking);
  const effect = call.effects.at(-1)?.effect;
  // Bridge mode: live once the bridge is, but people hear you only once the account's own client has connected.
  const reaching = call.phase === 'live' && call.mode === 'bridge' && call.self && !call.self.connected;
  const status = call.phase === 'connecting' ? 'Connecting…' : call.phase === 'ended' ? (call.note ?? 'Call ended') : reaching ? 'Connecting to Discord…' : elapsed(call.since, now);
  const video = canVideo();
  return (
    <section
      class={`call-dock ${open ? 'open' : ''} ${call.phase}`}
      aria-label="Call"
      data-call-stats={call.stats ? JSON.stringify(call.stats) : undefined}
      data-call-phase={call.phase}
      data-call-connected={call.self?.connected || call.timing.connected !== undefined ? '1' : undefined}
      data-call-timing={JSON.stringify(call.timing)}
    >
      <CallVideos />
      <div class="call-dock-bar">
        <button class="call-dock-title" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span class={`call-dot ${call.phase}`} />
          <span class="call-dock-text">
            <b>{title}</b>
            <small>
              {status}
              {call.phase === 'live' && ` · ${call.mode === 'direct' ? 'direct' : 'bridge'}`}
              {effect ? ` · ${name(effect.who)}: ${effect.sound ? `${effect.emoji ? `${effect.emoji} ` : '🔊 '}${effect.sound.name}` : effect.emoji}` : speaking.length > 0 && ` · ${speaking.map((p) => name(p.id)).join(', ')}`}
            </small>
          </span>
        </button>
        <div class="call-dock-buttons">
          <button
            class={`call-btn mic ${call.muted ? 'off' : ''}`}
            onClick={() => setMuted(!call.muted)}
            aria-label={call.muted ? 'Unmute' : 'Mute'}
            title={call.listenOnly ? 'No microphone: listening only' : call.self?.muted && !call.muted ? 'The account is still muted: tap to try again' : call.muted ? 'Unmute' : 'Mute'}
            disabled={call.phase === 'ended' || call.listenOnly}
            style={{ '--mic-level': call.muted ? 0 : micLevel.value }}
          >
            <Icon name={call.muted ? 'micOff' : 'mic'} size={18} />
          </button>
          <button class={`call-btn ${call.deafened ? 'off' : ''}`} onClick={() => setDeafened(!call.deafened)} aria-label={call.deafened ? 'Undeafen' : 'Deafen'} title={call.deafened ? 'Undeafen' : 'Deafen'} disabled={call.phase === 'ended'}>
            <Icon name={call.deafened ? 'headphonesOff' : 'headphones'} size={18} />
          </button>
          {video && (
            <button class={`call-btn ${call.camera ? 'on' : ''}`} onClick={() => void setCamera(!call.camera)} aria-label={call.camera ? 'Turn camera off' : 'Turn camera on'} title={call.camera ? 'Turn camera off' : 'Turn camera on'} data-track="call camera">
              <Icon name="camera" size={18} />
            </button>
          )}
          {video && canShareScreen() && (
            <button class={`call-btn ${call.screen ? 'on' : ''}`} onClick={() => void setScreen(!call.screen)} aria-label={call.screen ? 'Stop sharing' : 'Share your screen or a window'} title={call.screen ? 'Stop sharing' : 'Share your screen or a window'} data-track="call screen">
              <Icon name="monitor" size={18} />
            </button>
          )}
          <button class="call-btn leave" onClick={leaveCall} aria-label="Leave the call" title="Leave the call" disabled={call.phase === 'ended'}>
            <Icon name="phoneOff" size={18} />
          </button>
        </div>
      </div>
      {open && (Panel ? <Panel call={call} /> : <div class="call-dock-body call-empty">Loading…</div>)}
    </section>
  );
}

/** One video: a stream on a <video>, a tap for full screen. */
function VideoTile({ stream, label, mirror, slot }: { stream: MediaStream; label: string; mirror?: boolean; slot?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (v && v.srcObject !== stream) {
      v.srcObject = stream;
      v.play().catch(() => {});
    }
  }, [stream]);
  return (
    <figure class={`call-video ${mirror ? 'mirror' : ''}`} data-video-slot={slot}>
      <video ref={ref} autoplay playsInline muted onClick={(e) => void (e.currentTarget as HTMLVideoElement).requestFullscreen?.().catch(() => {})} />
      <figcaption>{label}</figcaption>
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
  return (
    <div class="call-videos" aria-label="Video">
      {remote.map(({ v, stream }) => (
        <VideoTile key={`${v.slot}:${v.who}:${v.source}`} stream={stream!} slot={v.slot} label={`${name(v.who)}${v.source === 'stream' ? ' · screen' : ''}`} />
      ))}
      {media.screen && <VideoTile key="my-screen" stream={media.screen} label="Your screen" />}
      {media.camera && <VideoTile key="my-camera" stream={media.camera} label="You" mirror />}
    </div>
  );
}


function name(identityId: string): string {
  const i = db.identities.get(identityId);
  // Another of the owner's own accounts is named as that account, not "You".
  const person = i?.personId && !isSelfIdentity(identityId) ? db.persons.get(i.personId) : null;
  return person?.name ?? i?.displayName ?? i?.handle ?? 'Someone';
}
