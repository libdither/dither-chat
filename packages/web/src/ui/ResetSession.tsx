/**
 * "Reset secure session" on a direct conversation's About (docs/profile.md), where an account in it can (capability
 * 'resetSession', Signal's end session): for messages from them that will not decrypt. It tells them, so it asks first.
 */
import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { netName } from '../model.ts';
import { api, db, toast } from '../state.ts';
import { Card } from './ProfileShell.tsx';

export function ResetSessionCard({ conv }: { conv: P.ConversationView }) {
  const [busy, setBusy] = useState(false);
  if (conv.shape !== 'direct') return null;
  const account = conv.vantages.map((v) => db.accounts.get(v.accountId)).find((a) => a?.capabilities.includes('resetSession'));
  if (!account) return null;
  const reset = async () => {
    if (!confirm(`Reset the secure session with them on ${netName(conv.network)}? They see that you did. It helps when their messages say they could not be decrypted.`)) return;
    setBusy(true);
    try {
      await api(`/api/conversations/${conv.id}/reset-session`, { body: { accountId: account.id } });
      toast({ kind: 'info', title: 'Secure session reset', body: '' }, 2500);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not reset the secure session', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Secure session" icon="lock">
      <button class="btn ghost small" disabled={busy || account.status !== 'online'} onClick={() => void reset()}>
        Reset secure session
      </button>
      <p class="pf-hint">{account.status === 'online' ? 'For messages from them that could not be decrypted.' : `${account.label} is not connected.`}</p>
    </Card>
  );
}
