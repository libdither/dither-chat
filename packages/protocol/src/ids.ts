import type { Network } from './ontology.ts';

/** Hub-id prefixes. Network objects get deterministic ids so ingest is idempotent. */
export type IdPrefix = 'idn' | 'spc' | 'cnv' | 'msg' | 'att' | 'per' | 'acc' | 'fld' | 'rul';

const enc = new TextEncoder();

/** 16-char base64url of sha256(network NUL nativeId). Deterministic, so adapters' references resolve without lookups. */
export function hubId(prefix: IdPrefix, network: Network, nativeId: string): string {
  const h = new Bun.CryptoHasher('sha256').update(enc.encode(`${network}\0${nativeId}`)).digest();
  return `${prefix}_${Buffer.from(h.subarray(0, 12)).toString('base64url')}`;
}

export function randomId(prefix: IdPrefix): string {
  return `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')}`;
}
