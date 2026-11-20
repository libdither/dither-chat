/**
 * The video window's places on a page (docs/calls.md "The video window"), in the startup chunk so a page can make room
 * for the window before its own chunk (CallWindow.tsx) is here. The call's own chat has a slot under its header: the
 * docked window's strip, the whole page for Fill, or (floating) only a mark of where dragging it docks. A room has one
 * where its speakers go (CallRoom.tsx). No other page has one, so the window never docks onto Settings or another chat.
 * The window's choices are kept on this device.
 */
import { computed, signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { activeCall, callMedia } from '../call.ts';
import { type Place, placeFor, type SlotKind, type WindowChoices } from '../callLayout.ts';
import { phone } from '../phone.ts';
import { callBarOn, isCallChat } from './CallBar.tsx';
import type { MenuEntry } from './ContextMenu.tsx';

const KEY = 'dither-chat:call-window';
function read(): WindowChoices {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** The window's choices on this device: each absent until picked (Auto). */
export const winChoices = signal<WindowChoices>(read());

/** Keep these choices; `undefined` goes back to Auto. */
export function chooseWin(c: { [K in keyof WindowChoices]?: WindowChoices[K] | undefined }) {
  const next: WindowChoices = { ...winChoices.value };
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined) delete next[k as keyof WindowChoices];
    else (next as Record<string, unknown>)[k] = v;
  }
  winChoices.value = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
}

/** Where the window is on a page with this slot (callLayout.ts placeFor). */
export function winPlace(kind: SlotKind | null): Place | null {
  return placeFor(winChoices.value.place, kind, phone.value);
}

/** The call has video, either way: the window shows on any page (a room shows it without video too). */
export const callHasVideo = computed(() => {
  const call = activeCall.value;
  const m = callMedia.value;
  if (!call || call.phase === 'ended') return false;
  return !!m.camera || !!m.screen || call.video.some((v) => m.slots.has(v.slot));
});

/** The slot on the page on screen, if it has one. */
export const winSlot = signal<{ el: HTMLElement; kind: SlotKind } | null>(null);
/** The element the window is in now (a slot), or null while it floats. */
export const winIn = signal<HTMLElement | null>(null);
/** The docked strip's height while its divider is dragged. */
export const liveDockH = signal<number | null>(null);
/** The window carries the call's buttons (a phone): the dock's strip steps aside for it. */
export const winControls = signal(false);
/** A room's say on its speakers' tiles: the rank under each name, and a moderator's moves on them. */
export const roomTiles = signal<{ role(id: string): string | undefined; moves(id: string): MenuEntry[] } | null>(null);

/** Says this element is the page's slot while it is on screen. */
function useWinSlot(kind: SlotKind) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    winSlot.value = { el, kind };
    return () => {
      if (winSlot.peek()?.el === el) winSlot.value = null;
    };
  }, [kind]);
  return ref;
}

/**
 * The call is going on in this conversation, it has video, and the conversation is the page (on a phone it may only
 * peek beside the lists, with the call bar up: then the bar is the call).
 */
function windowHere(c: P.ConversationView): boolean {
  const call = activeCall.value;
  return !!call && call.phase !== 'ended' && isCallChat(c.id, call.conversationId) && callHasVideo.value && !(phone.value && callBarOn.value);
}

/** The window fills this chat's page (Fill): the page shows only its header and the window. */
export function fillsPage(c: P.ConversationView): boolean {
  return windowHere(c) && winPlace('page') === 'fill';
}

/** Under the call's own chat's header: the window's slot. */
export function CallSlot({ c }: { c: P.ConversationView }) {
  if (!windowHere(c)) return null;
  return <PageSlot />;
}

function PageSlot() {
  const ref = useWinSlot('page');
  const place = winPlace('page');
  const h = place === 'dock' ? (liveDockH.value ?? winChoices.value.dockH) : undefined;
  return <div ref={ref} class={`call-slot ${place} ${liveDockH.value !== null ? 'live' : ''}`} style={h ? { height: `${h}px` } : undefined} />;
}

/** A room's speakers: the window's slot, with `fallback` (their faces) while the window is elsewhere or loading. */
export function RoomSlot({ fallback, label }: { fallback: ComponentChildren; label: string }) {
  const ref = useWinSlot('room');
  const inside = !!ref.current && winIn.value === ref.current;
  return (
    <div ref={ref} class={`croom-slot ${inside ? 'filled' : ''}`} role="group" aria-label={label}>
      {!inside && fallback}
    </div>
  );
}
