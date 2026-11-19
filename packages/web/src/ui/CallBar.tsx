/**
 * The call bar and the call's mark on a chat row (docs/calls.md "The call bar"): the two smallest sizes of a call
 * you're in. The bar is a slim strip like a music player's: who is talking (or the call's name), how long it has gone,
 * mute and leave; a tap opens the call's conversation with the dock open. A phone shows it whenever the call's own
 * conversation isn't the page on screen; a computer shows it in the dock's place when the list is narrow or hidden.
 * The mark is a small sign on the call's row in the list: the face of whoever talks, or three small bars.
 */
import { computed, effect, signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { type ActiveCall, activeCall, isCallSelf, leaveCall, micLevel, setMuted } from '../call.ts';
import { convTitle } from '../model.ts';
import { reducedMotion } from '../phone.ts';
import { callIn } from '../ringing.ts';
import { db, go, isSelfIdentity } from '../state.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import './CallBar.css';

/** The dock is open (its people and controls showing). The bar opens it; closing it brings the bar back where it shows. */
export const callOpen = signal(false);

/** A computer's list at or under this width is too narrow for the dock: the bar takes its place. */
export const BAR_UNDER = 260;

/** How long a talker stays on the bar after they stop, so the name doesn't flicker between words. */
const HOLD_MS = 900;

/**
 * Who the bar and the mark show as talking: someone else in the call who speaks, held a little after they stop, and the
 * same talker kept while they go on even when others start too. Null when nobody (but maybe you) talks.
 */
const callSpeaker = signal<string | null>(null);
let held: ReturnType<typeof setTimeout> | null = null;
effect(() => {
  const call = activeCall.value;
  const now = call && call.phase !== 'ended' ? call.participants.filter((p) => p.speaking && !isCallSelf(call, p.id)).map((p) => p.id) : [];
  const shown = callSpeaker.peek();
  if (shown && now.includes(shown)) {
    if (held) clearTimeout(held), (held = null);
    return;
  }
  if (now.length) {
    if (held) clearTimeout(held), (held = null);
    callSpeaker.value = now[0]!;
    return;
  }
  if (!call) {
    if (held) clearTimeout(held), (held = null);
    callSpeaker.value = null;
    return;
  }
  if (shown && !held) held = setTimeout(() => ((held = null), (callSpeaker.value = null)), HOLD_MS);
});

export function elapsed(since: number, now: number) {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function person(identityId: string) {
  const i = db.identities.get(identityId);
  // Another of the owner's own accounts is named as that account, not "You".
  const p = i?.personId && !isSelfIdentity(identityId) ? db.persons.get(i.personId) : null;
  return { id: i?.personId ?? identityId, name: p?.name ?? i?.displayName ?? i?.handle ?? 'Someone', avatar: i?.avatar ?? null };
}

/** Open the call's conversation with the dock open; the bar grows into the dock where the browser can show it. */
function openCall(call: ActiveCall, here: boolean) {
  const run = () => {
    callOpen.value = true;
    if (!here) go({ view: 'inbox', conv: call.conversationId });
  };
  const doc = document as Document & { startViewTransition?: (f: () => Promise<void>) => unknown };
  if (reducedMotion() || !doc.startViewTransition) return run();
  doc.startViewTransition(async () => {
    run();
    // Preact draws on the next tick: the new state is on the page once it has.
    await new Promise((r) => setTimeout(r, 16));
  });
}

/** The call as a slim strip: who talks, how long, mute, leave. `here`: the call's conversation is the page on screen. */
export function CallBar({ call, here }: { call: ActiveCall; here: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const c = db.conversations.get(call.conversationId);
  const title = c ? convTitle(c) : 'Call';
  const talker = callSpeaker.value;
  const who = talker ? person(talker) : null;
  const status = call.phase === 'connecting' ? 'Connecting…' : call.phase === 'ended' ? (call.note ?? 'Call ended') : elapsed(call.since, now);
  return (
    <section
      class={`call-bar ${call.phase}`}
      aria-label="Call"
      data-call-bar={call.conversationId}
      data-call-phase={call.phase}
      data-call-connected={call.self?.connected || call.timing.connected !== undefined ? '1' : undefined}
    >
      <button class="call-bar-open" onClick={() => openCall(call, here)} data-track="call bar: open" aria-label={`Open the call in ${title}`} title={`Open the call in ${title}`}>
        {/* TODO: CallAvatar (the speaking ring on a square box) once it lands; this draws the same shape for now. */}
        <span class={`call-bar-face ${who ? 'speaking' : ''}`}>
          {who ? <Avatar id={who.id} name={who.name} url={who.avatar} size={30} square /> : <span class={`call-dot ${call.phase}`} />}
        </span>
        <span class="call-bar-text">
          <b>{who ? who.name : title}</b>
          <small>
            <span class="call-bar-time">{status}</span>
            {who && ` · ${title}`}
          </small>
        </span>
      </button>
      <button
        class={`call-btn mic call-bar-btn ${call.muted ? 'off' : ''}`}
        onClick={() => setMuted(!call.muted)}
        aria-label={call.muted ? 'Unmute' : 'Mute'}
        title={call.listenOnly ? 'No microphone: listening only' : call.muted ? 'Unmute' : 'Mute'}
        disabled={call.phase === 'ended' || call.listenOnly}
        data-track="call bar: mute"
        style={{ '--mic-level': call.muted ? 0 : micLevel.value }}
      >
        <Icon name={call.muted ? 'micOff' : 'mic'} size={18} />
      </button>
      <button class="call-btn leave call-bar-btn" onClick={leaveCall} aria-label="Leave the call" title="Leave the call" disabled={call.phase === 'ended'} data-track="call bar: leave">
        <Icon name="phoneOff" size={18} />
      </button>
    </section>
  );
}

/** What a row's mark shows: the call you're in there and who talks in it, or a call going on there you're not in. */
const yourCall = computed(() => {
  const call = activeCall.value;
  if (!call || call.phase === 'ended') return null;
  const someone = call.participants.some((p) => p.speaking);
  return { conv: call.conversationId, talker: callSpeaker.value, someone };
});

/** A small sign on a chat row with a call going on: the talker's face with a ring, or three bars (moving while anyone talks). */
export function CallMark({ convIds }: { convIds: readonly string[] }) {
  const mine = yourCall.value;
  if (mine && convIds.includes(mine.conv)) {
    const who = mine.talker ? person(mine.talker) : null;
    return (
      <span class={`call-mark mine ${who ? 'talker' : ''} ${mine.someone ? 'speaking' : ''}`} data-call-mark="mine" title={who ? `In your call: ${who.name} is talking` : 'Your call is here'} aria-label={who ? `In your call: ${who.name} is talking` : 'Your call is here'}>
        {who ? <Avatar id={who.id} name={who.name} url={who.avatar} size={14} square /> : <Bars />}
      </span>
    );
  }
  // A call going on there that you're not in (the hub's calls; it doesn't say who talks).
  const going: P.CallView | null = convIds.map((id) => callIn(id)).find((x) => !!x && !x.ringing) ?? null;
  if (!going) return null;
  return (
    <span class="call-mark" data-call-mark="going" title="A call is going on" aria-label="A call is going on">
      <Bars />
    </span>
  );
}

function Bars() {
  return (
    <span class="call-mark-bars" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
