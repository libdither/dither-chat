/**
 * The call's video window on a demo hub (docs/calls.md "The video window"), in headless Chromium with fake devices and
 * the demo call room as the far end. One device joins the libdither voice channel, turns its camera on and watches the
 * room bot's Go Live, so the window holds three videos; then, through the window's own menu and pointer:
 *
 * - the layout button opens the menu, its choices are radios, Escape closes it and gives focus back;
 * - Grid → Speaker moves every tile (the same elements) and one fills the window; your camera to a corner makes it a
 *   small inset, Hidden takes it away, Tile brings it back;
 * - double-clicking a tile pins it big, double-clicking it again goes back to Grid;
 * - dragging the window moves it (and keeps it on screen), the corner resizes it, dragging it to the conversation's top
 *   docks it above the messages (pushing them down), and dragging the docked video down floats it again;
 * - the choices are kept on this device;
 * - on a phone it starts as Speaker, docked at the top, with your camera in a corner.
 *
 *   bun packages/hub/src/main.ts --demo --data /tmp/x --port 8579 --web packages/web/dist
 *   bun scripts/verify-call-window.ts http://127.0.0.1:8579 [--shots <dir>] [--before]
 *
 * --shots saves screenshots of each layout; --before only joins and shoots (for a build without the window).
 * Use a fresh demo world each run.
 */
import { launch, type Page } from './browser.ts';

const args = process.argv.slice(2);
const hub = (args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--shots') ?? 'http://127.0.0.1:8579').replace(/\/$/, '');
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const before = args.includes('--before');
const MAIN = 'acc_demo-discord-main';
const ALT = 'acc_demo-discord-alt';

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const voice = boot.conversations.find((c: any) => c.variant === 'voice' && c.vantages.some((v: any) => v.accountId === MAIN) && c.vantages.some((v: any) => v.accountId === ALT));
if (!voice) throw new Error('no voice channel both demo Discord accounts see');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const wait = async (p: Page, expr: string, ms = 15_000) => p.until(expr, ms).then(() => true, () => false);
const shoot = async (p: Page, name: string) => {
  if (shots) await p.shot(`${shots}/${name}.png`);
};

const MEDIA = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const room = await launch({ args: MEDIA });
const a = await launch({ args: MEDIA });
const ph = await launch({ args: MEDIA });
const browsers = [room, a, ph];

/** A device in the voice channel's chat, joined, its camera on, watching the bot's Go Live. */
async function join(p: Page, account: string) {
  await p.goto(hub);
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), callMode: 'bridge', sendAs: { ${JSON.stringify(voice.id)}: ${JSON.stringify(account)} } }))`);
  await p.goto(`${hub}/?calls=1#/inbox/c/${voice.id}`);
  await p.until(`!!document.querySelector('.call-join')`, 30_000);
  await p.eval(`document.querySelector('.call-join').click()`);
  check(await wait(p, `!!document.querySelector('[data-call-connected]')`, 20_000), `${account}: joins`);
  await p.eval(`document.querySelector('[data-track="call camera"]').click()`);
  await p.eval(`document.querySelector('.call-dock-title').click()`);
  await wait(p, `!!document.querySelector('[data-track="watch stream"]')`, 10_000);
  await p.eval(`[...document.querySelectorAll('.call-people li')].find((li) => /Lev/.test(li.textContent))?.querySelector('[data-track="watch stream"]')?.click()`);
  await p.eval(`document.querySelector('.call-dock-title').click()`);
  check(await wait(p, `[...document.querySelectorAll('.call-video video')].filter((v) => v.videoWidth > 0).length >= 3`, 20_000), `${account}: three videos play (the bot's camera and Go Live, and your own)`, await p.eval(`[...document.querySelectorAll('.call-video')].map((f) => f.textContent)`));
}

/** Each tile's rectangle on screen, once every one has stopped moving. */
async function rects(p: Page): Promise<Record<string, { x: number; y: number; w: number; h: number }>> {
  const read = `JSON.stringify(Object.fromEntries([...document.querySelectorAll('.call-video')].map((f) => { const r = f.getBoundingClientRect(); return [f.dataset.tile, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }]; })))`;
  let last = '';
  for (let i = 0; i < 40; i++) {
    const now = await p.eval<string>(read);
    // Settled: no tile, and not the window, is in a transition.
    if (now === last && (await p.eval(`document.getAnimations().filter((x) => x.effect?.target?.closest?.('.call-videos')).length === 0`))) return JSON.parse(now);
    last = now;
    await p.until(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  }
  return JSON.parse(last);
}
const win = (p: Page) => p.eval<{ x: number; y: number; w: number; h: number; place: string; arrange: string; me: string }>(`(() => { const w = document.querySelector('.call-videos'); const r = w.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), place: w.dataset.place, arrange: w.dataset.arrange, me: w.dataset.me }; })()`);
const pick = async (p: Page, choice: string) => {
  if (!(await p.eval(`!!document.querySelector('.call-win-menu')`))) await p.eval(`document.querySelector('.call-win-btn').click()`);
  await p.eval(`document.querySelector('.call-win-menu [data-choice="${choice}"]').click()`);
};
/** A real pointer: press at (x, y), move by steps to (x2, y2), let go. */
async function dragMouse(p: Page, x: number, y: number, x2: number, y2: number) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + ((x2 - x) * i) / 8, y: y + ((y2 - y) * i) / 8, button: 'left', buttons: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
}
async function dblclick(p: Page, x: number, y: number) {
  for (const clickCount of [1, 2]) {
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
  }
}
const mid = (r: { x: number; y: number; w: number; h: number }) => [r.x + r.w / 2, r.y + r.h / 2] as const;
const moved = (x: Record<string, any>, y: Record<string, any>) => Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));

try {
  await room.page.goto(`${hub}/demo/callroom.html`);
  check(await wait(room.page, `/Open/.test(document.getElementById('status').textContent)`), 'the call room connects to the hub');

  const p = a.page;
  await p.size(1400, 900);
  await join(p, MAIN);
  if (before) {
    await shoot(p, 'before');
  } else {
    // ------------------------------------------------------------ the menu
    check(await p.eval(`!document.querySelector('.call-win-menu')`), 'the menu starts closed');
    await p.eval(`document.querySelector('.call-win-btn').click()`);
    check(await wait(p, `!!document.querySelector('.call-win-menu') && document.querySelector('.call-win-btn').getAttribute('aria-expanded') === 'true'`, 2000), 'the layout button opens the menu');
    check(await p.eval(`document.querySelectorAll('.call-win-menu [role=radiogroup]').length === 3 && document.querySelectorAll('.call-win-menu [role=radio][aria-checked=true]').length === 3`), 'three rows of choices, one checked in each');
    check(await wait(p, `document.activeElement?.getAttribute('aria-checked') === 'true'`, 2000), 'the checked choice has focus');
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    check(await wait(p, `!document.querySelector('.call-win-menu') && document.activeElement === document.querySelector('.call-win-btn')`, 2000), 'Escape closes the menu and gives focus back to its button');

    // ------------------------------------------------------------ arrangements
    await pick(p, 'grid');
    await pick(p, 'tile');
    await pick(p, 'float');
    const grid = await rects(p);
    const ids = Object.keys(grid);
    check(ids.length === 3 && new Set(ids.map((k) => `${grid[k].w}x${grid[k].h}`)).size === 1, 'Grid: three equal tiles', grid);
    await p.eval(`document.querySelector('.call-win-btn').click()`);
    await shoot(p, 'grid');
    const els = await p.eval(`(window.__tileEls = [...document.querySelectorAll('.call-video')]).length`);
    await pick(p, 'speaker');
    const speaker = await rects(p);
    check(moved(grid, speaker).length === 3, 'Speaker moves every tile', speaker);
    const W = await win(p);
    const big = ids.filter((k) => speaker[k].w > W.w - 40);
    check(big.length === 1 && Object.values(speaker).filter((r) => r.h < 100).length === 2, 'Speaker: one tile fills the window, two in the strip', { big, speaker });
    check(await p.eval(`window.__tileEls.every((el) => el.isConnected) && document.querySelectorAll('.call-video').length === ${els}`), 'the same tile elements moved (no remount)');
    await pick(p, 'corner');
    const corner = await rects(p);
    const mine = await p.eval<string>(`document.querySelector('.call-video.self').dataset.tile`);
    check(corner[mine].w < 200 && (await p.eval(`document.querySelector('.call-video.self').classList.contains('inset')`)), 'your camera in the corner is a small inset', corner[mine]);
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', buttons: 1, clickCount: 1 });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', buttons: 0, clickCount: 1 });
    check(await wait(p, `!document.querySelector('.call-win-menu')`, 2000), 'a press outside closes the menu');
    await shoot(p, 'speaker-corner');

    // The inset dragged to the other side settles in the nearest corner.
    const w0 = await win(p);
    const [ix, iy] = mid(corner[mine]);
    await dragMouse(p, ix, iy, w0.x + 60, iy);
    const after = await rects(p);
    check(after[mine].x < w0.x + 40 && (await p.eval(`JSON.parse(localStorage.getItem('dither-chat:call-window')).corner === 'bl'`)), 'the inset dragged left snaps to the bottom-left corner', after[mine]);

    await pick(p, 'off');
    check(await wait(p, `document.querySelector('.call-video.self').classList.contains('hidden') && getComputedStyle(document.querySelector('.call-video.self')).opacity === '0'`, 3000), 'Hidden takes your camera away');
    await pick(p, 'tile');
    await pick(p, 'grid');
    await p.eval(`document.querySelector('.call-win-btn').click()`);

    // ------------------------------------------------------------ pinning
    const g2 = await rects(p);
    const other = ids.find((k) => k !== mine)!;
    await dblclick(p, ...mid(g2[other]));
    const pinned = await rects(p);
    check((await win(p)).arrange === 'speaker' && pinned[other].w > W.w - 40 && (await p.eval(`!!document.querySelector('.call-video.pinned .call-video-pin')`)), 'double-click pins a tile big, with a pin mark', pinned[other]);
    await dblclick(p, ...mid(pinned[other]));
    await rects(p);
    check((await win(p)).arrange === 'grid' && (await p.eval(`!document.querySelector('.call-video.pinned')`)), 'double-click on the pinned one goes back to Grid');
    check(await p.eval(`!document.fullscreenElement`), 'a double-click does not go full screen');

    // ------------------------------------------------------------ moving, resizing, docking
    const f0 = await win(p);
    await dragMouse(p, f0.x + 40, f0.y + 40, f0.x - 200, f0.y - 100);
    await rects(p);
    const f1 = await win(p);
    check(Math.abs(f1.x - (f0.x - 240)) <= 2 && Math.abs(f1.y - (f0.y - 140)) <= 2, 'dragging the video moves the window', { f0, f1 });
    await dragMouse(p, f1.x + 40, f1.y + 40, 1399, 899);
    await rects(p);
    const f2 = await win(p);
    check(f2.x + f2.w <= 1400 && f2.y + f2.h <= 900, 'it stays on screen', f2);
    await dragMouse(p, f2.x + f2.w - 8, f2.y + f2.h - 8, f2.x + f2.w - 208, f2.y + f2.h - 108);
    await rects(p);
    const f3 = await win(p);
    check(f3.w === f2.w - 200 && f3.h === f2.h - 100, 'the corner resizes it', { f2, f3 });
    const pane = await p.eval<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector('.app > .center').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })()`);
    const msg0 = await p.eval<number>(`document.querySelector('.conv-head').getBoundingClientRect().top`);
    await dragMouse(p, f3.x + 40, f3.y + 40, f3.x + 40, pane.y + 4);
    await rects(p);
    const d = await win(p);
    const msg1 = await p.eval<number>(`document.querySelector('.conv-head').getBoundingClientRect().top`);
    check(d.place === 'dock' && d.x === pane.x && d.w === pane.w && d.y === pane.y, 'dragged to the conversation\'s top, it docks across it', { d, pane });
    check(msg1 >= msg0 + d.h - 2, 'docked, it pushes the conversation down', { msg0, msg1 });
    await shoot(p, 'docked');
    // The divider sets its height.
    await dragMouse(p, d.x + d.w / 2, d.y + d.h, d.x + d.w / 2, d.y + d.h + 60);
    await rects(p);
    check((await win(p)).h === d.h + 60, 'the divider makes the docked video taller', await win(p));
    await dragMouse(p, d.x + d.w / 2, d.y + 60, d.x + d.w / 2, d.y + 300);
    await rects(p);
    check((await win(p)).place === 'float', 'dragging the docked video down floats it');
    check(await p.eval(`!document.fullscreenElement`), 'no drag went full screen');
    const kept = await p.eval(`JSON.parse(localStorage.getItem('dither-chat:call-window'))`);
    check(kept.arrange === 'grid' && kept.me === 'tile' && kept.place === 'float' && kept.float && kept.dockH === d.h + 60, 'the choices are kept on this device', kept);

    // Back as the shots show it: Speaker, you in the corner, menu open.
    await pick(p, 'speaker');
    await pick(p, 'corner');
    await rects(p);
    await shoot(p, 'menu');
    await p.eval(`document.querySelector('.call-win-btn').click()`);
    check(p.errors.length === 0, 'no page errors on the computer', p.errors.slice(0, 3));
  }

  // ------------------------------------------------------------ a phone
  const q = ph.page;
  await q.size(390, 844, true);
  await join(q, ALT);
  if (!before) {
    await rects(q);
    const w = await win(q);
    check(w.arrange === 'speaker' && w.me === 'corner' && w.place === 'dock' && w.w >= 380, 'a phone starts as Speaker, docked at the top, you in the corner', w);
    check(q.errors.length === 0, 'no page errors on the phone', q.errors.slice(0, 3));
  }
  await shoot(q, before ? 'before-phone' : 'phone');
  for (const x of [p, q]) await x.eval(`document.querySelector('.call-btn.leave')?.click()`);
} finally {
  for (const x of browsers) await x.close().catch(() => {});
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
