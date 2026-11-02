/**
 * Encryption through the real hub and PWA, against the local testbed only: a temporary data dir,
 * a temporary zyan device, alice as the other client, headless Chromium as you.
 *   DITHER_TESTBED_PORT=... bun packages/adapter-matrix/testbed/testbed.ts up
 *   bun scripts/verify-e2ee.ts [screenshot-dir]
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Peer, M } from '../packages/adapter-matrix/test/peer.ts';
import { enc, MatrixClient } from '../packages/adapter-matrix/src/http.ts';
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

const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--data', data, '--port', String(PORT), '--host', '127.0.0.1'], { cwd: REPO, stdout: 'ignore', stderr: 'inherit' });
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

const account = await api('/api/accounts', { network: 'matrix', adapter: 'matrix', label: 'testbed', config: { homeserver: tb.baseUrl }, secret: { userId: tb.users.zyan.userId, password: tb.users.zyan.password } });
const { page, close } = await launch();
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
  await page.goto(`${url}/#/groups/c/${conv.id}`);
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
  await page.goto(`${url}/#/groups/c/${conv.id}`);
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
  // A space icon asked for before its account has connected answers 404 with or without encryption.
  const errors = page.errors.filter((e) => !e.includes('404'));
  check(errors.length === 0, 'no page errors', errors);
} catch (e) {
  failed++;
  console.log(`FAIL  ${(e as Error).message}`);
  await page.shot(join(shots, 'e2ee-failed.png')).catch(() => {});
} finally {
  await close();
  await alice.client.request('POST', `/_matrix/client/v3/rooms/${enc(room)}/leave`, { body: {} }).catch(() => {});
  await zyanOther.request('POST', `/_matrix/client/v3/rooms/${enc(room)}/leave`, { body: {} }).catch(() => {});
  await alice.stop();
  const s = await Bun.file(join(data, 'accounts', account.id, 'secret.json')).json().catch(() => ({} as any));
  hub.kill();
  await hub.exited;
  if (s.accessToken) await fetch(`${tb.baseUrl}/_matrix/client/v3/logout`, { method: 'POST', headers: { authorization: `Bearer ${s.accessToken}` } }).catch(() => {});
  rmSync(data, { recursive: true, force: true });
}
console.log(`\n${failed ? `${failed} failed` : 'all passed'}; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
