/**
 * Settings → Message history (docs/history.md): what the hub keeps when a network rewrites a message (edited) or
 * takes back a reaction, read receipts, and the log of names, descriptions and settings as they change. Each kind may
 * be turned off everywhere or for one network or account, and what was kept may be forgotten. Keeping deleted and
 * disappeared messages and statuses over time are under Adversarial features (Adversarial.tsx).
 */
import type * as P from '@dither-chat/protocol';
import { ABOUT_RULES } from '@dither-chat/protocol';
import { useEffect } from 'preact/hooks';
import { eraseKept, keeps, loadRetention, retention, saveRetention, setSource } from '../history.ts';
import { netName } from '../model.ts';
import { db } from '../state.ts';
import { NetGlyph } from './bits.tsx';

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

export const forget = (what: Parameters<typeof eraseKept>[0], label: string) => () => confirm(`Forget all ${label}? This cannot be undone.`) && void eraseKept(what);

export function HistorySettings() {
  useEffect(() => void loadRetention(), []);
  const r = retention.value;
  return (
    <section class="set-block" id="set-history">
      <h3>Message history</h3>
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
      <div class="btn-row">
        <button class="btn ghost small danger" onClick={forget('deleted', 'kept deleted messages')}>
          Deleted messages
        </button>
        <button class="btn ghost small danger" onClick={forget('disappeared', 'kept disappearing messages')}>
          Disappeared messages
        </button>
        <button class="btn ghost small danger" onClick={forget('edits', 'earlier versions of edited messages')}>
          Edit history
        </button>
        <button class="btn ghost small danger" onClick={forget('reactions', 'reactions taken back')}>
          Reactions taken back
        </button>
        <button class="btn ghost small danger" onClick={forget('receipts', 'read receipts')}>
          Read receipts
        </button>
        <button class="btn ghost small danger" onClick={forget('changes', 'logged changes')}>
          Change log
        </button>
        <button class="btn ghost small danger" onClick={forget('statuses', 'logged statuses')}>
          Status history
        </button>
      </div>
    </section>
  );
}
