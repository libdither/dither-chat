import { hostname as machineName } from 'node:os';

/**
 * The names this hub answers to (docs/deploy.md). A page can point its own domain at the hub's address (DNS
 * rebinding); the browser then calls it same-origin with that page, so Origin matching Host proves nothing. The Host
 * header still names the attacker's domain, and only names on this list get an answer.
 *
 * Always allowed: IP literals (a page on an IP origin is the hub's own origin), `localhost` and `*.localhost` (the
 * browser resolves those itself), this machine's name, `<machine>.<tailnet>.ts.net` (MagicDNS), the host of
 * DITHER_PUBLIC_URL, and each name in DITHER_ALLOWED_HOSTS (comma-separated).
 */
export function hostNames(env: Record<string, string | undefined> = process.env, machine = machineName()): Set<string> {
  const names = new Set<string>();
  const add = (h: string | undefined) => {
    const n = h?.trim().toLowerCase().replace(/\.$/, '');
    if (n) names.add(n);
  };
  const m = machine.toLowerCase();
  add(m);
  add(m.split('.')[0]);
  for (const u of [env.DITHER_PUBLIC_URL]) {
    try {
      if (u) add(new URL(u).hostname);
    } catch {}
  }
  for (const h of (env.DITHER_ALLOWED_HOSTS ?? '').split(',')) add(h);
  return names;
}

/** Whether a request's Host header names this hub. No header (HTTP/1.0, some tools) is not a browser: allowed. */
export function hostAllowed(host: string | null, names: Set<string>): boolean {
  if (!host) return true;
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return true; // an IPv6 literal
  const name = h.replace(/:\d+$/, '').replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (names.has(name)) return true;
  // MagicDNS: this machine's name in any tailnet. Only Tailscale answers for ts.net, so no page can rebind one.
  const first = name.split('.')[0];
  return name.endsWith('.ts.net') && name.split('.').length === 4 && names.has(first);
}
