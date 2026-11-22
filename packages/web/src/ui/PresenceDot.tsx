/**
 * A status dot on an avatar (presence.ts, docs/profile.md "Status dots"). It reads `presenceRev` itself, so a presence
 * frame draws only the dots again, never the row or list around them.
 */
import type * as P from '@dither-chat/protocol';
import { db, isSelfIdentity } from '../state.ts';
import { authorName, peerIdentity } from '../model.ts';
import { groupDot, identityDot, personDot, type Dot } from '../presence.ts';
import { presenceRev } from '../versions.ts';

/** Whose dot: one identity (merged with the rest of its person), a person, or a group's members (yours left out). */
export type PresenceOf = { identity: string | null | undefined } | { person: string | null | undefined } | { members: readonly string[] };

/** A conversation's dot: the person in a DM, who is around in a group; none for channels and notes to self. */
export function convPresence(c: Pick<P.ConversationView, 'shape' | 'peerPersonId' | 'participantIds'>): PresenceOf | undefined {
  if (c.shape === 'direct') return c.peerPersonId ? { person: c.peerPersonId } : { identity: peerIdentity(c as P.ConversationView) };
  if (c.shape === 'group') return { members: c.participantIds.filter((p) => !isSelfIdentity(p)) };
  return undefined;
}

export function dotFor(of: PresenceOf): Dot | null {
  if ('identity' in of) return identityDot(db, of.identity);
  if ('person' in of) return personDot(db, of.person);
  return groupDot(db, of.members, authorName);
}

export function PresenceDot({ of, size, corner }: { of: PresenceOf; size: number; corner?: 'top' }) {
  presenceRev.value;
  const dot = dotFor(of);
  if (!dot) return null;
  const d = Math.min(20, Math.max(8, Math.round(size * 0.28)));
  return (
    <span
      class={`presence-dot avatar-presence ${dot.state}${corner ? ` at-${corner}` : ''}`}
      style={{ width: `${d}px`, height: `${d}px` }}
      title={dot.title}
      role="img"
      aria-label={dot.title}
      data-presence={dot.state}
    />
  );
}
