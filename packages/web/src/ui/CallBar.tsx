/**
 * The call bar and the call's mark on a chat row (docs/calls.md "The call bar"): the two smallest sizes of a call
 * you're in. The bar is a slim row of the app's layout, like a music player's: whoever is talking (or the call's faces
 * while nobody does), how long it has gone, and the buttons your role needs most. A tap expands it in place: on a
 * phone a sheet under it with every button and Go to chat, on a computer the dock above it. A phone keeps it at the
 * top of the screen wherever the call's own chat isn't the page on screen; a computer shows it under the list (or the
 * page, with the list hidden) where the list has no room for the dock.
 * The mark is a small sign on a chat row with a call going on: three small bars, green when it's your call.
 */
import { computed, signal } from '@preact/signals';
import type { JSX } from 'preact';
import type * as P from '@dither-chat/protocol';
import { type ActiveCall, activeCall, callControls, callName, callStatus, featuredSpeaker } from '../call.ts';
import { barKinds, barShows, idleFaces } from '../callbar.ts';
import { communitiesOf, convTitle, inboxKeyOf } from '../model.ts';
import { PANE_DEFAULT, paneWidths } from '../panes.ts';
import { useLayer } from '../phone.ts';
import { callIn } from '../ringing.ts';
import { db, go } from '../state.ts';
import { Avatar } from './bits.tsx';
import { CallAvatar, callMarks } from './CallAvatar.tsx';
import { CallControls } from './CallControls.tsx';
import './CallBar.css';

/** The call expanded: the dock open, or (from the bar) the phone's sheet or a computer's dock over the bar. */
export const callOpen = signal(false);
/** The bar shows now (App.tsx says, as it lays the bar's row out). */
export const callBarOn = signal(false);

/** The call's conversation, while you're in one: what the layout reads, so a word or a mute does not draw it again. */
const callConv = computed(() => activeCall.value?.conversationId ?? null);
const listWidth = computed(() => paneWidths.value.sidebar ?? PANE_DEFAULT.sidebar);

/** Is `shown` (the conversation on screen) the call's chat? Any route of the same chat counts (docs/chats.md). */
export function isCallChat(shown: string | null, conv: string): boolean {
  return !!shown && (shown === conv || inboxKeyOf(shown) === inboxKeyOf(conv));
}

/** Does the bar show (callbar.ts barShows)? App.tsx gives it a row of the layout when it does. */
export function barShown(shown: string | null, phone: boolean, listHidden: boolean): boolean {
  const conv = callConv.value;
  return barShows({ inCall: !!conv, phone, here: !!conv && isCallChat(shown, conv), listHidden, listWidth: listWidth.value });
}

/** The call's own picture, as its row in the list shows it: the person, the group, or the server. */
function ConvFace({ c, size }: { c: P.ConversationView; size: number }) {
  const com = c.shape === 'direct' ? null : communitiesOf(c)[0];
  if (com) return <Avatar id={com.id} name={com.name} url={com.icon} size={size} square />;
  const url = c.shape === 'direct' && c.peerPersonId ? (db.persons.get(c.peerPersonId)?.avatar ?? c.avatar) : c.avatar;
  return <Avatar id={c.peerPersonId ?? c.id} name={convTitle(c)} url={url} size={size} square={c.shape !== 'direct'} />;
}

/** Whose face the bar shows: whoever talks (call.ts featuredSpeaker), else a few of the others (or the chat's picture) with the call's phase. */
function BarFace({ call, phase }: { call: ActiveCall; phase: string }) {
  const lead = featuredSpeaker.value;
  const talker = lead ? call.participants.find((p) => p.id === lead) : undefined;
  if (talker) return <CallAvatar {...callMarks(call, talker)} size={32} />;
  const c = db.conversations.get(call.conversationId);
  const faces = idleFaces(
    call.participants.map((p) => p.id),
    db.accounts.get(call.accountId)?.selfIdentityId,
  );
  return (
    <span class={`call-bar-idle n${faces.length}`}>
      {faces.length
        ? faces.map((id) => {
            const i = db.identities.get(id);
            return <Avatar id={i?.personId ?? id} name={callName(id)} url={i?.avatar ?? null} size={faces.length === 1 ? 32 : 22} />;
          })
        : c && <ConvFace c={c} size={32} />}
      <i class={`call-bar-phase call-dot ${phase === 'reaching' ? 'connecting' : phase}`} />
    </span>
  );
}

/**
 * The call as a slim row: who talks, how long, and two buttons at most. Never Leave: it is in the expanded call, away
 * from where a thumb rests. `now` ticks once a second (CallDock).
 */
export function CallBar({ call, now }: { call: ActiveCall; now: number }) {
  const c = db.conversations.get(call.conversationId);
  const title = c ? convTitle(c) : 'Call';
  const status = callStatus(call, now);
  const lead = featuredSpeaker.value;
  const talker = lead && call.participants.some((p) => p.id === lead) ? lead : null;
  const open = callOpen.value;
  return (
    <section
      class={`call-bar ${status.phase}`}
      aria-label="Call bar"
      data-call-bar={call.conversationId}
      data-call-phase={call.phase}
      data-call-connected={call.self?.connected || call.timing.connected !== undefined ? '1' : undefined}
    >
      <button class="call-bar-open" onClick={() => (callOpen.value = !open)} aria-expanded={open} title={open ? 'Fold the call' : `The call in ${title}: everyone in it and every button`} data-track="call bar: open">
        <span class="call-bar-face" aria-hidden="true">
          <BarFace call={call} phase={status.phase} />
        </span>
        <span class="call-bar-text">
          <b>{talker ? callName(talker) : title}</b>
          <small>
            {talker && <span class="sr-only">is talking, </span>}
            <span class="call-bar-time">{status.text}</span>
            {talker && ` · ${title}`}
            {status.hint && ` · ${status.hint}`}
          </small>
        </span>
      </button>
      <div class="call-bar-buttons">
        <CallControls call={call} only={barKinds(callControls(call), !!call.listenOnly)} track="call bar" />
      </div>
    </section>
  );
}

/** While the bar's call is expanded, back and Escape fold it: it is a layer, which Escape closes (escape.ts). */
export function BarLayer() {
  useLayer(() => (callOpen.value = false));
  return null;
}

/**
 * A phone's call, expanded from the bar: a sheet over the page you're on, hanging from the bar, with every button
 * (Leave among them), Go to chat, and the people in it (`Panel`, the dock's open body, a chunk of its own).
 */
export function CallSheet({ call, Panel }: { call: ActiveCall; Panel: ((p: { call: ActiveCall }) => JSX.Element) | null }) {
  const c = db.conversations.get(call.conversationId);
  const title = c ? convTitle(c) : 'Call';
  const fold = () => (callOpen.value = false);
  return (
    <>
      <BarLayer />
      <div class="call-sheet-back" onClick={fold} aria-hidden="true" />
      <section class="call-sheet" role="dialog" aria-label={`Call in ${title}`}>
        <div class="call-sheet-buttons">
          <CallControls call={call} track="call sheet" />
        </div>
        <button
          class="chip-btn call-sheet-go"
          data-track="call sheet: go to chat"
          onClick={() => {
            callOpen.value = false;
            go({ view: 'inbox', conv: call.conversationId });
          }}
        >
          Go to chat
        </button>
        {Panel ? <Panel call={call} /> : <div class="call-dock-body call-empty">Loading…</div>}
      </section>
    </>
  );
}

/** What a row's mark shows: the call you're in there and whether anyone talks, or a call going on there you're not in. */
const yourCall = computed(() => {
  const call = activeCall.value;
  if (!call || call.phase === 'ended') return null;
  return { conv: call.conversationId, someone: call.participants.some((p) => p.speaking) };
});

/** A small sign on a chat row with a call going on: three small bars, green in your call and moving while anyone talks. */
export function CallMark({ convIds }: { convIds: readonly string[] }) {
  const mine = yourCall.value;
  if (mine && convIds.includes(mine.conv)) {
    const words = mine.someone ? 'Your call is here: someone is talking' : 'Your call is here';
    return (
      <span class={`call-mark mine ${mine.someone ? 'speaking' : ''}`} data-call-mark="mine" role="img" title={words} aria-label={words}>
        <Bars />
      </span>
    );
  }
  // A call going on there that you're not in (the hub's calls; it doesn't say who talks).
  const going: P.CallView | null = convIds.map((id) => callIn(id)).find((x) => !!x && !x.ringing) ?? null;
  if (!going) return null;
  return (
    <span class="call-mark" data-call-mark="going" role="img" title="A call is going on" aria-label="A call is going on">
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
