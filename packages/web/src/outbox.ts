/**
 * Sends not yet through to the hub, kept on this device (IndexedDB), and how a sent copy finds the message it became.
 *
 * A message typed without the hub waits, and the app says it will go out by itself (docs/sync.md). Kept only in
 * memory, a reload or the system closing the app lost it. Kept here, with its files, it is shown again and goes out
 * when the hub is back, under the same `clientId`, so the hub sends a retry once (server.ts).
 *
 * The pending copy on screen goes once the real message is here. The hub's answer names it (`messageId`), so it is
 * matched by id; only an answer without one (a network that did not say) falls back to the text, and one message
 * never stands for two copies. On a slow link the message can come back on the socket before the answer: a copy that
 * went to the hub then takes a message of ours that came after it, with exactly its text and files, and is hidden
 * until the answer is here. Pure apart from the IndexedDB part, so it is tested without a browser.
 */

export interface OutboxFile {
  name: string;
  type: string;
  blob: Blob;
}

export interface OutboxEntry {
  /** Also the send's clientId (with `~<attempt>` after a retry you asked for, below). */
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
  /**
   * The hub could not tell whether it went out (the network did not answer in time, 504). A retry you ask for then
   * goes as a new send (`attempt`), since the hub answers the old id with the same "may have been sent".
   */
  unsure?: boolean;
  attempt?: number;
  /** A sticker, a voice message, view-once (docs/media-kinds.md): sent with the message as they are. */
  media?: SendMedia;
}

/** What a send carries beyond text and files (the hub's send body: protocol media.ts). */
export interface SendMedia {
  sticker?: string;
  voice?: { seconds: number; waveform?: string };
  viewOnce?: boolean;
}

export interface Outbox {
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

// ------------------------------------------------------------------ the copy on screen and its message

/** A pending copy, as far as matching goes. */
export interface Sent {
  tempId: string;
  conversationId: string;
  body: string;
  ts: number;
  files?: string[];
  /** The account it goes out from, when you chose one. */
  accountId?: string;
  /** The hub took it. */
  acked?: boolean;
  /** The hub's id for the message it became, when its answer (or its `sent` event) said. */
  messageId?: string;
  /** When it last went to the hub, by this device's clock: from then on it may be out on the network. */
  postedAt?: number;
  /** Its message came before the hub's answer: hidden until the answer is here. */
  echoed?: boolean;
}

/** A message of ours the client has. */
export interface Echo {
  id: string;
  conversationId: string;
  body: string;
  ts: number;
  attachments: number;
  /** The account of ours that wrote it, when it is one's own identity. */
  accountId?: string;
  /** When it came on the socket, by this device's clock; none for one read from a page. */
  seen?: number;
}

/**
 * Whether a send whose POST failed may be out on the network all the same: no answer, a 504 ("it may have been
 * sent") or another error after the hub handed it on. Not when the hub refused it first (4xx): then a message that
 * looks like it is another send's.
 */
export function mayBeOut(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return !(typeof status === 'number' && status >= 400 && status < 500);
}

/** How much earlier than the copy its message may be dated: the network's clock, not this device's. */
export const ECHO_SKEW = 60_000;

const sameContent = (s: Sent, m: Echo) => (s.files?.length ? m.attachments > 0 : s.body.trim() === m.body.trim());
/** Before the answer, only what is plainly the same message: its text and as many files. */
const sameExactly = (s: Sent, m: Echo) => s.body.trim() === m.body.trim() && (s.files?.length ?? 0) === m.attachments;
const sameAccount = (s: Sent, m: Echo) => !s.accountId || !m.accountId || s.accountId === m.accountId;
/** It came after the copy went to the hub: one that came before is another send (from another device, earlier). */
const cameAfter = (s: Sent, m: Echo) => (m.seen === undefined ? !!s.acked : m.seen >= (s.postedAt ?? s.ts));

/**
 * The copies the messages we have now stand for, by tempId. By id first; then by text, in send order, each copy taking
 * the oldest message of ours in the same conversation (from the same account) dated no earlier than the copy that no
 * other copy took: for copies the hub took without saying which message they became, the same text (with files, when
 * it had files); for copies that went to the hub and have no answer yet, exactly the same text and number of files,
 * and only a message that came on the socket after the copy went. `claimed` holds the messages already matched, and
 * grows: one message never takes two copies, and a copy waiting for its id never takes another's message. A copy
 * already `echoed` is its own message's once the hub took it.
 */
export function settled(sent: Sent[], echoes: Echo[], claimed: Set<string>): string[] {
  const out: string[] = [];
  const byId = new Map(echoes.map((m) => [m.id, m]));
  for (const s of sent) {
    if (s.messageId && byId.has(s.messageId)) {
      out.push(s.tempId);
      claimed.add(s.messageId);
    }
  }
  const waitingIds = new Set(sent.filter((s) => s.messageId).map((s) => s.messageId!));
  const oldest = [...echoes].sort((a, b) => a.ts - b.ts);
  for (const s of [...sent].sort((a, b) => a.ts - b.ts)) {
    if (s.messageId) continue;
    if (s.echoed) {
      if (s.acked) out.push(s.tempId);
      continue;
    }
    if (!s.acked && s.postedAt === undefined) continue;
    const m = oldest.find(
      (m) =>
        !claimed.has(m.id) &&
        !waitingIds.has(m.id) &&
        m.conversationId === s.conversationId &&
        m.ts >= s.ts - ECHO_SKEW &&
        sameAccount(s, m) &&
        cameAfter(s, m) &&
        (s.acked ? sameContent(s, m) : sameExactly(s, m)),
    );
    if (!m) continue;
    out.push(s.tempId);
    claimed.add(m.id);
  }
  return out;
}
