/**
 * Settings → Message history (docs/history.md): what the hub keeps when a network takes a message back (deleted,
 * disappeared) or rewrites it (edited), and the log of names, descriptions and settings as they change. Each kind
 * may be turned off everywhere or for one network or account, and what was kept may be forgotten.
 */
import type * as P from '@dither-chat/protocol';
import { ABOUT_RULES } from '@dither-chat/protocol';
import { useEffect } from 'preact/hooks';
import { eraseKept, keeps, loadRetention, retention, saveRetention, setSource } from '../history.ts';
import { netName } from '../model.ts';
import { db } from '../state.ts';
import { NetGlyph } from './bits.tsx';

const KINDS: { key: keyof P.KeepSettings; label: string; short: string; help: string }[] = [
  { key: 'deleted', label: 'Keep deleted messages', short: 'Deleted', help: 'When someone deletes a message, keep what it said. It shows as a collapsed line you can open. Messages you delete yourself are never kept.' },
  { key: 'disappearing', label: 'Keep disappearing messages', short: 'Disappearing', help: 'When a Signal or WhatsApp disappearing-message timer runs out, keep the message here instead of erasing it.' },
  { key: 'edits', label: 'Keep earlier versions of edited messages', short: 'Edits', help: 'Click "(edited)" on a message to see what it said before.' },
];

export function HistorySettings() {
  useEffect(() => void loadRetention(), []);
  const r = retention.value;
  const accounts = [...db.accounts.values()];
  const nets = [...new Set(accounts.map((a) => a.network))];
  const cell = (key: string, what: keyof P.KeepSettings, network: P.Network, accountId?: string) => {
    // Only networks with disappearing messages have anything to keep there.
    if (what === 'disappearing' && !ABOUT_RULES[network].disappearing)
      return (
        <td class="hist-none" title={`${netName(network)} has no disappearing messages`}>
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
  const forget = (what: 'deleted' | 'disappeared' | 'edits' | 'changes', label: string) => () => confirm(`Forget all ${label}? This cannot be undone.`) && void eraseKept(what);

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
          <small>Names, descriptions, pictures, settings and members of groups and servers, and people's names, pictures, bios and statuses, as they change. Shown under History on profile pages.</small>
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
      <p class="set-help">Turn any of these off for one network or account. A box set at its own level is outlined; right-click it to follow the level above again.</p>
      <table class="hist-table">
        <thead>
          <tr>
            <th />
            {KINDS.map((k) => (
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
                  {KINDS.map((k) => cell(n, k.key, n))}
                </tr>
                {accs.length > 1 &&
                  accs.map((a) => (
                    <tr class="hist-acc">
                      <th>{a.label}</th>
                      {KINDS.map((k) => cell(a.id, k.key, n, a.id))}
                    </tr>
                  ))}
              </>
            );
          })}
        </tbody>
      </table>

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
        <button class="btn ghost small danger" onClick={forget('changes', 'logged changes')}>
          Change log
        </button>
      </div>
    </section>
  );
}
