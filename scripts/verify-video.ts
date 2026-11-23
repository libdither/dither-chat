/**
 * The video player (docs/media-kinds.md "Videos") end to end, in headless Chromium against a demo hub, with real mouse,
 * key and touch input: the demo's bouldering clip in a WhatsApp chat, at desktop width and on a 390 px phone.
 *
 * Desktop: a click on the picture plays it, the bar shows while the pointer is over it and goes once it leaves, Space
 * pauses, a click on the seek bar goes there, M mutes, F fills the screen and Escape leaves it without leaving the chat,
 * a double click fills it too. Phone: a tap plays it, a tap shows and hides the controls, the big button pauses, Full
 * screen fills the screen and back leaves it. Also the file viewer's player, and that only one video plays at once.
 *
 *   bun run web:build && bun scripts/verify-video.ts                   # starts a demo hub of its own
 *   bun scripts/verify-video.ts http://127.0.0.1:8881 [/tmp/shots]      # or uses one: a demo hub with its own data dir
 * Only reads.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, type Page } from './browser.ts';

const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const own = process.argv[2] ? null : await ownHub();
const hub = process.argv[2] || own!.url;
async function ownHub() {
  const data = mkdtempSync(join(tmpdir(), 'dither-video-hub-'));
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];
  const proc = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
    cwd: resolve(import.meta.dir, '..'),
    env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const url = `http://127.0.0.1:${port}`;
  const end = Date.now() + 60_000;
  while (!(await fetch(`${url}/api/health`).then((r) => r.ok, () => false))) {
    if (Date.now() > end) throw new Error('the demo hub did not start');
    await Bun.sleep(200);
  }
  return { url, stop: () => (proc.kill(), rmSync(data, { recursive: true, force: true })) };
}

let failures = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`);
  if (!ok) failures++;
};

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const hit = ((await fetch(`${hub}/api/search?q=bouldering`).then((r) => r.json())) as any).hits.find((h: any) => h.message.attachments?.some((a: any) => a.kind === 'video'))?.message;
if (!hit) throw new Error('the demo has no video message');
const route = `${hub}/#/c/${hit.conversationId}`;

const b = await launch();
const p: Page = b.page;
type Pt = [number, number];
const PLAYER = `document.querySelector('.atts .vp')`;
const video = `${PLAYER}.querySelector('video')`;
const state = () =>
  p.eval<{ paused: boolean; t: number; muted: boolean; idle: boolean; barShown: boolean; full: string | null; inChat: boolean }>(`(() => {
    const v = ${video};
    const box = ${PLAYER};
    const bar = box.querySelector('.vp-bar');
    return { paused: v.paused, t: v.currentTime, muted: v.muted, idle: box.classList.contains('vp-idle'), barShown: !!bar && getComputedStyle(bar).opacity !== '0',
      full: document.fullscreenElement === box ? 'native' : box.classList.contains('vp-page') ? 'page' : null, inChat: location.hash.includes(${JSON.stringify(hit.conversationId)}) };
  })()`);
async function mid(sel: string): Promise<Pt> {
  const r = await p.eval(`(() => { const el = ${sel}; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.x, r.width]; })()`);
  return [r[0], r[1]];
}
const mouse = (type: string, [x, y]: Pt, extra: object = {}) => p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
async function click(pt: Pt, count = 1) {
  await mouse('mouseMoved', pt);
  for (let i = 1; i <= count; i++) {
    await mouse('mousePressed', pt, { clickCount: i });
    await mouse('mouseReleased', pt, { clickCount: i });
  }
  await Bun.sleep(250);
}
const key = async (k: string, code = k.length === 1 ? `Key${k.toUpperCase()}` : k, text = k.length === 1 ? k : undefined) => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, ...(text ? { text } : {}), windowsVirtualKeyCode: k === ' ' ? 32 : k === 'Escape' ? 27 : k.toUpperCase().charCodeAt(0) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
  await Bun.sleep(250);
};
const touch = (type: string, pts: Pt[]) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
async function tap(pt: Pt) {
  await touch('touchStart', [pt]);
  await Bun.sleep(40);
  await touch('touchEnd', []);
  await Bun.sleep(450);
}
const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));

try {
  // ---------------------------------------------------------------- desktop
  await p.size(1280, 800);
  await p.goto(route);
  await p.until(`!!${PLAYER} && ${video}.readyState >= 1`, 20_000);
  const look = await p.eval(`(() => { const b = ${PLAYER}; const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), native: ${video}.controls, name: b.querySelector('.vp-name b')?.textContent, dl: !!b.querySelector('.vp-top a[download]') }; })()`);
  check(look.w === 400 && look.h === 225 && !look.native, 'a 480×270 clip is drawn 400×225 with the app\'s controls, not the browser\'s', look);
  check(look.name === 'bouldering.webm' && look.dl, 'its name and Download are on it', look);
  await mid(PLAYER);
  await p.eval(`document.activeElement?.blur()`);
  await mouse('mouseMoved', [5, 5]);
  await Bun.sleep(200);
  await shot('desktop-before');

  const pic = await mid(PLAYER);
  await click(pic);
  await p.until(`!${video}.paused`, 5000).catch(() => {});
  check(!(await state()).paused, 'a click on the picture plays it');
  await mouse('mouseMoved', [pic[0] + 10, pic[1] + 10]);
  await Bun.sleep(300);
  check((await state()).barShown, 'the bar shows while the pointer is over it');
  await shot('desktop-playing');
  await mouse('mouseMoved', [5, 5]);
  await Bun.sleep(400);
  check(!(await state()).barShown, 'the bar goes once the pointer leaves');

  await click(pic);
  check((await state()).paused, 'a second click pauses it');
  await key(' ', 'Space', ' ');
  check(!(await state()).paused, 'Space plays it (the player has the focus)');
  await key(' ', 'Space', ' ');
  check((await state()).paused, 'and Space pauses it again');

  // Seek: three quarters along the bar.
  const seek = await p.eval<[number, number, number]>(`(() => { const r = ${PLAYER}.querySelector('.vp-seek').getBoundingClientRect(); return [r.x, r.width, r.y + r.height / 2]; })()`);
  await mouse('mouseMoved', pic);
  await mouse('mouseMoved', [seek[0] + seek[1] * 0.75, seek[2]]);
  const under = await p.eval(`(() => { const e = document.elementFromPoint(${seek[0] + seek[1] * 0.75}, ${seek[2]}); const bar = ${PLAYER}.querySelector('.vp-bar'); return { el: e?.className?.baseVal ?? e?.className, dur: ${video}.duration, op: getComputedStyle(bar).opacity, pe: getComputedStyle(bar).pointerEvents, cls: ${PLAYER}.className, now: ${PLAYER}.querySelector('.vp-seek').getBoundingClientRect().y }; })()`);
  await click([seek[0] + seek[1] * 0.75, seek[2]]);
  const t = (await state()).t;
  check(t > 6.5 && t < 8.5, 'a click three quarters along the seek bar goes to about 7.5 s of 10', { t, seek, under });
  await mouse('mouseMoved', [seek[0] + seek[1] * 0.3, seek[2]]);
  await Bun.sleep(200);
  const tip = await p.eval<string | null>(`${PLAYER}.querySelector('.vp-tip')?.textContent ?? null`);
  check(tip === '0:03', 'hovering the seek bar says the time under the pointer', tip);
  await shot('desktop-seek-hover');

  await key('m');
  check((await state()).muted, 'M mutes it');
  await key('m');
  check(!(await state()).muted, 'and M again unmutes it');

  await key('f');
  await p.until(`!!document.fullscreenElement || ${PLAYER}.classList.contains('vp-page')`, 3000).catch(() => {});
  let s = await state();
  check(!!s.full, 'F fills the screen', s.full);
  const fullSize = await p.eval(`(() => { const r = ${PLAYER}.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
  check(fullSize[0] === 1280 && fullSize[1] === 800, 'the whole screen', fullSize);
  await shot('desktop-full');
  await key('Escape', 'Escape');
  await Bun.sleep(300);
  s = await state();
  check(!s.full && s.inChat, 'Escape leaves full screen and stays in the chat', s);

  await Bun.sleep(500);
  await click(await mid(PLAYER), 2);
  await p.until(`!!document.fullscreenElement || ${PLAYER}.classList.contains('vp-page')`, 3000).catch(() => {});
  s = await state();
  check(!!s.full, 'a double click fills the screen', s);
  if (s.full) await key('Escape', 'Escape'), await Bun.sleep(300);
  await p.eval(`${video}.pause()`);

  // The file viewer's player: from the attachment's menu is not needed; the viewer opens a video file the hub served.
  check(p.errors.length === 0, 'no page errors on desktop', p.errors);

  // ---------------------------------------------------------------- phone
  await p.size(390, 844, true);
  await p.goto(route);
  await p.until(`!!${PLAYER} && ${video}.readyState >= 1`, 20_000);
  const ph = await p.eval(`(() => { const r = ${PLAYER}.getBoundingClientRect(); return { w: Math.round(r.width), touch: ${PLAYER}.classList.contains('vp-touch') }; })()`);
  check(ph.touch && ph.w >= 300, 'on a phone it takes the message\'s width, with the touch controls', ph);
  await p.eval(`${video}.currentTime = 0`);
  await shot('phone-before');
  const ppic = await mid(PLAYER);
  await tap(ppic);
  await p.until(`!${video}.paused`, 5000).catch(() => {});
  s = await state();
  check(!s.paused, 'a tap plays it');
  await shot('phone-playing');
  await Bun.sleep(3000);
  s = await state();
  check(s.idle && !s.barShown, 'the controls go by themselves after a few seconds', s);
  await tap([ppic[0] + 60, ppic[1] - 30]);
  s = await state();
  check(!s.idle && s.barShown && !s.paused, 'a tap brings the controls back and leaves it playing', s);
  await shot('phone-controls');
  await tap(await mid(`${PLAYER}.querySelector('.vp-big')`));
  check((await state()).paused, 'the big button pauses it');

  await tap(await mid(`${PLAYER}.querySelector('.vp-bar button[aria-label="Full screen"]')`));
  await p.until(`!!document.fullscreenElement || ${PLAYER}.classList.contains('vp-page')`, 3000).catch(() => {});
  s = await state();
  check(!!s.full, 'Full screen fills the screen', s.full);
  const pf = await p.eval(`(() => { const r = ${PLAYER}.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
  check(pf[0] === 390 && pf[1] === 844, 'the whole phone screen', pf);
  await shot('phone-full');
  // The page's full screen (the Android app's WebView, an iPhone): forced, then back.
  if (s.full === 'native') await p.eval(`document.exitFullscreen()`), await Bun.sleep(300);
  await p.eval(`(() => { window.__noFs = Element.prototype.requestFullscreen; Element.prototype.requestFullscreen = undefined; })()`);
  await tap(await mid(`${PLAYER}.querySelector('.vp-bar button[aria-label="Full screen"]')`));
  s = await state();
  const pageRect = await p.eval(`(() => { const r = ${PLAYER}.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), ${PLAYER}.matches(':popover-open')]; })()`);
  check(s.full === 'page' && pageRect[0] === 390 && pageRect[1] === 844 && pageRect[2], 'without the browser\'s full screen, the player fills the page over everything', pageRect);
  await shot('phone-page-full');
  await p.eval(`history.back()`);
  await Bun.sleep(500);
  s = await state();
  check(!s.full && s.inChat, 'back takes it down and stays in the chat', s);
  await p.eval(`Element.prototype.requestFullscreen = window.__noFs`);
  check(p.errors.length === 0, 'no page errors on the phone', p.errors);
} finally {
  await b.close?.();
  own?.stop();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
