/**
 * Files to send, uploaded to the hub a piece at a time (docs/uploads.md). Each starts as it is attached, shows its
 * progress, can be cancelled, and after a dropped connection carries on from what the hub has, so a phone on a flaky
 * connection does not start a large file again. Progress is what the hub has said it has, never what was handed to
 * the browser's socket. A photo is made progressive first (progressive/pack.ts), and the photos of a send go up by
 * quality: each one's first whole picture, then each to fair, then good, then the rest (`turn`). The pieces go with
 * XHR, which can tell a piece that has stalled. Pure apart from the transport and the packer, so it is tested without
 * a browser.
 *
 * What a file can be refused for before any of it is sent is worked out here too (`refusal`), so the composer says
 * which file and why, rather than leaving it out.
 */
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { MAX_UPLOAD, UPLOAD_PIECE } from '@dither-chat/protocol';
import type { Packed } from './progressive/pack.ts';

export interface Transport {
  start(name: string, mime: string, size: number, signal: AbortSignal): Promise<P.UploadState>;
  state(id: string, signal: AbortSignal): Promise<P.UploadState>;
  /** One piece at `offset`, given up as no answer (a TypeError) when nothing has moved for STALL_MS. */
  put(id: string, offset: number, piece: Blob, signal: AbortSignal): Promise<P.UploadState>;
  cancel(id: string): Promise<void>;
}

/** A refusal from the hub: its words, its status, and where to carry on from when it says. */
const refusal = (data: any, status: number) =>
  Object.assign(new Error(data?.error ?? `HTTP ${status}`), { status, received: typeof data?.received === 'number' ? data.received : undefined, sent: data?.sent === true });

/**
 * A piece with no bytes moving and no answer for this long is taken as a dead link: given up and asked about again
 * (the hub keeps what came of it). Long enough for a 256 KB piece on a 2G link.
 */
const STALL_MS = 30_000;

function xhr<T>(method: string, url: string, body: XMLHttpRequestBodyInit | null, signal: AbortSignal, stall = false, json = false): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('cancelled', 'AbortError'));
    const x = new XMLHttpRequest();
    x.open(method, url);
    if (json) x.setRequestHeader('content-type', 'application/json');
    let moved = Date.now();
    let stalled = false;
    const watch = stall
      ? setInterval(() => {
          if (Date.now() - moved < STALL_MS) return;
          stalled = true;
          x.abort();
        }, 1000)
      : undefined;
    const done = () => clearInterval(watch);
    if (stall) x.upload.onprogress = () => (moved = Date.now());
    x.onloadend = done;
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
    x.onabort = () => reject(stalled ? new TypeError('The upload stalled') : new DOMException('cancelled', 'AbortError'));
    signal.addEventListener('abort', () => x.abort(), { once: true });
    x.send(body);
  });
}

export const hubTransport: Transport = {
  start: (name, mime, size, signal) => xhr('POST', '/api/uploads/start', JSON.stringify({ name, mime, size }), signal, false, true),
  state: (id, signal) => xhr('GET', `/api/uploads/${id}`, null, signal),
  put: (id, offset, piece, signal) => xhr('PUT', `/api/uploads/${id}?offset=${offset}`, piece, signal, true),
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

interface UploadOpts {
  /** An upload the hub already has part of (from before a reload): carried on rather than begun again. */
  id?: string;
  /** The hub's id, once it has one, to keep with the send. */
  onId?: (id: string) => void;
  /** How much the hub has, each time it says. */
  onProgress?: (received: number) => void;
  /** Offsets a piece ends at, at the latest (a photo's quality stops, pack.ts). */
  stops?: number[];
  /** Waited on before each piece from this offset: another photo may go first (`turn`). */
  gate?: (from: number) => Promise<void>;
  signal?: AbortSignal;
  transport?: Transport;
  /** Tries after the network fails before giving up; the outbox then waits for the hub and asks again. */
  retries?: number;
  wait?: (ms: number) => Promise<void>;
}

/** What an upload ended as: all of it on the hub, or `sent` with a held send before it was all there (410). */
type Uploaded = P.UploadView & { sent?: true };

/** Upload one file, a piece at a time; resolves when the hub has all of it. */
export async function uploadFile(file: Blob, name: string, mime: string, o: UploadOpts = {}): Promise<Uploaded> {
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
      await o.gate?.(from);
      const stop = o.stops?.find((x) => x > from) ?? size;
      piece = file.slice(from, Math.min(size, from + UPLOAD_PIECE, stop));
      st = await t.put(st.id, from, piece, signal);
      failures = 0;
    } catch (e: any) {
      if (signal.aborted || e?.name === 'AbortError') throw e;
      // The hub sent it already, as far as it had come (a held send whose phone went quiet): nothing more to upload.
      // Asked how much it has (st is null then) or sent a piece, alike.
      if (e?.status === 410 && e.sent && (st?.id ?? id)) return { id: (st?.id ?? id)!, name, mime, size, sent: true };
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

type UploadStatus = 'packing' | 'uploading' | 'done' | 'failed' | 'cancelled';
interface UploadProgress {
  /** How much the hub has. */
  sent: number;
  status: UploadStatus;
  /** Why it failed, in words for the person. */
  error?: string;
  /** Failed for want of the hub, not refused: it goes when the hub is back. */
  offline?: boolean;
  /** The hub sent it as far as it had come, a send whose phone stopped (sendqueue.ts). */
  cut?: boolean;
  /** When the hub last said how much it has. */
  at?: number;
}

// ------------------------------------------------------------------ photos by quality

/** The photos uploading now, and the quality stop each is working towards (its index in its stops). */
const tiers = new Map<object, number>();
let woken: (() => void)[] = [];
function setTier(job: object, tier: number | null) {
  if (tier === null) tiers.delete(job);
  else tiers.set(job, tier);
  const w = woken;
  woken = [];
  for (const f of w) f();
}

/**
 * A photo's turn to send a piece towards its `tier`th stop: once no other photo uploading is still short of an
 * earlier stop. So every photo of a send has its first whole picture before any goes on to fair, and so on: a cut
 * leaves all of them usable (docs/uploads.md).
 */
async function turn(job: object, tier: number, signal: AbortSignal) {
  setTier(job, tier);
  while ([...tiers].some(([j, t]) => j !== job && t < tier)) {
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    await new Promise<void>((r) => {
      woken.push(r);
      signal.addEventListener('abort', () => r(), { once: true });
    });
  }
}

/** Makes a photo progressive before it uploads (progressive/pack.ts), loaded the first time a photo needs it. */
export type Packer = (file: Blob) => Promise<Packed | null>;
const loadPacker: Packer = (f) => import('./progressive/pack.ts').then((m) => m.pack(f));

/**
 * One file's upload, as the composer and the outbox see it: progress as a signal, and a result that a send waits on.
 * A failed one can be tried again, carrying on where it stopped. A photo is packed first (progressive), and `file` is
 * then what goes up.
 */
export class UploadJob {
  readonly progress: Signal<UploadProgress>;
  /** Only the status, for what needs no redraw at every percent. */
  readonly status: ReadonlySignal<UploadStatus>;
  /** The hub's id, once it has given one. */
  id?: string;
  /** Told the hub's id when it gives one; whoever holds the job now (the composer, then the send) sets it. */
  onId?: (id: string) => void;
  /** Told the file as it goes up, once a photo is packed: the outbox keeps that one, so a reload carries on the same bytes. */
  onPacked?: (file: Blob) => void;
  result?: Uploaded;
  /** What uploads: the file attached, or the progressive JPEG made of it. */
  file: Blob;
  /** A progressive photo's layers, once packed: where its picture is whole, fair, good (pack.ts). */
  packed: Packed | null = null;
  private ctl = new AbortController();
  private current!: Promise<Uploaded>;
  private ready: Promise<void>;
  private stopped = false;

  constructor(
    readonly original: Blob,
    readonly name: string,
    readonly type: string,
    private opts: Pick<UploadOpts, 'transport' | 'retries' | 'wait'> & { id?: string; packer?: Packer | null } = {},
  ) {
    this.id = opts.id;
    this.file = original;
    const photo = type === 'image/jpeg' || /\.jpe?g$/i.test(name);
    const packer = opts.packer === undefined ? loadPacker : opts.packer;
    this.progress = signal<UploadProgress>({ sent: 0, status: photo && packer ? 'packing' : 'uploading' });
    this.status = computed(() => this.progress.value.status);
    this.ready =
      photo && packer
        ? packer(original).then(
            (p) => {
              if (p) {
                this.packed = p;
                this.file = p.blob;
                if (p.blob !== original) this.onPacked?.(p.blob);
              }
            },
            () => {},
          )
        : Promise.resolve();
    this.run();
  }

  get size() {
    return this.file.size;
  }

  private run() {
    if (this.progress.value.status !== 'packing') this.progress.value = { sent: this.progress.value.sent, status: 'uploading' };
    const signal = this.ctl.signal;
    this.current = this.ready
      .then(() => {
        if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
        if (this.progress.value.status === 'packing') this.progress.value = { sent: 0, status: 'uploading' };
        const stops = this.packed?.stops;
        return uploadFile(this.file, this.name, this.type, {
          ...this.opts,
          id: this.id,
          signal,
          stops,
          gate: stops ? (from) => turn(this, stops.findIndex((x) => x > from), signal) : undefined,
          onId: (id) => {
            this.id = id;
            this.onId?.(id);
          },
          onProgress: (sent) => {
            if (this.progress.value.status === 'uploading') this.progress.value = { sent, status: 'uploading', at: Date.now() };
          },
        });
      })
      .then(
        (v) => {
          setTier(this, null);
          this.result = v;
          this.progress.value = { sent: v.sent ? this.progress.value.sent : this.size, status: 'done', ...(v.sent ? { cut: true } : {}) };
          return v;
        },
        (e: any) => {
          setTier(this, null);
          // Stopped because the hub sent it already: that is how it ended.
          if (this.stopped && this.id) return { id: this.id, name: this.name, mime: this.type, size: this.size, sent: true as const };
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
  settle(): Promise<Uploaded> {
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
    setTier(this, null);
    if (this.id) void (this.opts.transport ?? hubTransport).cancel(this.id);
  }

  /** Stop uploading without a word to the hub: it sent the message already (sendqueue.ts, a send whose files were still coming). */
  stop() {
    if (this.progress.value.status !== 'uploading' && this.progress.value.status !== 'packing') return;
    this.stopped = true;
    this.progress.value = { ...this.progress.value, status: 'done', cut: true };
    this.ctl.abort();
    setTier(this, null);
  }
}
