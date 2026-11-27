/**
 * The call window on a demo hub (docs/calls.md "The video window"), in headless Chromium with fake devices and the
 * demo call room as the far end. One device joins the libdither voice channel, turns its camera on and watches the
 * room bot's Go Live; then, through the window's own menu, pointer and keys:
 *
 * - a tile is a person (their camera, else their picture with its ring) or a shared screen;
 * - the layout button opens the menu: radios with one tab stop a row and the arrow keys, Auto first; Escape closes it;
 * - Grid → Speaker moves every tile (the same elements) and someone else's tile fills the window; your camera to a
 *   corner makes it a small inset, dragged to another corner it settles there; Hidden takes it away, Tile brings it back;
 * - a click on a tile shows it big at once, another puts it back, and neither is kept as a choice; Enter does the same;
 * - Full screen takes the whole window, its captions, your inset and the call's buttons;
 * - dragging moves the window and it stays on screen; the corner resizes it and its height fits the tiles; the grip
 *   moves it by keys; the menu opens upward near the bottom;
 * - dropped at the top of the call's chat it docks in the chat's slot under the header (the header and its buttons
 *   above it, the messages below); the divider takes the arrow keys; on another page it floats; Fill takes the chat's
 *   page and crops cameras (never screens); dragged down it floats again;
 * - the choices are kept on this device, and a call ending mid-drag leaves nothing behind;
 * - on a phone it starts as Speaker, docked under the header with the call's buttons on it (no dock strip), small
 *   enough to leave the chat room, and on another page the call bar takes its place.
 *
 *   bun packages/hub/src/main.ts --demo --host 127.0.0.1 --data /tmp/x --port 8579 --web packages/web/dist
 *   bun scripts/verify-call-window.ts http://127.0.0.1:8579 [--shots <dir>]
 *
 * --shots saves screenshots of each layout. Use a fresh demo world each run.
 */
import { launch, type Page } from './browser.ts';

const args = process.argv.slice(2);
const hub = (args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--shots') ?? 'http://127.0.0.1:8579').replace(/\/$/, '');
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const MAIN = 'acc_demo-discord-main';
const ALT = 'acc_demo-discord-alt';

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const voice = boot.conversations.find((c: any) => c.variant === 'voice' && c.vantages.some((v: any) => v.accountId === MAIN) && c.vantages.some((v: any) => v.accountId === ALT));
if (!voice) throw new Error('no voice channel both demo Discord accounts see');
const other = boot.conversations.find((c: any) => c.id !== voice.id && c.variant !== 'voice' && c.variant !== 'stage' && c.vantages.some((v: any) => v.accountId === MAIN));

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const wait = async (p: Page, expr: string, ms = 15_000) => p.until(expr, ms).then(() => true, () => false);
/** The dock's line of connection numbers can carry a network address: never in a screenshot. */
const shoot = async (p: Page, name: string) => {
  if (!shots) return;
  await p.eval(`document.getElementById('no-stats') || document.head.insertAdjacentHTML('beforeend', '<style id="no-stats">.call-stats { display: none !important }</style>')`);
  await p.shot(`${shots}/${name}.png`);
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
  // The dock's buttons, or on a phone the window's once there is video (the dock's strip steps aside for them).
  await p.eval(`document.querySelector('[data-track="call camera"]').click()`);
  const details = `(document.querySelector('.call-dock-title') ?? document.querySelector('[data-track="call window: people"]')).click()`;
  await p.eval(details);
  await wait(p, `!!document.querySelector('[data-track="watch stream"]')`, 10_000);
  await p.eval(`[...document.querySelectorAll('.call-people li')].find((li) => /Lev/.test(li.textContent))?.querySelector('[data-track="watch stream"]')?.click()`);
  await p.eval(details);
  check(await wait(p, `[...document.querySelectorAll('.call-video video')].filter((v) => v.videoWidth > 0).length >= 3`, 20_000), `${account}: three videos play (the bot's camera and Go Live, and your own)`, await p.eval(`[...document.querySelectorAll('.call-video')].map((f) => f.textContent)`));
}

type R = { x: number; y: number; w: number; h: number };
/** Each tile's rectangle on screen, once every one has stopped moving. */
async function rects(p: Page): Promise<Record<string, R>> {
  const read = `JSON.stringify(Object.fromEntries([...document.querySelectorAll('.call-video')].map((f) => { const r = f.getBoundingClientRect(); return [f.dataset.tile, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }]; })))`;
  let last = '';
  for (let i = 0; i < 40; i++) {
    const now = await p.eval<string>(read);
    // Settled: no tile, and not the window, is in a transition or an animation.
    if (now === last && (await p.eval(`document.getAnimations().filter((x) => x.effect?.target?.closest?.('.call-videos, .call-slot')).length === 0`))) return JSON.parse(now);
    last = now;
    await p.until(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  }
  return JSON.parse(last);
}
const win = (p: Page) =>
  p.eval<R & { place: string; arrange: string; arranged: string; me: string; parent: string }>(
    `(() => { const w = document.querySelector('.call-videos'); const r = w.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), place: w.dataset.place, arrange: w.dataset.arrange, arranged: w.dataset.arranged, me: w.dataset.me, parent: w.parentElement.parentElement.className }; })()`,
  );
const rectOf = (p: Page, sel: string) => p.eval<R | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
/** Every tile shown lies inside the window: its layout follows the window's size, whatever moved it. */
const tilesInside = (p: Page) =>
  p.eval<boolean>(
    `(() => { const w = document.querySelector('.call-videos').getBoundingClientRect(); return [...document.querySelectorAll('.call-video:not(.hidden)')].every((f) => { const r = f.getBoundingClientRect(); return r.left >= w.left - 1 && r.top >= w.top - 1 && r.right <= w.right + 1 && r.bottom <= w.bottom + 1; }); })()`,
  );
const kept = (p: Page) => p.eval<any>(`JSON.parse(localStorage.getItem('dither-chat:call-window') || '{}')`);
const openMenu = async (p: Page) => {
  if (!(await p.eval(`!!document.querySelector('.call-win-menu')`))) await p.eval(`document.querySelector('.call-win-layout').click()`);
};
const pick = async (p: Page, choice: string) => {
  await openMenu(p);
  await p.eval(`document.querySelector('.call-win-menu [data-choice="${choice}"]').click()`);
};
const closeMenu = (p: Page) => p.eval(`document.querySelector('.call-win-menu') && document.querySelector('.call-win-layout').click()`);
async function key(p: Page, k: string, code = k, vk = 0, shift = false) {
  const mods = shift ? 8 : 0;
  const text = k.length === 1 ? k : undefined;
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, ...(text ? { text } : {}) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
}
const KEYS = { Escape: ['Escape', 27], Enter: ['Enter', 13], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38] } as const;
const press = (p: Page, k: keyof typeof KEYS) => key(p, k, KEYS[k][0], KEYS[k][1]);
/** A real pointer: press at (x, y), move by steps to (x2, y2), let go. */
async function dragMouse(p: Page, x: number, y: number, x2: number, y2: number, release = true) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + ((x2 - x) * i) / 8, y: y + ((y2 - y) * i) / 8, button: 'left', buttons: 1 });
  if (release) await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
}
async function click(p: Page, x: number, y: number) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
const mid = (r: R) => [r.x + r.w / 2, r.y + r.h / 2] as const;
const moved = (x: Record<string, any>, y: Record<string, any>) => Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
const go = async (p: Page, hash: string) => {
  await p.eval(`location.hash = ${JSON.stringify(hash)}`);
};

try {
  await room.page.goto(`${hub}/demo/callroom.html`);
  check(await wait(room.page, `/Open/.test(document.getElementById('status').textContent)`), 'the call room connects to the hub');

  const p = a.page;
  await p.size(1400, 900);
  await join(p, MAIN);

  // ------------------------------------------------------------ tiles are people
  const people = await p.eval<number>(`document.querySelectorAll('.call-people li, .call-dock [data-who]').length`);
  const tiles = await p.eval<{ id: string; who?: string; video: boolean; face: boolean }[]>(`[...document.querySelectorAll('.call-video')].map((f) => ({ id: f.dataset.tile, who: f.dataset.who, video: !!f.querySelector('video'), face: !!f.querySelector('.call-av') }))`);
  check(tiles.filter((t) => t.id.startsWith('p:')).length >= 2 && tiles.some((t) => t.id.startsWith('s:')), "a tile for each person in the call and one for the bot's Go Live", { people, tiles });
  check(tiles.every((t) => t.video !== t.face), "each tile is a camera or the person's picture", tiles);
  const mine = tiles.find((t) => t.id.startsWith('p:') && t.video && t.who && t.who === tiles.find((x) => x.id.startsWith('p:') && x.video)?.who);
  const selfId = await p.eval<string>(`document.querySelector('.call-video.self').dataset.tile`);
  check(!!selfId && selfId.startsWith('p:') && !!mine, 'your own tile is you, with your camera', selfId);

  // ------------------------------------------------------------ the menu
  check(await p.eval(`!document.querySelector('.call-win-menu')`), 'the menu starts closed');
  await p.eval(`document.querySelector('.call-win-layout').click()`);
  check(await wait(p, `!!document.querySelector('.call-win-menu') && document.querySelector('.call-win-layout').getAttribute('aria-expanded') === 'true'`, 2000), 'the layout button opens the menu');
  check(await p.eval(`document.querySelectorAll('.call-win-menu [role=radiogroup]').length === 3 && [...document.querySelectorAll('.call-win-menu [role=radiogroup]')].every((g) => g.querySelectorAll('[aria-checked=true]').length === 1 && g.querySelectorAll('[tabindex="0"]').length === 1)`), 'three rows of choices, one checked and one tab stop in each');
  check(await p.eval(`[...document.querySelectorAll('.call-win-menu [role=radiogroup]')][0].querySelector('[data-choice]').dataset.choice === 'auto' && document.querySelector('.call-win-menu [data-choice=auto]').getAttribute('aria-checked') === 'true'`), 'Arrange starts on Auto, its first choice');
  check(await wait(p, `document.activeElement?.dataset.choice === 'auto'`, 2000), 'the checked choice has focus');
  await press(p, 'ArrowRight');
  check(await wait(p, `document.activeElement?.dataset.choice === 'grid' && document.activeElement.getAttribute('aria-checked') === 'true'`, 2000), 'the arrow keys move through a row and choose');
  await press(p, 'ArrowLeft');
  check(await wait(p, `document.querySelector('.call-win-menu [data-choice=auto]').getAttribute('aria-checked') === 'true'`, 2000) && !(await kept(p)).arrange, 'back to Auto: nothing kept for Arrange', await kept(p));
  await press(p, 'Escape');
  check(await wait(p, `!document.querySelector('.call-win-menu') && document.activeElement === document.querySelector('.call-win-layout')`, 2000), 'Escape closes the menu and gives focus back to its button');

  // ------------------------------------------------------------ arrangements
  await pick(p, 'grid');
  await pick(p, 'tile');
  await pick(p, 'float');
  await closeMenu(p);
  const grid = await rects(p);
  const ids = Object.keys(grid);
  check(ids.length >= 3 && new Set(ids.map((k) => `${grid[k].w}x${grid[k].h}`)).size === 1, 'Grid: equal tiles', grid);
  await shoot(p, 'grid');
  const els = await p.eval(`(window.__tileEls = [...document.querySelectorAll('.call-video')]).length`);
  await pick(p, 'speaker');
  const speaker = await rects(p);
  check(moved(grid, speaker).length === ids.length, 'Speaker moves every tile', speaker);
  const W = await win(p);
  const big = ids.filter((k) => speaker[k].w > W.w - 40);
  check(big.length === 1 && big[0] !== selfId && big[0] !== 'my-screen', "Speaker: one tile fills the window, and it isn't yours", { big, selfId });
  check(await p.eval(`window.__tileEls.every((el) => el.isConnected) && document.querySelectorAll('.call-video').length === ${els}`), 'the same tile elements moved (no remount)');
  await pick(p, 'corner');
  const corner = await rects(p);
  check(corner[selfId].w < 200 && (await p.eval(`document.querySelector('.call-video.self').classList.contains('inset')`)), 'your camera in the corner is a small inset', corner[selfId]);
  await click(p, 1, 1);
  check(await wait(p, `!document.querySelector('.call-win-menu')`, 2000), 'a press outside closes the menu');
  await shoot(p, 'speaker-corner');

  // The inset dragged to the other side settles in the nearest corner.
  const w0 = await win(p);
  // Measured again: a screenshot (--shots) hides the stats, which moves the inset from where it was measured above.
  const [ix, iy] = mid((await rects(p))[selfId]);
  await dragMouse(p, ix, iy, w0.x + 60, iy);
  const after = await rects(p);
  check(after[selfId].x < w0.x + 40 && (await kept(p)).corner === 'bl', 'the inset dragged left snaps to the bottom-left corner', after[selfId]);

  await pick(p, 'off');
  check(await wait(p, `document.querySelector('.call-video.self').classList.contains('hidden') && getComputedStyle(document.querySelector('.call-video.self')).opacity === '0'`, 3000), 'Hidden takes your camera away');
  await pick(p, 'tile');
  await pick(p, 'grid');
  await closeMenu(p);

  // ------------------------------------------------------------ a click shows a tile big
  const g2 = await rects(p);
  const pickOther = ids.find((k) => k !== selfId && k.startsWith('p:'))!;
  await click(p, ...mid(g2[pickOther]));
  check(await p.eval(`document.querySelector('[data-tile="${pickOther}"]').classList.contains('pinned')`), 'a click shows the tile big at once (no wait for a double-click)');
  const focusedR = await rects(p);
  const W2 = await win(p);
  check(focusedR[pickOther].w > W2.w - 40 && (await p.eval(`!!document.querySelector('.call-video.pinned .call-video-pin') && document.querySelector('.call-video.pinned').getAttribute('aria-pressed') === 'true' && /shown big/.test(document.querySelector('.call-video.pinned').getAttribute('aria-label'))`)), 'big, with a mark a screen reader hears too', focusedR[pickOther]);
  check((await kept(p)).arrange === 'grid' && W2.arranged === 'grid', 'showing a tile big is not kept as a choice', await kept(p));
  await shoot(p, 'focused');
  await click(p, ...mid(focusedR[pickOther]));
  await rects(p);
  check((await p.eval(`!document.querySelector('.call-video.pinned')`)) && (await kept(p)).arrange === 'grid', 'another click puts it back, and Grid is still the choice');
  check(await p.eval(`!document.fullscreenElement`), 'a click does not go full screen');
  // By keys: Tab to a tile, Enter.
  await p.eval(`document.querySelector('[data-tile="${pickOther}"]').focus()`);
  await press(p, 'Enter');
  check(await wait(p, `document.querySelector('[data-tile="${pickOther}"]').classList.contains('pinned')`, 2000), 'Enter on a tile shows it big');
  await press(p, 'Enter');
  check(await wait(p, `!document.querySelector('.call-video.pinned')`, 2000), 'Enter again puts it back');

  // ------------------------------------------------------------ full screen
  await pick(p, 'corner');
  await closeMenu(p);
  await p.eval(`document.querySelector('.call-videos').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
  const fb = await rectOf(p, '[data-track="call video full screen"]');
  await click(p, ...mid(fb!));
  const fullOk = await wait(p, `document.fullscreenElement === document.querySelector('.call-videos')`, 3000);
  check(fullOk, 'Full screen takes the whole window');
  if (fullOk) {
    await rects(p);
    check(await p.eval(`!!document.querySelector('.call-videos.full .call-win-controls .call-btn.leave') && !!document.querySelector('.call-videos.full .call-video.inset') && !!document.querySelector('.call-videos.full figcaption')`), 'in full screen: the call buttons, your inset and the captions');
    await shoot(p, 'full-screen');
    await p.eval(`document.exitFullscreen()`);
    check(await wait(p, `!document.fullscreenElement && !document.querySelector('.call-videos.full')`, 3000), 'and back');
  }
  await pick(p, 'tile');
  await closeMenu(p);

  // ------------------------------------------------------------ moving, resizing, the menu's side
  const f0 = await win(p);
  // It first opens at the top right, under the chat's header (callLayout.ts defaultFloat).
  const head0 = (await rectOf(p, '.conv-head'))!;
  check(f0.y >= head0.y + head0.h && f0.y <= head0.y + head0.h + 24 && f0.x + f0.w >= 1400 - 40, 'the window first opens at the top right, under the header, clear of the newest messages', { f0, head0 });
  await dragMouse(p, f0.x + 40, f0.y + 40, f0.x - 200, f0.y + 140);
  await rects(p);
  const f1 = await win(p);
  check(Math.abs(f1.x - (f0.x - 240)) <= 2 && Math.abs(f1.y - (f0.y + 100)) <= 2, 'dragging the window moves it', { f0, f1 });
  await dragMouse(p, f1.x + 40, f1.y + 40, 1399, 899);
  await rects(p);
  const f2 = await win(p);
  check(f2.x + f2.w <= 1400 && f2.y + f2.h <= 900, 'it stays on screen', f2);
  await openMenu(p);
  const menu = await rectOf(p, '.call-win-menu');
  check(!!menu && menu.y >= 0 && menu.y + menu.h <= 900 && (await p.eval(`document.querySelector('.call-win-menu').classList.contains('up')`)), 'near the bottom the menu opens upward, on screen', menu);
  await closeMenu(p);
  await dragMouse(p, f2.x + f2.w - 6, f2.y + f2.h - 6, f2.x + f2.w - 206, f2.y + f2.h - 6);
  await rects(p);
  const f3 = await win(p);
  const g3 = await rects(p);
  const aspects = Object.values(g3).map((r) => r.w / r.h);
  check(f3.w === f2.w - 200 && aspects.every((x) => Math.abs(x - 16 / 9) < 0.08), 'the corner resizes it, and its height fits the tiles (16:9, no bars)', { f2, f3, aspects });
  await p.eval(`document.querySelector('.call-win-grip').focus()`);
  await press(p, 'ArrowLeft');
  await press(p, 'ArrowUp');
  await rects(p);
  const f4 = await win(p);
  check(f4.x === f3.x - 24 && f4.y === f3.y - 24, 'the grip moves it by the arrow keys', { f3, f4 });

  // ------------------------------------------------------------ docking in the chat's slot
  const line = (await rectOf(p, '.call-slot'))!;
  const head = (await rectOf(p, '.conv-head'))!;
  check(line.h === 0 && Math.abs(line.y - (head.y + head.h)) <= 1, "floating, the call's chat keeps a mark under its header where it docks", { line, head });
  await dragMouse(p, f4.x + 40, f4.y + 40, f4.x + 40, f4.y + 40 + (line.y - f4.y));
  await rects(p);
  const d = await win(p);
  const head1 = (await rectOf(p, '.conv-head'))!;
  const timeline = (await rectOf(p, '.pane .timeline, .pane [class*="timeline"]'))!;
  check(d.place === 'dock' && d.parent.includes('call-slot'), "dropped at the top of the call's chat, it docks in the chat's slot", d);
  check(d.y >= head1.y + head1.h - 1 && Math.abs(d.y - (head1.y + head1.h)) <= 1, 'docked under the header, its buttons free', { d, head1 });
  check(!!timeline && timeline.y >= d.y + d.h - 1, 'the messages are below it', { d, timeline });
  check(await tilesInside(p), 'docked, every tile is inside the window');
  await shoot(p, 'docked');
  // The divider: arrows, and a drag.
  check(await p.eval(`(() => { const s = document.querySelector('.call-win-split'); return s.tabIndex === 0 && +s.getAttribute('aria-valuenow') > 0 && +s.getAttribute('aria-valuemax') > 0; })()`), 'the divider is a separator with a value, in the tab order');
  await p.eval(`document.querySelector('.call-win-split').focus()`);
  await press(p, 'ArrowDown');
  await rects(p);
  const d1 = await win(p);
  check(d1.h === d.h + 24, 'the arrow keys make the docked window taller', { d, d1 });
  await dragMouse(p, d1.x + d1.w / 2, d1.y + d1.h, d1.x + d1.w / 2, d1.y + d1.h + 200);
  await rects(p);
  const d2 = await win(p);
  const aspects2 = Object.values(await rects(p)).map((r) => r.w / r.h);
  check(d2.h > d1.h && aspects2.every((x) => Math.abs(x - 16 / 9) < 0.08), 'dragging the divider sets its height, fitted to the tiles', { d1, d2, aspects2 });

  // Another page: the window steps down to floating, and no chat but the call's has a slot.
  if (other) {
    await go(p, `#/inbox/c/${other.id}`);
    check(await wait(p, `document.querySelector('.call-videos')?.dataset.place === 'float' && !document.querySelector('.call-slot')`, 5000), 'on another chat it floats, docked nowhere', await win(p));
    await go(p, `#/inbox/c/${voice.id}`);
    check(await wait(p, `document.querySelector('.call-videos')?.dataset.place === 'dock' && !!document.querySelector('.call-slot .call-videos')`, 5000), "back on the call's chat it docks again");
  }

  // Fill: the chat's page, cameras cropped, screens not.
  await pick(p, 'fill');
  await closeMenu(p);
  await rects(p);
  const fill = await win(p);
  const pane = (await rectOf(p, '.app > .center'))!;
  check(fill.place === 'fill' && fill.h > pane.h - head1.h - 40 && (await p.eval(`!document.querySelector('.pane .composer, .pane textarea')`)), "Fill takes the chat's page under its header", { fill, pane });
  check(
    await p.eval(`[...document.querySelectorAll('.call-video:not(.inset)')].every((f) => { const v = f.querySelector('video'); const r = f.getBoundingClientRect(); return (!v || getComputedStyle(v).objectFit === 'contain') && r.width / r.height <= 16 / 9 + 0.01 && r.width / r.height >= 4 / 3 - 0.01; })`),
    'Fill crops no picture: every tile between 4:3 and 16:9, its video shown whole',
  );
  check(await tilesInside(p), 'filling, every tile is inside the window');
  await shoot(p, 'fill');
  await pick(p, 'dock');
  await closeMenu(p);
  await rects(p);
  const d3 = await win(p);
  await dragMouse(p, d3.x + d3.w / 2, d3.y + 60, d3.x + d3.w / 2, d3.y + 300);
  await rects(p);
  check((await win(p)).place === 'float' && (await p.eval(`!document.querySelector('.call-slot .call-videos')`)), 'dragging the docked window down floats it');
  const k = await kept(p);
  check(k.arrange === 'grid' && k.me === 'tile' && k.place === 'float' && k.float && k.dockH > 0, 'the choices are kept on this device', k);

  // Back as the shots show it: Speaker, you in the corner, Auto in the menu.
  await pick(p, 'auto');
  await pick(p, 'corner');
  await rects(p);
  check(await tilesInside(p), 'floating again, every tile is inside the window');
  await shoot(p, 'menu');
  await closeMenu(p);

  // A call that ends mid-drag leaves no listener behind.
  const f5 = await win(p);
  await dragMouse(p, f5.x + 40, f5.y + 40, f5.x + 100, f5.y + 80, false);
  await p.eval(`document.querySelector('.call-dock .call-btn.leave').click()`);
  check(await wait(p, `!document.querySelector('.call-videos')`, 5000), 'leaving mid-drag takes the window away');
  for (let i = 0; i < 3; i++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300 + i * 10, y: 300, button: 'left', buttons: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 330, y: 300, button: 'left', buttons: 0, clickCount: 1 });
  check(p.errors.length === 0, 'no page errors on the computer', p.errors.slice(0, 3));

  // ------------------------------------------------------------ a phone
  const q = ph.page;
  await q.size(390, 844, true);
  await join(q, ALT);
  await rects(q);
  const w = await win(q);
  const qh = (await rectOf(q, '.conv-head'))!;
  check(w.arrange === 'speaker' && w.me === 'corner' && w.place === 'dock' && w.parent.includes('call-slot') && w.w >= 380, 'a phone starts as Speaker, docked in the chat, you in the corner', w);
  check(w.y >= qh.y + qh.h - 1, 'under the header, its buttons free', { w, qh });
  check(await q.eval(`document.querySelector('.call-dock').getClientRects().length === 0 && !!document.querySelector('.call-win-controls .call-btn.leave')`), "the call's buttons are on the window; no dock strip");
  check(qh.h + w.h <= 844 * 0.4, 'header and video leave most of the screen to the chat', { head: qh.h, video: w.h });
  check(await tilesInside(q), 'on the phone, every tile is inside the window');
  await shoot(q, 'phone');
  await q.eval(`document.querySelector('.call-win-controls [data-track="call window: people"]').click()`);
  check(await wait(q, `document.querySelector('.call-dock.open')?.getClientRects().length > 0`, 3000), "the window's people button opens the call's details");
  await q.eval(`document.querySelector('.call-win-controls [data-track="call window: people"]').click()`);
  await go(q, '#/inbox');
  check(await wait(q, `!document.querySelector('.call-videos') && !!document.querySelector('.call-bar')`, 5000), 'on another page the call bar takes its place');
  await go(q, `#/inbox/c/${voice.id}`);
  check(await wait(q, `!!document.querySelector('.call-slot .call-videos')`, 5000), "back in the call's chat it is docked again");
  check(q.errors.length === 0, 'no page errors on the phone', q.errors.slice(0, 3));
  await q.eval(`document.querySelector('.call-win-controls .call-btn.leave')?.click()`);
} finally {
  for (const x of browsers) await x.close().catch(() => {});
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
