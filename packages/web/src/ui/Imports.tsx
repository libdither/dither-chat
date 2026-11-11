/**
 * History for an account (docs/import.md): upload a backup or export to the hub, in pieces that resume, as one file
 * or a whole folder (a Molly backup folder); see what the hub made of it; import it, after a dry run if you like;
 * review where it disagreed with what the hub had; undo it. For Discord, fetch what neither an export nor live sync
 * has through the account itself (imports/gapfill.ts).
 */
import type * as P from '@dither-chat/protocol';
import { IMPORT_CHUNK } from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { android, onNativeUpload } from '../android.ts';
import { ago } from '../format.ts';
import { netName } from '../model.ts';
import { api, toast } from '../state.ts';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';

const HELP: Partial<Record<P.Network, { accept: string; what: string; folder?: string; zip?: string }>> = {
  signal: {
    accept: '.backup',
    what: 'a Molly or Signal backup. Pick the folder Molly backs up to (it holds SignalBackups and, with “Include kept messages”, .backup files), or that folder zipped (on a phone, where a browser can’t pick a folder), or a single .backup file.',
    folder: 'Upload the backup folder',
    zip: 'Upload it as a .zip',
  },
  discord: { accept: '.zip,.json,.html', what: 'Discord’s data package (package.zip) or a DiscordChatExporter export.' },
};

const STATUS_TEXT: Record<P.ImportSourceStatus, string> = {
  uploading: 'Uploading',
  checking: 'Checking',
  'needs-passphrase': 'Needs the passphrase',
  counting: 'Reading it through',
  ready: 'Ready',
  error: 'Error',
};

const STAGE_TEXT: Record<P.ImportRunView['stage'], string> = { reading: 'Reading the export', applying: 'Adding to the hub', done: 'Done', error: 'Failed', stopped: 'Stopped' };

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const count = (n: number, what: string) => `${n.toLocaleString()} ${what}${n === 1 ? '' : 's'}`;

/** Send one file of an upload from `from`, a piece at a time; a failed piece is tried again, a refused offset followed. */
async function send(id: string, index: number, file: File, from: number, onBytes: (n: number) => void, cancelled: () => boolean) {
  let offset = from;
  let failures = 0;
  while (offset < file.size) {
    if (cancelled()) throw new Error('cancelled');
    const piece = file.slice(offset, Math.min(file.size, offset + IMPORT_CHUNK));
    try {
      const res = await fetch(`/api/imports/${id}/data?file=${index}&offset=${offset}`, { method: 'PUT', body: piece });
      const data = await res.json();
      if (res.status === 409 && typeof data.received === 'number') {
        onBytes(data.received - offset);
        offset = data.received;
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(data.error ?? `${res.status}`), { fatal: res.status < 500 });
      onBytes(piece.size);
      offset += piece.size;
      failures = 0;
    } catch (e: any) {
      if (e.fatal || ++failures > 8) throw e;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));
    }
  }
}

const pathOf = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

function CensusLine({ c }: { c: P.ImportCensus }) {
  const x = c as any;
  if (c.format === 'signal-legacy') {
    const m = x.messages;
    const att = x.blobs?.attachment;
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
  if (c.format === 'signal-folder') {
    return (
      <>
        <p class="det-note">
          {count(x.snapshots, 'new-format snapshot')}
          {x.newestSnapshot ? ` (newest ${x.newestSnapshot.replace(/^signal-backup-/, '')})` : ''} · {count(x.attachments, 'attachment file')} ({bytes(x.attachmentBytes)}) ·{' '}
          {count(x.backups.length, '.backup file')}
          {x.zip ? ' · unpacked from the zip' : ''}
        </p>
        {x.v2 && (
          <p class="det-note">
            Newest snapshot: {count(x.v2.chatItems, 'message')} in {count(x.v2.chats, 'chat')}
            {x.v2.firstMonth ? `, ${x.v2.firstMonth} to ${x.v2.lastMonth}` : ''} · {count(x.v2.recipients.contact ?? 0, 'contact')}, {count(x.v2.recipients.group ?? 0, 'group')}
          </p>
        )}
        {x.legacy && <CensusLine c={x.legacy} />}
      </>
    );
  }
  return null;
}

function RunLine({ r }: { r: P.ImportRunView }) {
  const c = r.counts;
  return (
    <p class="det-note">
      {r.dryRun ? 'Dry run' : 'Import'} {r.finishedAt ? `${ago(r.finishedAt)}: ${STAGE_TEXT[r.stage].toLowerCase()}` : `· ${STAGE_TEXT[r.stage]}`}
      {c
        ? ` · ${count(c.messages, 'message')} in ${count(c.conversations, 'conversation')}: ${c.new.toLocaleString()} ${r.dryRun ? 'would be new' : 'new'}, ${c.same.toLocaleString()} already here${c.filled ? `, ${c.filled.toLocaleString()} filled in` : ''}${c.conflicts ? `, ${count(c.conflicts, 'difference')}` : ''}${c.kept ? ` · ${c.kept.toLocaleString()} of them deleted or disappeared, kept (shown with adversarial features)` : ''}${c.conversationsNew ? ` · ${count(c.conversationsNew, 'conversation')} the hub didn’t have (archived)` : ''}${c.duplicates ? ` · ${c.duplicates.toLocaleString()} duplicates skipped` : ''}`
        : ''}
      {r.files ? ` · ${count(r.files.linked, 'file')} kept${r.files.missing ? `, ${r.files.missing} missing from the export` : ''}` : ''}
      {r.skipped && Object.keys(r.skipped).length ? ` · left out: ${Object.entries(r.skipped).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(', ')}` : ''}
    </p>
  );
}

function Conflicts({ s, onChange }: { s: P.ImportSourceView; onChange: () => void }) {
  const [data, setData] = useState<{ counts: Record<string, number>; items: P.ImportConflictView[] } | null>(null);
  const load = () => api<{ counts: Record<string, number>; items: P.ImportConflictView[] }>(`/api/imports/${s.id}/conflicts?limit=50`).then(setData);
  useEffect(() => void load(), [s.id]);
  const decide = (c: P.ImportConflictView, decision: 'take-source' | 'ignore' | null) =>
    api(`/api/imports/${s.id}/conflicts`, { body: { messageId: c.messageId, kind: c.kind, decision } }).then(load, (e) => toast({ kind: 'error', title: 'Could not do that', body: e.message })).then(onChange);
  if (!data) return <Loading inline label="Loading…" />;
  if (!data.items.length) return <p class="det-note">Nothing differs.</p>;
  return (
    <div class="import-conflicts">
      <p class="det-note">
        Where the export says something else than the hub, the hub keeps its words until you choose. {data.counts.body ? count(data.counts.body, 'message') + ' worded differently' : ''}
        {data.counts.deleted ? ` · ${count(data.counts.deleted, 'message')} deleted here but present in the export` : ''}. Newest first, 50 at a time.
      </p>
      {data.items.map((c) => (
        <div class="import-conflict" key={c.messageId + c.kind}>
          <small>
            {new Date(c.ts).toLocaleString()} · {c.kind === 'deleted' ? 'deleted here' : 'worded differently'}
            {c.decision ? ` · ${c.decision === 'take-source' ? 'took the export’s' : 'ignored'}` : ''}
          </small>
          <div class="import-sides">
            <div>
              <b>Hub</b>
              <p>{c.hub.deleted && !c.hub.body ? '(deleted)' : c.hub.body}</p>
            </div>
            <div>
              <b>Export</b>
              <p>{c.source.body}</p>
            </div>
          </div>
          <div class="btn-row">
            {c.decision !== 'take-source' && (
              <button class="btn ghost small" onClick={() => decide(c, 'take-source')}>
                Use the export’s
              </button>
            )}
            {!c.decision && (
              <button class="btn ghost small" onClick={() => decide(c, 'ignore')}>
                Keep the hub’s
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SourceRow({ s, account, onChange, importing }: { s: P.ImportSourceView; account: P.AccountView; onChange: () => void; importing: boolean }) {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
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
  const run = s.run;
  const running = !!run && !run.finishedAt;
  // A new-format Molly backup opens with the account's recovery key, a .backup with its 30-digit passphrase.
  const recovery = (s.census as { needs?: string } | null)?.needs === 'recovery-key';
  const pct = s.status === 'uploading' ? s.received / Math.max(1, s.size) : s.status === 'counting' || (s.status === 'checking' && s.progress !== null) ? (s.progress ?? 0) : running ? run!.progress : null;
  const canImport = s.importable && s.status === 'ready' && s.accountId === account.id && !running;
  const imported = !!run && !run.dryRun && run.stage === 'done';
  return (
    <li class="import-source">
      <div class="import-head">
        <Icon name={s.files > 1 ? 'folder' : 'file'} size={16} />
        <span class="import-label">{s.label}</span>
        <span class={`status-pill ${s.status === 'ready' ? 'online' : s.status === 'error' ? 'error' : 'attention'}`}>{running ? STAGE_TEXT[run!.stage] : STATUS_TEXT[s.status]}</span>
      </div>
      <p class="det-note">
        {bytes(s.size)}
        {s.files > 1 ? ` in ${s.files.toLocaleString()} files` : ''} · added {ago(s.addedAt)}
        {s.addedBy !== 'upload' ? ` (${s.addedBy})` : ''}
        {s.sha256 ? ` · ${s.sha256.slice(0, 12)}` : ''}
      </p>
      {pct !== null && <progress class="import-progress" value={pct} max={1} />}
      {s.status === 'uploading' &&
        (android?.upload.value?.source === s.id ? (
          <p class="det-note">Uploading from this phone ({bytes(s.received)} of {bytes(s.size)}).</p>
        ) : (
          <p class="det-note">Not all here yet ({bytes(s.received)} of {bytes(s.size)}). Pick the same file or folder again to carry on.</p>
        ))}
      {s.error && <p class="det-note import-error">{s.error}</p>}
      {s.census && <CensusLine c={s.census} />}
      {run && <RunLine r={run} />}
      {run?.error && <p class="det-note import-error">{run.error}</p>}
      {s.notes && <details class="det-note"><summary>Notes</summary>{s.notes}</details>}
      {s.status === 'needs-passphrase' && (
        <form
          class="import-pass"
          onSubmit={(e) => {
            e.preventDefault();
            act(() => api(`/api/imports/${s.id}/passphrase`, { body: { passphrase: pass } }).then(() => setPass('')));
          }}
        >
          {recovery && <p class="det-note">Molly → Settings → Backups → On-device backups → View recovery key. The hub keeps only the backup key it gives, which opens backups and nothing else.</p>}
          <input
            class="input"
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete="off"
            autoCapitalize="off"
            spellcheck={false}
            placeholder={recovery ? '64-character recovery key' : '30-digit .backup passphrase'}
            value={pass}
            onInput={(e) => setPass((e.target as HTMLInputElement).value)}
          />
          <button class="btn" disabled={busy || (recovery ? pass.replace(/[^0-9a-zA-Z#=]/g, '').length !== 64 : pass.replace(/\D/g, '').length !== 30)}>
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
        {canImport && (
          <>
            <button class="btn ghost" disabled={busy || importing} onClick={() => act(() => api(`/api/imports/${s.id}/run`, { body: { dryRun: true } }))}>
              <Icon name="eye" size={14} /> Dry run
            </button>
            <button
              class="btn"
              disabled={busy || importing}
              onClick={() =>
                confirm(`Import “${s.label}” into ${account.label}? Messages the hub lacks are added; nothing it has is changed, and it can be undone.`) &&
                act(() => api(`/api/imports/${s.id}/run`, { body: { dryRun: false } }))
              }
            >
              <Icon name="download" size={14} /> {imported ? 'Import again' : 'Import'}
            </button>
          </>
        )}
        {running && (
          <button class="btn ghost" onClick={() => act(() => api('/api/imports/stop', { body: {} }))}>
            Stop
          </button>
        )}
        {run?.counts?.conflicts && !run.dryRun ? (
          <button class="btn ghost" onClick={() => setReview(!review)}>
            <Icon name="merge" size={14} /> {review ? 'Hide differences' : 'Review differences'}
          </button>
        ) : null}
        {(s.status === 'ready' || s.status === 'error') && !running && (
          <button class="btn ghost" disabled={busy} onClick={() => act(() => api(`/api/imports/${s.id}/check`, { body: {} }))}>
            <Icon name="refresh" size={14} /> Check again
          </button>
        )}
        {imported && (
          <button
            class="btn ghost danger"
            disabled={busy || importing}
            onClick={() =>
              confirm(`Undo the import of “${s.label}”? Messages only it brought go again; anything the network has sent since stays.`) &&
              act(async () => {
                const r = await api<{ removed: number }>(`/api/imports/${s.id}/undo`, { body: {} });
                toast({ kind: 'info', title: 'Import undone', body: `${count(r.removed, 'message')} taken out.` });
              })
            }
          >
            Undo import
          </button>
        )}
        <button
          class="btn ghost danger"
          disabled={busy || running}
          onClick={() => confirm(`Delete “${s.label}” from the hub? Messages already imported from it stay.`) && act(() => api(`/api/imports/${s.id}`, { method: 'DELETE' }))}
        >
          <Icon name="trash" size={14} /> Delete
        </button>
      </div>
      {review && <Conflicts s={s} onChange={onChange} />}
    </li>
  );
}

/** Discord: page back through each conversation for what neither an export nor live sync has. */
function GapFillRow({ a }: { a: P.AccountView }) {
  const [st, setSt] = useState<P.GapFillView | null>(null);
  const [all, setAll] = useState(false);
  const load = () => api<P.GapFillView>(`/api/history-gaps/${a.id}`).then(setSt, () => setSt(null));
  useEffect(() => {
    load();
    const t = setInterval(load, st?.running ? 3000 : 20_000);
    return () => clearInterval(t);
  }, [a.id, st?.running]);
  if (!st) return null;
  const act = (path: string, body: unknown) => api<P.GapFillView>(path, { body }).then(setSt, (e) => toast({ kind: 'error', title: 'Could not do that', body: e.message }));
  return (
    <div class="import-gaps">
      <p class="det-note">
        <b>Missing messages.</b> Pages back through each direct and group chat (and each channel an import reached) through this account, a page every few seconds the
        way scrolling up would, until it meets the imported history or the start of the chat. Their files are kept too.
        {st.conversations
          ? ` ${st.done.toLocaleString()} of ${count(st.conversations, 'conversation')} done · ${count(st.fetched, 'message')} fetched in ${count(st.pages, 'page')}${st.failed ? ` · ${st.failed} could not be read` : ''}.`
          : ''}
      </p>
      {st.running && <progress class="import-progress" value={st.done / Math.max(1, st.conversations)} max={1} />}
      <div class="btn-row">
        {st.running ? (
          <button class="btn ghost" onClick={() => act(`/api/history-gaps/${a.id}/stop`, {})}>
            Stop
          </button>
        ) : (
          <>
            <button class="btn ghost" onClick={() => act(`/api/history-gaps/${a.id}`, { allChannels: all })}>
              <Icon name="download" size={14} /> {st.conversations && st.done < st.conversations ? 'Carry on fetching' : 'Fetch missing messages'}
            </button>
            <label class="det-note import-check">
              <input type="checkbox" checked={all} onChange={(e) => setAll((e.target as HTMLInputElement).checked)} /> every server channel too
            </label>
          </>
        )}
      </div>
    </div>
  );
}

export function ImportsSection({ a }: { a: P.AccountView }) {
  const [sources, setSources] = useState<P.ImportSourceView[] | null>(null);
  const [upload, setUpload] = useState<{ name: string; received: number; size: number } | null>(null);
  const cancel = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const load = () => api<{ sources: P.ImportSourceView[] }>('/api/imports').then((r) => setSources(r.sources), () => setSources([]));
  const importing = !!sources?.some((s) => s.run && !s.run.finishedAt);
  // On the Android app, the app itself uploads, so it goes on with the app closed (android.ts, Uploads.kt).
  const native = !!android?.uploads();
  const job = native && android!.upload.value?.accountId === a.id ? android!.upload.value : null;
  const busy = !!upload || job?.state === 'running' || job?.state === 'listing' || importing || !!sources?.some((s) => s.status === 'checking' || s.status === 'counting');
  useEffect(() => {
    load();
    const t = setInterval(load, busy ? 1500 : 15_000);
    return () => clearInterval(t);
  }, [a.id, busy]);
  useEffect(() => () => void (cancel.current = true), []);
  useEffect(
    () =>
      onNativeUpload((u) => {
        if (u?.state === 'done' && u.accountId === a.id) toast({ kind: 'info', title: 'Uploaded', body: `${u.name} is on the hub.` });
        if (u?.state === 'failed' && u.error !== 'cancelled') toast({ kind: 'error', title: 'Upload did not start', body: u.error ?? '' });
        if (u?.state !== 'listing') load();
      }),
    [a.id],
  );
  useEffect(() => folderInput.current?.setAttribute('webkitdirectory', ''), [folderInput.current]);

  const mine = (sources ?? []).filter((s) => s.accountId === a.id || (!s.accountId && (s.network === a.network || !s.network)));
  const help = HELP[a.network];

  const pick = async (picked: File[]) => {
    if (!picked.length) return;
    cancel.current = false;
    const files = picked.map((f) => ({ file: f, path: pathOf(f) }));
    const total = files.reduce((n, f) => n + f.file.size, 0);
    const name = files.length === 1 ? files[0].path : files[0].path.split('/')[0] || `${files.length} files`;
    let received = 0;
    setUpload({ name, received, size: total });
    const bump = (n: number) => {
      received += n;
      setUpload({ name, received, size: total });
    };
    try {
      // The same file or folder again carries on where it stopped.
      const partial = mine.find((s) => s.status === 'uploading' && s.accountId === a.id && s.size === total && s.files === files.length);
      const src =
        partial ??
        (await api<P.ImportSourceView>('/api/imports', {
          body: files.length === 1 ? { accountId: a.id, name: files[0].file.name, size: total } : { accountId: a.id, files: files.map((f) => ({ path: f.path, size: f.file.size })) },
        }));
      const state = partial ? (await api<{ files: { size: number; received: number }[] }>(`/api/imports/${src.id}/files`)).files : files.map(() => ({ received: 0 }));
      received = state.reduce((n, f) => n + f.received, 0);
      // A few at a time: a backup folder is mostly small attachment files.
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const i = next++;
          const from = state[i]?.received ?? 0;
          if (from < files[i].file.size || files[i].file.size === 0) await send(src.id, i, files[i].file, from, bump, () => cancel.current);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      toast({ kind: 'info', title: 'Uploaded', body: `${name} is on the hub.` });
    } catch (e: any) {
      if (e.message !== 'cancelled') toast({ kind: 'error', title: 'Upload stopped', body: `${e.message}. Pick the same ${files.length > 1 ? 'folder' : 'file'} again to carry on.` });
    } finally {
      setUpload(null);
      load();
    }
  };
  const onPick = (e: Event) => {
    const el = e.target as HTMLInputElement;
    const list = [...(el.files ?? [])];
    el.value = '';
    pick(list);
  };

  return (
    <section class="det-section">
      <h3>History</h3>
      <p class="det-note">
        {a.network === 'telegram'
          ? 'Telegram keeps your whole history on its servers: older messages come in as you scroll back.'
          : a.network === 'gmessages'
            ? 'Older texts come from your phone as you scroll back.'
            : `${netName(a.network)} gives a linked device little or no history.`}{' '}
        Bring older messages in from {help?.what ?? 'an export.'} What you upload stays on the hub, in its data directory, and an import only adds what the hub lacks.
      </p>
      {job && job.state !== 'done' && job.state !== 'failed' ? (
        <div class="import-upload">
          <p class="det-note">
            {job.state === 'listing'
              ? `Finding the files${job.name ? ` in ${job.name}` : ''}…`
              : job.state === 'running'
                ? `Uploading ${job.name}: ${bytes(job.received)} of ${bytes(job.size)}. It goes on with the app closed, and the notification shows how far it got.`
                : job.state === 'paused'
                  ? `${job.name} paused at ${bytes(job.received)} of ${bytes(job.size)}.${job.error ? ` ${job.error}` : ''}`
                  : `${job.name ?? 'The upload'} stopped: ${job.error ?? 'the upload failed'}`}
          </p>
          {job.state !== 'listing' && <progress class="import-progress" value={job.received / Math.max(1, job.size)} max={1} />}
          <div class="btn-row">
            {job.state === 'running' && (
              <button class="btn ghost" onClick={() => android!.pauseUpload()}>
                Pause
              </button>
            )}
            {job.state === 'paused' && (
              <button class="btn" onClick={() => android!.resumeUpload()}>
                Carry on
              </button>
            )}
            {(job.state === 'paused' || job.state === 'error') && (
              <button class="btn ghost" title="What reached the hub stays there" onClick={() => android!.forgetUpload()}>
                {job.state === 'error' ? 'Dismiss' : 'Stop'}
              </button>
            )}
          </div>
        </div>
      ) : upload ? (
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
          {help?.folder && (
            <button class="btn ghost" onClick={() => (native ? android!.pickUpload(a.id, 'folder') : folderInput.current?.click())}>
              <Icon name="folder" size={14} /> {help.folder}
            </button>
          )}
          {help?.zip && (
            <button class="btn ghost" onClick={() => (native ? android!.pickUpload(a.id, 'files') : zipInput.current?.click())}>
              <Icon name="paperclip" size={14} /> {help.zip}
            </button>
          )}
          <button class="btn ghost" onClick={() => (native ? android!.pickUpload(a.id, 'files') : fileInput.current?.click())}>
            <Icon name="paperclip" size={14} /> Upload files
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={onPick} />
          <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={onPick} />
          <input ref={folderInput} type="file" multiple hidden onChange={onPick} />
        </div>
      )}
      {mine.length > 0 && (
        <ul class="import-list">
          {mine.map((s) => (
            <SourceRow key={s.id} s={s} account={a} onChange={load} importing={importing} />
          ))}
        </ul>
      )}
      {a.network === 'discord' && !a.demo && <GapFillRow a={a} />}
    </section>
  );
}
