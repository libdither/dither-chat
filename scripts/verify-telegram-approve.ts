/**
 * Approving a Telegram sign-in from the account page, end to end (docs/accounts.md, "Approving a Telegram sign-in"):
 * a throwaway dither-accounts manager runs the fake Telegram (TELEGRAM_FAKE=1), a throwaway hub uses it in remote
 * mode, and headless Chromium drives the page, with a fake camera that shows a QR code:
 *
 *   1. before sign-in the section is there but off, and the actions say to sign in first
 *   2. signed in, the devices list: this hub first and marked, with no sign-out; a negative hash; an empty region;
 *      a login code from Telegram's service account arrives as a message
 *   3. the scanner: the camera on, a QR code that is not a sign-in refused; the camera off while the page is hidden
 *   4. a pasted link: the warning (no undo for a day on a new account), the approve button armed only after a moment,
 *      nothing approved until it is pressed; then the device, app and place
 *   5. "That wasn't me": refused while this hub's session is under a day old, as Telegram words it; ended after
 *   6. an expired link, its error as it comes; a code read by the camera waits for the button; a picture of a code
 *   7. a row's sign-out with its confirm
 *   8. at 390 px in the dark and the light theme: no sideways overflow
 *   9. the camera refused (a browser without the fake camera's auto-accept): said so, the paste field still working
 *
 *   bun scripts/verify-telegram-approve.ts [--web packages/web/dist] [--manager-port 8690] [--hub-port 8691] [--keep]
 *
 * Build the page first (vite build --outDir <dir>, then --web <dir>). Needs dither-accounts beside this repo, in
 * ~/Projects, or at DITHER_ACCOUNTS_REPO; nothing there is written. Everything else is fresh under /tmp and deleted
 * after unless --keep (screenshots are in its shots/). Nothing reaches Telegram.
 */
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, type Page } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const argv = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const ACC = process.env.DITHER_ACCOUNTS_REPO ?? [resolve(REPO, '../dither-accounts'), join(homedir(), 'Projects/dither-accounts')].find((d) => existsSync(join(d, 'extractors/telegram')));
if (!ACC) throw new Error('no dither-accounts checkout: set DITHER_ACCOUNTS_REPO');
const WEB = resolve(opt('web', join(REPO, 'packages/web/dist')));
if (!existsSync(join(WEB, 'index.html'))) throw new Error(`no built page in ${WEB}: build it first`);
const MGR_PORT = Number(opt('manager-port', '8690'));
const HUB_PORT = Number(opt('hub-port', '8691'));
// The live manager and hub: never.
if ([8486, 8460].includes(MGR_PORT) || [8486, 8460].includes(HUB_PORT)) throw new Error('those are the live ports');
const MGR = `http://127.0.0.1:${MGR_PORT}`;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const keep = argv.includes('--keep');
const T = mkdtempSync('/tmp/tg-approve-verify-');
const SHOTS = join(T, 'shots');
mkdirSync(SHOTS);
mkdirSync(join(T, 'mgr'));
mkdirSync(join(T, 'no-page'));
const CAMERA = join(T, 'camera.y4m');

const { fakeControl } = (await import(join(ACC, 'extractors/telegram/src/fake.ts'))) as { fakeControl: (dir: string, cmd: Record<string, unknown>) => Promise<any> };
const { encode } = (await import(Bun.resolveSync('uqr', join(REPO, 'packages/web')))) as { encode: (text: string, o?: { border?: number }) => { data: boolean[][] } };

const NOT_SIGNED_IN = 'Telegram is not signed in on this account yet: sign in first';
const NOT_A_SIGN_IN = 'That is not a Telegram sign-in code. On the other device, choose to log in by QR code, and scan the code it shows.';
const EXPIRED = 'That code has expired: show a new one on the other device';

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' && !ok ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const until = async (f: () => unknown, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await f()) return true;
    } catch {}
    await Bun.sleep(150);
  }
  console.log(`     (gave up waiting for ${what})`);
  return false;
};
const json = (base: string, path: string, body?: unknown) =>
  fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
const stopProc = async (p: Subprocess | null) => {
  if (!p || p.exitCode !== null) return;
  p.kill('SIGTERM');
  const killer = setTimeout(() => p.kill('SIGKILL'), 10_000);
  await p.exited;
  clearTimeout(killer);
};

/** A QR code, black on white with its quiet zone, as rows of grey levels. */
function qrPicture(text: string, w: number, h: number): Uint8Array {
  const m = encode(text, { border: 0 }).data;
  const n = m.length + 8;
  const scale = Math.floor((Math.min(w, h) * 0.7) / n);
  const x0 = Math.floor((w - n * scale) / 2) + 4 * scale;
  const y0 = Math.floor((h - n * scale) / 2) + 4 * scale;
  const px = new Uint8Array(w * h).fill(235);
  for (let y = y0 - 4 * scale; y < y0 + (n - 4) * scale; y++) for (let x = x0 - 4 * scale; x < x0 + (n - 4) * scale; x++) px[y * w + x] = 255;
  m.forEach((row, r) => row.forEach((dark, c) => {
    if (!dark) return;
    for (let y = 0; y < scale; y++) px.fill(16, (y0 + r * scale + y) * w + x0 + c * scale, (y0 + r * scale + y) * w + x0 + (c + 1) * scale);
  }));
  return px;
}
/** What Chromium's fake camera shows (--use-file-for-fake-video-capture): a Y4M file, read again by each getUserMedia. */
function showOnCamera(text: string) {
  const [w, h] = [640, 480];
  const y = qrPicture(text, w, h);
  const uv = new Uint8Array((w / 2) * (h / 2)).fill(128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv, uv]);
  writeFileSync(CAMERA, Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]));
}
/** A 24-bit BMP of a QR code, for "Choose a picture of the code". */
function bmpOf(text: string, path: string) {
  const [w, h] = [360, 360];
  const px = qrPicture(text, w, h);
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * h, 34);
  for (let yy = 0; yy < h; yy++) for (let x = 0; x < w; x++) buf.fill(px[(h - 1 - yy) * w + x], 54 + yy * row + x * 3, 54 + yy * row + x * 3 + 3);
  writeFileSync(path, buf);
}

let mgr: Subprocess | null = null;
let hub: Subprocess | null = null;
let browser: Awaited<ReturnType<typeof launch>> | null = null;
try {
  console.log(`     workdir ${T}`);
  console.log(`     dither-accounts ${ACC} (${Bun.spawnSync(['git', '-C', ACC, 'log', '-1', '--format=%h %s']).stdout.toString().trim()})`);
  mgr = Bun.spawn(['bun', 'packages/manager/src/main.ts', '--data', join(T, 'mgr'), '--port', String(MGR_PORT), '--host', '127.0.0.1', '--web-dist', join(T, 'no-page')], {
    cwd: ACC,
    env: { ...process.env, TELEGRAM_FAKE: '1' },
    stdout: Bun.file(join(T, 'manager.log')),
    stderr: Bun.file(join(T, 'manager.err')),
  });
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), `a throwaway manager with the fake Telegram on ${MGR_PORT}`);
  const hubEnv: Record<string, string | undefined> = { ...process.env, DITHER_DATA: undefined, DITHER_PORT: undefined, DITHER_PUBLIC_URL: undefined, DITHER_ACCOUNTS_URL: MGR, DITHER_ACCOUNTS_CLIENT: join(ACC, 'packages/client/src/index.ts'), DITHER_CALENDAR_URL: 'off' };
  hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--data', join(T, 'hub'), '--port', String(HUB_PORT), '--host', '127.0.0.1', '--web', WEB], {
    cwd: REPO,
    env: hubEnv as Record<string, string>,
    stdout: Bun.file(join(T, 'hub.log')),
    stderr: Bun.file(join(T, 'hub.err')),
  });
  check(await until(async () => (await fetch(`${HUB}/api/health`)).ok, 30_000, 'the hub'), `a throwaway hub in remote mode on ${HUB_PORT}`);
  await until(async () => (await json(MGR, '/api/state')).apps.some((a: any) => a.name === 'dither-chat' && a.requests.length >= 2), 15_000, 'the hub registered');
  const app = (await json(MGR, '/api/state')).apps.find((a: any) => a.name === 'dither-chat');
  for (const r of app.requests.filter((r: any) => r.state === 'pending')) await fetch(`${MGR}/api/requests/${r.id}/approve`, { method: 'POST', headers: { origin: MGR }, body: '{}' });
  check(app.requests.length >= 2, "the hub's requests approved on the manager", app.requests.map((r: any) => r.interface));

  const added = await json(HUB, '/api/accounts', { network: 'telegram', label: 'fake telegram', config: {}, secret: {} });
  const id = added.id as string;
  check(!!id, 'a Telegram account added through the hub', added);
  const account = async () => (await json(HUB, '/api/bootstrap')).accounts.find((a: any) => a.id === id);
  check(await until(async () => (await account())?.attention?.kind === 'link_device', 30_000, 'its QR code'), 'it waits for its sign-in QR code');
  const dir = (await json(MGR, '/api/state')).accounts.find((a: any) => a.id === id)?.dir ?? join(T, 'mgr/accounts', id);
  const fake = (cmd: Record<string, unknown>) => fakeControl(dir, cmd);
  const act = (action: string, args?: unknown) => json(HUB, `/api/accounts/${id}/action`, { action, ...(args ? { args } : {}) });
  const accepted = async (since: number) => ((await fake({ op: 'calls', since })) as { method: string }[]).filter((c) => c.method === 'auth.acceptLoginToken').length;

  // ---------------------------------------------------------------- 1. before sign-in
  check((await act('sessions')).error === NOT_SIGNED_IN, 'before sign-in, sessions says to sign in first', await act('sessions'));
  showOnCamera('https://example.com/not-a-sign-in');
  browser = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAMERA}`] });
  let p: Page = browser.page;
  await p.size(1280, 860);
  await p.goto(`${HUB}/#/accounts/${id}`);
  await p.until(`!!document.querySelector('.tg-signins')`, 20_000);
  check(
    await p.eval(`(() => { const b = [...document.querySelectorAll('.tg-signins button')].find((x) => x.textContent.includes('Approve a sign-in')); return b && b.disabled && !!document.querySelector('.tg-offline'); })()`),
    'before sign-in, "Approve a sign-in" is there but off, and says why',
  );

  // ---------------------------------------------------------------- 2. the devices list
  await fake({ op: 'scan' });
  check(await until(async () => (await account())?.status === 'online', 30_000, 'online'), 'the fake phone scans its QR code: online');
  await p.until(`document.querySelectorAll('.tg-session').length >= 3`, 15_000);
  const rows = await p.eval<{ hash: string; text: string; signOut: boolean; badge: string | null }[]>(
    `[...document.querySelectorAll('.tg-session')].map((li) => ({ hash: li.dataset.hash, text: li.querySelector('.tg-session-main').innerText.replace(/\\s+/g, ' '), signOut: [...li.querySelectorAll('button')].some((b) => b.textContent === 'Sign out'), badge: li.querySelector('.tg-badge')?.textContent ?? null }))`,
  );
  console.log(rows.map((r) => `     | ${r.hash.padStart(20)}  ${r.text}${r.badge ? `  [${r.badge}]` : ''}${r.signOut ? '  (sign out)' : ''}`).join('\n'));
  const listed = (await act('sessions')).result.sessions as any[];
  check(JSON.stringify(rows.map((r) => r.hash)) === JSON.stringify(listed.map((s) => s.hash)), 'the rows are in the order sessions gives (this one first, then by last active)');
  check(rows[0]?.hash === '0' && rows[0].badge === 'This hub' && !rows[0].signOut && rows[0].text.includes('active now'), 'this hub\'s own session is first, marked "This hub", with no sign-out');
  const neg = rows.find((r) => r.hash.startsWith('-'));
  check(neg && neg.signOut && listed.some((s) => s.hash === neg.hash), `a negative hash stays the exact string (${neg?.hash}), with a sign-out`);
  const noRegion = listed.find((s) => !s.current && !s.region);
  const noRegionRow = rows.find((r) => r.hash === noRegion?.hash);
  check(noRegionRow && noRegionRow.text.includes(`${noRegion.country} · active`) && !/null|undefined|, ·|^, /.test(noRegionRow.text), `an empty region shows just the country: "${noRegionRow?.text}"`);
  check(rows.every((r) => !/\b(\d{1,3}\.){3}\d{1,3}\b/.test(r.text)), 'no IP anywhere');
  check(rows.every((r) => r.hash === '0' || /active (now|\d+[mh]|\w{3}|\w{3} \d+)$/.test(r.text)), 'every row says when it was last active');
  await p.shot(join(SHOTS, '01-devices.png'));
  // Someone signing in elsewhere by phone number: Telegram's code arrives as a message here, so no phone app is needed.
  await fake({ op: 'loginCode', code: '73914' });
  check(await until(async () => (await json(HUB, '/api/search?q=73914')).hits?.length > 0, 15_000, 'the login code'), "a login code from Telegram's service account (777000) arrives as a message");

  // ---------------------------------------------------------------- 3. the scanner
  const openScanner = async () => {
    await p.eval(`[...document.querySelectorAll('.tg-signins button')].find((x) => x.textContent.includes('Approve a sign-in')).click()`);
    await p.until(`!!document.querySelector('.tg-approve')`, 5000);
  };
  const closeScanner = async () => {
    await p.eval(`document.querySelector('.modal-head button[aria-label="Close"]').click()`);
    await p.until(`!document.querySelector('.tg-approve')`, 5000);
    await Bun.sleep(400);
  };
  const stepNow = () => p.eval<string>(`document.querySelector('.tg-approve')?.dataset.step ?? ''`);
  const holdTrack = () => p.eval(`(() => { const v = document.querySelector('.tg-camera video'); window.__track = v?.srcObject?.getVideoTracks?.()[0] ?? null; return !!window.__track; })()`);
  const trackEnded = () => p.eval<boolean>(`!!window.__track && window.__track.readyState === 'ended'`);
  const paste = async (text: string) => {
    await p.eval(`(() => { const i = document.querySelector('#tg-link'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await Bun.sleep(80);
    await p.eval(`document.querySelector('.tg-paste button[type=submit]').click()`);
  };
  const approveButton = `[...document.querySelectorAll('.tg-confirm button')].find((b) => b.textContent.includes('Approve the sign-in'))`;
  const clickText = (scope: string, text: string) => p.eval(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find((b) => b.textContent.includes(${JSON.stringify(text)})).click()`);

  await openScanner();
  check(await until(() => p.eval(`document.querySelector('.tg-camera')?.dataset.camera === 'on'`), 10_000, 'the camera'), 'the scanner turns the camera on');
  const decoder = await p.eval<string>(`document.querySelector('.tg-camera').dataset.decoder`);
  check(['jsqr', 'native'].includes(decoder), `codes are read by ${decoder === 'native' ? "the browser's BarcodeDetector" : 'jsQR (no BarcodeDetector in this browser)'}`);
  check(await until(async () => (await p.eval(`document.querySelector('.tg-refused')?.textContent`)) === NOT_A_SIGN_IN, 10_000, 'the refusal'), 'a QR code that is not a sign-in, read by the camera: "That is not a Telegram sign-in code…"');
  check((await stepNow()) === 'scan', 'and the scanner stays on scanning');
  await p.shot(join(SHOTS, '02-scanner.png'));
  // The page hides: the camera goes off, and comes back with the page.
  await holdTrack();
  await p.eval(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); })()`);
  check(await until(trackEnded, 3000, 'the camera off'), 'the page hidden: the camera stops');
  await p.eval(`(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); })()`);
  check(await until(() => p.eval(`document.querySelector('.tg-camera')?.dataset.camera === 'on'`), 10_000, 'the camera back'), 'the page shown again: the camera comes back');

  // ---------------------------------------------------------------- 4. a pasted link: the warning, then approving
  await holdTrack();
  await paste('https://t.me/+notASignIn');
  await Bun.sleep(300);
  check((await stepNow()) === 'scan', 'a pasted link that is not tg://login?token= goes no further');
  const link = (await fake({ op: 'loginToken' })).link as string;
  const before = Date.now();
  await paste(link);
  await p.until(`document.querySelector('.tg-approve')?.dataset.step === 'confirm'`, 3000);
  check(await p.eval(`${approveButton}.disabled`), 'the warning shows with the approve button not yet armed (a second, deliberate press)');
  check(await until(trackEnded, 3000, 'the camera off'), 'a code read: the camera stops');
  const warning = await p.eval<string>(`document.querySelector('.tg-confirm').innerText`);
  check(warning.includes('Only approve a code your own device is showing you') && warning.includes('Anyone who gets you to scan their code gets your Telegram account'), 'the warning says plainly whose code to approve and what a stranger\'s gets them');
  check(/There is no undo for about 2[34] hours/.test(warning), `a freshly signed-in account says there is no undo for a day: "${warning.match(/There is no undo[^.]*\./)?.[0]}"`);
  const warnSize = await p.eval<number>(`parseFloat(getComputedStyle(document.querySelector('.tg-confirm p')).fontSize)`);
  check(warnSize >= 14, `the warning is not small print (${warnSize}px)`);
  await p.shot(join(SHOTS, '03-warning.png'));
  check(await until(() => p.eval(`!${approveButton}.disabled`), 3000, 'armed'), 'the approve button arms after a moment');
  check((await accepted(before)) === 0, 'nothing is approved until it is pressed');
  await p.eval(`${approveButton}.click()`);
  await p.until(`document.querySelector('.tg-approve')?.dataset.step === 'approved'`, 15_000);
  check((await accepted(before)) === 1, 'pressed once: approved once');
  const shown = await p.eval<string>(`document.querySelector('.tg-approved').innerText.replace(/\\s+/g, ' ')`);
  check(shown.includes('Chrome 131, Linux') && shown.includes('Telegram Web 2.2 K · Web') && shown.includes('Utrecht, Netherlands'), `the new session: device, app and place: "${shown.slice(0, 120)}"`);
  await p.shot(join(SHOTS, '04-approved.png'));

  // ---------------------------------------------------------------- 5. "That wasn't me"
  await clickText('.tg-approved', "That wasn't me");
  await p.until(`!!document.querySelector('.tg-approved .tg-error')`, 15_000);
  const tooNew = await p.eval<string>(`document.querySelector('.tg-approved .tg-error').textContent`);
  check(tooNew.startsWith('Telegram does not let a session that is less than a day old end other sessions') && /It can in about \d+ hours/.test(tooNew), `refused while this hub's session is under a day old, in Telegram's words: "${tooNew.slice(0, 90)}…"`);
  await p.shot(join(SHOTS, '05-too-new.png'));
  await fake({ op: 'ageSession', hours: 25 });
  await clickText('.tg-approved', "That wasn't me");
  check(await until(() => p.eval(`document.querySelector('.tg-approved-head')?.textContent.includes('Signed out again.')`), 15_000, 'signed out'), "a day on, \"That wasn't me\" signs it out");
  check(!(await act('sessions')).result.sessions.some((s: any) => s.device === 'Chrome 131, Linux'), 'and it is gone from the sessions');
  await clickText('.tg-approved', 'Done');
  await p.until(`!document.querySelector('.tg-approve')`, 5000);
  await Bun.sleep(400);
  check(await until(async () => (await p.eval<number>(`document.querySelectorAll('.tg-session').length`)) === 3, 8000, 'the list'), 'the devices list is back to three');

  // ---------------------------------------------------------------- 6. errors as they come; the camera; a picture
  await openScanner();
  await paste((await fake({ op: 'loginToken', ttlMs: 0 })).link);
  await p.until(`document.querySelector('.tg-approve')?.dataset.step === 'confirm'`, 3000);
  await until(() => p.eval(`!${approveButton}.disabled`), 3000, 'armed');
  await p.eval(`${approveButton}.click()`);
  await p.until(`document.querySelector('.tg-approve')?.dataset.step === 'failed'`, 15_000);
  const expired = await p.eval<string>(`document.querySelector('.tg-approve .tg-error').textContent`);
  check(expired === EXPIRED, `an expired code: "${expired}"`);
  await p.shot(join(SHOTS, '06-expired.png'));
  await clickText('.tg-approve', 'Scan another code');
  check((await stepNow()) === 'scan', '"Scan another code" goes back to the scanner');
  await closeScanner();

  const camLink = (await fake({ op: 'loginToken', device: 'Pixel 9', platform: 'Android', app: 'Telegram Android', appVersion: '11.4', country: 'Germany', region: '' })).link as string;
  showOnCamera(camLink);
  const camStart = Date.now();
  await openScanner();
  check(await until(async () => (await stepNow()) === 'confirm', 15_000, 'the camera read'), 'the camera reads a sign-in code from the fake camera: the warning');
  await Bun.sleep(2500);
  check((await stepNow()) === 'confirm' && (await accepted(camStart)) === 0, 'and waits there: a scan never approves by itself');
  check(await p.eval(`!document.querySelector('.tg-camera video')`), 'the camera is off while the warning shows');
  await p.eval(`${approveButton}.click()`);
  await p.until(`document.querySelector('.tg-approve')?.dataset.step === 'approved'`, 15_000);
  const camShown = await p.eval<string>(`document.querySelector('.tg-approved').innerText.replace(/\\s+/g, ' ')`);
  check(camShown.includes('Pixel 9') && camShown.includes('Place Germany') && !camShown.includes(', Germany'), `approved from the camera; an empty region shows just the country: "${camShown.slice(0, 100)}"`);
  await clickText('.tg-approved', "That wasn't me");
  check(await until(() => p.eval(`document.querySelector('.tg-approved-head')?.textContent.includes('Signed out again.')`), 15_000, 'signed out'), 'and signed out again');
  await closeScanner();

  showOnCamera('https://example.com/not-a-sign-in');
  await openScanner();
  const picture = join(T, 'code.bmp');
  bmpOf((await fake({ op: 'loginToken' })).link, picture);
  const { root } = await p.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await p.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.tg-picture input[type=file]' });
  await p.send('DOM.setFileInputFiles', { nodeId, files: [picture] });
  check(await until(async () => (await stepNow()) === 'confirm', 8000, 'the picture read'), '"Choose a picture of the code": a picture of a sign-in code leads to the warning');
  await clickText('.tg-confirm', 'Cancel');
  check((await stepNow()) === 'scan', 'Cancel goes back to scanning');
  await until(() => p.eval(`document.querySelector('.tg-camera')?.dataset.camera === 'on'`), 10_000, 'the camera');
  await holdTrack();
  await closeScanner();
  check(await trackEnded(), 'closing the scanner stops the camera');

  // ---------------------------------------------------------------- 7. a row's sign-out; the camera refused
  const negRow = `document.querySelector('.tg-session[data-hash="${neg?.hash}"]')`;
  await p.eval(`[...${negRow}.querySelectorAll('button')].find((b) => b.textContent === 'Sign out').click()`);
  check(await p.eval(`${negRow}.querySelector('.tg-session-ask')?.textContent.includes('Sign it out?')`), 'a row\'s "Sign out" asks first');
  await p.shot(join(SHOTS, '07-row-confirm.png'));
  await p.eval(`[...${negRow}.querySelectorAll('button')].find((b) => b.textContent === 'Keep').click()`);
  check(await p.eval(`!${negRow}.querySelector('.tg-session-ask')`), '"Keep" keeps it');
  await p.eval(`[...${negRow}.querySelectorAll('button')].find((b) => b.textContent === 'Sign out').click()`);
  await p.eval(`[...${negRow}.querySelectorAll('.tg-session-ask button')].find((b) => b.textContent === 'Sign out').click()`);
  check(await until(() => p.eval(`!${negRow}`), 10_000, 'the row gone'), 'confirmed: the session with the negative hash is signed out and its row goes');
  check(!(await act('sessions')).result.sessions.some((s: any) => s.hash === neg?.hash), 'and Telegram (the fake) no longer lists it');

  // ---------------------------------------------------------------- 8. a phone, both themes
  await p.size(390, 844, true);
  for (const theme of ['dark', 'light']) {
    await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: '${theme}' }))`);
    await p.goto(`${HUB}/#/accounts/${id}`);
    await p.eval(`location.reload()`);
    await p.until(`document.querySelectorAll('.tg-session').length >= 2`, 20_000);
    await Bun.sleep(500);
    check((await p.eval(`document.documentElement.dataset.theme`)) === theme, `390 px, ${theme} theme`);
    const pane = await overflowThrough(p, '.account-scroll');
    check(!pane.length, `${theme}: the account page has no sideways overflow`, pane);
    await p.eval(`document.querySelector('.tg-signins').scrollIntoView()`);
    await Bun.sleep(200);
    await p.shot(join(SHOTS, `09-phone-${theme}-devices.png`));
    await p.eval(`[...document.querySelector('.tg-session:not(.current)').querySelectorAll('button')].find((b) => b.textContent === 'Sign out').click()`);
    await Bun.sleep(150);
    const asking = await overflow(p);
    check(!asking.length, `${theme}: a row asking "Sign it out?" fits`, asking);
    await p.eval(`[...document.querySelector('.tg-session-ask').querySelectorAll('button')].find((b) => b.textContent === 'Keep').click()`);
    await openScanner();
    await Bun.sleep(1200);
    const scan = await overflow(p);
    check(!scan.length, `${theme}: the scanner fits`, scan);
    await p.shot(join(SHOTS, `10-phone-${theme}-scanner.png`));
    await paste((await fake({ op: 'loginToken', device: 'A device with a very long name that goes on and on, Linux x86_64', app: 'Telegram Desktop', appVersion: '5.8.3 x64', country: 'Netherlands', region: 'North Holland' })).link);
    await p.until(`document.querySelector('.tg-approve')?.dataset.step === 'confirm'`, 3000);
    await Bun.sleep(300);
    const warn = await overflow(p);
    check(!warn.length, `${theme}: the warning fits`, warn);
    await p.shot(join(SHOTS, `11-phone-${theme}-warning.png`));
    await until(() => p.eval(`!${approveButton}.disabled`), 3000, 'armed');
    await p.eval(`${approveButton}.click()`);
    await p.until(`document.querySelector('.tg-approve')?.dataset.step === 'approved'`, 15_000);
    await Bun.sleep(300);
    const done = await overflow(p);
    check(!done.length, `${theme}: the approved session, with a long device name, fits`, done);
    await p.shot(join(SHOTS, `12-phone-${theme}-approved.png`));
    await clickText('.tg-approved', "That wasn't me");
    await until(() => p.eval(`document.querySelector('.tg-approved-head')?.textContent.includes('Signed out again.')`), 15_000, 'signed out');
    await closeScanner();
  }

  const errors = p.errors.filter((e) => !/status of 500/.test(e));
  check(!errors.length, `no page errors besides the refusals' 500s${errors.length ? ': ' + errors.join(' | ') : ''}`);

  // ---------------------------------------------------------------- 9. the camera refused
  // A browser of its own: the fake camera's auto-accept wins over a permission set to denied. Without it, headless
  // Chromium refuses the camera as a person's "Block" would; the permission is set to denied as well.
  await browser.close();
  browser = await launch({ args: ['--use-fake-device-for-media-stream'] });
  p = browser.page;
  await p.size(390, 844, true);
  await browserSend(browser.port, 'Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin: HUB });
  await p.goto(`${HUB}/#/accounts/${id}`);
  await p.until(`document.querySelectorAll('.tg-session').length >= 2`, 20_000);
  await openScanner();
  check(await until(() => p.eval(`document.querySelector('.tg-camera')?.dataset.camera === 'denied'`), 8000, 'denied'), 'the camera refused: the scanner says so');
  const deniedText = await p.eval<string>(`document.querySelector('.tg-camera-problem')?.textContent ?? ''`);
  check(deniedText.startsWith('The camera is not allowed here.') && deniedText.includes('paste the link below'), `in words: "${deniedText}"`);
  const refusedFits = await overflow(p);
  check(!refusedFits.length, 'and it fits at 390 px', refusedFits);
  await p.shot(join(SHOTS, '13-phone-camera-refused.png'));
  await paste((await fake({ op: 'loginToken' })).link);
  check(await until(async () => (await stepNow()) === 'confirm', 3000, 'confirm'), 'the paste field still works');
  await closeScanner();
  const errors2 = p.errors.filter((e) => !/status of 500/.test(e));
  check(!errors2.length, `no page errors there either${errors2.length ? ': ' + errors2.join(' | ') : ''}`);
} catch (e) {
  failures++;
  console.log('FAIL ', e);
  await browser?.page.shot(join(SHOTS, 'failure.png')).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  await stopProc(hub);
  await stopProc(mgr);
  if (keep) console.log(`     kept ${T}`);
  else rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

/** One command on the browser's own DevTools endpoint (Browser.* is not served on a page's). */
async function browserSend(port: number, method: string, params: unknown): Promise<any> {
  const { webSocketDebuggerUrl } = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, no) => ((ws.onopen = ok), (ws.onerror = no)));
  try {
    return await new Promise((ok, no) => {
      ws.onmessage = (m) => {
        const r = JSON.parse(String(m.data));
        if (r.id === 1) r.error ? no(new Error(r.error.message)) : ok(r.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

/** Anything in view that scrolls sideways or runs past the right edge (as verify-phone.ts checks), except what is meant to. */
function overflow(p: Page): Promise<string[]> {
  return p.eval(`(() => {
    const W = innerWidth, out = [], sideways = 'pre, code, .log-view, .detail-dump';
    if (document.scrollingElement.scrollWidth > W + 1) out.push('document ' + document.scrollingElement.scrollWidth);
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.left >= W || r.right <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const name = (el.className && typeof el.className === 'string' ? el.className : el.tagName).trim();
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && !el.matches(sideways)) out.push(name + ' scrolls sideways by ' + (el.scrollWidth - el.clientWidth));
      if (r.right <= W + 1 || cs.position === 'fixed') continue;
      let fine = false;
      for (let q = el; q && q !== document.body; q = q.parentElement) {
        const qs = getComputedStyle(q);
        if (qs.transform !== 'none' || (q !== el && q.matches(sideways)) || qs.textOverflow === 'ellipsis') { fine = true; break; }
      }
      if (!fine) out.push(name + ' right=' + Math.round(r.right));
    }
    return [...new Set(out)].slice(0, 8);
  })()`);
}
async function overflowThrough(p: Page, scroller: string): Promise<string[]> {
  const n = await p.eval<number>(`(() => { const el = document.querySelector(${JSON.stringify(scroller)}); return el ? Math.ceil((el.scrollHeight - el.clientHeight) / (el.clientHeight * 0.8)) : -1; })()`);
  if (n < 0) return [`no ${scroller}`];
  const found = new Set<string>();
  for (let i = 0; i <= n; i++) {
    await p.eval(`(() => { const el = document.querySelector(${JSON.stringify(scroller)}); el.scrollTop = ${i} * el.clientHeight * 0.8; })()`);
    await Bun.sleep(60);
    for (const o of await overflow(p)) found.add(o);
  }
  return [...found];
}
