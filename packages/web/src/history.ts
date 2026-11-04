/**
 * What the hub keeps of what changes and what the networks take back (docs/history.md): the settings, shared by
 * every device, and reading a place's or person's change log.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION } from '@dither-chat/protocol';
import { api, db, eventHooks, rev, toast } from './state.ts';

export const retention = signal<P.RetentionSettings>(DEFAULT_RETENTION);
let loading: Promise<void> | null = null;

export function loadRetention(): Promise<void> {
  loading ??= api<P.RetentionSettings>('/api/retention').then(
    (r) => void (retention.value = r),
    () => void (loading = null),
  );
  return loading;
}

eventHooks.add((ev) => {
  if (ev.t === 'retention') retention.value = ev.retention;
});

/** Change some settings; shown at once, put back if the hub refuses. */
export async function saveRetention(patch: Partial<P.RetentionSettings>) {
  const before = retention.value;
  retention.value = { ...before, ...patch };
  try {
    retention.value = await api<P.RetentionSettings>('/api/retention', { method: 'PUT', body: retention.value });
  } catch (e: any) {
    retention.value = before;
    toast({ kind: 'error', title: 'Could not save that', body: e.message });
  }
}

/** Whether a source keeps this, and whether that is its own say or inherited. */
export function keeps(r: P.RetentionSettings, what: keyof P.KeepSettings, network: P.Network, accountId?: string): { on: boolean; own: boolean } {
  const acc = accountId ? r.sources[accountId]?.[what] : undefined;
  if (acc !== undefined) return { on: acc, own: true };
  const net = r.sources[network]?.[what];
  if (net !== undefined) return { on: net, own: !accountId };
  return { on: r[what], own: false };
}

/** Set (or with null, clear) one source's say. */
export function setSource(key: string, what: keyof P.KeepSettings, on: boolean | null) {
  const sources = { ...retention.value.sources, [key]: { ...retention.value.sources[key] } };
  if (on === null) delete sources[key][what];
  else sources[key][what] = on;
  if (!Object.keys(sources[key]).length) delete sources[key];
  return saveRetention({ sources });
}

export async function eraseKept(what: 'deleted' | 'disappeared' | 'edits' | 'reactions' | 'receipts' | 'changes') {
  const r = await api<{ erased: number }>('/api/retention/erase', { body: { what } });
  toast({ kind: 'info', title: r.erased ? `Forgot ${r.erased}` : 'Nothing to forget', body: '' }, 2500);
}

export async function loadChanges(path: string): Promise<P.ChangeView[]> {
  const r = await api<{ changes: P.ChangeView[]; identities: P.IdentityView[] }>(path);
  for (const i of r.identities) if (!db.identities.has(i.id)) db.identities.set(i.id, i);
  if (r.identities.length) rev.value++;
  return r.changes;
}
