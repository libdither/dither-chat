/**
 * Web Push: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8188, RFC 8291), on node:crypto alone.
 *
 * This is what makes a notification reach a device with no open connection. It goes through the browser
 * vendor's relay (Google, Apple, Mozilla, Microsoft): the payload is encrypted end to end, but the relay sees
 * when a push happens and to which device. So it is opt-in per device. A UnifiedPush server (ntfy) takes the same
 * pushes for the Android app; a self-hosted one keeps that metadata on your own machines.
 */
import { createCipheriv, createECDH, createHash, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const b64u = (b: Uint8Array | string) => Buffer.from(b as any).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** One identity per hub, kept so subscriptions outlive restarts. */
export function loadVapidKeys(dataDir: string): VapidKeys {
  const p = join(dataDir, 'vapid.json');
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(generateVapidKeys()), { mode: 0o600 });
  chmodSync(p, 0o600);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/** RFC 8291. `as` and `salt` are only passed by tests, to replay the RFC's own example. */
export function encryptPayload(target: Pick<PushTarget, 'p256dh' | 'auth'>, plaintext: Uint8Array, fixed?: { asPrivate: string; salt: string }): Buffer {
  const uaPublic = unb64u(target.p256dh);
  const auth = unb64u(target.auth);
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(unb64u(fixed.asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed ? unb64u(fixed.salt) : randomBytes(16);
  const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** An ES256 JWT for this endpoint's origin (RFC 8292). */
export function vapidHeader(keys: VapidKeys, endpoint: string, subject: string, now = Date.now()): string {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const pub = unb64u(keys.publicKey);
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

export type PushOutcome = 'ok' | 'gone' | 'failed';

/** The relays browsers actually use. Anything else is refused, so the hub cannot be aimed at arbitrary hosts. */
const RELAYS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^jmt\d+\.google\.com$/, /\.push\.services\.mozilla\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];

/**
 * UnifiedPush servers allowed without asking. ntfy.sh is the ntfy app's default server, so the Android app works out of
 * the box with it. The hub's pushes are encrypted for the device (RFC 8291) before they leave, so ntfy.sh sees what a
 * browser vendor's relay sees: when a push happens, its size, and a random topic. The owner can turn it off in Settings.
 */
export const DEFAULT_SERVERS = ['https://ntfy.sh'];

/**
 * Push servers the operator named in DITHER_PUSH_RELAYS, as exact origins: `https://ntfy.example.net`. The Android
 * app gets its endpoint from a UnifiedPush distributor (the ntfy app, say), which speaks the same RFC 8291 Web Push
 * as the browser relays, on whatever server the distributor uses. A listed origin allows only itself: no other port,
 * no subdomain, and plain http only if it was written that way. Settings → Notifications does the same from the app.
 */
export function extraRelays(env = process.env.DITHER_PUSH_RELAYS): string[] {
  const out: string[] = [];
  for (const s of (env ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    try {
      const u = new URL(s);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.pathname === '/' && !u.search && !u.username) out.push(u.origin);
      else console.error(`DITHER_PUSH_RELAYS: ${s} is not an origin like https://ntfy.example.net, ignored`);
    } catch {
      console.error(`DITHER_PUSH_RELAYS: ${s} is not a URL, ignored`);
    }
  }
  return out;
}

/** A browser vendor's relay: always allowed, never listed. */
export function isBrowserRelay(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.username && !u.password && RELAYS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

export function isPushRelay(endpoint: string, extra: string[] = []): boolean {
  try {
    const u = new URL(endpoint);
    if (u.username || u.password) return false;
    if (extra.includes(u.origin)) return true;
    return isBrowserRelay(endpoint);
  } catch {
    return false;
  }
}

/**
 * A push server's origin from what someone typed in Settings, or from a device's endpoint. Typed text without a
 * scheme means https; plain http only when it was typed out, since it is for a server on your own network.
 */
export function serverOrigin(input: string, typed = false): { origin: string } | { error: string } {
  let s = input.trim();
  if (typed && s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: `${input.trim() || 'That'} is not an address like https://ntfy.example.net` };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'A push server is an https:// address' };
  if (u.username || u.password) return { error: 'A push server address has no user name or password in it' };
  if (typed && (u.pathname !== '/' || u.search || u.hash)) return { error: `Only the server, without a path: ${u.origin}` };
  return { origin: u.origin };
}

/** Loopback, private, link-local, carrier-grade NAT (Tailscale's 100.64/10), unique-local: not the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = a.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [x, y] = [+v4[1], +v4[2]];
    return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || x >= 224;
  }
  if (!a.includes(':')) return false;
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('64:ff9b:');
}

/** Where a host name points, and whether any of it is not the public internet. Names that do not resolve count as private. */
export async function resolvesPrivate(hostname: string, lookup: (h: string) => Promise<string[]> = defaultLookup): Promise<{ private: boolean; addresses: string[] }> {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return { private: isPrivateAddress(h), addresses: [h] };
  if (h === 'localhost' || h.endsWith('.localhost')) return { private: true, addresses: ['127.0.0.1'] };
  const addresses = await lookup(h).catch(() => [] as string[]);
  return { private: !addresses.length || addresses.some(isPrivateAddress), addresses };
}

async function defaultLookup(h: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  return (await lookup(h, { all: true })).map((r) => r.address);
}

export async function sendPush(target: PushTarget, payload: unknown, keys: VapidKeys, subject: string, opts: { ttl?: number; fetch?: typeof fetch } = {}): Promise<{ outcome: PushOutcome; status: number; detail?: string }> {
  const res = await (opts.fetch ?? fetch)(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(keys, target.endpoint, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttl ?? 86_400),
      Urgency: 'high',
    },
    body: new Uint8Array(encryptPayload(target, Buffer.from(JSON.stringify(payload)))),
    signal: AbortSignal.timeout(15_000),
  });
  // 404 and 410 mean the subscription is dead. Anything else may pass.
  if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status };
  if (res.ok) return { outcome: 'ok', status: res.status };
  return { outcome: 'failed', status: res.status, detail: await res.text().catch(() => '') };
}

/** Fits inside the 4 KB relays accept, with room for encryption overhead. */
export function pushPayload(title: string, body: string, conversationId: string | undefined, extra: Record<string, unknown> = {}) {
  return { title: title.slice(0, 200), body: body.slice(0, 1000), conversationId, ...extra };
}

export const fingerprint = (endpoint: string) => createHash('sha256').update(endpoint).digest('base64url').slice(0, 16);
