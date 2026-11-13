/**
 * An account's stories switch (capability 'stories', docs/media-kinds.md): off unless the owner turns it on, and only
 * applied when the account's network process next starts (Signal: signal-cli's daemon), which this page says.
 */
import { useEffect, useState } from 'preact/hooks';
import type * as P from '@dither-chat/protocol';
import { STORIES_ACTION } from '@dither-chat/protocol';
import { api, toast } from '../state.ts';

export function StoriesSetting({ a }: { a: P.AccountView }) {
  const [st, setSt] = useState<P.StoriesSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const call = (args?: { on: boolean }) => api<{ result: P.StoriesSetting }>(`/api/accounts/${a.id}/action`, { body: { action: STORIES_ACTION, ...(args ? { args } : {}) } }).then((r) => r.result);
  useEffect(() => {
    if (a.status === 'online') call().then(setSt, () => setSt(null));
  }, [a.id, a.status]);
  const set = async (on: boolean) => {
    setBusy(true);
    try {
      setSt(await call({ on }));
    } catch (e) {
      toast({ kind: 'error', title: 'Stories', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  if (!st) return null;
  const waiting = st.on !== st.running;
  return (
    <section class="det-section">
      <h3>Stories</h3>
      <label class="toggle-row">
        <input type="checkbox" checked={st.on} disabled={busy} onChange={(e) => void set((e.target as HTMLInputElement).checked)} />
        <span>
          <b>Receive stories</b>
          <small>
            Your contacts' and groups' stories show on their pages for the day they last, never in the inbox and never as a notification. Opening one
            tells its author only when your phone's read receipts are on. Off: Signal's stories are not taken in at all.
          </small>
        </span>
      </label>
      {waiting && <p class="det-note">{st.on ? 'Stories start coming in the next time this account restarts (Restart, under Controls).' : 'Stories stop coming in the next time this account restarts.'}</p>}
    </section>
  );
}
