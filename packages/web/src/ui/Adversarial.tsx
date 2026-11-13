/**
 * Settings → Adversarial features (docs/history.md): keeping what others deleted or set to disappear, logging
 * people's statuses and presence over time, and recording who is in which server. Off, and out of sight, until you have read why they are here behind a
 * warning: a popup whose "Yes, I really want to do this" stays greyed for 15 seconds. Each switch starts off, and
 * the section says so. Hiding them keeps their switches as they are: what they keep goes on being kept, out of sight,
 * so nothing is lost by hiding. Turning a switch off is asked first, and never forgets what was kept.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { confirmOff, retention, saveRetention } from '../history.ts';
import { Modal, showSection } from './bits.tsx';
import { type Kind, SourceTable } from './HistorySettings.tsx';
import { Icon } from './icons.tsx';

const READ_FOR = 15;

/** For the table by network and account. */
const KINDS: Kind[] = [
  { key: 'deleted', label: 'Keep deleted messages', short: 'Deleted', help: '' },
  { key: 'disappearing', label: 'Keep disappearing messages', short: 'Disappearing', help: '' },
];

/** Each switch, and where what it keeps shows (docs/history.md, "Where it shows"). */
const SWITCHES: { key: 'deleted' | 'disappearing' | 'statuses' | 'presence' | 'members' | 'voice'; label: string; help: string; where: string }[] = [
  {
    key: 'deleted',
    label: 'Keep deleted messages',
    help: 'When someone deletes a message, keep what it said. Messages you delete yourself are never kept.',
    where: 'in full in the chat, marked Deleted',
  },
  {
    key: 'disappearing',
    label: 'Keep disappearing messages',
    help: 'When a Signal or WhatsApp disappearing-message timer runs out, keep the message here instead of erasing it.',
    where: 'in full in the chat, marked Disappeared',
  },
  {
    key: 'statuses',
    label: 'Log statuses',
    help: "Each change to people's custom statuses (or About, on Signal and WhatsApp), with when. Their current status shows either way.",
    where: 'the Activity section of a profile',
  },
  {
    key: 'presence',
    label: 'Log presence (online/idle/offline)',
    help:
      'Each time people you follow (friends, contacts, people you have a DM with) come online, go idle or do not disturb, or go offline, and on which devices, where the network says. Nothing of it is kept while this is off.',
    where: 'the Activity section of a profile',
  },
  {
    key: 'members',
    label: 'Record server members (passive)',
    help: "Who your accounts' clients have seen in each server: message authors and the member list as it loads anyway, never a walk of the whole list.",
    where: "a server's About (seen N of M), and In common on a profile",
  },
  {
    key: 'voice',
    label: 'Record who is in voice channels (passive)',
    help: "Who is in each server voice channel when you are not, as your accounts' clients are told anyway, and each time someone joins or leaves one. Nothing of it is kept while this is off.",
    where: "a voice channel's row and its page",
  },
];

export function AdversarialSettings() {
  const r = retention.value;
  const [warning, setWarning] = useState(false);
  // Shown with every switch off, just now or when first seen: say that each starts off, until they are hidden again.
  const [nudge, setNudge] = useState(false);
  const justShown = useRef(false);
  useEffect(() => {
    if (!r.adversarial) {
      setNudge(false);
      return;
    }
    if (!SWITCHES.some((x) => r[x.key])) setNudge(true);
    if (justShown.current) {
      justShown.current = false;
      showSection('set-adversarial');
    }
  }, [r.adversarial]);
  const hide = () => {
    if (confirmOff('adversarial')) void saveRetention({ adversarial: false }, { confirm: true });
  };
  const set = (key: (typeof SWITCHES)[number]['key'], on: boolean) => {
    if (on) void saveRetention({ [key]: true });
    else if (confirmOff(key)) void saveRetention({ [key]: false }, { confirm: true });
    else retention.value = { ...retention.value };
  };
  const stillKept = [r.deleted && 'deleted', r.disappearing && 'disappearing'].filter(Boolean) as string[];
  return (
    <section class={`set-block adversarial ${r.adversarial ? 'open' : ''}`} id="set-adversarial">
      <h3>Adversarial features</h3>
      {!r.adversarial ? (
        <>
          <p class="set-help">Features that keep what other people chose to take back, or watch them over time. Off unless you turn them on here.</p>
          {stillKept.length > 0 && <p class="set-help">Still keeping {stillKept.join(' and ')} messages, out of sight. Show these features to see them or to stop it.</p>}
          <button class="btn ghost small" onClick={() => setWarning(true)}>
            <Icon name="eye" size={14} /> Show adversarial features
          </button>
        </>
      ) : (
        <div class="adv-body">
          {nudge && (
            <p class="adv-next" role="status">
              <Icon name="info" size={15} /> Next, turn on the ones you want. Each starts off.
            </p>
          )}
          <p class="set-help">These work against what other people expect of the networks. Hiding them keeps each switch as it is and what was kept out of sight; turning a switch off is asked first. Nothing kept is lost unless you forget it under Message history.</p>
          {SWITCHES.map((x) => (
            <label class="toggle-row">
              <input type="checkbox" checked={!!r[x.key]} onChange={(e) => set(x.key, (e.target as HTMLInputElement).checked)} />
              <span>
                <b>{x.label}</b>
                <small>{x.help}</small>
                <small class="adv-where">
                  <Icon name="eye" size={12} /> Where it shows: {x.where}
                </small>
              </span>
            </label>
          ))}

          <div class="hist-show">
            <b>Deleted and disappeared messages in chats</b>
            <div class="seg" role="radiogroup">
              {(['shown', 'hidden'] as const).map((v) => (
                <button role="radio" aria-checked={r.show === v} class={`chip-btn ${r.show === v ? 'on' : ''}`} onClick={() => void saveRetention({ show: v })}>
                  {v === 'shown' ? 'Shown' : 'Hidden'}
                </button>
              ))}
            </div>
            <small class="set-help">Each chat can say otherwise, on its page under Kept messages.</small>
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
      {warning && (
        <Warning
          onClose={() => setWarning(false)}
          onYes={() => {
            justShown.current = true;
            void saveRetention({ adversarial: true });
          }}
        />
      )}
    </section>
  );
}

/**
 * Why these are behind a warning; "Yes" can be ticked only after 15 seconds, and ticking it shows them. The words
 * scroll and "Yes" stays at the bottom, so on a phone it is on screen from the start.
 */
function Warning({ onClose, onYes }: { onClose: () => void; onYes: () => void }) {
  const [left, setLeft] = useState(READ_FOR);
  useEffect(() => {
    const t = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Modal title="Adversarial features" onClose={onClose}>
      <div class="adv-warning">
        <div class="adv-text">
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
            <li>
              <b>Presence history.</b> A log of when someone comes online, goes idle and goes offline, and on which device, shows when they wake,
              sleep, work and are with their phone. It is a finer-grained record of their day than they ever chose to share.
            </li>
            <li>
              <b>Server members.</b> A record of who is in which server, kept as your client sees them, puts together who knows whom and who goes where.
              People join a server to be in it, not to be listed by its members.
            </li>
            <li>
              <b>Voice channels.</b> A record of who sat in which voice channel, and when, says who spends their evenings with whom. People join a
              voice channel to talk, not to be logged.
            </li>
          </ul>
          <p>
            What is kept sits on your hub, readable by anyone who gets into it. Depending on where you live and who is in the chat, keeping it may break a
            network's terms or the law, and people who find out tend to trust you less. Turn these on only for a reason you would be comfortable
            explaining to the people affected.
          </p>
        </div>
        <div class="adv-foot">
          <label class={`adv-confirm ${left ? 'waiting' : ''}`}>
            <input
              type="checkbox"
              disabled={left > 0}
              onChange={(e) => {
                if (!(e.target as HTMLInputElement).checked) return;
                onYes();
                onClose();
              }}
            />
            <span>Yes, I really want to do this</span>
            {left > 0 && <span class="adv-timer">{left}s</span>}
          </label>
          <small>This shows their switches. Each starts off.</small>
        </div>
      </div>
    </Modal>
  );
}
