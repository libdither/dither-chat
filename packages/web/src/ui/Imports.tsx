/**
 * History sources for an account (docs/import.md): upload a backup or export to the hub in pieces, see what the hub
 * made of it, and give a Signal backup its passphrase. The hub keeps the file; importing it into the timeline is a
 * separate step.
 */
import type * as P from '@dither-chat/protocol';
import { IMPORT_CHUNK } from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ago } from '../format.ts';
import { netName } from '../model.ts';
import { api, toast } from '../state.ts';
import { Icon } from './icons.tsx';

const ACCEPT: Partial<Record<P.Network, { accept: string; what: string }>> = {
  signal: { accept: '.backup', what: 'a Signal or Molly backup (.backup). Make one on the phone: Settings → Chats → Chat backups, or Settings → Backups → On-device backups.' },
  discord: { accept: '.zip,.json,.html', what: 'Discord’s data package (package.zip), or a DiscordChatExporter export.' },
};

const STATUS_TEXT: Record<P.ImportSourceStatus, string> = {
  uploading: 'Uploading',
  checking: 'Checking',
  'needs-passphrase': 'Needs the passphrase',
  counting: 'Reading it through',
  ready: 'Ready',
  error: 'Error',
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Send `file` from `from`, a piece at a time; a piece that fails is tried again, a refused offset is followed. */
async function send(id: string, file: File, from: number, onProgress: (received: number) => void, cancelled: () => boolean): Promise<P.ImportSourceView> {
  let offset = from;
  let failures = 0;
  let last: P.ImportSourceView | null = null;
  while (offset < file.size) {
    if (cancelled()) throw new Error('cancelled');
    const piece = file.slice(offset, Math.min(file.size, offset + IMPORT_CHUNK));
    try {
      const res = await fetch(`/api/imports/${id}/data?offset=${offset}`, { method: 'PUT', body: piece });
      const data = await res.json();
      if (res.status === 409 && typeof data.received === 'number') {
        offset = data.received;
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(data.error ?? `${res.status}`), { fatal: res.status < 500 });
      last = data as P.ImportSourceView;
      offset = last.received;
      failures = 0;
      onProgress(offset);
    } catch (e: any) {
      if (e.fatal || ++failures > 8) throw e;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));
    }
  }
  return last ?? (await api<P.ImportSourceView>(`/api/imports/${id}`));
}

const count = (n: number, what: string) => `${n.toLocaleString()} ${what}${n === 1 ? '' : 's'}`;

function CensusLine({ c }: { c: P.ImportCensus }) {
  if (c.format === 'signal-legacy') {
    const m = (c as any).messages;
    const att = (c as any).blobs?.attachment;
    return (
      <p class="det-note">
        {count(m.total, 'message')}
        {m.firstMonth ? `, ${m.firstMonth} to ${m.lastMonth}` : ''}
        {att?.count ? ` · ${count(att.count, 'attachment')} (${bytes(att.bytes)})` : ''}
        {m.keepmsgExpired ? ` · ${m.keepmsgExpired.toLocaleString()} disappeared but kept` : ''}
        {m.deleted ? ` · ${m.deleted.toLocaleString()} deleted` : ''}
        {m.editRevisions ? ` · ${count(m.editRevisions, 'edit revision')}` : ''}
      </p>
    );
  }
  return null;
}

function SourceRow({ s, account, onChange }: { s: P.ImportSourceView; account: P.AccountView; onChange: () => void }) {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChange();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Could not do that', body: e.message });
    } finally {
      setBusy(false);
    }
  };
  const pct = s.status === 'uploading' ? s.received / Math.max(1, s.size) : s.status === 'counting' ? (s.progress ?? 0) : null;
  return (
    <li class="import-source">
      <div class="import-head">
        <Icon name="file" size={16} />
        <span class="import-label">{s.label}</span>
        <span class={`status-pill ${s.status === 'ready' ? 'online' : s.status === 'error' ? 'error' : 'attention'}`}>{STATUS_TEXT[s.status]}</span>
      </div>
      <p class="det-note">
        {bytes(s.size)}
        {s.files > 1 ? ` in ${s.files.toLocaleString()} files` : ''} · added {ago(s.addedAt)}
        {s.addedBy !== 'upload' ? ` (${s.addedBy})` : ''}
        {s.sha256 ? ` · ${s.sha256.slice(0, 12)}` : ''}
      </p>
      {pct !== null && <progress class="import-progress" value={pct} max={1} />}
      {s.status === 'uploading' && <p class="det-note">Not all here yet ({bytes(s.received)} of {bytes(s.size)}). Pick the same file again to carry on.</p>}
      {s.error && <p class="det-note import-error">{s.error}</p>}
      {s.census && <CensusLine c={s.census} />}
      {s.notes && <p class="det-note">{s.notes}</p>}
      {s.status === 'needs-passphrase' && (
        <form
          class="import-pass"
          onSubmit={(e) => {
            e.preventDefault();
            act(() => api(`/api/imports/${s.id}/passphrase`, { body: { passphrase: pass } }).then(() => setPass('')));
          }}
        >
          <input class="input" inputMode="numeric" autoComplete="off" placeholder="30-digit backup passphrase" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} />
          <button class="btn" disabled={busy || pass.replace(/\D/g, '').length !== 30}>
            Unlock
          </button>
        </form>
      )}
      <div class="btn-row">
        {s.accountId !== account.id && (
          <button class="btn ghost" disabled={busy} onClick={() => act(() => api(`/api/imports/${s.id}`, { method: 'PATCH', body: { accountId: account.id } }))}>
            <Icon name="link" size={14} /> This is {account.label}’s
          </button>
        )}
        {(s.status === 'ready' || s.status === 'error') && (
          <button class="btn ghost" disabled={busy} onClick={() => act(() => api(`/api/imports/${s.id}/check`, { body: {} }))}>
            <Icon name="refresh" size={14} /> Check again
          </button>
        )}
        <button
          class="btn ghost danger"
          disabled={busy}
          onClick={() => confirm(`Delete “${s.label}” from the hub? Messages already imported from it stay.`) && act(() => api(`/api/imports/${s.id}`, { method: 'DELETE' }))}
        >
          <Icon name="trash" size={14} /> Delete
        </button>
      </div>
    </li>
  );
}

export function ImportsSection({ a }: { a: P.AccountView }) {
  const [sources, setSources] = useState<P.ImportSourceView[] | null>(null);
  const [upload, setUpload] = useState<{ name: string; received: number; size: number } | null>(null);
  const cancel = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const load = () => api<{ sources: P.ImportSourceView[] }>('/api/imports').then((r) => setSources(r.sources), () => setSources([]));
  const busy = !!upload || !!sources?.some((s) => s.status === 'checking' || s.status === 'counting');
  useEffect(() => {
    load();
    const t = setInterval(load, busy ? 1500 : 15_000);
    return () => clearInterval(t);
  }, [a.id, busy]);
  useEffect(() => () => void (cancel.current = true), []);

  const mine = (sources ?? []).filter((s) => s.accountId === a.id || (!s.accountId && (s.network === a.network || !s.network)));
  const help = ACCEPT[a.network];

  const pick = async (file: File) => {
    cancel.current = false;
    setUpload({ name: file.name, received: 0, size: file.size });
    try {
      // The same file again carries on where it stopped.
      const partial = mine.find((s) => s.status === 'uploading' && s.accountId === a.id && s.size === file.size && s.label === file.name);
      const src = partial ?? (await api<P.ImportSourceView>('/api/imports', { body: { accountId: a.id, name: file.name, size: file.size } }));
      await send(src.id, file, src.received, (received) => setUpload({ name: file.name, received, size: file.size }), () => cancel.current);
      toast({ kind: 'info', title: 'Uploaded', body: `${file.name} is on the hub.` });
    } catch (e: any) {
      if (e.message !== 'cancelled') toast({ kind: 'error', title: 'Upload stopped', body: `${e.message}. Pick the same file again to carry on.` });
    } finally {
      setUpload(null);
      load();
    }
  };

  return (
    <section class="det-section">
      <h3>History</h3>
      <p class="det-note">
        {netName(a.network)} gives a linked device little or no history. Bring older messages in from {help?.what ?? 'an export.'} The file stays on the hub, in its data
        directory.
      </p>
      {upload ? (
        <div class="import-upload">
          <p class="det-note">
            Uploading {upload.name}: {bytes(upload.received)} of {bytes(upload.size)}. Keep this page open.
          </p>
          <progress class="import-progress" value={upload.received / Math.max(1, upload.size)} max={1} />
          <div class="btn-row">
            <button class="btn ghost" onClick={() => (cancel.current = true)}>
              Pause
            </button>
          </div>
        </div>
      ) : (
        <div class="btn-row">
          <button class="btn ghost" onClick={() => input.current?.click()}>
            <Icon name="paperclip" size={14} /> Upload a backup or export
          </button>
          <input
            ref={input}
            type="file"
            hidden
            accept={help?.accept}
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              (e.target as HTMLInputElement).value = '';
              if (f) pick(f);
            }}
          />
        </div>
      )}
      {mine.length > 0 && (
        <ul class="import-list">
          {mine.map((s) => (
            <SourceRow key={s.id} s={s} account={a} onChange={load} />
          ))}
        </ul>
      )}
    </section>
  );
}
