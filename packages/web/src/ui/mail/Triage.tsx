/**
 * A mail message's tier in the reader (slice 9, docs/mail.md "Triage and notifications"): why triage put it where it
 * did, its importance, and "Less like this", the one mark mail takes, as a chat message's bell has them.
 */
import type * as P from '@dither-chat/protocol';
import { isTier } from '../../marks.ts';
import { menuPoint, openMenu, type MenuSpec } from '../ContextMenu.tsx';
import { TriageWhy } from '../Marks.tsx';
import type { MessageAction } from './slots.tsx';

function spec(m: P.MailMessageView): MenuSpec | null {
  if (!m.triage) return null;
  return { label: 'Notification', items: [{ kind: 'row', render: (close) => <TriageWhy m={m} onDone={close} /> }] };
}

/** Under a message triage decided on: its tier, which opens the why and the mark. */
export const TRIAGE_MESSAGE_ACTIONS: MessageAction[] = [
  {
    id: 'triage',
    label: 'Notification',
    icon: 'bell',
    show: (m) => !!m.triage && isTier(m.triage.decision),
    run: (m) => {
      const p = menuPoint();
      openMenu({ x: Math.max(8, p.x - 160), y: p.y + 8 }, spec(m));
    },
  },
];
