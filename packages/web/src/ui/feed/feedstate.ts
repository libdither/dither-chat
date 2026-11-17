/**
 * The Feed page's data (docs/feed.md "The Feed page"), in the feed's chunk: which accounts can read and post, and each
 * source's entries. A source shows what the hub holds at once, then asks the networks (POST /api/feed/read) when it
 * was not read in the last minute, as a person opening their Home tab would; scrolling past the end brings older
 * posts, the hub's first, then the network's.
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

interface Line {
  entries: P.FeedEntryView[];
  /** The hub holds older entries: ask with `before`. */
  before: number | null;
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

const empty = (): Line => ({ entries: [], before: null, older: false, readAt: null, notes: [], loaded: false, reading: null, error: null });
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

/** Entries by key: a later page's copy of one replaces the earlier (its counts are newer). */
function merge(have: readonly P.FeedEntryView[], add: readonly P.FeedEntryView[], atTop: boolean): P.FeedEntryView[] {
  const keys = new Set(add.map((e) => e.key));
  const kept = have.filter((e) => !keys.has(e.key));
  return atTop ? [...add, ...kept].sort((a, b) => b.at - a.at) : [...kept, ...add];
}

const READ_AGAIN_MS = 60_000;

/** A source opened: what the hub holds now, then the networks asked when it is not fresh. */
export async function openSource(source: string) {
  const s = line(source);
  try {
    const v = await api<P.FeedEntriesView>(`/api/feed/entries?source=${encodeURIComponent(source)}`);
    take(v);
    s.value = { ...s.value, entries: v.entries, before: v.before, older: v.older, readAt: v.readAt, notes: v.notes, loaded: true, error: null };
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
    s.value = { ...s.value, entries: v.entries, before: v.before, older: v.older, readAt: v.readAt, notes: v.notes, loaded: true, reading: null };
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
      s.value = { ...s.value, entries: merge(s.value.entries, v.entries, false), before: v.before, older: v.older, reading: null };
    } catch (e) {
      s.value = { ...s.value, reading: null, error: (e as Error).message };
    }
    return;
  }
  if (!l.older) return;
  s.value = { ...l, reading: 'older' };
  try {
    await api<P.FeedEntriesView>('/api/feed/read', { method: 'POST', body: { source, older: true } });
    const last = s.value.entries[s.value.entries.length - 1]?.at;
    const v = await api<P.FeedEntriesView>(`/api/feed/entries?source=${encodeURIComponent(source)}${last !== undefined ? `&before=${last}` : ''}`);
    take(v);
    s.value = { ...s.value, entries: merge(s.value.entries, v.entries, false), before: v.before, older: v.older, reading: null };
  } catch (e) {
    s.value = { ...s.value, reading: null, error: (e as Error).message };
  }
}

/** Posts just made go on top of the sources that show them, before the next read brings them. */
export function addMine(made: P.FeedEntryView[]) {
  for (const [source, s] of lines) {
    const shown = made.filter((e) => source === 'mine' || e.seenBy.some((x) => source === `${x.accountId}:mine` || source === 'home' || source === `${x.accountId}:following`));
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
