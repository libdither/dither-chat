import { createHmac } from 'node:crypto';

/**
 * Signs a stored media URL into the hub's /media path (server.ts checks it). Its own module so search's thread
 * (search-worker.ts) signs as the hub's does without loading the server.
 */
export function mediaSigner(secret: string) {
  // The same link signs the same way every time: a bootstrap signs every picture it names (15k on the live hub), so
  // they are remembered rather than worked out again.
  const signed = new Map<string, string>();
  return (raw: string | null | undefined, accountId: string | null | undefined): string | null => {
    if (!raw) return null;
    if (raw.startsWith('data:')) return raw;
    const key = `${raw}|${accountId ?? ''}`;
    const hit = signed.get(key);
    if (hit) return hit;
    const sig = createHmac('sha256', secret).update(key).digest('base64url').slice(0, 16);
    const out = `/media/${sig}/${Buffer.from(raw).toString('base64url')}${accountId ? `?a=${accountId}` : ''}`;
    if (signed.size >= 100_000) signed.clear();
    signed.set(key, out);
    return out;
  };
}
