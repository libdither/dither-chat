import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushService } from '../src/push.ts';
import { Store } from '../src/store.ts';
import { HubServer } from '../src/server.ts';
import { Triage } from '../src/triage.ts';
import { encryptPayload, extraRelays, generateVapidKeys, isPrivateAddress, isPushRelay, loadVapidKeys, pushPayload, resolvesPrivate, serverOrigin, vapidHeader } from '../src/webpush.ts';

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
    await svc.notify('Alice', 'hello there', 'cnv_1', { canReply: true, replyTo: 'msg_1' });
    const r = received.at(-1)!;
    expect(r.path).toBe('/a');
    expect(r.headers.get('content-encoding')).toBe('aes128gcm');
    expect(r.headers.get('authorization')).toStartWith('vapid t=');
    expect(Number(r.headers.get('ttl'))).toBeGreaterThan(0);
    expect(JSON.parse(decrypt(r.body, d.ua, d.auth))).toEqual({ title: 'Alice', body: 'hello there', conversationId: 'cnv_1', canReply: true, replyTo: 'msg_1' });
    expect(Buffer.from(r.body).includes('hello')).toBe(false);
    expect(() => decrypt(r.body, other.ua, other.auth)).toThrow();
    expect(svc.devices()[0]).toMatchObject({ label: 'Phone', lastError: null });
    await svc.notify('Daily digest: 2 messages', 'Kitchen (2).', undefined, { inbox: true });
    expect(JSON.parse(decrypt(received.at(-1)!.body, d.ua, d.auth))).toEqual({ title: 'Daily digest: 2 messages', body: 'Kitchen (2).', inbox: true });
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
      await svc.notify('t', 'b', 'c', {});
      expect(svc.devices().length).toBe(0);
    }
    svc.subscribe({ endpoint: ep('flaky'), p256dh: d.p256dh, auth: d.auth64 });
    answer = 500;
    await svc.notify('t', 'b', 'c', {});
    expect(svc.devices()[0].lastError).toContain('500');
    expect(svc.devices()[0].lastErrorAt).toBeGreaterThan(0);
    for (let i = 0; i < 19; i++) await svc.notify('t', 'b', 'c', {});
    // Twenty failures alone are a phone that was off for a day: it stays until nothing has gone through for a week.
    expect(svc.devices().length).toBe(1);
    store.db.query('UPDATE push_subscription SET created_at = 0').run();
    await svc.notify('t', 'b', 'c', {});
    expect(svc.devices().length).toBe(0);
    answer = 201;
  });

  test('an unreachable relay is a failure, not a crash, and subscribing again resets it', async () => {
    const d = device();
    svc.subscribe({ endpoint: 'http://127.0.0.1:1/x', p256dh: d.p256dh, auth: d.auth64 }, 'Gone');
    await svc.notify('t', 'b', 'c', {});
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

  test('a UnifiedPush server is allowed only as the exact origin the operator listed', () => {
    const extra = extraRelays(' https://ntfy.example.net , http://127.0.0.1:2586, https://bad.example/path, ftp://x.example, nonsense');
    expect(extra).toEqual(['https://ntfy.example.net', 'http://127.0.0.1:2586']);
    expect(extraRelays(undefined)).toEqual([]);
    expect(isPushRelay('https://ntfy.example.net/upAbC?up=1', extra)).toBe(true);
    expect(isPushRelay('http://127.0.0.1:2586/upAbC?up=1', extra)).toBe(true);
    for (const e of ['https://ntfy.example.net/upAbC?up=1', 'http://127.0.0.1:2586/up']) expect(isPushRelay(e)).toBe(false);
    for (const e of ['http://ntfy.example.net/up', 'https://ntfy.example.net:8443/up', 'https://x.ntfy.example.net/up', 'https://user@ntfy.example.net/up', 'http://127.0.0.1:2587/up', 'https://127.0.0.1:2586/up']) expect(isPushRelay(e, extra)).toBe(false);
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

describe('push servers, allowed from the app', () => {
  let dir: string;
  let store: Store;
  const keys = generateVapidKeys();
  /** Fake DNS: public names resolve to a public address, *.ts.net and tailnet names to Tailscale's range. */
  const dns: Record<string, string[]> = { 'ntfy.example.net': ['203.0.113.7'], 'ntfy.sh': ['159.203.148.75'], 'ntfy.tail.ts.net': ['100.101.102.103'], 'moves.example.net': ['203.0.113.8'] };
  const lookup = async (h: string) => dns[h] ?? [];
  const sent: string[] = [];
  const transport = (async (url: string) => (sent.push(url), new Response('', { status: 201 }))) as unknown as typeof fetch;
  const make = (env: Record<string, string> = {}) => {
    const svc = new PushService(store, keys, 's', env);
    svc.lookup = lookup;
    svc.transport = transport;
    return svc;
  };
  const sub = (endpoint: string) => {
    const d = device();
    return { endpoint, p256dh: d.p256dh, auth: d.auth64 };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-push-servers-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('addresses: typed text means https, a path is refused, and an endpoint gives its origin', () => {
    expect(serverOrigin('ntfy.example.net', true)).toEqual({ origin: 'https://ntfy.example.net' });
    expect(serverOrigin(' ntfy.example.net:8443 ', true)).toEqual({ origin: 'https://ntfy.example.net:8443' });
    expect(serverOrigin('http://100.64.0.5:2586', true)).toEqual({ origin: 'http://100.64.0.5:2586' });
    expect(serverOrigin('https://ntfy.example.net/upX?up=1')).toEqual({ origin: 'https://ntfy.example.net' });
    for (const bad of ['https://ntfy.example.net/up', 'ftp://x.example', 'https://u:p@ntfy.example.net', '']) expect('error' in serverOrigin(bad, true)).toBe(true);
  });

  test('private addresses: loopback, RFC 1918, link-local, CGNAT (Tailscale), unique-local', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0', '::1', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:127.0.0.1', '[::1]']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.7', '2001:db8::1']) expect(isPrivateAddress(ip)).toBe(false);
    expect(await resolvesPrivate('localhost', lookup)).toMatchObject({ private: true });
    expect(await resolvesPrivate('ntfy.tail.ts.net', lookup)).toEqual({ private: true, addresses: ['100.101.102.103'] });
    expect(await resolvesPrivate('nowhere.invalid', lookup)).toEqual({ private: true, addresses: [] });
    expect(await resolvesPrivate('ntfy.example.net', lookup)).toEqual({ private: false, addresses: ['203.0.113.7'] });
  });

  test('ntfy.sh is allowed by default; the owner can turn it off, which drops its devices, and back on', async () => {
    const svc = make();
    expect(svc.servers().find((s) => s.origin === 'https://ntfy.sh')).toMatchObject({ source: 'default', off: false });
    expect(svc.subscribe(sub('https://ntfy.sh/upAAA?up=1'), 'Phone')).toBeTruthy();
    expect(svc.revoke('https://ntfy.sh')).toEqual({ ok: true, removed: 1 });
    expect(svc.servers().find((s) => s.origin === 'https://ntfy.sh')).toMatchObject({ off: true });
    expect(svc.subscribe(sub('https://ntfy.sh/upBBB?up=1'), 'Phone')).toBeNull();
    expect(svc.pendingList()).toEqual([expect.objectContaining({ origin: 'https://ntfy.sh', labels: ['Phone'], http: false })]);
    // One tap: allowed again, and the device that was refused is registered without asking it again.
    expect(await svc.approve('https://ntfy.sh')).toEqual({ ok: true, origin: 'https://ntfy.sh', registered: 1 });
    expect(svc.devices().map((d) => d.server)).toEqual(['https://ntfy.sh']);
    expect(svc.pendingList()).toEqual([]);
    svc.remove({ endpoint: 'https://ntfy.sh/upBBB?up=1' });
  });

  test('an unknown https server: refused and held, then one tap allows it and registers the device', async () => {
    const svc = make();
    const e = 'https://ntfy.example.net/upCCC?up=1';
    expect(svc.subscribe(sub(e), 'Android app, Pixel')).toBeNull();
    expect(svc.pendingFor(e)).toMatchObject({ origin: 'https://ntfy.example.net', http: false });
    const r = await svc.approve('https://ntfy.example.net');
    expect(r).toEqual({ ok: true, origin: 'https://ntfy.example.net', registered: 1 });
    expect(svc.servers().find((s) => s.origin === 'https://ntfy.example.net')).toMatchObject({ source: 'approved', private: false, devices: 1 });
    // Allowed means that origin only: not another port, scheme or subdomain.
    for (const other of ['https://ntfy.example.net:8443/up', 'http://ntfy.example.net/up', 'https://x.ntfy.example.net/up']) expect(svc.subscribe(sub(other))).toBeNull();
    expect(await svc.test({ endpoint: e })).toEqual({ ok: true });
    expect(sent.at(-1)).toBe(e);
    // Removing it stops sending and forgets the devices on it.
    expect(svc.revoke('https://ntfy.example.net')).toEqual({ ok: true, removed: 1 });
    expect(svc.subscribe(sub(e))).toBeNull();
    for (const p of svc.pendingList()) svc.dismiss(p.origin);
  });

  test('a private address asks first, and plain http only when typed out', async () => {
    const svc = make();
    expect(svc.subscribe(sub('https://ntfy.tail.ts.net/upDDD?up=1'), 'Phone')).toBeNull();
    const asked = await svc.approve('https://ntfy.tail.ts.net');
    expect(asked).toMatchObject({ ok: false, confirm: 'private', addresses: ['100.101.102.103'] });
    expect(svc.devices()).toEqual([]);
    expect(await svc.approve('https://ntfy.tail.ts.net', { allowPrivate: true })).toMatchObject({ ok: true, registered: 1 });
    expect(svc.servers().find((s) => s.origin === 'https://ntfy.tail.ts.net')).toMatchObject({ private: true });
    expect(await svc.test({ endpoint: 'https://ntfy.tail.ts.net/upDDD?up=1' })).toEqual({ ok: true });

    expect(svc.subscribe(sub('http://100.64.0.9:2586/upEEE?up=1'))).toBeNull();
    expect(svc.pendingList().find((p) => p.origin === 'http://100.64.0.9:2586')).toMatchObject({ http: true });
    expect(await svc.approve('http://100.64.0.9:2586')).toMatchObject({ ok: false });
    expect(await svc.approve('http://100.64.0.9:2586', { typed: true })).toMatchObject({ ok: false, confirm: 'private' });
    expect(await svc.approve('http://100.64.0.9:2586', { typed: true, allowPrivate: true })).toMatchObject({ ok: true, registered: 1 });
    svc.revoke('https://ntfy.tail.ts.net');
    svc.revoke('http://100.64.0.9:2586');
  });

  test('an allowed public name that later points at a private address is refused at send time', async () => {
    const svc = make();
    await svc.approve('https://moves.example.net');
    const e = 'https://moves.example.net/upFFF?up=1';
    svc.subscribe(sub(e), 'Phone');
    dns['moves.example.net'] = ['127.0.0.1'];
    const n = sent.length;
    const r = await svc.test({ endpoint: e });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('private address');
    expect(sent.length).toBe(n);
    svc.revoke('https://moves.example.net');
  });

  test('DITHER_PUSH_RELAYS servers are listed and cannot be removed from the app', () => {
    const svc = make({ DITHER_PUSH_RELAYS: 'https://env.example.net' });
    expect(svc.servers().find((s) => s.origin === 'https://env.example.net')).toMatchObject({ source: 'environment' });
    expect(svc.revoke('https://env.example.net').ok).toBe(false);
  });

  test("ntfy's 507 for a topic nobody listens on says what to do, and a test that arrives is recorded", async () => {
    const svc = make();
    svc.transport = (async () => new Response('{"code":50701,"http":507,"error":"cannot publish to UnifiedPush topic without previously active subscriber"}', { status: 507 })) as unknown as typeof fetch;
    await svc.approve('https://ntfy.sh');
    const id = svc.subscribe(sub('https://ntfy.sh/upGGG?up=1'), 'Phone')!;
    const r = await svc.test({ id });
    expect(r).toMatchObject({ ok: false, code: 'no-subscriber' });
    expect(r.error).toContain('Open the ntfy app');
    expect(svc.devices()[0].lastTestAt).toBeGreaterThan(0);
    svc.arrived(id);
    expect(svc.devices()[0].lastArrivedAt).toBeGreaterThan(0);
    svc.remove({ id });
  });

  test('the old DITHER_NTFY_URL topic still gets every push, and has a test', async () => {
    const posts: [string, RequestInit][] = [];
    const svc = make({ DITHER_NTFY_URL: 'https://ntfy.example.net/mytopic', DITHER_NTFY_TOKEN: 'tk', DITHER_PUBLIC_URL: 'https://chat.example.net' });
    svc.transport = (async (url: string, init: RequestInit) => (posts.push([url, init]), new Response('{}'))) as unknown as typeof fetch;
    await svc.notify('Alice', 'hi', 'cnv_1', {});
    expect(posts[0][0]).toBe('https://ntfy.example.net/mytopic');
    expect(posts[0][1].headers).toMatchObject({ Title: 'Alice', Authorization: 'Bearer tk', Click: 'https://chat.example.net/#/inbox/c/cnv_1' });
    expect(svc.topicView()).toMatchObject({ server: 'https://ntfy.example.net', lastError: null });
    expect(await svc.test({ id: 'ntfy-topic' })).toEqual({ ok: true });
    expect(make().topicView()).toBeNull();
  });

  test('over HTTP: only a same-origin page can allow a server; a refused device learns which one', async () => {
    const svc = make();
    const port = 19460 + Math.floor(Math.random() * 1000);
    const sup = { authorize: () => null, online: () => true, command: async () => undefined } as any;
    const hub = new HubServer(store, sup, new Triage(store), { port, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's', push: svc });
    hub.start();
    const url = `http://127.0.0.1:${port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') => fetch(url + path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
    try {
      const refused = await post('/api/push/subscribe', { subscription: { endpoint: 'https://ntfy.example.net/upHHH?up=1', keys: sub('x') }, label: 'Phone' });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ server: 'https://ntfy.example.net', http: false });
      expect(((await (await fetch(`${url}/api/push`)).json()) as any).pending[0].origin).toBe('https://ntfy.example.net');
      // No Origin (curl, the Android app's own requests) and another site's Origin are both refused.
      expect((await post('/api/push/servers', { origin: 'https://ntfy.example.net' })).status).toBe(403);
      expect((await post('/api/push/servers', { origin: 'https://ntfy.example.net' }, { origin: 'https://evil.example' })).status).toBe(403);
      const ok = await post('/api/push/servers', { origin: 'https://ntfy.example.net' }, { origin: url });
      expect(await ok.json()).toEqual({ ok: true, origin: 'https://ntfy.example.net', registered: 1 });
      const asked = await post('/api/push/servers', { origin: 'ntfy.tail.ts.net', typed: true }, { origin: url });
      expect(asked.status).toBe(409);
      expect((await post('/api/push/servers', { origin: 'https://ntfy.example.net' }, {}, 'DELETE')).status).toBe(403);
      expect(await (await post('/api/push/servers', { origin: 'https://ntfy.example.net' }, { origin: url }, 'DELETE')).json()).toEqual({ ok: true, removed: 1 });
    } finally {
      hub.stop();
    }
  });
});
