/**
 * The line under a send not yet in its chat (docs/sync.md "The send queue"): its mark (a clock while only this device
 * has it, one tick once the hub has it, two once the network named the message), what it is doing, and what you can
 * do about it. A held send (the chat moved on while it waited) shows Send, Edit and Cancel, and its countdown while a
 * device shows the chat; one in doubt shows Send again and Discard; one refused shows Try again and Discard.
 */
import { useEffect, useState } from 'preact/hooks';
import { refill } from '../mail/chats.ts';
import { sendNote, type ShownSend } from '../sendrows.ts';
import { discardSend, hubSends, retrySend, sendAction } from '../state.ts';
import { Icon } from './icons.tsx';

const hubNow = () => Date.now() + hubSends.value.offset;
let refills = 0;

/** The mark itself, with what it means as its title. */
function Mark({ s }: { s: ShownSend }) {
  const [icon, title] =
    s.mark === 'device'
      ? (['clock', 'Only on this device so far'] as const)
      : s.mark === 'hub'
        ? (['check', 'The hub has it'] as const)
        : s.mark === 'network'
          ? (['checks', 'Sent: the network has it'] as const)
          : s.mark === 'held'
            ? (['pause', 'Held for you'] as const)
            : s.mark === 'unsure'
              ? (['alert', 'May have been sent'] as const)
              : (['alert', 'Not sent'] as const);
  return (
    <span class={`send-mark ${s.mark}`} title={title} aria-label={title}>
      <Icon name={icon} size={12} />
    </span>
  );
}

export function PendingNote({ s }: { s: ShownSend }) {
  // A countdown redraws every second while it runs.
  const [, tick] = useState(0);
  useEffect(() => {
    if (s.holdUntil === undefined) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [s.holdUntil]);
  const now = hubNow();
  const act = (a: 'send' | 'cancel' | 'edit') =>
    void sendAction(s.key, a, (row) => (refill.value = { place: row.conversationId, text: row.body, seq: ++refills, append: true }));
  return (
    <span class="pending-line">
      <Mark s={s} />
      <span class="pending-note">{sendNote(s, now)}</span>
      {s.mark === 'held' && (
        <span class="pending-actions">
          <button class="btn ghost small" onClick={() => act('send')}>
            Send
          </button>
          <button class="btn ghost small" onClick={() => act('edit')} title={s.files.length ? 'Its files are not put back: attach them again' : undefined}>
            Edit
          </button>
          <button class="btn ghost small" onClick={() => act('cancel')}>
            Cancel
          </button>
        </span>
      )}
      {(s.mark === 'unsure' || s.mark === 'failed') && (
        <span class="pending-actions">
          <button class="btn ghost small" onClick={() => (s.from === 'device' ? retrySend(s.key) : act('send'))}>
            {s.mark === 'unsure' ? 'Send again' : 'Try again'}
          </button>
          <button class="btn ghost small" onClick={() => (s.from === 'device' ? discardSend(s.key) : act('cancel'))}>
            Discard
          </button>
        </span>
      )}
    </span>
  );
}
