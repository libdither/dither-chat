/**
 * Mail accounts as Accounts (their Mail group) and Settings (set-mail) show them. They are added and changed on the
 * dither-accounts page, never here (§14 Q5): this links there. An account whose access ended is deleted from the hub
 * a day later, or at once with "Delete now" (§14 Q6).
 */
import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { fullTime } from '../../format.ts';
import { deleteMailAccount } from '../../mail/api.ts';
import { db, mailRev, toast } from '../../state.ts';
import { Icon } from '../icons.tsx';

const KIND: Record<string, string> = { imap: 'Email (IMAP)', proton: 'Proton Mail' };

function state(a: P.MailAccountView): { pill: string; cls: string } {
  if (a.level === null) return { pill: 'No access', cls: 'disabled' };
  if (a.problem) return { pill: 'Needs you', cls: 'attention' };
  return a.online ? { pill: 'Online', cls: 'online' } : { pill: 'Offline', cls: 'offline' };
}

function DeleteNow({ a }: { a: P.MailAccountView }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      class="btn ghost small danger"
      disabled={busy}
      onClick={() => {
        if (!confirm(`Delete the mail of ${a.address ?? a.label} from this hub now? It stays on the server.`)) return;
        setBusy(true);
        deleteMailAccount(a.id)
          .catch((e) => toast({ kind: 'error', title: 'Could not delete', body: String(e.message) }))
          .finally(() => setBusy(false));
      }}
    >
      Delete now
    </button>
  );
}

export function MailAccountRows() {
  mailRev.value;
  const s = db.mail;
  const accounts = [...s.accounts.values()];
  const manager = s.access.managerUrl;
  return (
    <div class="mail-accounts">
      {accounts.map((a) => {
        const st = state(a);
        return (
          <div class="mail-acc" data-mail-account={a.id}>
            <div class="mail-acc-top">
              <span class="mail-acc-dot" style={{ background: a.color }} />
              <span class="mail-acc-name">{a.address ?? a.label}</span>
              <span class={`status-pill ${st.cls}`}>{st.pill}</span>
            </div>
            <div class="mail-acc-sub">
              {KIND[a.kind] ?? a.kind}
              {a.level === 'read' && ' · read only: marked read here only'}
              {a.dryRun && ' · dry run'}
            </div>
            {a.problem && a.level !== null && <div class="mail-acc-line">{a.problem.message}</div>}
            {a.level !== null && a.send.ok === false && <div class="mail-acc-line">Sending is off: {a.send.why ?? 'dither-accounts says this account cannot send'}. Reading works.</div>}
            {a.level === null && (
              <div class="mail-acc-line">
                dither-chat no longer has access to it. Its mail here is deleted {a.deleteAt ? `at ${fullTime(a.deleteAt)}` : 'soon'}. <DeleteNow a={a} />
              </div>
            )}
            {a.managedUrl && (
              <a class="link-btn" href={a.managedUrl} target="_blank" rel="noopener">
                <Icon name="external" size={12} /> Open in dither-accounts
              </a>
            )}
          </div>
        );
      })}
      {manager ? (
        <a class="btn ghost small" href={manager} target="_blank" rel="noopener">
          <Icon name="plus" size={13} /> Add a mail account in dither-accounts
        </a>
      ) : (
        <p class="set-help">Mail accounts are added on the dither-accounts page.</p>
      )}
    </div>
  );
}
