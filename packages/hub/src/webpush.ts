/**
 * Web Push: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8188, RFC 8291), on node:crypto alone.
 *
 * This is what makes a notification reach a device with no open connection. It goes through the browser
 * vendor's relay (Google, Apple, Mozilla, Microsoft): the payload is encrypted end to end, but the relay sees
 * when a push happens and to which device. So it is opt-in per device. ntfy stays the fully self-hosted route.
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
 * Push servers the operator named in DITHER_PUSH_RELAYS, as exact origins: `https://ntfy.example.net`. The Android
 * app gets its endpoint from a UnifiedPush distributor (the ntfy app, say), which speaks the same RFC 8291 Web Push
 * as the browser relays, on whatever server the distributor uses. Nothing is allowed by default, and a listed origin
 * allows only itself: no other port, no subdomain, and plain http only if it was written that way.
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

export function isPushRelay(endpoint: string, extra: string[] = []): boolean {
  try {
    const u = new URL(endpoint);
    if (u.username || u.password) return false;
    if (extra.includes(u.origin)) return true;
    return u.protocol === 'https:' && RELAYS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

export async function sendPush(target: PushTarget, payload: unknown, keys: VapidKeys, subject: string, opts: { ttl?: number; fetch?: typeof fetch } = {}): Promise<{ outcome: PushOutcome; status: number }> {
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
  return { outcome: res.ok ? 'ok' : 'failed', status: res.status };
}

/** Fits inside the 4 KB relays accept, with room for encryption overhead. */
export function pushPayload(title: string, body: string, conversationId: string | undefined, extra: Record<string, unknown> = {}) {
  return { title: title.slice(0, 200), body: body.slice(0, 1000), conversationId, ...extra };
}

export const fingerprint = (endpoint: string) => createHash('sha256').update(endpoint).digest('base64url').slice(0, 16);
