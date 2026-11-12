/**
 * Settings → Indexing → Mail (docs/mail.md "Keeping all mail"): each mail account's copy on the hub measured against
 * its server: messages and bodies held, the room it takes, how far the walk through its mailboxes has come, Gmail's
 * month audits, how the server's own search compared lately, and whether searches still need the server. Keep all
 * mail per account, Pause and Resume. The hub does the work (GET/PUT /api/mail/keep); this asks it and draws it.
 */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api, db, mailRev, toast } from '../../state.ts';

const STATE_LABEL: Record<P.MailKeepView['state'], string> = { running: 'Running', idle: 'Up to date', paused: 'Paused', disk: 'Disk guard', stopped: 'Stopped', waiting: 'Waiting', offline: 'Offline', off: 'Not kept' };
/** The pills' looks, from the index jobs' (Indexing.tsx). */
const STATE_CLASS: Record<P.MailKeepView['state'], string> = { running: 'running', idle: 'done', paused: 'paused', disk: 'failed', stopped: 'failed', waiting: 'paused', offline: 'paused', off: '' };
const STOP_LABEL: Record<string, string> = { challenge: 'a sign-in check is waiting', signedOut: 'signed out', quota: 'over its quota', paused: 'it paused background reads' };

const n = (x: number) => x.toLocaleString();
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
/** Bytes as a person reads them, up to GB. */
const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(0)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
let dayFmt: Intl.DateTimeFormat | undefined;
/** "3 Mar 2014". */
const day = (t: number) => (dayFmt ??= new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })).format(t);

/** Whose search a measure is: Gmail's, Proton's, the server's. */
function searchName(a: P.MailKeepView, kind: string | undefined): string {
  if (a.audit) return "Gmail's search";
  if (kind === 'proton') return "Proton's search";
  return "The server's search";
}

function KeepRow({ a, reload }: { a: P.MailKeepView; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const acc = db.mail.accounts.get(a.accountId);
  const name = acc?.address ?? acc?.label ?? a.accountId;
  const change = async (body: P.MailKeepChange, what: string) => {
    setBusy(true);
    try {
      await api<P.MailKeepView>(`/api/mail/keep/${encodeURIComponent(a.accountId)}`, { method: 'PUT', body });
      reload();
    } catch (e) {
      toast({ kind: 'error', title: `Could not ${what}`, body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const toggle = (keep: boolean) => {
    if (!keep && !confirm(`Stop keeping all of ${name}'s mail? What is here stays until the hub's caches need the room.`)) return;
    void change({ keep }, keep ? 'keep it' : 'stop keeping it');
  };
  const total = a.messages.total;
  const pct = a.messages.held ? Math.round((a.bodies / a.messages.held) * 100) : 0;
  const lines: (string | null)[] = [
    `${n(a.messages.held)}${total !== null ? ` of ${n(total)}` : ''} messages held · ${n(a.bodies)} with their text · ${size(a.bytes.bodies + a.bytes.text)} here`,
    a.storage ? `The account says it uses ${a.storage.text ?? `${size(a.storage.used ?? 0)}${a.storage.total ? ` of ${size(a.storage.total)}` : ''}`}` : null,
    a.state === 'waiting' ? null : a.keep ? (a.walk.complete ? `Every mailbox listed to its end (${plural(a.walk.mailboxes, 'mailbox', 'mailboxes')})` : `Walking ${a.walk.mailbox ?? 'its mailboxes'}${a.walk.back ? `: back to ${day(a.walk.back)}` : ''} · ${n(a.walk.done)} of ${plural(a.walk.mailboxes, 'mailbox', 'mailboxes')} listed`) : 'A year of mail and all of Inbox; bodies as they are read',
    a.audit && a.state !== 'waiting' ? `${n(a.audit.matched)} of ${plural(a.audit.windows, 'month')} match Gmail${a.audit.missed ? ` · ${n(a.audit.missed)} missing mail` : ''}${a.audit.caught ? ` · ${n(a.audit.caught)} caught` : ''}${a.audit.estimate !== null ? ` · Gmail counts ${n(a.audit.estimate)} in the months searched` : ''}` : null,
    a.measure.searches ? `${searchName(a, acc?.kind)} found ${n(a.measure.found)} in your last 30 days of searches: ${n(a.measure.held)} held here, ${n(a.measure.local)} found here` : null,
  ];
  return (
    <li class={`job ${a.state === 'idle' ? 'done' : a.state}`} data-mail-keep={a.accountId}>
      <div class="job-head">
        {acc && <span class="mail-acc-dot" style={{ background: acc.color }} />}
        <b class="job-name">{name}</b>
        <span class="job-kind">{a.audit || acc?.kind === 'google' ? 'Gmail' : acc?.kind === 'proton' ? 'Proton' : 'IMAP'}</span>
        <span class={`job-pill ${STATE_CLASS[a.state]}`}>{STATE_LABEL[a.state]}</span>
      </div>
      {a.keep && (
        <div class="job-bar" role="progressbar" aria-label={`${name}: ${n(a.bodies)} of ${n(a.messages.held)} messages with their text`} aria-valuemin={0} aria-valuemax={a.messages.held || 1} aria-valuenow={a.bodies}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {lines.filter(Boolean).map((l) => (
        <p class="job-line">{l}</p>
      ))}
      {a.state === 'stopped' && (
        <p class="job-line job-error" role="alert">
          Stopped by the account: {STOP_LABEL[a.stopped ?? ''] ?? a.stopped}. It goes on when the account says it may.
        </p>
      )}
      {a.state === 'disk' && (
        <p class="job-line job-error" role="alert">
          Stopped by the disk guard: bodies wait until the disk has more room.
        </p>
      )}
      {a.state === 'waiting' && (
        <p class="job-line job-when">
          Waiting for dither-accounts' slow lane for Gmail. Until it has one, only the last year and all of Inbox are kept, as for any account.
        </p>
      )}
      {a.state === 'offline' && <p class="job-line job-when">Waiting for the account to be online.</p>}
      {a.keep && (
        <p class={`job-line ${a.local.on ? 'keep-local' : 'job-when'}`}>
          {a.local.on ? 'Searched locally: searches no longer ask its server unless you do.' : `Searches still ask its server: ${a.local.missing.join('; ')}.`}
        </p>
      )}
      <div class="job-controls">
        <label class="toggle-row keep-toggle">
          <input type="checkbox" checked={a.keep} disabled={busy} onChange={(e) => toggle((e.target as HTMLInputElement).checked)} />
          <span>
            <b>Keep all mail</b>
          </span>
        </label>
        <div class="job-buttons">
          {a.keep && !a.paused && (
            <button class="btn ghost small" disabled={busy} onClick={() => void change({ paused: true }, 'pause')}>
              Pause
            </button>
          )}
          {a.keep && a.paused && (
            <button class="btn ghost small" disabled={busy} onClick={() => void change({ paused: false }, 'resume')}>
              Resume
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** The Mail part of Settings → Indexing: looked at every 5 s while an account is working, every 30 s otherwise. */
export function MailKeepSection() {
  mailRev.value;
  const [page, setPage] = useState<P.MailKeepPage | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const on = db.mail.access.state === 'granted' && db.mail.accounts.size > 0;
  const working = !!page?.accounts.some((a) => a.state === 'running');
  useEffect(() => {
    if (!on) return;
    let live = true;
    api<P.MailKeepPage>('/api/mail/keep').then(
      (r) => live && setPage(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [tick, on]);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(reload, working ? 5_000 : 30_000);
    return () => clearTimeout(t);
  }, [tick, working, on]);
  if (!on || !page?.accounts.length) return null;
  const low = page.disk.free !== null && page.disk.free < page.disk.floor;
  return (
    <div class="keep-mail" id="set-indexing-mail">
      <h4>Mail</h4>
      <p class="set-help">
        Every message of each mail account and its whole text kept on this hub, until a search of the server would find nothing this hub's own search cannot. The server is read at most twice a second, and never ahead of what you are reading.
      </p>
      {low && (
        <p class="set-help job-error" role="alert">
          The disk holding the hub's data has {size(page.disk.free!)} free, under {size(page.disk.floor)}: no bodies are fetched until there is more room.
        </p>
      )}
      <ul class="jobs">
        {page.accounts.map((a) => (
          <KeepRow key={a.accountId} a={a} reload={reload} />
        ))}
      </ul>
    </div>
  );
}
