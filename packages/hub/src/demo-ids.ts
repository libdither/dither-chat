/** Native ids for the demo world, shaped like each network's own (demo.ts, demo-crowd.ts), the same every run. */

export const h = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest();
/** A Discord snowflake. */
export const snow = (k: string) => (BigInt('0x' + h('d' + k).toString('hex').slice(0, 15)) % 900000000000000000n + 1000000000000000000n).toString();
/** A Signal UUID. */
export const uuid = (k: string) => {
  const x = h('s' + k).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}`;
};
/** A Matrix room id on a server. */
export const room = (k: string, server: string) => `!${h('m' + k).toString('base64url').slice(0, 18)}:${server}`;
/** A Matrix event id. */
export const event = (k: string) => `$${h('e' + k).toString('base64url').slice(0, 43)}`;
/** A WhatsApp group jid. */
export const wgroup = (k: string) => `120363${BigInt('0x' + h('w' + k).toString('hex').slice(0, 12)).toString().padStart(12, '0').slice(0, 12)}@g.us`;
/** A Telegram user id. */
export const tgUser = (k: string) => String(100_000_000 + (h('t' + k).readUInt32BE(0) % 6_000_000_000));
