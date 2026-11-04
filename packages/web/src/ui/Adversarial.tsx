/**
 * Settings → Adversarial features (docs/history.md): keeping what others deleted or set to disappear, and logging
 * people's statuses over time. Off, and out of sight, until you have read why they are here behind a warning: a
 * popup whose "Yes, I really want to do this" stays greyed for 15 seconds. Hiding them again turns them all off.
 */
import { ADVERSARIAL_KEEPS } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { retention, saveRetention } from '../history.ts';
import { Modal } from './bits.tsx';
import { type Kind, SourceTable } from './HistorySettings.tsx';
import { Icon } from './icons.tsx';

const READ_FOR = 15;

const KINDS: Kind[] = [
  { key: 'deleted', label: 'Keep deleted messages', short: 'Deleted', help: 'When someone deletes a message, keep what it said. It shows as a collapsed line you can open. Messages you delete yourself are never kept.' },
  { key: 'disappearing', label: 'Keep disappearing messages', short: 'Disappearing', help: 'When a Signal or WhatsApp disappearing-message timer runs out, keep the message here instead of erasing it.' },
];

export function AdversarialSettings() {
  const r = retention.value;
  const [warning, setWarning] = useState(false);
  const hide = () => {
    const sources = Object.fromEntries(
      Object.entries(r.sources)
        .map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([f]) => !(ADVERSARIAL_KEEPS as readonly string[]).includes(f)))] as const)
        .filter(([, v]) => Object.keys(v).length),
    );
    void saveRetention({ adversarial: false, deleted: false, disappearing: false, statuses: false, sources });
  };
  return (
    <section class={`set-block adversarial ${r.adversarial ? 'open' : ''}`} id="set-adversarial">
      <h3>Adversarial features</h3>
      {!r.adversarial ? (
        <>
          <p class="set-help">Features that keep what other people chose to take back, or watch them over time. Off unless you turn them on here.</p>
          <button class="btn ghost small" onClick={() => setWarning(true)}>
            <Icon name="eye" size={14} /> Show adversarial features
          </button>
        </>
      ) : (
        <div class="adv-body">
          <p class="set-help">These work against what other people expect of the networks. Hiding them turns them all off; what was kept stays out of sight until they are shown again, or is forgotten under Message history.</p>
          {KINDS.map((k) => (
            <label class="toggle-row">
              <input type="checkbox" checked={r[k.key]} onChange={(e) => void saveRetention({ [k.key]: (e.target as HTMLInputElement).checked })} />
              <span>
                <b>{k.label}</b>
                <small>{k.help}</small>
              </span>
            </label>
          ))}
          <label class="toggle-row">
            <input type="checkbox" checked={r.statuses} onChange={(e) => void saveRetention({ statuses: (e.target as HTMLInputElement).checked })} />
            <span>
              <b>Log statuses</b>
              <small>Each change to people's custom statuses (or About, on Signal and WhatsApp), with when. Shown under History on their profile. Their current status shows either way.</small>
            </span>
          </label>

          <div class="hist-show">
            <b>Deleted and disappeared messages in chats</b>
            <div class="seg" role="radiogroup">
              {(['collapsed', 'hidden'] as const).map((v) => (
                <button role="radio" aria-checked={r.show === v} class={`chip-btn ${r.show === v ? 'on' : ''}`} onClick={() => void saveRetention({ show: v })}>
                  {v === 'collapsed' ? 'Collapsed line' : 'Hidden completely'}
                </button>
              ))}
            </div>
          </div>

          <h4 class="hist-sub">By network and account</h4>
          <SourceTable kinds={KINDS} />

          <div class="btn-row">
            <button class="btn ghost small" onClick={hide}>
              <Icon name="eyeOff" size={14} /> Hide adversarial features
            </button>
          </div>
        </div>
      )}
      {warning && <Warning onClose={() => setWarning(false)} />}
    </section>
  );
}

/** Why these are behind a warning; "Yes" can be ticked only after 15 seconds, and ticking it shows them. */
function Warning({ onClose }: { onClose: () => void }) {
  const [left, setLeft] = useState(READ_FOR);
  useEffect(() => {
    const t = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Modal title="Adversarial features" onClose={onClose}>
      <div class="adv-warning">
        <p>
          These keep what other people chose to take back, or watch them over time. Each works against what the person on the other end expects, and
          against how the network meant it to work:
        </p>
        <ul>
          <li>
            <b>Deleted messages.</b> Someone deleted a message because they did not want it seen, or kept. Keeping it reverses their choice, often
            without them knowing.
          </li>
          <li>
            <b>Disappearing messages.</b> A timer is an agreement, between everyone in the chat, that messages do not last. Keeping them breaks that
            agreement for everyone, not just you.
          </li>
          <li>
            <b>Status history.</b> A log of someone's statuses over time says where they were, how they felt and when they were around. That is
            surveillance, however idle the reason.
          </li>
        </ul>
        <p>
          What is kept sits on your hub, readable by anyone who gets into it. Depending on where you live and who is in the chat, keeping it may break a
          network's terms or the law, and people who find out tend to trust you less. Turn these on only for a reason you would be comfortable
          explaining to the people affected.
        </p>
        <label class={`adv-confirm ${left ? 'waiting' : ''}`}>
          <input
            type="checkbox"
            disabled={left > 0}
            onChange={(e) => {
              if (!(e.target as HTMLInputElement).checked) return;
              void saveRetention({ adversarial: true });
              onClose();
            }}
          />
          <span>Yes, I really want to do this</span>
          {left > 0 && <span class="adv-timer">{left}s</span>}
        </label>
      </div>
    </Modal>
  );
}
