/**
 * Mail accounts as Accounts (their Mail group) and Settings (set-mail) show them. They are added and changed on the
 * dither-accounts page, never here (§14 Q5): this links there. An account whose access ended is deleted from the hub
 * a day later, or at once with "Delete now" (§14 Q6).
 */
import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { fullTime } from '../../format.ts';
import { askMailAgain, deleteMailAccount } from '../../mail/api.ts';
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

/** What to do while mail is not shared (§6.6). Null once it is and an account is there. */
export function MailAccessNote() {
  mailRev.value;
  const s = db.mail;
  const [busy, setBusy] = useState(false);
  const url = s.access.managerUrl;
  const open = url ? (
    <a class="link-btn" href={url} target="_blank" rel="noopener">
      Open dither-accounts
    </a>
  ) : null;
  switch (s.access.state) {
    case 'off':
      return <p class="mail-note">Mail comes through dither-accounts. Set DITHER_ACCOUNTS_URL on the hub to read it here.</p>;
    case 'unreachable':
      return <p class="mail-note">dither-accounts is not answering, so mail is not syncing. What is kept here still shows.</p>;
    case 'pending':
      return (
        <p class="mail-note">
          dither-chat asked dither-accounts for your email (read and send). Approve it on the manager's page. {open}
        </p>
      );
    case 'denied':
      return (
        <p class="mail-note">
          You declined mail access.{' '}
          <button
            class="link-btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              askMailAgain()
                .then(() => toast({ kind: 'info', title: 'Asked again', body: "Approve it on the dither-accounts page." }))
                .catch((e) => toast({ kind: 'error', title: 'Could not ask', body: String(e.message) }))
                .finally(() => setBusy(false));
            }}
          >
            Ask again
          </button>
        </p>
      );
    default:
      return s.accounts.size ? null : (
        <p class="mail-note">
          No mail accounts in dither-accounts. Add Email (IMAP) or Proton Mail there. {open}
        </p>
      );
  }
}
