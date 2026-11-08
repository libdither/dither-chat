/**
 * Fetching a file for a viewer: only the first part of a big one (TEXT_CAP), so a 20 MB log doesn't stall the page.
 * The hub serves /media with nosniff and a sandbox CSP; fetch() reads the bytes as data, and the viewers only ever
 * put them into the page as text, never as markup.
 */
import { useEffect, useState } from 'preact/hooks';

export const TEXT_CAP = 2 * 1024 * 1024;

/**
 * Bytes for people, as format.ts says them. The viewers import nothing from the app's own modules but Preact, so the
 * bundler keeps the app's startup code in as few chunks as before.
 */
export function size(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export interface Fetched {
  bytes: Uint8Array;
  /** Stopped at the cap: there is more. */
  truncated: boolean;
}

export async function fetchHead(url: string, cap = TEXT_CAP, signal?: AbortSignal): Promise<Fetched> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(r.status === 404 ? 'The hub no longer has this file.' : `The hub answered ${r.status}.`);
  const reader = r.body!.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    if (n >= cap) {
      truncated = n > cap || !(await reader.read().then((x) => x.done));
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(Math.min(n, cap));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    out.set(p.subarray(0, out.length - at), at);
    at += p.length;
  }
  return { bytes: out, truncated };
}

/** Text from bytes: the encoding the hub found, else by byte-order mark, else UTF-8 if it is, else Windows-1252. */
export function decode(b: Uint8Array, encoding?: string): string {
  let enc = encoding;
  if (!enc) {
    if (b[0] === 0xff && b[1] === 0xfe) enc = 'utf-16le';
    else if (b[0] === 0xfe && b[1] === 0xff) enc = 'utf-16be';
    else {
      try {
        // A character cut by the cap at the very end is not a reason to call it something else.
        new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, Math.max(0, b.length - 3)));
        enc = 'utf-8';
      } catch {
        enc = 'windows-1252';
      }
    }
  }
  let d: TextDecoder;
  try {
    d = new TextDecoder(enc);
  } catch {
    d = new TextDecoder('utf-8');
  }
  return d.decode(b).replace(/^\ufeff/, '');
}

export type Load<T> = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; value: T; truncated: boolean };

/** The first part of `url` as text, decoded. */
export function useText(url: string, encoding?: string, cap = TEXT_CAP): Load<string> {
  const [s, set] = useState<Load<string>>({ state: 'loading' });
  useEffect(() => {
    const ac = new AbortController();
    set({ state: 'loading' });
    fetchHead(url, cap, ac.signal)
      .then((f) => set({ state: 'ok', value: decode(f.bytes, encoding), truncated: f.truncated }))
      .catch((e) => !ac.signal.aborted && set({ state: 'error', error: e?.message ?? String(e) }));
    return () => ac.abort();
  }, [url, encoding, cap]);
  return s;
}

/** "Showing the first 2 MB of 14 MB." */
export function Partial({ shown, total, what = 'file' }: { shown: number; total?: number | null; what?: string }) {
  return (
    <div class="fv-note" role="note">
      Showing the first {size(shown)}
      {total ? ` of ${size(total)}` : ''}. Download the {what} for the rest.
    </div>
  );
}

export function Failed({ error }: { error: string }) {
  return <div class="fv-wait">{error}</div>;
}

export function Waiting() {
  return <div class="fv-wait">Loading…</div>;
}
