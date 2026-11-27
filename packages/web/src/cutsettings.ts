/** Settings → Sending → "When a picture is cut off", as the hub keeps it (`/api/sending/cut`, sendqueue.ts). */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { api, toast } from './state.ts';

/** Null until read. */
export const cutSettings = signal<P.CutSettings | null>(null);
let reading: Promise<void> | null = null;

/** Read it from the hub, once; `again` reads it afresh (a send the hub now holds: it may have changed elsewhere). */
export function loadCutSettings(again = false): Promise<void> {
  if (again) reading = null;
  reading ??= api<P.CutSettings>('/api/sending/cut').then(
    (c) => void (cutSettings.value = c),
    () => void (reading = null),
  );
  return reading;
}

export async function setCutSettings(patch: Partial<P.CutSettings>) {
  const before = cutSettings.value;
  if (!before) return;
  const next = { ...before, ...patch };
  cutSettings.value = next;
  try {
    cutSettings.value = await api<P.CutSettings>('/api/sending/cut', { method: 'PUT', body: next });
  } catch (e) {
    cutSettings.value = before;
    toast({ kind: 'error', title: 'Could not save', body: (e as Error).message });
  }
}
