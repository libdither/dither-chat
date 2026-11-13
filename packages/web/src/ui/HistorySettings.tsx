/**
 * Settings → Message history (docs/history.md): what the hub keeps when a network rewrites a message (edited) or
 * takes back a reaction, read receipts, and the log of names, descriptions and settings as they change. Each kind may
 * be turned off everywhere or for one network or account, and what was kept may be forgotten. Keeping deleted and
 * disappeared messages, statuses and presence over time are under Adversarial features (Adversarial.tsx).
 */
import type * as P from '@dither-chat/protocol';
import { ABOUT_RULES } from '@dither-chat/protocol';
import { useEffect } from 'preact/hooks';
import { ADVERSARIAL_KINDS, eraseKept, keeping, kept, keeps, loadKept, loadRetention, retention, saveRetention, setSource } from '../history.ts';
import { netName } from '../model.ts';
import { db } from '../state.ts';
import { NetGlyph, showSection } from './bits.tsx';
import { Icon } from './icons.tsx';

export type Kind = { key: keyof P.KeepSettings; label: string; short: string; help: string };

const KINDS: Kind[] = [
  { key: 'edits', label: 'Keep earlier versions of edited messages', short: 'Edits', help: 'Click "(edited)" on a message to see what it said before.' },
  { key: 'reactions', label: 'Keep reactions taken back', short: 'Reactions', help: 'Who took back which reaction, and reactions a moderator cleared. Under Message History in a message\'s menu.' },
  { key: 'receipts', label: 'Keep read receipts', short: 'Receipts', help: 'Who got, read and played your messages, and when (Signal, WhatsApp, Matrix; Discord has none). Ticks beside your messages.' },
];

/** Each kind for each network, and for each account where a network has several. */
export function SourceTable({ kinds }: { kinds: Kind[] }) {
  const r = retention.value;
  const accounts = [...db.accounts.values()];
  const nets = [...new Set(accounts.map((a) => a.network))];
  const cell = (key: string, what: keyof P.KeepSettings, network: P.Network, accountId?: string) => {
    // Only networks with disappearing messages, or receipts, have anything to keep there.
    if ((what === 'disappearing' && !ABOUT_RULES[network].disappearing) || (what === 'receipts' && network === 'discord'))
      return (
        <td class="hist-none" title={`${netName(network)} has no ${what === 'receipts' ? 'read receipts' : 'disappearing messages'}`}>
          –
        </td>
      );
    const k = keeps(r, what, network, accountId);
    return (
      <td>
        <label class={`hist-cell ${k.own ? 'own' : ''}`} title={k.own ? 'Set here. Right-click to follow the level above again.' : 'Follows the level above'}>
          <input
            type="checkbox"
            checked={k.on}
            onChange={(e) => void setSource(key, what, (e.target as HTMLInputElement).checked)}
            onContextMenu={(e) => {
              if (!k.own) return;
              e.preventDefault();
              void setSource(key, what, null);
            }}
          />
        </label>
      </td>
    );
  };
  return (
    <table class="hist-table">
      <thead>
        <tr>
          <th />
          {kinds.map((k) => (
            <th>{k.short}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {nets.map((n) => {
          const accs = accounts.filter((a) => a.network === n);
          return (
            <>
              <tr class="hist-net">
                <th>
                  <NetGlyph network={n} size={13} /> {netName(n)}
                </th>
                {kinds.map((k) => cell(n, k.key, n))}
              </tr>
              {accs.length > 1 &&
                accs.map((a) => (
                  <tr class="hist-acc">
                    <th>{a.label}</th>
                    {kinds.map((k) => cell(a.id, k.key, n, a.id))}
                  </tr>
                ))}
            </>
          );
        })}
      </tbody>
    </table>
  );
}

export const forget = (what: P.KeptKind, label: string) => () => confirm(`Forget all ${label}? This cannot be undone.`) && void eraseKept(what);

/** Each kind Forget erases: its button, and what the confirmation calls it. */
const FORGET: [P.KeptKind, string, string][] = [
  ['deleted', 'Deleted messages', 'kept deleted messages'],
  ['disappeared', 'Disappeared messages', 'kept disappearing messages'],
  ['edits', 'Edit history', 'earlier versions of edited messages'],
  ['reactions', 'Reactions taken back', 'reactions taken back'],
  ['receipts', 'Read receipts', 'read receipts'],
  ['changes', 'Change log', 'logged changes'],
  ['statuses', 'Status history', 'logged statuses'],
  ['presence', 'Presence history', 'logged presence'],
  ['members', 'Server members', 'recorded server members'],
  ['voice', 'Voice channels', 'who was recorded in voice channels'],
];

const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function HistorySettings() {
  useEffect(() => void loadRetention(), []);
  const r = retention.value;
  // What is kept follows the settings, so ask again whenever they change.
  useEffect(() => void loadKept(), [r]);
  const had = kept.value;
  // Nothing adversarial is being kept: hidden, or each of its switches off.
  const notKept = !ADVERSARIAL_KINDS.some((w) => keeping(r, w));
  const keptBefore = ADVERSARIAL_KINDS.some((w) => had?.[w]);
  // Forget is for what is being kept or was kept; the rest have nothing to forget.
  const forgettable = FORGET.filter(([w]) => keeping(r, w) || had?.[w] !== false);
  const empty = FORGET.filter((f) => !forgettable.includes(f));
  return (
    <section class="set-block" id="set-history">
      <h3>Message history</h3>
      {notKept && (
        <div class="hist-off" role="note">
          <Icon name="eyeOff" size={16} />
          <div>
            <p>
              <b>Deleted and disappearing messages, statuses, presence and server members are not being kept.</b>
              {keptBefore && ' Some were kept before; Forget, below, erases them.'}
            </p>
            <button class="btn ghost small" onClick={() => showSection('set-adversarial')}>
              Turn them on in Adversarial features <Icon name="chevronRight" size={13} />
            </button>
          </div>
        </div>
      )}
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
        <input type="checkbox" checked={r.changes} onChange={(e) => void saveRetention({ changes: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>Log changes</b>
          <small>Names, descriptions, pictures, settings, members and roles of groups and servers; pins; and people's names, pictures and bios, as they change. Shown under History on profile pages.</small>
        </span>
      </label>

      <h4 class="hist-sub">By network and account</h4>
      <p class="set-help">Turn any of these off for one network or account. A box set at its own level is outlined; right-click it to follow the level above again.</p>
      <SourceTable kinds={KINDS} />

      <h4 class="hist-sub">Forget what was kept</h4>
      {forgettable.length > 0 && (
        <div class="btn-row hist-forget">
          {forgettable.map(([w, label, what]) => (
            <button class="btn ghost small danger" data-kind={w} onClick={forget(w, what)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {empty.length > 0 && <p class="set-help hist-empty">Nothing kept, so nothing to forget: {list(empty.map(([, label]) => label.toLowerCase()))}.</p>}
    </section>
  );
}
