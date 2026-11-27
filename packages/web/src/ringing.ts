/**
 * Calls ringing you and voice channels, as the hub has them (docs/calls.md "Ringing"): the `calls` and `voice` client
 * events, and GET /api/calls/ringing and /api/voice after each bootstrap. The ring card (ui/Ringing.tsx) shows each call that
 * rings you, with Answer and Decline.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { api } from './api.ts';

/** Calls the hub told this page about, by id. */
const calls = signal<Map<string, P.CallView>>(new Map());
/** Voice channels with people or a status line, by conversation id. */
export const voice = signal<Map<string, P.VoiceChannelView>>(new Map());

/** The ring the page itself plays (ringtone.ts), loaded with the first call that rings you aloud: off the first screen. */
let ringtone: Promise<unknown> | null = null;

export function applyCalls(list: P.CallView[]) {
  if (!ringtone && list.some((c) => c.ringing && c.alerts)) ringtone = import('./ringtone.ts').then((m) => m.startRingtone());
  const next = new Map(calls.value);
  for (const c of list) next.set(c.id, c);
  // Keep the page's map small: what rings or goes on, and the last few that ended.
  const ended = [...next.values()].filter((c) => c.state === 'ended').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  for (const c of ended.slice(20)) next.delete(c.id);
  calls.value = next;
}

export function applyVoice(list: P.VoiceChannelView[]) {
  const next = new Map(voice.value);
  for (const v of list) {
    if (!v.members.length && !v.status) next.delete(v.conversationId);
    else next.set(v.conversationId, v);
  }
  voice.value = next;
}

/** After a bootstrap: what rings now, and who is in voice. A hub from before calls answers 404: nothing. */
export async function loadCalls() {
  const [c, v] = await Promise.all([api<{ calls: P.CallView[] }>('/api/calls/ringing').catch(() => null), api<{ channels: P.VoiceChannelView[] }>('/api/voice').catch(() => null)]);
  if (c) {
    calls.value = new Map();
    applyCalls(c.calls);
  }
  if (v) {
    voice.value = new Map();
    applyVoice(v.channels);
  }
}

/** Calls ringing you now, newest first. */
export function ringingCalls(): P.CallView[] {
  return [...calls.value.values()].filter((c) => c.ringing).sort((a, b) => b.startedAt - a.startedAt);
}

/** Every call the page knows of that has not ended (voicenow.ts: who is in a call now). */
export function liveCalls(): P.CallView[] {
  return [...calls.value.values()].filter((c) => c.state !== 'ended');
}

/** The call going on or ringing in a conversation, if any. */
export function callIn(conversationId: string): P.CallView | null {
  return [...calls.value.values()].find((c) => c.conversationId === conversationId && c.state !== 'ended') ?? null;
}

/**
 * The call an Answer from outside the page (Android's ring notification, android.ts) joins: that call, while it has
 * not ended; a stale Answer gets null. Joining an ended one-to-one call would place a new call to the other side
 * (Signal and the like have no call to join, so joining one rings them), so an Answer replayed later, as when Android
 * brings the app back from the intent that once answered, must join nothing. Without a call id, the conversation's call
 * going on or ringing.
 */
export function answerable(list: P.CallView[], callId: string | undefined): P.CallView | null {
  const c = callId ? list.find((x) => x.id === callId) : list.find((x) => x.state !== 'ended');
  return c && c.state !== 'ended' ? c : null;
}

/** Whether a page rings aloud (ringtone.ts): a call that rings you and may sound, the page in sight, this device in no call. */
export function ringsAloud(calls: Pick<P.CallView, 'ringing' | 'alerts'>[], visible: boolean, inCall: boolean): boolean {
  return visible && !inCall && calls.some((c) => c.ringing && c.alerts);
}
