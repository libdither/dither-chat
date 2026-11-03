/** Who a new direct conversation can be addressed to on each network. Shared so the composer and the hub agree. */
import type { Network } from './ontology.ts';

const MXID = /^@[^\s:]+:[^\s:]+(:\d+)?$/;
const ACI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE = /^\+[1-9]\d{6,14}$/;
const SNOWFLAKE = /^\d{15,22}$/;

const phone = (s: string) => s.replace(/[\s().-]/g, '');

const WAJID = /^\d{5,20}@(s\.whatsapp\.net|lid)$/;

/** The network a typed address can only belong to. Names and Discord ids answer null: pick those from a list. */
export function guessDirectNetwork(input: string): Network | null {
  return guessDirectNetworks(input)[0] ?? null;
}

/** Every network a typed address could belong to: a phone number fits Signal and WhatsApp. */
export function guessDirectNetworks(input: string): Network[] {
  const s = input.trim();
  if (MXID.test(s)) return ['matrix'];
  if (WAJID.test(s)) return ['whatsapp'];
  if (ACI.test(s.toLowerCase())) return ['signal'];
  if (PHONE.test(phone(s))) return ['signal', 'whatsapp'];
  return [];
}

/** The native address to give an adapter's openDirect, or what is wrong with this one. */
export function directTarget(network: Network, input: string): { peer: string } | { error: string } {
  const s = input.trim();
  if (network === 'matrix') return MXID.test(s) ? { peer: s } : { error: 'A Matrix ID looks like @name:server.org' };
  if (network === 'signal') {
    if (ACI.test(s.toLowerCase())) return { peer: s.toLowerCase() };
    return PHONE.test(phone(s)) ? { peer: phone(s) } : { error: 'A phone number needs its country code, like +15551234567' };
  }
  if (network === 'whatsapp') {
    if (WAJID.test(s)) return { peer: s };
    return PHONE.test(phone(s)) ? { peer: phone(s) } : { error: 'A phone number needs its country code, like +15551234567' };
  }
  return SNOWFLAKE.test(s) ? { peer: s } : { error: 'Pick someone you know on Discord: it needs their user id' };
}
