import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushService } from '../src/push.ts';
import { Store } from '../src/store.ts';
import { encryptPayload, generateVapidKeys, isPushRelay, loadVapidKeys, pushPayload, vapidHeader } from '../src/webpush.ts';

const u = (s: string) => Buffer.from(s, 'base64url');

describe('payload encryption', () => {
  test('reproduces the worked example in RFC 8291 section 5', () => {
    const out = encryptPayload(
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      Buffer.from('When I grow up, I want to be a watermelon'),
      { asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: 'DGv6ra1nlYgDCS1FRnbzlw' },
    );
    expect(out.toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });
});

/** What a browser does with a push: the receiving half of RFC 8291, kept independent of the code under test. */
function decrypt(body: Uint8Array, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
  const b = Buffer.from(body);
  const salt = b.subarray(0, 16);
  const idlen = b[20];
  const asPublic = b.subarray(21, 21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const ct = b.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString();
}

function device() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  return { ua, auth, p256dh: ua.getPublicKey().toString('base64url'), auth64: auth.toString('base64url') };
}

describe('VAPID', () => {
  test('a valid ES256 token for the endpoint origin', () => {
    const keys = generateVapidKeys();
    const h = vapidHeader(keys, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:a@b.c', 1_000_000);
    const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
    expect(m[4]).toBe(keys.publicKey);
    const claims = JSON.parse(u(m[2]).toString());
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1000 + 12 * 3600, sub: 'mailto:a@b.c' });
    const pub = u(keys.publicKey);
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, u(m[3]))).toBe(true);
  });
});

describe('the service', () => {
  let dir: string;
  let store: Store;
  let svc: PushService;
  let srv: ReturnType<typeof Bun.serve>;
  const received: { path: string; headers: Headers; body: Uint8Array }[] = [];
  let answer = 201;
  const ep = (p: string) => `http://127.0.0.1:${srv.port}/${p}`;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-push-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    srv = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        received.push({ path: new URL(req.url).pathname, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
        return new Response('', { status: answer });
      },
    });
    svc = new PushService(store, generateVapidKeys(), 'https://example.org');
    svc.allow = () => true;
  });
  afterAll(() => {
    srv.stop(true);
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('over real HTTP, a device can read what the hub sends, and nobody else can', async () => {
    const d = device();
    const other = device();
    svc.subscribe({ endpoint: ep('a'), p256dh: d.p256dh, auth: d.auth64 }, 'Phone');
    await svc.notify('Alice', 'hello there', 'cnv_1', 'msg_1');
    const r = received.at(-1)!;
    expect(r.path).toBe('/a');
    expect(r.headers.get('content-encoding')).toBe('aes128gcm');
    expect(r.headers.get('authorization')).toStartWith('vapid t=');
    expect(Number(r.headers.get('ttl'))).toBeGreaterThan(0);
    expect(JSON.parse(decrypt(r.body, d.ua, d.auth))).toEqual({ title: 'Alice', body: 'hello there', conversationId: 'cnv_1', messageId: 'msg_1' });
    expect(Buffer.from(r.body).includes('hello')).toBe(false);
    expect(() => decrypt(r.body, other.ua, other.auth)).toThrow();
    expect(svc.devices()[0]).toMatchObject({ label: 'Phone', lastError: null });
    expect(svc.devices()[0].lastOkAt).not.toBeNull();
    svc.remove({ endpoint: ep('a') });
  });

  test('a test push reaches only that device and works', async () => {
    const a = device();
    const b = device();
    svc.subscribe({ endpoint: ep('one'), p256dh: a.p256dh, auth: a.auth64 }, 'One');
    svc.subscribe({ endpoint: ep('two'), p256dh: b.p256dh, auth: b.auth64 }, 'Two');
    const n = received.length;
    expect(await svc.test({ endpoint: ep('two') })).toEqual({ ok: true });
    expect(received.length).toBe(n + 1);
    expect(received.at(-1)!.path).toBe('/two');
    expect(JSON.parse(decrypt(received.at(-1)!.body, b.ua, b.auth)).test).toBe(true);
    svc.remove({ endpoint: ep('one') });
    svc.remove({ endpoint: ep('two') });
  });

  test('stale subscriptions go away: 404 and 410 at once, others after many failures', async () => {
    const d = device();
    for (const status of [404, 410]) {
      svc.subscribe({ endpoint: ep('dead'), p256dh: d.p256dh, auth: d.auth64 });
      answer = status;
      await svc.notify('t', 'b', 'c', 'm');
      expect(svc.devices().length).toBe(0);
    }
    svc.subscribe({ endpoint: ep('flaky'), p256dh: d.p256dh, auth: d.auth64 });
    answer = 500;
    await svc.notify('t', 'b', 'c', 'm');
    expect(svc.devices()[0].lastError).toContain('500');
    for (let i = 0; i < 19; i++) await svc.notify('t', 'b', 'c', 'm');
    expect(svc.devices().length).toBe(0);
    answer = 201;
  });

  test('an unreachable relay is a failure, not a crash, and subscribing again resets it', async () => {
    const d = device();
    svc.subscribe({ endpoint: 'http://127.0.0.1:1/x', p256dh: d.p256dh, auth: d.auth64 }, 'Gone');
    await svc.notify('t', 'b', 'c', 'm');
    expect(svc.devices()[0].lastError).toBeTruthy();
    svc.subscribe({ endpoint: 'http://127.0.0.1:1/x', p256dh: d.p256dh, auth: d.auth64 }, '');
    expect(svc.devices()[0]).toMatchObject({ lastError: null, label: 'Gone' });
    svc.remove({ endpoint: 'http://127.0.0.1:1/x' });
  });

  test('only real relays can be subscribed by default', () => {
    const real = new PushService(store, generateVapidKeys(), 's');
    const d = device();
    expect(real.subscribe({ endpoint: 'http://169.254.169.254/latest', p256dh: d.p256dh, auth: d.auth64 })).toBeNull();
    for (const e of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://jmt17.google.com/fcm/send/x']) expect(isPushRelay(e)).toBe(true);
    for (const e of ['http://fcm.googleapis.com/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x', 'nonsense']) expect(isPushRelay(e)).toBe(false);
  });

  test('VAPID keys persist, privately', () => {
    const a = loadVapidKeys(dir);
    expect(loadVapidKeys(dir)).toEqual(a);
    expect(statSync(join(dir, 'vapid.json')).mode & 0o077).toBe(0);
  });
  test('payloads are trimmed to what relays accept', () => {
    const d = device();
    const body = encryptPayload({ p256dh: d.p256dh, auth: d.auth64 }, Buffer.from(JSON.stringify(pushPayload('t'.repeat(9000), 'b'.repeat(9000), 'c'))));
    expect(body.length).toBeLessThan(4096);
  });
});
