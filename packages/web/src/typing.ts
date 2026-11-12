/**
 * Typing, in the app (docs/typing.md): your own typing told to the hub, throttled like Discord's client, and a clock
 * that redraws the indicators when a typer runs out.
 */
import { effect, signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { TypingSender, type TypingTarget } from '@dither-chat/protocol';
import { api, toast, typing } from './state.ts';
import { nextExpiry } from './typers.ts';

/** Settings → Privacy, as the hub keeps it. Null until read; the hub refuses a start when sharing is off either way. */
export const privacy = signal<P.PrivacySettings | null>(null);
let reading: Promise<void> | null = null;

export function loadPrivacy(): Promise<void> {
  reading ??= api<P.PrivacySettings>('/api/privacy').then(
    (p) => void (privacy.value = p),
    () => void (reading = null),
  );
  return reading;
}

export async function setShareTyping(on: boolean) {
  const before = privacy.value;
  privacy.value = { ...(before ?? { shareTyping: true }), shareTyping: on };
  if (!on) sender.stop();
  try {
    privacy.value = await api<P.PrivacySettings>('/api/privacy', { method: 'PUT', body: { shareTyping: on } });
  } catch (e) {
    privacy.value = before;
    toast({ kind: 'error', title: 'Could not save', body: (e as Error).message });
  }
}

const sender = new TypingSender(
  (t, stop) => void api(`/api/conversations/${t.conversationId}/typing`, { body: { ...(t.accountId ? { accountId: t.accountId } : {}), ...(stop ? { stop: true } : {}) } }).catch(() => {}),
  { enabled: () => privacy.value?.shareTyping !== false },
);

/** Told of each edit to a message box by hand (the activity log counts them: activity.ts). */
export const typedHooks = new Set<(conversationId: string) => void>();

/** The composer's text changed by hand: maybe a start. */
export function composerTyped(target: TypingTarget, text: string) {
  if (!privacy.value) void loadPrivacy();
  sender.input(target, text);
  for (const h of typedHooks) h(target.conversationId);
}

/** Sent, cleared, left or hidden: a stop if a start went out. */
export const composerDone = () => sender.stop();

if (typeof window !== 'undefined') {
  addEventListener('pagehide', composerDone);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && composerDone());
}

/** Moves when a typer runs out, so views of `typing` redraw without an event from the hub. */
export const typingNow = signal(Date.now());
let expiry: ReturnType<typeof setTimeout> | undefined;
effect(() => {
  void typingNow.value; // after each expiry, wait for the next one
  const next = nextExpiry(typing.value, Date.now());
  clearTimeout(expiry);
  if (next !== null) expiry = setTimeout(() => (typingNow.value = Date.now()), Math.max(0, next - Date.now()) + 30);
});
