/**
 * Sending with more than words (docs/sending.md), the page's side: whether a reply pings its author (remembered per
 * account, as Discord's reply bar remembers it), sending silently, Send later's list as the hub keeps it, and what
 * you saved on the network. The times offered and the words for them are pure and tested; the rest calls the hub.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { api, connected, eventHooks, toast } from './state.ts';
import { whenWords } from './sendtimes.ts';

export * from './sendtimes.ts';

// ------------------------------------------------------------------ capabilities

const has = (acc: P.AccountView | null | undefined, cap: P.Capability) => !!acc?.capabilities.includes(cap);
/** The send can go out without notifying anyone (Discord's @silent). */
export const canSendSilently = (acc: P.AccountView | null | undefined) => has(acc, 'silentSend');
/** A reply can leave its author unpinged. */
export const canReplyQuietly = (acc: P.AccountView | null | undefined) => has(acc, 'replyMention');
export const canSaveOnNetwork = (acc: P.AccountView | null | undefined) => has(acc, 'savedMessages');
export const canRemovePreviews = (acc: P.AccountView | null | undefined) => has(acc, 'suppressEmbeds');

// ------------------------------------------------------------------ Send later

/** The hub's list (and, once the list was opened, the networks' own), or null before it was read. */
export const scheduled = signal<P.ScheduledSendView[] | null>(null);
let networkItems: P.ScheduledSendView[] = [];

/** The hub's list, with each network's own scheduled messages when `network` (asked only when the list is opened). */
export async function loadScheduled(network = false) {
  try {
    const r = await api<{ items: P.ScheduledSendView[] }>(`/api/scheduled${network ? '?network=1' : ''}`);
    if (network) networkItems = r.items.filter((x) => x.where === 'network');
    setScheduled(r.items.filter((x) => x.where === 'hub'));
  } catch {
    // The list waits for the next try; the composer works without it.
  }
}

function setScheduled(hub: P.ScheduledSendView[]) {
  scheduled.value = [...hub, ...networkItems].sort((a, b) => a.dueAt - b.dueAt);
}

/** Read once, then kept by the hub's `scheduled` events; again after a reconnect. */
let started = false;
export function watchScheduled() {
  if (started) return;
  started = true;
  eventHooks.add((ev) => {
    if (ev.t === 'scheduled') setScheduled(ev.items);
    else if (ev.t === 'resync') void loadScheduled();
  });
  connected.subscribe((on) => on && void loadScheduled());
}


export async function scheduleSend(b: P.ScheduleBody): Promise<P.ScheduledSendView | null> {
  try {
    const v = await api<P.ScheduledSendView>('/api/scheduled', { body: b });
    toast({ kind: 'info', title: 'Scheduled', body: `It goes out ${whenWords(v.dueAt, Date.now())}.` });
    return v;
  } catch (e) {
    toast({ kind: 'error', title: 'Not scheduled', body: (e as Error).message });
    return null;
  }
}

export async function editScheduled(id: string, patch: { body?: string; dueAt?: number }): Promise<boolean> {
  try {
    await api(`/api/scheduled/${id}`, { method: 'PATCH', body: patch });
    return true;
  } catch (e) {
    toast({ kind: 'error', title: 'Not changed', body: (e as Error).message });
    return false;
  }
}

export async function sendScheduledNow(id: string) {
  try {
    const v = await api<P.ScheduledSendView>(`/api/scheduled/${id}/send`, { body: {} });
    if (v.state === 'failed') toast({ kind: 'error', title: 'Not sent', body: v.note ?? 'The network refused it' });
  } catch (e) {
    toast({ kind: 'error', title: 'Not sent', body: (e as Error).message });
  }
}

export async function cancelScheduled(v: P.ScheduledSendView) {
  try {
    await api(`/api/scheduled/${v.id}`, { method: 'DELETE' });
    if (v.where === 'network') {
      networkItems = networkItems.filter((x) => x.id !== v.id);
      setScheduled((scheduled.value ?? []).filter((x) => x.where === 'hub'));
    }
  } catch (e) {
    toast({ kind: 'error', title: 'Not cancelled', body: (e as Error).message });
  }
}

// ------------------------------------------------------------------ saved on the network

/** What the hub last heard was saved, by message id; null until first read. */
export const saved = signal<Map<string, P.SavedView> | null>(null);
let savedLoading: Promise<void> | null = null;

/** What the hub last heard (no request to the network), once. */
export function knowSaved(): Promise<void> {
  return (savedLoading ??= api<P.SavedPage>('/api/saved').then(
    (p) => void (saved.value = new Map(p.saved.map((s) => [s.messageId, s]))),
    () => void (savedLoading = null),
  ));
}

/** The list as each network has it now (the owner opened it). */
export async function loadSaved(more?: { account: string; before: number }): Promise<P.SavedPage> {
  const q = more ? `?account=${encodeURIComponent(more.account)}&before=${more.before}` : '?fresh=1';
  const p = await api<P.SavedPage>(`/api/saved${q}`);
  saved.value = new Map(p.saved.map((s) => [s.messageId, s]));
  return p;
}

export async function saveOnNetwork(m: P.MessageView, dueAt?: number) {
  try {
    const v = await api<P.SavedView>(`/api/messages/${m.id}/save`, { body: dueAt !== undefined ? { dueAt } : {} });
    saved.value = new Map(saved.value ?? []).set(m.id, v);
    toast({ kind: 'info', title: dueAt !== undefined ? 'Reminder set' : 'Saved', body: dueAt !== undefined ? `Discord reminds you ${whenWords(dueAt, Date.now())}.` : 'Saved on Discord.' });
  } catch (e) {
    toast({ kind: 'error', title: 'Not saved', body: (e as Error).message });
  }
}

export async function unsaveOnNetwork(m: Pick<P.MessageView, 'id'>) {
  try {
    await api(`/api/messages/${m.id}/save`, { body: { remove: true } });
    const next = new Map(saved.value ?? []);
    next.delete(m.id);
    saved.value = next;
  } catch (e) {
    toast({ kind: 'error', title: 'Not removed', body: (e as Error).message });
  }
}

export async function removePreviews(m: P.MessageView) {
  try {
    await api(`/api/messages/${m.id}/remove-previews`, { body: {} });
  } catch (e) {
    toast({ kind: 'error', title: 'Previews not removed', body: (e as Error).message });
  }
}
