/**
 * A status dot on an avatar (presence.ts, docs/profile.md "Status dots"). It reads `presenceRev` itself, so a presence
 * frame draws only the dots again, never the row or list around them.
 */
import type * as P from '@dither-chat/protocol';
import { db, isSelfIdentity } from '../state.ts';
import { authorName, peerIdentity } from '../model.ts';
import { groupDot, identityDot, personDot, type Dot } from '../presence.ts';
import { presenceRev } from '../versions.ts';
import { memoOn } from './memo.ts';

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

/** Who `of` names, as one string: the same dot, whatever object a parent made for it. */
export const whose = (of: PresenceOf | undefined) =>
  !of ? '' : 'identity' in of ? `i:${of.identity ?? ''}` : 'person' in of ? `p:${of.person ?? ''}` : `m:${of.members.join(',')}`;

/** What a dot shows, as one string ('' for none). Reads `presenceRev`, so what draws with it follows presence frames. */
export function dotLooks(of: PresenceOf): string {
  presenceRev.value;
  const dot = dotFor(of);
  return dot ? `${dot.state} ${dot.title}` : '';
}

type DotProps = { of: PresenceOf; size: number; corner?: 'top' };

/**
 * Drawn again only when what it shows changes (memoOn): rows and avatars make a new `of` each time they draw, and a
 * row drawn again (its unread count, a rule) must not draw its dot again (docs/perf.md "Every click"); a presence frame
 * draws the dots it changed, and a merge or a renamed member the dots it changed.
 */
export const PresenceDot = memoOn(
  function PresenceDot({ of, size, corner }: DotProps) {
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
  },
  (p) => `${p.size} ${p.corner ?? ''} ${dotLooks(p.of)}`,
);
