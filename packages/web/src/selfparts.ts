/**
 * What the profile and account pages offer of an account's own self (docs/account-self.md), as plain functions:
 * which of someone's accounts can be blocked or ignored from here, a network note added to yours without losing
 * either, and when a status set to clear after a while clears. ui/ProfileSelf.tsx and ui/AccountSelf.tsx draw them.
 */
import type * as P from '@dither-chat/protocol';

export interface SelfOffer {
  identity: P.IdentityView;
  /** Ignore or Stop Ignoring is offered; `ignored` says which. */
  ignore: boolean;
  ignored: boolean;
  block: boolean;
}

/** For each of their accounts: Ignore (or Stop) and Block, where a connected account of yours on that network can. A block hides both. */
export function selfOffers(ids: P.IdentityView[], ignored: P.ProfileView['ignored'], links: P.PersonLinkView[], accounts: Iterable<P.AccountView>): SelfOffer[] {
  const list = [...accounts];
  const able = (network: P.Network, cap: P.Capability) => list.some((a) => a.network === network && a.status === 'online' && a.capabilities.includes(cap));
  return ids
    .map((i) => {
      const blocked = links.some((l) => l.identityId === i.id && l.relationship === 'blocked');
      return { identity: i, ignore: !blocked && able(i.network, 'ignore'), ignored: (ignored ?? []).some((x) => x.identityId === i.id), block: !blocked && able(i.network, 'block') };
    })
    .filter((o) => o.ignore || o.block);
}

/** Your note with a network's note added below it, unless it holds that text already: neither text is lost. */
export function withNetworkNote(note: string | null, network: string, text: string): string {
  const cur = note ?? '';
  if (!text.trim() || cur.includes(text)) return cur;
  return `${cur.trimEnd()}${cur.trim() ? '\n\n' : ''}${network} note: ${text}`;
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
