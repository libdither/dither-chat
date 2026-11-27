/**
 * Message search on a thread of its own (docs/search.md, "On a thread of its own"). The hub is one thread, and a search
 * on it waited behind whatever else was running (a ranking refit, a burst of adapter events), seconds at times; on its
 * own thread, with a read-only connection to the same database (search-worker.ts), it waits for nothing but the
 * searches before it. The database is in WAL mode, so each search sees every write the hub committed before it began.
 *
 * One worker, one search at a time, in the order asked. A search still queued is called off, and not run, when a newer
 * one comes as you type from the same device (`key`), or when its request goes away (`signal`). `states` holds, by id,
 * whether each is queued (its id), running (minus its id) or called off (0): the worker claims a search with a
 * compare-and-swap, so a search is either run or called off, never both.
 */
import type * as P from '@dither-chat/protocol';
import type { SearchOptions, Store } from './store.ts';

/** One slot per search in flight; a search's slot is its id modulo this. */
const SLOTS = 4096;

export interface SearchAsk {
  q: string;
  limit: number;
  cursor: string | null;
  context: number;
  typing: boolean;
}

export type WorkerIn =
  | { t: 'open'; file: string; secret: string; states: SharedArrayBuffer }
  | { t: 'hold'; gate: SharedArrayBuffer }
  | { t: 'warm'; people: string[] }
  | ({ t: 'search'; id: number; people: string[] } & SearchAsk);

type WorkerOut =
  | { t: 'opened' }
  | { t: 'broken'; error: string }
  | { t: 'holding' }
  | { t: 'done'; id: number; page: P.SearchPage }
  | { t: 'failed'; id: number; error: string }
  | { t: 'skipped'; id: number };

/** A search called off before it ran: a newer one took its place, or its request went away. */
export class SearchCalledOff extends Error {
  constructor(readonly why: 'superseded' | 'gone') {
    super(why === 'superseded' ? 'a newer search took its place' : 'the request went away');
  }
}

interface Waiting {
  key: string;
  ask: SearchAsk;
  resolve: (p: P.SearchPage) => void;
  reject: (e: Error) => void;
  done: () => void;
}

export class SearchThread {
  private worker: Worker | null = null;
  private readonly states = new Int32Array(new SharedArrayBuffer(4 * SLOTS));
  private lastId = 0;
  private waiting = new Map<number, Waiting>();
  /** Why the worker could not open the database: searches run on the hub's thread instead. */
  private broken: string | null = null;
  /** For tests: the ids of the latest searches the worker ran, and of those it skipped. */
  readonly ran: number[] = [];
  readonly skipped: number[] = [];
  /** For tests: the id the latest search got. */
  get lastAsked(): number {
    return this.lastId;
  }
  private holding: (() => void) | null = null;

  constructor(private d: { store: Store; file: string; secret: string; log?: (line: string) => void }) {}

  /** Starts the worker and has it load people search's list, so the first search does not wait for that. */
  start() {
    this.post({ t: 'warm', people: this.d.store.peopleChanges() });
  }

  search(ask: SearchAsk, o: { key?: string; signal?: AbortSignal } = {}): Promise<P.SearchPage> {
    if (this.broken) return Promise.resolve(this.here(ask));
    if (o.signal?.aborted) return Promise.reject(new SearchCalledOff('gone'));
    const key = o.key ?? '';
    // What you typed before this, still queued, is not wanted any more. Never a search asked with Enter or for more.
    if (ask.typing) for (const [id, w] of this.waiting) if (w.key === key && w.ask.typing) this.callOff(id, 'superseded');
    const id = this.nextId();
    if (id === null) return Promise.reject(new Error('too many searches in flight'));
    return new Promise<P.SearchPage>((resolve, reject) => {
      const gone = () => this.callOff(id, 'gone');
      o.signal?.addEventListener('abort', gone, { once: true });
      this.waiting.set(id, { key, ask, resolve, reject, done: () => o.signal?.removeEventListener('abort', gone) });
      Atomics.store(this.states, id % SLOTS, id);
      this.post({ t: 'search', id, people: this.d.store.peopleChanges(), ...ask });
    });
  }

  /**
   * For tests: keeps the worker busy until the returned function is called, as a slow search would. Resolves once the
   * worker is held.
   */
  hold(): Promise<() => void> {
    const gate = new SharedArrayBuffer(4);
    const release = () => (Atomics.store(new Int32Array(gate), 0, 1), Atomics.notify(new Int32Array(gate), 0));
    return new Promise((resolve) => {
      this.holding = () => resolve(release);
      this.post({ t: 'hold', gate });
    });
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new Error('search stopped'));
  }

  /** Called off if the worker has not started it; one it has started runs to its end. */
  private callOff(id: number, why: SearchCalledOff['why']) {
    if (Atomics.compareExchange(this.states, id % SLOTS, id, 0) !== id) return;
    this.settle(id)?.reject(new SearchCalledOff(why));
  }

  private nextId(): number | null {
    for (let tries = 0; tries < SLOTS; tries++) {
      this.lastId = this.lastId >= 0x3fffffff ? 1 : this.lastId + 1;
      if (Atomics.load(this.states, this.lastId % SLOTS) === 0 && !this.waiting.has(this.lastId)) return this.lastId;
    }
    return null;
  }

  private settle(id: number): Waiting | undefined {
    const w = this.waiting.get(id);
    if (!w) return undefined;
    this.waiting.delete(id);
    w.done();
    return w;
  }

  private post(m: WorkerIn) {
    this.worker ??= this.startWorker();
    this.worker.postMessage(m);
  }

  private startWorker(): Worker {
    const w = new Worker(new URL('./search-worker.ts', import.meta.url).href);
    (w as { unref?: () => void }).unref?.();
    w.onmessage = (e: MessageEvent<WorkerOut>) => this.heard(e.data);
    w.onerror = (e) => {
      this.d.log?.(`search: worker failed: ${e.message}`);
      if (this.worker === w) this.worker = null;
      this.failAll(new Error(`search worker failed: ${e.message}`));
    };
    w.postMessage({ t: 'open', file: this.d.file, secret: this.d.secret, states: this.states.buffer as SharedArrayBuffer } satisfies WorkerIn);
    return w;
  }

  private heard(m: WorkerOut) {
    if (m.t === 'opened') return;
    if (m.t === 'holding') return void (this.holding?.(), (this.holding = null));
    if (m.t === 'broken') {
      this.broken = m.error;
      this.d.log?.(`search: no thread of its own (${m.error}); searching on the hub's thread`);
      this.worker?.terminate();
      this.worker = null;
      // What was queued runs here instead.
      for (const [id, w] of [...this.waiting]) {
        Atomics.store(this.states, id % SLOTS, 0);
        this.settle(id);
        try {
          w.resolve(this.here(w.ask));
        } catch (e) {
          w.reject(e as Error);
        }
      }
      return;
    }
    if (m.t === 'skipped') return void keep(this.skipped, m.id);
    Atomics.store(this.states, m.id % SLOTS, 0);
    keep(this.ran, m.id);
    const w = this.settle(m.id);
    if (!w) return;
    if (m.t === 'done') w.resolve(m.page);
    else w.reject(new Error(m.error));
  }

  /** On the hub's thread, as before. */
  private here(ask: SearchAsk): P.SearchPage {
    return this.d.store.search(ask.q, ask.limit, ask.cursor, ask.context, { typing: ask.typing } satisfies SearchOptions);
  }

  private failAll(e: Error) {
    for (const id of [...this.waiting.keys()]) {
      Atomics.store(this.states, id % SLOTS, 0);
      this.settle(id)?.reject(e);
    }
  }
}

const keep = (list: number[], id: number) => (list.push(id), list.length > 100 && list.shift());
