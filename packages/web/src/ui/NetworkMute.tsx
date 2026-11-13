/**
 * "Mute on Discord" on a place's About page (nativemute.ts, docs/notifications.md "Muted on the network"): the
 * network's own mute, with a timer, which stops its own apps too. Shown only where an account that sees the place
 * can (capability 'mute'). The new mute comes back as the place's fact, as one set in Discord's own app does.
 */
import type * as P from '@dither-chat/protocol';
import { MUTE_TIMERS, muteTimerLabel, NETWORK_META } from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { canMuteOnNetwork, canUnmute, networkMuteLine } from '../nativemute.ts';
import { api, db } from '../state.ts';

export function NetworkMute({ kind, id, network, accountIds, mute }: { kind: 'conversation' | 'space'; id: string; network: P.Network; accountIds: string[]; mute: P.NativeMute | null | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canMuteOnNetwork(accountIds.map((a) => db.accounts.get(a)))) return null;
  const net = NETWORK_META[network].name;
  const send = async (body: { muted: boolean; minutes?: number | null }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ failed: { error: string }[] }>(`/api/${kind === 'space' ? 'spaces' : 'conversations'}/${id}/native-mute`, { body });
      if (r.failed?.length) setError(`One account could not: ${r.failed[0]!.error}`);
    } catch (e) {
      setError(`${net} did not take it: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="network-mute">
      <p class="pf-hint">{networkMuteLine(network, mute)}.</p>
      {canUnmute(mute) ? (
        <button class="btn ghost small" disabled={busy} onClick={() => void send({ muted: false })}>
          Unmute on {net}
        </button>
      ) : (
        <label class="pf-level">
          <select class="select" disabled={busy} value="" aria-label={`Mute on ${net}`} onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v) void send({ muted: true, minutes: v === 'off' ? null : Number(v) });
          }}>
            <option value="">Mute on {net}…</option>
            {MUTE_TIMERS.map((m) => (
              <option value={m === null ? 'off' : String(m)}>{m === null ? muteTimerLabel(null) : `For ${muteTimerLabel(m)}`}</option>
            ))}
          </select>
        </label>
      )}
      <p class="pf-hint">Stops {net}'s own apps notifying too. dither's Mute above only changes what dither notifies.</p>
      {error && <p class="about-error">{error}</p>}
    </div>
  );
}
