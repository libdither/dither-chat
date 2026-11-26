/**
 * The line under a send not yet through: what it is doing, and what you can do about it (docs/sync.md "A send in
 * doubt"). A send in doubt (it went to the hub, and no answer said whether it went out) waits for you: Send again (a
 * new send) or Discard. A send under way for a moment, or waiting for the hub, has a tick to let it go again by itself
 * if the hub drops: off by default, since a send the hub lost track of may be out already.
 */
import { useEffect, useState } from 'preact/hooks';
import { discardSend, pending, retrySend, setAutoResend } from '../state.ts';

type Pending = (typeof pending.value)[number];

/** How long a send is under way before its tick shows: a quick send never flashes one. */
const TICK_AFTER_MS = 1500;

const DOUBT_NOTE = 'May have been sent: the hub stopped answering while sending. Check the chat before sending again.';

export function PendingNote({ p }: { p: Pending }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), TICK_AFTER_MS);
    return () => clearTimeout(t);
  }, [p.tempId]);
  const note = p.failed ? `Failed: ${p.failed}` : p.unsure ? DOUBT_NOTE : p.queued ? 'Waiting for the hub, sends when it is back' : p.uploading ? 'Uploading…' : 'Sending…';
  const stuck = !!(p.failed || p.unsure);
  return (
    <>
      <span class="pending-note">{note}</span>
      {stuck && (
        <span class="pending-actions">
          <button class="btn ghost small" onClick={() => retrySend(p.tempId)}>
            {p.unsure ? 'Send again' : 'Try again'}
          </button>
          <button class="btn ghost small" onClick={() => discardSend(p.tempId)}>
            Discard
          </button>
        </span>
      )}
      {!stuck && (slow || p.queued || p.autoResend) && (
        <label class="pending-auto" title="Off: if the hub stops answering while this is being sent, it waits for you rather than going again, so it is never sent twice">
          <input type="checkbox" checked={!!p.autoResend} onChange={(e) => setAutoResend(p.tempId, (e.target as HTMLInputElement).checked)} />
          Resend automatically if the hub drops
        </label>
      )}
    </>
  );
}
