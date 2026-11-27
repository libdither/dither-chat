/**
 * Sends not yet with the hub, kept on this device (IndexedDB) with their files.
 *
 * A message typed without the hub waits, and the app says it will go out by itself (docs/sync.md). Kept only in
 * memory, a reload or the system closing the app lost it. Kept here, it is shown again and goes to the hub when it is
 * back, under the same `clientId`.
 *
 * The device's copy lasts only until the hub has the send in its queue (one tick): the hub answers at once, and from
 * then on the hub's row is what every device shows (sendrows.ts, docs/sync.md "The send queue"). The hub keeps every
 * `clientId` for good, so sending the same one again is always safe: a repeat is answered with what the hub has, never
 * sent twice. So a send whose answer was lost (no answer, the socket dropped, a proxy's 502) just goes to the hub again
 * when it is back; it is never in doubt on the device. Being in doubt is the hub's to say, for a send it handed to
 * the network and lost track of. Pure apart from the IndexedDB part, so it is tested without a browser.
 */
import type * as P from '@dither-chat/protocol';

export interface OutboxFile {
  name: string;
  type: string;
  blob: Blob;
}

export interface OutboxEntry {
  /** Also the send's clientId. */
  tempId: string;
  conversationId: string;
  body: string;
  ts: number;
  accountId?: string;
  replyTo?: string;
  /** Kept until the send is through: an upload the hub let expire is made again from these. */
  files?: OutboxFile[];
  /** Each file's upload on the hub as soon as it has one, so one cut off by a reload carries on (upload.ts). */
  uploads?: (string | undefined)[];
  /** The uploads' ids on the hub, once all of each has arrived. */
  attachments?: string[];
  /** Sent without notifying anyone, and (a reply) without pinging its author (docs/sending.md). */
  silent?: boolean;
  mentionReplied?: boolean;
  /** The hub refused it: shown with the reason, to try again or throw away. */
  failed?: string;
  /** The newest message you could see when you pressed Send (sendrows.ts seenUpTo): the hub holds it if more came. */
  seenUpTo?: P.SeenUpTo;
  /** A sticker, a voice message, view-once, a GIF (docs/media-kinds.md): sent with the message as they are. */
  media?: SendMedia;
}

/** What a send carries beyond text and files (the hub's send body: protocol media.ts). */
export interface SendMedia {
  sticker?: string;
  voice?: { seconds: number; waveform?: string };
  viewOnce?: boolean;
  /** The one file is a GIF from the GIF picker: sent as the network's own GIF where it has one. */
  gif?: boolean;
}

interface Outbox {
  put(e: OutboxEntry): Promise<void>;
  remove(tempId: string): Promise<void>;
  all(): Promise<OutboxEntry[]>;
}

const STORE = 'sends';

/** The outbox in IndexedDB; in memory only where there is none (or it refuses), which is how it was before. */
export function openOutbox(factory: IDBFactory | undefined = globalThis.indexedDB, name = 'dither-chat-outbox'): Outbox {
  const memory = new Map<string, OutboxEntry>();
  let dbp: Promise<IDBDatabase | null> | null = null;
  const idb = () =>
    (dbp ??= new Promise<IDBDatabase | null>((resolve) => {
      if (!factory) return resolve(null);
      try {
        const req = factory.open(name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'tempId' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    }));
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
    const d = await idb();
    if (!d) return undefined;
    return new Promise<T | undefined>((resolve) => {
      try {
        const t = d.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = t.onabort = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  };
  return {
    async put(e) {
      memory.set(e.tempId, e);
      await tx('readwrite', (s) => s.put(e));
    },
    async remove(tempId) {
      memory.delete(tempId);
      await tx('readwrite', (s) => s.delete(tempId));
    },
    async all() {
      const kept = (await tx<OutboxEntry[]>('readonly', (s) => s.getAll())) ?? [];
      const out = new Map(kept.map((e) => [e.tempId, e]));
      for (const [k, e] of memory) if (!out.has(k)) out.set(k, e);
      return [...out.values()].sort((a, b) => a.ts - b.ts);
    },
  };
}

// ------------------------------------------------------------------ what a failed POST becomes

/**
 * What a send becomes when its POST to the hub failed:
 * - `queued`: no answer (the request died, the socket with it, a proxy's 502 or 503 for a hub that is gone, a 504):
 *   it waits on the device and goes to the hub again when it is back, under the same clientId. Safe: the hub answers a
 *   repeat with what it has, and sends one id once.
 * - `failed`: the hub answered with a refusal (4xx: an empty message, no account that can write here) or its own
 *   error (500): shown with the reason, to try again or throw away.
 */
export function afterFailure(e: unknown, s: { online: boolean }): 'queued' | 'failed' {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return 'failed';
  const noAnswer = e instanceof TypeError || (e as { name?: unknown } | null)?.name === 'AbortError' || !s.online || status === 502 || status === 503 || status === 504;
  return noAnswer ? 'queued' : 'failed';
}

/** How a send kept from before this start is shown again: failed as it was, else waiting to go to the hub. */
export function restoredState(e: OutboxEntry): { queued?: true; failed?: string } {
  return e.failed ? { failed: e.failed } : { queued: true };
}
