/**
 * A mail message's notification level in the reader (slice 9, docs/mail.md "Triage and notifications"): why triage
 * put it where it did, its three chances, and the four levels to vote it to, as a chat message's bell has them.
 */
import type * as P from '@dither-chat/protocol';
import { TIER_LABEL } from '@dither-chat/protocol';
import { menuPoint, openMenu, type MenuSpec } from '../ContextMenu.tsx';
import { TierPicker, TriageChances, triageHeading } from '../TierVote.tsx';
import type { MessageAction } from './slots.tsx';

function spec(m: P.MailMessageView): MenuSpec | null {
  const t = m.triage;
  if (!t) return null;
  return {
    label: 'Notification',
    items: [
      {
        kind: 'row',
        render: (close) => (
          <div class="triage-pop">
            <div class="menu-title">{triageHeading(t.decision)}</div>
            <ul>
              {t.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            {t.probs && <TriageChances p={t.probs} />}
            <TierPicker m={m} onDone={close} />
          </div>
        ),
      },
    ],
  };
}

const levelOf = (t: P.TriageView) => (t.feedback ?? t.decision) as P.NotifyTier;

/** Under a message triage decided on: its level, which opens the why and the vote. */
export const TRIAGE_MESSAGE_ACTIONS: MessageAction[] = [
  {
    id: 'triage',
    label: 'Notification',
    icon: 'bell',
    show: (m) => !!m.triage && m.triage.decision !== 'silent' && !!TIER_LABEL[levelOf(m.triage)],
    run: (m) => {
      const p = menuPoint();
      openMenu({ x: Math.max(8, p.x - 160), y: p.y + 8 }, spec(m));
    },
  },
];
