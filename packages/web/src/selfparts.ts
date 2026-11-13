/**
 * What the profile and account pages offer of an account's own self (docs/account-self.md), as plain functions:
 * which of someone's accounts can be ignored from here, and when a status set to clear after a while clears.
 * ui/ProfileSelf.tsx and ui/AccountSelf.tsx draw them.
 */
import type * as P from '@dither-chat/protocol';

export interface SelfOffer {
  identity: P.IdentityView;
  /** Ignore or Stop Ignoring: which. */
  ignored: boolean;
}

/** Their accounts Ignore (or Stop Ignoring) is offered for: where a connected account of yours on that network can, and you have not blocked them. */
export function selfOffers(ids: P.IdentityView[], ignored: P.ProfileView['ignored'], links: P.PersonLinkView[], accounts: Iterable<P.AccountView>): SelfOffer[] {
  const list = [...accounts];
  const able = (network: P.Network, cap: P.Capability) => list.some((a) => a.network === network && a.status === 'online' && a.capabilities.includes(cap));
  return ids
    .map((i) => {
      const blocked = links.some((l) => l.identityId === i.id && l.relationship === 'blocked');
      return !blocked && able(i.network, 'ignore') ? { identity: i, ignored: (ignored ?? []).some((x) => x.identityId === i.id) } : null;
    })
    .filter((o): o is SelfOffer => !!o);
}

const HOUR = 3_600_000;
/** Clear after, as Discord's own status dialog offers it. -1: at the end of today. */
export const CLEAR_AFTER: [string, number | null][] = [
  ["Don't clear", null],
  ['30 minutes', HOUR / 2],
  ['1 hour', HOUR],
  ['4 hours', 4 * HOUR],
  ['Today', -1],
];

/** When a status set now clears, for a CLEAR_AFTER choice; undefined: it does not. */
export function clearsAt(choice: number, now: number): number | undefined {
  const after = CLEAR_AFTER[choice]?.[1] ?? null;
  if (after === null) return undefined;
  if (after > 0) return now + after;
  const d = new Date(now);
  d.setHours(23, 59, 59, 0);
  return d.getTime();
}
