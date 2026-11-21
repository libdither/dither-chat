import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { type ActiveCall, activeCall, callName, callStatus, canCall, canRing, featuredSpeaker, leaveCall, roomOnPage, startCall } from '../call.ts';
import { roomCall } from './CallRoomLazy.tsx';
import { callIn } from '../ringing.ts';
import { db, pref, rev } from '../state.ts';
import { convTitle } from '../model.ts';
import { CallControls } from './CallControls.tsx';
import { Icon } from './icons.tsx';
import { BarLayer, CallBar, CallSheet, callOpen } from './CallBar.tsx';
import { phone } from '../phone.ts';
import { callHasVideo, winControls, winPlace, winSlot } from './CallSlot.tsx';

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
 * can ring the others (or Join, when a call is going on there already). Not on a room you are in: its own buttons, or
 * the dock's, have Leave.
 */
export function JoinCallButton({ c }: { c: P.ConversationView }) {
  rev.value;
  const voiceAccount = canCall(c);
  const ringAccount = voiceAccount ? null : canRing(c);
  const accountId = voiceAccount ?? ringAccount;
  const call = activeCall.value;
  if (!accountId || roomCall(c)) return null;
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
      onClick={() => (here ? leaveCall() : void startCall(c.id, accountId, pref('callMode'), ring))}
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
  // On a phone the window carries the call's buttons while it shows: the dock's strip steps aside until opened.
  return (
    <>
      <CallVideos />
      <Dock call={call} now={now} open={open} Panel={Panel} hidden={winControls.value && !open} />
    </>
  );
}

/**
 * The dock: the call's name, status and buttons; open, its people too. `overBar`: shown over the call bar, folded by
 * back. `hidden`: the call window carries the buttons (a phone), so the strip is not drawn; it keeps the call's state.
 */
function Dock({ call, now, open, Panel, overBar, hidden }: { call: ActiveCall; now: number; open: boolean; Panel: PanelParts['CallPanel'] | null; overBar?: boolean; hidden?: boolean }) {
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
      hidden={hidden}
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
        {/* The room on screen has the buttons: one set of them at a time. */}
        {roomOnPage.value !== call.conversationId && (
          <div class="call-dock-buttons">
            <CallControls call={call} only={DOCK_BUTTONS} />
          </div>
        )}
      </div>
      {open && (Panel ? <Panel call={call} /> : <div class="call-dock-body call-empty">Loading…</div>)}
    </section>
  );
}

type WindowParts = typeof import('./CallWindow.tsx');
let videoWindow: WindowParts | null = null;
let loadingWindow: Promise<WindowParts> | null = null;

/** The call window's chunk (CallWindow.tsx), asked for only once the call has video or a room. */
function useCallWindow(want: boolean): WindowParts['CallWindow'] | null {
  const [w, setW] = useState(videoWindow);
  useEffect(() => {
    if (!want || w) return;
    (loadingWindow ??= import('./CallWindow.tsx').then(
      (m) => (videoWindow = m),
      (e) => {
        loadingWindow = null;
        throw e;
      },
    )).then(setW, () => {});
  }, [want]);
  return w?.CallWindow ?? null;
}

/**
 * The call's window (CallWindow.tsx): once the call has video, and wherever a room is on the page (its speakers are
 * the window's tiles, with video or without).
 */
function CallVideos() {
  const call = activeCall.value;
  const want = !!call && call.phase !== 'ended' && (callHasVideo.value || (winSlot.value?.kind === 'room' && winPlace('room') === 'fill'));
  const Window = useCallWindow(want);
  if (!want || !Window) return null;
  return <Window call={call} />;
}
