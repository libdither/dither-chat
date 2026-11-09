/** What the New box offers for what was typed or pasted (docs/add.md). No browser needed, so it can be tested alone. */
import type * as P from '@dither-chat/protocol';
import { describeAddRef, directTarget, NETWORK_META, notBuiltLine, parseAdd } from '@dither-chat/protocol';

export type AddRowState =
  /** One of these accounts can say what it is: on a click, or at once for a link. */
  | { kind: 'resolve'; accounts: P.AccountView[] }
  /** None can look it up, but one can open a conversation with it, as New message always could. */
  | { kind: 'direct'; accounts: P.AccountView[]; peer: string }
  /** A plain line, no button: nothing here can do it yet. */
  | { kind: 'unbuilt'; line: string };

export interface AddRow {
  key: string;
  ref: P.AddRef;
  /** What it is, in a few words: "Discord invite discord.gg/abc", "Telegram @name". */
  label: string;
  state: AddRowState;
}

const online = (accounts: Iterable<P.AccountView>, network: P.Network) => [...accounts].filter((a) => a.network === network && a.status === 'online');

/** The address openDirect takes for a reading, when it is one. */
export function readingPeer(ref: P.AddRef): string | null {
  const raw = ref.kind === 'person' ? ref.handle : ref.kind === 'name' ? `@${ref.name}` : null;
  if (!raw) return null;
  const t = directTarget(ref.network, raw);
  return 'peer' in t ? t.peer : null;
}

/** A link resolves as soon as it is pasted or Enter is pressed; a bare word or @name only when its row is clicked. */
export function isLink(input: string): boolean {
  const s = input.trim();
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s) || /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\//.test(s) || /^[#!][^\s:]+:\S+$/.test(s);
}

/** One row per reading whose network has a connected account here, most specific first. */
export function addRows(input: string, accounts: Iterable<P.AccountView>): AddRow[] {
  const all = [...accounts];
  return parseAdd(input).flatMap((ref, i): AddRow[] => {
    const on = online(all, ref.network);
    if (!on.length) return [];
    const resolvers = on.filter((a) => a.capabilities.includes('resolve'));
    const peer = readingPeer(ref);
    const starters = on.filter((a) => a.capabilities.includes('openDirect'));
    const state: AddRowState = resolvers.length
      ? { kind: 'resolve', accounts: resolvers }
      : peer && starters.length
        ? { kind: 'direct', accounts: starters, peer }
        : { kind: 'unbuilt', line: notBuiltLine(ref) };
    return [{ key: `${i}:${ref.network}:${ref.kind}`, ref, label: describeAddRef(ref), state }];
  });
}

/** Networks a reading of the input belongs to that have no connected account here, for "No connected X account". */
export function offlineNetworks(input: string, accounts: Iterable<P.AccountView>): P.Network[] {
  const all = [...accounts];
  return [...new Set(parseAdd(input).map((r) => r.network))].filter((n) => !online(all, n).length);
}

export const ACTION_LABEL: Record<P.AddAction, string> = { join: 'Join', ask: 'Ask to join', friend: 'Add friend', follow: 'Follow', contact: 'Add contact', message: 'Message' };

/** "Discord server", "Telegram channel", "Matrix room", "Person on Telegram". */
export function previewKind(v: Pick<P.AddPreviewView, 'what'>, network: P.Network): string {
  const net = NETWORK_META[network];
  if (v.what === 'person') return `Person on ${net.name}`;
  if (v.what === 'space') return `${net.name} ${net.spaceNoun}`;
  return `${net.name} ${v.what}`;
}

/** "5,321 members · 802 online" */
export function previewCounts(v: Pick<P.AddPreviewView, 'members' | 'online'>): string | null {
  const parts = [v.members !== null ? `${v.members.toLocaleString('en-US')} member${v.members === 1 ? '' : 's'}` : null, v.online !== null ? `${v.online.toLocaleString('en-US')} online` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** When the invite runs out, from now. */
export function expiresIn(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms <= 0) return 'This invite has run out';
  const h = ms / 3_600_000;
  if (h < 1) return `Invite runs out in ${Math.max(1, Math.round(ms / 60_000))} minutes`;
  if (h < 48) return `Invite runs out in ${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`;
  return `Invite runs out in ${Math.round(h / 24)} days`;
}

/** What a partial preview could not say, by what acting on it would be. */
export function partialLine(actions: P.AddAction[]): string {
  if (actions.includes('friend') || actions.includes('follow') || actions.includes('contact')) return "Can't preview this without asking";
  return "Can't preview this without joining";
}

/** The address to open a conversation with someone a preview found. */
export function messagePeer(v: Pick<P.AddPreviewView, 'nativeId' | 'ref'>): string | null {
  if (v.nativeId) {
    const t = directTarget(v.ref.network, v.nativeId);
    if ('peer' in t) return t.peer;
  }
  return readingPeer(v.ref);
}

/** The check the network wants, said plainly. */
export const CHECK_LINE: Record<P.AddCheck, string> = {
  captcha: 'a captcha',
  verify: 'that it is you',
  phone: 'a verified phone number',
  rules: "agreeing to the server's rules",
};
