/**
 * Muting a place on its network itself (capability 'mute', protocol attention.ts), from its About page. Separate from
 * dither's own Mute, a rule that only decides what the hub notifies: this one stops the network's own apps (Discord
 * on a phone) as well. The network's answer comes back as the place's fact with its new mute, as a change made in its
 * own app does, so the hub keeps no state of its own here.
 *
 * Every connected account that sees the place and can mute there is asked, one after another: muting on Discord means
 * none of your Discord accounts buzz for it.
 */
import type * as P from '@dither-chat/protocol';
import { MUTE_TIMERS } from '@dither-chat/protocol';
import { AboutError } from './about.ts';
import type { Store } from './store.ts';

interface Link {
  online(accountId: string): boolean;
  command<T = unknown>(accountId: string, cmd: { t: 'mute'; target: P.AboutTarget; muted: boolean; until?: number }, timeoutMs?: number): Promise<T>;
}

export interface NativeMuteResult {
  /** Accounts whose network took it, and its mute as it now stands there. */
  done: { accountId: string; mute: P.NativeMute }[];
  /** Accounts that could not, with the network's sentence. */
  failed: { accountId: string; error: string }[];
}

/** The accounts that see this place, are connected, and can mute on their network. */
export function muteAccounts(store: Store, link: Pick<Link, 'online'>, kind: 'space' | 'conversation', id: string): string[] {
  return store.vantageAccounts(kind, id).filter((a) => {
    const acc = store.account(a);
    if (!acc || !link.online(a)) return false;
    try {
      return (JSON.parse(acc.capabilities ?? '[]') as string[]).includes('mute');
    } catch {
      return false;
    }
  });
}

/**
 * Mute (for `minutes`, or until turned off when null) or unmute a place on its network. Throws AboutError: 404 for no
 * such place, 409 when no connected account can, 400 for a timer the network does not offer, 502 when every account's
 * network refused (its sentence).
 */
export async function setNativeMute(store: Store, link: Link, kind: 'space' | 'conversation', id: string, b: { muted?: unknown; minutes?: unknown }, now = Date.now()): Promise<NativeMuteResult> {
  const native = store.nativeOf(kind, id);
  if (!native) throw new AboutError(`No such ${kind}`, 404);
  if (typeof b.muted !== 'boolean') throw new AboutError('Mute or unmute?', 400);
  const minutes = b.minutes === undefined ? null : b.minutes;
  if (b.muted && !MUTE_TIMERS.includes(minutes as number | null)) throw new AboutError('That is not one of the timers', 400);
  const accounts = muteAccounts(store, link, kind, id);
  if (!accounts.length) throw new AboutError('No connected account can mute this on its network', 409);
  const until = b.muted && typeof minutes === 'number' ? now + minutes * 60_000 : undefined;
  const done: NativeMuteResult['done'] = [];
  const failed: NativeMuteResult['failed'] = [];
  for (const accountId of accounts) {
    try {
      const mute = await link.command<P.NativeMute>(accountId, { t: 'mute', target: { kind, nativeId: native.nativeId }, muted: b.muted, ...(until !== undefined ? { until } : {}) }, 30_000);
      done.push({ accountId, mute: mute && typeof mute === 'object' ? mute : {} });
    } catch (e) {
      failed.push({ accountId, error: (e as Error).message });
    }
  }
  if (!done.length) throw new AboutError(failed[0]?.error ?? 'The network refused', 502);
  return { done, failed };
}
