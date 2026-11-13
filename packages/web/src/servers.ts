/** A server's page beyond its settings (ui/ServerParts.tsx, docs/servers.md): the words and checks it shows. */
import type * as P from '@dither-chat/protocol';

/** "Every week", "Every 2 weeks", "Repeats" for a rule this does not put in words; null for once. */
export function repeatText(rrule: string | null): string | null {
  if (!rrule) return null;
  const f = /FREQ=(\w+)/.exec(rrule)?.[1];
  const n = Number(/INTERVAL=(\d+)/.exec(rrule)?.[1] ?? 1);
  const unit = f === 'DAILY' ? 'day' : f === 'WEEKLY' ? 'week' : f === 'MONTHLY' ? 'month' : f === 'YEARLY' ? 'year' : null;
  if (!unit) return 'Repeats';
  return n > 1 ? `Every ${n} ${unit}s` : `Every ${unit}`;
}

/** Whether the answer so far may be sent: the rules ticked, required questions answered, required prompts picked. */
export function gateReady(g: P.SpaceGate, agree: boolean, answers: Record<string, string | number>, picks: ReadonlySet<string>): boolean {
  if (g.kind === 'onboarding') return (g.prompts ?? []).every((p) => !p.required || p.options.some((o) => picks.has(o.id)));
  return (!g.rules?.length || agree) && (g.questions ?? []).every((q) => !q.required || String(answers[q.id] ?? '').trim() !== '');
}

/** Called-off occurrences still to come, for "2 called off". */
export function calledOff(e: Pick<P.ScheduledEventView, 'exceptions'>, now: number): number {
  return e.exceptions.filter((x) => x.cancelled && x.original > now).length;
}
