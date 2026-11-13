/**
 * A server's page beyond its settings (ServerParts.tsx, docs/servers.md) is a chunk of its own, loaded the first time a
 * place page wants it (as the calendar's chip is, calendar/lazy.tsx).
 */
import { useEffect, useState } from 'preact/hooks';

type Parts = typeof import('./ServerParts.tsx');
let parts: Parts | null = null;
let loading: Promise<Parts> | null = null;

function load(): Promise<Parts> {
  return (loading ??= import('./ServerParts.tsx').then(
    (m) => (parts = m),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

/** The parts once loaded; asked for only while `want`. */
export function useServerParts(want: boolean): Parts | null {
  const [m, setM] = useState(parts);
  useEffect(() => {
    if (want && !m) load().then(setM, () => {});
  }, [want]);
  return m;
}
