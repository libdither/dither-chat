/**
 * Files attached in the composer (docs/uploads.md). Each starts uploading as it is attached and shows how far it got,
 * with a cancel; one that failed can be tried again. A file that cannot be sent stays in the row, saying why (too
 * large for the network or the hub, empty, unreadable, one too many), rather than being left out without a word.
 */
import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS } from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { bytes } from '../format.ts';
import { netName } from '../model.ts';
import { connected, startUpload, uploadsOf } from '../state.ts';
import { readable, refusalOf, type UploadJob } from '../upload.ts';
import { isMedia } from '../camera.ts';
import { Icon } from './icons.tsx';

export interface Attached {
  key: number;
  file: File;
  url: string | null;
  /** Its upload; none for a file refused before it began. */
  job?: UploadJob;
  refused?: string;
}

let keys = 0;

/** The composer's files for one conversation: cancelled when you leave it, handed to the send when you send. */
export function useAttached(network: P.Network | undefined, convId: string) {
  const [files, setFiles] = useState<Attached[]>([]);
  const cur = useRef(files);
  cur.current = files;
  const add = async (list: File[]) => {
    if (!network || !list.length) return;
    const net = { name: netName(network), ...ATTACHMENT_LIMITS[network] };
    const checked = await Promise.all(list.map(async (file) => ({ file, readable: file.size === 0 || (await readable(file)) })));
    // Counted against what is attached by now, refused ones aside.
    let n = cur.current.filter((f) => !f.refused).length;
    const added = checked.map(({ file, readable }): Attached => {
      const refused = refusalOf({ size: file.size, readable }, n, net);
      if (refused) return { key: keys++, file, url: null, refused };
      n++;
      return { key: keys++, file, url: isMedia(file) ? URL.createObjectURL(file) : null, job: startUpload(file) };
    });
    setFiles((c) => [...c, ...added]);
  };
  const remove = (key: number) => {
    const f = cur.current.find((x) => x.key === key);
    f?.job?.cancel();
    if (f?.url) URL.revokeObjectURL(f.url);
    setFiles((c) => c.filter((x) => x.key !== key));
  };
  /** `sent`: they went with a send, which has their uploads now. Otherwise the uploads are cancelled. */
  const clear = (sent: boolean) => {
    for (const f of cur.current) {
      if (!sent) f.job?.cancel();
      if (f.url) URL.revokeObjectURL(f.url);
    }
    setFiles([]);
  };
  useEffect(() => () => clear(false), [convId]);
  // One that failed for want of the hub tries again once the hub is back.
  const online = connected.value;
  useEffect(() => {
    if (online) for (const f of cur.current) if (f.job?.progress.value.offline) f.job.retry();
  }, [online]);
  const sendable = files.filter((f) => f.job);
  // Only the status: no redraw of the whole composer at every percent. A file waiting for the hub does not hold up a
  // send, which then waits for the hub as any send does; one the hub refused does, until it is tried again or removed.
  const failed = sendable.some((f) => f.job!.status.value === 'failed' && !f.job!.progress.peek().offline);
  return { files, add, remove, clear, sendable, failed };
}

export function AttachedFiles({ files, remove }: { files: Attached[]; remove: (key: number) => void }) {
  if (!files.length) return null;
  return (
    <div class="composer-files">
      {files.map((f) => (
        <AttachedFile key={f.key} f={f} remove={() => remove(f.key)} />
      ))}
    </div>
  );
}

function AttachedFile({ f, remove }: { f: Attached; remove: () => void }) {
  const { status, why, pct } = statusOf(f);
  const name = f.file.name || 'file';
  return (
    <div class={`composer-file ${status}`} data-status={status} title={why ? `${name}: ${why}` : name}>
      <Thumb f={f} />
      <div class="composer-file-text">
        <span class="composer-file-name">{name}</span>
        {why ? (
          <span class="composer-file-why" role="alert">
            {why}
          </span>
        ) : status === 'uploading' ? (
          <span class="upload-bar" role="progressbar" aria-label={`Uploading ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </span>
        ) : (
          <span class="composer-file-size">{bytes(f.file.size)}</span>
        )}
      </div>
      {status === 'failed' && (
        <button class="btn ghost small" onClick={() => f.job!.retry()}>
          Retry
        </button>
      )}
      <button class="icon-btn small" onClick={remove} title={status === 'uploading' ? 'Cancel the upload' : 'Remove'} aria-label={status === 'uploading' ? `Cancel uploading ${name}` : `Remove ${name}`}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

/** A photo or a video's first frame where there is one, else the file's icon. */
export function Thumb({ f, size = 22 }: { f: Attached; size?: number }) {
  if (!f.url) return <Icon name="file" size={size} />;
  return f.file.type.startsWith('video/') ? <video src={f.url} muted playsInline preload="metadata" aria-hidden="true" /> : <img src={f.url} alt="" />;
}

/** Where an attached file has got, in words: why it cannot go, that it failed, or how far it is. */
export function statusOf(f: Attached): { status: string; why: string | null; pct: number } {
  const p = f.job?.progress.value;
  const status = f.refused ? 'refused' : (p?.status ?? 'done');
  const pct = p && f.file.size ? Math.min(100, Math.floor((p.sent / f.file.size) * 100)) : 0;
  const why = f.refused ?? (p?.status === 'failed' ? (p.offline ? 'Waiting for the hub' : `Upload failed: ${p.error}`) : null);
  return { status, why, pct };
}

/** How far one file of a sent message has uploaded, on its pending copy. */
export function PendingUpload({ tempId, index }: { tempId: string; index: number }) {
  const job = uploadsOf(tempId)[index];
  const p = job?.progress.value;
  if (!job || !p || p.status === 'done') return null;
  return <span class="pending-upload"> · {p.status === 'failed' ? p.error : `${Math.min(100, Math.floor((p.sent / (job.size || 1)) * 100))}%`}</span>;
}
