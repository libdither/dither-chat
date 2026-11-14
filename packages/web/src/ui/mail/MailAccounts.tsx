/**
 * Mail accounts on the accounts page (docs/accounts.md "One list"): each is a row of the one list, and its page has the
 * Mail section below. Settings' Mail block lists them as links to those pages. Proton Mail is added from Add account
 * once dither-accounts lets this hub add it; other mail kinds on dither-accounts' page (or from Add account, after
 * asking). An account whose access ended is deleted from the hub a day later, or at once with "Delete now" (§14 Q6).
 */
import type * as P from '@dither-chat/protocol';
import { useState } from 'preact/hooks';
import { ago, fullTime } from '../../format.ts';
import { askMailAgain, deleteMailAccount } from '../../mail/api.ts';
import { sendingAgain } from '../../mail/drafts.ts';
import { db, go, mailRev, toast } from '../../state.ts';
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

/** Settings' Mail block: each mail account, a link to its page under Accounts. */
export function MailAccountRows() {
  mailRev.value;
  const accounts = [...db.mail.accounts.values()];
  if (!accounts.length) return null;
  return (
    <div class="mail-accounts">
      {accounts.map((a) => {
        const st = state(a);
        return (
          <button class="link-row acc-link" data-mail-account={a.id} onClick={() => go({ view: 'accounts', account: a.id })}>
            <span class="mail-acc-dot" style={{ background: a.color }} />
            <span class="mail-acc-name">{a.address ?? a.label}</span>
            <span class={`status-pill ${st.cls}`}>{st.pill}</span>
            <Icon name="chevronRight" size={16} class="link-row-go" />
          </button>
        );
      })}
    </div>
  );
}

const PHASE: Record<P.MailAccountView['sync']['phase'], string> = { first: 'first sync', backfill: 'going back', idle: 'up to date', relist: 'listing again' };

/** An account's Mail section on its page: where it stands, what it may do, what stopped. */
export function MailAccountSection({ a, openLive }: { a: P.MailAccountView; openLive?: () => void }) {
  mailRev.value;
  const [busy, setBusy] = useState(false);
  const level = a.level === 'write' ? 'Read and send' : a.level === 'read' ? 'Read only (marked read here only)' : 'None';
  return (
    <section class="det-section" data-mail-section>
      <h3>Mail</h3>
      {a.problem && a.level !== null && (
        <div class="det-callout warn">
          <Icon name="alert" size={15} />
          <span>{a.problem.message}</span>
          {openLive && (
            <button class="btn small" onClick={openLive}>
              <Icon name="monitor" size={13} /> Live view
            </button>
          )}
        </div>
      )}
      {a.level === null && (
        <div class="det-callout">
          <span>
            dither-chat no longer has access to it. Its mail here is deleted {a.deleteAt ? `at ${fullTime(a.deleteAt)}` : 'soon'}. It stays on the server.
          </span>
          <DeleteNow a={a} />
        </div>
      )}
      <dl class="kv">
        <dt>Address</dt>
        <dd>{a.address ?? 'not known yet'}</dd>
        <dt>Kind</dt>
        <dd>{KIND[a.kind] ?? a.kind}</dd>
        <dt>Access</dt>
        <dd>
          {level}
          {a.dryRun && ' · dry run: changes are not made on the server'}
        </dd>
        <dt>Here</dt>
        <dd>
          {a.sync.synced.toLocaleString()} {a.sync.synced === 1 ? 'message' : 'messages'}
          {a.sync.oldest ? `, back to ${ago(a.sync.oldest)}` : ''} · {PHASE[a.sync.phase]}
        </dd>
        <dt>Sending</dt>
        <dd>
          {a.send.ok === false ? `Off: ${a.send.why ?? 'the account cannot send'}` : a.send.ok ? 'Works' : 'Not tried yet'}
          {a.send.refused && (
            <>
              {' '}
              <button
                class="link-btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  sendingAgain(a.id)
                    .catch((e) => toast({ kind: 'error', title: 'Could not turn sending on', body: String(e.message) }))
                    .finally(() => setBusy(false));
                }}
              >
                Try sending again
              </button>
            </>
          )}
        </dd>
        {!!a.ops?.waiting && (
          <>
            <dt>Waiting</dt>
            <dd>
              {a.ops.waiting} {a.ops.waiting === 1 ? 'change' : 'changes'} the server has not confirmed yet
            </dd>
          </>
        )}
        {a.ops?.error && (
          <>
            <dt>Last change</dt>
            <dd>
              Not made, {ago(a.ops.error.at)}: {a.ops.error.message}
            </dd>
          </>
        )}
      </dl>
    </section>
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
