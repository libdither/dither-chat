/**
 * Attaching on a phone (docs/uploads.md, "On a phone"), in a 390x844 touch emulation against a demo hub of its own on
 * a fresh data dir, with Chromium's fake camera (two of them) and its permission prompts answered yes:
 *
 *   - + opens the sheet; Photos & videos asks for image/* and video/*, several at once; a photo and a caption on the
 *     send screen go as exactly one message with the image, its upload begun before send was pressed;
 *   - three photos: the strip, picking one, removing one, × back to the composer with the rest and the caption kept;
 *   - a file over the network's limit says so on the send screen, as the composer does;
 *   - the camera: the rear one first, flip to the other, the shutter's photo to the send screen and sent; held, a
 *     video;
 *   - the camera refused: the system's camera through <input accept="image/*" capture="environment">, at once while
 *     the tap still counts, else from a button; no camera API at all: the same input, from the tap;
 *   - the desktop keeps its paperclip.
 *
 *   bun scripts/verify-attach.ts [--port 8700] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 *
 * Builds the web app unless --web names a build. The file chooser is intercepted and answered over DevTools, as no
 * system picker exists here; on a phone the Android app's or the browser's own picker opens instead.
 */
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8700'));
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-attach-${PORT}-`));
mkdirSync(work, { recursive: true });
const shots = opt('shots', '');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
async function until(fn: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}
const getJson = async (path: string) => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<any>;
};

// ------------------------------------------------------------------ test pictures

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** A w×h PNG: a diagonal gradient from one colour to another, so each picture is told apart on screen. */
function png(w: number, h: number, from: number[], to: number[]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      for (let k = 0; k < 3; k++) raw[y * (w * 3 + 1) + 1 + x * 3 + k] = Math.round(from[k] + (to[k] - from[k]) * t);
    }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const files = join(work, 'files');
mkdirSync(files, { recursive: true });
const pics = [
  ['sunrise.png', [255, 140, 60], [120, 40, 160]],
  ['lake.png', [40, 120, 220], [20, 200, 160]],
  ['forest.png', [30, 110, 50], [200, 220, 90]],
  ['dusk.png', [90, 40, 140], [250, 120, 160]],
].map(([name, a, b]) => {
  const p = join(files, name as string);
  writeFileSync(p, png(480, 360, a as number[], b as number[]));
  return p;
});
const big = join(files, 'huge-photo.jpg');
writeFileSync(big, new Uint8Array(11 * 1024 * 1024));

// ------------------------------------------------------------------ the app and the hub

let web = opt('web', '');
if (!web) {
  web = join(work, 'web');
  console.log('building the web app…');
  const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'pipe', stderr: 'pipe' });
  if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
}
if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${PORT}`);
const log = openSync(join(work, 'hub.log'), 'a');
const hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', join(work, 'data'), '--port', String(PORT), '--host', '127.0.0.1', '--web', web], {
  env: { ...process.env, DITHER_DEMO_CHATTER: '0' },
  stdout: log,
  stderr: log,
});
await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
await until(async () => (await getJson('/api/bootstrap')).accounts.every((a: any) => a.status === 'online'), 30_000, 'demo accounts not online');
const boot = await getJson('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const discord = new Set(boot.accounts.filter((a: any) => a.network === 'discord' && a.capabilities.includes('sendMedia')).map((a: any) => a.id));
const conv = boot.conversations.find((c: any) => c.shape === 'direct' && c.network === 'discord' && c.vantages.some((v: any) => discord.has(v.accountId)));
if (!conv) throw new Error('no Discord direct conversation to send in');
/** Our messages here with this text, from the hub. */
const sentWith = async (body: string) => ((await getJson(`/api/conversations/${conv.id}/messages?limit=30`)).messages as any[]).filter((m) => m.body === body);

// Two fake cameras, so there is something to flip to; every camera and microphone prompt answered yes.
const { page, close } = await launch({ args: ['--use-fake-device-for-media-stream=device-count=2', '--use-fake-ui-for-media-stream'] });

// The file chooser, answered here: what it asked for, then the files.
const choosers: { backendNodeId: number; mode: string }[] = [];
page.on('Page.fileChooserOpened', (p) => choosers.push(p));
const uploads: { at: number; url: string }[] = [];
page.on('Network.requestWillBeSent', (p) => p.request.url.includes('/api/uploads/start') && uploads.push({ at: Date.now(), url: p.request.url }));
async function chooser(ms = 5000): Promise<{ backendNodeId: number; mode: string; accept: string; capture: string | null; multiple: boolean }> {
  await until(() => choosers.length > 0, ms, 'a file chooser');
  const c = choosers.shift()!;
  const { object } = await page.send('DOM.resolveNode', { backendNodeId: c.backendNodeId });
  const r = await page.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return { accept: this.accept, capture: this.getAttribute("capture"), multiple: this.multiple }; }', returnByValue: true });
  return { ...c, ...r.result.value };
}
const answer = (c: { backendNodeId: number }, paths: string[]) => page.send('DOM.setFileInputFiles', { files: paths, backendNodeId: c.backendNodeId });

type Pt = [number, number];
const touch = (type: string, pts: Pt[]) => page.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
async function at(sel: string): Promise<Pt> {
  const r = await page.eval<Pt | null>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`);
  if (!r) throw new Error(`nothing matches ${sel}`);
  return r;
}
async function tap(sel: string, holdMs = 40) {
  const p = await at(sel);
  await touch('touchStart', [p]);
  await Bun.sleep(holdMs);
  await touch('touchEnd', []);
  await Bun.sleep(350);
}
const has = (sel: string) => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const count = (sel: string) => page.eval<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const track = (sel: string) => page.eval<string | null>(`document.querySelector(${JSON.stringify(sel)})?.dataset.track ?? null`);
const typeCaption = async (text: string) => {
  await page.eval(`document.querySelector('.send-screen textarea').focus()`);
  await page.send('Input.insertText', { text });
  await Bun.sleep(100);
};
async function openChat() {
  await page.goto(`${base}/#/inbox/c/${conv.id}`);
  await page.until(`!!document.querySelector('.app.phone .composer-row .composer-plus')`, 20000);
  await Bun.sleep(600);
  // Touches reach a new page only once it has a frame.
  for (let i = 0; i < 20; i++) {
    const ok = await page.eval<boolean>(`(() => { window.__t = false; addEventListener('touchstart', () => (window.__t = true), { once: true, capture: true }); return true; })()`);
    await touch('touchStart', [[195, 4]]);
    await touch('touchCancel', []);
    await Bun.sleep(100);
    if (ok && (await page.eval<boolean>('window.__t'))) break;
  }
}

try {
  await page.size(390, 844, true);
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
  await openChat();

  // ------------------------------------------------------------------ the row

  const row = await page.eval<string[]>(`[...document.querySelector('.composer-row').children].map((e) => e.className.split(' ').filter(Boolean)[e.classList.contains('composer-box') ? 0 : e.classList.length - 1])`);
  check('the row reads [+] [box] [send]', row.join() === 'composer-plus,composer-box,send-btn', row);
  check('…with the camera inside the box, on its right', await page.eval(`document.querySelector('.composer-box').lastElementChild.classList.contains('composer-camera')`));
  check('counted as composer: plus and composer: camera', (await track('.composer-plus')) === 'plus' && (await track('.composer-camera')) === 'camera' && (await page.eval(`document.querySelector('.composer').dataset.trackArea`)) === 'composer');
  // The box at its cap, for a look at the row with a long draft.
  await page.eval(`document.querySelector('.composer textarea').focus()`);
  await page.send('Input.insertText', { text: Array.from({ length: 14 }, (_, i) => `line ${i + 1}: a long message, typed on a phone, to see where the box stops`).join('\n') });
  await Bun.sleep(200);
  const capped = await page.eval<{ h: number; line: number }>(`(() => { const t = document.querySelector('.composer textarea'); return { h: t.getBoundingClientRect().height, line: parseFloat(getComputedStyle(t).lineHeight) }; })()`);
  check('a long draft stops at five lines in the new row', Math.abs((capped.h - 16) / capped.line - 5) < 0.3, capped);
  if (shots) await page.shot(join(shots, 'composer-long-text-at-cap.png'));
  await page.eval(`(() => { const t = document.querySelector('.composer textarea'); t.select(); document.execCommand('delete'); t.blur(); })()`);
  await Bun.sleep(200);

  // ------------------------------------------------------------------ + → Photos & videos → one photo → send

  await tap('.composer-plus');
  await page.until(`!!document.querySelector('.attach-sheet')`, 3000);
  const items = await page.eval<string[]>(`[...document.querySelectorAll('.attach-sheet [data-track]')].map((e) => e.closest('[data-track-area]').dataset.trackArea + ': ' + e.dataset.track)`);
  check('+ opens the sheet: Photos & videos, File', items.join() === 'attach: photos,attach: file', items);
  if (shots) await page.shot(join(shots, 'plus-sheet.png'));
  uploads.length = 0;
  await tap('.attach-sheet [data-track=photos]');
  let c = await chooser();
  check('Photos & videos asks for photos and videos, several at once', c.accept === 'image/*,video/*' && c.multiple && c.mode === 'selectMultiple' && !c.capture, c);
  await page.until(`!document.querySelector('.attach-sheet')`, 3000).then(
    () => check('…and the sheet goes as the picker opens', true),
    () => check('…and the sheet goes as the picker opens', false),
  );
  await answer(c, [pics[0]]);
  await page.until(`!!document.querySelector('.send-screen .ss-media')`, 5000);
  check('a picked photo opens the send screen, large', (await page.eval<string>(`document.querySelector('.send-screen .ss-media').tagName`)) === 'IMG');
  check('…its upload already begun', uploads.length === 1, uploads.length);
  const caption = `the sunrise ${Date.now().toString(36)}`;
  await typeCaption(caption);
  check('the caption is the message text: the composer has it too', (await page.eval<string>(`document.querySelector('.composer textarea').value`)) === caption);
  await page.until(`!document.querySelector('.send-screen .send-btn').disabled`, 5000);
  const sendKey = await page.eval<string>(`(() => { const b = document.querySelector('.send-screen .send-btn'); return b.closest('[data-track-area]').dataset.trackArea + ': ' + b.dataset.track; })()`);
  const sendAt = Date.now();
  await tap('.send-screen .send-btn');
  check('the send screen sends with its send button, counted as send screen: send', sendKey === 'send screen: send' && !(await has('.send-screen')), sendKey);
  check('…the photo had started uploading before send was pressed', uploads.length >= 1 && uploads[0].at < sendAt);
  await until(async () => (await sentWith(caption)).length > 0, 15_000, 'the message on the hub').catch(() => {});
  await Bun.sleep(1000);
  let mine = await sentWith(caption);
  check('exactly one message, with the image', mine.length === 1 && mine[0].attachments?.length === 1 && mine[0].attachments[0].name === 'sunrise.png', mine.map((m) => m.attachments?.map((a: any) => a.name)));
  check('the composer is empty again', (await page.eval<string>(`document.querySelector('.composer textarea').value`)) === '' && (await count('.composer-file')) === 0);

  // ------------------------------------------------------------------ three photos: the strip, pick, remove, back

  await tap('.composer-plus');
  await tap('.attach-sheet [data-track=photos]');
  c = await chooser();
  await answer(c, pics.slice(1, 4));
  await page.until(`document.querySelectorAll('.send-screen .ss-thumb').length === 3`, 5000);
  check('three photos: a strip of three, each with a remove', (await count('.send-screen .ss-thumb .ss-remove')) === 3 && (await page.eval<string>(`document.querySelector('.ss-title').textContent`)) === '1 of 3');
  await Bun.sleep(500);
  if (shots) await page.shot(join(shots, 'send-screen-3-photos.png'));
  const first = await page.eval<string>(`document.querySelector('.ss-media').src`);
  await tap('.send-screen .ss-thumb:nth-child(2) .ss-pick');
  check('tapping a thumbnail shows it large', (await page.eval<string>(`document.querySelector('.ss-media').src`)) !== first && (await page.eval<string>(`document.querySelector('.ss-title').textContent`)) === '2 of 3');
  await tap('.send-screen .ss-thumb:nth-child(3) .ss-remove');
  check('remove takes one out', (await count('.send-screen .ss-thumb')) === 2);
  const kept = `two of them ${Date.now().toString(36)}`;
  await typeCaption(kept);
  await tap('.send-screen [data-track=back]');
  check('× goes back to the composer with the files and the text', !(await has('.send-screen')) && (await count('.composer-file')) === 2 && (await page.eval<string>(`document.querySelector('.composer textarea').value`)) === kept);
  await page.until(`[...document.querySelectorAll('.composer-file')].every((e) => e.dataset.status === 'done')`, 10_000).catch(() => {});
  await tap('.composer-row > .send-btn');
  await until(async () => (await sentWith(kept)).length > 0, 15_000, 'the message on the hub').catch(() => {});
  await Bun.sleep(800);
  mine = await sentWith(kept);
  check('…and sent from there, one message with both', mine.length === 1 && mine[0].attachments?.length === 2, mine.map((m) => m.attachments?.map((a: any) => a.name)));

  // ------------------------------------------------------------------ a file over the limit says so

  await tap('.composer-plus');
  await tap('.attach-sheet [data-track=photos]');
  c = await chooser();
  await answer(c, [big]);
  await page.until(`!!document.querySelector('.send-screen')`, 5000);
  const why = await page.eval<string | null>(`document.querySelector('.send-screen .ss-why')?.textContent ?? null`);
  check('a photo over Discord’s limit says so on the send screen', /Over Discord’s 10 MB limit/.test(why ?? ''), why);
  await tap('.send-screen [data-track=back]');
  await page.eval(`document.querySelector('.composer-file button[aria-label^="Remove"]')?.click()`);
  await Bun.sleep(200);

  // ------------------------------------------------------------------ the camera

  uploads.length = 0;
  await tap('.composer-camera');
  await page.until(`(() => { const v = document.querySelector('.cam-video'); return !!v && v.videoWidth > 0; })()`, 8000).then(
    () => check('the camera opens full screen with a picture', true),
    () => check('the camera opens full screen with a picture', false),
  );
  const cam1 = await page.eval<string>(`document.querySelector('.cam-video').srcObject.getVideoTracks()[0].getSettings().deviceId`);
  check('camera controls are counted: shutter, flip, gallery, close', (await track('.cam-shutter')) === 'shutter' && (await track('.cam [aria-label="Switch camera"]')) === 'flip' && (await track('.cam [aria-label="Pick photos or videos instead"]')) === 'photos' && (await track('.cam [aria-label="Close the camera"]')) === 'close' && (await page.eval(`document.querySelector('.cam').dataset.trackArea`)) === 'camera');
  check('no torch on a camera without one', !(await has('.cam [data-track=torch]')));
  await Bun.sleep(300);
  if (shots) await page.shot(join(shots, 'camera.png'));
  await tap('.cam [data-track=flip]');
  await page.until(`(() => { const v = document.querySelector('.cam-video'); return v?.srcObject?.getVideoTracks()[0]?.getSettings().deviceId !== ${JSON.stringify(cam1)} && v.videoWidth > 0; })()`, 6000).then(
    () => check('flip goes to the other camera', true),
    () => check('flip goes to the other camera', false),
  );
  await tap('.cam-shutter');
  await page.until(`!!document.querySelector('.send-screen .ss-media')`, 5000).then(
    () => check('the shutter: a photo, on the send screen', true),
    () => check('the shutter: a photo, on the send screen', false),
  );
  check('…and the camera is off', !(await has('.cam')) && (await page.eval(`!document.querySelector('video.cam-video')`)));
  const photo = await page.eval<string>(`document.querySelector('.send-screen .ss-title').textContent`);
  check('…a JPEG named for when it was taken', /^photo-\d{4}-\d\d-\d\d-\d{6}\.jpg$/.test(photo), photo);
  const shotCaption = `from the camera ${Date.now().toString(36)}`;
  await typeCaption(shotCaption);
  await page.until(`!document.querySelector('.send-screen .send-btn').disabled`, 5000);
  await tap('.send-screen .send-btn');
  await until(async () => (await sentWith(shotCaption)).length > 0, 15_000, 'the photo on the hub').catch(() => {});
  await Bun.sleep(800);
  mine = await sentWith(shotCaption);
  check('the photo goes as one message', mine.length === 1 && mine[0].attachments?.length === 1 && /\.jpg$/.test(mine[0].attachments[0].name) && mine[0].attachments[0].size > 1000, mine.map((m) => m.attachments?.map((a: any) => [a.name, a.size])));

  // Held: a video.
  await tap('.composer-camera');
  await page.until(`(() => { const v = document.querySelector('.cam-video'); return !!v && v.videoWidth > 0; })()`, 8000);
  const sh = await at('.cam-shutter');
  await touch('touchStart', [sh]);
  await page.until(`!!document.querySelector('.cam-rec')`, 4000).then(
    () => check('holding the shutter records, with a clock', true),
    () => check('holding the shutter records, with a clock', false),
  );
  await Bun.sleep(1500);
  await touch('touchEnd', []);
  await page.until(`!!document.querySelector('.send-screen video.ss-media')`, 6000).then(
    () => check('…and letting go puts the video on the send screen', true),
    () => check('…and letting go puts the video on the send screen', false),
  );
  const clip = `a clip ${Date.now().toString(36)}`;
  if (await has('.send-screen textarea')) {
    await typeCaption(clip);
    await page.until(`!document.querySelector('.send-screen .send-btn').disabled`, 8000).catch(() => {});
    await tap('.send-screen .send-btn');
    await until(async () => (await sentWith(clip)).length > 0, 15_000, 'the video on the hub').catch(() => {});
    await Bun.sleep(800);
    mine = await sentWith(clip);
    check('the video goes as one message', mine.length === 1 && /\.(mp4|webm)$/.test(mine[0].attachments?.[0]?.name ?? '') && mine[0].attachments[0].size > 1000, mine.map((m) => m.attachments?.map((a: any) => [a.name, a.size])));
  }

  // The gallery beside the shutter: the camera goes, the photo picker opens.
  await tap('.composer-camera');
  await page.until(`!!document.querySelector('.cam [data-track=photos]')`, 8000);
  await tap('.cam [data-track=photos]');
  c = await chooser().catch(() => null as any);
  check('the gallery beside the shutter opens the photo picker, and the camera goes', !!c && c.accept === 'image/*,video/*' && !(await has('.cam')), c);
  check('…and nothing holds the camera', await page.eval(`!document.querySelector('video.cam-video')`));

  // ------------------------------------------------------------------ the camera refused, or missing

  await page.eval(`navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))`);
  await tap('.composer-camera');
  c = await chooser().catch(() => null as any);
  check('refused: the system camera at once, from the same tap', !!c && c.accept === 'image/*' && c.capture === 'environment' && !c.multiple, c);
  check('…and no camera screen left behind', !(await has('.cam')));
  if (c) {
    await answer(c, [pics[0]]);
    await page.until(`!!document.querySelector('.send-screen .ss-media')`, 5000).then(
      () => check('…whose photo goes to the send screen', true),
      () => check('…whose photo goes to the send screen', false),
    );
    await tap('.send-screen [data-track=back]');
    await page.eval(`document.querySelector('.composer-file button[aria-label^="Remove"], .composer-file button[aria-label^="Cancel"]')?.click()`);
    await Bun.sleep(200);
  }
  // Refused after the tap stopped counting (a prompt answered slowly): a button asks the system camera.
  await page.eval(`Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => ({ isActive: false, hasBeenActive: true }) })`);
  await tap('.composer-camera');
  await page.until(`!!document.querySelector('.cam-failed')`, 4000).then(
    () => check('refused later: the camera screen says so, with a button', true),
    () => check('refused later: the camera screen says so, with a button', false),
  );
  if (await has('.cam-failed button')) {
    await tap('.cam-failed button');
    c = await chooser().catch(() => null as any);
    check('…which opens the system camera', !!c && c.capture === 'environment', c);
  }
  await page.eval(`delete navigator.userActivation`);
  // No camera API at all (an old browser, plain HTTP): the system camera from the tap, no camera screen.
  await page.eval(`Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => undefined })`);
  await tap('.composer-camera');
  c = await chooser().catch(() => null as any);
  check('no camera API: the system camera from the tap', !!c && c.capture === 'environment' && !(await has('.cam')), c);

  // ------------------------------------------------------------------ the desktop

  await page.size(1280, 800);
  await page.goto(`${base}/#/inbox/c/${conv.id}`);
  await page.until(`!!document.querySelector('.composer textarea')`, 20000);
  await Bun.sleep(500);
  check('the desktop has its paperclip or + menu, and no phone + or camera', ((await has('.composer-box .attach-btn')) || (await has('.composer-box .composer-plus-menu'))) && !(await has('.composer-plus')) && !(await has('.composer-camera')));

  const errors = page.errors.filter((e) => !/WebSocket connection|Failed to load resource|File chooser dialog can only be shown/.test(e));
  check('no script errors', !errors.length, errors);
} catch (e) {
  failed++;
  console.log('FAIL  ', e);
  if (shots) await page.shot(join(shots, 'verify-attach-failure.png')).catch(() => {});
} finally {
  await close();
  hub.kill('SIGTERM');
  await hub.exited;
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
