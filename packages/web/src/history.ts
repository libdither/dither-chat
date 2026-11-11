/**
 * What the hub keeps of what changes and what the networks take back (docs/history.md): the settings, shared by
 * every device, and reading a place's or person's change log.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION } from '@dither-chat/protocol';
import { api, changed, db, eventHooks, toast } from './state.ts';

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

/**
 * Change some settings; shown at once, put back if the hub refuses. Only `patch` goes to the hub, so a device that
 * has not loaded the settings yet never sends its defaults back. Turning off a switch that keeps or shows kept things
 * takes `confirm` (the hub refuses it otherwise): ask first (confirmOff).
 */
export async function saveRetention(patch: Partial<P.RetentionSettings> | { showIn: Record<string, 'shown' | 'hidden' | null> }, o: { confirm?: boolean } = {}) {
  await loadRetention();
  const before = retention.value;
  const showIn = 'showIn' in patch && patch.showIn ? Object.fromEntries(Object.entries({ ...before.showIn, ...patch.showIn }).filter(([, v]) => v)) : before.showIn;
  retention.value = { ...before, ...(patch as Partial<P.RetentionSettings>), showIn: showIn as P.RetentionSettings['showIn'] };
  try {
    retention.value = await api<P.RetentionSettings>('/api/retention', { method: 'PUT', body: { ...patch, ...(o.confirm ? { confirm: true } : {}) } });
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
  const was = retention.value.sources[key]?.[what];
  if (was === true && on !== true && (what === 'deleted' || what === 'disappearing') && !confirmOff(what)) return Promise.resolve();
  return saveRetention({ sources }, { confirm: true });
}

const STOPS: Partial<Record<keyof P.RetentionSettings, string>> = {
  deleted: 'Stop keeping deleted messages? Messages deleted from now on are emptied, as the network asks.',
  disappearing: 'Stop keeping disappearing messages? Messages whose timer runs out from now on are emptied.',
  statuses: 'Stop logging statuses?',
  presence: 'Stop logging presence?',
  members: 'Stop recording server members?',
  adversarial: 'Hide adversarial features? What their switches keep goes on being kept, out of sight. Turn a switch off to stop it.',
};

/** Asks before turning off a switch that keeps or shows kept things. What was kept stays either way. */
export function confirmOff(what: keyof P.RetentionSettings): boolean {
  const q = STOPS[what];
  return !q || confirm(`${q}\n\nWhat was kept already stays, until you forget it under Message history.`);
}

/** One chat's say on showing kept deleted and disappeared messages; null goes back to the default. */
export function setShowIn(conversationId: string, v: 'shown' | 'hidden' | null) {
  return saveRetention({ showIn: { [conversationId]: v } });
}

export async function eraseKept(what: P.KeptKind) {
  const r = await api<{ erased: number }>('/api/retention/erase', { body: { what } });
  toast({ kind: 'info', title: r.erased ? `Forgot ${r.erased}` : 'Nothing to forget', body: '' }, 2500);
  void loadKept();
}

/** Which kinds have anything kept (GET /api/retention/kept); null until the hub has said. */
export const kept = signal<Record<P.KeptKind, boolean> | null>(null);
export function loadKept(): Promise<void> {
  return api<Record<P.KeptKind, boolean>>('/api/retention/kept').then(
    (k) => void (kept.value = k),
    () => {},
  );
}

export { ADVERSARIAL_KINDS, keeping } from './keeping.ts';

const PRESENCE_LABEL: Record<P.PresenceView['state'], string> = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline' };

/** A logged presence in words: "Online on desktop and mobile". */
export function presenceText(p: P.PresenceView | null | undefined): string {
  if (!p) return 'Nothing';
  const on = p.devices?.length ? ` on ${p.devices.join(' and ')}` : '';
  return `${PRESENCE_LABEL[p.state] ?? p.state}${on}`;
}

export async function loadChanges(path: string): Promise<P.ChangeView[]> {
  const r = await api<{ changes: P.ChangeView[]; identities: P.IdentityView[] }>(path);
  for (const i of r.identities) if (!db.identities.has(i.id)) db.identities.set(i.id, i);
  if (r.identities.length) changed('meta');
  return r.changes;
}
