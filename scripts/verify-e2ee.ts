/**
 * Encryption through the real hub and PWA, against the local testbed only: a temporary data dir,
 * a temporary zyan device, alice as the other client, headless Chromium as you.
 *   DITHER_TESTBED_PORT=... bun packages/adapter-matrix/testbed/testbed.ts up
 *   bun scripts/verify-e2ee.ts [screenshot-dir]
 * DITHER_WEB_DIST: serve that build of the PWA (e.g. one made with vite build --outDir /tmp/...).
 *
 * The hub reaches the homeserver through a proxy that the script breaks on purpose (testbed/flaky.ts),
 * and a second zyan device (test/peer.ts) plays Element: the recovery key path, then emoji
 * verification through a dropped connection and a reloaded page, a repeated request, a timeout.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Peer, M } from '../packages/adapter-matrix/test/peer.ts';
import { enc, MatrixClient } from '../packages/adapter-matrix/src/http.ts';
import { encodeRecoveryKey, encryptSecret, secretKeyInfo } from '../packages/adapter-matrix/src/recovery.ts';
import { FlakyProxy } from '../packages/adapter-matrix/testbed/flaky.ts';
import { testbedImage } from '../packages/adapter-matrix/testbed/png.ts';
import { launch } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dither-e2ee-shots-'));
const tb = await Bun.file(join(REPO, '.data/matrix-testbed/testbed.json')).json();
const data = mkdtempSync(join(tmpdir(), 'dither-e2ee-hub-'));
const PORT = 8491;
const url = `http://127.0.0.1:${PORT}`;
let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};

const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];
const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--data', data, '--port', String(PORT), '--host', '127.0.0.1', ...web], { cwd: REPO, env: { ...process.env, DITHER_CALENDAR_URL: 'off' }, stdout: 'ignore', stderr: 'inherit' });
const proxy = new FlakyProxy(tb.baseUrl).start();
const api = async (path: string, body?: unknown) => {
  const r = await fetch(url + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
for (let i = 0; i < 100; i++) {
  if (await fetch(url).then((r) => r.ok, () => false)) break;
  await Bun.sleep(100);
}

const alice = await Peer.login(tb.baseUrl, 'alice', tb.users.alice.password);
const zyanOther = new MatrixClient(tb.baseUrl);
zyanOther.accessToken = tb.users.zyan.accessToken;
const { room_id: room } = await alice.client.request('POST', '/_matrix/client/v3/createRoom', {
  body: { name: 'Hub encryption check', preset: 'private_chat', invite: [tb.users.zyan.userId], initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] },
});
await zyanOther.request('POST', `/_matrix/client/v3/join/${enc(room)}`, { body: {} });

const account = await api('/api/accounts', { network: 'matrix', adapter: 'matrix', label: 'testbed', config: { homeserver: proxy.url }, secret: { userId: tb.users.zyan.userId, password: tb.users.zyan.password } });
const { page, close } = await launch();
let other: Peer | null = null;
/** Actions the script makes fail on purpose (a mistyped recovery key): the hub answers those with a 500. */
let refusals = 0;
try {
  await page.size(1280, 900);
  page.on('Network.responseReceived', (p) => p.response.status >= 400 && console.log(`note: ${p.response.status} ${p.response.url}`));
  await page.goto(`${url}/#/accounts/${account.id}`);
  await page.until(`document.querySelector('.account-pane') !== null`, 20000);
  await page.until(`[...document.querySelectorAll('.account-pane button')].some((b) => b.textContent.includes('Set up encryption'))`, 20000);
  await page.shot(join(shots, 'e2ee-1-setup.png'));
  check(true, 'the account card offers "Set up encryption"');

  // The composer's refusal, before.
  let conv: any;
  for (let i = 0; i < 100 && !conv; i++) {
    conv = (await api('/api/bootstrap')).conversations.find((c: any) => c.nativeId === room);
    if (!conv) await Bun.sleep(200);
  }
  check(!!conv?.encrypted, 'the hub knows the room is encrypted');
  await page.goto(`${url}/#/inbox/c/${conv.id}`);
  await page.until(`document.querySelector('.composer-box.disabled') !== null`, 15000);
  const reason = await page.eval(`document.querySelector('.composer textarea').placeholder`);
  check(/Set up encryption/.test(reason), 'before setup the composer refuses, and points at the action', reason);
  await page.shot(join(shots, 'e2ee-2-refused.png'));

  // Setting it up, in the UI.
  await page.goto(`${url}/#/accounts/${account.id}`);
  await page.until(`[...document.querySelectorAll('.account-pane button')].some((b) => b.textContent.includes('Set up encryption'))`, 20000);
  await page.eval(`[...document.querySelectorAll('.account-pane button')].find((b) => b.textContent.includes('Set up encryption')).click()`);
  await page.until(`document.querySelector('.account-pane').textContent.includes('Fingerprint')`, 30000);
  await page.shot(join(shots, 'e2ee-3-active.png'));
  check(true, 'setting up from the card works');
  const secretFile = join(data, 'accounts', account.id, 'secret.json');
  check((statSync(secretFile).mode & 0o777) === 0o600, 'secret.json stays 0600');
  check((statSync(join(data, 'accounts', account.id, 'crypto.sqlite')).mode & 0o777) === 0o600, 'crypto.sqlite is 0600');
  check(readdirSync(join(data, 'accounts', account.id)).every((f) => !f.includes('recovery')), 'no stray key files');

  // Alice writes; the timeline shows it; search finds it. The composer sends; alice reads.
  await Bun.sleep(1000);
  const bytes = testbedImage();
  const att = M.Attachment.encrypt(bytes);
  const cipher = att.encryptedData;
  const file = JSON.parse(att.mediaEncryptionInfo!);
  const up = await alice.client.request('POST', '/_matrix/media/v3/upload', { body: cipher, contentType: 'application/octet-stream' });
  await alice.send(room, 'm.room.message', { msgtype: 'm.text', body: 'plaintextneedle from alice' });
  await alice.send(room, 'm.room.message', { msgtype: 'm.image', body: 'pic.png', file: { ...file, url: up.content_uri }, info: { mimetype: 'image/png', size: bytes.length, w: 96, h: 64 } });
  await page.goto(`${url}/#/inbox/c/${conv.id}`);
  await page.until(`document.querySelector('.pane')?.textContent.includes('plaintextneedle from alice')`, 20000);
  check(true, 'the timeline shows the decrypted text');
  await page.until(`[...document.querySelectorAll('.pane img')].some((i) => i.complete && i.naturalWidth === 96)`, 20000);
  check(true, 'the decrypted image renders in the page through the hub media path');
  await page.shot(join(shots, 'e2ee-4-timeline.png'));
  const found = await api('/api/search?q=plaintextneedle');
  check(JSON.stringify(found).includes('plaintextneedle'), 'search finds decrypted text on the hub');
  const cached = readdirSync(join(data, 'media-cache'));
  check(cached.length > 0 && cached.every((f) => (statSync(join(data, 'media-cache', f)).mode & 0o777) === 0o600), 'decrypted media in the cache is 0600', cached.length);

  await page.until(`!document.querySelector('.composer-box.disabled')`, 15000);
  await page.eval(`(() => { const t = document.querySelector('.composer textarea'); t.value = 'sent from the composer'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.eval(`document.querySelector('.send-btn').click()`);
  const got = await alice.waitFor((e) => e.content?.body === 'sent from the composer');
  check(got.raw.type === 'm.room.encrypted', 'the composer sends encrypted, and alice decrypts it');
  other = await Peer.login(tb.baseUrl, 'zyan', tb.users.zyan.password);
  await verification(conv.id, room, other);
  // A space icon asked for before its account has connected answers 404 with or without encryption.
  const errors = page.errors.filter((e) => !e.includes('404') && !(e.includes('status of 500') && refusals-- > 0));
  check(errors.length === 0, 'no page errors', errors);
} catch (e) {
  failed++;
  console.log(`FAIL  ${(e as Error).message}${process.env.VERBOSE ? `\n${(e as Error).stack}` : ""}`);
  await page.shot(join(shots, 'e2ee-failed.png')).catch(() => {});
} finally {
  await close();
  await alice.client.request('POST', `/_matrix/client/v3/rooms/${enc(room)}/leave`, { body: {} }).catch(() => {});
  await zyanOther.request('POST', `/_matrix/client/v3/rooms/${enc(room)}/leave`, { body: {} }).catch(() => {});
  await alice.stop();
  await other?.stop().catch(() => {});
  proxy.stop();
  const s = await Bun.file(join(data, 'accounts', account.id, 'secret.json')).json().catch(() => ({} as any));
  hub.kill();
  await hub.exited;
  if (s.accessToken) await fetch(`${tb.baseUrl}/_matrix/client/v3/logout`, { method: 'POST', headers: { authorization: `Bearer ${s.accessToken}` } }).catch(() => {});
  rmSync(data, { recursive: true, force: true });
}
console.log(`\n${failed ? `${failed} failed` : 'all passed'}; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);

// ------------------------------------------------------------------ verification and the recovery key

async function verification(convId: string, room: string, other: Peer) {
  const user = new M.UserId(tb.users.zyan.userId);
  const status = async () => (await api(`/api/accounts/${account.id}/action`, { action: 'encryptionStatus' })).result;
  const hubDevice: string = (await status()).deviceId;
  const pane = `document.querySelector('.account-pane')`;
  const click = (text: string) => page.eval(`(() => { const b = [...${pane}.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click(); })()`);
  const has = (text: string) => `${pane}?.textContent.includes(${JSON.stringify(text)})`;
  const typeKey = (value: string) =>
    page.eval(`(() => { const i = ${pane}.querySelector('.recovery-box input'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const until = async <T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms: number, what: string): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
      await Bun.sleep(150);
    }
  };
  const open = (r: M.VerificationRequest) => !r.isDone() && !r.isCancelled();

  // Element's side of the account: a cross-signing identity, a key backup, and secret storage holding
  // both under one recovery key, as Element sets it up (testbed only).
  // A keys query of the other device's first sync can land after the new identity and make it drop the
  // new private keys as stale; wait for that sync, and check the keys are still there a moment later.
  let own: Awaited<ReturnType<typeof other.machine.exportCrossSigningKeys>>;
  for (let attempt = 0; ; attempt++) {
    await Bun.sleep(2000);
    await other.bootstrapCrossSigning(tb.users.zyan.password);
    await Bun.sleep(2000);
    own = await other.machine.exportCrossSigningKeys();
    if ((own?.self_signing_key && own.masterKey) || attempt >= 2) break;
  }
  check(!!own?.self_signing_key && !!own.masterKey, 'recovery: the other device holds the cross-signing keys it stores');
  const backup = await other.createBackup();
  const ssss = crypto.getRandomValues(new Uint8Array(32));
  const keyId = `verify${Date.now()}`;
  await other.setAccountData(`m.secret_storage.key.${keyId}`, { algorithm: 'm.secret_storage.v1.aes-hmac-sha2', ...(await secretKeyInfo(ssss)) });
  await other.setAccountData('m.secret_storage.default_key', { key: keyId });
  const put = async (name: string, value: string | undefined) => value && other.setAccountData(name, { encrypted: { [keyId]: await encryptSecret(ssss, name, value) } });
  await put('m.cross_signing.master', own?.masterKey);
  await put('m.cross_signing.self_signing', own?.self_signing_key);
  await put('m.cross_signing.user_signing', own?.userSigningKey);
  await put('m.megolm_backup.v1', backup.key.toBase64());
  await until(async () => !!(await other.machine.getDevice(user, new M.DeviceId(hubDevice))), 30_000, 'the other device to know the hub device');

  // A message whose key the hub never gets: only the backup has it. "Old messages" in short.
  await alice.machine.invalidateGroupSession(new M.RoomId(room)); // a new room key, not yet shared with anyone
  const withheld = await alice.heldKeyShare(room);
  for (const req of withheld) {
    const body = JSON.parse(req.body);
    for (const devices of Object.values<any>(body.messages ?? {})) delete devices[hubDevice];
    await alice.send1({ type: req.type, id: req.id, event_type: req.event_type, txn_id: req.txn_id, body: JSON.stringify(body) });
  }
  await alice.sendWithoutShare(room, 'm.room.message', { msgtype: 'm.text', body: 'only the backup can read this' });
  await other.waitFor((e) => e.content?.body === 'only the backup can read this', 30_000);
  check((await other.uploadBackup()) > 0, 'recovery: the other device backed up its room keys');

  await page.goto(`${url}/#/accounts/${account.id}`);
  await page.until(`${pane}?.querySelector('.recovery-box input') !== null`, 20000);
  check(await page.eval(has('Unlock with your recovery key')), 'recovery: the account page offers the recovery key first');
  const key = encodeRecoveryKey(ssss);
  const compact = key.replace(/ /g, '');
  await typeKey(compact.slice(0, 12) + (compact[12] === 'a' ? 'b' : 'a') + compact.slice(13));
  await click('Unlock');
  refusals++;
  await page.until(`${pane}.querySelector('.form-error')?.textContent.includes('typo')`, 20000);
  check(true, 'recovery: a mistyped key says it has a typo, next to the field');
  await page.shot(join(shots, 'e2ee-5-recovery-typo.png'));
  await typeKey(key);
  await click('Unlock');
  await page.until(`${pane}.textContent.includes('Yes, cross-signed') && ${pane}.textContent.includes('Connected, version')`, 30000);
  check(true, 'recovery: the key verifies this device and connects the backup');
  await page.shot(join(shots, 'e2ee-6-recovered.png'));
  const st = await status();
  check(st.verified === true && st.backup?.version === backup.version && !st.recoveryError, 'recovery: the hub agrees', { verified: st.verified, backup: st.backup, error: st.recoveryError });
  await page.goto(`${url}/#/inbox/c/${convId}`);
  await page.until(`document.querySelector('.pane')?.textContent.includes('only the backup can read this')`, 30000);
  check(true, 'recovery: the old message decrypts from the backup, in the timeline');
  await other.send1(other.machine.queryKeysForUsers([new M.UserId(tb.users.zyan.userId)]));
  await until(async () => (await other.machine.getDevice(user, new M.DeviceId(hubDevice)))?.isCrossSigningTrusted(), 30_000, 'the other device to trust the hub device').then(
    () => check(true, 'recovery: the other device sees the hub device as verified'),
    () => check(false, 'recovery: the other device sees the hub device as verified'),
  );

  // Emoji verification, asked for by the other app (as when Element asks); accepted on the page. Then the
  // page reloads and the hub loses the homeserver for 15 s while the emoji are up; both still confirm.
  await page.goto(`${url}/#/accounts/${account.id}`);
  await page.until(`${pane}?.querySelector('.kv') !== null`, 20000);
  const hubDev = await other.machine.getDevice(user, new M.DeviceId(hubDevice));
  const [req, asked] = await hubDev!.requestVerification([M.VerificationMethod.SasV1]);
  await other.send1(asked);
  await page.until(`[...${pane}.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Accept')`, 20000);
  check(await page.eval(has(other.deviceId)), 'verify: the request on the page names the device that asks');
  await click('Accept');
  await until(() => req.phase() === M.VerificationRequestPhase.Ready, 20_000, 'the hub to accept');
  const startedA = await req.startSas();
  await other.send1(startedA![1]);
  const sas = startedA![0];
  await page.until(`${pane}.querySelector('.sas-emoji') !== null`, 30000);
  const clock = await page.eval<string>(`${pane}.querySelector('.verify-clock')?.textContent ?? ''`);
  check(/\d+ s left/.test(clock), 'verify: the page shows the emoji and the time left', clock);
  await page.shot(join(shots, 'e2ee-7-compare.png'));
  await until(() => sas.canBePresented(), 20_000, 'emoji on the other device');
  const theirs = sas.emoji()!.map((e) => e.symbol).join('');
  await page.goto(`${url}/#/accounts/${account.id}`); // a reload mid-flow, as when a phone brings the app back
  await page.until(`${pane}?.querySelector('.sas-emoji') !== null`, 20000);
  const mine = await page.eval<string>(`[...${pane}.querySelectorAll('.sas-symbol')].map((s) => s.textContent).join('')`);
  check(mine === theirs, 'verify: after a reload the same emoji are back', { mine, theirs });
  proxy.rule = (method, path) => (method === 'GET' && path.endsWith('/sync') ? 'hang' : path.includes('/sendToDevice/') ? 'reset' : 'pass');
  await proxy.refuse(50);
  setTimeout(() => (proxy.rule = () => 'pass'), 15_000);
  for (const out of await sas.confirm()) if (out) await other.send1(out);
  await Bun.sleep(2000);
  await click('They match');
  await until(() => req.isDone() || req.isCancelled(), 60_000, 'the flow to end').catch(() => {});
  const hubSide = (await status()).verification;
  check(req.isDone(), 'verify: a reload and 15 s without the homeserver while comparing do not end the flow', req.isDone() ? 'done' : { other: req.cancelInfo?.reason() ?? 'still open', otherConfirmed: sas.haveWeConfirmed(), hub: hubSide && { phase: hubSide.phase, sending: hubSide.sending, left: hubSide.expiresAt && Math.round((hubSide.expiresAt - Date.now()) / 1000) } });
  await page.until(`!${pane}.querySelector('.verify-device')`, 10000).catch(() => {});

  // The other app asks twice; the page follows the newer request. Nobody confirms: it times out and says so.
  const device = await other.machine.getDevice(user, new M.DeviceId(hubDevice));
  const [first, out1] = await device!.requestVerification([M.VerificationMethod.SasV1]);
  await other.send1(out1);
  await page.until(has('asks to verify this one'), 20000);
  first.cancel(); // Element was killed in the background and forgot it: no cancel reaches the hub
  const [second, out2] = await device!.requestVerification([M.VerificationMethod.SasV1]);
  await other.send1(out2);
  await until(async () => (await status()).verification?.flowId === second.flowId, 20_000, 'the hub to follow the newer request').then(
    () => check(true, 'verify: a repeated request replaces the first one'),
    async () => check(false, 'verify: a repeated request replaces the first one', (await status()).verification),
  );
  check(!second.isCancelled(), 'verify: and the new one stays open');
  await page.until(`[...${pane}.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Accept')`, 10000);
  await click('Accept');
  await until(() => second.phase() === M.VerificationRequestPhase.Ready, 20_000, 'the hub to accept');
  const started = await second.startSas();
  await other.send1(started![1]);
  await page.until(`${pane}.querySelector('.sas-emoji') !== null`, 30000);
  check(true, 'verify: the newer request reaches the emoji');
  await page.until(has('Verification did not finish'), 120000);
  const ended = await page.eval<string>(`${pane}.querySelector('.verify-why')?.textContent ?? ''`);
  check(/in time|gave up/.test(ended), 'verify: a flow that times out says so, and why', ended);
  await page.shot(join(shots, 'e2ee-8-timed-out.png'));
  const before = new Set(other.machine.getVerificationRequests(user).map((r) => r.flowId));
  await click('Start again');
  await until(() => other.machine.getVerificationRequests(user).some((r) => !before.has(r.flowId) && open(r)), 20_000, 'a new request').then(
    () => check(true, 'verify: "Start again" asks again in one tap'),
    () => check(false, 'verify: "Start again" asks again in one tap'),
  );
  await click('Cancel').catch(() => {});
}
