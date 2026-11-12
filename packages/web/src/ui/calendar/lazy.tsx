/**
 * The chip under a message that made a plan (docs/calendar.md). What the main bundle carries is only this: a component
 * that reads the plans' own signal and draws nothing when its message has no plan. The card is a chunk of its own,
 * loaded the first time a plan shows (as Mail's screens are, ui/mail/lazy.tsx).
 *
 * The message row does not read `plansRev`: only these do, so a change to plans draws the chips again, not the rows.
 */
import { useEffect, useState } from 'preact/hooks';
import { chipOf, planByMessage, plansRev } from '../../plans.ts';

type Card = typeof import('./PlanChip.tsx');
let card: Card | null = null;
let loading: Promise<Card> | null = null;

function loadCard(): Promise<Card> {
  return (loading ??= import('./PlanChip.tsx').then(
    (m) => (card = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

export function PlanChipLazy({ messageId }: { messageId: string }) {
  plansRev.value;
  const plan = planByMessage.get(messageId);
  const chip = plan ? chipOf(plan, Date.now()) : null;
  const [m, setM] = useState(card);
  useEffect(() => {
    if (chip && !m) loadCard().then(setM, () => {});
  }, [!!chip]);
  if (!plan || !chip || !m) return null;
  return <m.PlanChip plan={plan} chip={chip} />;
}
