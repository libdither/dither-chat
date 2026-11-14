/**
 * The channel last opened in each server, on this device, so opening a server goes back to it (docs/servers.md
 * "Opening a server"). Pure: App.tsx feeds it routes and says what is under a space.
 */
import type { Route } from './routes.ts';

/** Server id (its top community) → the conversation last opened in it. */
export type LastChannels = Record<string, string>;

const KEY = 'dither-chat:last-channel';
/** Enough for every server one has, with room; the oldest go first past it. */
const KEEP = 500;

export function readLastChannels(): LastChannels {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function saveLastChannels(m: LastChannels) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    // Private windows and full storage: the next open just shows the server's list.
  }
}

/** `m` with `conv` as the server's latest, moved to the end; null when that is already so. */
export function noteChannel(m: LastChannels, server: string, conv: string): LastChannels | null {
  const keys = Object.keys(m);
  if (m[server] === conv && keys[keys.length - 1] === server) return null;
  const out: LastChannels = {};
  for (const k of keys.slice(-(KEEP - 1))) if (k !== server) out[k] = m[k];
  out[server] = conv;
  return out;
}

/**
 * A server opened with no channel gets the one last opened there, if it is still under it; else its first channel to
 * read (`first`), as Discord does; with neither, the route as it was.
 */
export function withLastChannel(r: Route, m: LastChannels, serverOf: (space: string) => string, isUnder: (space: string, conv: string) => boolean, first: (space: string) => string | undefined = () => undefined): Route {
  if (r.view !== 'space' || r.conv) return r;
  const last = m[serverOf(r.space)];
  const conv = last && isUnder(r.space, last) ? last : first(r.space);
  return conv ? { ...r, conv } : r;
}
