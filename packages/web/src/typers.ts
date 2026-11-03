/**
 * Who is typing where, from the hub's live typing events (docs/typing.md). Pure, so tests can run it. Nothing here
 * goes into the snapshot: a typer is of the moment, and a reload starts with nobody typing.
 */
import type * as P from '@dither-chat/protocol';
import { TYPING_TTL } from '@dither-chat/protocol';

export interface Typer {
  identityId: string;
  until: number;
  /** From the network, when the hub knows no name for them. */
  name?: string;
}
export type TypingState = Record<string, Typer[]>;

/** One typing event onto the state: a start (re)sets the typer's deadline, a stop removes them. Expired ones go. */
export function applyTyping(state: TypingState, ev: Extract<P.ClientEvent, { t: 'typing' }>, now: number, isSelf: (id: string) => boolean = () => false): TypingState {
  const cur = (state[ev.conversationId] ?? []).filter((x) => x.identityId !== ev.identityId && x.until > now);
  if (!ev.stop && !isSelf(ev.identityId)) cur.push({ identityId: ev.identityId, until: now + (ev.ttl ?? TYPING_TTL), ...(ev.name ? { name: ev.name } : {}) });
  const next = { ...state };
  if (cur.length) next[ev.conversationId] = cur;
  else delete next[ev.conversationId];
  return next;
}

/** Everyone typing in these conversations now, once each, in the order they started. */
export function typersIn(state: TypingState, convIds: string[], now: number): Typer[] {
  const seen = new Set<string>();
  const out: Typer[] = [];
  for (const c of convIds) {
    for (const t of state[c] ?? []) {
      if (t.until <= now || seen.has(t.identityId)) continue;
      seen.add(t.identityId);
      out.push(t);
    }
  }
  return out;
}

/** When the next typer here runs out, so a view can redraw then; null when nobody is typing. */
export function nextExpiry(state: TypingState, now: number): number | null {
  let next: number | null = null;
  for (const list of Object.values(state)) for (const t of list) if (t.until > now && (next === null || t.until < next)) next = t.until;
  return next;
}
