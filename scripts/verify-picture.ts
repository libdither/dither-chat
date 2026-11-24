/**
 * Changing a picture (ui/PictureEditor.tsx, docs/profile.md "Changing a picture"), end to end against a demo hub in
 * headless Chromium: a group's big picture is a button with a camera and opens its menu, View Picture first; someone
 * else's picture opens full screen in the image viewer; a picture dropped on the
 * page opens the editor, which crops it, shows it at three sizes and sends nothing until Save; Save changes it on the
 * network, and Undo in the toast puts the old one back. On your own page, the editor lists each network you may
 * change it on with only one ticked; the account tile's menu ticks that account. The same on a phone.
 *
 *   bun scripts/verify-picture.ts http://127.0.0.1:8497 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this changes pictures.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8497';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const group = boot.conversations.find((c: any) => c.network === 'discord' && c.shape === 'group')?.id;
const self = boot.persons.find((p: any) => p.isSelf)?.id;
// Someone else with a picture: theirs opens full screen.
const other = boot.identities.find((i: any) => i.avatar && i.personId && i.personId !== self)?.personId;
if (!group || !self || !other) throw new Error('the demo world lacks a place this checks');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const where = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  return r;
};
const click = async (sel: string) => {
  const r = await where(sel);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const clickText = async (sel: string, text: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(text)}) && x.getBoundingClientRect().width > 0); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`no ${sel} says ${text}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
/** A phone takes taps, not mouse clicks. */
const tap = async (sel: string) => {
  const r = await where(sel);
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const drag = async (sel: string, dx: number, dy: number) => {
  const r = await where(sel);
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 5; i++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + (dx * i) / 5, y: r.y + (dy * i) / 5, button: 'left', buttons: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + dx, y: r.y + dy, button: 'left', clickCount: 1 });
};
/** A made-up picture (a wide gradient with a sun), dropped on the page as a file is. */
const dropPicture = () =>
  p.eval(`(async () => {
    const c = document.createElement('canvas'); c.width = 900; c.height = 600;
    const g = c.getContext('2d'); const l = g.createLinearGradient(0, 0, 0, 600);
    l.addColorStop(0, '#ff9a6b'); l.addColorStop(0.6, '#c94f7c'); l.addColorStop(1, '#3b2a5a');
    g.fillStyle = l; g.fillRect(0, 0, 900, 600); g.fillStyle = '#ffd75e'; g.beginPath(); g.arc(560, 220, 90, 0, 7); g.fill();
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([b], 'sunset.png', { type: 'image/png' }));
    for (const type of ['dragenter', 'dragover', 'drop']) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
const about = () => fetch(`${hub}/api/conversations/${group}/about`).then((r) => r.json()) as Promise<any>;
const toastSays = (text: string) => p.until(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(${JSON.stringify(text)}))`, 10000);

try {
  await p.size(1280, 860);

  // A group whose picture you may change.
  await p.goto(`${hub}/#/about/c/${group}`);
  await p.until(`!!document.querySelector('.profile-page .pf-avatar-edit')`, 15000);
  check(await p.eval(`!!document.querySelector('.pf-avatar-edit .pf-avatar-badge')`), 'the big picture is a button with a camera on it');
  check(!(await p.eval(`[...document.querySelectorAll('.pf-actions button')].some((b) => b.textContent.includes('Change picture'))`)), 'no Change picture button among the actions any more');
  check(!(await p.eval(`[...document.querySelectorAll('.pf-card')].some((b) => b.textContent.includes('Remove picture'))`)), 'no picture buttons in the Group card');
  const before = (await about()).fields.avatar?.value ?? null;

  await click('.pf-avatar-edit');
  await p.until(`!!document.querySelector('.ctx-menu, .menu, [role="menu"]')`, 3000);
  const items = await p.eval<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`);
  check(items.some((t) => t.includes('Upload a Picture')) && items.some((t) => t.includes('From This Chat')), 'its menu: upload, and this chat’s pictures', items);
  if (shots) await p.shot(`${shots}/group-menu.png`);
  check(!items.some((t) => t.includes('View Picture')), 'no View Picture while it has none', items);
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  await dropPicture();
  await p.until(`!!document.querySelector('.pic-editor .pic-img')`, 5000);
  check(await p.eval(`document.querySelectorAll('.pic-sizes .pic-shown.square').length === 3`), 'the editor shows it at three sizes, square for a group');
  check(((await about()).fields.avatar?.value ?? null) === before, 'nothing is sent before Save');
  const left0 = await p.eval<number>(`parseFloat(document.querySelector('.pic-img').style.left)`);
  await drag('.pic-crop', 60, 0);
  const left1 = await p.eval<number>(`parseFloat(document.querySelector('.pic-img').style.left)`);
  check(left1 > left0, 'dragging moves the picture in the frame', { left0, left1 });
  await drag('.pic-crop', 900, 0);
  check((await p.eval<number>(`parseFloat(document.querySelector('.pic-img').style.left)`)) === 0, 'but never so far that an edge shows');
  if (shots) await p.shot(`${shots}/group-editor.png`);

  await clickText('.pic-foot .btn', 'Save');
  await toastSays('Picture changed');
  const after = (await about()).fields.avatar?.value ?? null;
  check(!!after && after !== before, 'Save changed it on the network', { before, after });
  check(!(await p.eval(`!!document.querySelector('.pic-editor')`)), 'the editor closed');
  await clickText('.toast button, .toast', 'Undo');
  await toastSays('Picture put back');
  const undone = (await about()).fields.avatar?.value ?? null;
  check(undone !== after, 'Undo put the old picture back', { after, undone });

  // Someone else's page: the picture opens full screen, to zoom, and Escape puts it away.
  await p.goto(`${hub}/#/p/${other}`);
  await p.until(`!!document.querySelector('.profile-page .pf-avatar-view')`, 15000);
  check(!(await p.eval(`!!document.querySelector('.profile-page .pf-avatar-edit')`)), 'someone else’s picture has no camera');
  await click('.pf-avatar-view');
  await p.until(`document.querySelector('.viewer .viewer-img')?.naturalWidth > 0`, 3000);
  const shown = await p.eval<string>(`document.querySelector('.viewer .viewer-img').getAttribute('src')`);
  const theirs = await p.eval<string>(`document.querySelector('.pf-avatar-view img')?.getAttribute('src') ?? ''`);
  check(!!shown && shown === theirs, 'clicking their picture opens it full screen', { shown, theirs });
  const box = await p.eval<{ w: number; h: number; W: number; H: number }>(`(() => { const b = document.querySelector('.viewer .viewer-img').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), W: innerWidth, H: innerHeight }; })()`);
  check(box.w >= box.W - 2 || box.h >= box.H - 2, 'filling the screen, though the picture is smaller', box);
  if (shots) await p.shot(`${shots}/other-viewer.png`);
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await p.until(`!document.querySelector('.viewer') && !!document.querySelector('.profile-page .pf-avatar-view')`, 3000);
  check(true, 'Escape closes it, back on their page');

  // Your own page: each network you may change it on, one ticked.
  await p.goto(`${hub}/#/p/${self}`);
  await p.until(`!!document.querySelector('.profile-page .pf-avatar-edit')`, 15000);
  check(!(await p.eval(`[...document.querySelectorAll('.pf-own-row span')].some((s) => s.textContent.startsWith('Picture on'))`)), 'no “Picture on …” rows under the bio any more');
  await dropPicture();
  await p.until(`!!document.querySelector('.pic-editor .pic-img')`, 5000);
  const dests = await p.eval<{ label: string; on: boolean }[]>(`[...document.querySelectorAll('.pic-dest')].map((d) => ({ label: d.textContent.trim(), on: d.querySelector('input').checked }))`);
  check(dests.length > 1 && dests.filter((d) => d.on).length === 1, 'every network you may change it on, one ticked', dests);
  check(await p.eval(`document.querySelectorAll('.pic-sizes .pic-shown:not(.square)').length === 3`), 'round for a person');
  if (shots) await p.shot(`${shots}/self-editor.png`);
  await clickText('.pic-foot .btn', 'Save');
  await toastSays('Picture changed');
  // Now it has one, its menu shows it full screen first.
  await p.until(`!document.querySelector('.pic-editor')`, 3000);
  await click('.pf-avatar-edit');
  await p.until(`!!document.querySelector('[role="menuitem"]')`, 3000);
  const own = await p.eval<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`);
  check(own[0]?.includes('View Picture'), 'View Picture first in the menu', own);
  if (shots) await p.shot(`${shots}/self-menu.png`);
  await clickText('[role="menuitem"]', 'View Picture');
  await p.until(`document.querySelector('.viewer .viewer-img')?.naturalWidth > 0`, 3000);
  check(await p.eval(`document.querySelector('.viewer .viewer-img').getAttribute('src') === document.querySelector('.pf-avatar-edit img')?.getAttribute('src')`), 'View Picture opens it full screen');
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await p.until(`!document.querySelector('.viewer')`, 3000);

  // An account row's Edit opens the editor ticked to that account.
  await p.until(`!!document.querySelector('.pf-acct-list .pf-acct-edit-btn')`, 5000);
  await click('.pf-acct-list .pf-acct-edit-btn');
  await clickText('.pf-acct-edit .btn', 'Change Picture');
  await p.until(`!!document.querySelector('.pic-editor')`, 3000);
  check(await p.eval(`!document.querySelector('.pic-editor .pic-img') && !!document.querySelector('.pic-empty')`), 'from an account tile’s menu: the editor asks for a picture');
  const ticked = await p.eval<string[]>(`[...document.querySelectorAll('.pic-dest')].filter((d) => d.querySelector('input').checked).map((d) => d.textContent.trim())`);
  check(ticked.length === 1, 'ticked to that account only', ticked);
  if (shots) await p.shot(`${shots}/self-from-tile.png`);
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  // On a phone.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/about/c/${group}`);
  await p.until(`!!document.querySelector('.profile-page .pf-avatar-edit')`, 15000);
  // The toasts from saving sit over the picture on a phone until they go.
  await p.until(`(() => { const b = document.querySelector('.pf-avatar-edit').getBoundingClientRect(); return !!document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('.pf-avatar-edit'); })()`, 15000);
  await tap('.pf-avatar-edit');
  await p.until(`!!document.querySelector('.sheet [role="menu"]')`, 3000);
  if (shots) await p.shot(`${shots}/phone-menu.png`);
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await dropPicture();
  await p.until(`!!document.querySelector('.pic-editor .pic-img')`, 5000);
  check(await p.eval(`document.querySelector('.pic-crop').getBoundingClientRect().right <= innerWidth`), 'the crop frame fits a phone');
  if (shots) await p.shot(`${shots}/phone-editor.png`);

  // The demo world's pictures point at network servers a demo hub never reaches (502): not this page's errors.
  const errors = p.errors.filter((e) => !e.includes('502 (Bad Gateway)'));
  check(!errors.length, 'no errors in the page', errors.slice(0, 3));
} catch (e) {
  if (shots) await p.shot(`${shots}/failed.png`).catch(() => {});
  console.log(await p.eval(`document.querySelector('.profile-page')?.innerText.slice(0, 400)`).catch(() => ''));
  throw e;
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
