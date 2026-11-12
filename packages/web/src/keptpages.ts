/**
 * Message pages kept on this device (docs/sync.md, "Kept pages"): the newest messages of the conversations opened most
 * recently, and of those fetched ahead, so that opening one shows its messages at once, before the hub answers, even
 * right after a start. Each opened page is then caught up from the journal position it was kept at (state.ts
 * fillTimeline: what is newer, and what changed inside it), or replaced by the hub's page when that cannot be said.
 *
 * One record per timeline in IndexedDB (snapshot.ts holds the database), written only when its messages changed, and an
 * index of when each was last opened or fetched. Records are read at start as text and parsed only when opened. The
 * least recently used go first past MAX_PAGES or MAX_PAGES_CHARS. Nothing here is ever sent anywhere.
 */
import type * as P from '@dither-chat/protocol';

/** Pages kept, most recently used first. 60 served 80% of a week's opens in a replay, 40 77.5%, 12 60.5% (docs/perf.md). */
export const MAX_PAGES = 60;
/** The newest messages kept of each. */
export const MAX_PAGE_MESSAGES = 40;
/** All of them together, in characters of JSON. */
export const MAX_PAGES_CHARS = 3_000_000;
/** The index's key in the store; no timeline key starts with '#'. */
export const INDEX_KEY = '#index';

/** One kept page, as stored (its text) and as shown (parsed). */
export interface KeptPage {
  key: string;
  messages: P.MessageView[];
  conversationIds?: string[];
  /** The journal position these messages are current to: opening it asks only for what changed since (docs/sync.md). */
  sync?: P.SyncPosition;
  /** Authors and reactors of the messages, and the messages replies quote, which the bootstrap may not have. */
  identities: P.IdentityView[];
  quoted: P.MessageView[];
}
export interface PageRecord {
  schema: string;
  key: string;
  text: string;
}
export interface IndexRecord {
  schema: string;
  /** Key and when it was last opened or fetched ahead. */
  at: [string, number][];
}

/** What the store does with a save (snapshot.ts runs it in one transaction). */
export interface PageWrites {
  put: PageRecord[];
  del: string[];
  index: IndexRecord;
}

/** A timeline as the client holds it (state.ts Timeline), with the position its messages are current to. */
export interface LiveTimeline {
  messages: P.MessageView[];
  conversationIds?: string[];
  detached?: boolean;
  loading?: boolean;
  sync?: P.SyncPosition;
}

/** The text of a page: its newest messages, with the people and quoted messages they name. */
export function pageText(key: string, t: LiveTimeline, identities: Map<string, P.IdentityView>, quoted: Map<string, P.MessageView>): string {
  const messages = t.messages.slice(-MAX_PAGE_MESSAGES);
  const have = new Set(messages.map((m) => m.id));
  const people = new Set<string>();
  const q: P.MessageView[] = [];
  for (const m of messages) {
    if (m.authorId) people.add(m.authorId);
    for (const r of m.reactions) for (const i of r.identityIds) people.add(i);
    const r = m.replyToId && !have.has(m.replyToId) ? quoted.get(m.replyToId) : undefined;
    if (r) {
      have.add(r.id);
      q.push(r);
      if (r.authorId) people.add(r.authorId);
    }
  }
  const ids: P.IdentityView[] = [];
  for (const id of people) {
    const i = identities.get(id);
    if (i) ids.push(i);
  }
  const page: KeptPage = { key, messages, ...(t.conversationIds ? { conversationIds: t.conversationIds } : {}), ...(t.sync ? { sync: t.sync } : {}), identities: ids, quoted: q };
  return JSON.stringify(page);
}

const epochOf = (s: P.SyncPosition | undefined) => (s ? `${s.v}:${s.epoch}` : '');

export class PageCache {
  /** When each page was last opened or fetched ahead: what to keep, the most recent first. */
  private at = new Map<string, number>();
  /** Records read at start and not yet opened: their text, parsed when opened. */
  private unread = new Map<string, PageRecord>();
  /** What the store holds: each record's size in characters. */
  private stored = new Map<string, number>();
  /** What each stored record was written from, to tell a page that changed from one that did not. */
  private wrote = new Map<string, { msgs: P.MessageView[]; convs: string; epoch: string }>();
  /** Records to write that were not made from a timeline in memory (an older snapshot's pages). */
  private loose = new Map<string, string>();

  constructor(
    readonly schema: string,
    private now: () => number = Date.now,
  ) {}

  /** What the store held at start. Records of another schema are left out, and go at the next save. */
  adopt(records: (PageRecord | IndexRecord)[]) {
    let index: IndexRecord | undefined;
    for (const r of records) {
      if ('at' in r) index = r;
      else if (r.schema === this.schema) {
        this.unread.set(r.key, r);
        this.stored.set(r.key, r.text.length);
        this.at.set(r.key, 0);
      } else this.stored.set(r.key, Infinity);
    }
    if (index?.schema === this.schema) for (const [k, t] of index.at) if (this.at.has(k)) this.at.set(k, t);
  }

  /** Pages from a snapshot of before this store (they were part of its rest), kept as they were. */
  adoptLegacy(pages: KeptPage[]) {
    const t = this.now();
    pages.forEach((p, i) => {
      if (this.at.has(p.key)) return;
      const text = JSON.stringify(p);
      this.unread.set(p.key, { schema: this.schema, key: p.key, text });
      this.loose.set(p.key, text);
      this.at.set(p.key, t - 1 - i);
    });
  }

  /** Opened now, or fetched ahead: it goes first in what is kept. */
  touch(key: string) {
    this.at.set(key, this.now());
  }

  /** A kept page not yet opened since the start, given once: what opening it shows while the hub catches it up. */
  take(key: string): KeptPage | undefined {
    const r = this.unread.get(key);
    if (!r) return undefined;
    this.unread.delete(key);
    try {
      const page = JSON.parse(r.text) as KeptPage;
      // The messages shown are these objects: if nothing changes them, the record stays as it is.
      this.wrote.set(key, { msgs: page.messages.slice(-MAX_PAGE_MESSAGES), convs: (page.conversationIds ?? []).join(','), epoch: epochOf(page.sync) });
      return page;
    } catch {
      this.forget(key);
      return undefined;
    }
  }

  /** Has a page for it: one not yet opened since the start, or one kept from memory. */
  has(key: string): boolean {
    return this.unread.has(key) || this.stored.has(key);
  }

  /** Keys of the pages not yet opened since the start. */
  unopened(): string[] {
    return [...this.unread.keys()];
  }

  /** Gone from the hub (a conversation removed, an account left): never shown again, and deleted at the next save. */
  forget(key: string) {
    this.at.delete(key);
    this.unread.delete(key);
    this.loose.delete(key);
    this.wrote.delete(key);
  }

  /**
   * What to write: the most recently used pages within the bounds, each written again only when its messages, the
   * conversations it spans or its position's epoch changed. An older position for the same messages is still right
   * (catching up from it asks for a little more), so a page that did not change keeps its record. `live` is the
   * timeline in memory for a key, if any; `exists` says whether its conversation or person is still there.
   */
  save(o: { live: (key: string) => LiveTimeline | undefined; exists: (key: string) => boolean; identities: Map<string, P.IdentityView>; quoted: Map<string, P.MessageView> }): PageWrites {
    for (const k of [...this.at.keys()]) if (!o.exists(k)) this.forget(k);
    const order = [...this.at.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
    const put: PageRecord[] = [];
    let chars = 0;
    let n = 0;
    const keep = new Set<string>();
    for (const key of order) {
      const t = o.live(key);
      // A glance only when it was fetched ahead (touched): Catch up's cards never are.
      const usable = t && !t.detached && !t.loading && t.messages.length > 0;
      let text: string | null = null;
      let made: { msgs: P.MessageView[]; convs: string; epoch: string } | null = null;
      if (usable) {
        const msgs = t.messages.slice(-MAX_PAGE_MESSAGES);
        const convs = (t.conversationIds ?? []).join(',');
        const epoch = epochOf(t.sync);
        const w = this.wrote.get(key);
        const same = !!w && this.stored.has(key) && w.convs === convs && (w.epoch === epoch || !epoch) && w.msgs.length === msgs.length && msgs.every((m, i) => m === w.msgs[i]);
        if (!same) {
          text = pageText(key, t, o.identities, o.quoted);
          made = { msgs, convs, epoch };
        }
      } else if (this.loose.has(key)) text = this.loose.get(key)!;
      // Nothing to keep for it: not in memory and never stored (one opened and left before it loaded).
      const size = text?.length ?? this.stored.get(key);
      if (size === undefined) continue;
      if (n + 1 > MAX_PAGES || chars + size > MAX_PAGES_CHARS) continue;
      n++;
      chars += size;
      keep.add(key);
      if (text !== null) {
        put.push({ schema: this.schema, key, text });
        this.stored.set(key, text.length);
        this.loose.delete(key);
        if (made) this.wrote.set(key, made);
      }
    }
    const del: string[] = [];
    for (const k of [...this.stored.keys()]) {
      if (keep.has(k)) continue;
      del.push(k);
      this.stored.delete(k);
      this.wrote.delete(k);
      this.loose.delete(k);
    }
    // What fell out of the bounds stays out: it is not in memory any more than in the store.
    for (const k of [...this.at.keys()]) if (!keep.has(k) && !o.live(k)) this.at.delete(k);
    return { put, del, index: { schema: this.schema, at: order.filter((k) => keep.has(k)).map((k) => [k, this.at.get(k)!] as [string, number]) } };
  }
}
