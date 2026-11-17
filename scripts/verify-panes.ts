/**
 * Panel widths (docs/desktop.md "Panel widths") against a demo hub in headless Chromium, with real mouse input:
 * dragging the list's edge widens it and the conversation gives the room; the width outlives a reload; the
 * conversation keeps its room however far it is dragged; a double-click puts it back; the details panel's edge
 * drags the other way; arrow keys move a focused edge; a phone has no edges.
 *
 *   bun scripts/verify-panes.ts http://127.0.0.1:8881 [/tmp/shots]
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8881';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const width = (sel: string) => p.eval<number>(`Math.round(document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect().width ?? -1)`);
const centre = (sel: string) =>
  p.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const mouse = (type: string, x: number, y: number, clickCount = 1) => p.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : type === 'mousePressed' ? 1 : 0, clickCount });
async function dragBy(sel: string, dx: number) {
  const c = await centre(sel);
  if (!c) throw new Error(`no ${sel}`);
  await mouse('mouseMoved', c.x, c.y);
  await mouse('mousePressed', c.x, c.y);
  for (let i = 1; i <= 8; i++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + (dx * i) / 8, y: c.y, button: 'left', buttons: 1 });
  await mouse('mouseReleased', c.x + dx, c.y);
  await Bun.sleep(150);
}
async function dblclick(sel: string) {
  const c = (await centre(sel))!;
  await mouse('mousePressed', c.x, c.y, 1);
  await mouse('mouseReleased', c.x, c.y, 1);
  await mouse('mousePressed', c.x, c.y, 2);
  await mouse('mouseReleased', c.x, c.y, 2);
  await Bun.sleep(150);
}
const key = async (k: string, code: string, vk: number) => {
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await Bun.sleep(100);
};

await p.size(1400, 900);
await p.goto(hub);
await p.until(`!!document.querySelector('.sidebar .inbox-row, .sidebar .row')`, 20000);
const start = await width('.sidebar');
const centreStart = await width('.center');
check(start === 332, 'the list starts at its usual width', start);
if (shots) await p.shot(`${shots}/panes-before.png`);

await dragBy('.pane-edge-sidebar', 120);
const wider = await width('.sidebar');
check(Math.abs(wider - 452) <= 1, 'dragging its edge 120 px right widens the list by as much', wider);
check(Math.abs(centreStart - (await width('.center')) - 120) <= 1, 'the conversation gives up the room');
check(!(await p.eval<boolean>(`document.documentElement.classList.contains('pane-dragging')`)), 'nothing is left mid-drag after the button goes up');
if (shots) await p.shot(`${shots}/panes-wider.png`);

await p.goto(hub);
await p.until(`!!document.querySelector('.sidebar .inbox-row, .sidebar .row')`, 20000);
check(Math.abs((await width('.sidebar')) - wider) <= 1, 'the width outlives a reload', await width('.sidebar'));

await dragBy('.pane-edge-sidebar', 2000);
const most = await width('.sidebar');
check(most <= 640 && (await width('.center')) >= 380, 'dragged far, the list stops at its widest and the conversation keeps its room', { most, center: await width('.center') });
await dragBy('.pane-edge-sidebar', -2000);
check((await width('.sidebar')) === 220, 'dragged far left, the list stops at its narrowest', await width('.sidebar'));

await dblclick('.pane-edge-sidebar');
check((await width('.sidebar')) === 332, 'a double-click puts the usual width back', await width('.sidebar'));

await p.eval(`document.querySelector('.pane-edge-sidebar').focus()`);
await key('ArrowRight', 'ArrowRight', 39);
await key('ArrowRight', 'ArrowRight', 39);
check((await width('.sidebar')) === 364, 'arrow keys move a focused edge 16 px a press', await width('.sidebar'));
await key('Home', 'Home', 36);
check((await width('.sidebar')) === 332, 'Home puts the usual width back', await width('.sidebar'));

// The details panel: open a chat, then its details from its header.
const conv = boot.conversations.find((c: any) => c.kind === 'dm') ?? boot.conversations[0];
await p.goto(`${hub}/#/inbox/c/${conv.id}`);
await p.until(`!!document.querySelector('.hdr-btn[data-track="details"]')`, 10000);
const opened = await p.eval<boolean>(`(() => { const b = document.querySelector('.hdr-btn[data-track="details"]'); b?.click(); return !!b; })()`);
await p.until(`!!document.querySelector('.details')`, 5000).catch(() => {});
check(opened && (await width('.details')) === 320, 'the details panel opens at its usual width', await width('.details'));
await dragBy('.pane-edge-details', -100);
check(Math.abs((await width('.details')) - 420) <= 1, 'dragging its edge 100 px left widens the details by as much', await width('.details'));
if (shots) await p.shot(`${shots}/panes-details.png`);
await dblclick('.pane-edge-details');
check((await width('.details')) === 320, 'a double-click puts its usual width back', await width('.details'));

await p.size(390, 844, true);
await Bun.sleep(400);
check((await p.eval<number>(`document.querySelectorAll('.pane-edge').length`)) === 0, 'a phone has no edges to drag');

await close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
