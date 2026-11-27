/**
 * The room view's way in (docs/calls.md "The room view"): on a stage you are in, the room is the conversation's page.
 * On a wide pane it sits beside the channel's chat; on a narrow one a Room / Chat switch above shows one of them (a
 * container query, Timeline.tsx's room-pane). The room itself (CallRoom.tsx) is a chunk of its own, loaded the first
 * time, with a Try again when it could not load.
 */
import { effect, signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { activeCall, roomRequests, type ActiveCall } from '../call.ts';
import { metaRev } from '../state.ts';

type Parts = typeof import('./CallRoom.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

/** The room's chunk: the parts once here, `failed` when the last try could not load it, and `retry`. */
function useRoomParts(want: boolean): { parts: Parts | null; failed: boolean; retry: () => void } {
  const [m, setM] = useState(parts);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!want || m) return;
    setFailed(false);
    (loading ??= import('./CallRoom.tsx').then(
      (x) => (parts = x),
      (e) => {
        loading = null;
        throw e;
      },
    )).then(setM, () => setFailed(true));
  }, [want, tries]);
  return { parts: m, failed, retry: () => setTries((n) => n + 1) };
}

/** Conversations switched to their chat while their room is on (narrow panes; this tab, this call only). */
const toChat = signal<ReadonlySet<string>>(new Set());
// A call over (or none): the next room opens as a room again.
effect(() => {
  const a = activeCall.value;
  if ((!a || a.phase === 'ended') && toChat.peek().size) toChat.value = new Set();
});

function setRoomShown(conversationId: string, room: boolean) {
  const next = new Set(toChat.value);
  if (room) next.delete(conversationId);
  else next.add(conversationId);
  toChat.value = next;
}

/** The call in this conversation when it is a room you are in: a stage, joined and not over. */
export function roomCall(c: P.ConversationView): ActiveCall | null {
  const call = activeCall.value;
  return call && call.conversationId === c.id && call.phase !== 'ended' && (c.variant === 'stage' || !!call.stage) ? call : null;
}

/** A room with a chat of its own (a stage channel's text chat) has it beside the room; one without has only the room. */
export function roomHasChat(c: P.ConversationView): boolean {
  return c.variant === 'stage' || c.variant === 'voice';
}

/** Which of the two a narrow pane shows. */
export function roomSide(c: P.ConversationView): 'room' | 'chat' {
  return toChat.value.has(c.id) ? 'chat' : 'room';
}

/** Room / Chat, above a narrow pane while a room is on (hidden by CSS on a wide one, where both show). Room counts the requests a moderator has. */
export function RoomSwitch({ c }: { c: P.ConversationView }) {
  metaRev.value; // the account's abilities, which say who you may invite, change without `call` changing
  const call = roomCall(c);
  if (!call || !roomHasChat(c)) return null;
  const room = roomSide(c) === 'room';
  const asks = roomRequests(call).length;
  return (
    <div class="room-switch" role="group" aria-label="Show">
      <button aria-pressed={room} class={room ? 'on' : ''} onClick={() => setRoomShown(c.id, true)} data-track="room switch room">
        Room
        {asks > 0 && (
          <span class="room-switch-count" aria-label={`, ${asks} asking to speak`}>
            {asks}
          </span>
        )}
      </button>
      <button aria-pressed={!room} class={!room ? 'on' : ''} onClick={() => setRoomShown(c.id, false)} data-track="room switch chat">
        Chat
      </button>
    </div>
  );
}

/** The room itself, once its chunk is here. */
export function CallRoomLazy({ c }: { c: P.ConversationView }) {
  const call = roomCall(c);
  const { parts: m, failed, retry } = useRoomParts(!!call);
  if (!call) return null;
  const Room = m?.CallRoom;
  if (Room) return <Room call={call} />;
  return (
    <div class="room-loading" role="status">
      {failed ? (
        <>
          <span>The room could not load.</span>
          <button class="chip-btn" onClick={retry} data-track="room retry">
            Try again
          </button>
        </>
      ) : (
        'Opening the room…'
      )}
    </div>
  );
}
