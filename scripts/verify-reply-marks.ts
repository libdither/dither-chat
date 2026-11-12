/**
 * Reply marks (docs/inbox.md, "Marks"), end to end in headless Chromium against a demo hub: on a row that shows a reply
 * you owe (↩), its menu has "No reply needed" and "Reply needed" under "Why it's here"; "No reply needed" takes the ↩
 * off at once and the hub's fold agrees a few seconds later; the toast's Undo brings it back; "Reply needed" holds the
 * row (the hub says `replyMark: 'needs'`), ticked in the menu, and picking it again lets go; a message from someone
 * else has both in its menu, ticked when set, and picking the ticked one takes it back; on a phone, a row's long-press
 * sheet has them too.
 *
 *   bun scripts/verify-reply-marks.ts http://127.0.0.1:8491 [/tmp/shots]
 *
 * The hub must be a fresh demo hub (--demo) with its own data dir: this marks messages.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8491';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const view = async (id: string) => ((await fetch(`${hub}/api/attention`).then((r) => r.json())) as any).items.find((v: any) => v.id === id);
const until = async (f: () => Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await Bun.sleep(250);
  }
  return false;
};

const { page: p, close } = await launch();
const mouse = (type: string, x: number, y: number, button: 'left' | 'right' | 'none' = 'none') =>
  p.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: button === 'right' ? 2 : button === 'left' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
const click = async (x: number, y: number, button: 'left' | 'right' = 'left') => {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, button);
  await mouse('mouseReleased', x, y, button);
  await Bun.sleep(150);
};
const at = async (sel: string, pick = 'el => true'): Promise<[number, number]> => {
  const r = await p.eval<[number, number] | null>(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(${pick}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  if (!r) throw new Error(`nothing matches ${sel}`);
  return r;
};
const items = () => p.eval<string[]>(`[...document.querySelectorAll('.cm .cm-item, .cm-sheet .sheet-action')].map((e) => e.textContent.trim() + (e.getAttribute('aria-checked') === 'true' ? ' ✓' : ''))`);
const pick = async (label: string) => click(...(await at('.cm .cm-item, .cm-sheet .sheet-action', `el => el.textContent.trim().startsWith(${JSON.stringify(label)})`)));
const owedRow = (key: string) => p.eval<boolean>(`!!document.querySelector('[data-row="${key}"] .row-owed')`);

// ------------------------------------------------------------------ desktop
await p.size(1280, 800);
await p.goto(`${hub}/#/inbox`);
await p.until(`document.querySelectorAll('.sidebar [data-row]').length > 3`, 15000);
// A row owing a reply that is one conversation (a chat of several routes is keyed by its person).
await p.until(`[...document.querySelectorAll('.sidebar [data-row]')].some((el) => el.dataset.row.startsWith('cnv_') && el.querySelector('.row-owed'))`, 15000);
const key = await p.eval<string>(`[...document.querySelectorAll('.sidebar [data-row]')].find((el) => el.dataset.row.startsWith('cnv_') && el.querySelector('.row-owed')).dataset.row`);
const before = await view(key);
check(before?.owedSince != null, 'a row owes a reply, with ↩', { owedSince: before?.owedSince != null });

await click(...(await at(`[data-row="${key}"]`)), 'right');
let menu = await items();
const reply = menu.findIndex((l) => l.startsWith('No reply needed'));
check(reply >= 0 && menu[reply + 1]?.startsWith('Reply needed') && menu.findIndex((l) => l.startsWith('Mark As Read')) > reply, 'its menu has both marks, before Mark As Read', menu.slice(0, 4));
if (shots) await p.shot(`${shots}/row-menu.png`);
await pick('No reply needed');
check(!(await owedRow(key)), '"No reply needed": the ↩ goes at once');
check(await p.eval(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('No reply needed') && t.textContent.includes('Undo'))`), '…with a toast that offers Undo');
check(await until(async () => (await view(key))?.owedSince === null, 20000), '…and the hub folds it: nothing owed');


// Taken back in the message's menu: "No reply needed" is ticked there, and picking it again undoes it.
await click(...(await at(`[data-row="${key}"]`)));
// They wrote last (the row owes a reply): the newest message is theirs.
const lastFromThem = `.msg:not(.system):not(.pending) .msg-body`;
await p.until(`document.querySelectorAll(${JSON.stringify(lastFromThem)}).length > 0`, 15000);
await Bun.sleep(400);
await click(...(await at(lastFromThem, '(el, i, all) => i === all.length - 1')), 'right');
menu = await items();
check(menu.includes('No reply needed ✓'), 'the message it marked has "No reply needed" ticked in its menu', menu.filter((l) => /reply/i.test(l)));
await pick('No reply needed');
check(await until(async () => (await view(key))?.owedSince === before.owedSince, 20000), 'picked again: owed again, since the same message');
check(await until(() => owedRow(key), 5000), '…with its ↩ back');

// The toast's Undo, right away.
await click(...(await at(`[data-row="${key}"]`)), 'right');
await pick('No reply needed');
check(!(await owedRow(key)), 'marked again: the ↩ goes');
await click(...(await at('.toast', `el => el.textContent.includes('Undo')`)));
check(await until(async () => (await view(key))?.owedSince === before.owedSince, 20000), 'Undo on the toast: owed again');
check(await until(() => owedRow(key), 5000), '…with its ↩ back');

await click(...(await at(`[data-row="${key}"]`)), 'right');
await pick('Reply needed');
check(await until(async () => (await view(key))?.replyMark === 'needs', 20000), '"Reply needed" holds the row', await view(key));
await click(...(await at(`[data-row="${key}"]`)), 'right');
menu = await items();
check(menu.includes('Reply needed ✓'), '…ticked in its menu', menu.slice(0, 4));
await pick('Reply needed');
check(await until(async () => (await view(key))?.replyMark === undefined, 20000), 'picked again, the hold goes');

// A message from someone else has both marks in its menu, unticked when unmarked.
await click(...(await at(`[data-row="${key}"]`)));
await Bun.sleep(400);
await click(...(await at(lastFromThem, '(el, i, all) => i === all.length - 1')), 'right');
menu = await items();
check(menu.includes('No reply needed') && menu.includes('Reply needed'), 'a message from someone else: both marks in its menu', menu.filter((l) => /reply/i.test(l)));
await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });

// ------------------------------------------------------------------ phone
const touch = (type: string, pts: [number, number][]) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
await p.size(390, 844, true);
await p.goto(`${hub}/#/inbox`);
await p.until(`!!document.querySelector('.app.phone')`, 15000);
await p.until(`[...document.querySelectorAll('[data-row]')].some((el) => el.querySelector('.row-owed'))`, 15000);
const phoneKey = await p.eval<string>(`[...document.querySelectorAll('[data-row]')].find((el) => el.querySelector('.row-owed')).dataset.row`);
const [x, y] = await at(`[data-row="${phoneKey}"]`);
await touch('touchStart', [[x, y]]);
await Bun.sleep(650);
await touch('touchEnd', []);
await Bun.sleep(400);
menu = await items();
check(menu.some((l) => l.startsWith('No reply needed')) && menu.some((l) => l.startsWith('Reply needed')), 'phone: a row\'s long-press sheet has both marks', menu.slice(0, 4));
if (shots) await p.shot(`${shots}/phone-row-sheet.png`);

check(p.errors.length === 0, 'no page errors', p.errors.slice(0, 3));
await close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
