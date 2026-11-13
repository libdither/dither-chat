/**
 * Plans dither-calendar found in chats (docs/calendar.md), kept by message so a chip can show under the message that
 * named the time. A hub without a calendar account sends no `calendar` in its bootstrap: then `calendarOn` stays false,
 * nothing here is asked for, and the timeline draws nothing more per message.
 *
 * Imports nothing of state.ts: state.ts calls in (applyBootstrap, the socket opening, events).
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';

/**
 * Whether the hub has a calendar (an enabled calendar account): from the bootstrap, then the `calendar` events, which
 * turn it on and (`off`) off again when the account comes or goes. Anything drawn per message reads it as a plain value;
 * what reads `calendarLink` (the rail, the tab bar) follows at once.
 */
export let calendarOn = false;
/** Plans changed: a chip reads this, not the message row (docs/perf.md). */
export const plansRev = signal(0);
/** Whether the hub reaches the calendar, and how many plans wait there (the rail's dot). */
export const calendarLink = signal<P.CalendarLinkView | null>(null);

const byId = new Map<string, P.CalendarPlanView>();
/** The plan under each message (its messageId: the message that named the time). */
export const planByMessage = new Map<string, P.CalendarPlanView>();

/** Plans in, as a whole list (`replace`) or as changes. */
export function putPlans(plans: P.CalendarPlanView[], replace = false) {
  if (replace) {
    byId.clear();
    planByMessage.clear();
  }
  for (const p of plans) {
    const old = byId.get(p.id);
    if (old && old.messageId !== p.messageId && planByMessage.get(old.messageId)?.id === p.id) planByMessage.delete(old.messageId);
    byId.set(p.id, p);
    // Two plans named in one message: the one changed last shows.
    const there = planByMessage.get(p.messageId);
    if (!there || there.id === p.id || there.updatedAt <= p.updatedAt) planByMessage.set(p.messageId, p);
  }
  plansRev.value++;
}

/** What accept or dismiss answered, shown at once; the `plans` event that follows settles it. */
export function patchPlan(id: string, a: P.CalendarProposalAnswer) {
  const p = byId.get(id);
  if (!p) return;
  putPlans([{ ...p, state: a.state, change: a.change, title: a.title, allDay: a.allDay, startAt: a.startAt, endAt: a.endAt, startDate: a.startDate, endDate: a.endDate, location: a.location, updatedAt: Math.max(p.updatedAt, a.updatedAt ?? 0) }]);
}

export function setCalendarLink(v: P.CalendarLinkView | null) {
  const cur = calendarLink.value;
  if (v && cur && cur.reachable === v.reachable && cur.waiting === v.waiting) return;
  calendarLink.value = v;
}

/** The calendar account went: no pane, tab or chips until one comes back. */
function calendarGone() {
  if (!calendarOn) return;
  calendarOn = false;
  putPlans([], true);
  calendarLink.value = null;
}

/** A bootstrap (the hub's, or the snapshot's) is in. Returns true when it turns the calendar on; one without a calendar turns it off. */
export function calendarFromBootstrap(b: { calendar?: P.CalendarLinkView }): boolean {
  if (!b.calendar) {
    calendarGone();
    return false;
  }
  const was = calendarOn;
  calendarOn = true;
  setCalendarLink(b.calendar);
  return !was;
}

/** A `plans` or `calendar` event. Returns true when it turns the calendar on (the caller asks for its plans). */
export function applyPlanEvent(ev: P.ClientEvent): boolean {
  if (ev.t === 'plans') putPlans(ev.plans, !!ev.replace);
  else if (ev.t === 'calendar') {
    if (ev.off) {
      calendarGone();
      return false;
    }
    const was = calendarOn;
    calendarOn = true;
    // A new link value even when only `calendarOn` changed, so what draws the calendar's entries looks again.
    if (!was) calendarLink.value = { path: '/calendar/', reachable: ev.reachable, waiting: ev.waiting };
    else setCalendarLink({ path: '/calendar/', reachable: ev.reachable, waiting: ev.waiting });
    return !was;
  }
  return false;
}

let loading: Promise<void> | null = null;
/** The hub's cache of plans, whole: on a calendar hub, when the live socket (re)opens and on a resync. */
export function loadPlans(): Promise<void> {
  if (!calendarOn) return Promise.resolve();
  return (loading ??= fetch('/api/plans')
    .then(async (r) => {
      if (!r.ok) return;
      const v = (await r.json()) as P.PlansView;
      putPlans(v.plans, true);
      setCalendarLink({ path: '/calendar/', reachable: v.reachable, waiting: v.waiting });
    })
    .catch(() => {})
    .finally(() => (loading = null)));
}

// ------------------------------------------------------------------ the chip

export type Chip = 'suggest' | 'added' | 'moved' | 'calledOff' | 'cancelled';

const DAY = 86_400_000;

/** When a plan ends, as an instant: its end, else its start; an all-day one at the end of its last day (UTC). */
function endOf(p: Pick<P.CalendarPlanView, 'allDay' | 'startAt' | 'endAt' | 'startDate' | 'endDate'>): number | null {
  if (!p.allDay) return p.endAt ?? p.startAt;
  const d = p.endDate ?? p.startDate;
  const t = d ? Date.parse(`${d}T00:00:00Z`) : NaN;
  if (Number.isNaN(t)) return null;
  // Google's end date is exclusive; a single date is that whole day.
  return p.endDate ? t : t + DAY;
}

/** What a plan's chip shows, or null for none: dismissed, or a suggestion more than a day past. */
export function chipOf(p: P.CalendarPlanView, now: number): Chip | null {
  switch (p.state) {
    case 'dismissed':
      return null;
    case 'cancelled':
      return 'cancelled';
    case 'suggested': {
      const end = endOf(p);
      return end !== null && end < now - DAY ? null : 'suggest';
    }
    case 'added':
      return p.change === 'moved' ? 'moved' : p.change === 'cancelled' ? 'calledOff' : 'added';
  }
  return null;
}

/** "Fri 14 Nov 19:00", or "Fri 14 Nov" all day, in this device's zone (an all-day date is the same everywhere). */
export function planWhen(p: { allDay: boolean; startAt: number | null; startDate: string | null }, timeZone?: string): string {
  if (p.allDay || p.startAt === null) {
    if (!p.startDate) return '';
    return new Date(`${p.startDate}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
  }
  const d = new Date(p.startAt);
  const date = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).replace(',', '');
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
  return `${date} ${time}`;
}

/** The chat app's route for a calendar hash ("#/day/2026-11-14" -> "day/2026-11-14"). */
export const calendarAt = (open: string) => open.replace(/^#\/?/, '');
