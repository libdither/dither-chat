/**
 * The Feed page's data (docs/feed.md "The Feed page"), in the feed's chunk: which accounts can read and post, your
 * feeds, and each source's entries. A source shows what the hub holds at once, then asks the networks (POST
 * /api/feed/read) when it was not read in the last minute, as a person opening their Home tab would; scrolling past
 * the end brings older posts, the hub's first, then the network's. A feed's order swapped asks the hub only.
 */
import type * as P from '@dither-chat/protocol';
import { signal, type Signal } from '@preact/signals';
import { api, db } from '../../state.ts';

export const sources = signal<P.FeedSourcesView | null>(null);
let sourcesAsked: Promise<void> | null = null;

/** The accounts and drafts count, asked once a page (and again after posting or an account change). */
export function loadSources(again = false): Promise<void> {
  if (sourcesAsked && !again) return sourcesAsked;
  sourcesAsked = api<P.FeedSourcesView>('/api/feed/sources').then(
    (v) => void (sources.value = v),
    () => void (sourcesAsked = null),
  );
  return sourcesAsked;
}

const FEED_CAPS: readonly P.Capability[] = ['home', 'publish', 'postMedia', 'unpublish'];
/** What the Feed page takes from the accounts: the ones that can read or post here, whether each is connected, and
 * what it can do. An account that comes back with its timelines after the page opened changes it (FeedPane asks for
 * the sources again); one with nothing here (a chat account reconnecting) does not. */
export function accountsKey(): string {
  const parts: string[] = [];
  for (const a of db.accounts.values()) {
    const can = FEED_CAPS.filter((c) => a.capabilities.includes(c));
    if (can.length) parts.push(`${a.id}:${a.status === 'online'}:${can.join('+')}`);
  }
  return parts.sort().join();
}

interface Line {
  entries: P.FeedEntryView[];
  /** The hub holds older entries: ask with `before`. */
  before: number | null;
  /** Where the page after these starts, once older posts were read. */
  next: number | null;
  /** The networks have older posts than the hub holds. */
  older: boolean;
  readAt: number | null;
  notes: P.FeedEntriesView['notes'];
  /** Showing what the hub held, before the first answer. */
  loaded: boolean;
  /** Asking the networks now (a fresh read, or older posts). */
  reading: 'top' | 'older' | null;
  error: string | null;
}

const empty = (): Line => ({ entries: [], before: null, next: null, older: false, readAt: null, notes: [], loaded: false, reading: null, error: null });
const lines = new Map<string, Signal<Line>>();
export function line(source: string): Signal<Line> {
  let s = lines.get(source);
  if (!s) lines.set(source, (s = signal(empty())));
  return s;
}

/** The people a view names go into the app's identities, so names and pictures draw. */
function take(v: P.FeedEntriesView) {
  for (const i of v.identities) if (!db.identities.has(i.id)) db.identities.set(i.id, i);
}

/** Entries by key: on top, new ones first; below, a later page's copy of one shown takes its place (its counts are
 * newer) and the rest follow. */
function merge(have: readonly P.FeedEntryView[], add: readonly P.FeedEntryView[], atTop: boolean): P.FeedEntryView[] {
  if (atTop) {
    const keys = new Set(add.map((e) => e.key));
    return [...add, ...have.filter((e) => !keys.has(e.key))];
  }
  const byKey = new Map(add.map((e) => [e.key, e]));
  const had = new Set(have.map((e) => e.key));
  return [...have.map((e) => byKey.get(e.key) ?? e), ...add.filter((e) => !had.has(e.key))];
}
const page = (v: P.FeedEntriesView) => ({ before: v.before, next: v.next, older: v.older, readAt: v.readAt, notes: v.notes });

const READ_AGAIN_MS = 60_000;

/** A source opened: what the hub holds now, then the networks asked when it is not fresh. */
export async function openSource(source: string) {
  const s = line(source);
  try {
    const v = await api<P.FeedEntriesView>(`/api/feed/entries?source=${encodeURIComponent(source)}`);
    take(v);
    s.value = { ...s.value, entries: v.entries, ...page(v), loaded: true, error: null };
    if (!v.readAt || Date.now() - v.readAt > READ_AGAIN_MS || !v.entries.length) await refresh(source);
  } catch (e) {
    s.value = { ...s.value, loaded: true, error: (e as Error).message };
  }
}

/** Ask the networks for what is new (pull to refresh, Refresh, the page opened). */
export async function refresh(source: string) {
  const s = line(source);
  if (s.value.reading) return;
  s.value = { ...s.value, reading: 'top', error: null };
  try {
    const v = await api<P.FeedEntriesView>('/api/feed/read', { method: 'POST', body: { source } });
    take(v);
    s.value = { ...s.value, entries: v.entries, ...page(v), loaded: true, reading: null };
  } catch (e) {
    s.value = { ...s.value, reading: null, error: (e as Error).message };
  }
}

/** Older entries: the next page the hub holds, else the networks' next page. */
export async function more(source: string) {
  const s = line(source);
  const l = s.value;
  if (l.reading || !l.loaded) return;
  if (l.before !== null) {
    s.value = { ...l, reading: 'older' };
    try {
      const v = await api<P.FeedEntriesView>(`/api/feed/entries?source=${encodeURIComponent(source)}&before=${l.before}`);
      take(v);
      s.value = { ...s.value, entries: merge(s.value.entries, v.entries, false), ...page(v), reading: null };
    } catch (e) {
      s.value = { ...s.value, reading: null, error: (e as Error).message };
    }
    return;
  }
  if (!l.older) return;
  s.value = { ...l, reading: 'older' };
  try {
    await api<P.FeedEntriesView>('/api/feed/read', { method: 'POST', body: { source, older: true } });
    const next = s.value.next;
    const v = await api<P.FeedEntriesView>(`/api/feed/entries?source=${encodeURIComponent(source)}${next !== null ? `&before=${next}` : ''}`);
    take(v);
    s.value = { ...s.value, entries: merge(s.value.entries, v.entries, false), ...page(v), reading: null };
  } catch (e) {
    s.value = { ...s.value, reading: null, error: (e as Error).message };
  }
}

/** The same source's posts again from the hub, in its order as it is now (a feed's order swapped): nothing is asked of
 * the networks. */
async function reorder(source: string) {
  const s = line(source);
  try {
    const v = await api<P.FeedEntriesView>(`/api/feed/entries?source=${encodeURIComponent(source)}`);
    take(v);
    s.value = { ...s.value, entries: v.entries, ...page(v), loaded: true, error: null };
  } catch (e) {
    s.value = { ...s.value, error: (e as Error).message };
  }
}

/** Posts just made go on top of the sources that show them (Your posts, and feeds that take that account's
 * Following), before the next read brings them. */
export function addMine(made: P.FeedEntryView[]) {
  const mixes = sources.value?.mixes ?? [];
  for (const [source, s] of lines) {
    const mix = mixes.find((m) => m.id === source);
    const shown = made.filter((e) =>
      e.seenBy.some((x) => source === 'mine' || source === `${x.accountId}:mine` || source === `${x.accountId}:following` || !!mix?.sources.some((y) => y.accountId === x.accountId && y.feed === 'following' && y.share > 0)),
    );
    if (shown.length) s.value = { ...s.value, entries: merge(s.value.entries, shown, true) };
  }
}

/** A post deleted: out of every source (a copy of a cross-post leaves the others). */
export function dropPost(network: P.Network, id: string) {
  const key = `${network}:${id}`;
  for (const s of lines.values()) {
    const had = s.value.entries;
    const next = had.flatMap((e) => {
      if (e.key !== key) return [{ ...e, ...(e.copies ? { copies: e.copies.filter((c) => c.post.id !== id) } : {}) }];
      // The first copy goes: the next one stands in its place.
      const [first, ...rest] = e.copies ?? [];
      return first ? [{ ...e, key: `${network}:${first.post.id}`, post: first.post, copies: rest, seenBy: e.seenBy.filter((x) => x.accountId !== e.seenBy[0]?.accountId) }] : [];
    });
    s.value = { ...s.value, entries: next };
  }
}

// ------------------------------------------------------------------ your feeds

/** The feed's tuning is open (beside the posts, or a sheet on a phone). */
export const tuning = signal(false);

type MixPatch = Partial<Pick<P.FeedMixView, 'name' | 'order' | 'sources'>>;

/** A feed changed: shown at once, saved on the hub, and its posts put in their new order (a timeline turned on that
 * was never read is read). */
export async function saveMix(id: string, patch: MixPatch): Promise<P.FeedMixView> {
  const v = sources.value;
  if (v)
    sources.value = {
      ...v,
      mixes: v.mixes.map((m) =>
        m.id !== id ? m : { ...m, ...patch, sources: patch.sources ? m.sources.map((x) => patch.sources!.find((y) => y.accountId === x.accountId && y.feed === x.feed) ?? x) : m.sources },
      ),
    };
  const saved = await api<P.FeedMixView>(`/api/feed/mixes/${id}`, { method: 'PUT', body: patch });
  const w = sources.value;
  if (w) sources.value = { ...w, mixes: w.mixes.some((m) => m.id === id) ? w.mixes.map((m) => (m.id === id ? saved : m)) : [...w.mixes, saved] };
  if (patch.sources) await openSource(id);
  else if (patch.order) await reorder(id);
  return saved;
}

/** A new feed: every account's Following, taking turns, named for you to change. */
export function newMix(): Promise<P.FeedMixView> {
  const id = `m-${Math.random().toString(36).slice(2, 10)}`;
  return saveMix(id, { name: 'New feed', order: 'turns' });
}

/** A feed you made, gone; Following or Discover, put back as they were. */
export async function dropMix(id: string) {
  await api(`/api/feed/mixes/${id}`, { method: 'DELETE' });
  await loadSources(true);
  // Following or Discover as they were; a feed you made is gone with its posts.
  if (sources.value?.mixes.some((m) => m.id === id)) await reorder(id);
  else lines.delete(id);
}

// ------------------------------------------------------------------ drafts

export const drafts = signal<P.DraftView[] | null>(null);
export function loadDrafts() {
  return api<{ drafts: P.DraftView[] }>('/api/feed/drafts').then((v) => void (drafts.value = v.drafts));
}
export async function saveDraft(id: string, d: Omit<P.DraftView, 'id' | 'updatedAt'>): Promise<P.DraftView> {
  const v = await api<P.DraftView>(`/api/feed/drafts/${id}`, { method: 'PUT', body: d });
  drafts.value = [v, ...(drafts.value ?? []).filter((x) => x.id !== id)];
  void loadSources(true);
  return v;
}
export async function dropDraft(id: string) {
  await api(`/api/feed/drafts/${id}`, { method: 'DELETE' });
  drafts.value = (drafts.value ?? []).filter((x) => x.id !== id);
  void loadSources(true);
}

/** A draft opened in the composer (Edit on a draft): the composer takes it. */
export const editing = signal<P.DraftView | null>(null);
