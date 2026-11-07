/**
 * Files to send, uploaded to the hub a piece at a time (docs/uploads.md). Each starts as it is attached, shows its
 * progress, can be cancelled, and after a dropped connection carries on from what the hub has, so a phone on a flaky
 * connection does not start a large file again. The pieces go with XHR, since fetch says nothing of an upload's
 * progress. Pure apart from the transport, so it is tested without a browser.
 *
 * What a file can be refused for before any of it is sent is worked out here too (`refusal`), so the composer says
 * which file and why, rather than leaving it out.
 */
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { MAX_UPLOAD, UPLOAD_CHUNK } from '@dither-chat/protocol';

export interface Transport {
  start(name: string, mime: string, size: number, signal: AbortSignal): Promise<P.UploadState>;
  state(id: string, signal: AbortSignal): Promise<P.UploadState>;
  /** One piece at `offset`; `onSent` hears how much of it has gone. */
  put(id: string, offset: number, piece: Blob, onSent: (n: number) => void, signal: AbortSignal): Promise<P.UploadState>;
  cancel(id: string): Promise<void>;
}

/** A refusal from the hub: its words, its status, and where to carry on from when it says. */
const refusal = (data: any, status: number) => Object.assign(new Error(data?.error ?? `HTTP ${status}`), { status, received: typeof data?.received === 'number' ? data.received : undefined });

function xhr<T>(method: string, url: string, body: XMLHttpRequestBodyInit | null, signal: AbortSignal, onSent?: (n: number) => void, json = false): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('cancelled', 'AbortError'));
    const x = new XMLHttpRequest();
    x.open(method, url);
    if (json) x.setRequestHeader('content-type', 'application/json');
    if (onSent) x.upload.onprogress = (e) => onSent(e.loaded);
    x.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(x.responseText);
      } catch {}
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(refusal(data, x.status));
    };
    // As fetch does: no answer at all is a TypeError, which the outbox takes as "wait for the hub".
    x.onerror = x.ontimeout = () => reject(new TypeError('Cannot reach the hub'));
    x.onabort = () => reject(new DOMException('cancelled', 'AbortError'));
    signal.addEventListener('abort', () => x.abort(), { once: true });
    x.send(body);
  });
}

export const hubTransport: Transport = {
  start: (name, mime, size, signal) => xhr('POST', '/api/uploads/start', JSON.stringify({ name, mime, size }), signal, undefined, true),
  state: (id, signal) => xhr('GET', `/api/uploads/${id}`, null, signal),
  put: (id, offset, piece, onSent, signal) => xhr('PUT', `/api/uploads/${id}?offset=${offset}`, piece, signal, onSent),
  cancel: (id) => fetch(`/api/uploads/${id}`, { method: 'DELETE' }).then(() => {}, () => {}),
};

/** Whether the browser can still read it: a file moved or deleted since it was picked, or a folder, cannot be. */
export async function readable(b: Blob): Promise<boolean> {
  try {
    await b.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

export const UNREADABLE = 'Cannot be read: it may have been moved or deleted, or be a folder';
const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

/**
 * Why this file cannot be sent to this network, before any of it is uploaded; null when it can. `index` is how many
 * files are already attached, for the network's count.
 */
export function refusalOf(f: { size: number; readable: boolean }, index: number, net: { name: string; bytes: number; files: number }, cap = MAX_UPLOAD): string | null {
  if (f.size === 0) return 'Empty file';
  // Whichever limit is lower is the one it meets first.
  if (f.size > net.bytes && net.bytes <= cap) return `Over ${net.name}’s ${mb(net.bytes)} limit (this is ${mb(f.size)})`;
  if (f.size > cap) return `Over the hub’s ${mb(cap)} limit (this is ${mb(f.size)})`;
  if (!f.readable) return UNREADABLE;
  if (index >= net.files) return `${net.name} takes ${net.files} files at a time`;
  return null;
}

export interface UploadOpts {
  /** An upload the hub already has part of (from before a reload): carried on rather than begun again. */
  id?: string;
  /** The hub's id, once it has one, to keep with the send. */
  onId?: (id: string) => void;
  onProgress?: (sent: number) => void;
  signal?: AbortSignal;
  transport?: Transport;
  /** Tries after the network fails before giving up; the outbox then waits for the hub and asks again. */
  retries?: number;
  wait?: (ms: number) => Promise<void>;
}

/** Upload one file, a piece at a time; resolves when the hub has all of it. */
export async function uploadFile(file: Blob, name: string, mime: string, o: UploadOpts = {}): Promise<P.UploadView> {
  const t = o.transport ?? hubTransport;
  const signal = o.signal ?? new AbortController().signal;
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = o.retries ?? 6;
  const size = file.size;
  let id = o.id;
  let st: P.UploadState | null = null;
  let failures = 0;
  let begunAgain = false;
  for (;;) {
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    let piece: Blob | null = null;
    try {
      if (!st && id) {
        st = await t.state(id, signal);
        // Not this file after all: begin again.
        if (st.size !== size) (st = null), (id = undefined);
      }
      if (!st) {
        st = await t.start(name, mime, size, signal);
        id = st.id;
        o.onId?.(id);
      }
      o.onProgress?.(st.received);
      if (st.received >= size) {
        const { received: _r, ...view } = st;
        return view;
      }
      const from = st.received;
      piece = file.slice(from, Math.min(size, from + UPLOAD_CHUNK));
      st = await t.put(st.id, from, piece, (n) => o.onProgress?.(from + n), signal);
      failures = 0;
    } catch (e: any) {
      if (signal.aborted || e?.name === 'AbortError') throw e;
      // Somewhere else than expected: carry on from what the hub has.
      if (e?.status === 409 && typeof e.received === 'number' && st) {
        st = { ...st, received: e.received };
        continue;
      }
      // The hub no longer has it (it expired, or its data went): begin again, once.
      if (e?.status === 404 && !begunAgain) {
        begunAgain = true;
        st = null;
        id = undefined;
        continue;
      }
      if (e?.status && e.status < 500) throw e;
      // No answer, or the hub failing: first make sure it is not the file that cannot be read.
      if (piece && !(await readable(piece))) throw Object.assign(new Error(UNREADABLE), { status: 400, unreadable: true });
      if (++failures > retries) throw e;
      await wait(Math.min(15_000, 1000 * 2 ** (failures - 1)));
      // Then ask how much it has: a piece cut off midway may have left some.
      st = null;
    }
  }
}

export type UploadStatus = 'uploading' | 'done' | 'failed' | 'cancelled';
export interface UploadProgress {
  sent: number;
  status: UploadStatus;
  /** Why it failed, in words for the person. */
  error?: string;
  /** Failed for want of the hub, not refused: it goes when the hub is back. */
  offline?: boolean;
}

/**
 * One file's upload, as the composer and the outbox see it: progress as a signal, and a result that a send waits on.
 * A failed one can be tried again, carrying on where it stopped.
 */
export class UploadJob {
  readonly progress: Signal<UploadProgress>;
  /** Only the status, for what needs no redraw at every percent. */
  readonly status: ReadonlySignal<UploadStatus>;
  /** The hub's id, once it has given one. */
  id?: string;
  /** Told the hub's id when it gives one; whoever holds the job now (the composer, then the send) sets it. */
  onId?: (id: string) => void;
  result?: P.UploadView;
  private ctl = new AbortController();
  private current!: Promise<P.UploadView>;

  constructor(
    readonly file: Blob,
    readonly name: string,
    readonly type: string,
    private opts: Pick<UploadOpts, 'transport' | 'retries' | 'wait'> & { id?: string } = {},
  ) {
    this.id = opts.id;
    this.progress = signal<UploadProgress>({ sent: 0, status: 'uploading' });
    this.status = computed(() => this.progress.value.status);
    this.run();
  }

  get size() {
    return this.file.size;
  }

  private run() {
    this.progress.value = { sent: this.progress.value.sent, status: 'uploading' };
    this.current = uploadFile(this.file, this.name, this.type, {
      ...this.opts,
      id: this.id,
      signal: this.ctl.signal,
      onId: (id) => {
        this.id = id;
        this.onId?.(id);
      },
      onProgress: (sent) => {
        // Every few percent is enough to draw.
        const last = this.progress.value.sent;
        if (sent === this.size || sent < last || sent - last >= this.size / 50) this.progress.value = { sent, status: 'uploading' };
      },
    }).then(
      (v) => {
        this.result = v;
        this.progress.value = { sent: this.size, status: 'done' };
        return v;
      },
      (e: any) => {
        if (this.progress.value.status !== 'cancelled') {
          const offline = e instanceof TypeError;
          this.progress.value = { sent: this.progress.value.sent, status: 'failed', error: offline ? 'Cannot reach the hub' : String(e?.message ?? e), offline };
        }
        throw e;
      },
    );
    // Nobody may be waiting on it yet: a failure is shown, not thrown at the page.
    this.current.catch(() => {});
  }

  /** What a send waits for: the upload as it goes, or a failed one tried again. */
  settle(): Promise<P.UploadView> {
    const s = this.progress.value.status;
    if (s === 'cancelled') return Promise.reject(new DOMException('cancelled', 'AbortError'));
    if (s === 'failed') this.retry();
    return this.current;
  }

  retry() {
    if (this.progress.value.status !== 'failed') return;
    this.ctl = new AbortController();
    this.run();
  }

  /** Stop it, and have the hub forget what it has of it. */
  cancel() {
    if (this.progress.value.status === 'cancelled') return;
    this.progress.value = { ...this.progress.value, status: 'cancelled' };
    this.ctl.abort();
    if (this.id) void (this.opts.transport ?? hubTransport).cancel(this.id);
  }
}
