/** Plans from dither-calendar under messages (plans.ts, docs/calendar.md): which chip shows, and the store by message. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { applyPlanEvent, calendarFromBootstrap, calendarLink, chipOf, patchPlan, planByMessage, planWhen, plansRev } from '../src/plans.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const H = 3_600_000;
const plan = (over: Partial<P.CalendarPlanView> = {}): P.CalendarPlanView => ({
  id: 'prp_1',
  conversationId: 'cnv_1',
  messageId: 'msg_said',
  lastMessageId: 'msg_last',
  title: 'Dinner',
  location: "Luigi's",
  allDay: false,
  startAt: NOW + 50 * H,
  endAt: NOW + 52 * H,
  startDate: null,
  endDate: null,
  timeZone: 'Europe/Berlin',
  state: 'suggested',
  change: null,
  verdict: 'suggest',
  event: null,
  open: '#/chats',
  updatedAt: NOW,
  ...over,
});

test('the chip for each state', () => {
  expect(chipOf(plan(), NOW)).toBe('suggest');
  expect(chipOf(plan({ state: 'added' }), NOW)).toBe('added');
  expect(chipOf(plan({ state: 'added', change: 'moved' }), NOW)).toBe('moved');
  expect(chipOf(plan({ state: 'added', change: 'cancelled' }), NOW)).toBe('calledOff');
  expect(chipOf(plan({ state: 'cancelled' }), NOW)).toBe('cancelled');
  expect(chipOf(plan({ state: 'dismissed' }), NOW)).toBeNull();
});

test('a suggestion more than a day past shows nothing; one just past, or added and past, still shows', () => {
  expect(chipOf(plan({ startAt: NOW - 30 * H, endAt: NOW - 29 * H }), NOW)).toBeNull();
  expect(chipOf(plan({ startAt: NOW - 20 * H, endAt: NOW - 19 * H }), NOW)).toBe('suggest');
  expect(chipOf(plan({ state: 'added', startAt: NOW - 90 * H, endAt: NOW - 89 * H }), NOW)).toBe('added');
  // All day: the whole day counts.
  expect(chipOf(plan({ allDay: true, startAt: null, endAt: null, startDate: '2026-11-10' }), NOW)).toBe('suggest');
  expect(chipOf(plan({ allDay: true, startAt: null, endAt: null, startDate: '2026-11-09' }), NOW)).toBeNull();
});

test('the time, as the chip says it', () => {
  expect(planWhen({ allDay: false, startAt: Date.parse('2026-11-14T18:00:00Z'), startDate: null }, 'Europe/Berlin')).toBe('Sat 14 Nov 19:00');
  expect(planWhen({ allDay: true, startAt: null, startDate: '2026-11-14' })).toBe('Sat 14 Nov');
});

test('plans by the message that named the time; a replace drops the rest; the answer shows at once', () => {
  expect(calendarFromBootstrap({})).toBe(false);
  expect(calendarFromBootstrap({ calendar: { path: '/calendar/', reachable: true, waiting: 2 } })).toBe(true);
  expect(calendarLink.value).toEqual({ path: '/calendar/', reachable: true, waiting: 2 });
  const rev = plansRev.value;
  applyPlanEvent({ t: 'plans', plans: [plan(), plan({ id: 'prp_2', messageId: 'msg_other' })], replace: true });
  expect(plansRev.value).toBeGreaterThan(rev);
  expect(planByMessage.get('msg_said')?.id).toBe('prp_1');
  expect(planByMessage.has('msg_last')).toBe(false);
  // Read again, it now names another message: the old one shows nothing.
  applyPlanEvent({ t: 'plans', plans: [plan({ messageId: 'msg_moved', updatedAt: NOW + 1 })] });
  expect(planByMessage.has('msg_said')).toBe(false);
  expect(planByMessage.get('msg_moved')?.id).toBe('prp_1');
  patchPlan('prp_1', { id: 'prp_1', state: 'added', change: null, title: 'Dinner', allDay: false, startAt: NOW + 50 * H, endAt: NOW + 52 * H, startDate: null, endDate: null, location: null, updatedAt: NOW + 2 });
  expect(chipOf(planByMessage.get('msg_moved')!, NOW)).toBe('added');
  applyPlanEvent({ t: 'plans', plans: [plan({ id: 'prp_3', messageId: 'msg_3' })], replace: true });
  expect([...planByMessage.keys()]).toEqual(['msg_3']);
  applyPlanEvent({ t: 'calendar', reachable: false, waiting: 0 });
  expect(calendarLink.value).toEqual({ path: '/calendar/', reachable: false, waiting: 0 });
});

test('the calendar comes and goes with its account: off drops the plans and the link, the next event brings it back', async () => {
  const plans = await import('../src/plans.ts');
  expect(calendarFromBootstrap({ calendar: { path: '/calendar/', reachable: true, waiting: 1 } })).toBe(false);
  expect(plans.calendarOn).toBe(true);
  applyPlanEvent({ t: 'plans', plans: [plan({ id: 'prp_9', messageId: 'msg_9' })], replace: true });
  expect(applyPlanEvent({ t: 'calendar', reachable: false, waiting: 0, off: true })).toBe(false);
  expect(plans.calendarOn).toBe(false);
  expect(calendarLink.value).toBeNull();
  expect(planByMessage.size).toBe(0);
  // Back: on again, and the caller is told to read its plans.
  expect(applyPlanEvent({ t: 'calendar', reachable: false, waiting: 0 })).toBe(true);
  expect(plans.calendarOn).toBe(true);
  expect(calendarLink.value).toEqual({ path: '/calendar/', reachable: false, waiting: 0 });
  expect(applyPlanEvent({ t: 'calendar', reachable: true, waiting: 3 })).toBe(false);
  // A bootstrap from a hub whose calendar account went turns it off too.
  expect(calendarFromBootstrap({})).toBe(false);
  expect(plans.calendarOn).toBe(false);
});
