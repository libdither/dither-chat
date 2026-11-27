/**
 * What the inbox needs of a person's chat routes (ui/Pairs.tsx) from the start: the route picked on their page, and the
 * conversation open before it. Pairs.tsx, the rest, is in the conversation's chunk (docs/perf.md "Left out of the first
 * load"), loaded after the app starts; what is here watches the route from the start.
 */
import type * as P from '@dither-chat/protocol';
import { effect, signal } from '@preact/signals';
import { pickHolds } from './chatroutes.ts';
import { route } from './state.ts';

/**
 * The route picked on this page, per person, this session, the address it was picked at and when: a pick holds while
 * the page stays at that address, and the address wins once it changes (opening another of their DMs sends through
 * it). It gives way to a message on another route after it (`live`): a tab left open for hours does not keep sending
 * through the route picked at its start.
 */
export const picked = signal<Record<string, { to: string; at: string; ts: number }>>({});

/** Whether a draft waits in a conversation's message box (Timeline keeps it in localStorage). */
function draftIn(conversationId: string): boolean {
  try {
    return !!localStorage.getItem(`dither-chat:draft:${conversationId}`);
  } catch {
    return false;
  }
}

/** A pick of `to` at `ts` still holds among these routes: no message on another since, or a draft waits in its box. */
export const live = (to: string, ts: number, directs: P.ConversationView[]) => directs.some((d) => d.id === to) && (pickHolds(to, ts, directs) || draftIn(to));

/** The route picked this session, if it is still one of theirs and still holds: where the inbox's row for them opens. */
export function pickedRoute(personId: string, directs: P.ConversationView[]): string | null {
  const p = picked.value[personId];
  return p && live(p.to, p.ts, directs) ? p.to : null;
}

/** The last conversation open before this page: where you came from, to guess which of your accounts to send as. */
export const cameFrom = signal<string | null>(null);
if (typeof window !== 'undefined')
  effect(() => {
    const r = route.value as { view: string; conv?: string };
    if (r.view !== 'people' && r.conv) cameFrom.value = r.conv;
  });
