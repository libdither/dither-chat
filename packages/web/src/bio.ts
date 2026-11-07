/** Your own bio: which account can change it, and how much its network still takes. No browser needed. */
import type * as P from '@dither-chat/protocol';
import { BIO_LIMIT, bioLength } from '@dither-chat/protocol';

/** The account whose own identity this is, if its adapter can change the bio (capability 'editProfile'). */
export function bioEditor(accounts: Iterable<P.AccountView>, identityId: string): P.AccountView | null {
  for (const a of accounts) if (a.selfIdentityId === identityId && a.capabilities.includes('editProfile')) return a;
  return null;
}

/** Characters left under the network's limit (negative past it), or null where the network sets none. */
export function bioLeft(network: P.Network, draft: string): { limit: number; left: number } | null {
  const limit = BIO_LIMIT[network];
  return limit === undefined ? null : { limit, left: limit - bioLength(draft) };
}
