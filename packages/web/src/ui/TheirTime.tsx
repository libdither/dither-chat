/**
 * A message's times (docs/profile.md "Their time"): yours, and beside it the author's own when their clock is known
 * and differs from yours (theirclock.ts), "~" before a guessed one and a moon while it is night for them. Pointing at
 * either for a moment shows their usual day (TheirDay.tsx, a chunk of its own loaded the first time), in that time; a
 * click on theirs, or a tap on a phone, keeps it open.
 */
import type * as P from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { clock } from '../format.ts';
import { clockOf, clocksRev, theirTimeAt } from '../theirclock.ts';
import { Icon } from './icons.tsx';

export interface DayCard {
  el: HTMLElement;
  identityId: string;
  name: string;
  ts: number;
  frame: 'theirs' | 'yours';
  /** Opened by a click or a tap: it stays until closed, and back closes it. */
  pinned: boolean;
  /** Opened from your message waiting on their answer (ui/Typing.tsx): the card leads with when it is likely to come. */
  answer?: boolean;
}

const dayCard = signal<DayCard | null>(null);

type Parts = typeof import('./TheirDay.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;
const load = () =>
  (loading ??= import('./TheirDay.tsx').then(
    (m) => (parts = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));

let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
/** How long the pointer rests on a time before its card shows, and how long it may be away before it goes. */
const SHOW_MS = 350;
const HIDE_MS = 220;

function enter(e: PointerEvent, card: Omit<DayCard, 'el' | 'pinned'>) {
  if (e.pointerType === 'touch') return;
  clearTimeout(hideTimer);
  if (dayCard.value?.pinned) return;
  const el = e.currentTarget as HTMLElement;
  void load().catch(() => {});
  clearTimeout(showTimer);
  showTimer = setTimeout(() => (dayCard.value = { ...card, el, pinned: false }), dayCard.value ? 0 : SHOW_MS);
}

/** The pointer left a time or the card: it goes soon, unless it comes back or the card was opened by a click. */
export function leaveCard() {
  clearTimeout(showTimer);
  if (dayCard.value?.pinned) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => (dayCard.value = null), HIDE_MS);
}
export const stayCard = () => clearTimeout(hideTimer);

function pin(e: MouseEvent, card: Omit<DayCard, 'el' | 'pinned'>) {
  e.stopPropagation();
  clearTimeout(showTimer);
  const el = e.currentTarget as HTMLElement;
  void load()
    .then(() => (dayCard.value = { ...card, el, pinned: true }))
    .catch(() => {});
}

/** Pointer handlers that show the author's day for a time: none on a touch screen, nor for your own messages. */
export function dayHover(m: P.MessageView, name: string, frame: DayCard['frame']) {
  const id = m.authorId;
  if (!id) return {};
  return { onPointerEnter: (e: PointerEvent) => enter(e, { identityId: id, name, ts: m.ts, frame }), onPointerLeave: leaveCard };
}

/** Something that shows someone's day for a time when pointed at, and keeps it open when clicked, as their times do. */
export function dayCardProps(card: Omit<DayCard, 'el' | 'pinned'>) {
  return { onPointerEnter: (e: PointerEvent) => enter(e, card), onPointerLeave: leaveCard, onClick: (e: MouseEvent) => pin(e, card) };
}

/** A message head's times: yours, then theirs where it differs. `hover`: a pointer to show cards with. */
export function TimeStamps({ m, name, hover }: { m: P.MessageView; name: string; hover: boolean }) {
  clocksRev.value;
  const id = m.authorId!;
  const c = clockOf(id);
  const t = c ? theirTimeAt(c, m.ts) : null;
  const card = { identityId: id, name, ts: m.ts };
  return (
    <>
      <span class="msg-time" {...(hover ? dayHover(m, name, 'yours') : {})}>
        {clock(m.ts)}
      </span>
      {t && (
        <button
          type="button"
          class={`msg-their-time${t.guessed ? ' guessed' : ''}`}
          aria-label={`${t.text} for ${name}${t.guessed ? ', a guess' : ''}: when they are usually around`}
          {...(hover ? dayHover(m, name, 'theirs') : {})}
          onClick={(e) => pin(e, { ...card, frame: 'theirs' })}
        >
          {t.night && <Icon name="moon" size={10} />}
          {t.guessed ? '~' : ''}
          {t.text}
        </button>
      )}
    </>
  );
}

/** Which of the timelines' hosts draws the card: the first mounted, while it is. */
let owner: object | null = null;

/** The card's mount, in each timeline; only one of them draws it. Nothing until a card is asked for. */
export function TheirDayHost() {
  const [me] = useState(() => ({}));
  useEffect(
    () => () => {
      if (owner === me) owner = null;
    },
    [],
  );
  // Read always, so a host left after the drawing one goes takes over at the next card.
  const card = dayCard.value;
  const c = (owner ??= me) === me ? card : null;
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (c && !m) load().then(setM, () => {});
  }, [c]);
  // A card whose time scrolled away or left the page goes with it.
  useEffect(() => {
    if (!c) return;
    const gone = (e: Event) => {
      const t = e.target as Node | null;
      if (t instanceof Element && t.closest('.their-day')) return;
      dayCard.value = null;
    };
    document.addEventListener('scroll', gone, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', gone, { capture: true });
  }, [c]);
  return c && m ? <m.TheirDay card={c} onClose={() => (dayCard.value = null)} /> : null;
}
