/**
 * Muting a place on its network itself (docs/notifications.md "Muted on the network"): whether any account can, and
 * how the mute there reads. Separate from dither's own Mute, which only decides what dither notifies. Pure, so it can
 * be tested alone; ui/NetworkMute.tsx draws it on a place's About page.
 */
import type * as P from '@dither-chat/protocol';
import { mutedNow, NETWORK_META } from '@dither-chat/protocol';
import { clock, fullTime } from './format.ts';

/** Some account that sees the place can mute it on its network (capability 'mute'). */
export function canMuteOnNetwork(accounts: readonly (Pick<P.AccountView, 'capabilities'> | undefined)[]): boolean {
  return accounts.some((a) => !!a?.capabilities?.includes('mute'));
}

/** How it stands on the network, in words: "Muted on Discord until 5:30 PM", "Not muted on Discord". */
export function networkMuteLine(network: P.Network, m: P.NativeMute | null | undefined, now = Date.now()): string {
  const net = NETWORK_META[network].name;
  if (!mutedNow(m, now)) return m?.level === 'mentions' ? `${net} notifies only mentions here` : `Not muted on ${net}`;
  if (m?.until === undefined) return m?.muted ? `Muted on ${net}` : `${net} notifies nothing here`;
  const sameDay = new Date(m.until).toDateString() === new Date(now).toDateString();
  return `Muted on ${net} until ${sameDay ? clock(m.until) : fullTime(m.until)}`;
}

/** Whether Unmute applies: a mute (Discord's Mute) in force, not a level of nothing set in its own menus. */
export function canUnmute(m: P.NativeMute | null | undefined, now = Date.now()): boolean {
  return !!m && mutedNow(m, now) && (m.muted === true || m.until !== undefined);
}
