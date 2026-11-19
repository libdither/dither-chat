/**
 * The room view's way in (docs/calls.md "The room view"): on a stage you are in, the room is the conversation's page,
 * with a Room / Chat switch above it; the room itself (CallRoom.tsx) is a chunk of its own, loaded the first time.
 */
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { activeCall, type ActiveCall } from '../call.ts';

type Parts = typeof import('./CallRoom.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

function useRoomParts(want: boolean): Parts | null {
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (!want || m) return;
    (loading ??= import('./CallRoom.tsx').then(
      (x) => (parts = x),
      (e) => {
        loading = null;
        throw e;
      },
    )).then(setM, () => {});
  }, [want]);
  return m;
}

/** Conversations switched to their chat while their room is on (this tab only). */
const toChat = signal<ReadonlySet<string>>(new Set());

function setRoomShown(conversationId: string, room: boolean) {
  const next = new Set(toChat.value);
  if (room) next.delete(conversationId);
  else next.add(conversationId);
  toChat.value = next;
}

/** The call in this conversation when it is a room you are in: a stage, joined and not over. */
export function roomCall(c: P.ConversationView): ActiveCall | null {
  const call = activeCall.value;
  return call && call.conversationId === c.id && call.phase !== 'ended' && c.variant === 'stage' ? call : null;
}

/** The room shows instead of the chat, unless switched away. */
export function roomShown(c: P.ConversationView): boolean {
  return !!roomCall(c) && !toChat.value.has(c.id);
}

/** Room / Chat, above the page while a room is on. */
export function RoomSwitch({ c }: { c: P.ConversationView }) {
  if (!roomCall(c)) return null;
  const room = roomShown(c);
  return (
    <div class="room-switch" role="tablist" aria-label="Show">
      <button role="tab" aria-selected={room} class={room ? 'on' : ''} onClick={() => setRoomShown(c.id, true)} data-track="room switch room">
        Room
      </button>
      <button role="tab" aria-selected={!room} class={!room ? 'on' : ''} onClick={() => setRoomShown(c.id, false)} data-track="room switch chat">
        Chat
      </button>
    </div>
  );
}

/** The room itself, once its chunk is here. */
export function CallRoomLazy({ c }: { c: P.ConversationView }) {
  const call = roomCall(c);
  const Room = useRoomParts(!!call)?.CallRoom;
  if (!call) return null;
  return Room ? <Room call={call} onChat={() => setRoomShown(c.id, false)} /> : <div class="room-loading">Opening the room…</div>;
}
