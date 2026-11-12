/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * The card for a plan under the message that named its time (docs/calendar.md): a suggestion to add, what is on your
 * calendar, a move or a cancellation the chat made since. Its buttons answer the calendar through the hub
 * (/calendar/api/proposals/:id/accept|dismiss), show the answer at once, and the `plans` event that follows settles it.
 */
// Classic JSX (the pragmas above): preact's own `h`, so this chunk needs no jsx-runtime chunk split off the app's start.
import { Fragment, h, type ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { calendarAt, patchPlan, planWhen, type Chip } from '../../plans.ts';
import { go, toast } from '../../state.ts';

async function answer(plan: P.CalendarPlanView, how: 'accept' | 'dismiss') {
  const res = await fetch(`/calendar/api/proposals/${encodeURIComponent(plan.id)}/${how}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const text = await res.text();
  const data = res.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? (text.slice(0, 160) || `${res.status}`));
  patchPlan(plan.id, data as P.CalendarProposalAnswer);
}

const open = (plan: P.CalendarPlanView) => go({ view: 'calendar', at: calendarAt(plan.open) });

export function PlanChip({ plan, chip }: { plan: P.CalendarPlanView; chip: Chip }) {
  const [busy, setBusy] = useState(false);
  const act = (how: 'accept' | 'dismiss') => async (e: Event) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await answer(plan, how);
    } catch (err) {
      toast({ kind: 'error', title: 'The calendar did not take that', body: String((err as Error).message) });
    } finally {
      setBusy(false);
    }
  };
  const ev = plan.event;
  const place = plan.location ?? ev?.location ?? null;
  const btn = (how: 'accept' | 'dismiss', label: string, track: string, primary = false) => (
    <button class={`plan-btn ${primary ? 'primary' : ''}`} data-track={`plan chip: ${track}`} disabled={busy} onClick={act(how)}>
      {label}
    </button>
  );
  let text: ComponentChildren;
  let actions: ComponentChildren = null;
  switch (chip) {
    case 'suggest':
      text = (
        <>
          <b>{plan.title}</b>
          <span>{planWhen(plan)}</span>
          {place && <span>{place}</span>}
        </>
      );
      actions = (
        <>
          {btn('accept', 'Add', 'add', true)}
          {btn('dismiss', 'Dismiss', 'dismiss')}
        </>
      );
      break;
    case 'added':
      text = (
        <>
          <span>On your calendar</span>
          <b>{ev?.title ?? plan.title}</b>
          <span>{planWhen(ev ?? plan)}</span>
        </>
      );
      break;
    case 'moved':
      text = (
        <>
          <b>{ev?.title ?? plan.title}</b>
          <span>Moved to {planWhen(plan)}</span>
        </>
      );
      actions = (
        <>
          {btn('accept', 'Move it', 'move', true)}
          {btn('dismiss', 'Keep', 'keep time')}
        </>
      );
      break;
    case 'calledOff':
      text = (
        <>
          <b>{ev?.title ?? plan.title}</b>
          <span>Called off</span>
        </>
      );
      actions = (
        <>
          {btn('accept', 'Remove', 'remove', true)}
          {btn('dismiss', 'Keep', 'keep event')}
        </>
      );
      break;
    case 'cancelled':
      text = (
        <>
          <b>{plan.title}</b>
          <span>Called off</span>
        </>
      );
      break;
  }
  return (
    <div class={`plan-chip ${chip}`} role="group" aria-label="Plan from this chat">
      <button class="plan-open" data-track={`plan chip: open (${chip})`} title="Open in Calendar" onClick={() => open(plan)} style={ev?.color ? ({ '--plan-color': ev.color } as any) : undefined}>
        {/* The calendar icon drawn here, not from icons.tsx: this chunk then shares no extra chunk with the app's start. */}
        <svg class="icon" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect width="18" height="18" x="3" y="4" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        {text}
      </button>
      {actions && <span class="plan-actions">{actions}</span>}
    </div>
  );
}
